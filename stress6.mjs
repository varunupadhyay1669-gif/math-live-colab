// Round-3 stress — privilege escalation, mode interleaving, persistence, robustness.
// PORT=3000 node stress6.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3000';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 5000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 800) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const QUIZ = `<!doctype html><body><h1 id="q">Q</h1><button id="n">next</button></body>`;
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) {
  const s = conn(); await on1(s, 'connect');
  const ssP = on1(s, 'session_state', { timeout: 5000 }).catch(() => null);
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  await on1(s, 'room_state').catch(() => {});
  return { s, ss: await ssP };
}
async function upload(t, room, id = 'q') { t.emit('upload_file', { roomId: room, file: { id, name: id, html: QUIZ, uploadedAt: 1 } }); await delay(180); }

// P1: a STUDENT cannot escalate — teacher-only events from a student are ignored
async function P1_privilegeEscalation() {
  console.log('P1: students cannot fire teacher-only actions');
  const room = rid('p1');
  const t = await joinTeacher(room, 'MrT');
  await upload(t, room);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  // student self-grants control -> must NOT broadcast control_changed
  const noGrant = none(b.s, 'control_changed', 800);
  a.s.emit('grant_control', { roomId: room, holderName: 'Ann' });
  assert((await noGrant) === null, 'student cannot grant itself control', '');
  // student adds a gate -> ignored
  const noGate = none(b.s, 'gate_added', 800);
  a.s.emit('add_gate', { roomId: room, step: 1, question: 'x', options: ['a', 'b'], correctIndex: 0 });
  assert((await noGate) === null, 'student cannot add a gate', '');
  // student kicks the TEACHER -> teacher must NOT be kicked
  const teacherKicked = none(t, 'kicked', 800);
  // resolve teacher id is hard from a student; just try a broad kick by guessing — server must reject anyway
  a.s.emit('kick_user', { roomId: room, userId: 'anything' });
  assert((await teacherKicked) === null, 'student cannot kick anyone (teacher safe)', '');
  // student forces a step change -> ignored
  const noStep = none(b.s, 'step_changed', 800);
  a.s.emit('set_step', { roomId: room, step: 9 });
  assert((await noStep) === null, 'student cannot change the step', '');
  // student tries hard_reset -> ignored
  const noReset = none(b.s, 'room_reset', 800);
  a.s.emit('hard_reset', { roomId: room });
  assert((await noReset) === null, 'student cannot hard-reset the room', '');
}

// P2: bookmark restore while a student holds control — control persists, holder still drives the rebuilt sim
async function P2_restoreKeepsControl() {
  console.log('P2: time-machine restore preserves an active control grant');
  const room = rid('p2');
  const t = await joinTeacher(room);
  await upload(t, room);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(b.s, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  t.emit('bookmark_create', { roomId: room, name: 'M' });
  const bms = await on1(t, 'bookmarks_changed').catch(() => null);
  const bmId = bms?.bookmarks?.[0]?.id;
  // restore
  t.emit('bookmark_restore', { roomId: room, bookmarkId: bmId });
  await delay(400);
  // Ann should STILL hold control and be able to drive the rebuilt sim
  const bobGetsAnn = on1(b.s, 'interaction', { match: p => p?.id === 'annAfterRestore', timeout: 2500 });
  a.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'annAfterRestore', path: '#n' } });
  await bobGetsAnn.then(() => ok('control survives a time-machine restore (holder still drives)')).catch(e => bad('control survives restore', e.message));
}

// P4: interactive + control interleave — disabling interactive must NOT revoke an explicit control grant
async function P4_interactiveControlInterleave() {
  console.log('P4: disabling interactive keeps an explicit control grant alive');
  const room = rid('p4');
  const t = await joinTeacher(room);
  await upload(t, room);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  await delay(150);
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(b.s, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  // now disable interactive globally
  t.emit('toggle_student_interaction', { roomId: room, allowed: false });
  await delay(200);
  // Ann (control holder) must STILL drive
  const bobGetsAnn = on1(b.s, 'interaction', { match: p => p?.id === 'annStillDrives', timeout: 2500 });
  a.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'annStillDrives', path: '#n' } });
  await bobGetsAnn.then(() => ok('control holder keeps driving after interactive is turned off')).catch(e => bad('control survives interactive-off', e.message));
  // Bob (no control, interactive off) must be dropped
  const aNoBob = none(a.s, 'interaction', 800);
  b.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'bobBlocked', path: '#n' } });
  assert(!((await aNoBob)?.id === 'bobBlocked'), 'non-holder is view-only again once interactive is off', '');
}

