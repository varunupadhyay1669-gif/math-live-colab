// Round-16: LIVE MIRROR hardening — the remaining structural desync holes.
//
// The mirror content-dedups: it never re-sends state it believes the follower
// already has. That is what makes it cheap, and it was also the last way to
// desync — a frame LOST IN TRANSIT (socket hiccup, reconnect, relay drop) is
// never retried, so on a static screen the student stays stale forever. A tiny
// fingerprint heartbeat now closes that. This suite pins the whole contract:
//   H1  mirror_ping (fingerprint heartbeat) relays teacher → students
//   H2  a STUDENT's mirror_ping is rejected (only the teacher describes truth)
//   H3  mirror_dom carries the styling envelope (attrs + head CSS + hash)
//   H4  mirror_request serves the CACHED envelope, not just the body
//   H5  a frame larger than the old 2MB file cap still relays (transient frames
//       must not be silently dropped — that froze the student permanently)
//   H6  a frame beyond the transport ceiling is refused (no wedged socket)
//   H7  new content clears the whole cached envelope (no stale CSS/attrs)
// PORT=4000 node stress16.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 4000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 900) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const HTML_B = '<!doctype html><body><h1 id="q">B</h1></body>';
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

async function run() {
  const room = rid('mh');
  const t = await joinTeacher(room);
  const stu = await joinStudent(room, 'Stu');
  await delay(150);

  // ── H1: fingerprint heartbeat reaches students ──
  console.log('H1: fingerprint heartbeat relays teacher → students');
  const gotPing = on1(stu, 'mirror_ping', { match: p => p && p.h === 'abc-123', timeout: 3000 });
  t.emit('mirror_ping', { roomId: room, h: 'abc-123' });
  await gotPing.then(() => ok('student receives the teacher\'s state fingerprint')).catch(e => bad('mirror_ping relays', e.message));

  // ── H2: a student cannot forge the fingerprint ──
  console.log('H2: a student\'s fingerprint is rejected');
  const forged = none(t, 'mirror_ping', 900);
  stu.emit('mirror_ping', { roomId: room, h: 'forged' });
  assert(!(await forged), 'a student\'s mirror_ping is rejected (teacher-only)', '');

  // ── H3: the styling envelope rides with the frame ──
  console.log('H3: mirror_dom carries body attrs + head CSS + fingerprint');
  const gotDom = on1(stu, 'mirror_dom', { match: p => p && p.body && p.body.includes('S1'), timeout: 3000 });
  t.emit('mirror_dom', {
    roomId: room, body: '<div>S1</div>',
    attrs: '[["class","dark"]]', head: '<style>b{color:red}</style>', h: 'hash-1',
  });
  const dom = await gotDom.catch(() => null);
  assert(!!dom && dom.attrs === '[["class","dark"]]', 'body attributes relay (theme/class changes reach students)', dom ? `attrs=${dom.attrs}` : 'no frame');
  assert(!!dom && (dom.head || '').includes('color:red'), 'runtime-injected head CSS relays', dom ? `head=${String(dom.head).slice(0, 30)}` : '');
  assert(!!dom && dom.h === 'hash-1', 'content fingerprint relays', dom ? `h=${dom.h}` : '');

  // ── H4: late joiner is served the cached ENVELOPE, not a bare body ──
  console.log('H4: mirror_request serves the cached styling envelope');
  const late = conn(); await on1(late, 'connect');
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  await on1(late, 'room_state').catch(() => {});
  await delay(120);
  const cached = on1(late, 'mirror_dom', { match: p => p && p.body && p.body.includes('S1'), timeout: 3000 });
  late.emit('mirror_request', { roomId: room });
  const c = await cached.catch(() => null);
  assert(!!c && c.attrs === '[["class","dark"]]' && (c.head || '').includes('color:red'),
    'late joiner is served cached attrs + head CSS (renders styled, not bare)', c ? `attrs=${c.attrs}` : 'nothing served');

  // ── H5: a frame over the old 2MB FILE cap must still relay ──
  console.log('H5: a >2MB transient frame still relays (was silently dropped)');
  const big = '<div>' + 'x'.repeat(2 * 1024 * 1024 + 5000) + '</div>'; // ~2.05MB
  const gotBig = on1(stu, 'mirror_dom', { match: p => p && p.body && p.body.length > 2 * 1024 * 1024, timeout: 6000 });
  t.emit('mirror_dom', { roomId: room, body: big, attrs: '[]', head: '', h: 'big-1' });
  await gotBig.then(() => ok('a 2MB+ page still reaches students (no silent freeze)')).catch(e => bad('oversized frame relays', e.message));

  // ── H6: beyond the transport ceiling it is refused, not wedged ──
  console.log('H6: a frame beyond the transport ceiling is refused cleanly');
  const huge = 'y'.repeat(4 * 1024 * 1024 + 1000); // > MAX_MIRROR_FRAME
  const gotHuge = none(stu, 'mirror_dom', 1500);
  t.emit('mirror_dom', { roomId: room, body: huge, attrs: '[]', head: '', h: 'huge-1' });
  const h6 = await gotHuge;
  assert(!(h6 && h6.body && h6.body.length > 4 * 1024 * 1024), 'a frame past the ceiling is refused (socket stays healthy)', '');
  // prove the socket still works after the refusal
  const stillAlive = on1(stu, 'mirror_dom', { match: p => p && p.body === '<i>alive</i>', timeout: 3000 });
  t.emit('mirror_dom', { roomId: room, body: '<i>alive</i>', attrs: '[]', head: '', h: 'alive-1' });
  await stillAlive.then(() => ok('mirroring continues normally after an over-cap frame')).catch(e => bad('socket healthy after refusal', e.message));

  // ── H7: new content clears the whole envelope ──
  console.log('H7: new content clears the cached envelope (no stale CSS)');
  t.emit('run_preview', { roomId: room, fileId: 'a', html: HTML_B });
  await delay(250);
  const late2 = conn(); await on1(late2, 'connect');
  late2.emit('join_room', { roomId: room, userName: 'Late2', role: 'student' });
  await on1(late2, 'room_state').catch(() => {});
  await delay(120);
  const stale = none(late2, 'mirror_dom', 1000);
  late2.emit('mirror_request', { roomId: room });
  const s7 = await stale;
  assert(!(s7 && ((s7.head || '').includes('color:red') || s7.attrs === '[["class","dark"]]')),
    'new content clears cached attrs + head CSS (no stale styling)', s7 ? 'served stale envelope!' : '');

  // ── H8: the teacher's scroll-sync ("Linked") toggle actually gates scroll ──
  // The mirror relayed the teacher's scroll unconditionally, so UNLINKING did
  // nothing and students were still dragged to the teacher's position.
  console.log('H8: the scroll-sync toggle gates teacher→student scrolling');
  const room3 = rid('mh3');
  const t3 = await joinTeacher(room3);
  const stu3 = await joinStudent(room3, 'Stu3');
  await delay(150);
  // Linked (default) → scroll relays
  const linked = on1(stu3, 'mirror_scroll', { match: p => p && p.scrollY === 500, timeout: 2500 });
  t3.emit('mirror_scroll', { roomId: room3, scrollX: 0, scrollY: 500 });
  await linked.then(() => ok('Linked: the teacher\'s scroll moves students')).catch(e => bad('linked scroll relays', e.message));
  // Unlinked → scroll must NOT relay
  t3.emit('toggle_scroll_sync', { roomId: room3, enabled: false });
  await delay(250);
  const unlinked = none(stu3, 'mirror_scroll', 1000);
  t3.emit('mirror_scroll', { roomId: room3, scrollX: 0, scrollY: 900 });
  const leaked = await unlinked;
  assert(!leaked, 'Unlinked: the teacher\'s scroll does NOT drag students', leaked ? `leaked scrollY=${leaked.scrollY}` : '');
  // Re-linked → relays again (toggle is live, not one-way)
  t3.emit('toggle_scroll_sync', { roomId: room3, enabled: true });
  await delay(250);
  const relinked = on1(stu3, 'mirror_scroll', { match: p => p && p.scrollY === 700, timeout: 2500 });
  t3.emit('mirror_scroll', { roomId: room3, scrollX: 0, scrollY: 700 });
  await relinked.then(() => ok('Re-linked: scrolling resumes (toggle works both ways)')).catch(e => bad('relink resumes scroll', e.message));

  console.log(`\nSTRESS16 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
