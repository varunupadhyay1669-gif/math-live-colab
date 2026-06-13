// Adversarial stress test — exercises the INTERACTIONS between features
// (where regressions hide), not each feature in isolation. Run against a live
// server:  PORT=3100 node stress.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket', 'polling'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 4000, match } = {}) {
  return new Promise((res, rej) => {
    const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout);
    function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); }
    s.on(ev, h);
  });
}
function none(s, ev, ms = 800) {
  return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); });
}
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const FILE = (id, body) => ({ id, name: id, html: `<!doctype html><html><head></head><body>${body}</body></html>`, uploadedAt: Date.now() });

async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

async function S1_controlHolderDisconnectClears() {
  console.log('S1: control auto-clears when the holder disconnects');
  const room = rid('s1');
  const t = await joinTeacher(room);
  const a = await joinStudent(room, 'Ann');
  const cleared = on1(t, 'control_changed', { match: p => p.holderName === null, timeout: 6000 });
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(t, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  a.disconnect();
  await cleared.then(() => ok('holder disconnect broadcast control_changed=null')).catch(e => bad('holder disconnect clears control', e.message));
}

async function S2_controlChainSingleWriter() {
  console.log('S2: control chain keeps exactly one writer');
  const room = rid('s2');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: FILE('f', 'X') });
  await delay(200);
  const a = await joinStudent(room, 'Ada');
  const b = await joinStudent(room, 'Bo');
  // grant A → A drives (t + b receive A's click)
  t.emit('grant_control', { roomId: room, holderName: 'Ada' });
  await delay(200);
  const tGetsA = on1(t, 'interaction', { match: p => p?.type === 'SYNC_CLICK' && p.id === 'a1' });
  const bGetsA = on1(b, 'interaction', { match: p => p?.type === 'SYNC_CLICK' && p.id === 'a1' });
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'a1', path: '#x' } });
  await tGetsA.then(() => ok('A holds: A drives teacher')).catch(e => bad('A drives teacher', e.message));
  await bGetsA.then(() => ok('A holds: A drives other student B')).catch(e => bad('A drives B', e.message));
  // grant B → A must STOP driving
  t.emit('grant_control', { roomId: room, holderName: 'Bo' });
  await delay(250);
  const aStillDrives = none(t, 'interaction', 900);
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'a2', path: '#x' } });
  const r = await aStillDrives;
  assert(r === null || r?.id !== 'a2', 'after handoff to B, A no longer drives', JSON.stringify(r)?.slice(0, 50));
  // B now drives
  const tGetsB = on1(t, 'interaction', { match: p => p?.type === 'SYNC_CLICK' && p.id === 'b1' });
  b.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'b1', path: '#x' } });
  await tGetsB.then(() => ok('B now drives')).catch(e => bad('B drives', e.message));
}

async function S3_teacherIsMirrorWhileStudentControls() {
  console.log('S3: teacher does NOT drive while a student holds control (single writer)');
  const room = rid('s3');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: FILE('f', 'X') });
  await delay(200);
  const a = await joinStudent(room, 'Ada');
  const b = await joinStudent(room, 'Bo');
  t.emit('grant_control', { roomId: room, holderName: 'Ada' });
  await delay(250);
  // The teacher emits a sim-driving click while Ada holds control. With a true
  // single-writer model, students must NOT receive the teacher's click (the
  // teacher is a mirror of Ada right now). cursor is exempt (pointing is fine).
  const bGetsTeacher = none(b, 'interaction', 900);
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 't1', path: '#x' } });
  const r = await bGetsTeacher;
  assert(r === null || r?.id !== 't1', 'teacher click is NOT relayed while a student holds control', JSON.stringify(r)?.slice(0, 50));
  // teacher cursor SHOULD still reach students (pointing is harmless)
  const bGetsCursor = on1(b, 'interaction', { match: p => p?.type === 'SYNC_CURSOR' });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CURSOR', x: 0.5, y: 0.5 } });
  await bGetsCursor.then(() => ok('teacher cursor still reaches students while mirroring')).catch(e => bad('teacher cursor relays while mirroring', e.message));
}

