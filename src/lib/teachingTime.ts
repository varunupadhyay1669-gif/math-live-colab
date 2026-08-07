// How long was actually taught.
//
// The obvious approach — last save minus first save — measures saving, not
// teaching. A tutor who saved twice early and never again reads as a
// five-minute lesson. Wall-clock from entering the room is no better: it
// counts the twenty minutes spent setting up before the student arrives, and
// the room left open over lunch.
//
// So: count only while a teacher AND at least one student are both present.
// That is the definition a tutor would recognise as "the lesson".

/** Only ticks while both sides are there. */
export class TeachingClock {
  private seconds = 0;
  private since: number | null = null;

  /** Seconds already banked, plus any currently running. */
  total(now: number): number {
    return this.seconds + (this.since === null ? 0 : Math.floor((now - this.since) / 1000));
  }

  /**
   * Tell the clock who is in the room. Idempotent — safe to call on every
   * user_list, which is how it will actually be driven.
   */
  setPresence(teaching: boolean, now: number): void {
    if (teaching && this.since === null) {
      this.since = now;
      return;
    }
    if (!teaching && this.since !== null) {
      this.seconds += Math.floor((now - this.since) / 1000);
      this.since = null;
    }
  }

  /** Resume a lesson already part-taught — a reload mid-lesson keeps its time. */
  resume(seconds: number): void {
    if (Number.isFinite(seconds) && seconds > 0) this.seconds = Math.floor(seconds);
  }

  /** Starting a different lesson starts a different clock. */
  reset(): void {
    this.seconds = 0;
    this.since = null;
  }
}

/**
 * Is this room in a lesson right now?
 *
 * Both roles must be present. A teacher alone is preparing; a student alone is
 * waiting. Neither is teaching, and counting either inflates every figure the
 * admin page reports.
 */
export function isTeaching(users: Array<{ role: string }>): boolean {
  let teacher = false, student = false;
  for (const u of users) {
    if (u.role === 'teacher') teacher = true;
    else if (u.role === 'student') student = true;
    if (teacher && student) return true;
  }
  return false;
}

/** "1h 25m", "45m", "30s" — for a person reading a summary. */
export function humanTeachingTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  // 90 minutes must not render as "1h 60m".
  if (h > 0) return m === 60 ? `${h + 1}h` : m === 0 ? `${h}h` : `${h}h ${m}m`;
  return `${m}m`;
}
