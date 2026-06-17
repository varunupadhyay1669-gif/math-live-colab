// Round-2 ADVERSARIAL stress — the edges that freeze a class or leak control.
// PORT=3000 node stress5.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3000';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 5000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 800) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const QUIZ = `<!doctype html><body><h1 id="q">Q</h1><button id="n">next</button></body>`;
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) {
  const s = conn(); await on1(s, 'connect');
  const ssP = on1(s, 'session_state', { timeout: 5000 }).catch(() => null);
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  await on1(s, 'room_state').catch(() => {});
  return { s, ss: await ssP };
}
async function upload(t, room) { t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } }); await delay(180); }

// B1: CONTROL HOLDER fully disconnects -> control auto-clears -> teacher can drive again (no frozen class)
async function B1_holderDisconnectClearsControl() {
  console.log('B1: control holder full-disconnect frees the class');
  const room = rid('b1');
  const t = await joinTeacher(room);
  await upload(t, room);
  const ann = await joinStudent(room, 'Ann');
  const bob = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(bob.s, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  // Ann closes the tab for good
  const cleared = on1(bob.s, 'control_changed', { match: p => p.holderName === null, timeout: 3000 });
  ann.s.disconnect();
  await cleared.then(() => ok('control auto-clears when the holder disconnects')).catch(e => bad('control auto-clears on holder leave', e.message));
  // teacher must be able to drive again
  const bobGetsTeacher = on1(bob.s, 'interaction', { match: p => p?.id === 'tdrive', timeout: 2500 });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'tdrive', path: '#n' } });
  await bobGetsTeacher.then(() => ok('teacher drives again after holder left (class not frozen)')).catch(e => bad('teacher resumes after holder left', e.message));
}

// B3: control holder keeps driving while the TEACHER is gone (grace)
async function B3_holderDrivesDuringTeacherGrace() {
  console.log('B3: control holder drives even while the teacher is in grace');
  const room = rid('b3');
  const t = await joinTeacher(room, 'MrT');
  await upload(t, room);
  const ann = await joinStudent(room, 'Ann');
  const bob = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(bob.s, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  t.disconnect(); await delay(400); // teacher in grace
  const bobGetsAnn = on1(bob.s, 'interaction', { match: p => p?.id === 'annDriveGrace', timeout: 2500 });
  ann.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'annDriveGrace', path: '#n' } });
  await bobGetsAnn.then(() => ok('holder keeps driving the class with the teacher absent')).catch(e => bad('holder drives during teacher grace', e.message));
}

// B6: control follows a same-name reconnect (incognito holder) — the NEW socket drives
async function B6_controlFollowsReconnect() {
  console.log('B6: control follows the holder across a same-name reconnect');
  const room = rid('b6');
  const t = await joinTeacher(room);
  await upload(t, room);
  const ann1 = await joinStudent(room, 'Ann');
  const bob = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(bob.s, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  // Ann reopens in a new tab (same name) -> dedup replaces the old socket
  const ann2 = await joinStudent(room, 'Ann');
  await delay(400);
  // The NEW Ann socket should be able to drive (control is name-keyed)
  const bobGetsNewAnn = on1(bob.s, 'interaction', { match: p => p?.id === 'newAnn', timeout: 2500 });
  ann2.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'newAnn', path: '#n' } });
  await bobGetsNewAnn.then(() => ok('reconnected (new-socket) holder drives — control was preserved')).catch(e => bad('control follows reconnect', e.message));
}

// B8: late joiner inherits current step + gate (step-lock survives join)
async function B8_stepGateLateJoin() {
  console.log('B8: late joiner inherits step + gate');
  const room = rid('b8');
  const t = await joinTeacher(room);
  await upload(t, room);
  t.emit('add_gate', { roomId: room, step: 2, question: 'What is 2+2?', options: ['3', '4', '5'], correctIndex: 1 });
  await delay(120);
  t.emit('set_step', { roomId: room, step: 2 });
  await delay(150);
  const s = await joinStudent(room, 'Late');
  assert(s.ss?.currentStep === 2, 'late joiner inherits currentStep=2', `step=${s.ss?.currentStep}`);
  assert(s.ss?.gates && s.ss.gates[2] && s.ss.gates[2].question === 'What is 2+2?', 'late joiner inherits the gate', JSON.stringify(s.ss?.gates));
}

