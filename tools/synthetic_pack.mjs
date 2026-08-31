// A minimal, valid 1.2 pack — and the machinery to break it on purpose.
//
// The real fixture is a session that already happened, which makes it perfect
// for asking "did we recover more of the class?" and useless for asking "does
// the validator actually catch a bad pack?" — it only has one shape. This
// builds a pack small enough to read in full, then bends one thing at a time.
//
// A validator that has never been shown a failing pack is an assertion that
// everything is fine.
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import path from 'path';

/** A pack with one of everything, all cross-references resolving. */
export function syntheticPack() {
  return {
    schema_version: '1.2',
    generated_at: '2026-08-31T10:00:00.000Z',
    session: {
      id: 'sess_synthetic',
      started_at: '2026-08-31T09:00:00.000+05:30',
      duration_s: 600,
      room: 'demo',
      subject: 'Maths',
      lesson_number: 4,
      participants: [
        { role: 'tutor', id: 'tutor_1', display_name: 'Tutor', timezone: 'Asia/Kolkata' },
        { role: 'student', id: 'student_1', display_name: 'Student', timezone: null },
      ],
      textbook: { title: 'NCERT Class 7 Maths', edition: null, note: null },
      student_profile: { grade: '7', level: 'on track', goals: ['times tables'] },
      tutor_intent_before: 'Number properties, convenient order.',
      tutor_note_after: 'Multiplication facts still shaky.',
    },
    transcript: [
      { id: 't0001', t: 10, speaker: 'Tutor', role: 'tutor', text: 'Four times twenty-one times five.',
        confidence: null, low_confidence: false, alternates: [], flags: [], surface_id: 'wb_1' },
      { id: 't0002', t: 40, speaker: 'Tutor', role: 'tutor', text: '084-3223 carry 83 16 17 1917',
        confidence: null, low_confidence: false, alternates: [], flags: ['number_garble'], surface_id: 'wb_1' },
    ],
    events: [
      { t: 0, type: 'surface_changed', surface_id: 'wb_1' },
      { t: 40, type: 'silence', duration_s: 120, board_activity: 'active', ink_snapshots_during: ['snap_0002'] },
    ],
    surfaces: [{ id: 'wb_1', type: 'whiteboard', title: 'Whiteboard' }],
    snapshots: [
      { id: 'snap_0001', surface_id: 'wb_1', t: 5, image: 'snapshots/snap_0001.jpg', reason: 'session_start',
        has_new_ink: false, ink_delta_image: null, ink_bbox: null, scroll_y: 0, ocr_text: null,
        transcript_window: ['t0001'], material_ids: ['mat_1'] },
      { id: 'snap_0002', surface_id: 'wb_1', t: 90, image: 'snapshots/snap_0002.jpg', reason: 'ink_committed',
        has_new_ink: true, ink_delta_image: null, ink_bbox: [0, 0, 10, 10], scroll_y: 0, ocr_text: null,
        transcript_window: ['t0002'], material_ids: [] },
    ],
    materials: [
      { id: 'mat_1', type: 'image', image: 'materials/mat_1.jpg', source: 'pasted exercise',
        shown_from: 4, shown_to: null, ocr_text: null, detected_question_numbers: [], source_ref: null,
        t_added: 4, surface_id: 'wb_1', bbox: [0, 0, 100, 100], origin: 'paste', sha256: 'abc123' },
    ],
    explainer_outlines: [],
    interactives: [],
    homework: {
      previous_pack: null, submitted: false, submissions: [],
      assigned: { text: 'Q7-10 from the pasted exercise', material_id: 'mat_1', item_range: 'Q7-10' },
    },
    capture_report: {
      board_snapshots_kept: 2, duplicates_suppressed: 0, snapshots_with_new_ink: 1,
      screens_recorded: 1, asr_lines_low_confidence: 1, asr_confidence_available: false,
      failures: [{ what: 'ocr', why: 'no OCR engine is bundled' }],
    },
    derived: {
      generated_at: '2026-08-31T10:00:00.000Z',
      generator: 'test-stub',
      prompt_version: 'v1',
      segments: [{ id: 'seg_1', t_start: 0, t_end: 600, label: 'Convenient order', description: 'Regrouping to multiply.' }],
      attempts: [{
        id: 'att_1', segment_id: 'seg_1',
        question: { text: '4 x 21 x 5', material_id: 'mat_1', first_seen_t: 10 },
        responses: [{ t_approx: 40, answer: '2100', verdict: 'incorrect',
                      evidence: { transcript_ids: ['t0002'], snapshot_ids: ['snap_0002'] } }],
        resolution: { final_answer: '420', how: 'tutor_led' },
        confidence: 'medium',
      }],
      error_patterns: [{
        id: 'err_1', pattern: 'Multiplies by ten instead of regrouping',
        example_attempt_ids: ['att_1'],
        evidence: { transcript_ids: ['t0002'], snapshot_ids: [] },
        confidence: 'low',
      }],
      key_frames: ['snap_0002'],
    },
  };
}

/** The README that pack honestly deserves. */
export function syntheticReadme(pack, hasSummary) {
  const lines = ['MathsLive class pack', ''];
  if (hasSummary) lines.push('summary.md        - a short reading of the lesson.');
  lines.push('pack.json         - the lesson as data.');
  if (pack.derived) lines.push('                    - derived: segments, attempts, error patterns');
  if (pack.snapshots.length) lines.push('snapshots/        - board frames referenced by the JSON.');
  if (pack.materials.length) lines.push('materials/        - what was shown during the lesson.');
  lines.push('');
  lines.push('For AI agents: read summary.md first, then `derived` in the JSON, then');
  lines.push('follow evidence pointers into transcript/snapshots. The full snapshot set');
  lines.push('is fallback, not the entry point.');
  return lines.join('\n');
}

/**
 * Write a pack to disk as a real archive directory, so the filesystem-level
 * checks (missing images, oversized summary, lying README) have something to
 * actually look at.
 */
export function writePackDir(dir, pack, { summary = '# Lesson\n\nShort.\n', readme = null } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  mkdirSync(path.join(dir, 'materials'), { recursive: true });
  writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack, null, 2));
  for (const s of pack.snapshots ?? []) {
    if (s.image) writeFileSync(path.join(dir, s.image), 'jpeg-bytes');
    if (s.ink_delta_image) writeFileSync(path.join(dir, s.ink_delta_image), 'jpeg-bytes');
  }
  for (const m of pack.materials ?? []) {
    if (m.image) writeFileSync(path.join(dir, m.image), 'jpeg-bytes');
    if (m.source_ref) writeFileSync(path.join(dir, m.source_ref), '<html></html>');
  }
  if (summary !== null) writeFileSync(path.join(dir, 'summary.md'), summary);
  writeFileSync(path.join(dir, 'README.txt'), readme ?? syntheticReadme(pack, summary !== null));
  return dir;
}
