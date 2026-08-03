// The machine-readable shape of a class pack.
//
// The PDF is for a person. This is for the assistant that writes the follow-up
// worksheet, and it exists because that assistant was otherwise OCR-ing images,
// guessing which of sixty near-identical snapshots mattered, and reading pages
// of CSS to find the teaching content.
//
// Everything here is ADDITIVE — nothing downstream breaks if the sidecar is
// absent — and every id is stable across re-exports of the same session so a
// consumer can diff two exports meaningfully.

export const SCHEMA_VERSION = '1.0';

export interface PackParticipant {
  role: 'tutor' | 'student';
  id: string;
  display_name: string;
  /** Null when unknown — there is no booking record to read it from yet. */
  timezone: string | null;
}

export interface PackSession {
  id: string;
  started_at: string;          // ISO 8601 with offset
  duration_s: number;
  room: string;
  subject: string;
  lesson_number: number | null;
  participants: PackParticipant[];
  textbook: { title: string; edition: string | null; note: string | null } | null;
  tutor_intent_before: string | null;
  tutor_note_after: string | null;
}

export interface PackTranscriptLine {
  id: string;                  // t0001, stable by order
  t: number;                   // seconds from session start
  speaker: string;
  role: 'tutor' | 'student' | 'unknown';
  text: string;
  confidence: number | null;
  low_confidence: boolean;
  alternates: string[];
  /** Which surface was on screen when this was said (P0-4, forward link). */
  surface_id: string | null;
}

export type PackEventType =
  | 'control_handed_to_student' | 'control_taken_back'
  | 'surface_changed' | 'narration_started' | 'narration_stopped'
  | 'silence' | 'note';

export interface PackEvent {
  t: number;
  type: PackEventType;
  surface_id?: string;
  /** For 'silence', how long it lasted. */
  duration_s?: number;
  text?: string;
}

export interface PackSurface {
  id: string;                  // wb_1, exp_1, lesson_1
  type: 'whiteboard' | 'explainer' | 'lesson';
  title: string | null;
}

export type SnapshotReason =
  | 'ink_committed' | 'surface_changed' | 'scrolled'
  | 'interactive_answered' | 'periodic' | 'session_end';

export interface PackSnapshot {
  id: string;
  surface_id: string;
  t: number;
  image: string;               // path inside the archive
  reason: SnapshotReason;
  has_new_ink: boolean;
  ink_delta_image: string | null;
  ink_bbox: [number, number, number, number] | null;
  scroll_y: number;
  ocr_text: string | null;     // null: no OCR engine ships with the app
  transcript_window: string[]; // ids of lines spoken around this moment (P0-4)
}

export interface PackMaterial {
  id: string;
  type: 'textbook_page' | 'lesson_page' | 'explainer' | 'image' | 'homework';
  image: string | null;
  source: string;
  shown_from: number;
  shown_to: number | null;
  ocr_text: string | null;
  detected_question_numbers: string[];
  /** For html materials: a pointer to the source kept in the archive. */
  source_ref: string | null;
}

/** A worked example lifted out of an explainer, rather than its raw HTML. */
export interface PackWorkedExample {
  title: string | null;
  steps: string[];
}

export interface PackQuestion {
  question_id: string;
  prompt: string;
  options: string[];
  correct_option_index: number | null;
}

export interface PackOutlineSection {
  heading: string;
  level: number;
  text: string[];
  worked_examples: PackWorkedExample[];
  questions: PackQuestion[];
}

export interface PackExplainerOutline {
  surface_id: string;
  title: string | null;
  sections: PackOutlineSection[];
  source_ref: string | null;
}

export interface PackAttempt {
  t: number;
  by: 'tutor' | 'student';
  option_index: number | null;
  value?: number | string;     // slider / parameter widgets
  correct: boolean | null;
}

export interface PackInteractive {
  surface_id: string;
  widget: string;
  question_id: string;
  prompt: string;
  options: string[];
  correct_option_index: number | null;
  attempts: PackAttempt[];
  final_state: 'correct_first_try' | 'correct_after_retry' | 'incorrect' | 'unanswered';
}