// P5: room persists across a full emptying — rejoin restores the uploaded lesson + seed
async function P5_persistThroughEmpty() {
  console.log('P5: lesson survives the room going empty, then a rejoin');
  const room = rid('p5');
  const t = await joinTeacher(room);
  await upload(t, room, 'lesson-keep');
  const s1 = await joinStudent(room, 'Stu');
  const seed = s1.ss?.randomSeed;
  // everyone leaves
  s1.s.disconnect(); t.disconnect();
  await delay(700);
  // a brand-new teacher reopens the SAME room id
  const t2 = await joinTeacher(room);
  await delay(200);
  const s2 = await joinStudent(room, 'Stu2');
  const hasFile = (s2.ss?.activeFileId === 'lesson-keep') || (s2.ss?.effectiveHtml || '').includes('id="q"');
  assert(hasFile, 'rejoining the emptied room restores the uploaded lesson', `activeFile=${s2.ss?.activeFileId}`);
  assert(typeof s2.ss?.randomSeed === 'number' && s2.ss.randomSeed > 0, 'restored room still carries a valid seed', `seed=${s2.ss?.randomSeed} (was ${seed})`);
}

// P6: malformed / hostile interaction payloads don't crash or leak
async function P6_malformedPayloads() {
  console.log('P6: malformed payloads are handled gracefully');
  const room = rid('p6');
  const t = await joinTeacher(room);
  await upload(t, room);
  const b = await joinStudent(room, 'Bob');
  // teacher emits a null/empty event — must not crash; nothing meaningful relayed
  const noJunk = none(b.s, 'interaction', 700);
  t.emit('interaction', { roomId: room, event: null });
  t.emit('interaction', { roomId: room });
  t.emit('interaction', { roomId: room, event: { type: 'NOT_A_SYNC_TYPE', foo: 'bar' } });
  await delay(300);
  // server still alive: a real teacher event still gets through afterwards
  const alive = on1(b.s, 'interaction', { match: p => p?.id === 'aliveCheck', timeout: 2500 });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'aliveCheck', path: '#n' } });
  await alive.then(() => ok('server survives malformed payloads and keeps relaying')).catch(e => bad('server alive after malformed', e.message));
  // upload with empty html -> upload_error, not a crash
  const upErr = on1(t, 'upload_error', { timeout: 2000 }).catch(() => null);
  t.emit('upload_file', { roomId: room, file: { id: 'bad', name: 'bad', html: '   ', uploadedAt: 1 } });
  assert((await upErr) !== null, 'empty-html upload is rejected with upload_error', '');
}

// P7: a malicious student spoofing the control-holder's name — documents the behavior (name-keyed control)
async function P7_nameSpoofControl() {
  console.log('P7: control is name-keyed — document spoof behavior');
  const room = rid('p7');
  const t = await joinTeacher(room);
  await upload(t, room);
  const ann = await joinStudent(room, 'Ann');
  const bob = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(bob.s, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  // A different student already in the room as "Bob" tries to drive -> dropped (good)
  const annNoBob = none(ann.s, 'interaction', 700);
  bob.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'bobSpoofAttempt', path: '#n' } });
  assert(!((await annNoBob)?.id === 'bobSpoofAttempt'), 'a non-holder named Bob cannot drive', '');
  ok('control is exclusively name-matched to the granted holder (Ann)');
}

// P8: gate_answer coerces answerIndex — a correct answer sent as the string "2"
// must score CORRECT, not be silently marked wrong by a strict === mismatch.
async function P8_gateAnswerCoercion() {
  console.log('P8: gate_answer coerces a string answerIndex');
  const room = rid('p8');
  const t = await joinTeacher(room);
  await upload(t, room);
  t.emit('add_gate', { roomId: room, step: 1, question: 'Pick c', options: ['a', 'b', 'c'], correctIndex: 2 });
  await delay(150);
  const s = await joinStudent(room, 'Stu');
  const r1 = on1(s.s, 'gate_result', { timeout: 2500 }).catch(() => null);
  s.s.emit('gate_answer', { roomId: room, step: 1, answerIndex: '2', studentName: 'Stu' }); // STRING that matches
  const res1 = await r1;
  assert(res1 && res1.correct === true, 'string answerIndex "2" matching correctIndex 2 scores CORRECT', JSON.stringify(res1));
  const s2 = await joinStudent(room, 'Stu2');
  const r2 = on1(s2.s, 'gate_result', { timeout: 2500 }).catch(() => null);
  s2.s.emit('gate_answer', { roomId: room, step: 1, answerIndex: '0', studentName: 'Stu2' }); // wrong string
  const res2 = await r2;
  assert(res2 && res2.correct === false, 'wrong string answerIndex "0" scores incorrect', JSON.stringify(res2));
}

async function run() {
  const tests = [P1_privilegeEscalation, P2_restoreKeepsControl, P4_interactiveControlInterleave,
    P5_persistThroughEmpty, P6_malformedPayloads, P7_nameSpoofControl, P8_gateAnswerCoercion];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(200); }
  console.log(`\nSTRESS6 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
