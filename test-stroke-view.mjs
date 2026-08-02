// The red zig-zag: a stroke drawn while the shared view moves under your hand.
//
// Whiteboard points are stored in BOARD coordinates, mapped from the finger's
// screen position by dividing through the CURRENT view. If a shared-view update
// lands between two pointermoves, the same finger position maps to a different
// board point — so a straight drag records a line that jumps back and forth.
// With the teacher panning while a student writes, it jumps on every frame and
// draws a dense band instead of a line.
//
// This reproduces the maths both ways: LIVE transform (the old behaviour) and
// FROZEN-at-stroke-start (the fix).
// node test-stroke-view.mjs

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

// The real mapping, lifted from Whiteboard.screenToBoard.
const toBoard = (v, cx, cy) => ({ x: (cx - v.boardOffsetX) / v.boardScale, y: (cy - v.boardOffsetY) / v.boardScale });

/** A finger dragged straight to the right, 60 samples, y never changes. */
function drag(apply) {
  const pts = [];
  for (let i = 0; i < 60; i++) pts.push(apply(600 + i * 8, 700, i));
  return pts;
}

/** Biggest vertical jump between consecutive points, in board units. */
const maxJumpY = (pts) => pts.slice(1).reduce((m, p, i) => Math.max(m, Math.abs(p.y - pts[i].y)), 0);
/** How many times the vertical direction reverses — a zig-zag counter. */
function reversals(pts) {
  let n = 0, prev = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.sign(pts[i].y - pts[i - 1].y);
    if (d !== 0 && prev !== 0 && d !== prev) n++;
    if (d !== 0) prev = d;
  }
  return n;
}

// The teacher pans up and down while the student writes — exactly what a
// shared view does when the other side is scrolling around a worksheet.
const viewAt = (i) => ({ boardOffsetX: 0, boardOffsetY: (i % 2 === 0 ? 0 : -600), boardScale: 1 });
const startView = viewAt(0);

console.log('W1: a straight drag, with the view moving mid-stroke (the old maths)');
const live = drag((cx, cy, i) => toBoard(viewAt(i), cx, cy));
assert(maxJumpY(live) > 500, `the line tears vertically (max jump ${maxJumpY(live).toFixed(0)} board px)`);
assert(reversals(live) > 40, `and reverses direction over and over — a dense band, not a line (${reversals(live)} reversals)`);

console.log('W2: the same drag, mapped through the transform the stroke started with');
const frozen = drag((cx, cy) => toBoard(startView, cx, cy));
assert(maxJumpY(frozen) === 0, 'a straight drag records a straight line');
assert(reversals(frozen) === 0, 'with no reversals at all');
assert(frozen[0].x === 600 && frozen[frozen.length - 1].x === 600 + 59 * 8, 'and the x range is untouched');

console.log('W3: freezing does not break normal drawing when nothing moves');
const still = (i) => ({ boardOffsetX: 120, boardOffsetY: -40, boardScale: 0.55 });
const a = drag((cx, cy, i) => toBoard(still(i), cx, cy));
const b = drag((cx, cy) => toBoard(still(0), cx, cy));
assert(JSON.stringify(a) === JSON.stringify(b), 'with a steady view, frozen and live agree exactly');

console.log('W4: the stroke still lands where the student put it');
// A point under the finger maps back to the same screen position through the
// same transform — the ink is under their pen, not offset.
const v = { boardOffsetX: 120, boardOffsetY: -40, boardScale: 0.55 };
const p = toBoard(v, 900, 500);
const backX = p.x * v.boardScale + v.boardOffsetX;
const backY = p.y * v.boardScale + v.boardOffsetY;
assert(Math.abs(backX - 900) < 1e-9 && Math.abs(backY - 500) < 1e-9, 'board → screen round-trips to the finger position');

console.log(`\nSTROKE/VIEW RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
