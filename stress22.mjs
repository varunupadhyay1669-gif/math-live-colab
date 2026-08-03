// Round-22: NARRATION — what was said, as text, from both sides.
//
// No audio ever leaves a device. Each browser transcribes its own microphone
// and relays short lines; the teacher's class pack merges them. Contract:
//   N1  the teacher can ask the room to start, and students are told
//   N2  a student's line reaches the TEACHER, tagged with their name
//   N3  it is not broadcast to other students (one child's speech is not
//       delivered to another child's screen)
//   N4  the teacher's own lines are not echoed back to them
//   N5  a student cannot ask the room to start listening
//   N6  a non-member cannot inject lines into someone else's lesson
//   N7  stopping is relayed too
// PORT=4000 node stress22.mjs
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
async function joinTeacher(room) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

async function run() {
  const room = rid('narr');
  const t = await joinTeacher(room);
  const anika = await joinStudent(room, 'Anika');
  const rohan = await joinStudent(room, 'Rohan');
  await delay(250);

  // ── N1 ──
  console.log('N1: the teacher asks the room to start');
  const asked = on1(anika, 'narration_request', { timeout: 3000 });
  t.emit('narration_request', { roomId: room, on: true });
  const p1 = await asked.catch(e => ({ err: e.message }));
  assert(p1?.on === true, 'the student is asked (their browser then asks THEM)', JSON.stringify(p1));

  // ── N2 ──
  console.log('N2: a student line reaches the teacher, with a name on it');
  const heard = on1(t, 'narration_line', { timeout: 3000 });
  anika.emit('narration_line', { roomId: room, text: 'do I take away eight each time', t: 12000 });
  const p2 = await heard.catch(e => ({ err: e.message }));
  assert(p2?.text === 'do I take away eight each time', 'the words arrive', JSON.stringify(p2));
  assert(p2?.speaker === 'Anika', 'attributed to who said them', JSON.stringify(p2));
  assert(p2?.t === 12000, 'with the offset into the lesson, so it lines up with the board');

  // ── N3 ──
  console.log('N3: one student\'s speech is not delivered to another student');
  const leaked = none(rohan, 'narration_line', 900);
  anika.emit('narration_line', { roomId: room, text: 'something private', t: 1 });
  assert(!(await leaked), 'lines go only to the teacher');

  // ── N4 ──
  console.log('N4: the teacher is not sent their own lines back');
  const echo = none(t, 'narration_line', 900);
  t.emit('narration_line', { roomId: room, text: 'teacher speaking', t: 2 });
  assert(!(await echo), 'no echo (the teacher keeps their own locally)');

  // ── N5 ──
  console.log('N5: only the teacher can ask the room to listen');
  const studentAsk = none(rohan, 'narration_request', 900);
  anika.emit('narration_request', { roomId: room, on: true });
  assert(!(await studentAsk), 'a student cannot switch on anyone else\'s microphone');

  // ── N6 ──
  console.log('N6: an outsider cannot inject lines');
  const outsider = conn(); await on1(outsider, 'connect');
  const injected = none(t, 'narration_line', 900);
  outsider.emit('narration_line', { roomId: room, text: 'not in this room', t: 3 });
  assert(!(await injected), 'someone who never joined is ignored');

  // ── N7 ──
  console.log('N7: stopping reaches everyone');
  const stopped = on1(anika, 'narration_request', { match: p => p?.on === false, timeout: 3000 });
  t.emit('narration_request', { roomId: room, on: false });
  await stopped.then(() => ok('the student is told to stop')).catch(e => bad('stop did not relay', e.message));

  console.log(`\nNARRATION RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  sockets.forEach(s => { try { s.close(); } catch {} });
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('CRASH', e); sockets.forEach(s => { try { s.close(); } catch {} }); process.exit(1); });
