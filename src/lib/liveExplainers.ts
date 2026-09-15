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
