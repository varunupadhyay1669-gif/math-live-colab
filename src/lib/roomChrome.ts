// Which room-status row to show — at most one, ever.
//
// There used to be three independent banners above the board, each with its
// own `&&` in the render. Two of them applied at once for any signed-in tutor
// with an unsaved board, and a third for one who had just saved. Nothing in
// the code stopped all of them appearing together; it was only ever the
// conditions happening not to overlap. Meanwhile the whiteboard started ~190px
// down a 720px screen.
//
// Pulling the decision out here makes "at most one row" a property that can be
// checked rather than a thing to hope for.

export interface ChromeState {
  /** Anonymous room counting down to expiry. */
  expiresAt: number | null;
  claimed: boolean;
  claimedBy: string | null;
  /** Signed in, so this lesson can be filed under the student. */
  canSaveHistory: boolean;
  /** Whiteboard open — the row competes directly with drawing space. */
  slim: boolean;
}

export type StripMode =
  | 'none'
  | 'expiry'    // just the countdown (its own live clock)
  | 'history'   // just the "file this lesson" prompt
  | 'both'      // one row carrying both actions
  | 'saved';    // the confirmation, which is never urgent

export function stripMode(s: ChromeState): StripMode {
  const unsaved = !s.claimed && !!s.expiresAt;
  if (unsaved && s.canSaveHistory) return 'both';
  if (unsaved) return 'expiry';
  if (s.canSaveHistory) return 'history';
  // A confirmation of something already done is the first thing to drop when
  // the board needs the room.
  if (s.claimed && s.claimedBy && !s.slim) return 'saved';
  return 'none';
}