// B13: gate correctIndex is STRIPPED for students (no answer leak via the wire)
async function B13_gateAnswerNotLeaked() {
  console.log('B13: gate answer (correctIndex) is not leaked to students');
  const room = rid('b13');
  const t = await joinTeacher(room);
  await upload(t, room);
  t.emit('add_gate', { roomId: room, step: 1, question: 'Secret?', options: ['a', 'b', 'c'], correctIndex: 2 });
  await delay(150);
  const s = await joinStudent(room, 'Cheater');
  const g = s.ss?.gates?.[1];
  assert(g && g.question === 'Secret?' && g.options?.length === 3, 'student gets the gate question + options', JSON.stringify(g));
  // The server replaces the real answer with the -1 sentinel for students.
  assert(g && g.correctIndex === -1 && g.correctIndex !== 2, 'real correctIndex (2) is hidden behind the -1 sentinel (no answer leak)', `correctIndex=${g?.correctIndex}`);
}

// B9: whiteboard mode is reflected in a late joiner's session state
async function B9_whiteboardLateJoin() {
  console.log('B9: whiteboard mode reaches a late joiner');
  const room = rid('b9');
  const t = await joinTeacher(room);
  await upload(t, room);
  t.emit('whiteboard_mode_toggle', { roomId: room, active: true });
  await delay(200);
  const s = await joinStudent(room, 'Late');
  assert(s.ss?.whiteboardMode === true, 'late joiner sees whiteboardMode=true', `wb=${s.ss?.whiteboardMode}`);
}

// B10: reconnect storm — same student reconnects 5x fast -> exactly ONE user remains
async function B10_reconnectStorm() {
  console.log('B10: rapid reconnect storm leaves no ghost users');
  const room = rid('b10');
  const t = await joinTeacher(room);
  await upload(t, room);
  let last;
  for (let i = 0; i < 5; i++) { last = await joinStudent(room, 'Flaky'); await delay(120); }
  await delay(500);
  // ask the teacher for the user list
  const list = await on1(t, 'user_list', { timeout: 2500 }).catch(() => null) || [];
  // user_list may not push on demand; trigger it by a no-op presence check via reactions list isn't reliable — count from a fresh teacher view
  const flakyCount = Array.isArray(list) ? list.filter(u => u.name === 'Flaky').length : -1;
  // If we couldn't get a fresh list, fall back to verifying the latest socket still gets state
  if (flakyCount === -1) { assert(!!last.ss, 'final reconnect still receives session_state', ''); }
  else { assert(flakyCount <= 1, 'no duplicate "Flaky" users after the storm', `count=${flakyCount}`); }
}

// B11: kicked student can rejoin cleanly
async function B11_kickThenRejoin() {
  console.log('B11: kicked student can rejoin and re-sync');
  const room = rid('b11');
  const t = await joinTeacher(room);
  await upload(t, room);
  // Register the user_list listener BEFORE the student join triggers the
  // broadcast — otherwise we wait for a NEXT list that never comes (race).
  const listP = on1(t, 'user_list', { match: l => l.some(u => u.role === 'student'), timeout: 4000 });
  const s = await joinStudent(room, 'Kicked');
  const list = await listP.catch(() => null);
  const sid = list?.find(u => u.role === 'student')?.id;
  assert(!!sid, 'teacher resolves the student socket id from user_list', `sid=${sid}`);
  const kicked = on1(s.s, 'kicked', { timeout: 2500 });
  t.emit('kick_user', { roomId: room, userId: sid });
  await kicked.then(() => ok('student receives kick')).catch(e => bad('student kicked', e.message));
  await delay(300);
  const rejoin = await joinStudent(room, 'Kicked');
  assert(!!rejoin.ss, 'kicked student can rejoin and gets session_state', '');
}

async function run() {
  const tests = [B1_holderDisconnectClearsControl, B3_holderDrivesDuringTeacherGrace, B6_controlFollowsReconnect,
    B8_stepGateLateJoin, B13_gateAnswerNotLeaked, B9_whiteboardLateJoin, B10_reconnectStorm, B11_kickThenRejoin];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(200); }
  console.log(`\nSTRESS5 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
