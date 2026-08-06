// Round-27: THE TUTOR'S SCREEN — the direction that works on an iPad.
//
// Live Mirror can fail for reasons neither person can see: a lesson that will
// not render, a device that will not run it. Sharing the tutor's actual screen
// sidesteps the whole question. It is also the ONLY screen sharing available
// when the student is on iPadOS, which cannot capture a screen but receives
// video like any other browser. Contract:
//   T1  only the teacher can announce a share
//   T2  every student in the room is told, and told who
//   T3  a student joining mid-share learns about it from the room state
//   T4  the teacher's offer reaches the student it is addressed to, and no other
//   T5  stopping is relayed, and the room forgets it
// PORT=4000 node stress27.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 5000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 800) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);

async function joinTeacher(room) {
  const s = conn(); await on1(s, 'connect');
  s.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher' });
  await on1(s, 'room_state'); return s;
}
async function joinStudent(room, name) {
  const s = conn(); await on1(s, 'connect');
  const stP = on1(s, 'session_state');
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  return { s, state: await stP };
}

async function run() {
  const room = rid('tscr');
  const t = await joinTeacher(room);
  const listP = on1(t, 'user_list', { match: l => l.filter(u => u.role === 'student').length === 2 });
  const { s: a } = await joinStudent(room, 'Kanishka');
  const { s: b } = await joinStudent(room, 'Rohan');
  const list = await listP;
  const aId = list.find(u => u.name === 'Kanishka').id;
  const bId = list.find(u => u.name === 'Rohan').id;

  console.log('T1: only the teacher can announce a share');
  const notFromStudent = none(b, 'teacher_screen');
  a.emit('teacher_screen', { roomId: room, on: true });
  assert((await notFromStudent) === null, 'a student announcing a share is ignored');
  const outsider = conn(); await on1(outsider, 'connect');
  const notFromOutsider = none(a, 'teacher_screen');
  outsider.emit('teacher_screen', { roomId: room, on: true });
  assert((await notFromOutsider) === null, 'and so is someone who never joined the room');

  console.log('T2: every student is told, and told who');
  const aP = on1(a, 'teacher_screen');
  const bP = on1(b, 'teacher_screen');
  t.emit('teacher_screen', { roomId: room, on: true });
  const [aMsg, bMsg] = await Promise.all([aP, bP]);
  assert(aMsg.on === true && bMsg.on === true, 'both students learn the share started');
  assert(aMsg.name === 'Varun', 'and whose screen it is', String(aMsg.name));
  const echoed = await none(t, 'teacher_screen', 500);
  assert(echoed === null, 'the teacher is not told about their own share');

  console.log('T3: a student joining mid-share is told by the room state');
  // Otherwise they sit looking at a lesson the tutor has already moved past.
  const { state: lateState } = await joinStudent(room, 'Late');
  assert(lateState.teacherScreenOn === true,
    'the room remembers the share for whoever arrives next', JSON.stringify(lateState.teacherScreenOn));

  console.log('T4: the offer goes to the addressed student only');
  const toA = on1(a, 'screen_signal');
  const notToB = none(b, 'screen_signal');
  t.emit('screen_signal', { roomId: room, to: aId, signal: { description: { type: 'offer', sdp: 'X' } } });
  const sig = await toA;
  assert(sig.signal.description.type === 'offer', 'the student receives the tutor\'s offer');
  assert((await notToB) === null, 'and the other student does not — separate connections, separate offers');
  // The student's answer goes back up the same channel.
  const answerP = on1(t, 'screen_signal');
  a.emit('screen_signal', { roomId: room, signal: { description: { type: 'answer', sdp: 'Y' } } });
  const ans = await answerP;
  assert(ans.signal.description.type === 'answer' && ans.from === aId,
    'and their answer reaches the tutor, tagged with who sent it');

  console.log('T5: stopping is relayed and the room forgets it');
  const stopP = on1(a, 'teacher_screen', { match: m => m.on === false });
  t.emit('teacher_screen', { roomId: room, on: false });
  assert((await stopP).on === false, 'students are told the share ended');
  const { state: afterState } = await joinStudent(room, 'After');
  assert(afterState.teacherScreenOn === false,
    'and someone joining later is not told to expect a screen that is gone',
    JSON.stringify(afterState.teacherScreenOn));
  void bId;
}

run().catch(e => { bad('harness', e.message); }).finally(async () => {
  sockets.forEach(s => { try { s.close(); } catch {} });
  console.log(`\nTEACHER SCREEN RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
});