async function S4_bookmarkRestoreFollows() {
  console.log('S4: bookmark restore rewinds every client + reseeds');
  const room = rid('s4');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  t.emit('upload_file', { roomId: room, file: FILE('v1', 'VERSION ONE') });
  await on1(s, 'run_preview', { match: p => p.html?.includes('VERSION ONE') }).catch(() => {});
  const st1 = await on1(t, 'sync_full_state', { match: p => p.randomSeed > 0 }).catch(() => null);
  const bmAdded = on1(t, 'bookmarks_changed', { match: p => p.bookmarks?.length >= 1 });
  t.emit('bookmark_create', { roomId: room, name: 'A' });
  const bm = await bmAdded.catch(() => null);
  t.emit('run_preview', { roomId: room, fileId: 'v1', html: '<!doctype html><body>VERSION TWO</body>' });
  await on1(s, 'run_preview', { match: p => p.html?.includes('VERSION TWO') }).catch(() => {});
  const restored = on1(s, 'run_preview', { match: p => p.html?.includes('VERSION ONE') });
  // restore broadcasts canonical sync_full_state (not unicast session_state)
  const reseeded = on1(s, 'sync_full_state', { match: p => typeof p.randomSeed === 'number' && p.randomSeed > 0 && p.randomSeed !== (st1 && st1.randomSeed) });
  t.emit('bookmark_restore', { roomId: room, bookmarkId: bm.bookmarks[0].id });
  await restored.then(() => ok('restore rewinds the student to the bookmarked HTML')).catch(e => bad('restore rewinds student', e.message));
  await reseeded.then(() => ok('restore delivers a fresh seed (new baseline)')).catch(e => bad('restore reseeds', e.message));
}

async function S5_rapidFileSwitchConverges() {
  console.log('S5: rapid file switches — student lands on the last file');
  const room = rid('s5');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  t.emit('upload_file', { roomId: room, file: FILE('a', 'ALPHA') });
  await delay(120);
  t.emit('upload_file', { roomId: room, file: FILE('b', 'BETA') });
  await delay(120);
  t.emit('upload_file', { roomId: room, file: FILE('c', 'GAMMA') });
  await delay(120);
  t.emit('switch_file', { roomId: room, fileId: 'a' });
  await delay(120);
  t.emit('switch_file', { roomId: room, fileId: 'c' });
  // student's effectiveHtml should settle on GAMMA
  const settle = on1(s, 'session_state', { match: p => p.effectiveHtml?.includes('GAMMA'), timeout: 5000 });
  s.emit('request_content', { roomId: room });
  await settle.then(() => ok('student converges to the final switched file (GAMMA)')).catch(e => bad('student converges to final file', e.message));
}

async function S6_whiteboardPerms() {
  console.log('S6: whiteboard draw gated to teacher/interactive');
  const room = rid('s6');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  // view-only: student whiteboard_draw is rejected (not relayed to teacher)
  const noWb = none(t, 'whiteboard_stroke', 800);
  s.emit('whiteboard_draw', { roomId: room, stroke: { id: 'w1', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], color: '#000', width: 2, tool: 'pen' } });
  const r = await noWb;
  assert(r === null, 'view-only student cannot draw on whiteboard', JSON.stringify(r)?.slice(0, 50));
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  await delay(200);
  const gotWb = on1(t, 'whiteboard_stroke', { match: p => p.stroke?.id === 'w2' });
  s.emit('whiteboard_draw', { roomId: room, stroke: { id: 'w2', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], color: '#000', width: 2, tool: 'pen' } });
  await gotWb.then(() => ok('interactive student can draw on whiteboard')).catch(e => bad('interactive student whiteboard draw', e.message));
}

