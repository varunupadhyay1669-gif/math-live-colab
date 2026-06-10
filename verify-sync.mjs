// Socket.IO integration smoke test for Math Live.
//
// Runs against a live dev server (npm run dev on PORT, default 3000) and
// exercises the critical teacher<->student sync paths plus several fixes made
// during the production-hardening pass:
//   - file upload reaches the student
//   - step-gate flow: add_gate now ships question+options to students, the
//     answer key (correctIndex) is NOT leaked, grading + XP work, and a repeat
//     correct answer earns no XP (anti-farm)
//   - session_state to a student carries gates with correctIndex stripped (-1)
//   - room password gates students (socket) and the HTTP fallback (403)
//   - deleting the active file repoints canonical HTML to the next file
//
// Usage:  node verify-sync.mjs            (expects server on http://localhost:3000)
//         PORT=4000 node verify-sync.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3000';
const URL = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function bad(name, detail) { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

function connect() {
  return io(URL, { transports: ['websocket', 'polling'], reconnection: false, forceNew: true });
}
// Wait for a named event (optionally matching a predicate), else reject after timeoutMs.
function waitFor(socket, event, { timeout = 4000, match } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`timeout waiting for "${event}"`)); }, timeout);
    function handler(payload) {
      if (match && !match(payload)) return;
      clearTimeout(timer); socket.off(event, handler); resolve(payload);
    }
    socket.on(event, handler);
  });
}
// Assert an event does NOT arrive within the window.
function expectNo(socket, event, ms = 800) {
  return new Promise((resolve) => {
    let got = null;
    const handler = (p) => { got = p; };
    socket.on(event, handler);
    setTimeout(() => { socket.off(event, handler); resolve(got); }, ms);
  });
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const sockets = [];
function track(s) { sockets.push(s); return s; }

async function run() {
  const ROOM = 'vroom' + Math.floor(Date.now() % 100000);

  // ── Test A: teacher creates room, student joins, file upload mirrors ──
  console.log('Test A: join + file upload sync');
  const teacher = track(connect());
  await waitFor(teacher, 'connect');
  teacher.emit('join_room', { roomId: ROOM, userName: 'Teacher', role: 'teacher' });
  await waitFor(teacher, 'room_state').then(() => ok('teacher joined (room_state)')).catch(e => bad('teacher joined', e.message));

  const student = track(connect());
  await waitFor(student, 'connect');
  student.emit('join_room', { roomId: ROOM, userName: 'Ada', role: 'student' });
  await waitFor(student, 'room_state').then(() => ok('student joined (room_state)')).catch(e => bad('student joined', e.message));

  const f1 = { id: 'f1', name: 'Sim One', html: '<!doctype html><html><head></head><body><h1 id="t">SIM ONE</h1></body></html>', uploadedAt: Date.now() };
  const gotPreview = waitFor(student, 'run_preview', { match: p => p && typeof p.html === 'string' && p.html.includes('SIM ONE') });
  teacher.emit('upload_file', { roomId: ROOM, file: f1 });
  await gotPreview.then(() => ok('student received uploaded HTML (run_preview)')).catch(e => bad('student received uploaded HTML', e.message));

  // ── Test B: gate flow, answer-key leak, grading, anti-farm ──
  console.log('Test B: step-gate flow + answer-leak + XP anti-farm');
  const gateAdded = waitFor(student, 'gate_added', { match: p => p && p.step === 2 });
  teacher.emit('add_gate', { roomId: ROOM, step: 2, question: 'What is 2 + 2?', options: ['3', '4', '5'], correctIndex: 1 });
  const ga = await gateAdded.catch(() => null);
  assert(ga && ga.question === 'What is 2 + 2?' && Array.isArray(ga.options) && ga.options.length === 3,
    'student gate_added carries question + options', JSON.stringify(ga));
  assert(ga && ga.correctIndex === undefined, 'gate_added does NOT leak correctIndex', `correctIndex=${ga && ga.correctIndex}`);

  // session_state to the student must carry gates with correctIndex stripped
  const ss = waitFor(student, 'session_state', { match: p => p && p.gates && p.gates[2] });
  student.emit('request_content', { roomId: ROOM });
  const sstate = await ss.catch(() => null);
  assert(sstate && sstate.gates && sstate.gates[2] && sstate.gates[2].correctIndex === -1,
    'session_state gates hide correctIndex from student (-1)', sstate && JSON.stringify(sstate.gates[2]));

  // correct answer earns XP
  const res1 = waitFor(student, 'gate_result');
  student.emit('gate_answer', { roomId: ROOM, step: 2, answerIndex: 1, studentName: 'Ada' });
  const r1 = await res1.catch(() => null);
  assert(r1 && r1.correct === true && r1.xpGained > 0, 'correct gate answer grades + awards XP', JSON.stringify(r1));

  // repeat correct answer earns NO XP (anti-farm)
  const res2 = waitFor(student, 'gate_result');
  student.emit('gate_answer', { roomId: ROOM, step: 2, answerIndex: 1, studentName: 'Ada' });
  const r2 = await res2.catch(() => null);
  assert(r2 && r2.correct === true && r2.xpGained === 0, 'repeat correct answer earns 0 XP (anti-farm)', JSON.stringify(r2));

  // ── Test C: password gating (socket + HTTP fallback) ──
  console.log('Test C: room password gating');
  teacher.emit('set_room_password', { roomId: ROOM, password: 'secret' });
  await delay(150);

  const wrongPw = track(connect());
  await waitFor(wrongPw, 'connect');
  const wrongErr = waitFor(wrongPw, 'join_error');
  wrongPw.emit('join_room', { roomId: ROOM, userName: 'Eve', role: 'student', password: 'nope' });
  await wrongErr.then(() => ok('wrong password rejected (join_error)')).catch(e => bad('wrong password rejected', e.message));

  const rightPw = track(connect());
  await waitFor(rightPw, 'connect');
  const rightOk = waitFor(rightPw, 'room_state');
  rightPw.emit('join_room', { roomId: ROOM, userName: 'Bo', role: 'student', password: 'secret' });
  await rightOk.then(() => ok('correct password accepted')).catch(e => bad('correct password accepted', e.message));

  // HTTP fallback must refuse a password-protected room
  try {
    const httpRes = await fetch(`${URL}/api/room/${ROOM}/content`);
    assert(httpRes.status === 403, 'HTTP content fallback blocked for password room (403)', `status=${httpRes.status}`);
  } catch (e) { bad('HTTP content fallback blocked', e.message); }

  // ── Test D: deleting the active file repoints canonical HTML ──
  console.log('Test D: delete active file repoints to next file');
  // Need a 2nd room without a password so the student receives broadcasts cleanly.
  const ROOM2 = 'vroomb' + Math.floor(Date.now() % 100000);
  const t2 = track(connect()); await waitFor(t2, 'connect');
  t2.emit('join_room', { roomId: ROOM2, userName: 'Teacher2', role: 'teacher' });
  await waitFor(t2, 'room_state').catch(() => {});
  const s2 = track(connect()); await waitFor(s2, 'connect');
  s2.emit('join_room', { roomId: ROOM2, userName: 'Cy', role: 'student' });
  await waitFor(s2, 'room_state').catch(() => {});

  t2.emit('upload_file', { roomId: ROOM2, file: { id: 'a1', name: 'Alpha', html: '<!doctype html><body>ALPHA</body>', uploadedAt: Date.now() } });
  await waitFor(s2, 'run_preview', { match: p => p.html && p.html.includes('ALPHA') }).catch(() => {});
  t2.emit('upload_file', { roomId: ROOM2, file: { id: 'b2', name: 'Beta', html: '<!doctype html><body>BETA</body>', uploadedAt: Date.now() } });
  await waitFor(s2, 'run_preview', { match: p => p.html && p.html.includes('BETA') }).catch(() => {});

  // Delete the active file (b2) -> server should repoint to a1 and broadcast it.
  const repoint = waitFor(s2, 'run_preview', { match: p => p.html && p.html.includes('ALPHA') });
  const del = waitFor(s2, 'file_deleted', { match: p => p.fileId === 'b2' });
  t2.emit('delete_file', { roomId: ROOM2, fileId: 'b2' });
  const d = await del.catch(() => null);
  assert(d && d.newActiveId === 'a1', 'delete active file repoints newActiveId to remaining file', JSON.stringify(d));
  await repoint.then(() => ok('students re-served the remaining file after delete')).catch(e => bad('students re-served remaining file', e.message));

  // ── Test E: invalid switch_file does not crash / mis-point ──
  console.log('Test E: invalid switch_file is a no-op');
  t2.emit('switch_file', { roomId: ROOM2, fileId: 'does-not-exist' });
  await delay(200);
  // server still alive + valid switch still works
  const back = waitFor(s2, 'run_preview', { match: p => p.html && p.html.includes('ALPHA') });
  t2.emit('switch_file', { roomId: ROOM2, fileId: 'a1' });
  await back.then(() => ok('valid switch_file still works after an invalid one (no crash)')).catch(e => bad('valid switch after invalid', e.message));

  // ── Test F: NO live mirror — connected students don't get snapshot pushes ──
  console.log('Test F: non-force dom_snapshot is NOT pushed to connected students');
  // s2 is still in pendingSyncStudents (our driver-teacher has no iframe and
  // never acked the join-time snapshot request). The FIRST snapshot is the
  // legitimate late-join catch-up delivery that flushes the pending set.
  t2.emit('dom_snapshot', { roomId: ROOM2, html: '<!doctype html><body>ALPHA pending-flush</body>', requestId: `snap-hb-${Date.now()}` });
  await delay(500);
  // Now s2 is a caught-up, connected student: the next snapshot must NOT be
  // pushed to it in any form (the old live_dom mirror would have).
  const sawLiveDom = expectNo(s2, 'live_dom', 900);
  const sawDomSnap = expectNo(s2, 'dom_snapshot', 900);
  const sawRunPrev = expectNo(s2, 'run_preview', 900);
  t2.emit('dom_snapshot', { roomId: ROOM2, html: '<!doctype html><body>ALPHA mutated</body>', requestId: `snap-hb-${Date.now()}` });
  const [ld, ds, rp] = await Promise.all([sawLiveDom, sawDomSnap, sawRunPrev]);
  assert(ld === null, 'no live_dom pushed to connected student', JSON.stringify(ld)?.slice(0, 80));
  assert(ds === null, 'no dom_snapshot pushed to connected student', JSON.stringify(ds)?.slice(0, 80));
  assert(rp === null, 'no run_preview rebuild pushed to connected student', JSON.stringify(rp)?.slice(0, 80));

  // The snapshot must still land server-side for LATE JOINERS — delivered via
  // canonical session_state.effectiveHtml (clients render effectiveHtml first).
  const lateJoiner = track(connect());
  await waitFor(lateJoiner, 'connect');
  const lateState = waitFor(lateJoiner, 'session_state', { match: p => p?.effectiveHtml && p.effectiveHtml.includes('ALPHA mutated') });
  lateJoiner.emit('join_room', { roomId: ROOM2, userName: 'Late', role: 'student' });
  await lateState.then(() => ok('late joiner hydrates from the stored snapshot (effectiveHtml)')).catch(e => bad('late joiner hydrates from stored snapshot', e.message));

  // ── Test G: hasCanvas snapshots are never stored (canvas sims boot clean) ──
  console.log('Test G: hasCanvas snapshot policy');
  t2.emit('dom_snapshot', { roomId: ROOM2, html: '<!doctype html><body><canvas></canvas>EMPTY SHELL</body>', requestId: `snap-hb-${Date.now()}`, hasCanvas: true });
  await delay(300);
  const ssCanvas = waitFor(s2, 'session_state');
  s2.emit('request_content', { roomId: ROOM2 });
  const canvasState = await ssCanvas.catch(() => null);
  assert(canvasState && canvasState.liveSnapshotHtml === null, 'hasCanvas snapshot NOT stored as liveSnapshotHtml', `liveSnapshotHtml=${String(canvasState?.liveSnapshotHtml).slice(0, 60)}`);
  assert(canvasState && canvasState.effectiveHtml && !canvasState.effectiveHtml.includes('EMPTY SHELL'), 'effectiveHtml falls back to pristine source for canvas sims', String(canvasState?.effectiveHtml).slice(0, 60));

  // ── Test H: interactive student events broadcast to other students, not sender ──
  console.log('Test H: student interaction broadcast (interactive mode)');
  t2.emit('toggle_student_interaction', { roomId: ROOM2, allowed: true });
  await delay(250);
  const s3 = track(connect()); await waitFor(s3, 'connect');
  s3.emit('join_room', { roomId: ROOM2, userName: 'Dee', role: 'student' });
  await waitFor(s3, 'room_state').catch(() => {});
  const otherGets = waitFor(s3, 'interaction', { match: p => p?.type === 'SYNC_CLICK' });
  const teacherGets = waitFor(t2, 'interaction', { match: p => p?.type === 'SYNC_CLICK' });
  const senderEcho = expectNo(s2, 'interaction', 900);
  s2.emit('interaction', { roomId: ROOM2, event: { type: 'SYNC_CLICK', path: '#btn', clientX: 0.5, clientY: 0.5 } });
  await otherGets.then(() => ok('other student receives the click')).catch(e => bad('other student receives the click', e.message));
  await teacherGets.then(() => ok('teacher receives the click')).catch(e => bad('teacher receives the click', e.message));
  const echo = await senderEcho;
  assert(echo === null || echo?.type !== 'SYNC_CLICK', 'sender does NOT get their own click echoed', JSON.stringify(echo)?.slice(0, 80));

  // ── Test I: control handoff lets a non-interactive student drive ──
  console.log('Test I: control grant lets one student drive (toggle off)');
  const ROOM3 = 'vctl' + Math.floor(Date.now() % 100000);
  const t3 = track(connect()); await waitFor(t3, 'connect');
  t3.emit('join_room', { roomId: ROOM3, userName: 'Tî', role: 'teacher' });
  await waitFor(t3, 'room_state').catch(() => {});
  const driver = track(connect()); await waitFor(driver, 'connect');
  driver.emit('join_room', { roomId: ROOM3, userName: 'Mia', role: 'student' });
  await waitFor(driver, 'room_state').catch(() => {});
  const bystander = track(connect()); await waitFor(bystander, 'connect');
  bystander.emit('join_room', { roomId: ROOM3, userName: 'Sam', role: 'student' });
  await waitFor(bystander, 'room_state').catch(() => {});

  // interaction toggle is OFF by default → a student's click must be dropped.
  const noEcho = expectNo(t3, 'interaction', 700);
  driver.emit('interaction', { roomId: ROOM3, event: { type: 'SYNC_CLICK', path: '#x' } });
  const dropped = await noEcho;
  assert(dropped === null || dropped?.type !== 'SYNC_CLICK', 'student click dropped when not interactive & not control-holder', JSON.stringify(dropped)?.slice(0, 60));

  // grant control to Mia → her clicks now reach teacher + other students.
  const ctlChanged = waitFor(bystander, 'control_changed', { match: p => p.holderName === 'Mia' });
  t3.emit('grant_control', { roomId: ROOM3, holderName: 'Mia' });
  await ctlChanged.then(() => ok('control_changed broadcast to the room')).catch(e => bad('control_changed broadcast', e.message));
  const teacherSeesDriver = waitFor(t3, 'interaction', { match: p => p?.type === 'SYNC_CLICK' });
  const otherSeesDriver = waitFor(bystander, 'interaction', { match: p => p?.type === 'SYNC_CLICK' });
  driver.emit('interaction', { roomId: ROOM3, event: { type: 'SYNC_CLICK', path: '#y' } });
  await teacherSeesDriver.then(() => ok('control holder drives the teacher sim')).catch(e => bad('control holder drives teacher', e.message));
  await otherSeesDriver.then(() => ok('control holder drives other students')).catch(e => bad('control holder drives others', e.message));

  // a NON-holder student still can't drive.
  const noEcho2 = expectNo(t3, 'interaction', 700);
  bystander.emit('interaction', { roomId: ROOM3, event: { type: 'SYNC_CLICK', path: '#z' } });
  const dropped2 = await noEcho2;
  assert(dropped2 === null || dropped2?.type !== 'SYNC_CLICK', 'non-holder student still cannot drive', JSON.stringify(dropped2)?.slice(0, 60));

  // revoke → Mia can't drive anymore.
  const revoked = waitFor(driver, 'control_changed', { match: p => p.holderName === null });
  t3.emit('grant_control', { roomId: ROOM3, holderName: null });
  await revoked.then(() => ok('control revoked broadcast')).catch(e => bad('control revoked', e.message));

  // ── Test J: ping relays from a VIEW-ONLY student (no interaction, no control) ──
  console.log('Test J: SYNC_PING relays even from a view-only student');
  const pingSeen = waitFor(bystander, 'interaction', { match: p => p?.type === 'SYNC_PING' });
  driver.emit('interaction', { roomId: ROOM3, event: { type: 'SYNC_PING', clientX: 0.5, clientY: 0.5 } });
  await pingSeen.then(() => ok('view-only student ping reaches the room')).catch(e => bad('view-only ping reaches room', e.message));

  // ── Test K: peek round-trip (teacher requests → student answers → teacher gets it) ──
  console.log('Test K: student peek round-trip');
  driver.on('request_student_snapshot', ({ requestId }) => {
    driver.emit('student_snapshot', { roomId: ROOM3, html: '<!doctype html><body>MIA SCREEN</body>', requestId });
  });
  const driverId = driver.id;
  const peekBack = waitFor(t3, 'student_snapshot', { match: p => p?.html?.includes('MIA SCREEN') });
  t3.emit('peek_student', { roomId: ROOM3, studentId: driverId });
  const peek = await peekBack.catch(() => null);
  assert(peek && peek.studentName === 'Mia', 'teacher receives the peeked student screen', JSON.stringify(peek)?.slice(0, 80));

  // ── Test L: Time Machine bookmark + restore rewinds canonical HTML ──
  console.log('Test L: bookmark + restore rewinds the class');
  t3.emit('upload_file', { roomId: ROOM3, file: { id: 'tm1', name: 'V1', html: '<!doctype html><body>VERSION ONE</body>', uploadedAt: Date.now() } });
  await waitFor(driver, 'run_preview', { match: p => p.html?.includes('VERSION ONE') }).catch(() => {});
  const bmAdded = waitFor(t3, 'bookmarks_changed', { match: p => Array.isArray(p.bookmarks) && p.bookmarks.length >= 1 });
  t3.emit('bookmark_create', { roomId: ROOM3, name: 'Checkpoint A' });
  const bmList = await bmAdded.catch(() => null);
  assert(bmList && bmList.bookmarks[0]?.name === 'Checkpoint A', 'bookmark created + listed', JSON.stringify(bmList)?.slice(0, 80));
  // move on to V2, then rewind to the bookmark
  t3.emit('run_preview', { roomId: ROOM3, fileId: 'tm1', html: '<!doctype html><body>VERSION TWO</body>' });
  await waitFor(driver, 'run_preview', { match: p => p.html?.includes('VERSION TWO') }).catch(() => {});
  const restored = waitFor(driver, 'run_preview', { match: p => p.html?.includes('VERSION ONE') });
  t3.emit('bookmark_restore', { roomId: ROOM3, bookmarkId: bmList.bookmarks[0].id });
  await restored.then(() => ok('restoring a bookmark rewinds every client to that HTML')).catch(e => bad('bookmark restore rewinds clients', e.message));

  // ── Test M: event journal — late joiner receives the interaction stream ──
  console.log('Test M: event journal replays to late joiners');
  const ROOM4 = 'vjrnl' + Math.floor(Date.now() % 100000);
  const t4 = track(connect()); await waitFor(t4, 'connect');
  t4.emit('join_room', { roomId: ROOM4, userName: 'JT', role: 'teacher' });
  await waitFor(t4, 'room_state').catch(() => {});
  t4.emit('upload_file', { roomId: ROOM4, file: { id: 'j1', name: 'J', html: '<!doctype html><body><button id="b">go</button></body>', uploadedAt: Date.now() } });
  await delay(300);
  // three discrete teacher events + noise that must NOT be journaled
  t4.emit('interaction', { roomId: ROOM4, event: { type: 'SYNC_CLICK', path: '#b' } });
  t4.emit('interaction', { roomId: ROOM4, event: { type: 'SYNC_CURSOR', x: 0.1, y: 0.1 } });
  t4.emit('interaction', { roomId: ROOM4, event: { type: 'SYNC_INPUT', path: '#b', value: '7' } });
  t4.emit('interaction', { roomId: ROOM4, event: { type: 'SYNC_PING', clientX: 0.5, clientY: 0.5 } });
  t4.emit('interaction', { roomId: ROOM4, event: { type: 'SYNC_CLICK', path: '#b' } });
  await delay(300);
  const sLate = track(connect()); await waitFor(sLate, 'connect');
  const gotReplay = waitFor(sLate, 'interaction_replay');
  sLate.emit('join_room', { roomId: ROOM4, userName: 'LateLou', role: 'student' });
  const replay = await gotReplay.catch(() => null);
  assert(replay && Array.isArray(replay.events) && replay.events.length === 3,
    'late joiner gets exactly the 3 discrete events (cursor/ping excluded)', `got=${replay && replay.events?.map(e => e.type).join(',')}`);
  assert(replay && replay.events[0].type === 'SYNC_CLICK' && replay.events[1].type === 'SYNC_INPUT' && replay.events[2].type === 'SYNC_CLICK',
    'journal preserves event order', replay && replay.events?.map(e => e.type).join(','));

  // ── Test N: journal resets on a new baseline (run_preview) ──
  console.log('Test N: journal clears on new content baseline');
  t4.emit('run_preview', { roomId: ROOM4, fileId: 'j1', html: '<!doctype html><body><button id="b">v2</button></body>' });
  await delay(300);
  const sLate2 = track(connect()); await waitFor(sLate2, 'connect');
  const noReplay = expectNo(sLate2, 'interaction_replay', 900);
  sLate2.emit('join_room', { roomId: ROOM4, userName: 'LateLee', role: 'student' });
  const nr = await noReplay;
  assert(nr === null, 'no replay after run_preview baseline (journal cleared)', JSON.stringify(nr)?.slice(0, 60));

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error('FATAL', err); for (const s of sockets) { try { s.close(); } catch {} } process.exit(2); });
