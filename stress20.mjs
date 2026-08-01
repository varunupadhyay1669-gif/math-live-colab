// Round-20: EXPLANATIONS ARE KEPT, NOT THROWN AWAY.
//
// Reported from a real lesson: "if I exit that HTML code of the explanation I
// cannot go back to it, I have to upload that thing again." Contract:
//   E1  adding an explanation shows it to the student and lists it
//   E2  closing returns to the lesson but KEEPS it (this is the bug)
//   E3  a kept explanation can be reopened without re-uploading
//   E4  several can be kept and switched between
//   E5  delete removes it — and if it was on screen, takes it off the student's too
//   E6  clear removes all of them
//   E7  the list survives a reload (it's in the hydration payload)
//   E8  a student cannot add, switch, delete or clear
//   E9  the list is bounded, and re-adding the same body reopens rather than piles up
// PORT=4000 node stress20.mjs
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
async function joinTeacher(room) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: 'Teacher', role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) {
  const s = conn(); await on1(s, 'connect');
  const st = on1(s, 'session_state', { timeout: 5000 }).catch(() => null);
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  s._state = await st; return s;
}
const doc = (t) => `<!doctype html><html><body><h1>${t}</h1></body></html>`;
// Track the latest list the teacher has been told about.
function trackList(sock) {
  sock._list = null;
  sock.on('explanations_state', (p) => { sock._list = p; });
}

async function run() {
  const room = rid('exp');
  const t = await joinTeacher(room);
  trackList(t);
  const stu = await joinStudent(room, 'Anika');
  await delay(200);

  // ── E1 ──
  console.log('E1: adding an explanation shows it and lists it');
  const shown = on1(stu, 'temp_content', { timeout: 3000 });
  t.emit('show_temp_content', { roomId: room, html: doc('ONE'), name: 'Method one' });
  const p1 = await shown.catch(e => ({ err: e.message }));
  assert(p1?.name === 'Method one', "student sees it", JSON.stringify(p1)?.slice(0, 80));
  await delay(150);
  assert(t._list?.list?.length === 1, 'it appears in the teacher\'s list', JSON.stringify(t._list));
  assert(t._list?.activeId === t._list?.list?.[0]?.id, 'and is marked as the one on screen');
  const oneId = t._list.list[0].id;

  // ── E2: THE BUG ──
  console.log('E2: closing goes back to the lesson but KEEPS the explanation');
  const closed = on1(stu, 'clear_temp_content', { timeout: 3000 });
  t.emit('clear_temp_content', { roomId: room });
  await closed.then(() => ok('student returns to the lesson')).catch(e => bad('close did not reach the student', e.message));
  await delay(150);
  assert(t._list?.list?.length === 1, 'the explanation is STILL kept after closing', JSON.stringify(t._list));
  assert(t._list?.activeId === null, 'but nothing is on screen');

  // ── E3 ──
  console.log('E3: it can be reopened without uploading it again');
  const reshown = on1(stu, 'temp_content', { timeout: 3000 });
  t.emit('explanation_show', { roomId: room, id: oneId });
  const p3 = await reshown.catch(e => ({ err: e.message }));
  assert(p3?.name === 'Method one', 'the same explanation comes back', JSON.stringify(p3)?.slice(0, 80));
  assert(p3?.html?.includes('ONE'), 'with its original content intact');

  // ── E4 ──
  console.log('E4: several are kept and can be switched between');
  t.emit('show_temp_content', { roomId: room, html: doc('TWO'), name: 'Method two' });
  await delay(200);
  assert(t._list?.list?.length === 2, 'two explanations kept', JSON.stringify(t._list?.list));
  const twoId = t._list.list[1].id;
  assert(t._list?.activeId === twoId, 'the new one is showing');
  const back = on1(stu, 'temp_content', { match: p => p?.name === 'Method one', timeout: 3000 });
  t.emit('explanation_show', { roomId: room, id: oneId });
  await back.then(() => ok('switching back to the first works')).catch(e => bad('switch back failed', e.message));

  // ── E5 ──
  console.log('E5: deleting the one on screen takes it off the student\'s screen too');
  const gone = on1(stu, 'clear_temp_content', { timeout: 3000 });
  t.emit('explanation_delete', { roomId: room, id: oneId });
  await gone.then(() => ok('student is returned to the lesson')).catch(e => bad('delete did not clear the student view', e.message));
  await delay(150);
  assert(t._list?.list?.length === 1 && t._list.list[0].id === twoId, 'only the other one is left', JSON.stringify(t._list?.list));

  // Deleting one that ISN'T showing must not disturb the screen.
  t.emit('explanation_show', { roomId: room, id: twoId });
  await delay(200);
  t.emit('show_temp_content', { roomId: room, html: doc('THREE'), name: 'Method three' });
  await delay(200);
  const threeId = t._list.list.find(e => e.name === 'Method three').id;
  const undisturbed = none(stu, 'clear_temp_content', 700);
  t.emit('explanation_delete', { roomId: room, id: twoId });
  assert(!(await undisturbed), 'deleting a background explanation leaves the screen alone');
  await delay(150);
  assert(t._list?.activeId === threeId, 'and the one on screen is still showing');

  // ── E6 ──
  console.log('E6: clear removes all of them');
  t.emit('explanation_clear', { roomId: room });
  await delay(250);
  assert((t._list?.list?.length ?? -1) === 0, 'the list is empty', JSON.stringify(t._list));
  assert(t._list?.activeId === null, 'and nothing is on screen');

  // ── E7 ──
  console.log('E7: the list survives a reload');
  t.emit('show_temp_content', { roomId: room, html: doc('KEEP'), name: 'Survives reload' });
  await delay(250);
  const rejoined = await joinStudent(room, 'Rohan');   // hydration payload
  const st = rejoined._state;
  assert(Array.isArray(st?.explanations) && st.explanations.length === 1,
    'hydration carries the kept list', JSON.stringify(st?.explanations));
  assert(st?.explanations?.[0]?.name === 'Survives reload', 'with its name');
  assert(!('html' in (st?.explanations?.[0] ?? {})), 'but not the body — names only, so hydration stays small');
  assert(st?.activeExplanationId, 'and which one is on screen');

  // ── E8 ──
  console.log('E8: a student cannot manage the teacher\'s explanations');
  const beforeLen = t._list.list.length;
  stu.emit('show_temp_content', { roomId: room, html: doc('HACK'), name: 'Student added' });
  stu.emit('explanation_delete', { roomId: room, id: t._list.list[0].id });
  stu.emit('explanation_clear', { roomId: room });
  stu.emit('explanation_show', { roomId: room, id: t._list.list[0].id });
  await delay(700);
  assert(t._list.list.length === beforeLen, 'the list is untouched by a student', JSON.stringify(t._list?.list));

  // ── E9 ──
  console.log('E9: bounded, and re-adding the same file reopens instead of piling up');
  t.emit('show_temp_content', { roomId: room, html: doc('KEEP'), name: 'Survives reload' });
  await delay(250);
  assert(t._list.list.length === 1, 'the same body does not create a duplicate tab', JSON.stringify(t._list?.list));
  for (let i = 0; i < 12; i++) t.emit('show_temp_content', { roomId: room, html: doc('X' + i), name: 'Extra ' + i });
  await delay(700);
  assert(t._list.list.length <= 8, `the list is capped (got ${t._list.list.length})`);

  console.log(`\nEXPLANATION TABS RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  sockets.forEach(s => { try { s.close(); } catch {} });
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('CRASH', e); sockets.forEach(s => { try { s.close(); } catch {} }); process.exit(1); });
