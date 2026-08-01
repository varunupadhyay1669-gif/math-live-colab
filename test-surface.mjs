// Ink belongs to the thing it was drawn on.
//
// One canvas is shared by the lesson and every explanation. Before this rule
// existed, notes made on an explanation stayed on screen over the lesson after
// closing it — measured at 11,467 stray pixels in a real room.
// node --import tsx test-surface.mjs
import { belongsToSurface } from './src/components/AnnotationLayer.tsx';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const MAIN = 'main', A = 'exp:exp-a', B = 'exp:exp-b';

console.log('S1: ink stays where it was drawn');
assert(belongsToSurface({ surface: MAIN }, MAIN), 'lesson ink shows on the lesson');
assert(belongsToSurface({ surface: A }, A), 'explanation ink shows on that explanation');
assert(!belongsToSurface({ surface: A }, MAIN), 'explanation ink does NOT show on the lesson (the reported bug)');
assert(!belongsToSurface({ surface: MAIN }, A), 'lesson ink does NOT show on an explanation');
assert(!belongsToSurface({ surface: A }, B), 'one explanation\'s ink does not leak into another');

console.log('S2: strokes drawn before surfaces existed belong to the lesson');
assert(belongsToSurface({}, MAIN), 'a stroke with no surface shows on the lesson');
assert(belongsToSurface({ surface: undefined }, MAIN), 'an explicit undefined does too');
assert(belongsToSurface({ surface: '' }, MAIN), 'and an empty string');
assert(!belongsToSurface({}, A), 'but an old stroke does not appear over an explanation');

console.log('S3: nothing here throws on junk');
assert(belongsToSurface(null, MAIN), 'a null stroke is treated as the lesson\'s, not a crash');
assert(belongsToSurface(undefined, MAIN), 'so is undefined');
assert(belongsToSurface({ surface: MAIN }, ''), 'a missing current surface means the lesson');
assert(!belongsToSurface({ surface: A }, ''), 'and explanation ink still stays off it');

console.log('S4: the filter a surface applies to a saved snapshot');
const saved = [
  { id: '1', surface: MAIN }, { id: '2', surface: A }, { id: '3' },
  { id: '4', surface: B }, { id: '5', surface: A },
];
const onMain = saved.filter(s => belongsToSurface(s, MAIN)).map(s => s.id);
const onA = saved.filter(s => belongsToSurface(s, A)).map(s => s.id);
assert(JSON.stringify(onMain) === '["1","3"]', 'the lesson gets its own ink plus the legacy stroke', JSON.stringify(onMain));
assert(JSON.stringify(onA) === '["2","5"]', 'explanation A gets only its own', JSON.stringify(onA));
assert(saved.filter(s => belongsToSurface(s, 'exp:nope')).length === 0, 'a surface with no ink renders blank, not everything');

console.log(`\nSURFACE RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
