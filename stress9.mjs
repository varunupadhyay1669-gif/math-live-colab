// Round-9: whiteboard OBJECT hydration — shapes, instruments, grid mode.
// These mutations had no test coverage. Verifies each persists server-side and
// hydrates to a LATE JOINER with all fields intact, and that removes/updates
// are reflected. PORT=3100 node stress9.mjs
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
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function lateStudent(room, name = 'Late') {
  const s = conn(); await on1(s, 'connect');
  const ssP = on1(s, 'session_state', { timeout: 4000 }).catch(() => null);
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  await on1(s, 'room_state').catch(() => {});
  return { s, ss: await ssP };
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// W1: a SHAPE hydrates to a late joiner with every field intact
async function W1_shapeHydrates() {
  console.log('W1: shape hydrates to a late joiner (all fields)');
  const room = rid('w1');
  const t = await joinTeacher(room);
  const shape = { id: 'sh1', type: 'rect', x: 10, y: 20, w: 100, h: 60, color: '#e11', strokeWidth: 3, rotation: 0, filled: false, groupId: null };
  t.emit('whiteboard_add_shape', { roomId: room, shape });
  await delay(200);
  const { ss } = await lateStudent(room);
  const got = (ss?.whiteboard?.shapes || []).find(s => s.id === 'sh1');
  assert(!!got, 'shape is hydrated to the late joiner', JSON.stringify(ss?.whiteboard?.shapes)?.slice(0, 60));
  assert(got && deepEq(got, shape), 'every shape field is preserved verbatim', JSON.stringify(got));
}

// W2: shape UPDATE then late join → updated version
async function W2_shapeUpdate() {
  console.log('W2: shape update reflected for a late joiner');
  const room = rid('w2');
  const t = await joinTeacher(room);
  t.emit('whiteboard_add_shape', { roomId: room, shape: { id: 'sh1', type: 'circle', x: 0, y: 0, r: 10, color: '#000' } });
  await delay(100);
  t.emit('whiteboard_update_shape', { roomId: room, shape: { id: 'sh1', type: 'circle', x: 5, y: 5, r: 40, color: '#0a0' } });
  await delay(150);
  const { ss } = await lateStudent(room);
  const got = (ss?.whiteboard?.shapes || []).find(s => s.id === 'sh1');
  assert(got && got.r === 40 && got.color === '#0a0', 'late joiner gets the UPDATED shape (r=40, green)', JSON.stringify(got));
}

// W3: shape REMOVE → gone for a late joiner
async function W3_shapeRemove() {
  console.log('W3: removed shape is absent for a late joiner');
  const room = rid('w3');
  const t = await joinTeacher(room);
  t.emit('whiteboard_add_shape', { roomId: room, shape: { id: 'keep', type: 'rect', x: 0, y: 0, w: 5, h: 5, color: '#000' } });
  t.emit('whiteboard_add_shape', { roomId: room, shape: { id: 'gone', type: 'rect', x: 1, y: 1, w: 5, h: 5, color: '#000' } });
  await delay(120);
  t.emit('whiteboard_remove_shape', { roomId: room, shapeId: 'gone' });
  await delay(150);
  const { ss } = await lateStudent(room);
  const ids = (ss?.whiteboard?.shapes || []).map(s => s.id);
  assert(ids.includes('keep') && !ids.includes('gone'), 'removed shape gone, others kept', JSON.stringify(ids));
}

// W4: an INSTRUMENT (ruler/protractor) hydrates with full geometry
async function W4_instrumentHydrates() {
  console.log('W4: instrument hydrates to a late joiner (geometry intact)');
  const room = rid('w4');
  const t = await joinTeacher(room);
  const instrument = { id: 'ruler1', type: 'ruler', x: 120, y: 240, rotation: 35, length: 400, unit: 'cm' };
  t.emit('whiteboard_add_instrument', { roomId: room, instrument });
  await delay(200);
  const { ss } = await lateStudent(room);
  const got = (ss?.whiteboard?.instruments || []).find(i => i.id === 'ruler1');
  assert(!!got, 'instrument hydrated to late joiner', JSON.stringify(ss?.whiteboard?.instruments)?.slice(0, 60));
  assert(got && got.rotation === 35 && got.length === 400 && got.type === 'ruler', 'instrument geometry preserved (rotation/length/type)', JSON.stringify(got));
}

// W5: instrument REMOVE → gone for a late joiner
async function W5_instrumentRemove() {
  console.log('W5: removed instrument is absent for a late joiner');
  const room = rid('w5');
  const t = await joinTeacher(room);
  t.emit('whiteboard_add_instrument', { roomId: room, instrument: { id: 'p1', type: 'protractor', x: 0, y: 0, rotation: 0 } });
  await delay(120);
  t.emit('whiteboard_remove_instrument', { roomId: room, instrumentId: 'p1' });
  await delay(150);
  const { ss } = await lateStudent(room);
  const ids = (ss?.whiteboard?.instruments || []).map(i => i.id);
  assert(!ids.includes('p1'), 'removed instrument is gone for the late joiner', JSON.stringify(ids));
}

// W6: grid mode hydrates to a late joiner
async function W6_gridModeHydrates() {
  console.log('W6: grid mode hydrates to a late joiner');
  const room = rid('w6');
  const t = await joinTeacher(room);
  t.emit('whiteboard_set_grid_mode', { roomId: room, gridMode: 'graph' });
  await delay(150);
  const { ss } = await lateStudent(room);
  assert(ss?.whiteboard?.gridMode === 'graph', 'late joiner sees gridMode=graph', `gridMode=${ss?.whiteboard?.gridMode}`);
}

// W7: a STUDENT cannot add a shape (teacher-only) — no privilege escalation
async function W7_studentCannotAddShape() {
  console.log('W7: student cannot add a shape (teacher-only)');
  const room = rid('w7');
  const t = await joinTeacher(room);
  const { s } = await lateStudent(room, 'Stu');
  s.emit('whiteboard_add_shape', { roomId: room, shape: { id: 'evil', type: 'rect', x: 0, y: 0, w: 5, h: 5, color: '#000' } });
  await delay(250);
  const { ss } = await lateStudent(room, 'Check');
  const ids = (ss?.whiteboard?.shapes || []).map(s2 => s2.id);
  assert(!ids.includes('evil'), 'a student-added shape is rejected (not in canonical state)', JSON.stringify(ids));
}

async function run() {
  const tests = [W1_shapeHydrates, W2_shapeUpdate, W3_shapeRemove, W4_instrumentHydrates, W5_instrumentRemove, W6_gridModeHydrates, W7_studentCannotAddShape];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(150); }
  console.log(`\nSTRESS9 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
