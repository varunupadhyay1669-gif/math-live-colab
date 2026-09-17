// Explanations that stay alive after they are closed.
//
// 15 Sep 2026, from the founder, mid-class: a student had filled in half a
// fractions / decimals / percents worksheet opened as an explanation. The
// teacher closed it to work question 4 through on the whiteboard, opened it
// again, and every answer was gone — the student had to start from the top.
//
// Closing an explanation unmounted its iframe, so opening it again loaded the
// file from scratch: new document, empty inputs, score back to zero. The lesson
// surface had exactly this bug and was fixed on 22 Aug by staying mounted and
// hidden; the explanation is a second surface and never got the same fix.
//
// So each explanation that has been shown keeps its own iframe, hidden rather
// than destroyed, and showing it again brings back the same running document.
// Only a few at a time: every one is a live page with its own timers, and the
// teacher is often on an iPad.
//
// Pure, so the rules below are tested without a browser.

/** How many explanation documents are kept alive at once. */
export const MAX_LIVE_EXPLAINERS = 3;

export interface LiveExplainer {
  /** Which explanation this document is — see explainerKey(). */
  key: string;
  /** The blob: URL the iframe was loaded from. */
  url: string;
  /** When it was last brought forward, in the caller's own ticks. */
  usedAt: number;
}

/**
 * Identify an explanation by what it is, not by how it arrived.
 *
 * Reopening from the tab strip, a reconnect's session_state and a fresh upload
 * of the same file all hand over the same HTML, and must all find the same live
 * document. The seed is part of it on purpose: restarting the lesson changes the
 * seed, and a restart is the one time a fresh document is what the teacher wants.
 *
 * FNV-1a over the whole string: an explanation can be 2 MB, which is a few
 * milliseconds, and this runs when the explanation changes, not per render.
 */
export function explainerKey(html: string, seed: number): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    h ^= html.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${seed}:${html.length}:${(h >>> 0).toString(36)}`;
}

/**
 * Bring one explanation forward, creating its document only if it has none.
 *
 * The list keeps INSERTION order and never reorders the entries that survive.
 * That is not tidiness: React moves a keyed DOM node when its position in a list
 * changes, and a browser reloads an iframe that is moved in the DOM — the very
 * loss this module exists to prevent. New documents are appended; the one
 * evicted is the least recently used, and never the one being brought forward.
 */
export function touchLiveExplainer(
  prev: readonly LiveExplainer[],
  key: string,
  createUrl: () => string,
  tick: number,
  cap: number = MAX_LIVE_EXPLAINERS,
): { next: LiveExplainer[]; created: boolean; evicted: LiveExplainer[] } {
  const found = prev.find(e => e.key === key);
  let next: LiveExplainer[] = found
    ? prev.map(e => (e === found ? { ...e, usedAt: tick } : e))
    : [...prev, { key, url: createUrl(), usedAt: tick }];

  const limit = Math.max(1, Math.floor(cap));
  const evicted: LiveExplainer[] = [];
  while (next.length > limit) {
    let victim: LiveExplainer | null = null;
    for (const e of next) {
      if (e.key === key) continue;
      if (!victim || e.usedAt < victim.usedAt) victim = e;
    }
    if (!victim) break;
    evicted.push(victim);
    const gone = victim;
    next = next.filter(e => e !== gone);
  }
  return { next, created: !found, evicted };
}

/**
 * What the class is looking at. One surface, not two flags.
 *
 * 17 Sep 2026, mid-class: the tutor had a worksheet open as an explanation,
 * tapped Whiteboard to work question 4 through, and the class split in two. His
 * own screen went blank -- the lesson hidden, the explanation hidden, and the
 * board refusing to render because an explanation was still "active" -- while
 * the student carried on watching the worksheet, which was still being streamed
 * live from a document the tutor could not see. Every way out was withdrawn in
 * that state as well: Back to main, the explanation tabs and Exit explanation
 * are all hidden on the whiteboard, so there was no way to reach the board at
 * all. "The student somewhere else, I'm somewhere else."
 *
 * The cause was that "the whiteboard is up" and "an explanation is showing" were
 * two independent booleans, and the two sides broke the tie in opposite
 * directions. So they are one decision now, taken in one place on the server and
 * broadcast in an order that never hands a client both at once.
 */
export interface SurfaceState {
  /** Is the whiteboard the class's surface? */
  whiteboardMode: boolean;
  /** The explanation the class is on, or null for the lesson underneath it. */
  activeExplanationId: string | null;
  /** The explanation the board is holding for them, or null. */
  explanationBeforeWhiteboard: string | null;
}

export interface SurfaceToggle {
  next: SurfaceState;
  /**
   * The explanation to put on the class's screen (or null for none), or
   * undefined to leave what is showing exactly as it is. Distinct from null on
   * purpose: "close it" and "don't touch it" are different instructions.
   */
  showExplanation?: string | null;
}

/**
 * Enter or leave the whiteboard without leaving the class in two places.
 *
 * Entering sets any open explanation aside -- closed as a surface, so both sides
 * and every joiner agree the class is on the board, but NOT discarded: its
 * document stays alive and running in the tutor's tab, which is what keeps the
 * student's half-finished answers (see touchLiveExplainer above). Leaving brings
 * that same one back, so the founder's own journey -- explanation open, onto the
 * board to work question 4 through, come back -- ends where it started.
 *
 * `isKept` answers whether an explanation is still in the room's list, so a file
 * deleted while the board was up is never reopened on the way out.
 *
 * Pure, so the rule is tested without a browser or a socket.
 */
export function whiteboardSurfaceToggle(
  prev: SurfaceState,
  active: boolean,
  isKept: (id: string) => boolean,
): SurfaceToggle {
  if (active) {
    // Re-entering the board (a template load flips it on when it is already on)
    // must not overwrite what the first entry set aside.
    const held = prev.whiteboardMode ? prev.explanationBeforeWhiteboard : prev.activeExplanationId;
    const showing = prev.activeExplanationId !== null;
    return {
      next: { whiteboardMode: true, activeExplanationId: null, explanationBeforeWhiteboard: held },
      ...(showing ? { showExplanation: null } : {}),
    };
  }
  // Only a genuine exit from the board restores. Anything else that turns the
  // flag off -- an upload, which means "show the class this lesson" -- leaves
  // the surface where it put it.
  const back = prev.whiteboardMode ? prev.explanationBeforeWhiteboard : null;
  if (back !== null && isKept(back)) {
    return {
      next: { whiteboardMode: false, activeExplanationId: back, explanationBeforeWhiteboard: null },
      showExplanation: back,
    };
  }
  return {
    next: { whiteboardMode: false, activeExplanationId: prev.activeExplanationId, explanationBeforeWhiteboard: null },
  };
}
