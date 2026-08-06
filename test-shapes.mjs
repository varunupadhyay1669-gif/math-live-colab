// Shape geometry — the corners a shape gets from the box the tutor dragged.
//
// This one function feeds BOTH the renderer and the hit test, so a bug here is
// a shape you can see and cannot select, or one that is drawn mirrored when
// you drag the "wrong" way.
// node --import tsx test-shapes.mjs
import { shapePolygon, isPolygonal, ellipseBox, nearEllipseEdge, SHAPE_CATALOG } from './src/lib/shapeGeometry.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
// Shoelace area — positive or negative depending on winding, so compare |area|.
const area = (p) => Math.abs(p.reduce((s, [x, y], i) => {
  const [nx, ny] = p[(i + 1) % p.length];
  return s + (x * ny - nx * y);
}, 0) / 2);
const inBox = (p, l, t, r, b) => p.every(([x, y]) => x >= l - 1e-6 && x <= r + 1e-6 && y >= t - 1e-6 && y <= b + 1e-6);

console.log('S1: the shapes a maths lesson actually needs exist');
for (const kind of ['triangle', 'rightTriangle', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'star'])
  assert(shapePolygon(kind, 0, 0, 100, 100) !== null, `${kind} has an outline`);
assert(SHAPE_CATALOG.length === 13, 'the palette offers 13 shapes, up from 5', String(SHAPE_CATALOG.length));
assert(new Set(SHAPE_CATALOG.map(s => s.id)).size === SHAPE_CATALOG.length, 'with no duplicates');
assert(SHAPE_CATALOG.some(s => s.label === 'Trapezium'), 'named the way the tutor names them');

console.log('S2: every polygon stays inside the box that was dragged');
// A shape that escapes its box tears the selection rectangle away from what
// you can see, and the eraser stops matching the outline.
for (const s of SHAPE_CATALOG) {
  const poly = shapePolygon(s.id, 20, 40, 220, 140);
  if (!poly) continue;
  assert(inBox(poly, 20, 40, 220, 140), `${s.id} stays within its box`);
}

console.log('S3: dragging backwards draws the same shape');
// A tutor dragging up-and-left means the same triangle as one dragging
// down-and-right. Without normalising, half of these come out upside down.
for (const kind of ['triangle', 'rightTriangle', 'trapezoid', 'pentagon', 'star', 'diamond']) {
  const fwd = shapePolygon(kind, 0, 0, 100, 80);
  const back = shapePolygon(kind, 100, 80, 0, 0);
  assert(JSON.stringify(fwd) === JSON.stringify(back), `${kind} is identical dragged either way`);
}

console.log('S4: the shapes are the shapes they claim to be');
const tri = shapePolygon('triangle', 0, 0, 100, 100);
assert(tri.length === 3, 'a triangle has three corners');
assert(near(tri[0][0], 50) && near(tri[0][1], 0), 'with its apex centred on top', JSON.stringify(tri[0]));
assert(near(area(tri), 5000), 'and half the area of its box', String(area(tri)));

const rt = shapePolygon('rightTriangle', 0, 0, 100, 100);
const corner = rt.find(([x, y]) => near(x, 0) && near(y, 100));
assert(!!corner, 'the right triangle has its square corner at the bottom-left');
// The legs must be axis-aligned or the right angle is not a right angle.
const vertical = rt.filter(([x]) => near(x, 0)).length === 2;
const horizontal = rt.filter(([, y]) => near(y, 100)).length === 2;
assert(vertical && horizontal, 'and both legs lie on the axes — an actual 90°');

const par = shapePolygon('parallelogram', 0, 0, 100, 100);
assert(par.length === 4, 'a parallelogram has four corners');
assert(near(par[1][0] - par[0][0], par[2][0] - par[3][0]),
  'and its two slanted sides are parallel', JSON.stringify(par));

const trap = shapePolygon('trapezoid', 0, 0, 100, 100);
assert(near(trap[1][0] - trap[0][0], 56) && near(trap[2][0] - trap[3][0], 100),
  'a trapezium has one short parallel side and one long one', JSON.stringify(trap));

for (const [kind, n] of [['pentagon', 5], ['hexagon', 6], ['star', 10]])
  assert(shapePolygon(kind, 0, 0, 100, 100).length === n, `${kind} has ${n} vertices`);
const pent = shapePolygon('pentagon', 0, 0, 100, 100);
assert(near(pent[0][0], 50) && near(pent[0][1], 0), 'a pentagon sits point-up, as it is drawn in every textbook');
const star = shapePolygon('star', 0, 0, 100, 100);
const radii = star.map(([x, y]) => Math.hypot(x - 50, y - 50));
assert(radii.filter(r => near(r, 50, 0.01)).length === 5, 'a star has five outer points');
assert(radii.filter(r => r < 25).length === 5, 'and five inner ones');

console.log('S5: the star has a notch at the bottom, and that is correct');
// Probing a star at the bottom-centre of its box finds nothing, because a
// five-pointed star has an inner vertex there, not an edge. This looked like a
// broken hit test the first time it was measured in the browser. It is not —
// and "fixing" it would mean grabbing clicks in empty space.
const bottomCentre = star.filter(([x, y]) => near(x, 50, 0.01) && y > 50);
assert(bottomCentre.length === 1, 'there is exactly one vertex at bottom-centre');
assert(bottomCentre[0][1] < 70,
  'and it is an INNER vertex, well above the bottom of the box', String(bottomCentre[0][1]));
const topPoint = star.find(([x, y]) => near(x, 50, 0.01) && y < 50);
assert(near(topPoint[1], 0), 'while the top IS a point touching the box edge', String(topPoint[1]));

console.log('S6: non-polygons say so rather than returning something wrong');
for (const kind of ['line', 'arrow', 'circle', 'ellipse']) {
  assert(shapePolygon(kind, 0, 0, 10, 10) === null, `${kind} has no polygon outline`);
  assert(!isPolygonal(kind), `and isPolygonal(${kind}) agrees`);
}

console.log('S7: degenerate drags do not crash or produce junk');
for (const kind of SHAPE_CATALOG.map(s => s.id)) {
  const poly = shapePolygon(kind, 50, 50, 50, 50);   // a click, not a drag
  if (!poly) continue;
  assert(poly.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
    `${kind} survives a zero-size drag with finite points`);
}

console.log('S8: the ellipse is hollow, and its edge is where it looks');
const box = ellipseBox(0, 0, 200, 100);
assert(near(box.cx, 100) && near(box.cy, 50) && near(box.rx, 100) && near(box.ry, 50), 'the box maths is right');
assert(nearEllipseEdge(200, 50, 0, 0, 200, 100, 3), 'a point on the wide edge hits');
assert(nearEllipseEdge(100, 100, 0, 0, 200, 100, 3), 'and one on the narrow edge');
assert(!nearEllipseEdge(100, 50, 0, 0, 200, 100, 3), 'the centre does NOT — these outlines are hollow');
assert(!nearEllipseEdge(100, 80, 0, 0, 200, 100, 3), 'nor a point well inside');
// The bug this guards: normalising without converting back stretches the
// tolerance by the aspect ratio, so a wide ellipse grabs clicks 20px away.
assert(!nearEllipseEdge(100, 68, 0, 0, 200, 100, 3),
  'and the tolerance is not stretched by the aspect ratio');
assert(!nearEllipseEdge(5, 5, 0, 0, 0, 0, 3), 'a zero-size ellipse hits nothing instead of dividing by zero');

console.log(`\nSHAPE GEOMETRY RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
