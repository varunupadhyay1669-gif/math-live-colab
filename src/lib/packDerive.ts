// Things the pack can work out about itself, without a model.
//
// Everything here is DERIVED and labelled as such. It reads raw capture and
// writes new fields beside it; it never edits transcript text, snapshot images,
// or event timings. The rule throughout: say what the evidence supports, name
// the evidence, and say "unclear" the rest of the time.
//
// The LLM pass lives in packLlm.ts. This file is what still works with no API
// key, no network, and no budget — which, today, is the only configuration
// that exists.
import type { PackEvent, PackSnapshot, PackTranscriptLine } from './packSchema';

// ── 1.3 Silence classification ─────────────────────────────────────────────

/**
 * Work out whether the board was being used during each silence.
 *
 * A 413-second silence in a maths lesson is either "the student is working" or
 * "nothing happened, and seven minutes of the class are missing". Those are
 * opposite readings of the same gap, and a downstream agent currently has no
 * way to tell them apart. Joining snapshot timestamps into the window answers
 * it from data already in the pack.
 *
 * Deliberately does NOT say who was drawing. The pack has no authorship yet;
 * claiming the student wrote something would be a guess wearing a fact's
 * clothes. Authorship arrives with the stroke log.
 */
export function classifySilences(events: PackEvent[], snapshots: PackSnapshot[]): PackEvent[] {
  return events.map(e => {
    if (e.type !== 'silence') return e;
    const from = e.t;
    const to = e.t + (e.duration_s ?? 0);
    // has_new_ink, not merely "a frame exists": a periodic snapshot of an
    // unchanged board during a silence is evidence of nothing happening.
    const during = snapshots
      .filter(s => s.t >= from && s.t <= to && s.has_new_ink)
      .map(s => s.id);
    return {
      ...e,
      board_activity: during.length > 0 ? 'active' as const : 'inactive' as const,
      ink_snapshots_during: during,
    };
  });
}

// ── 1.5 Honest ASR confidence ──────────────────────────────────────────────

/**
 * Words a maths transcript should never contain, which the recogniser produces
 * when it is guessing at a number. "Timestan" for "times ten" is the shape.
 */
const NON_WORDS = /\b(timestan|timesten|carryed|pointo|equalto|minuse|divideby)\b/i;

/**
 * Digit soup: four or more separate number tokens in one short line, which is
 * what "084-3223 carry 83 16 17 1917" looks like to a machine. Real spoken
 * maths says one or two numbers at a time.
 */
function digitDensity(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const numbers = words.filter(w => /\d/.test(w)).length;
  return numbers / words.length;
}

/**
 * Why this line is suspect, if it is.
 *
 * A flag is an invitation to check, never a claim about what was said. The
 * text is left exactly as the engine produced it — correcting it belongs to
 * the cleanup pass, which has board context to corroborate against.
 */
export function flagsFor(text: string): string[] {
  const flags: string[] = [];
  const words = text.trim().split(/\s+/).filter(Boolean);

  const numberTokens = words.filter(w => /\d/.test(w));
  if (numberTokens.length >= 4 && digitDensity(text) > 0.45) flags.push('number_garble');
  // A single token carrying a long unbroken run of digits is almost always the
  // recogniser jamming several spoken numbers together.
  if (words.some(w => /\d{5,}/.test(w))) flags.push('number_garble');
  if (NON_WORDS.test(text)) flags.push('non_word');
  if (words.length <= 2 && numberTokens.length > 0) flags.push('fragment');

  return [...new Set(flags)];
}

export interface AsrConfidenceSummary {
  /** True only if the engine actually gave us numbers for at least one line. */
  available: boolean;
  /**
   * Lines a reader should treat with suspicion — counted from real confidence
   * where we have it, and from heuristic flags where we do not. Never zero
   * just because nothing was measured.
   */
  lowConfidenceCount: number;
}

export function summariseAsrConfidence(lines: PackTranscriptLine[]): AsrConfidenceSummary {
  const available = lines.some(l => typeof l.confidence === 'number');
  if (available) {
    return { available: true, lowConfidenceCount: lines.filter(l => l.low_confidence).length };
  }
  return {
    available: false,
    lowConfidenceCount: lines.filter(l => (l.flags?.length ?? 0) > 0).length,
  };
}
