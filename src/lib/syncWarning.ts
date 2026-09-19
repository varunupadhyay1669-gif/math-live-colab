// Which students the tutor should be warned about, and when the clock means
// nothing.
//
// The tutor gets one red pill when a student's screen has fallen behind: the
// follower acks every frame it paints, the server forwards the ack, and a
// student whose last ack is old, or who said the frame did not match, is named.
//
// 17 Sep 2026, found in review before it reached a class. The fix that stopped
// the hidden lesson streaming while the whiteboard is up also stopped its 2s
// heartbeat, and the heartbeat is what produces acks. So a board trip of more
// than twelve seconds put "Learner is not seeing your screen — 40 seconds
// behind" on the tutor's screen, with a Resend that could not send anything,
// every single time. Measured on the board: clean at 5s and 10s, warning at
// 15s, still there at 40s, gone a second after leaving.
//
// The lesson is deliberately silent on the board, so silence there is not
// evidence of anything. Two rules follow:
//
//   * On the whiteboard, nobody is reported. There is nothing to be behind.
//   * Coming back, the clock starts from the moment the class returned, not
//     from the last ack, so the minutes spent at the board are not counted
//     against the first ack, which lands about two seconds later.
//
// Pure, so both rules are tested without a browser.

export interface AckedStatus {
  /** The follower said the frame it painted matched the tutor's fingerprint. */
  ok: boolean;
  /** When that ack was recorded, ms epoch. */
  at: number;
}

export interface OutOfSyncStudent {
  id: string;
  name: string;
  /** How long their screen has been unaccounted for, in whole seconds. */
  secondsBehind: number;
}

/** Past the ~2s heartbeat and the 7s the participants list treats as merely quiet. */
export const SYNC_STALE_MS = 12_000;

export function studentsOutOfSync(
  students: ReadonlyArray<{ id: string; name: string }>,
  status: Readonly<Record<string, AckedStatus | undefined>>,
  opts: { now: number; onWhiteboard: boolean; clockFrom?: number; staleMs?: number },
): OutOfSyncStudent[] {
  if (opts.onWhiteboard) return [];
  const staleMs = opts.staleMs ?? SYNC_STALE_MS;
  const clockFrom = opts.clockFrom ?? 0;
  const out: OutOfSyncStudent[] = [];
  for (const s of students) {
    const ack = status[s.id];
    if (!ack) continue;   // never acked at all: the join path speaks for that
    const since = opts.now - Math.max(ack.at, clockFrom);
    // A "did not match" is only believed if it was said after the class came
    // back: one from before the board trip has had no chance to be corrected.
    const saidNotOk = !ack.ok && ack.at >= clockFrom;
    if (since > staleMs || saidNotOk) {
      out.push({ id: s.id, name: s.name, secondsBehind: Math.max(0, Math.round(since / 1000)) });
    }
  }
  return out;
}
