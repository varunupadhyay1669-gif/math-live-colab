// How long a student whose screen is empty waits before asking again.
//
// 17 Sep 2026. The old ladder was four timers — 2s, 5s, 10s, 20s — and then it
// stopped for good. Nothing re-armed it: the effect's dependencies do not
// change while a student is stuck, so twenty seconds after arriving, a student
// looking at "Waiting for teacher..." had made their last request and the only
// moves left were a button that gave no sign of working, or a page reload.
//
// The 48 hours to 17 Sep hold 80 `request_content` events across 95 joins, and
// 14 of 17 student sockets sent them at offsets [0, 3, 8, 18] — the whole
// ladder, every rung, meaning every one of those students still had nothing on
// screen when it ran out. One of them pressed Retry Loading fourteen times in
// 4.3 seconds and then reloaded the page.
//
// So: the same four rungs (they are well judged — a lesson usually lands in the
// first couple of seconds, and a student who is genuinely early should not be
// left waiting), and after that a steady, cheap cadence that never gives up.
// These are iPads on hotel wifi and the server has 1 GB: one ask every 15
// seconds is far less traffic than the page reload it replaces, and after the
// request_content handler was taught to answer from the mirror cache, an ask
// costs the room less than it used to.

/** Gaps BETWEEN attempts. Cumulative, that is 2s, 5s, 10s, 20s — the ladder. */
const RUNGS = [2000, 3000, 5000, 10000];

/** The cadence a student who is still staring at nothing settles into. */
export const CONTENT_RETRY_STEADY_MS = 15000;

/**
 * How long to wait before attempt number `attempt` (0-based).
 *
 * Always a number. That is the whole point: there is no attempt count at which
 * this returns null, undefined or Infinity, because there is no number of
 * seconds after which a student with an empty screen stops deserving an answer.
 */
export function contentRetryDelay(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) return RUNGS[0];
  const i = Math.floor(attempt);
  return i < RUNGS.length ? RUNGS[i] : CONTENT_RETRY_STEADY_MS;
}

/** When attempt `attempt` fires, in ms from the first one being scheduled. */
export function contentRetryOffset(attempt: number): number {
  let total = 0;
  for (let i = 0; i <= attempt; i++) total += contentRetryDelay(i);
  return total;
}
