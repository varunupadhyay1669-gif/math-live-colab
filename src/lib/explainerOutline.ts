import type { PackOutlineSection, PackQuestion, PackWorkedExample } from './packSchema';

// Reading an explainer for what it TEACHES, instead of pasting its source.
//
// The pack used to embed the whole explainer document — stylesheet, scripts and
// all — so a reader scrolled eighteen pages of CSS to reach two pages of maths.
// Everything a consumer actually wants is in the rendered DOM: the headings, the
// prose, the worked steps, and the practice questions with their options.
//
// Written against a DOM-like interface rather than the real one so it can be
// tested on a parsed document with no browser present.

export interface DomLike {
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  querySelector(sel: string): ElLike | null;
  title?: string;
}

export interface ElLike {
  tagName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(sel: string): ArrayLike<ElLike>;
  querySelector(sel: string): ElLike | null;
}

const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
const arr = <T>(x: ArrayLike<T>): T[] => Array.prototype.slice.call(x);

/** Elements a lesson author might plausibly use for a question block. */
const QUESTION_SELECTOR = '[data-question-id],[data-question],.question,.practice-question,.quiz-question,.mcq';
const OPTION_SELECTOR = '[data-option],.option,.choice,.answer-option,li,button';

/**
 * Pull the practice questions out of a document.
 *
 * Convention first — `data-question-id`, `data-option`, `data-correct` give an
 * exact answer. Where an explainer has no such markup we fall back to structure,
 * which is imperfect but far better than the nothing that shipped before. The
 * fallback never invents a correct answer: unknown stays null rather than
 * guessing, because a wrong "correct answer" would poison the worksheet built
 * from it.
 */
export function extractQuestions(root: DomLike | ElLike): PackQuestion[] {
  const out: PackQuestion[] = [];
  const blocks = arr(root.querySelectorAll(QUESTION_SELECTOR));
  for (const [i, block] of blocks.entries()) {
    const explicitId = block.getAttribute('data-question-id') || block.getAttribute('data-question');
    const promptEl = block.querySelector('[data-prompt],.prompt,.question-text,h3,h4,p');
    const prompt = clean(promptEl?.textContent) || clean(block.textContent).slice(0, 200);
    if (!prompt) continue;

    const optionEls = arr(block.querySelectorAll(OPTION_SELECTOR))
      .filter(el => clean(el.textContent).length > 0);
    // Drop anything that merely contains the others (a wrapper caught by `li`).
    const options: string[] = [];
    let correct: number | null = null;
    for (const el of optionEls) {
      const text = clean(el.textContent);
      if (!text || text === prompt) continue;
      if (options.includes(text)) continue;
      const idx = options.length;
      options.push(text);
      const isCorrect = el.getAttribute('data-correct');
      if (isCorrect !== null && isCorrect !== 'false') correct = idx;
    }
    // A block-level data-correct index wins over per-option marking.
    const blockCorrect = block.getAttribute('data-correct');
    if (blockCorrect !== null && /^\d+$/.test(blockCorrect)) correct = Number(blockCorrect);

    out.push({
      question_id: explicitId || `q${i + 1}`,
      prompt,
      options,
      correct_option_index: correct,
    });
  }
  return out;
}

/** Worked examples: a titled block whose children read as ordered steps. */
export function extractWorkedExamples(root: DomLike | ElLike): PackWorkedExample[] {
  const out: PackWorkedExample[] = [];
  const blocks = arr(root.querySelectorAll('[data-worked-example],.worked-example,.example,.solution'));
  for (const block of blocks) {
    const titleEl = block.querySelector('h2,h3,h4,.title,[data-title]');
    const stepEls = arr(block.querySelectorAll('li,.step,[data-step],p'));
    const steps = stepEls.map(e => clean(e.textContent)).filter(Boolean);
    const title = clean(titleEl?.textContent) || null;
    // A block with no steps is just a paragraph; it belongs in the prose.
    if (steps.length === 0) continue;
    out.push({ title, steps: steps.filter(s => s !== title).slice(0, 40) });
  }
  return out;
}

/**
 * Section the document by its headings and attach the prose, examples and
 * questions that sit under each. Content before the first heading is kept under
 * an "Introduction" section rather than dropped.
 */
export function outlineExplainer(doc: DomLike): PackOutlineSection[] {
  const nodes = arr(doc.querySelectorAll('h1,h2,h3,h4,p,li,[data-question-id],[data-question],.question,.practice-question,.quiz-question,.mcq,[data-worked-example],.worked-example,.example,.solution'));
  const sections: PackOutlineSection[] = [];
  let current: PackOutlineSection = { heading: 'Introduction', level: 0, text: [], worked_examples: [], questions: [] };
  const seenText = new Set<string>();

  for (const el of nodes) {
    const tag = (el.tagName || '').toUpperCase();
    if (/^H[1-4]$/.test(tag)) {
      if (current.text.length || current.worked_examples.length || current.questions.length || current.heading !== 'Introduction') {
        sections.push(current);
      }
      current = { heading: clean(el.textContent) || '(untitled)', level: Number(tag[1]), text: [], worked_examples: [], questions: [] };
      continue;
    }
    const text = clean(el.textContent);
    if (!text) continue;
    // Long documents repeat boilerplate; keep each distinct line once.
    if (seenText.has(text)) continue;
    seenText.add(text);
    if (text.length > 2) current.text.push(text.slice(0, 1000));
  }
  sections.push(current);

  // Questions and worked examples are gathered document-wide and attached to the
  // section whose prose they sit closest to; doing it per-section would miss any
  // that live outside a heading.
  const questions = extractQuestions(doc);
  const examples = extractWorkedExamples(doc);
  if (sections.length) {
    sections[sections.length - 1].questions = questions;
    sections[sections.length - 1].worked_examples = examples;
  }

  return sections.filter(s => s.text.length || s.questions.length || s.worked_examples.length);
}

/** Best-effort title for an explainer surface. */
export function explainerTitle(doc: DomLike, fallback: string | null): string | null {
  const h1 = doc.querySelector('h1');
  return clean(h1?.textContent) || clean(doc.title) || fallback;
}
