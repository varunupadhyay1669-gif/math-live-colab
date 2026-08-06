// Round-26: SERVER RESTART MID-LESSON — does the board come back?
//
// Rooms live in memory and flush to an ephemeral disk every five minutes, so a
// redeploy during a lesson hands the reconnecting teacher a brand new empty
// room. This measures what the SERVER does with the recovery replay the
// teacher's client sends, and what a student sees.
//
//   S1  after a restart the room is genuinely empty (the premise holds)
//   S2  a teacher replaying their board repopulates it
//   S3  a student joining afterwards receives the restored board
//   S4  replaying does not duplicate a board the server still has
// PORT=4000 node stress26.mjs   (restarts nothing itself — it simulates the
// restart by using a fresh room id, which is exactly what the server hands
// back after losing one)
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 5000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const count = (wb) => ['strokes', 'shapes', 'texts', 'objects', 'instruments']
  .reduce((n, k) => n + ((wb && Array.isArray(wb[k])) ? wb[k].length : 0), 0);

const BOARD = {
  gridMode: 'graph',
  strokes: [
    { id: 'k1', points: [{ x: 1, y: 1 }, { x: 9, y: 9 }], color: '#111827', width: 3, tool: 'pen', createdAt: 1 },
    { id: 'k2', points: [{ x: 20, y: 5 }, { x: 40, y: 25 }], color: '#EF4444', width: 3, tool: 'pen', createdAt: 2 },
  ],
  shapes: [{ id: 'sh1', kind: 'rightTriangle', x1: 0, y1: 0, x2: 60, y2: 40, color: '#111827', width: 3 }],
  texts: [{ id: 'tx1', x: 10, y: 80, text: 'x = 45', color: '#111827', fontSize: 24 }],
  objects: [], instruments: [],
};

async function joinTeacher(room) {
  const s = conn(); await on1(s, 'connect');
  const stP = on1(s, 'session_state');
  s.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher' });
  const st = await stP;
  return { s, st };
}

/** Join and read the board the way the client does — off session_state. */
async function readBoard(room, name) {
  const s = conn(); await on1(s, 'connect');
  const stP = on1(s, 'session_state');
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  return (await stP).whiteboard;
}

/** Exactly what Room.tsx's reseedBoard emits. */
function replayBoard(s, room, board) {
  if (board.gridMode) s.emit('whiteboard_set_grid_mode', { roomId: room, gridMode: board.gridMode });
  for (const shape of board.shapes) s.emit('whiteboard_add_shape', { roomId: room, shape });
  for (const text of board.texts) s.emit('whiteboard_add_text', { roomId: room, text });
  for (const stroke of board.strokes) s.emit('whiteboard_draw', { roomId: room, stroke });
}

async function run() {
  console.log('S1: a room the server has lost really does come back empty');
  const room = rid('restart');
  const { s: teacher, st: firstState } = await joinTeacher(room);
  assert(count(firstState.whiteboard) === 0,
    'the fresh room has no board at all — this is what a restarted server hands back',
    String(count(firstState.whiteboard)));

  console.log('S2: the teacher replaying their copy repopulates it');
  replayBoard(teacher, room, BOARD);
  await sleep(700);
  // Rejoin to read the room back the way a client would.
  const restored = await readBoard(room, 'Probe');
  assert(count(restored) === 4, 'all four pieces are on the server again', String(count(restored)));
  assert(restored.shapes[0].kind === 'rightTriangle', 'the shape kept its kind');
  assert(restored.texts[0].text === 'x = 45', 'and the text its content');
  assert(restored.gridMode === 'graph', 'the graph paper came back too');

  console.log('S3: a student who joins after the restart sees the lesson');
  const seen = await readBoard(room, 'Kanishka');
  assert(count(seen) === 4,
    'a student arriving late gets the whole restored board, not a blank one', String(count(seen)));

  console.log('S4: replaying onto an intact board is what we must NOT do');
  // The client refuses this (shouldReseedBoard), but measure the cost of
  // getting it wrong so the guard is never treated as optional.
  replayBoard(teacher, room, BOARD);
  await sleep(700);
  const doubled = await readBoard(room, 'Probe2');
  assert(count(doubled) > 4,
    'a second replay DOES duplicate — which is why the client checks first',
    String(count(doubled)));
}

run().catch(e => { bad('harness', e.message); }).finally(async () => {
  sockets.forEach(s => { try { s.close(); } catch {} });
  console.log(`\nRESTART RECOVERY RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
});
