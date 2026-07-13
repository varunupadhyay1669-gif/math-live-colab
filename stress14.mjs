// Round-14: run_preview IDEMPOTENCY (the "teacher stuck on the map after the
// whiteboard" root cause, browser-reproduced).
//
// run_preview is emitted for TWO reasons: the teacher running NEW html, and
// re-seeding the server from the teacher's cache (on reconnect, or when a
// student joins while the teacher is on the whiteboard → request_html_sync).
// The re-seed carries the SAME html. Previously run_preview ALWAYS reset the
// content baseline (journal + shared RNG seed), so a mid-lesson re-seed wiped
// every interactive student's navigation — and a later catch-up / late-join had
// nothing to replay. Contract now:
//   J1  re-seed with the SAME html PRESERVES the interaction journal
//   J2  re-seed with the SAME html PRESERVES the shared RNG seed
//   J3  run_preview with DIFFERENT html DOES reset the journal (new lesson)
//   J4  run_preview with DIFFERENT html DOES issue a fresh seed
//   J5  end-to-end: journal an interactive student's nav, re-seed (same html),
//       a late joiner STILL replays the full nav (the real fix)
// PORT=3100 node stress14.mjs
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
const HTML_A = '<!doctype html><body><h1 id="q">A</h1><button id="n">next</button></body>';
const HTML_B = '<!doctype html><body><h1 id="q">B-DIFFERENT</h1><button id="n">next</button></body>';
const has = (p, id) => Array.isArray(p?.events) && p.events.some(e => e && e.id === id);
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }
// Read a room's current seed via a throwaway joiner's session_state.
async function readSeed(room) {
  const s = conn(); await on1(s, 'connect');
  const st = on1(s, 'session_state', { timeout: 3000 });
  s.emit('join_room', { roomId: room, userName: 'Peek' + Math.floor(Math.random() * 1e5), role: 'student' });
  const state = await st.catch(() => null);
  return state?.randomSeed;
}

async function run() {
  // ── Setup: upload A, journal 3 interactive-student clicks ──
  console.log('J1-J2: re-seed with SAME html preserves journal + seed');
  const room = rid('rp');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'a', name: 'A', html: HTML_A, uploadedAt: 1 } });
  await delay(200);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  await delay(150);
  const stu = await joinStudent(room, 'Stu');
  for (const id of ['nav1', 'nav2', 'nav3']) { stu.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id, path: '#n' } }); await delay(40); }
  await delay(250);
  const seedBefore = await readSeed(room);

  // ── Idempotent re-seed: run_preview with the SAME html ──
  t.emit('run_preview', { roomId: room, fileId: 'a', html: HTML_A });
  await delay(300);
  const late1 = conn(); await on1(late1, 'connect');
  const replay1 = on1(late1, 'interaction_replay', { match: p => has(p, 'nav1') && has(p, 'nav2') && has(p, 'nav3'), timeout: 3000 });
  late1.emit('join_room', { roomId: room, userName: 'Late1', role: 'student' });
  await replay1.then(() => ok('re-seed (same html) PRESERVES the journal — late joiner replays all 3 nav events')).catch(e => bad('journal preserved on re-seed', e.message));
  const seedAfter = await readSeed(room);
  assert(typeof seedBefore === 'number' && seedAfter === seedBefore, 're-seed (same html) PRESERVES the shared RNG seed', `before ${seedBefore} after ${seedAfter}`);

  // ── Genuine new content: run_preview with DIFFERENT html ──
  console.log('J3-J4: run_preview with NEW html resets journal + seed');
  t.emit('run_preview', { roomId: room, fileId: 'a', html: HTML_B });
  await delay(300);
  const late2 = conn(); await on1(late2, 'connect');
  const noReplay = none(late2, 'interaction_replay', 1200);
  const st2 = on1(late2, 'session_state', { timeout: 3000 });
  late2.emit('join_room', { roomId: room, userName: 'Late2', role: 'student' });
  const r2 = await noReplay;
  const state2 = await st2.catch(() => null);
  assert(!has(r2, 'nav1'), 'NEW html resets the journal — old nav no longer replays', r2 ? `events=${r2.count}` : '');
  assert(!!state2 && typeof state2.randomSeed === 'number' && state2.randomSeed !== seedBefore, 'NEW html issues a fresh seed', `old ${seedBefore} new ${state2?.randomSeed}`);
  assert(!!state2 && state2.effectiveHtml === HTML_B, 'NEW html is what late joiners boot', '');

  // ── J5: end-to-end — the exact "whiteboard round-trip" journal survival ──
  console.log('J5: interactive nav survives a same-html re-seed (the real fix)');
  const room2 = rid('rp2');
  const t2 = await joinTeacher(room2);
  t2.emit('upload_file', { roomId: room2, file: { id: 'a', name: 'A', html: HTML_A, uploadedAt: 1 } });
  await delay(200);
  t2.emit('toggle_student_interaction', { roomId: room2, allowed: true });
  await delay(150);
  const stu2 = await joinStudent(room2, 'Kid');
  stu2.emit('interaction', { roomId: room2, event: { type: 'SYNC_CLICK', id: 'open', path: '#n' } });
  await delay(150);
  // A SECOND student joins (this is what triggers request_html_sync → teacher
  // re-seeds run_preview with the same html mid-lesson).
  t2.emit('run_preview', { roomId: room2, fileId: 'a', html: HTML_A }); // simulate the auto re-seed
  await delay(150);
  stu2.emit('interaction', { roomId: room2, event: { type: 'SYNC_CLICK', id: 'answer', path: '#n' } });
  await delay(250);
  const late3 = conn(); await on1(late3, 'connect');
  const replay3 = on1(late3, 'interaction_replay', { match: p => has(p, 'open') && has(p, 'answer'), timeout: 3000 });
  late3.emit('join_room', { roomId: room2, userName: 'Late3', role: 'student' });
  await replay3.then(() => ok('nav BEFORE and AFTER the mid-lesson re-seed both replay (no wipe)')).catch(e => bad('nav survives mid-lesson re-seed', e.message));

  console.log(`\nSTRESS14 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
