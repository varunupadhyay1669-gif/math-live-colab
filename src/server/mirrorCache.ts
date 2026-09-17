// ── The room's cached mirror frame ──
//
// One slot per room: the last frame the tutor's authoritative iframe streamed,
// kept so a student who joins, reconnects or asks for help has something on
// screen instantly instead of a blank page. It is the largest single thing a
// room holds, so there is one of it and not one per surface (a 1 GB box, up to
// 3 MiB a frame).
//
// 17 Sep 2026. The rule this file exists to enforce, after a class where the
// tutor was on the whiteboard and the student was still on the worksheet:
//
//   A CACHED FINGERPRINT MAY ONLY EVER DESCRIBE A BODY THAT WAS ACTUALLY
//   CACHED WITH IT, AND A CACHED FRAME MAY ONLY BE SERVED TO A SCREEN THAT IS
//   SHOWING THE DOCUMENT IT CAME FROM.
//
// Both halves were broken, and each one on its own turns a moment of staleness
// into a permanent one, because the follower's fingerprint heartbeat is the
// only thing that repairs a lost frame. Give a student a frame whose hash
// belongs to a different document and the heartbeat agrees with the source for
// ever: the student sits on the wrong page reporting that they are fine.
//
//   * The hash used to be written by the 2 s fingerprint heartbeat ALONE
//     (`room.mirrorHash = h`), with no body beside it. Measured on 17 Sep: turn
//     a lesson to a page whose frame exceeds the 3 MiB ceiling, and the frame is
//     dropped while the heartbeat sails through — the cache then held page 0's
//     body wearing page 2's live fingerprint, and a student given that pair
//     reported ok:true while frozen on page 0 for the rest of the lesson.
//   * The slot carried no surface identity. The tutor has three surfaces and
//     the stream follows whichever is on screen, so for the ~250 ms around
//     every explanation open or close the slot still held the OTHER document —
//     measured at 22 of 330 samples across twelve switches, in both directions.
//     A student asking in that window was handed the lesson to paint into their
//     explanation, or the explanation to paint into their lesson.
//
// Pure on purpose: these are the rules, and they are checked offline in
// verify-mirror.mjs without a server, a socket or a browser.

/** What a room remembers of the tutor's screen. Field names match RoomData's. */
export interface MirrorCache {
  mirrorBody: string | null;
  mirrorAttrs: string | null;
  mirrorHead: string | null;
  mirrorHash: string | null;
  /** Which of the tutor's documents this frame came from. */
  mirrorSurface: string | null;
}

/** A frame as it arrives from the source. `head` is sent only when it changed. */
export interface MirrorFrameIn {
  body: string;
  attrs?: string;
  head?: string | null;
  h?: string;
}

/** A frame as it goes out to a student. */
export interface MirrorFrameOut {
  body: string;
  attrs: string | null;
  head: string | null;
  h: string | null;
}

export const EMPTY_MIRROR: MirrorCache = {
  mirrorBody: null,
  mirrorAttrs: null,
  mirrorHead: null,
  mirrorHash: null,
  mirrorSurface: null,
};

/**
 * Which document the class is looking at.
 *
 * Deliberately NOT a function of whiteboardMode. The board carries its own
 * strokes and is nobody's mirror: since 17 Sep 2026 the tutor's relay drops
 * every SYNC_MIRROR while it is up (src/pages/Room.tsx), so no frame is
 * produced during a board trip and none can be filed under the wrong name. The
 * slot goes on holding the lesson's last frame throughout, which is precisely
 * what a student should be handed on the way back — and adding a third key for
 * the board would instead empty the cache on every trip and make the class
 * repaint from nothing each time. The surfaces that genuinely swap the
 * streaming document are the lesson and the explanations.
 */
export function mirrorSurfaceKey(room: { activeExplanationId: string | null }): string {
  return room.activeExplanationId ? `explanation:${room.activeExplanationId}` : 'lesson';
}

/**
 * Fold an incoming frame into the cache.
 *
 * The result is always self-consistent: body, attributes, head CSS and
 * fingerprint all describe the same document, or the fingerprint is dropped.
 */
export function cacheMirrorFrame(cache: MirrorCache, frame: MirrorFrameIn, surface: string): MirrorCache {
  // A different document is streaming now, so nothing carried over from the
  // last one applies to it. The head is the trap here: the source sends head
  // CSS only when it CHANGED, measured against that iframe's own last send, so
  // the lesson's first frame after an explanation closes carries head:null —
  // and the slot used to keep the explanation's stylesheet and hand a late
  // joiner the right content laid out with another document's CSS.
  const base = cache.mirrorSurface === surface ? cache : EMPTY_MIRROR;

  const attrs = typeof frame.attrs === 'string' ? frame.attrs : null;
  const head = typeof frame.head === 'string' ? frame.head : base.mirrorHead;
  // The source's fingerprint covers body + attributes + head together. Keep it
  // only when we hold all three, so that a student who paints this frame and
  // fingerprints what they painted gets the same answer. An incomplete frame is
  // still worth serving — something real on screen beats a blank page — it just
  // travels without a fingerprint, and the heartbeat then tells the student to
  // ask for a whole one.
  const complete = attrs !== null && head !== null;
  return {
    mirrorBody: frame.body,
    mirrorAttrs: attrs,
    mirrorHead: head,
    mirrorHash: complete && typeof frame.h === 'string' ? frame.h : null,
    mirrorSurface: surface,
  };
}

/**
 * What to hand a student asking for a frame right now, or null when the cache
 * has nothing that belongs on their screen.
 *
 * Returning null is the right answer, not a failure: the caller also asks the
 * source for a fresh frame, and a blank half-second is a great deal better than
 * the other document. The student's own agent keeps asking until something
 * paints.
 */
export function servableFrame(cache: MirrorCache, surface: string): MirrorFrameOut | null {
  if (cache.mirrorBody === null) return null;
  if (cache.mirrorSurface !== surface) return null;
  return {
    body: cache.mirrorBody,
    attrs: cache.mirrorAttrs,
    head: cache.mirrorHead,
    h: cache.mirrorHash,
  };
}
