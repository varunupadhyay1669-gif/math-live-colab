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

export const SCHEMA_VERSION = '1.2';

/**
 * Any 1.x pack is valid. New fields in a minor version are optional additions,
 * so a pack written by an older exporter is still readable — and rejecting one
 * would mean a tutor's file from last month stopped validating just because the
 * app moved on. A major bump is what signals a real break.
 */
export function versionAccepted(v: unknown): boolean {
  return typeof v === 'string' && /^1\.\d+$/.test(v);
}

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
  /**
   * What the tutor holds in their head between lessons, from the student's
   * dashboard: which class they're in, the level they work at, what they're
   * working towards. A pack without it describes an hour with an anonymous
   * learner; with it, a worksheet built from the pack is pitched right.
   * Null when this room has no student record, or the tutor left it blank.
   */
  student_profile: { grade: string | null; level: string | null; goals: string[] } | null;
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
  /**
   * 1.2 — why a line is suspect when the engine gives us no number.
   * e.g. "number_garble" for digit-density anomalies. Heuristic, and labelled
   * as such: a flag is a reason to look, never a claim about what was said.
   */
  flags?: string[];
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
  /**
   * 1.2 — for 'silence': was the board being worked on while nobody spoke?
   * Derived by joining snapshot timestamps into the silence window. It says
   * the board changed, NOT who changed it — authorship arrives in Phase 3.
   */
  board_activity?: 'active' | 'inactive';
  /** 1.2 — snapshot ids falling inside this silence. Evidence for the above. */
  ink_snapshots_during?: string[];
}

export interface PackSurface {
  id: string;                  // wb_1, exp_1, lesson_1
  type: 'whiteboard' | 'explainer' | 'lesson';
  title: string | null;
}

export type SnapshotReason =
  | 'ink_committed' | 'surface_changed' | 'scrolled'
  | 'interactive_answered' | 'periodic' | 'session_end'
  /** 1.2 — the baseline frame taken when capture arms, so t=0 is not a blank. */
  | 'session_start';

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
  /** 1.2 — materials visible in this frame. */
  material_ids?: string[];
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
  /** 1.2 — when it appeared, and where it came from. */
  t_added?: number;
  surface_id?: string;
  bbox?: [number, number, number, number] | null;
  origin?: 'paste' | 'file' | 'url';
  /** 1.2 — content hash, so the same picture pasted twice is one material. */
  sha256?: string;
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

// ── 1.2: the derive block ───────────────────────────────────────────────────
//
// Everything under `derived` is MACHINE-WRITTEN and says so. It never
// overwrites raw data — transcript, events and snapshots are untouched — and
// every claim carries pointers back into them, so a downstream agent can
// disbelieve any single statement and go check.

export interface DerivedEvidence {
  transcript_ids: string[];
  snapshot_ids: string[];
}

export interface DerivedSegment {
  id: string;
  t_start: number;
  t_end: number;
  label: string;
  description: string;
}

export interface DerivedResponse {
  t_approx: number;
  answer: string;
  verdict: 'correct' | 'incorrect' | 'unclear';
  evidence: DerivedEvidence;
}

export interface DerivedAttempt {
  id: string;
  segment_id: string;
  question: { text: string; material_id?: string; first_seen_t: number };
  responses: DerivedResponse[];
  resolution: { final_answer?: string; how: 'independent' | 'tutor_led' | 'unresolved' };
  confidence: 'high' | 'medium' | 'low';
}

export interface DerivedErrorPattern {
  id: string;
  pattern: string;
  example_attempt_ids: string[];
  evidence: DerivedEvidence;
  confidence: 'high' | 'medium' | 'low';
}

export interface PackDerived {
  generated_at: string;
  /** The model that wrote this, so a reader can weigh it. */
  generator: string;
  prompt_version: string;
  segments: DerivedSegment[];
  attempts: DerivedAttempt[];
  error_patterns: DerivedErrorPattern[];
  /** The board that matters: final state per problem. Capped at 10. */
  key_frames: string[];
}

