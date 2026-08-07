// Round-28: IDLE-ROOM EVICTION — the fix for Render's memory-limit restarts.
//
// Render restarted this service for exceeding its memory limit, which is what
// made joining unreliable and boards vanish mid-lesson. A room stayed in RAM
// for its whole life — 24h anonymous, 30 DAYS once claimed — with nobody in
// it, carrying up to 50 files at 2MB each plus a live copy of the teacher's
// whole iframe DOM.
//
// Eviction writes an idle room to the store and drops it; join_room lazily
// restores it. The danger is obvious, so most of this measures what it must
// NEVER do. Contract:
//   E1  an idle, empty room is evicted
//   E2  its content comes BACK when someone rejoins — eviction is not deletion
//   E3  a room with someone in it is NEVER evicted, however long it sits
//   E4  a room emptied seconds ago is not evicted (still warm)
//   E5  emptying a room releases the mirror cache immediately
// Run with short windows. TEACHER_GRACE_MS matters: eviction deliberately
// skips a room while the teacher's 45s reconnect grace is armed, so without
// shortening it this test passes while never reaching the eviction path — which
// is exactly what happened the first time it was written.
//   IDLE_EVICT_MS=1200 SWEEP_INTERVAL_MS=800 TEACHER_GRACE_MS=600 PORT=4100 node server.ts
//   PORT=4100 node stress28.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '4100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 6000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const strokes = (wb) => ((wb && wb.strokes) || []).length;
const roomsInMemory = async () => (await (await fetch(URL + '/healthz')).json()).rooms;

const STROKE = (id) => ({ id, points: [{ x: 1, y: 1 }, { x: 40, y: 40 }], color: '#111827', width: 3, tool: 'pen', createdAt: 1 });

async function teacherWithBoard(room, n = 2) {
  const s = conn(); await on1(s, 'connect');
  const stP = on1(s, 'session_state');
  s.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher' });
  await stP;
  for (let i = 0; i < n; i++) s.emit('whiteboard_draw', { roomId: room, stroke: STROKE('k' + i) });
  await sleep(400);
  return s;
}
async function readBoard(room, name) {
  const s = conn(); await on1(s, 'connect');
  const stP = on1(s, 'session_state');
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  const st = await stP;
  return { s, wb: st.whiteboard };
}

async function run() {
  console.log('E1/E2: an idle room is evicted, and comes BACK when rejoined');
  const room = rid('evict');
  const t = await teacherWithBoard(room, 3);
  const before = await roomsInMemory();
  t.close();
  await sleep(5000);   // past the grace window, IDLE_EVICT_MS, a sweep and the persist
  const afterIdle = await roomsInMemory();
  assert(afterIdle < before,
    'the room genuinely LEFT memory — not merely "still works"', `${before} -> ${afterIdle}`);
  // If eviction were deletion, this room would now be gone and a student
  // would be told the teacher has not opened it.
  const late = conn(); await on1(late, 'connect');
  let refused = null;
  late.on('join_error', p => { refused = p; });
  const stP = on1(late, 'session_state').catch(() => null);
  late.emit('join_room', { roomId: room, userName: 'Kanishka', role: 'student' });
  const st = await stP;
  assert(refused === null, 'an evicted room is still joinable — it was stored, not deleted', JSON.stringify(refused));
  assert(st && strokes(st.whiteboard) === 3,
    'and every stroke came back with it', st ? String(strokes(st.whiteboard)) : 'no state');

  console.log('E3: a room with someone in it is NEVER evicted');
  // The failure that would end a lesson: dropping a room out from under the
  // people using it.
  const busy = rid('busy');
  const bt = await teacherWithBoard(busy, 2);
  await sleep(5000);   // several sweeps go by while the teacher sits there
  const { wb } = await readBoard(busy, 'Probe');
  assert(strokes(wb) === 2, 'the occupied room kept its board through every sweep', String(strokes(wb)));
  // And the teacher's own socket still works — proof the room is the same one.
  bt.emit('whiteboard_draw', { roomId: busy, stroke: STROKE('after') });
  await sleep(400);
  const { wb: wb2 } = await readBoard(busy, 'Probe2');
  assert(strokes(wb2) === 3, 'and is still the live room the teacher is drawing on', String(strokes(wb2)));

  console.log('E4: a room emptied moments ago is left warm');
  const warm = rid('warm');
  const wt = await teacherWithBoard(warm, 1);
  wt.close();
  await sleep(600);    // under IDLE_EVICT_MS
  const { wb: wb3 } = await readBoard(warm, 'Quick');
  assert(strokes(wb3) === 1, 'stepping out for a moment costs nothing', String(strokes(wb3)));

  console.log('E5: emptying a room releases the mirror cache at once');
  // mirrorBody is a full copy of the teacher's iframe DOM and the largest
  // single thing a room holds. It is re-sent by the source on the next
  // mutation, so holding it for an empty room is pure waste.
  const mir = rid('mirror');
  const mt = conn(); await on1(mt, 'connect');
  const mP = on1(mt, 'session_state');
  mt.emit('join_room', { roomId: mir, userName: 'Varun', role: 'teacher' });
  await mP;
  mt.emit('mirror_snapshot', { roomId: mir, body: '<div>'.repeat(2000), attrs: '', head: '', hash: 'h1' });
  await sleep(400);
  mt.close();
  await sleep(700);
  const { wb: _wb, s: after } = await readBoard(mir, 'Later');
  const mirrorState = await on1(after, 'mirror_snapshot', { timeout: 900 }).catch(() => null);
  assert(mirrorState === null,
    'no cached DOM is served to the next joiner — it was released when the room emptied',
    mirrorState ? 'still cached' : '');
  void _wb;
}

run().catch(e => { bad('harness', e.message); }).finally(async () => {
  sockets.forEach(s => { try { s.close(); } catch {} });
  console.log(`\nEVICTION RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
});
