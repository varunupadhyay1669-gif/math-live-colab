// Round-24: SCREEN SHARE relay — who may ask, who may signal whom.
//
// This channel carries a live view of a child's screen. The gating is the
// feature, not a detail of it. Contract:
//   C1  the teacher can ask a student, and that student alone is asked
//   C2  a student cannot ask anyone to share
//   C3  a non-member cannot ask, or signal, into someone else's room
//   C4  a student's signal reaches the teacher and NO other student
//   C5  one student cannot open a connection to another student
//   C6  the teacher's signal reaches only the student they addressed
//   C7  state (declined / unsupported / stopped) reaches the right person only
//   C8  a bogus state string is dropped
// PORT=4000 node stress24.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 4000, match } = {}) {
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
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  await on1(s, 'room_state'); return s;
}
const idOf = async (teacher, name) => {
  const list = await on1(teacher, 'user_list', { match: l => l.some(u => u.name === name) })
    .catch(() => null);
  return list ? list.find(u => u.name === name).id : null;
};

async function run() {
  const room = rid('scr');
  const t = await joinTeacher(room);
  const listP = on1(t, 'user_list', { match: l => l.filter(u => u.role === 'student').length === 2 });
  const a = await joinStudent(room, 'Kanishka');
  const b = await joinStudent(room, 'Rohan');
  const list = await listP;
  const aId = list.find(u => u.name === 'Kanishka').id;
  const bId = list.find(u => u.name === 'Rohan').id;

  console.log('C1: the teacher asks one student, and only that one is asked');
  const askedA = on1(a, 'screen_request');
  const notB = none(b, 'screen_request');
  t.emit('screen_request', { roomId: room, studentId: aId });
  const ask = await askedA;
  assert(ask.teacherName === 'Varun', 'the student is told who is asking', String(ask.teacherName));
  assert((await notB) === null, 'the other student is not asked — one child at a time');

  console.log('C2/C3: nobody else can ask');
  const notAskedB = none(b, 'screen_request');
  a.emit('screen_request', { roomId: room, studentId: bId });
  assert((await notAskedB) === null, 'a student cannot ask another student to share their screen');
  const outsider = conn(); await on1(outsider, 'connect');
  const notAskedA = none(a, 'screen_request');
  outsider.emit('screen_request', { roomId: room, studentId: aId });
  assert((await notAskedA) === null, 'and someone who never joined cannot ask at all');

  console.log('C4/C5: a student signals the teacher, nobody else');
  const toTeacher = on1(t, 'screen_signal');
  const notToB = none(b, 'screen_signal');
  a.emit('screen_signal', { roomId: room, signal: { description: { type: 'offer' } } });
  const sig = await toTeacher;
  assert(sig.from === aId, 'the teacher receives it, tagged with who sent it', String(sig.from));
  assert(sig.signal.description.type === 'offer', 'and the payload is intact');
  assert((await notToB) === null, 'the other student never sees it');
  const notToBDirect = none(b, 'screen_signal');
  a.emit('screen_signal', { roomId: room, to: bId, signal: { description: { type: 'offer' } } });
  assert((await notToBDirect) === null, 'and a student naming another student is ignored, not routed');
  const notFromOutsider = none(t, 'screen_signal');
  outsider.emit('screen_signal', { roomId: room, signal: { candidate: {} } });
  assert((await notFromOutsider) === null, 'a non-member cannot signal into the room');

  console.log('C6: the teacher signals the student they addressed');
  const toA = on1(a, 'screen_signal');
  const notSigB = none(b, 'screen_signal');
  t.emit('screen_signal', { roomId: room, to: aId, signal: { description: { type: 'answer' } } });
  assert((await toA).signal.description.type === 'answer', 'the answer arrives');
  assert((await notSigB) === null, 'and only there');

  console.log('C7: state reaches the right person only');
  const stateT = on1(t, 'screen_state');
  const notStateB = none(b, 'screen_state');
  a.emit('screen_state', { roomId: room, state: 'unsupported' });
  const st = await stateT;
  assert(st.state === 'unsupported' && st.from === aId, 'the teacher learns the device cannot share', JSON.stringify(st));
  assert((await notStateB) === null, 'the other student is not told');
  const stopA = on1(a, 'screen_state');
  const notStopB = none(b, 'screen_state');
  t.emit('screen_state', { roomId: room, state: 'stopped', to: aId });
  assert((await stopA).state === 'stopped', 'the teacher can tell them to stop capturing');
  assert((await notStopB) === null, 'without telling the rest of the class someone was being watched');

  console.log('C8: junk is dropped');
  const noJunk = none(t, 'screen_state');
  a.emit('screen_state', { roomId: room, state: 'recording_everything' });
  assert((await noJunk) === null, 'an unknown state never reaches the teacher');
  const noTargetJunk = none(a, 'screen_state');
  t.emit('screen_state', { roomId: room, state: 'stopped', to: 'not-a-socket' });
  assert((await noTargetJunk) === null, 'nor a state addressed to nobody');
}

run().catch(e => { bad('harness', e.message); }).finally(async () => {
  sockets.forEach(s => { try { s.close(); } catch {} });
  console.log(`\nSCREEN SHARE RELAY RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
});
