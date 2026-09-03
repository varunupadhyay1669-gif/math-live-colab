// What the product is called, and what it teaches.
//
// PLAN.md task 1.2 (finding C1–C7). The name "MathsLive" and the word "Math"
// are spread through the UI, the exports and the copy — fifteen or so places,
// each of which has to be found and edited by hand to answer a question the
// plan asks seriously: whether a product for "anyone who teaches anything"
// should be called MathsLive at all (QUESTIONS.md Q7, still open).
//
// This does not answer that question. It makes it a one-line change instead of
// an afternoon, and it stops the next feature adding a sixteenth place.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT MUST NEVER BE CONFIGURED FROM HERE, and why. This is the important
// half of the file, because the tempting next step is to route everything
// through it.
//
//   window.mathslive.getState/setState   A contract with every lesson file
//   the id "mathslive-mirror-script"     anyone has already written, published
//   the id "mathslive-ping-style"        in docs/LESSON-CONTRACT.md and pasted
//   the id "mathslive-mirror-head"       into AI prompts. Renaming it breaks
//                                        lessons that exist, on machines we
//                                        cannot reach.
//
//   localStorage / IndexedDB keys        "mathslive_simulation_library",
//                                        "mathlive:templates" and the rest.
//                                        The key IS where a teacher's saved
//                                        work lives; rename it and their
//                                        library is silently empty.
//
//   Socket event names                   A running class has an old client and
//                                        a new server talking to each other
//                                        across a deploy.
//
// Those are wire and storage contracts that happen to contain a brand name.
// What follows is display text and content taxonomy — the things a person
// reads.
// ─────────────────────────────────────────────────────────────────────────

export interface ProductConfig {
  /** The wordmark, and the name in every sentence the product writes. */
  name: string;
  /** Split for the two-tone wordmark: name === brandLead + brandTail. */
  brandLead: string;
  brandTail: string;
  /** One line, used where the product introduces itself. */
  tagline: string;
  /** The public address, for links inside exports. */
  siteUrl: string;
  /**
   * The subject list a teacher tags a lesson with.
   *
   * Maths-only today because the library that ships is maths (PLAN.md C6 adds
   * the rest). "Other" stays last and stays present: a taxonomy with no escape
   * hatch makes people pick the wrong thing rather than the right one.
   */
  subjects: readonly string[];
  /** Used when nothing better is known — never in place of a real answer. */
  defaultSubject: string;
  /** Money, for the pages that quote a price without asking the server. */
  currency: { code: string; symbol: string };
  /**
   * Where "today" is decided for daily mail.
   *
   * The server's clock is UTC and every teacher so far is in India, so asking
   * "has today's mail gone?" in UTC flips the answer at half past five in the
   * morning. Per-teacher time zones are Phase 2 (`users.timezone`); this is
   * the default until a teacher has one.
   */
  defaultTimezone: string;
}

export const PRODUCT: ProductConfig = {
  name: 'MathsLive',
  brandLead: 'Maths',
  brandTail: 'Live',
  tagline: 'Interactive Teaching Platform',
  siteUrl: 'https://mathslive.matheinstein.com',
  subjects: ['Algebra', 'Geometry', 'Calculus', 'Fractions', 'Probability', 'Trigonometry', 'Statistics', 'Other'],
  defaultSubject: 'Math',
  currency: { code: 'INR', symbol: '₹' },
  defaultTimezone: 'Asia/Kolkata',
};

/**
 * The subject to record for a lesson.
 *
 * A class's `label` is what a teacher typed to describe what they teach that
 * student ("Algebra", "Year 8 revision"), and it is what the admin screen
 * already shows in a column headed Subject. Both class-pack exporters used to
 * write the literal 'Math' regardless — so every pack claimed the same
 * subject, including a pack from a lesson that was not maths at all.
 */
export function subjectFor(classLabel?: string | null): string {
  const label = (classLabel || '').trim();
  return label || PRODUCT.defaultSubject;
}
