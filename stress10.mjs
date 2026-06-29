// Round-10: live-class DESYNC fixes (the "teacher on the map, student on the
// quiz" bug). The lesson was a stateful, click-navigated quiz. Root causes:
//  (1) an interactive student's navigation was relayed TEACHER-ONLY and NEVER
//      journaled, so any teacher iframe rebuild (whiteboard toggle / reconnect)
//      reloaded the pristine home screen with nothing to replay -> stuck on map.
//  (2) no on-demand catch-up when the teacher's lesson iframe remounted.
// Fixes pinned here (server contract):
//  - interactive student nav IS journaled -> a late joiner / reconnecting client
//    replays it and reaches the student's real screen.
//  - request_replay returns the current journal to a member on demand.
//  - LIVE routing is unchanged: still teacher-only (no leak to other students),
//    view-only stays passive (not journaled), order preserved.
// PORT=3100 node stress10.mjs
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
const QUIZ = `<!doctype html><body><h1 id="q">Q</h1><button id="n">next</button></body>`;
const has = (p, id) => Array.isArray(p?.events) && p.events.some(e => e && e.id === id);
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }
async function upload(t, room) { t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } }); await delay(180); }

// D1: interactive student's nav click IS journaled -> a late joiner replays it.
//     (THE core fix: without it, a rebuilt teacher iframe has nothing to catch up on.)
async function D1_interactiveNavJournaled() {
  console.log('D1: interactive student nav is journaled (late joiner replays it)');
  const room = rid('d1');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const s = await joinStudent(room, 'Stu');
  s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'nav1', path: '#n' } });
  await delay(250);
  const late = conn(); await on1(late, 'connect');
  const replay = on1(late, 'interaction_replay', { match: p => has(p, 'nav1'), timeout: 3000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  await replay.then(() => ok('interactive student nav click IS journaled (late joiner replays it)')).catch(e => bad('interactive nav journaled', e.message));
}

// D2: request_replay returns the current journal to a member on demand
//     (the mechanism the teacher uses to catch up when its lesson iframe remounts).
async function D2_requestReplay() {
  console.log('D2: request_replay returns the journal (teacher catch-up)');
  const room = rid('d2');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const s = await joinStudent(room, 'Stu');
  s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'rr1', path: '#n' } });
  await delay(250);
  const got = on1(t, 'interaction_replay', { match: p => has(p, 'rr1'), timeout: 3000 });
  t.emit('request_replay', { roomId: room });
  await got.then(() => ok('request_replay returns the journal on demand')).catch(e => bad('request_replay', e.message));
}

// D3: interactive student's click STILL reaches the teacher LIVE (regression of the
//     bidirectional fix — journaling must not have broken live mirroring).
async function D3_stillReachesTeacherLive() {
  console.log('D3: interactive student click still reaches the teacher live');
  const room = rid('d3');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const s = await joinStudent(room, 'Stu');
  const got = on1(t, 'interaction', { match: p => p?.id === 'live1', timeout: 2500 });
  s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'live1', path: '#n' } });
  await got.then(() => ok('interactive student click STILL reaches the teacher live')).catch(e => bad('live bidirectional', e.message));
}

// D4: interactive student's click is NOT broadcast LIVE to another student
//     (single-writer-live preserved; journaling is teacher-only on the wire).
async function D4_noLiveLeakToOtherStudent() {
  console.log('D4: interactive student click does NOT leak live to another student');
  const room = rid('d4');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  const bGets = none(b, 'interaction', 900);
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'leak1', path: '#n' } });
  assert(!((await bGets)?.id === 'leak1'), 'interactive student click is NOT broadcast live to another student', '');
}

// D5: multiple interactive nav events replay IN ORDER to a late joiner
async function D5_orderPreserved() {
  console.log('D5: journaled interactive nav replays in order');
  const room = rid('d5');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const s = await joinStudent(room, 'Stu');
  for (const id of ['o1', 'o2', 'o3']) { s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id, path: '#n' } }); await delay(40); }
  await delay(220);
  const late = conn(); await on1(late, 'connect');
  const replay = on1(late, 'interaction_replay', { match: p => Array.isArray(p?.events) && p.events.filter(e => ['o1', 'o2', 'o3'].includes(e.id)).length === 3, timeout: 3000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const r = await replay.catch(() => null);
  const ids = r ? r.events.filter(e => ['o1', 'o2', 'o3'].includes(e.id)).map(e => e.id).join(',') : '';
  assert(ids === 'o1,o2,o3', 'interactive nav events replay in order', ids || 'no replay');
}

// D6: a VIEW-ONLY student's click is NOT journaled (stays truly passive).
async function D6_viewOnlyNotJournaled() {
  console.log('D6: view-only student click is NOT journaled');
  const room = rid('d6');
  const t = await joinTeacher(room); await upload(t, room);
  // interaction deliberately NOT enabled — default view-only
  const s = await joinStudent(room, 'Stu');
  s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'vo1', path: '#n' } });
  await delay(250);
  const late = conn(); await on1(late, 'connect');
  const replay = none(late, 'interaction_replay', 1200);
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const r = await replay;
  assert(!has(r, 'vo1'), 'view-only student click is NOT journaled', '');
}

async function run() {
  const tests = [D1_interactiveNavJournaled, D2_requestReplay, D3_stillReachesTeacherLive,
    D4_noLiveLeakToOtherStudent, D5_orderPreserved, D6_viewOnlyNotJournaled];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(150); }
  console.log(`\nSTRESS10 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
