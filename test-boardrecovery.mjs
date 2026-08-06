// Board recovery — putting the whiteboard back when the server forgets it.
//
// Rooms live in memory, flushed to an ephemeral disk every five minutes, so a
// redeploy mid-lesson hands the reconnecting teacher a brand new empty room and
// every student's board goes blank. The teacher's browser still holds it.
//
// Both directions of this decision are damaging: not restoring loses the
// lesson, restoring when the server DID keep it duplicates every stroke.
// node --import tsx test-boardrecovery.mjs
import { shouldReseedBoard, boardPieceCount } from './src/lib/boardRecovery.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const full = { strokes: [{ id: 'a' }, { id: 'b' }], shapes: [{ id: 's' }], texts: [], objects: [], instruments: [] };
const empty = { strokes: [], shapes: [], texts: [], objects: [], instruments: [] };
const RECONNECT = { wasReconnect: true, alreadyReseeded: false };

console.log('B1: the case this exists for');
// Server restarted, room came back empty, teacher still holds the lesson.
const d = shouldReseedBoard(empty, full, RECONNECT);
assert(d.reseed === true, 'a board the server lost IS restored from the teacher', d.reason);
assert(shouldReseedBoard(null, full, RECONNECT).reseed === true, 'a missing board counts as lost too');
assert(shouldReseedBoard(undefined, full, RECONNECT).reseed === true, 'and an absent one');
assert(shouldReseedBoard({}, full, RECONNECT).reseed === true, 'and an object with no arrays at all');

console.log('B2: never restore over a board the server still has');
// This is the direction that silently doubles every stroke on the board.
assert(shouldReseedBoard(full, full, RECONNECT).reseed === false,
  'a server that kept the board is left alone', shouldReseedBoard(full, full, RECONNECT).reason);
assert(shouldReseedBoard({ strokes: [{ id: 'x' }] }, full, RECONNECT).reseed === false,
  'even a single surviving stroke means the room is intact');
assert(shouldReseedBoard({ instruments: [{ id: 'r' }] }, full, RECONNECT).reseed === false,
  'and a lone dropped ruler counts as intact');

console.log('B3: a first join is not a recovery');
// A brand-new room is legitimately empty. Restoring here would push a previous
// student's board into a fresh room.
assert(shouldReseedBoard(empty, full, { wasReconnect: false, alreadyReseeded: false }).reseed === false,
  'an empty room on FIRST connect is just a new room', shouldReseedBoard(empty, full, { wasReconnect: false, alreadyReseeded: false }).reason);

console.log('B4: restore once, not once per state message');
// Several room_state / session_state messages arrive around a reconnect. Each
// one replaying the board would stack duplicates.
assert(shouldReseedBoard(empty, full, { wasReconnect: true, alreadyReseeded: true }).reseed === false,
  'the second state message in one reconnect does nothing');

console.log('B5: nothing local means nothing to do');
assert(shouldReseedBoard(empty, empty, RECONNECT).reseed === false, 'two empty boards need no repair');
assert(shouldReseedBoard(empty, null, RECONNECT).reseed === false, 'nor does holding nothing');
// The teacher deliberately cleared the board, then the socket blipped. Pushing
// the old content back would undo a clear they meant.
assert(shouldReseedBoard(empty, { strokes: [], gridMode: 'graph' }, RECONNECT).reseed === false,
  'a board cleared on purpose is not resurrected by a reconnect');

console.log('B6: every decision explains itself');
for (const [server, local, o] of [[empty, full, RECONNECT], [full, full, RECONNECT], [empty, empty, RECONNECT],
                                  [empty, full, { wasReconnect: false, alreadyReseeded: false }],
                                  [empty, full, { wasReconnect: true, alreadyReseeded: true }]]) {
  const r = shouldReseedBoard(server, local, o);
  assert(typeof r.reason === 'string' && r.reason.length > 10, `reason given: "${r.reason}"`);
}

console.log('B7: the tutor is told what was put back');
assert(boardPieceCount(full) === 3, 'pieces are counted across every kind', String(boardPieceCount(full)));
assert(boardPieceCount(empty) === 0, 'an empty board counts zero');
assert(boardPieceCount(null) === 0, 'and a missing one does not throw');
assert(boardPieceCount({ strokes: 'nope' }) === 0, 'nor does a malformed one');
assert(boardPieceCount({ strokes: [1, 2], texts: [3], objects: [4], instruments: [5], shapes: [6] }) === 6,
  'all five kinds are included');

console.log(`\nBOARD RECOVERY RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
