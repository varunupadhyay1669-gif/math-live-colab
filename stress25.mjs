// Round-25: JOINING — one shot, or wait, but never a dead end.
//
// The reported symptom: "I have to join and join and ultimately it gets
// connected." The cause was that a student arriving before the teacher got a
// hard error whose only button was "Go home", so they reloaded until the
// teacher happened to be in. Contract:
//   J1  a student who arrives early is told to WAIT, and the error is
//       marked retryable
//   J2  the same student joins successfully once the teacher opens the room,
//       with no reload — the same socket, a second join_room
//   J3  genuinely hopeless cases are NOT marked retryable, so a client that
//       retries on the flag cannot spin forever
//   J4  a teacher never has to wait — they create the room
//   J5  repeated joins from one socket do not pile up duplicate members
// PORT=4000 node stress25.mjs
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
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);

async function run() {
  console.log('J1: a student who arrives early is told to wait');
  const room = rid('join');
  const student = conn(); await on1(student, 'connect');
  const errP = on1(student, 'join_error');
  student.emit('join_room', { roomId: room, userName: 'Kanishka', role: 'student' });
  const err = await errP;
  assert(err.retryable === true, 'the refusal is marked retryable', JSON.stringify(err));
  assert(err.code === 'room_not_open', 'with a code the client can branch on', String(err.code));
  assert(!/not found/i.test(err.message),
    'and it no longer reads like the link is broken', err.message);
  assert(/teacher/i.test(err.message), 'it says what is actually happening', err.message);

  console.log('J2: they get in when the teacher arrives — same socket, no reload');
  const teacher = conn(); await on1(teacher, 'connect');
  teacher.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher' });
  await on1(teacher, 'room_state');
  // This is exactly what the client's retry timer does.
  const stateP = on1(student, 'room_state');
  student.emit('join_room', { roomId: room, userName: 'Kanishka', role: 'student' });
  const state = await stateP;
  assert(!!state, 'the student is admitted on the next knock, with no page reload');
  const list = await on1(teacher, 'user_list', { match: l => l.some(u => u.name === 'Kanishka') })
    .catch(() => null);
  assert(!!list, 'and the teacher sees them arrive');

  console.log('J3: hopeless cases are not retryable');
  const badRoom = conn(); await on1(badRoom, 'connect');
  const e1P = on1(badRoom, 'join_error');
  badRoom.emit('join_room', { roomId: 'not a valid room!!', userName: 'X', role: 'student' });
  const e1 = await e1P;
  assert(e1.retryable === false, 'an invalid room code is terminal — retrying it forever is a spin', JSON.stringify(e1));
  const badRole = conn(); await on1(badRole, 'connect');
  const e2P = on1(badRole, 'join_error');
  badRole.emit('join_room', { roomId: room, userName: 'X', role: 'wizard' });
  const e2 = await e2P;
  assert(e2.retryable === false, 'and so is an invalid role');
  // A second teacher under a different name cannot take the seat, and waiting
  // will never change that.
  const teacher2 = conn(); await on1(teacher2, 'connect');
  const e3P = on1(teacher2, 'join_error');
  teacher2.emit('join_room', { roomId: room, userName: 'Someone Else', role: 'teacher' });
  const e3 = await e3P;
  assert(e3.retryable === false, 'nor does a taken teacher seat free itself by waiting', JSON.stringify(e3));

  console.log('J4: a teacher never waits');
  const fresh = rid('join');
  const t2 = conn(); await on1(t2, 'connect');
  let refused = null;
  t2.on('join_error', p => { refused = p; });
  t2.emit('join_room', { roomId: fresh, userName: 'Varun', role: 'teacher' });
  await on1(t2, 'room_state');
  assert(refused === null, 'opening a brand-new room just works', JSON.stringify(refused));

  console.log('J5: knocking repeatedly does not duplicate the student');
  for (let i = 0; i < 4; i++) {
    student.emit('join_room', { roomId: room, userName: 'Kanishka', role: 'student' });
    await new Promise(r => setTimeout(r, 120));
  }
  const finalList = await on1(teacher, 'user_list', { timeout: 4000 }).catch(() => null)
    || await new Promise(res => { teacher.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher' }); on1(teacher, 'user_list').then(res).catch(() => res(null)); });
  const kanishkas = (finalList || []).filter(u => u.name === 'Kanishka').length;
  assert(kanishkas <= 1, 'the room holds ONE of her however many times she knocked', String(kanishkas));
}

run().catch(e => { bad('harness', e.message); }).finally(async () => {
  sockets.forEach(s => { try { s.close(); } catch {} });
  console.log(`\nJOIN RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
});
