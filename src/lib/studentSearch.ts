// Ordering + "type a few letters to jump" matching for the teacher's student
// list. Kept out of the component so the behaviour is unit-testable — the
// ranking rules are the whole point of the feature and easy to regress.

export type SearchableClass = {
  student_name?: string | null;
  label?: string | null;
  room_code?: string | null;
};

/** A–Z by student name. `numeric` so "Student 2" precedes "Student 10", and
 *  base sensitivity so case/accents don't split the alphabet. */
export function sortStudents<T extends SearchableClass>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    (a.student_name || '').localeCompare(b.student_name || '', undefined, {
      sensitivity: 'base',
      numeric: true,
    }));
}

/** Lower is a better match; 99 means "no match, hide it".
 *   0 the name starts with the query          ("an" → "Anika")
 *   1 any word in the name starts with it     ("ka" → "Anika Kapoor")
 *   2 it appears anywhere, incl. label / code ("grade 5", a room code)
 */
export function scoreStudent(row: SearchableClass, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = (row.student_name || '').toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.split(/\s+/).some(w => w.startsWith(q))) return 1;
  const hay = `${name} ${(row.label || '').toLowerCase()} ${(row.room_code || '').toLowerCase()}`;
  if (hay.includes(q)) return 2;
  return 99;
}

/** Sorted A–Z when idle; best-match-first while searching. Stable within a
 *  rank, so equally-good matches stay alphabetical. */
export function filterStudents<T extends SearchableClass>(rows: readonly T[], query: string): T[] {
  const sorted = sortStudents(rows);
  const q = query.trim();
  if (!q) return sorted;
  return sorted
    .map((r, i) => ({ r, s: scoreStudent(r, q), i }))
    .filter(x => x.s < 99)
    .sort((a, b) => (a.s - b.s) || (a.i - b.i))
    .map(x => x.r);
}
