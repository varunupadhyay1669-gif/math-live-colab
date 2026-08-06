import { boardHasContent } from './lessonNav';

// Putting the board back after the server forgets it.
//
// Rooms live in memory and are flushed to disk every five minutes — onto a
// filesystem that a redeploy wipes. So a server restart mid-lesson leaves the
// room gone: the teacher's client reconnects, claims the seat, and the server
// hands back a BRAND NEW EMPTY ROOM. Every student's board goes blank and the
// lesson's work is gone.
//
// Except it isn't: the teacher's own browser still holds every stroke. It
// already re-seeds the HTML lesson on reconnect for exactly this reason — the
// whiteboard was simply never included, which is the more painful half.
//
// The decision is here rather than inline because getting it wrong in the other
// direction is just as bad: re-seeding a board the server DID keep would
// duplicate every stroke on it.

export interface ReseedDecision {
  reseed: boolean;
  reason: string;
}

/**
 * Should we push our local board back to the server?
 *
 * Only when all of these hold: this is a reconnect (not a first join, where an
 * empty room is simply a new room), the server came back with nothing, and we
 * are holding something worth restoring.
 */
export function shouldReseedBoard(
  serverBoard: unknown,
  localBoard: unknown,
  opts: { wasReconnect: boolean; alreadyReseeded: boolean },
): ReseedDecision {
  if (!opts.wasReconnect) {
    return { reseed: false, reason: 'first join — an empty room here is just a new room' };
  }
  if (opts.alreadyReseeded) {
    // Without this, every subsequent room_state during one reconnect would
    // replay the board again, stacking duplicates.
    return { reseed: false, reason: 'already restored once this reconnect' };
  }
  if (boardHasContent(serverBoard)) {
    return { reseed: false, reason: 'the server kept the board — restoring would duplicate it' };
  }
  if (!boardHasContent(localBoard)) {
    return { reseed: false, reason: 'nothing local to restore' };
  }
  return { reseed: true, reason: 'server lost the board and we still hold it' };
}

/**
 * How many pieces we would push back — used for the message the tutor sees.
 *
 * Silently repopulating a board that just went blank looks like a glitch;
 * saying what happened turns it into the app visibly saving them.
 */
export function boardPieceCount(board: unknown): number {
  const b = (board || {}) as Record<string, unknown[]>;
  return ['objects', 'strokes', 'shapes', 'texts', 'instruments']
    .reduce((n, k) => n + (Array.isArray(b[k]) ? b[k].length : 0), 0);
}
