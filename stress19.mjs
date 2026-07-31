// Round-19: the two faults reported from a real lesson.
//
//   H1  hanging up must reach the other side (their camera has to stop; a
//       one-sided teardown leaves someone filming an empty room while a frozen
//       last frame makes it look like a live call)
//   H2  a pause must survive a burst of other teacher traffic — the teacher is
//       moving the mouse when they click pause, so the play/pause event lands
//       in the middle of a cursor flood. It used to be dropped at the soft
//       rate-limit cap exactly then.
// PORT=4000 node stress19.mjs
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
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
async function joinTeacher(room, name = 'Teacher') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

const VID = 'dQw4w9WgXcQ';

async function run() {
  const room = rid('hang');
  const t = await joinTeacher(room);
  const stu = await joinStudent(room, 'Anika');
  await delay(200);

  // ── H1 ──
  console.log('H1: hanging up reaches the other side');
  const sawJoin = on1(stu, 'rtc_presence', { match: p => p?.active === true, timeout: 3000 });
  t.emit('rtc_presence', { roomId: room, active: true });
  await sawJoin.then(() => ok('student is told the teacher is on camera')).catch(e => bad('join presence', e.message));

  const sawHangup = on1(stu, 'rtc_presence', { match: p => p?.active === false, timeout: 3000 });
  t.emit('rtc_presence', { roomId: room, active: false });
  const hp = await sawHangup.catch(e => ({ err: e.message }));
  assert(hp && hp.active === false, 'student is told the teacher hung up', JSON.stringify(hp));
  assert(hp?.name, 'and who it was, so the message can name them', JSON.stringify(hp));

  // The student leaving must reach the teacher too — same contract both ways.
  const teacherSawHangup = on1(t, 'rtc_presence', { match: p => p?.active === false, timeout: 3000 });
  stu.emit('rtc_presence', { roomId: room, active: false });
  await teacherSawHangup.then(() => ok('and it works in the other direction'))
    .catch(e => bad('student hang-up did not reach the teacher', e.message));

  // ── H2 ──
  console.log('H2: a pause survives the cursor burst that comes with clicking it');
  t.emit('video_open', { roomId: room, videoId: VID, start: 0 });
  await on1(stu, 'video_open', { timeout: 3000 }).catch(() => {});
  await delay(1100);   // fresh rate-limit window

  // Flood with mirror_scroll — a real, rate-limited teacher event — to push
  // past the 200/s soft cap the way a busy lesson can.
  for (let i = 0; i < 260; i++) t.emit('mirror_scroll', { roomId: room, scrollX: 0, scrollY: i });
  const gotPause = on1(stu, 'video_state', { match: p => p?.playing === false, timeout: 3000 });
  t.emit('video_state', { roomId: room, time: 12.5, playing: false });
  const pv = await gotPause.catch(e => ({ err: e.message }));
  assert(pv && pv.playing === false, 'the pause still reaches the student mid-flood', JSON.stringify(pv));
  assert(pv && Math.abs(pv.time - 12.5) < 0.01, 'carrying the position it was paused at', JSON.stringify(pv));

  // And a late joiner must see it paused, not playing.
  const late = conn(); await on1(late, 'connect');
  const st = on1(late, 'session_state', { timeout: 5000 }).catch(() => null);
  late.emit('join_room', { roomId: room, userName: 'Rohan', role: 'student' });
  const sv = (await st)?.sharedVideo;
  assert(sv && sv.playing === false && Math.abs(sv.time - 12.5) < 0.5,
    'someone joining after the pause arrives paused at the same spot', JSON.stringify(sv));

  console.log(`\nHANGUP + PAUSE RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  sockets.forEach(s => { try { s.close(); } catch {} });
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('CRASH', e); sockets.forEach(s => { try { s.close(); } catch {} }); process.exit(1); });
