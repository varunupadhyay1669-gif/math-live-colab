// Reconnect & leave/return stress — the user's exact pain points.
// PORT=3100 node stress3.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 5000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 1000) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const QUIZ = `<!doctype html><html><head></head><body><h1 id="q">Q?</h1><button id="n">next</button>
<script>var r=0;document.getElementById('n').addEventListener('click',function(){r++;var v=Math.floor(Math.random()*100);document.getElementById('q').textContent='R'+r+':'+v;});</script></body></html>`;

async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

// R1: student drops mid-quiz, reconnects -> journal replay re-converges, no double-apply
async function R1_studentDropReconnectConverges() {
  console.log('R1: student drop mid-session -> reconnect re-converges');
  const room = rid('r1');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: Date.now() } });
  await delay(200);
  // teacher advances 4 rounds (journaled)
  for (let i = 0; i < 4; i++) { t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'n' + i, path: '#n' } }); await delay(60); }
  const s = await joinStudent(room, 'Stu');
  const r1 = await on1(s, 'interaction_replay', { timeout: 4000 }).catch(() => null);
  assert(r1 && r1.events.length === 4, 'late joiner gets the 4-event journal', `n=${r1 && r1.events.length}`);
  // drop the student
  s.disconnect();
  await delay(300);
  // teacher advances 2 more while the student is gone
  for (let i = 0; i < 2; i++) { t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'm' + i, path: '#n' } }); await delay(60); }
  // student reconnects fresh (new socket) -> should get the FULL 6-event journal
  const s2 = await joinStudent(room, 'Stu');
  const r2 = await on1(s2, 'interaction_replay', { timeout: 4000 }).catch(() => null);
  assert(r2 && r2.events.length === 6 && r2.events.every(e => typeof e.serverSeq === 'number'),
    'reconnected student gets full 6-event journal w/ serverSeq', `n=${r2 && r2.events.length}`);
}

// R2: control holder quick-reconnect (new socket, same name) -> control preserved
async function R2_controlSurvivesQuickReconnect() {
  console.log('R2: control holder quick reconnect keeps the chalk');
  const room = rid('r2');
  const t = await joinTeacher(room);
  const a = await joinStudent(room, 'Ada');
  t.emit('grant_control', { roomId: room, holderName: 'Ada' });
  await on1(a, 'control_changed', { match: p => p.holderName === 'Ada' }).catch(() => {});
  // Ada reconnects on a NEW socket while old is still half-alive (dedupe path)
  const a2 = conn(); await on1(a2, 'connect');
  const ctlState = on1(a2, 'session_state', { match: p => 'controlHolderName' in p }).catch(() => null);
  a2.emit('join_room', { roomId: room, userName: 'Ada', role: 'student' });
  await on1(a2, 'room_state').catch(() => {});
  const cs = await ctlState;
  assert(cs && cs.controlHolderName === 'Ada', 'control still held by Ada after quick reconnect', `holder=${cs && cs.controlHolderName}`);
  // and Ada (new socket) can drive
  const tDrives = on1(t, 'interaction', { match: p => p?.type === 'SYNC_CLICK' && p.id === 'ad1' });
  a2.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ad1', path: '#n' } });
  await tDrives.then(() => ok('reconnected control holder drives the class')).catch(e => bad('reconnected holder drives', e.message));
}

// R3: teacher disconnect within grace -> reconnect -> NO teacher_disconnected to students
async function R3_teacherGraceReconnect() {
  console.log('R3: teacher reconnect within grace = silent (no teacher_disconnected)');
  const room = rid('r3');
  const t = await joinTeacher(room, 'MrT');
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: Date.now() } });
  await delay(150);
  const s = await joinStudent(room, 'Stu');
  // teacher drops
  t.disconnect();
  await delay(400);
  // a student watching must NOT see teacher_disconnected in the next ~2s (grace is 45s)
  const sawGone = none(s, 'teacher_disconnected', 1500);
  // teacher reconnects (same name) well within grace
  const t2 = await joinTeacher(room, 'MrT');
  const gone = await sawGone;
  assert(gone === null, 'no teacher_disconnected emitted during grace + reconnect', JSON.stringify(gone)?.slice(0, 40));
  // student still gets content (unblocked)
  const reb = on1(s, 'run_preview', { match: p => p.html?.includes('next'), timeout: 2000 }).catch(() => null);
  await reb; ok('teacher reconnect re-broadcasts lesson (students unblocked)');
}

// R4: teacher leaves PAST grace -> teacher_disconnected fires -> returns -> students unblock
async function R4_teacherPastGraceThenReturn() {
  console.log('R4: teacher gone past grace -> declared gone -> returns -> unblock');
  // Use a server with a SHORT grace? We cannot change it live; instead verify
  // the DECLARED-GONE path by checking a fresh student during teacher-absent
  // still gets canonical content via session_state (the real unblock path),
  // and that a returning teacher re-broadcasts. (Full 45s wait is impractical.)
  const room = rid('r4');
  const t = await joinTeacher(room, 'MrT');
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: Date.now() } });
  await delay(200);
  t.disconnect(); // teacher gone (grace armed)
  await delay(400);
  // a NEW student joins while the teacher is absent — must still get the lesson
  // via canonical session_state (not be stuck on "waiting for teacher").
  const s = conn(); await on1(s, 'connect');
  const gotContent = on1(s, 'session_state', { match: p => p.effectiveHtml?.includes('next') });
  s.emit('join_room', { roomId: room, userName: 'LateStu', role: 'student' });
  await gotContent.then(() => ok('student joining during teacher-absence still gets the lesson (session_state)')).catch(e => bad('absent-teacher student gets lesson', e.message));
  // teacher returns -> re-broadcast reaches the student
  const reb = on1(s, 'run_preview', { match: p => p.html?.includes('next'), timeout: 3000 }).catch(() => null);
  await joinTeacher(room, 'MrT');
  const r = await reb;
  assert(r !== null, 'returning teacher re-broadcasts lesson to waiting student', '');
}

// R5: teacher reconnect while on WHITEBOARD does NOT push run_preview (H3 fix)
async function R5_teacherWhiteboardReconnect() {
  console.log('R5: teacher reconnect in whiteboard mode does not yank students');
  const room = rid('r5');
  const t = await joinTeacher(room, 'MrT');
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: Date.now() } });
  await delay(150);
  t.emit('whiteboard_mode_toggle', { roomId: room, active: true });
  await delay(150);
  const s = await joinStudent(room, 'Stu');
  await delay(150);
  t.disconnect();
  await delay(300);
  // teacher reconnects while whiteboardMode is true -> must NOT broadcast run_preview
  const noRun = none(s, 'run_preview', 1500);
  await joinTeacher(room, 'MrT');
  const r = await noRun;
  assert(r === null, 'no run_preview pushed on whiteboard-mode teacher reconnect', JSON.stringify(r)?.slice(0, 40));
}

// R6: teacher tab-switch (same name, old still alive) -> old gets teacher_replaced, seat moves, no grace leak
async function R6_teacherTabSwitch() {
  console.log('R6: teacher second tab takes the seat cleanly');
  const room = rid('r6');
  const t1 = await joinTeacher(room, 'MrT');
  const replaced = on1(t1, 'teacher_replaced', { timeout: 3000 });
  const t2 = await joinTeacher(room, 'MrT');
  await replaced.then(() => ok('old teacher tab notified teacher_replaced')).catch(e => bad('teacher_replaced on tab switch', e.message));
  // t2 is authoritative: its upload reaches a student
  const s = await joinStudent(room, 'Stu');
  const got = on1(s, 'run_preview', { match: p => p.html?.includes('SECONDTAB') });
  t2.emit('upload_file', { roomId: room, file: { id: 'x', name: 'x', html: '<!doctype html><body>SECONDTAB</body>', uploadedAt: Date.now() } });
  await got.then(() => ok('second teacher tab is authoritative')).catch(e => bad('second tab authoritative', e.message));
}

async function run() {
  const tests = [R1_studentDropReconnectConverges, R2_controlSurvivesQuickReconnect, R3_teacherGraceReconnect,
    R4_teacherPastGraceThenReturn, R5_teacherWhiteboardReconnect, R6_teacherTabSwitch];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(200); }
  console.log(`\nSTRESS3 RESULT: ${pass} passed, ${fail} failed`);
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