async function S7_largePayloadsRejected() {
  console.log('S7: oversized payloads rejected (no crash, server stays alive)');
  const room = rid('s7');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  const huge = 'x'.repeat(3 * 1024 * 1024); // 3MB > 2MB cap
  t.emit('upload_file', { roomId: room, file: { id: 'big', name: 'big', html: '<body>' + huge + '</body>', uploadedAt: Date.now() } });
  const upErr = await on1(t, 'upload_error', { timeout: 3000 }).catch(() => null);
  assert(upErr !== null, 'oversized upload is rejected with upload_error', '');
  // server still alive: a normal upload still works
  t.emit('upload_file', { roomId: room, file: FILE('ok', 'FINE') });
  await on1(s, 'run_preview', { match: p => p.html?.includes('FINE'), timeout: 4000 })
    .then(() => ok('server healthy after oversized payload (normal upload works)')).catch(e => bad('server healthy after big payload', e.message));
}

async function S8_reconnectKeepsConvergence() {
  console.log('S8: student reconnect re-converges, no double-apply');
  const room = rid('s8');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: FILE('cnt', '<span id="n">0</span>') });
  await delay(200);
  // three journaled discrete events
  for (const id of ['e1', 'e2', 'e3']) { t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id, path: '#n' } }); await delay(60); }
  const s = await joinStudent(room, 'Stu');
  const firstReplay = await on1(s, 'interaction_replay', { timeout: 4000 }).catch(() => null);
  assert(firstReplay && firstReplay.events.length === 3, 'late joiner gets 3-event journal', `n=${firstReplay && firstReplay.events.length}`);
  // simulate a blip: same-name rejoin (server kicks old, new one is a fresh sim → full replay)
  const s2 = conn(); await on1(s2, 'connect');
  const replay2 = on1(s2, 'interaction_replay', { timeout: 4000 });
  s2.emit('join_room', { roomId: room, userName: 'Stu', role: 'student' });
  const r2 = await replay2.catch(() => null);
  assert(r2 && r2.events.length === 3 && r2.events.every(e => typeof e.serverSeq === 'number'),
    'rejoined student gets the journal with serverSeq (client gap-filters)', `n=${r2 && r2.events.length}`);
}

async function S9_gateWhileControlling() {
  console.log('S9: gate answering works for the control-holder');
  const room = rid('s9');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  t.emit('add_gate', { roomId: room, step: 1, question: 'Q?', options: ['a', 'b'], correctIndex: 1 });
  await on1(s, 'gate_added', { match: p => p.step === 1 }).catch(() => {});
  t.emit('grant_control', { roomId: room, holderName: 'Stu' });
  await delay(150);
  const res = on1(s, 'gate_result');
  s.emit('gate_answer', { roomId: room, step: 1, answerIndex: 1, studentName: 'Stu' });
  const r = await res.catch(() => null);
  assert(r && r.correct === true && r.xpGained > 0, 'control-holder can answer a gate + earn XP', JSON.stringify(r)?.slice(0, 60));
}

async function S10_pingFromViewOnly() {
  console.log('S10: any student can ping (look-here) even view-only');
  const room = rid('s10');
  const t = await joinTeacher(room);
  const a = await joinStudent(room, 'A');
  const b = await joinStudent(room, 'B');
  const teacherPing = on1(t, 'interaction', { match: p => p?.type === 'SYNC_PING' });
  const bPing = on1(b, 'interaction', { match: p => p?.type === 'SYNC_PING' });
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_PING', clientX: 0.5, clientY: 0.5 } });
  await teacherPing.then(() => ok('view-only student ping reaches teacher')).catch(e => bad('ping to teacher', e.message));
  await bPing.then(() => ok('view-only student ping reaches other students')).catch(e => bad('ping to other students', e.message));
}

async function run() {
  const tests = [S1_controlHolderDisconnectClears, S2_controlChainSingleWriter, S3_teacherIsMirrorWhileStudentControls,
    S4_bookmarkRestoreFollows, S5_rapidFileSwitchConverges, S6_whiteboardPerms, S7_largePayloadsRejected,
    S8_reconnectKeepsConvergence, S9_gateWhileControlling, S10_pingFromViewOnly];
  for (const test of tests) {
    try { await test(); } catch (e) { bad(test.name + ' threw', e.message); }
    await delay(150);
  }
  console.log(`\nSTRESS RESULT: ${pass} passed, ${fail} failed`);
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
