// Challenge timer — durations a lesson actually uses, and a custom entry that
// cannot start a nonsense countdown on a child's screen.
// node --import tsx test-timer.mjs
import { TIMER_PRESETS, parseDuration, clampDuration, formatDuration, presetLabel, MIN_DURATION, MAX_DURATION } from './src/lib/timerOptions.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

console.log('T1: the range covers a real lesson');
// The old list stopped at 3 minutes, which covers "try this question" and
// nothing else — no 10-second drill, no exam-condition past paper.
assert(TIMER_PRESETS.includes(10), 'a 10-second mental-arithmetic drill');
assert(TIMER_PRESETS.includes(600), 'and a ten-minute past paper', String(TIMER_PRESETS.slice(-3)));
assert(TIMER_PRESETS.length >= 10, 'more than the old five', String(TIMER_PRESETS.length));
assert(TIMER_PRESETS.every((s, i, a) => i === 0 || s > a[i - 1]), 'and they are in order');
assert(TIMER_PRESETS.every(s => clampDuration(s) === s), 'every preset is itself a legal duration');

console.log('T2: custom entry understands how people write times');
assert(parseDuration('90s') === 90, '"90s"');
assert(parseDuration('45 sec') === 45, '"45 sec"');
assert(parseDuration('7 min') === 420, '"7 min"');
assert(parseDuration('2m') === 120, '"2m"');
assert(parseDuration('1.5 min') === 90, '"1.5 min"');
assert(parseDuration('2:30') === 150, '"2:30" — the stopwatch form');
assert(parseDuration('10:00') === 600, '"10:00"');
assert(parseDuration(' 90 ') === 90, 'and stray spaces do not matter');

console.log('T3: a bare number guesses the way that cannot ruin a lesson');
// "5" means five minutes; "90" means ninety seconds. Reading "90" as minutes
// would start a 90-minute countdown in the middle of a class.
assert(parseDuration('5') === 300, '"5" is five minutes');
assert(parseDuration('90') === 90, '"90" is ninety seconds, not ninety minutes');
assert(parseDuration('10') === 600, '"10" is ten minutes — the boundary');
assert(parseDuration('11') === 11, 'and "11" is eleven seconds');

console.log('T4: nonsense never becomes a countdown');
// This reaches every student's screen, so a typo must stop here.
for (const junk of ['', '   ', 'abc', '-30', '0', '1e9', 'NaN', 'Infinity', '5 fortnights', '1:99', '--5', '3,5'])
  assert(parseDuration(junk) === null, `rejected: ${JSON.stringify(junk)}`, String(parseDuration(junk)));
assert(parseDuration('2 hours') === null, 'and a unit we do not support is rejected rather than guessed');

console.log('T5: the range is enforced, not suggested');
assert(clampDuration(MIN_DURATION) === MIN_DURATION, 'the minimum is allowed');
assert(clampDuration(MAX_DURATION) === MAX_DURATION, 'and the maximum');
assert(clampDuration(MIN_DURATION - 1) === null, 'a second under is not');
assert(clampDuration(MAX_DURATION + 1) === null, 'nor a second over');
assert(clampDuration(NaN) === null && clampDuration(Infinity) === null, 'and neither NaN nor Infinity');
assert(clampDuration(90.6) === 91, 'fractional seconds round to whole ones');
assert(parseDuration('3601') === null, 'a custom time past an hour is refused at the parse');

console.log('T6: what the tutor reads');
assert(formatDuration(45) === '45s', 'under a minute counts in seconds');
assert(formatDuration(90) === '1:30', 'over a minute reads as a clock');
assert(formatDuration(600) === '10:00', 'and ten minutes is not "10:0"');
assert(formatDuration(60) === '1:00', 'exactly a minute too');
assert(presetLabel(30) === '30 sec' && presetLabel(90) === '1.5 min' && presetLabel(600) === '10 min',
  'menu labels are wordier than the running countdown');

console.log(`\nTIMER RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
