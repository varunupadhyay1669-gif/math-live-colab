// MathsLive Admin — the labels the owner reads a tutor's activity from.
//
// The access control itself is in Postgres (migration 004) and cannot be
// tested from here; this covers the presentation, where a wrong answer means
// a tutor is called dormant while they are teaching daily.
// node --import tsx test-admin.mjs
import { activityStatus, agoLabel } from './src/lib/adminLabels.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const NOW = Date.parse('2026-08-07T12:00:00.000Z');
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();

console.log('A1: how active is this tutor');
assert(activityStatus(daysAgo(0), NOW) === 'active this week', 'signed in today');
assert(activityStatus(daysAgo(6), NOW) === 'active this week', 'and six days ago');
assert(activityStatus(daysAgo(8), NOW) === 'active this month', 'eight days ago is this month');
assert(activityStatus(daysAgo(29), NOW) === 'active this month', 'and twenty-nine days');
assert(activityStatus(daysAgo(45), NOW) === 'dormant', 'six weeks is dormant');
assert(activityStatus(null, NOW) === 'never signed in',
  'someone who was given a login and never used it is NOT "dormant" — that is a different conversation');

console.log('A2: the boundaries are where they are named');
assert(activityStatus(daysAgo(7), NOW) === 'active this week', 'exactly seven days still counts as the week');
assert(activityStatus(daysAgo(30), NOW) === 'active this month', 'and exactly thirty as the month');
assert(activityStatus(daysAgo(31), NOW) === 'dormant', 'thirty-one is not');

console.log('A3: a clock skewed into the future does not read as dormant');
// A tutor whose device clock is ahead would otherwise be reported dormant
// while they are teaching daily.
assert(activityStatus(new Date(NOW + 3600_000).toISOString(), NOW) === 'active this week',
  'a timestamp slightly in the future is still active');
assert(activityStatus('not a date', NOW) === 'never signed in', 'and junk does not throw');

console.log('A4: when was the last lesson');
assert(agoLabel(daysAgo(0), NOW) === 'today', 'today');
assert(agoLabel(daysAgo(1), NOW) === 'yesterday', 'yesterday');
assert(agoLabel(daysAgo(5), NOW) === '5 days ago', 'a few days');
assert(agoLabel(daysAgo(31), NOW) === 'a month ago', 'a month reads as a month, not "31 days"');
assert(agoLabel(daysAgo(75), NOW) === '3 months ago', 'and longer in months');
assert(agoLabel(null, NOW) === '—', 'a tutor who has never taught shows a dash, not "today"');
assert(agoLabel('rubbish', NOW) === '—', 'and junk does not throw');

console.log(`\nADMIN RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
