import type { SessionRow } from './sessions';

/** Local calendar day of an ISO timestamp — lessons are named by their day. */
export function lessonDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** The row for a given day, if this class already has one. */
export function findSessionForDay(rows: SessionRow[], day: string): SessionRow | null {
  return rows.find(r => lessonDay(r.started_at) === day) ?? null;
}

// Naming a lesson so a tutor can pick it out of a list.
//
// A lesson picker is only useful if the labels distinguish the lessons. "Aug 6"
// three times over is worse than useless — it looks like a bug and gives no way
// to choose. So: the day, plus the time only when a student had more than one
// lesson that day, plus the topic when there is one.

/** "Aug 6", "Aug 6, 16:00", "Aug 6 · Quadratics". Never bare and ambiguous. */
export function lessonLabel(row: SessionRow, sameDayCount = 1): string {
  const d = new Date(row.started_at);
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const base = sameDayCount > 1 ? `${day}, ${time}` : day;
  const topic = (row.topic || '').trim();
  // The topic is the useful half when it exists, but a 60-character lesson name
  // would push the header wider than the screen.
  return topic ? `${base} · ${topic.length > 22 ? topic.slice(0, 21) + '…' : topic}` : base;
}

export function lessonIsToday(row: SessionRow): boolean {
  return lessonDay(row.started_at) === lessonDay(new Date().toISOString());
}

/**
 * Label every row, disambiguating only the days that need it.
 *
 * Adding the time to all of them would make a once-a-week student's history
 * read like a train timetable.
 */
export function labelSessions(rows: SessionRow[]): Array<{ row: SessionRow; label: string }> {
  const perDay = new Map<string, number>();
  for (const r of rows) {
    const d = lessonDay(r.started_at);
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  return rows.map(row => ({ row, label: lessonLabel(row, perDay.get(lessonDay(row.started_at)) || 1) }));
}

/**
 * Is there anything on this board worth saving before we replace it?
 *
 * Switching lessons wipes the live board. Doing that silently over a lesson's
 * work is the one unrecoverable thing this feature could do, so the caller
 * saves first — but only when there is something to save, or every switch
 * writes an empty row over the student's history.
 */
export function boardHasContent(wb: unknown): boolean {
  const b = (wb || {}) as Record<string, unknown[]>;
  return ['objects', 'strokes', 'shapes', 'texts', 'instruments']
    .some(k => Array.isArray(b[k]) && b[k].length > 0);
}