export interface PackCaptureReport {
  board_snapshots_kept: number;
  duplicates_suppressed: number;
  snapshots_with_new_ink: number;
  screens_recorded: number;
  asr_lines_low_confidence: number;
  /**
   * 1.2 — whether the engine gave us confidence numbers at all.
   *
   * When false, asr_lines_low_confidence is counted from heuristic flags
   * instead, and the reader is told so rather than being handed a zero that
   * means "we never looked". A lying zero is worse than an honest absence.
   */
  asr_confidence_available?: boolean;
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
  homework: {
    previous_pack: string | null;
    submitted: boolean;
    submissions: string[];
    /** 1.2 — what was set for next time, in the tutor's own words. */
    assigned?: { text: string | null; material_id?: string | null; item_range?: string | null } | null;
  };
  capture_report: PackCaptureReport;
  /** 1.2 — machine-written reading of the lesson. Absent if no model ran. */
  derived?: PackDerived;
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
  // Iterate only what is actually iterable. `(x || [])` looks safe and isn't:
  // a string or an object passes the || and then has no .entries(), so a
  // malformed pack made the validator THROW instead of reporting the fault —
  // exactly backwards for the one caller that matters, the one checking a file
  // it did not write. The isArr() check above each loop still records the error.
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

  if (!p || typeof p !== 'object') return ['pack is not an object'];

  req(versionAccepted(p.schema_version), `schema_version must be 1.x (current ${SCHEMA_VERSION})`);
  req(isStr(p.generated_at), 'generated_at must be a string');

  const s = p.session;
  req(!!s && typeof s === 'object', 'session missing');
  if (s) {
    req(isStr(s.id) && s.id.length > 0, 'session.id must be a non-empty string');
    req(isStr(s.started_at), 'session.started_at must be a string');
    req(isNum(s.duration_s) && s.duration_s >= 0, 'session.duration_s must be a number');
    req(isStr(s.room), 'session.room must be a string');
    req(isArr(s.participants), 'session.participants must be an array');
    for (const [i, part] of list<any>(s.participants).entries()) {
      req(part.role === 'tutor' || part.role === 'student', `participants[${i}].role invalid`);
      req(isStr(part.id) && part.id.length > 0, `participants[${i}].id missing`);
      req(isStr(part.display_name), `participants[${i}].display_name missing`);
      req(nullable(part.timezone, isStr), `participants[${i}].timezone must be string or null`);
    }
    req(nullable(s.tutor_intent_before, isStr), 'session.tutor_intent_before must be string or null');
    req(nullable(s.tutor_note_after, isStr), 'session.tutor_note_after must be string or null');
    if (s.textbook !== null && s.textbook !== undefined) {
      req(isStr(s.textbook.title) && s.textbook.title.length > 0, 'session.textbook.title must be a non-empty string');
      req(nullable(s.textbook.edition, isStr), 'session.textbook.edition must be string or null');
      req(nullable(s.textbook.note, isStr), 'session.textbook.note must be string or null');
    }
    // Additive: a pack written before this field existed simply omits it, and
    // that must not be an error. Only a PRESENT profile is checked.
    if (s.student_profile !== null && s.student_profile !== undefined) {
      req(nullable(s.student_profile.grade, isStr), 'session.student_profile.grade must be string or null');
      req(nullable(s.student_profile.level, isStr), 'session.student_profile.level must be string or null');
      // Guarded rather than chained: a validator that THROWS on a malformed
      // pack is useless to the one caller that matters — the one checking a
      // file it did not write. Report the fault, never raise it.
      req(isArr(s.student_profile.goals), 'session.student_profile.goals must be an array');
      if (isArr(s.student_profile.goals)) {
        req(s.student_profile.goals.every(isStr), 'session.student_profile.goals must all be strings');
      }
    }
  }

  const surfaceIds = new Set(list<any>(p.surfaces).map(x => x.id));
  req(isArr(p.surfaces), 'surfaces must be an array');
  for (const [i, sf] of list<any>(p.surfaces).entries()) {
    req(isStr(sf.id) && sf.id.length > 0, `surfaces[${i}].id missing`);
    req(['whiteboard', 'explainer', 'lesson'].includes(sf.type), `surfaces[${i}].type invalid`);
    req(nullable(sf.title, isStr), `surfaces[${i}].title must be string or null`);
  }

