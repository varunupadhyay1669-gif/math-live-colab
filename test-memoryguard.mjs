// Shedding load instead of being killed.
//
// This service was suspended after repeated memory-limit restarts. The guard's
// job is to give up idle rooms before the process is killed — and, far more
// importantly, to NEVER give up a room someone is teaching in. Solving a memory
// problem by ending a lesson is not solving it.
// node --import tsx test-memoryguard.mjs
import { pressureFrom, idleWindowFor, describeMemory } from './src/lib/memoryGuard.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const MB = 1048576;
// A Render free instance: 512MB, with headroom left for everything that is not
// the JS heap.
const POLICY = { budgetBytes: 400 * MB, idleMs: 30 * 60 * 1000 };

console.log('M1: pressure is called early, not at the cliff');
assert(pressureFrom(100 * MB, POLICY) === 'ok', 'a quarter full is fine');
assert(pressureFrom(279 * MB, POLICY) === 'ok', 'just under 70% is still fine');
assert(pressureFrom(280 * MB, POLICY) === 'high', '70% is high');
assert(pressureFrom(339 * MB, POLICY) === 'high', 'and stays high to 85%');
assert(pressureFrom(340 * MB, POLICY) === 'critical', '85% is critical');
assert(pressureFrom(399 * MB, POLICY) === 'critical', 'and beyond');
// By 95% a Node heap is already thrashing; acting then is too late.
assert(pressureFrom(0.9 * POLICY.budgetBytes, POLICY) === 'critical',
  'the alarm sounds well before the heap is nearly full');

console.log('M2: the idle window collapses under pressure');
assert(idleWindowFor('ok', POLICY) === 30 * 60 * 1000, 'normally a room sits warm for half an hour');
assert(idleWindowFor('high', POLICY) === 60_000, 'under pressure that drops to a minute');
assert(idleWindowFor('critical', POLICY) === 0, 'and at critical every empty room goes at once');
assert(idleWindowFor('high', POLICY) < idleWindowFor('ok', POLICY), 'pressure only ever shortens it');
assert(idleWindowFor('critical', POLICY) <= idleWindowFor('high', POLICY), 'and more pressure shortens it further');

console.log('M3: a short configured window is not LENGTHENED by pressure');
// The tests run with a tiny window; a naive Math.max would have quietly made
// eviction slower exactly when it needed to be faster.
const SHORT = { budgetBytes: 400 * MB, idleMs: 5_000 };
assert(idleWindowFor('high', SHORT) === 5_000, 'a five-second window stays five seconds under pressure');
assert(idleWindowFor('critical', SHORT) === 0, 'and still collapses at critical');

console.log('M4: nonsense readings do not trigger a panic');
// A bogus pressure reading that sheds every room is worse than none.
assert(pressureFrom(NaN, POLICY) === 'ok', 'NaN is not an emergency');
assert(pressureFrom(0, POLICY) === 'ok', 'nor zero');
assert(pressureFrom(-1, POLICY) === 'ok', 'nor a negative reading');
assert(pressureFrom(100 * MB, { budgetBytes: 0, idleMs: 1 }) === 'ok', 'nor a budget of zero — no division blowup');

console.log('M5: the log says something a person can act on');
const line = describeMemory(340 * MB, POLICY);
assert(line.includes('340MB') && line.includes('400MB') && line.includes('85%'),
  'used, budget and percentage all present', line);
assert(!describeMemory(1, { budgetBytes: 0, idleMs: 0 }).includes('NaN'), 'and no NaN leaks into it');

console.log(`\nMEMORY GUARD RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