export interface PackCaptureReport {
  board_snapshots_kept: number;
  duplicates_suppressed: number;
  snapshots_with_new_ink: number;
  screens_recorded: number;
  asr_lines_low_confidence: number;
  failures: Array<{ what: string; why: string }>;
}

export interface ClassPackJson {
  schema_version: string;
  generated_at: string;
  session: PackSession;
  transcript: PackTranscriptLine[];
  events: PackEvent[];
  surfaces: PackSurface[];
  snapshots: PackSnapshot[];
  materials: PackMaterial[];
  explainer_outlines: PackExplainerOutline[];
  interactives: PackInteractive[];
  homework: { previous_pack: string | null; submitted: boolean; submissions: string[] };
  capture_report: PackCaptureReport;
}

// ── Validation ──────────────────────────────────────────────────────────────
// Hand-rolled rather than a JSON-schema dependency: the shape is fixed and
// small, and a test that says WHICH field is wrong beats one that says
// "does not validate".

export function validatePack(pack: unknown): string[] {
  const errs: string[] = [];
  const p = pack as ClassPackJson;
  const req = (cond: boolean, msg: string) => { if (!cond) errs.push(msg); };
  const isArr = (v: unknown) => Array.isArray(v);
  const isStr = (v: unknown) => typeof v === 'string';
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const isBool = (v: unknown) => typeof v === 'boolean';
  const nullable = (v: unknown, ok: (x: unknown) => boolean) => v === null || ok(v);

  if (!p || typeof p !== 'object') return ['pack is not an object'];

  req(p.schema_version === SCHEMA_VERSION, `schema_version must be ${SCHEMA_VERSION}`);
  req(isStr(p.generated_at), 'generated_at must be a string');

  const s = p.session;
  req(!!s && typeof s === 'object', 'session missing');
  if (s) {
    req(isStr(s.id) && s.id.length > 0, 'session.id must be a non-empty string');
    req(isStr(s.started_at), 'session.started_at must be a string');
    req(isNum(s.duration_s) && s.duration_s >= 0, 'session.duration_s must be a number');
    req(isStr(s.room), 'session.room must be a string');
    req(isArr(s.participants), 'session.participants must be an array');
    for (const [i, part] of (s.participants || []).entries()) {
      req(part.role === 'tutor' || part.role === 'student', `participants[${i}].role invalid`);
      req(isStr(part.id) && part.id.length > 0, `participants[${i}].id missing`);
      req(isStr(part.display_name), `participants[${i}].display_name missing`);
      req(nullable(part.timezone, isStr), `participants[${i}].timezone must be string or null`);
    }
    req(nullable(s.tutor_intent_before, isStr), 'session.tutor_intent_before must be string or null');
    req(nullable(s.tutor_note_after, isStr), 'session.tutor_note_after must be string or null');
  }

  const surfaceIds = new Set((p.surfaces || []).map(x => x.id));
  req(isArr(p.surfaces), 'surfaces must be an array');
  for (const [i, sf] of (p.surfaces || []).entries()) {
    req(isStr(sf.id) && sf.id.length > 0, `surfaces[${i}].id missing`);
    req(['whiteboard', 'explainer', 'lesson'].includes(sf.type), `surfaces[${i}].type invalid`);
    req(nullable(sf.title, isStr), `surfaces[${i}].title must be string or null`);
  }

  req(isArr(p.transcript), 'transcript must be an array');
  const lineIds = new Set<string>();
  for (const [i, l] of (p.transcript || []).entries()) {
    req(isStr(l.id) && l.id.length > 0, `transcript[${i}].id missing`);
    req(!lineIds.has(l.id), `transcript[${i}].id "${l.id}" is duplicated`);
    lineIds.add(l.id);
    req(isNum(l.t), `transcript[${i}].t must be a number`);
    req(isStr(l.text), `transcript[${i}].text must be a string`);
    req(nullable(l.confidence, isNum), `transcript[${i}].confidence must be number or null`);
    req(isBool(l.low_confidence), `transcript[${i}].low_confidence must be boolean`);
    req(isArr(l.alternates), `transcript[${i}].alternates must be an array`);
    req(nullable(l.surface_id, isStr), `transcript[${i}].surface_id must be string or null`);
    if (l.surface_id) req(surfaceIds.has(l.surface_id), `transcript[${i}].surface_id "${l.surface_id}" is not a known surface`);
  }

  req(isArr(p.snapshots), 'snapshots must be an array');
  const snapIds = new Set<string>();
  for (const [i, sn] of (p.snapshots || []).entries()) {
    req(isStr(sn.id) && sn.id.length > 0, `snapshots[${i}].id missing`);
    req(!snapIds.has(sn.id), `snapshots[${i}].id "${sn.id}" is duplicated`);
    snapIds.add(sn.id);
    req(surfaceIds.has(sn.surface_id), `snapshots[${i}].surface_id "${sn.surface_id}" is not a known surface`);
    req(isNum(sn.t), `snapshots[${i}].t must be a number`);
    req(isStr(sn.image), `snapshots[${i}].image must be a path`);
    req(isBool(sn.has_new_ink), `snapshots[${i}].has_new_ink must be boolean`);
    req(nullable(sn.ink_delta_image, isStr), `snapshots[${i}].ink_delta_image must be string or null`);
    req(sn.ink_bbox === null || (isArr(sn.ink_bbox) && sn.ink_bbox.length === 4), `snapshots[${i}].ink_bbox must be null or 4 numbers`);
    req(nullable(sn.ocr_text, isStr), `snapshots[${i}].ocr_text must be string or null`);
    req(isArr(sn.transcript_window), `snapshots[${i}].transcript_window must be an array`);
    for (const id of sn.transcript_window || []) {
      req(lineIds.has(id), `snapshots[${i}].transcript_window references unknown line "${id}"`);
    }
    // A frame claiming new ink with no evidence of where it is helps nobody.
    if (sn.has_new_ink) req(sn.ink_bbox !== null, `snapshots[${i}] has_new_ink but no ink_bbox`);
  }

  req(isArr(p.interactives), 'interactives must be an array');
  for (const [i, it] of (p.interactives || []).entries()) {
    req(surfaceIds.has(it.surface_id), `interactives[${i}].surface_id "${it.surface_id}" is not a known surface`);
    req(isStr(it.question_id) && it.question_id.length > 0, `interactives[${i}].question_id missing`);
    req(isStr(it.prompt), `interactives[${i}].prompt must be a string`);
    req(isArr(it.options), `interactives[${i}].options must be an array`);
    req(nullable(it.correct_option_index, isNum), `interactives[${i}].correct_option_index must be number or null`);
    req(isArr(it.attempts), `interactives[${i}].attempts must be an array`);
    for (const [j, a] of (it.attempts || []).entries()) {
      req(isNum(a.t), `interactives[${i}].attempts[${j}].t must be a number`);
      req(a.by === 'tutor' || a.by === 'student', `interactives[${i}].attempts[${j}].by invalid`);
      req(nullable(a.correct, isBool), `interactives[${i}].attempts[${j}].correct must be boolean or null`);
    }
    req(['correct_first_try', 'correct_after_retry', 'incorrect', 'unanswered'].includes(it.final_state),
      `interactives[${i}].final_state invalid`);
  }

  req(isArr(p.materials), 'materials must be an array');
  req(isArr(p.explainer_outlines), 'explainer_outlines must be an array');
  req(isArr(p.events), 'events must be an array');

  const cr = p.capture_report;
  req(!!cr, 'capture_report missing');
  if (cr) {
    req(isNum(cr.board_snapshots_kept), 'capture_report.board_snapshots_kept must be a number');
    req(isNum(cr.duplicates_suppressed), 'capture_report.duplicates_suppressed must be a number');
    req(isNum(cr.snapshots_with_new_ink), 'capture_report.snapshots_with_new_ink must be a number');
    req(isNum(cr.asr_lines_low_confidence), 'capture_report.asr_lines_low_confidence must be a number');
    req(isArr(cr.failures), 'capture_report.failures must be an array');
  }

  return errs;
}
