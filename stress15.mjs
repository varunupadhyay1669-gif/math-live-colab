// Round-15: LIVE MIRROR relay contract (the "impossible to desync" engine).
//
// The teacher's iframe is the single authoritative lesson; it streams its real
// DOM/canvas via `mirror_dom`/`mirror_canvas`, the server fans out to students,
// and a DRIVING student forwards input back via `mirror_input`. The whole
// guarantee rests on the server routing + gating these correctly:
//   M1  teacher `mirror_dom` reaches students
//   M2  server CACHES the body; a late student's `mirror_request` is served it
//   M3  `mirror_request` also pokes the teacher (force a fresh snapshot)
//   M4  an interactive student's `mirror_input` reaches the teacher
//   M5  a VIEW-ONLY student's `mirror_input` is DROPPED (can't drive)
//   M6  a STUDENT's `mirror_dom` is REJECTED (only the teacher may stream)
//   M7  teacher `mirror_canvas` reaches students
//   M8  a CONTROL-HOLDER student drives even with interaction OFF
//   M9  new content (`run_preview` new html) CLEARS the cached body
// PORT=3100 node stress15.mjs
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
const HTML_A = '<!doctype html><body><h1 id="q">A</h1></body>';
const HTML_B = '<!doctype html><body><h1 id="q">B-DIFFERENT</h1></body>';
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

async function run() {
  // ── M1: teacher mirror_dom reaches students ──
  console.log('M1: teacher mirror_dom reaches students');
  const room = rid('mir');
  const t = await joinTeacher(room);
  const stu = await joinStudent(room, 'Stu');
  await delay(150);
  const gotDom = on1(stu, 'mirror_dom', { match: p => p && typeof p.body === 'string' && p.body.includes('SCREEN-1'), timeout: 3000 });
  t.emit('mirror_dom', { roomId: room, body: '<div id="s">SCREEN-1</div>' });
  await gotDom.then(() => ok('student receives the teacher\'s streamed DOM')).catch(e => bad('teacher mirror_dom reaches student', e.message));

  // ── M2 + M3: cache serves a late joiner; teacher is also poked ──
  console.log('M2-M3: mirror_request serves the cached body AND pokes the teacher');
  const late = conn(); await on1(late, 'connect');
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  await on1(late, 'room_state').catch(() => {});
  await delay(120);
  const lateGetsCache = on1(late, 'mirror_dom', { match: p => p && p.body && p.body.includes('SCREEN-1'), timeout: 3000 });
  const teacherPoked = on1(t, 'mirror_request', { timeout: 3000 });
  late.emit('mirror_request', { roomId: room });
  await lateGetsCache.then(() => ok('late joiner instantly served the cached DOM snapshot')).catch(e => bad('cache serves late joiner', e.message));
  await teacherPoked.then(() => ok('mirror_request pokes the teacher for a fresh snapshot')).catch(e => bad('mirror_request pokes teacher', e.message));

  // ── M4: interactive student's input reaches the teacher ──
  console.log('M4: an interactive student may drive (mirror_input → teacher)');
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  await delay(150);
  const drive = on1(t, 'mirror_input', { match: p => p && p.input && p.input.kind === 'click' && p.input.path === '#opt', timeout: 3000 });
  stu.emit('mirror_input', { roomId: room, input: { kind: 'click', path: '#opt' } });
  await drive.then(p => assert(p.studentName === 'Stu', 'interactive student\'s input reaches the teacher (tagged with name)', `name=${p.studentName}`)).catch(e => bad('interactive student drives', e.message));

  // ── M5: a view-only student is BLOCKED from driving ──
  console.log('M5: a view-only student cannot drive (mirror_input dropped)');
  t.emit('toggle_student_interaction', { roomId: room, allowed: false });
  await delay(150);
  const blocked = none(t, 'mirror_input', 1000);
  stu.emit('mirror_input', { roomId: room, input: { kind: 'click', path: '#should-not-arrive' } });
  const leaked = await blocked;
  assert(!leaked, 'view-only student\'s input is dropped by the server', leaked ? `leaked path=${leaked?.input?.path}` : '');

  // ── M6: a student cannot masquerade as the source ──
  console.log('M6: only the teacher may stream DOM (student mirror_dom rejected)');
  const spy = none(t, 'mirror_dom', 1000); // teacher must NOT receive a student's stream
  stu.emit('mirror_dom', { roomId: room, body: '<div>FORGED-BY-STUDENT</div>' });
  const forged = await spy;
  assert(!forged, 'a student\'s mirror_dom is rejected (role-gated to teacher)', forged ? 'forged body broadcast!' : '');

  // ── M7: teacher canvas frames reach students ──
  console.log('M7: teacher mirror_canvas reaches students');
  const gotCanvas = on1(stu, 'mirror_canvas', { match: p => Array.isArray(p?.canvases) && p.canvases[0]?.sel === '#c', timeout: 3000 });
  t.emit('mirror_canvas', { roomId: room, canvases: [{ sel: '#c', w: 4, h: 4, data: 'data:image/png;base64,AAAA' }] });
  await gotCanvas.then(() => ok('student receives the teacher\'s canvas frame')).catch(e => bad('teacher mirror_canvas reaches student', e.message));

  // ── M8: a control-holder drives even with interaction OFF ──
  console.log('M8: a control-holder student drives even with interaction OFF');
  const room2 = rid('mir2');
  const t2 = await joinTeacher(room2);
  const kid = await joinStudent(room2, 'Kid');
  await delay(150);
  t2.emit('grant_control', { roomId: room2, holderName: 'Kid' }); // interaction stays OFF
  await on1(kid, 'control_changed', { match: p => p.holderName === 'Kid', timeout: 3000 }).catch(() => {});
  await delay(120);
  const chalkDrive = on1(t2, 'mirror_input', { match: p => p?.input?.path === '#chalk', timeout: 3000 });
  kid.emit('mirror_input', { roomId: room2, input: { kind: 'click', path: '#chalk' } });
  await chalkDrive.then(() => ok('the control-holder\'s input reaches the teacher with interaction off')).catch(e => bad('control-holder drives', e.message));

  // ── M9: new content clears the cached body ──
  console.log('M9: new content clears the cached mirror body');
  t2.emit('mirror_dom', { roomId: room2, body: '<div>OLD-LESSON-BODY</div>' });
  await delay(150);
  t2.emit('run_preview', { roomId: room2, fileId: 'a', html: HTML_B }); // genuine new lesson
  await delay(200);
  const late2 = conn(); await on1(late2, 'connect');
  late2.emit('join_room', { roomId: room2, userName: 'Late2', role: 'student' });
  await on1(late2, 'room_state').catch(() => {});
  await delay(120);
  const staleServe = none(late2, 'mirror_dom', 1000);
  late2.emit('mirror_request', { roomId: room2 });
  const stale = await staleServe;
  assert(!(stale && stale.body && stale.body.includes('OLD-LESSON-BODY')), 'new content cleared the stale cached body (no old lesson served)', stale ? 'served stale body!' : '');

  console.log(`\nSTRESS15 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
