// Challenge-timer durations.
//
// The old list was 30s / 1 / 1.5 / 2 / 3 min — five options, none longer than
// three minutes. That covers "try this one question" and nothing else: not the
// 10-second mental-arithmetic drill, not the ten-minute exam-condition past
// paper. This is the full range a lesson actually uses, plus a custom entry so
// the list never has to be guessed exactly right.

export const TIMER_PRESETS = [10, 15, 30, 45, 60, 90, 120, 180, 300, 600, 900] as const;

/** "1:30", "90", "90s", "1.5 min", "2m" → seconds. Null when it isn't a time. */
export function parseDuration(input: string): number | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  // mm:ss — the form people type when they mean a stopwatch.
  const clock = raw.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (clock) return clampDuration(Number(clock[1]) * 60 + Number(clock[2]));

  const m = raw.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] || '';
  // A bare number is minutes only if it is small enough that seconds would be
  // absurd — "5" means five minutes, "90" means ninety seconds. Guessing the
  // other way round starts a 90-minute timer in the middle of a lesson.
  const seconds = /^(m|min|mins|minute|minutes)$/.test(unit) ? n * 60
    : unit ? n
    : n <= 10 ? n * 60
    : n;
  return clampDuration(seconds);
}

export const MIN_DURATION = 5;
export const MAX_DURATION = 3600;   // an hour; longer than any single task

/** Whole seconds inside the allowed range, or null. Also the server's rule. */
export function clampDuration(seconds: number): number | null {
  if (!Number.isFinite(seconds)) return null;
  const s = Math.round(seconds);
  if (s < MIN_DURATION || s > MAX_DURATION) return null;
  return s;
}

/** "45s", "1:30", "10:00" — what the tutor reads on the button. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

/** The menu label — slightly wordier than the countdown itself. */
export function presetLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  const m = seconds / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}
