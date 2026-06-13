// Adversarial stress round 2 — the handlers not covered by round 1:
// hard reset, kick, explanation late-join, claim, attention, chat hardening,
// whiteboard caps/validation, gate validation. PORT=3100 node stress2.mjs
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
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 800) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const FILE = (id, body) => ({ id, name: id, html: `<!doctype html><body>${body}</body>`, uploadedAt: Date.now() });
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

async function T1_hardReset() {
  console.log('T1: hard reset clears session + control, preserves files');
  const room = rid('t1');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: FILE('f', 'LESSON') });
  await delay(150);
  const s = await joinStudent(room, 'Stu');
  t.emit('grant_control', { roomId: room, holderName: 'Stu' });
  await on1(s, 'control_changed', { match: p => p.holderName === 'Stu' }).catch(() => {});
  t.emit('add_gate', { roomId: room, step: 1, question: 'Q', options: ['a', 'b'], correctIndex: 0 });
  await delay(150);
  const ctlCleared = on1(s, 'control_changed', { match: p => p.holderName === null });
  const reset = on1(s, 'room_reset');
  t.emit('hard_reset', { roomId: room });
  const rp = await reset.catch(() => null);
  assert(rp && Array.isArray(rp.files) && rp.files.some(f => f.id === 'f'), 'hard_reset PRESERVES uploaded files', JSON.stringify(rp?.files?.length));
  await ctlCleared.then(() => ok('hard_reset clears the control grant')).catch(e => bad('hard_reset clears control', e.message));
}

async function T2_kick() {
  console.log('T2: kick removes the student');
  const room = rid('t2');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  const kicked = on1(s, 'kicked');
  // resolve the student's socket id from the user_list the teacher holds
  const list = await on1(t, 'user_list', { match: l => l.some(u => u.role === 'student'), timeout: 3000 }).catch(() => null);
  const sid = list?.find(u => u.role === 'student')?.id;
  assert(!!sid, 'teacher sees the student in user_list', '');
  t.emit('kick_user', { roomId: room, userId: sid });
  await kicked.then(() => ok('kicked student receives kicked event')).catch(e => bad('student kicked', e.message));
}

async function T3_explanationLateJoin() {
  console.log('T3: late joiner receives active explanation (temp content)');
  const room = rid('t3');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: FILE('f', 'MAIN') });
  await delay(150);
  t.emit('show_temp_content', { roomId: room, html: '<!doctype html><body>EXPLAIN THIS</body>', name: 'Aside' });
  await delay(200);
  const s = conn(); await on1(s, 'connect');
  const temp = on1(s, 'temp_content', { match: p => p.html?.includes('EXPLAIN THIS') });
  s.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  await temp.then(() => ok('late joiner gets the active explanation overlay')).catch(e => bad('late joiner explanation', e.message));
}

async function T4_whiteboardUpdateCap() {
  console.log('T4: whiteboard image-update cannot bypass the size cap');
  const room = rid('t4');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  await delay(150);
  // add a tiny image (allowed in interactive mode)
  t.emit('whiteboard_add_image', { roomId: room, object: { id: 'img1', type: 'image', src: 'data:image/png;base64,AAAA', x: 0, y: 0, width: 10, height: 10 } });
  await delay(150);
  // try to UPDATE it to a 7MB src — must be rejected (not relayed to the student)
  const huge = 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024);
  const noUpdate = none(s, 'whiteboard_update_object', 900);
  t.emit('whiteboard_update_object', { roomId: room, object: { id: 'img1', type: 'image', src: huge, x: 5, y: 5, width: 10, height: 10 } });
  const r = await noUpdate;
  assert(r === null, 'oversized whiteboard image update is rejected', r ? 'relayed ' + (r.object?.src?.length) : '');
}

async function T5_claimRoom() {
  console.log('T5: claim room flips claimed + broadcasts');
  const room = rid('t5');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: FILE('f', 'X') });
  await delay(150);
  const claimed = on1(t, 'room_claimed', { match: p => p.claimed === true });
  t.emit('claim_room', { roomId: room, name: 'MsP' });
  const c = await claimed.catch(() => null);
  assert(c && c.claimed === true && typeof c.expiresAt === 'number', 'claim_room broadcasts claimed + expiry', JSON.stringify(c)?.slice(0, 60));
}

