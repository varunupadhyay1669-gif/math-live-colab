// Switching students and lesson days.
//
// Two things decide whether this is usable: labels that tell one lesson from
// another, and a save that updates a day rather than adding a row to it.
// node --import tsx test-lessonnav.mjs
import { lessonLabel, lessonIsToday, labelSessions, boardHasContent, lessonDay, findSessionForDay } from './src/lib/lessonNav.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const row = (iso, topic = null, id = iso) => ({ id, started_at: iso, topic, class_id: 'c', teacher_id: 't', ended_at: null, notes: null, whiteboard_snapshot: null, html_used: null });

console.log('L1: a lesson is named by its day');
assert(lessonDay('2026-08-06T16:00:00.000Z') === '2026-08-06', 'the day is the calendar date');
assert(lessonDay('2026-08-06T23:59:00.000Z') === '2026-08-06', 'and late in the day is still that day');
const l = lessonLabel(row('2026-08-06T16:00:00.000Z'));
assert(/Aug/.test(l) && /6/.test(l), 'the label carries the date', l);

console.log('L2: the topic is the useful half, when there is one');
assert(lessonLabel(row('2026-08-06T16:00:00.000Z', 'Quadratics')).includes('Quadratics'),
  'a topic is shown beside the date');
const longTopic = lessonLabel(row('2026-08-06T16:00:00.000Z', 'Simultaneous equations by elimination and substitution'));
assert(longTopic.includes('…'), 'a long one is cut rather than pushing the header off screen', longTopic);
assert(longTopic.length < 40, 'and stays a sensible width', String(longTopic.length));
assert(!lessonLabel(row('2026-08-06T16:00:00.000Z', '   ')).includes('·'),
  'a blank topic does not leave a dangling separator');

console.log('L3: two lessons on one day are told apart');
// The failure this prevents: a picker showing "Aug 6" three times, which looks
// like a bug and gives no way to choose.
const sameDay = [
  row('2026-08-06T09:00:00.000Z', null, 'a'),
  row('2026-08-06T16:00:00.000Z', null, 'b'),
  row('2026-07-30T16:00:00.000Z', null, 'c'),
];
const labelled = labelSessions(sameDay);
assert(labelled[0].label !== labelled[1].label, 'the two same-day lessons get different labels',
  labelled.map(x => x.label).join(' / '));
assert(/\d{1,2}:\d{2}/.test(labelled[0].label), 'because the time is added where it is needed');
assert(!/\d{1,2}:\d{2}/.test(labelled[2].label),
  'but a once-a-week student does not get a train timetable', labelled[2].label);

console.log('L4: saving updates the day instead of stacking rows');
// saveSession always INSERTed. Pressing "Save to history" three times in one
// lesson wrote three near-identical rows for the same afternoon.
const history = [row('2026-08-06T09:00:00.000Z', null, 'today'), row('2026-07-30T16:00:00.000Z', null, 'lastweek')];
assert(findSessionForDay(history, '2026-08-06')?.id === 'today', 'today resolves to today\'s row');
assert(findSessionForDay(history, '2026-07-30')?.id === 'lastweek', 'and last week to last week\'s');
assert(findSessionForDay(history, '2026-08-05') === null, 'a day with no lesson resolves to nothing — a NEW row');
assert(findSessionForDay([], '2026-08-06') === null, 'and an empty history too');

console.log('L5: "today" means today');
assert(lessonIsToday(row(new Date().toISOString())), 'a lesson saved now is today');
assert(!lessonIsToday(row('2020-01-01T00:00:00.000Z')), 'one from 2020 is not');

console.log('L6: an empty board is never written over a student\'s history');
// Switching lessons saves first. Without this check, every switch would file
// a blank lesson over real work.
assert(boardHasContent({ strokes: [{ id: 's' }] }), 'ink counts');
assert(boardHasContent({ shapes: [{ id: 's' }] }), 'shapes count');
assert(boardHasContent({ texts: [{ id: 't' }] }), 'text counts');
assert(boardHasContent({ objects: [{ id: 'o' }] }), 'images count');
assert(boardHasContent({ instruments: [{ id: 'i' }] }), 'a dropped ruler counts');
assert(!boardHasContent({ strokes: [], shapes: [], texts: [], objects: [], instruments: [] }), 'an empty board does not');
assert(!boardHasContent({}), 'nor an absent one');
assert(!boardHasContent(null) && !boardHasContent(undefined), 'nor null');
assert(!boardHasContent({ strokes: 'lots' }), 'and a malformed field is not mistaken for content');
assert(boardHasContent({ gridMode: 'graph', strokes: [{ id: 'x' }] }),
  'grid mode alone is not content, but ink with it is');
assert(!boardHasContent({ gridMode: 'graph' }),
  'switching the paper to graph and changing your mind does not file a lesson');

console.log(`\nLESSON NAV RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