  req(isArr(p.transcript), 'transcript must be an array');
  const lineIds = new Set<string>();
  for (const [i, l] of list<any>(p.transcript).entries()) {
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
  for (const [i, sn] of list<any>(p.snapshots).entries()) {
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
    for (const id of list<any>(sn.transcript_window)) {
      req(lineIds.has(id), `snapshots[${i}].transcript_window references unknown line "${id}"`);
    }
    // A frame claiming new ink with no evidence of where it is helps nobody.
    if (sn.has_new_ink) req(sn.ink_bbox !== null, `snapshots[${i}] has_new_ink but no ink_bbox`);
  }

  req(isArr(p.interactives), 'interactives must be an array');
  for (const [i, it] of list<any>(p.interactives).entries()) {
    req(surfaceIds.has(it.surface_id), `interactives[${i}].surface_id "${it.surface_id}" is not a known surface`);
    req(isStr(it.question_id) && it.question_id.length > 0, `interactives[${i}].question_id missing`);
    req(isStr(it.prompt), `interactives[${i}].prompt must be a string`);
    req(isArr(it.options), `interactives[${i}].options must be an array`);
    req(nullable(it.correct_option_index, isNum), `interactives[${i}].correct_option_index must be number or null`);
    req(isArr(it.attempts), `interactives[${i}].attempts must be an array`);
    for (const [j, a] of list<any>(it.attempts).entries()) {
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

  // ── 1.2 invariants ────────────────────────────────────────────────────────
  // These are what make the pack trustworthy rather than merely well-formed.

  for (const [i, e] of list<any>(p.events).entries()) {
    if (e.board_activity !== undefined) {
      req(e.board_activity === 'active' || e.board_activity === 'inactive',
        `events[${i}].board_activity must be "active" or "inactive"`);
    }
    if (e.ink_snapshots_during !== undefined) {
      req(isArr(e.ink_snapshots_during), `events[${i}].ink_snapshots_during must be an array`);
      for (const id of list<any>(e.ink_snapshots_during)) {
        req(snapIds.has(id), `events[${i}].ink_snapshots_during references unknown snapshot "${id}"`);
      }
      // Saying the board was active while naming no frame is an unevidenced
      // claim, which is the one thing this pack must not contain.
      if (e.board_activity === 'active') {
        req(list<any>(e.ink_snapshots_during).length > 0,
          `events[${i}] claims board_activity "active" but lists no snapshots`);
      }
    }
  }

  const materialIds = new Set(list<any>(p.materials).map(m => m.id));
  for (const [i, m] of list<any>(p.materials).entries()) {
    if (m.origin !== undefined) {
      req(['paste', 'file', 'url'].includes(m.origin), `materials[${i}].origin invalid`);
    }
    if (m.t_added !== undefined) req(isNum(m.t_added), `materials[${i}].t_added must be a number`);
    if (m.sha256 !== undefined) req(isStr(m.sha256), `materials[${i}].sha256 must be a string`);
    if (m.surface_id !== undefined && m.surface_id !== null) {
      req(surfaceIds.has(m.surface_id), `materials[${i}].surface_id "${m.surface_id}" is not a known surface`);
    }
  }

  for (const [i, sn] of list<any>(p.snapshots).entries()) {
    if (sn.material_ids !== undefined) {
      req(isArr(sn.material_ids), `snapshots[${i}].material_ids must be an array`);
      for (const id of list<any>(sn.material_ids)) {
        req(materialIds.has(id), `snapshots[${i}].material_ids references unknown material "${id}"`);
      }
    }
  }

  for (const [i, l] of list<any>(p.transcript).entries()) {
    if (l.flags !== undefined) {
      req(isArr(l.flags) && list<any>(l.flags).every(isStr), `transcript[${i}].flags must be strings`);
    }
  }

  const d = p.derived;
  if (d !== undefined && d !== null) {
    req(isStr(d.generated_at), 'derived.generated_at must be a string');
    req(isStr(d.generator) && d.generator.length > 0, 'derived.generator must name the model that wrote it');
    req(isStr(d.prompt_version), 'derived.prompt_version must be a string');

    req(isArr(d.segments), 'derived.segments must be an array');
    const segIds = new Set(list<any>(d.segments).map(x => x.id));
    for (const [i, seg] of list<any>(d.segments).entries()) {
      req(isStr(seg.id) && seg.id.length > 0, `derived.segments[${i}].id missing`);
      req(isNum(seg.t_start) && isNum(seg.t_end), `derived.segments[${i}] needs numeric t_start/t_end`);
      req(seg.t_end >= seg.t_start, `derived.segments[${i}] ends before it starts`);
      req(isStr(seg.label), `derived.segments[${i}].label must be a string`);
    }

    // The contract that makes any of this worth reading: every claim points at
    // something a reader can go and check, and every pointer resolves.
    const checkEvidence = (ev: any, where: string) => {
      req(!!ev && typeof ev === 'object', `${where}.evidence missing`);
      if (!ev) return;
      req(isArr(ev.transcript_ids), `${where}.evidence.transcript_ids must be an array`);
      req(isArr(ev.snapshot_ids), `${where}.evidence.snapshot_ids must be an array`);
      for (const id of list<any>(ev.transcript_ids)) {
        req(lineIds.has(id), `${where} cites transcript line "${id}", which is not in this pack`);
      }
      for (const id of list<any>(ev.snapshot_ids)) {
        req(snapIds.has(id), `${where} cites snapshot "${id}", which is not in this pack`);
      }
      req(list<any>(ev.transcript_ids).length + list<any>(ev.snapshot_ids).length > 0,
        `${where} makes a claim with no evidence at all`);
    };

    req(isArr(d.attempts), 'derived.attempts must be an array');
    const attemptIds = new Set(list<any>(d.attempts).map(x => x.id));
    for (const [i, a] of list<any>(d.attempts).entries()) {
      req(isStr(a.id) && a.id.length > 0, `derived.attempts[${i}].id missing`);
      req(segIds.has(a.segment_id), `derived.attempts[${i}].segment_id "${a.segment_id}" is not a known segment`);
      req(!!a.question && isStr(a.question.text), `derived.attempts[${i}].question.text missing`);
      if (a.question?.material_id) {
        req(materialIds.has(a.question.material_id),
          `derived.attempts[${i}].question.material_id "${a.question.material_id}" is not a known material`);
      }
      req(isArr(a.responses), `derived.attempts[${i}].responses must be an array`);
      for (const [j, r] of list<any>(a.responses).entries()) {
        req(['correct', 'incorrect', 'unclear'].includes(r.verdict),
          `derived.attempts[${i}].responses[${j}].verdict invalid`);
        checkEvidence(r.evidence, `derived.attempts[${i}].responses[${j}]`);
      }
      req(['independent', 'tutor_led', 'unresolved'].includes(a.resolution?.how),
        `derived.attempts[${i}].resolution.how invalid`);
      req(['high', 'medium', 'low'].includes(a.confidence), `derived.attempts[${i}].confidence invalid`);
    }

    req(isArr(d.error_patterns), 'derived.error_patterns must be an array');
    for (const [i, ep] of list<any>(d.error_patterns).entries()) {
      req(isStr(ep.pattern) && ep.pattern.length > 0, `derived.error_patterns[${i}].pattern missing`);
      for (const id of list<any>(ep.example_attempt_ids)) {
        req(attemptIds.has(id), `derived.error_patterns[${i}] cites unknown attempt "${id}"`);
      }
      checkEvidence(ep.evidence, `derived.error_patterns[${i}]`);
      req(['high', 'medium', 'low'].includes(ep.confidence), `derived.error_patterns[${i}].confidence invalid`);
    }

    req(isArr(d.key_frames), 'derived.key_frames must be an array');
    // Capped because the point of key_frames is to be the SHORT list. An
    // unbounded one is just the snapshot array again, and helps nobody.
    req(list<any>(d.key_frames).length <= 10,
      `derived.key_frames must be 10 or fewer (got ${list<any>(d.key_frames).length})`);
    for (const id of list<any>(d.key_frames)) {
      req(snapIds.has(id), `derived.key_frames references unknown snapshot "${id}"`);
    }
  }

  const cr = p.capture_report;
  req(!!cr, 'capture_report missing');
  if (cr) {
    req(isNum(cr.board_snapshots_kept), 'capture_report.board_snapshots_kept must be a number');
    req(isNum(cr.duplicates_suppressed), 'capture_report.duplicates_suppressed must be a number');
    req(isNum(cr.snapshots_with_new_ink), 'capture_report.snapshots_with_new_ink must be a number');
    req(isNum(cr.asr_lines_low_confidence), 'capture_report.asr_lines_low_confidence must be a number');
    req(isArr(cr.failures), 'capture_report.failures must be an array');
    if (cr.asr_confidence_available !== undefined) {
      req(isBool(cr.asr_confidence_available), 'capture_report.asr_confidence_available must be boolean');
      // The lying zero, caught. If the engine gave us no confidence numbers AND
      // the count is zero, then reporting "0 low-confidence lines" claims a
      // check that never happened — unless nothing was flagged either.
      if (cr.asr_confidence_available === false && cr.asr_lines_low_confidence === 0) {
        const flagged = list<any>(p.transcript).filter(l => list<any>(l.flags).length > 0).length;
        req(flagged === 0,
          `capture_report says 0 low-confidence lines, but ${flagged} transcript line(s) carry flags`);
      }
    }
  }

  return errs;
}