async function T6_attention() {
  console.log('T6: attention check ack reaches teacher');
  const room = rid('t6');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  // Register the student's auto-ack BEFORE the teacher pings (no race).
  s.on('attention_check', () => s.emit('attention_ack', { roomId: room, studentName: 'Stu' }));
  const ackGot = on1(t, 'attention_ack', { match: p => p.studentName === 'Stu' });
  t.emit('attention_check', { roomId: room });
  await ackGot.then(() => ok('teacher receives the attention ack')).catch(e => bad('attention ack', e.message));
}

async function T7_chatHardening() {
  console.log('T7: chat sanitization + empty rejection');
  const room = rid('t7');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  // empty message → no chat_message
  const noEmpty = none(s, 'chat_message', 700);
  s.emit('send_chat', { roomId: room, message: '   ', userName: 'Stu' });
  const e = await noEmpty;
  assert(e === null, 'empty chat message is dropped', JSON.stringify(e)?.slice(0, 40));
  // oversized message → truncated to <= 2000
  const got = on1(s, 'chat_message', { match: p => p.userName === 'Stu' });
  s.emit('send_chat', { roomId: room, message: 'y'.repeat(5000), userName: 'Stu' });
  const m = await got.catch(() => null);
  assert(m && m.message.length <= 2000, 'oversized chat is truncated to 2000', `len=${m && m.message.length}`);
}

async function T8_whiteboardViewValidation() {
  console.log('T8: whiteboard_set_view rejects NaN/garbage');
  const room = rid('t8');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  // teacher sends a garbage view → must NOT be relayed (finite-number guard)
  const noBad = none(s, 'whiteboard_set_view', 800);
  t.emit('whiteboard_set_view', { roomId: room, view: { boardScale: 'nope', boardOffsetX: NaN, boardOffsetY: 5 } });
  const r = await noBad;
  assert(r === null, 'garbage whiteboard view is rejected', JSON.stringify(r)?.slice(0, 50));
  // a valid view IS relayed
  const good = on1(s, 'whiteboard_set_view', { match: p => p.view?.boardScale === 1.5 });
  t.emit('whiteboard_set_view', { roomId: room, view: { boardScale: 1.5, boardOffsetX: 10, boardOffsetY: 20 } });
  await good.then(() => ok('valid whiteboard view relays')).catch(e => bad('valid whiteboard view relays', e.message));
}

async function T9_gateValidation() {
  console.log('T9: gate with a blank option is rejected (no misgrade)');
  const room = rid('t9');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  // a blank option that survives to the server must be rejected → no gate_added
  const noGate = none(s, 'gate_added', 800);
  t.emit('add_gate', { roomId: room, step: 1, question: 'Q', options: ['ok', '   '], correctIndex: 0 });
  const r = await noGate;
  assert(r === null, 'gate with a blank option is rejected server-side', JSON.stringify(r)?.slice(0, 50));
  // a clean gate IS accepted
  const gate = on1(s, 'gate_added', { match: p => p.step === 2 });
  t.emit('add_gate', { roomId: room, step: 2, question: 'Q2', options: ['x', 'y'], correctIndex: 1 });
  await gate.then(() => ok('a clean gate is accepted + delivered')).catch(e => bad('clean gate accepted', e.message));
}

async function T10_studentCannotMutateCanonical() {
  console.log('T10: a student cannot mutate teacher-only canonical state');
  const room = rid('t10');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: FILE('f', 'X') });
  await delay(150);
  const s = await joinStudent(room, 'Stu');
  // student tries to set the step (teacher-only) → must NOT broadcast
  const noStep = none(t, 'step_changed', 800);
  s.emit('set_step', { roomId: room, step: 7 });
  const r = await noStep;
  assert(r === null, 'student set_step is ignored (teacher-only)', JSON.stringify(r)?.slice(0, 40));
  // student tries to switch files → ignored
  const noSwitch = none(t, 'active_file_changed', 800);
  s.emit('switch_file', { roomId: room, fileId: 'f' });
  const r2 = await noSwitch;
  assert(r2 === null, 'student switch_file is ignored (teacher-only)', JSON.stringify(r2)?.slice(0, 40));
}

async function run() {
  const tests = [T1_hardReset, T2_kick, T3_explanationLateJoin, T4_whiteboardUpdateCap, T5_claimRoom,
    T6_attention, T7_chatHardening, T8_whiteboardViewValidation, T9_gateValidation, T10_studentCannotMutateCanonical];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(150); }
  console.log(`\nSTRESS2 RESULT: ${pass} passed, ${fail} failed`);
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
