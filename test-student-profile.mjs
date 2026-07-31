// The per-student profile: identity, goals, and "when did I last teach them".
// Runs the REAL helpers via tsx so they can't drift from the app.
// node --import tsx test-student-profile.mjs
import {
  profileFrom, parseGoals, joinGoals, firstEmoji, initials,
  accentFor, avatarFor, summariseHistory, sinceLabel,
} from './src/lib/studentProfile.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

console.log('P1: a profile read from a row that predates the migration');
const old = { id: '1', student_name: 'Anika', room_code: 'anika' };
const p0 = profileFrom(old);
assert(p0.grade === '' && p0.level === '' && p0.avatar === '', 'missing columns read as empty, not undefined');
assert(Array.isArray(p0.goals) && p0.goals.length === 0, 'goals is always a list');
assert(profileFrom(null).grade === '', 'a missing row does not throw');
assert(profileFrom(undefined).goals.length === 0, 'an undefined row does not throw');

console.log('P2: a filled-in profile');
const p1 = profileFrom({ grade: ' Year 8 ', level: 'Higher', goals: 'Fractions\n- Ratios\n\n  • Percentages ', avatar: '🦊' });
assert(p1.grade === 'Year 8', 'whitespace is trimmed');
assert(p1.goals.length === 3 && p1.goals[1] === 'Ratios', 'goals split per line, bullets stripped', JSON.stringify(p1.goals));
assert(p1.goals[2] === 'Percentages', 'and unicode bullets too', JSON.stringify(p1.goals));
assert(p1.avatar === '🦊', 'emoji avatar survives');

console.log('P3: goals round-trip without mangling');
const list = ['Master long division', 'Speed on times tables'];
assert(JSON.stringify(parseGoals(joinGoals(list))) === JSON.stringify(list), 'save then reload gives the same goals');
assert(parseGoals('').length === 0, 'empty text means no goals');
assert(parseGoals('\n\n \n').length === 0, 'blank lines are not goals');
assert(parseGoals(Array.from({ length: 40 }, (_, i) => 'g' + i).join('\n')).length === 12, 'capped so the card stays readable');

console.log('P4: the avatar field only ever holds an emoji');
assert(firstEmoji('🦊') === '🦊', 'an emoji is kept');
assert(firstEmoji('') === '', 'empty stays empty');
assert(firstEmoji('hello') === '', 'a word is rejected');
assert(firstEmoji('🦊🐰🐼') === '🦊', 'only the first is kept');
assert(firstEmoji('  🎯  ') === '🎯', 'padding is ignored');

console.log('P5: initials when there is no emoji');
assert(initials('Anika Kapoor') === 'AK', 'first and last initial');
assert(initials('drihan') === 'D', 'one name gives one letter');
assert(initials('  maya   r  sharma ') === 'MS', 'extra spaces do not break it');
assert(initials('') === '?', 'a nameless row still renders something');

console.log('P6: a student\'s colour is stable and derived, never picked');
const a1 = accentFor('Anika Kapoor'), a2 = accentFor('anika kapoor');
assert(a1.bg === a2.bg, 'case does not change the colour');
assert(accentFor('Anika').bg !== undefined, 'always resolves to a colour');
const spread = new Set(['Anika', 'Drihan', 'Maya', 'Rohan', 'Kabir', 'Zara', 'Ishaan', 'Meera'].map(n => accentFor(n).bg));
assert(spread.size >= 4, `different students get visibly different colours (${spread.size}/8 distinct)`);
const av = avatarFor('Anika Kapoor');
assert(av.label === 'AK' && av.isEmoji === false, 'no override falls back to initials');
assert(avatarFor('Anika Kapoor', '🦊').isEmoji === true, 'an emoji override wins');
assert(avatarFor('Anika Kapoor', 'nonsense').label === 'AK', 'junk in the avatar field falls back safely');

console.log('P7: the history summary a tutor actually reads');
const s = (id, topic, iso) => ({ id, topic, started_at: iso, class_id: 'c', teacher_id: 't', ended_at: null, notes: null, whiteboard_snapshot: null, html_used: null });
const hist = [
  s('3', 'Ratios', '2026-07-20T10:00:00Z'),
  s('1', 'Fractions', '2026-07-01T10:00:00Z'),
  s('2', 'fractions', '2026-07-10T10:00:00Z'),
];
const h = summariseHistory(hist);
assert(h.count === 3, 'counts every session');
assert(h.lastTaughtAt === '2026-07-20T10:00:00Z', 'last taught is the newest, whatever order they arrive in');
assert(h.topics[0] === 'Ratios', 'newest topic first', JSON.stringify(h.topics));
assert(h.topics.length === 2, 'the same topic twice is listed once', JSON.stringify(h.topics));
assert(summariseHistory([]).count === 0 && summariseHistory(null).lastTaughtAt === null, 'no history does not throw');

console.log('P8: recency in words');
const now = Date.parse('2026-07-31T12:00:00Z');
assert(sinceLabel(null, now) === 'not yet taught', 'never taught says so');
assert(sinceLabel('2026-07-31T09:00:00Z', now) === 'today', 'today');
assert(sinceLabel('2026-07-30T09:00:00Z', now) === 'yesterday', 'yesterday');
assert(sinceLabel('2026-07-28T09:00:00Z', now) === '3 days ago', 'a few days');
assert(sinceLabel('2026-07-20T09:00:00Z', now) === 'last week', 'last week');
assert(sinceLabel('2026-06-20T09:00:00Z', now).includes('weeks ago'), 'several weeks');
assert(sinceLabel('2026-04-01T09:00:00Z', now).includes('months ago'), 'months');
assert(sinceLabel('not-a-date', now) === 'not yet taught', 'a corrupt date does not crash the page');

console.log(`\nSTUDENT PROFILE RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
