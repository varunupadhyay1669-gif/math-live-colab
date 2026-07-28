// Round-17: VIDEO CALL signalling relay.
//
// Meet/Zoom/Teams send X-Frame-Options, so an embedded meeting link can never
// show faces. Instead the two browsers connect directly (WebRTC) and this room
// socket is the introduction channel. Media never touches the server — only
// these tiny offer/answer/ICE messages do. Contract:
//   V1  a teacher's signal reaches the student
//   V2  a student's signal reaches the teacher (both directions negotiate)
//   V3  a signal is NOT echoed back to its own sender (would confuse the SDP
//       state machine and break the call)
//   V4  presence relays, carrying who is calling
//   V5  a NON-MEMBER cannot inject signalling into someone else's lesson
//   V6  signals stay inside their own room (no cross-room leakage)
// PORT=4000 node stress17.mjs
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
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

async function run() {
  const room = rid('rtc');
  const t = await joinTeacher(room, 'Teacher');
  const stu = await joinStudent(room, 'Anika');
  await delay(200);

  // ── V1: teacher → student ──
  console.log('V1: the teacher\'s call offer reaches the student');
  const gotOffer = on1(stu, 'rtc_signal', { match: p => p?.signal?.description?.type === 'offer', timeout: 3000 });
  t.emit('rtc_signal', { roomId: room, signal: { description: { type: 'offer', sdp: 'v=0 fake-offer' } } });
  await gotOffer.then(() => ok('student receives the teacher\'s offer')).catch(e => bad('teacher → student signal', e.message));

  // ── V2: student → teacher ──
  console.log('V2: the student\'s answer reaches the teacher');
  const gotAnswer = on1(t, 'rtc_signal', { match: p => p?.signal?.description?.type === 'answer', timeout: 3000 });
  stu.emit('rtc_signal', { roomId: room, signal: { description: { type: 'answer', sdp: 'v=0 fake-answer' } } });
  await gotAnswer.then(() => ok('teacher receives the student\'s answer')).catch(e => bad('student → teacher signal', e.message));

  // ── V3: never echoed back to the sender ──
  console.log('V3: a signal is not echoed back to whoever sent it');
  const echo = none(t, 'rtc_signal', 900);
  t.emit('rtc_signal', { roomId: room, signal: { candidate: { candidate: 'fake-ice' } } });
  assert(!(await echo), 'sender does not receive its own signal (SDP state stays sane)', '');

  // ── V4: presence, with who is calling ──
  console.log('V4: presence tells the other side who is calling');
  const pres = on1(t, 'rtc_presence', { match: p => p && p.active === true, timeout: 3000 });
  stu.emit('rtc_presence', { roomId: room, active: true });
  const p4 = await pres.catch(() => null);
  assert(!!p4 && p4.name === 'Anika' && p4.role === 'student', 'presence carries the caller\'s name and role', p4 ? `name=${p4.name} role=${p4.role}` : 'none');

  // ── V5: outsiders cannot inject into a lesson ──
  console.log('V5: a non-member cannot inject signalling');
  const outsider = conn(); await on1(outsider, 'connect');   // never joined the room
  const leak = none(stu, 'rtc_signal', 1000);
  outsider.emit('rtc_signal', { roomId: room, signal: { description: { type: 'offer', sdp: 'v=0 INTRUDER' } } });
  const l5 = await leak;
  assert(!(l5 && JSON.stringify(l5).includes('INTRUDER')), 'a stranger\'s signal is rejected (cannot hijack a lesson call)', l5 ? 'INTRUDER got through!' : '');

  // ── V6: no cross-room leakage ──
  console.log('V6: signals stay inside their own room');
  const room2 = rid('rtc2');
  const t2 = await joinTeacher(room2, 'OtherTeacher');
  await delay(150);
  const cross = none(t2, 'rtc_signal', 1000);
  t.emit('rtc_signal', { roomId: room, signal: { description: { type: 'offer', sdp: 'v=0 ROOM1-ONLY' } } });
  const l6 = await cross;
  assert(!(l6 && JSON.stringify(l6).includes('ROOM1-ONLY')), 'another room never sees this lesson\'s call signals', l6 ? 'leaked across rooms!' : '');

  console.log(`\nSTRESS17 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
