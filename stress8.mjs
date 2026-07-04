// Round-8: BIDIRECTIONAL sync — student -> teacher when interactive.
// The reported bug: teacher->student worked, but an interactive student's
// clicks/scrolls never reached the teacher. These tests pin the fix:
// interactive student events relay to the TEACHER (only), view-only stays
// one-way, and an interactive student must NOT drive other students.
// PORT=3100 node stress8.mjs
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
function none(s, ev, ms = 800) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const QUIZ = `<!doctype html><body><h1 id="q">Q</h1><button id="n">next</button></body>`;
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }
async function upload(t, room) { t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } }); await delay(180); }

// BD1: interactive student's CLICK reaches the teacher (the core fix)
async function BD1_clickReachesTeacher() {
  console.log('BD1: interactive student click -> teacher sees it');
  const room = rid('bd1');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const s = await joinStudent(room, 'Stu');
  const got = on1(t, 'interaction', { match: p => p?.type === 'SYNC_CLICK' && p.id === 'sc1', timeout: 2500 });
  s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'sc1', path: '#n' } });
  await got.then(() => ok('teacher receives the interactive student CLICK (role=student)')).catch(e => bad('teacher sees student click', e.message));
}

// BD2: interactive student's SCROLL reaches the teacher
async function BD2_scrollReachesTeacher() {
  console.log('BD2: interactive student scroll -> teacher sees it');
  const room = rid('bd2');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const s = await joinStudent(room, 'Stu');
  const got = on1(t, 'interaction', { match: p => p?.type === 'SYNC_SCROLL' && p.id === 'ss1', timeout: 2500 });
  s.emit('interaction', { roomId: room, event: { type: 'SYNC_SCROLL', id: 'ss1', scrollY: 250 } });
  await got.then(() => ok('teacher receives the interactive student SCROLL')).catch(e => bad('teacher sees student scroll', e.message));
}

// BD3: VIEW-ONLY student's click does NOT reach the teacher (stays one-way)
async function BD3_viewOnlyStaysOneWay() {
  console.log('BD3: view-only student click is NOT relayed to teacher');
  const room = rid('bd3');
  const t = await joinTeacher(room); await upload(t, room);
  // do NOT enable interactive — view-only is the default
  const s = await joinStudent(room, 'Stu');
  const leaked = none(t, 'interaction', 900);
  s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'vo1', path: '#n' } });
  assert(!((await leaked)?.id === 'vo1'), 'view-only student click is dropped (no student->teacher leak)', '');
}

// BD4: an interactive student must NOT drive OTHER students (teacher-only routing)
async function BD4_notToOtherStudents() {
  console.log('BD4: interactive student does NOT drive other students');
  const room = rid('bd4');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  const bGets = none(b, 'interaction', 900);
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ann1', path: '#n' } });
  assert(!((await bGets)?.id === 'ann1'), 'student A interaction does NOT reach student B (no multi-writer drift)', '');
}

// BD5: control-holder still drives ROOM-WIDE (regression)
async function BD5_controlHolderRoomWide() {
  console.log('BD5: control-holder still drives room-wide');
  const room = rid('bd5');
  const t = await joinTeacher(room); await upload(t, room);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(b, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  const bGets = on1(b, 'interaction', { match: p => p?.id === 'ctl1', timeout: 2500 });
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ctl1', path: '#n' } });
  await bGets.then(() => ok('control-holder drives every screen (room-wide)')).catch(e => bad('control-holder room-wide', e.message));
}

// BD6: teacher -> student still works (regression of the direction that already worked)
async function BD6_teacherToStudent() {
  console.log('BD6: teacher -> student still mirrors');
  const room = rid('bd6');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const s = await joinStudent(room, 'Stu');
  const got = on1(s, 'interaction', { match: p => p?.id === 'td1', timeout: 2500 });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'td1', path: '#n' } });
  await got.then(() => ok('teacher click still reaches the student')).catch(e => bad('teacher->student', e.message));
}

// BD7: teacher WHEEL (3D camera zoom) broadcasts to students with tick count intact
async function BD7_teacherWheelToStudent() {
  console.log('BD7: teacher SYNC_WHEEL -> student (camera zoom sync)');
  const room = rid('bd7');
  const t = await joinTeacher(room); await upload(t, room);
  const s = await joinStudent(room, 'Stu');
  await delay(150);
  const got = on1(s, 'interaction', { match: p => p?.type === 'SYNC_WHEEL' && p.id === 'wz1', timeout: 2500 });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_WHEEL', id: 'wz1', path: 'canvas', deltaY: -360, count: 3 } });
  const p = await got.catch(() => null);
  assert(!!p, 'student receives the teacher WHEEL event', '');
  assert(!!p && p.count === 3 && p.deltaY === -360, 'tick count + delta preserved through routing', p ? `count=${p.count} dY=${p.deltaY}` : '');
}

// BD8: interactive student WHEEL relays to the TEACHER only (no leak to other students)
async function BD8_studentWheelTeacherOnly() {
  console.log('BD8: interactive student SYNC_WHEEL -> teacher only');
  const room = rid('bd8');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(200);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  const tGets = on1(t, 'interaction', { match: p => p?.id === 'wz2', timeout: 2500 });
  const bLeak = none(b, 'interaction', 900);
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_WHEEL', id: 'wz2', path: 'canvas', deltaY: 120, count: 1 } });
  await tGets.then(() => ok('teacher receives the interactive student WHEEL')).catch(e => bad('student wheel -> teacher', e.message));
  assert(!((await bLeak)?.id === 'wz2'), 'student wheel does NOT leak to other students', '');
}

async function run() {
  const tests = [BD1_clickReachesTeacher, BD2_scrollReachesTeacher, BD3_viewOnlyStaysOneWay,
    BD4_notToOtherStudents, BD5_controlHolderRoomWide, BD6_teacherToStudent,
    BD7_teacherWheelToStudent, BD8_studentWheelTeacherOnly];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(150); }
  console.log(`\nSTRESS8 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
