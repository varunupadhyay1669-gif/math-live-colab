import type { PackInteractive, PackAttempt } from './packSchema';
import { extractQuestions } from './explainerOutline';
import type { DomLike, ElLike } from './explainerOutline';

// Which option the student actually clicked.
//
// This is the single most valuable thing the pack was missing: direct evidence
// of what the student knows. The export showed the PIXELS of a multiple-choice
// widget and never which answer was chosen, so a worksheet built from the pack
// was guessing at the very thing it should target.
//
// Two facts about this app make it cheap:
//   - explainers are same-origin iframes, so one delegated listener sees every
//     click without touching the explainer templates;
//   - under Live Mirror the student never runs lesson JS — their clicks are
//     forwarded and REPLAYED inside the tutor's iframe. So the tutor's page sees
//     both people's answers, and attribution has to come from knowing a
//     forwarded input just arrived, not from the DOM event.

const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
const arr = <T>(x: ArrayLike<T>): T[] => Array.prototype.slice.call(x);

export interface RecordedAttempt {
  questionId: string;
  prompt: string;
  options: string[];
  correctIndex: number | null;
  optionIndex: number | null;
  value?: number | string;
  correct: boolean | null;
  widget: string;
  by: 'tutor' | 'student';
  t: number;
}

/** Walk up from the clicked node to the question block that owns it. */
export function closestQuestionBlock(el: ElLike | null, maxHops = 8): ElLike | null {
  let node: any = el;
  for (let i = 0; i < maxHops && node; i++) {
    const has = node.getAttribute && (
      node.getAttribute('data-question-id') || node.getAttribute('data-question')
    );
    const cls = (node.className && String(node.className)) || '';
    if (has || /\b(question|practice-question|quiz-question|mcq|trap-or-truth)\b/.test(cls)) return node as ElLike;
    node = node.parentElement;
  }
  return null;
}

/**
 * Did the page mark this answer right or wrong?
 *
 * Read AFTER the explainer's own click handler has run, so the classes it adds
 * are already there. Returns null when the page says nothing — an unknown result
 * is recorded honestly rather than assumed wrong, because a worksheet built on a
 * false "she got this wrong" is worse than one built on a gap.
 */
export function readCorrectness(optionEl: ElLike | null, block: ElLike | null): boolean | null {
  const check = (el: ElLike | null, allowAttr: boolean): boolean | null => {
    if (!el) return null;
    if (allowAttr) {
      const attr = el.getAttribute('data-correct');
      // A NUMBER here is an index ("option 2 is the right one"), not a verdict
      // on this click. Reading it as a boolean marked every answer on such a
      // question correct — including wrong ones, in the pack a worksheet is
      // then built from.
      if (attr !== null && !/^\d+$/.test(attr.trim())) return attr !== 'false';
    }
    const cls = ((el as any).className && String((el as any).className)) || '';
    if (/\b(correct|right|is-correct|success)\b/.test(cls)) return true;
    if (/\b(incorrect|wrong|is-wrong|error|fail)\b/.test(cls)) return false;
    return null;
  };
  // On the option, data-correct is a verdict. On the block it is an index, so
  // only its classes are consulted there.
  return check(optionEl, true) ?? check(block, false);
}

/** Index of the clicked option within its question block. */
export function optionIndexOf(block: ElLike, optionEl: ElLike): { index: number | null; options: string[] } {
  const candidates = arr(block.querySelectorAll('[data-option],.option,.choice,.answer-option,li,button'))
    .filter(e => clean(e.textContent).length > 0);
  const options: string[] = [];
  let index: number | null = null;
  for (const el of candidates) {
    const text = clean(el.textContent);
    if (!text || options.includes(text)) continue;
    if (el === optionEl) index = options.length;
    options.push(text);
  }
  // The click may have landed on a child of the option (a <span> inside a
  // button); fall back to matching on text.
  if (index === null) {
    const text = clean(optionEl.textContent);
    const at = options.indexOf(text);
    if (at >= 0) index = at;
  }
  return { index, options };
}

/**
 * Fold a stream of attempts into one record per question.
 *
 * final_state is what a consumer reads first: whether she got it, and whether it
 * took her more than one go. "Correct after retry" is a different teaching
 * signal from "correct first try", and both differ from never answering.
 */
export function summariseInteractives(
  attempts: RecordedAttempt[],
  surfaceId: string,
  known: PackInteractive[] = [],
): PackInteractive[] {
  const byId = new Map<string, PackInteractive>();
  for (const k of known) byId.set(k.question_id, { ...k, attempts: [...k.attempts] });

  for (const a of attempts) {
    let rec = byId.get(a.questionId);
    if (!rec) {
      rec = {
        surface_id: surfaceId,
        widget: a.widget || 'multiple_choice',
        question_id: a.questionId,
        prompt: a.prompt,
        options: a.options,
        correct_option_index: a.correctIndex,
        attempts: [],
        final_state: 'unanswered',
      };
      byId.set(a.questionId, rec);
    }
    // Later knowledge wins: the page may only reveal the right answer after the
    // first wrong guess.
    if (rec.correct_option_index === null && a.correctIndex !== null) rec.correct_option_index = a.correctIndex;
    if (!rec.prompt && a.prompt) rec.prompt = a.prompt;
    if (rec.options.length === 0 && a.options.length) rec.options = a.options;

    const attempt: PackAttempt = { t: a.t, by: a.by, option_index: a.optionIndex, correct: a.correct };
    if (a.value !== undefined) attempt.value = a.value;
    rec.attempts.push(attempt);
  }

  for (const rec of byId.values()) {
    rec.final_state = finalState(rec);
  }
  return [...byId.values()];
}

function finalState(rec: PackInteractive): PackInteractive['final_state'] {
  const answers = rec.attempts.filter(a => a.option_index !== null || a.value !== undefined);
  if (answers.length === 0) return 'unanswered';
  const resolved = answers.map(a => {
    if (a.correct !== null) return a.correct;
    // No verdict from the page — infer from the known answer if we have one.
    if (rec.correct_option_index !== null && a.option_index !== null) return a.option_index === rec.correct_option_index;
    return null;
  });
  const last = resolved[resolved.length - 1];
  if (last === true) return resolved.length === 1 ? 'correct_first_try' : 'correct_after_retry';
  if (last === false) return 'incorrect';
  return 'unanswered';
}

/** Questions present on a surface but never attempted still belong in the pack. */
export function withUnattempted(doc: DomLike, surfaceId: string, existing: PackInteractive[]): PackInteractive[] {
  const seen = new Set(existing.map(e => e.question_id));
  const out = [...existing];
  for (const q of extractQuestions(doc)) {
    if (seen.has(q.question_id)) continue;
    out.push({
      surface_id: surfaceId,
      widget: 'multiple_choice',
      question_id: q.question_id,
      prompt: q.prompt,
      options: q.options,
      correct_option_index: q.correct_option_index,
      attempts: [],
      final_state: 'unanswered',
    });
  }
  return out;
}
