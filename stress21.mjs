// Round-21: "ASK THE TEACHER TO UNLOCK IT".
//
// A view-only student tapping the lesson got nothing back — no button moved,
// no message — so they assume it's broken, and the teacher (who simply forgot
// to allow interaction) never finds out. Contract:
//   A1  a student's ask reaches the TEACHER only, carrying their name
//   A2  it is not broadcast to other students
//   A3  asking is pointless once interaction is already on, so it's suppressed
//   A4  a teacher cannot ask themselves
//   A5  a non-member of the room cannot ping someone else's teacher
//   A6  the ask does NOT itself unlock anything (the teacher decides)
// PORT=4000 node stress21.mjs
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
async function joinTeacher(room) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: 'Teacher', role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

async function run() {
  const room = rid('ask');
  const t = await joinTeacher(room);
  const anika = await joinStudent(room, 'Anika');
  const rohan = await joinStudent(room, 'Rohan');
  await delay(250);

  // ── A1 ──
  console.log('A1: the ask reaches the teacher, with who is asking');
  const heard = on1(t, 'interaction_requested', { timeout: 3000 });
  anika.emit('request_interaction', { roomId: room });
  const p = await heard.catch(e => ({ err: e.message }));
  assert(p?.studentName === 'Anika', 'the teacher is told who tapped', JSON.stringify(p));
  assert(typeof p?.at === 'number', 'and when');

  // ── A2 ──
  console.log('A2: other students are not bothered by it');
  const leaked = none(rohan, 'interaction_requested', 900);
  anika.emit('request_interaction', { roomId: room });
  assert(!(await leaked), 'the ask is teacher-only');

  // ── A6 (before unlocking) ──
  console.log('A6: asking does not unlock anything by itself');
  const selfUnlock = none(anika, 'student_interaction_toggled', 900);
  anika.emit('request_interaction', { roomId: room });
  assert(!(await selfUnlock), 'a student cannot let themselves in by asking');

  // ── A4 ──
  console.log('A4: a teacher cannot ask themselves');
  const selfAsk = none(t, 'interaction_requested', 900);
  t.emit('request_interaction', { roomId: room });
  assert(!(await selfAsk), 'the teacher\'s own ask is ignored');

  // ── A5 ──
  console.log('A5: an outsider cannot ping someone else\'s teacher');
  const outsider = conn(); await on1(outsider, 'connect');
  const pinged = none(t, 'interaction_requested', 900);
  outsider.emit('request_interaction', { roomId: room });
  assert(!(await pinged), 'someone who never joined the room is ignored');

  // ── A3 ──
  console.log('A3: once interaction is on, the ask is pointless and suppressed');
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  await delay(300);
  const afterUnlock = none(t, 'interaction_requested', 900);
  anika.emit('request_interaction', { roomId: room });
  assert(!(await afterUnlock), 'no nagging once students can already interact');

  // And it starts working again if the teacher locks it back.
  t.emit('toggle_student_interaction', { roomId: room, allowed: false });
  await delay(300);
  const again = on1(t, 'interaction_requested', { timeout: 3000 });
  anika.emit('request_interaction', { roomId: room });
  await again.then(() => ok('and asking works again after re-locking'))
    .catch(e => bad('ask stopped working after a lock/unlock cycle', e.message));

  console.log(`\nASK-TO-UNLOCK RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  sockets.forEach(s => { try { s.close(); } catch {} });
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('CRASH', e); sockets.forEach(s => { try { s.close(); } catch {} }); process.exit(1); });
