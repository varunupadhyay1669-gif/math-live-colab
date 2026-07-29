// Ordering + "type to jump" matching for the teacher's student list.
// Runs the REAL helper (src/lib/studentSearch.ts) via tsx, so this can't drift
// from what the Dashboard actually uses.
// node --import tsx test-student-search.mjs
import { sortStudents, filterStudents, scoreStudent } from './src/lib/studentSearch.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const names = (list) => list.map(r => r.student_name);

const ROSTER = [
  { student_name: 'Zara Ahmed',   label: 'Grade 7',  room_code: 'zara7' },
  { student_name: 'anika kapoor', label: 'Grade 5',  room_code: 'anika5' },
  { student_name: 'Drihan Patel', label: 'Grade 6',  room_code: 'drihan6' },
  { student_name: 'Student 10',   label: 'trial',    room_code: 's10' },
  { student_name: 'Student 2',    label: 'trial',    room_code: 's2' },
  { student_name: 'Kabir Singh',  label: 'Grade 9',  room_code: 'kabir9' },
];

console.log('S1: alphabetical order');
const sorted = names(sortStudents(ROSTER));
assert(sorted[0] === 'anika kapoor', 'A–Z regardless of capitalisation (lower-case "anika" still sorts first)', sorted.join(', '));
assert(sorted[sorted.length - 1] === 'Zara Ahmed', 'Z sorts last', sorted.join(', '));
assert(sorted.indexOf('Student 2') < sorted.indexOf('Student 10'), '"Student 2" before "Student 10" (numeric, not text, ordering)', sorted.join(', '));

console.log('S2: typing the first letters of a name');
const an = names(filterStudents(ROSTER, 'an'));
assert(an[0] === 'anika kapoor', '"an" puts Anika first', an.join(', '));
const dri = names(filterStudents(ROSTER, 'dri'));
assert(dri[0] === 'Drihan Patel' && dri.length === 1, '"dri" narrows to exactly Drihan', dri.join(', '));

console.log('S3: matching a surname');
const ka = names(filterStudents(ROSTER, 'ka'));
assert(ka[0] === 'Kabir Singh', '"ka" prefers Kabir (first name beats surname)', ka.join(', '));
assert(ka.includes('anika kapoor'), '"ka" still finds "anika kapoor" by her surname', ka.join(', '));

console.log('S4: searching by class label or room code');
const g9 = names(filterStudents(ROSTER, 'grade 9'));
assert(g9.length === 1 && g9[0] === 'Kabir Singh', 'a label like "Grade 9" finds the right student', g9.join(', '));
const byCode = names(filterStudents(ROSTER, 'drihan6'));
assert(byCode.length === 1 && byCode[0] === 'Drihan Patel', 'a room code finds its student', byCode.join(', '));

console.log('S5: no match, and empty query');
assert(filterStudents(ROSTER, 'zzzz').length === 0, 'a query nobody matches returns nothing (so the UI can say so)');
assert(filterStudents(ROSTER, '').length === ROSTER.length, 'an empty box shows everyone');
assert(filterStudents(ROSTER, '   ').length === ROSTER.length, 'whitespace only is treated as empty');

console.log('S6: ranking is strict');
assert(scoreStudent({ student_name: 'Anika' }, 'an') === 0, 'name-start ranks best');
assert(scoreStudent({ student_name: 'Anika Kapoor' }, 'ka') === 1, 'word-start ranks second');
assert(scoreStudent({ student_name: 'Bob', label: 'Grade 5' }, 'grade') === 2, 'label match ranks third');
assert(scoreStudent({ student_name: 'Bob' }, 'xyz') === 99, 'no match is excluded');

console.log('S7: robust against messy data');
assert(filterStudents([{ student_name: null }, { student_name: 'Amy' }], 'am').length === 1, 'a missing name never crashes the search');
assert(sortStudents([{ student_name: null }, { student_name: 'Amy' }]).length === 2, 'sorting tolerates a missing name');

console.log(`\nSTUDENT SEARCH RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
