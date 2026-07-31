// Round-18: SHARED YOUTUBE CLIP.
//
// The teacher pastes a link and a video opens over the lesson on every screen,
// following their play/pause/skip. Contract:
//   Y1  a teacher opening a clip opens it on the student's screen
//   Y2  a STUDENT cannot open, move or close a clip (teacher-authoritative)
//   Y3  a bogus video id is refused outright, not embedded
//   Y4  a student who joins mid-clip lands on the same video, wound forward to
//       roughly where the teacher is (not back at 0:00)
//   Y5  the teacher's position reaches students, and is not echoed to itself
//   Y6  closing it clears the room — a later joiner sees no video
//   Y7  clips stay inside their own room
// PORT=4000 node stress18.mjs
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
async function joinStudent(room, name) {
  const s = conn(); await on1(s, 'connect');
  const state = on1(s, 'session_state', { timeout: 5000 }).catch(() => null);
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  s._sessionState = await state;
  return s;
}

const VID = 'dQw4w9WgXcQ';
const VID2 = 'aqz-KE-bpKQ';

async function run() {
  const room = rid('yt');
  const t = await joinTeacher(room, 'Teacher');
  const stu = await joinStudent(room, 'Anika');
  await delay(200);

  // ── Y1 ──
  console.log('Y1: the teacher opens a clip and it opens on the student\'s screen');
  const opened = on1(stu, 'video_open', { timeout: 3000 });
  t.emit('video_open', { roomId: room, videoId: VID, start: 42 });
  const p1 = await opened.catch(e => ({ err: e.message }));
  assert(p1?.videoId === VID, 'student gets the same video', JSON.stringify(p1));
  assert(p1?.start === 42, 'and the same starting point (42s in)', JSON.stringify(p1));

  // ── Y2 ──
  console.log('Y2: a student cannot drive the room\'s video');
  const stuOpen = none(t, 'video_open', 900);
  stu.emit('video_open', { roomId: room, videoId: VID2 });
  assert(!(await stuOpen), 'a student opening a clip is ignored');

  const stuMove = none(stu, 'video_state', 900);
  stu.emit('video_state', { roomId: room, time: 999, playing: false });
  assert(!(await stuMove), 'a student cannot scrub everyone else\'s clip');

  const stuClose = none(t, 'video_close', 900);
  stu.emit('video_close', { roomId: room });
  assert(!(await stuClose), 'a student cannot close the teacher\'s clip');

  // ── Y3 ──
  console.log('Y3: junk in the id field never reaches a student');
  for (const junk of ['', 'abc', '../../etc/passwd', '"><script>x</script>', VID + 'extra', 42, null]) {
    const seen = none(stu, 'video_open', 400);
    t.emit('video_open', { roomId: room, videoId: junk });
    assert(!(await seen), `refuses ${JSON.stringify(junk)}`);
  }

  // ── Y4 ──
  console.log('Y4: a student joining mid-clip catches up instead of restarting');
  t.emit('video_state', { roomId: room, time: 120, playing: true });
  await delay(1200);   // let real time pass so "wound forward" is measurable
  const late = await joinStudent(room, 'Rohan');
  const sv = late._sessionState?.sharedVideo;
  assert(sv?.videoId === VID, 'late joiner is handed the clip that\'s playing', JSON.stringify(sv));
  assert(sv && sv.time >= 121 && sv.time < 126,
    `and starts near where the teacher is, not at 0:00 (got ${sv ? sv.time.toFixed(1) : 'nothing'}s)`);
  assert(sv?.playing === true, 'and knows it is playing');

  // Paused clips must NOT drift forward while nobody is watching.
  t.emit('video_state', { roomId: room, time: 200, playing: false });
  await delay(1200);
  const late2 = await joinStudent(room, 'Meera');
  const sv2 = late2._sessionState?.sharedVideo;
  assert(sv2 && Math.abs(sv2.time - 200) < 0.5,
    `a paused clip stays put for the next joiner (got ${sv2 ? sv2.time.toFixed(1) : 'nothing'}s)`);
  assert(sv2?.playing === false, 'and is handed over still paused');

  // ── Y5 ──
  console.log('Y5: the teacher\'s position reaches students, and not themselves');
  const heard = on1(stu, 'video_state', { match: p => p?.time === 300, timeout: 3000 });
  const echo = none(t, 'video_state', 900);
  t.emit('video_state', { roomId: room, time: 300, playing: true });
  await heard.then(() => ok('student receives the teacher\'s position')).catch(e => bad('teacher → student position', e.message));
  assert(!(await echo), 'the teacher does not receive their own heartbeat back');

  // ── Y6 ──
  console.log('Y6: closing it really closes it');
  const closed = on1(stu, 'video_close', { timeout: 3000 });
  t.emit('video_close', { roomId: room });
  await closed.then(() => ok('student\'s clip closes')).catch(e => bad('close did not reach student', e.message));
  await delay(150);
  const after = await joinStudent(room, 'Kabir');
  assert(after._sessionState?.sharedVideo === null, 'and someone joining later sees no video at all',
    JSON.stringify(after._sessionState?.sharedVideo));

  // ── Y7 ──
  console.log('Y7: one class\'s video does not appear in another');
  const otherRoom = rid('yt-other');
  const t2 = await joinTeacher(otherRoom, 'Other teacher');
  const leak = none(stu, 'video_open', 900);
  t2.emit('video_open', { roomId: otherRoom, videoId: VID2 });
  assert(!(await leak), 'a clip opened next door does not show up here');

  console.log(`\nYOUTUBE RELAY RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  sockets.forEach(s => { try { s.close(); } catch {} });
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('CRASH', e); sockets.forEach(s => { try { s.close(); } catch {} }); process.exit(1); });
