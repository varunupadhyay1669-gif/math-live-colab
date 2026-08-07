// Teaching time — the number the admin page reports as hours taught.
//
// Both ways of getting this wrong are bad in the same direction: counting the
// twenty minutes of setup before the student arrives, or the room left open
// over lunch, inflates every tutor's figure and makes the whole page a lie.
// node --import tsx test-teachingtime.mjs
import { TeachingClock, isTeaching, humanTeachingTime } from './src/lib/teachingTime.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const T = (r) => ({ role: r });
const MIN = 60_000;

console.log('P1: a lesson is a teacher AND a student');
assert(isTeaching([T('teacher'), T('student')]), 'both present is a lesson');
assert(!isTeaching([T('teacher')]), 'a teacher alone is preparing, not teaching');
assert(!isTeaching([T('student')]), 'a student alone is waiting, not being taught');
assert(!isTeaching([]), 'an empty room is neither');
assert(isTeaching([T('teacher'), T('student'), T('student')]), 'two students still counts once');

console.log('P2: the clock runs only during the lesson');
const c = new TeachingClock();
let t = 1_000_000;
c.setPresence(false, t);                    // teacher arrives early, sets up
t += 20 * MIN;
assert(c.total(t) === 0, 'twenty minutes of setup before the student counts as nothing', String(c.total(t)));
c.setPresence(true, t);                     // student joins
t += 45 * MIN;
assert(c.total(t) === 45 * 60, 'forty-five minutes of lesson counts as forty-five', String(c.total(t) / 60));
c.setPresence(false, t);                    // student leaves
t += 90 * MIN;                              // room left open over lunch
assert(c.total(t) === 45 * 60, 'and the room left open afterwards adds nothing', String(c.total(t) / 60));

console.log('P3: a student dropping out mid-lesson pauses it');
const d = new TeachingClock();
let u = 0;
d.setPresence(true, u); u += 10 * MIN;
d.setPresence(false, u); u += 5 * MIN;      // she drops off the wifi
d.setPresence(true, u); u += 10 * MIN;      // and comes back
assert(d.total(u) === 20 * 60, 'the five minutes she was gone are not billed', String(d.total(u) / 60));

console.log('P4: it is safe to drive from every user_list');
// This is called on every membership change, which fires constantly.
const e = new TeachingClock();
let v = 0;
e.setPresence(true, v);
for (let i = 0; i < 50; i++) e.setPresence(true, v);   // repeats while nothing changed
v += 10 * MIN;
assert(e.total(v) === 10 * 60, 'repeated "still teaching" does not multiply the time', String(e.total(v) / 60));
for (let i = 0; i < 50; i++) e.setPresence(false, v);
assert(e.total(v) === 10 * 60, 'nor does repeated "stopped"', String(e.total(v) / 60));

console.log('P5: a reload mid-lesson keeps the time already taught');
const f = new TeachingClock();
f.resume(30 * 60);                          // half an hour was already banked
let w = 0;
f.setPresence(true, w); w += 10 * MIN;
assert(f.total(w) === 40 * 60, 'resumed time is added to, not replaced', String(f.total(w) / 60));
f.reset();
assert(f.total(w) === 0, 'and starting a different lesson starts a different clock');
const g = new TeachingClock();
g.resume(-5); assert(g.total(0) === 0, 'a nonsense resume value is ignored');
g.resume(NaN); assert(g.total(0) === 0, 'and so is NaN');

console.log('P6: reading it back');
assert(humanTeachingTime(45) === '45s', 'under a minute');
assert(humanTeachingTime(45 * 60) === '45m', 'three quarters of an hour');
assert(humanTeachingTime(3600) === '1h', 'exactly an hour is not "1h 0m"');
assert(humanTeachingTime(85 * 60) === '1h 25m', 'an hour and a bit');
assert(humanTeachingTime(90 * 60) === '1h 30m', 'ninety minutes');
// 119.6 minutes rounds to 60 minutes past the hour, which must carry.
assert(humanTeachingTime(7176) === '2h', '"1h 60m" is never printed', humanTeachingTime(7176));
assert(humanTeachingTime(null) === '—', 'a lesson from before tracking existed shows unknown, not zero');
assert(humanTeachingTime(undefined) === '—', 'and so does a missing value');
assert(humanTeachingTime(NaN) === '—', 'and NaN');
assert(humanTeachingTime(0) === '0s', 'but a genuine zero is a zero');

console.log(`\nTEACHING TIME RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f2 => console.log('  - ' + f2)); }
process.exit(fail === 0 ? 0 : 1);
