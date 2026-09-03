import {
  SCHEMA_VERSION,
  type ClassPackJson, type PackEvent, type PackSnapshot, type PackSurface,
  type PackTranscriptLine, type PackMaterial, type PackExplainerOutline,
  type PackInteractive, type PackCaptureReport, type PackParticipant,
  type PackDerived,
} from './packSchema';
import { classifySilences, flagsFor, summariseAsrConfidence } from './packDerive';
import { buildZip, dataUrlToBytes, type ZipEntry } from './zip';
import { mergeTranscript, type NarrationLine } from './narration';
import { PRODUCT } from './product';

// Turning what was collected during a lesson into the machine-readable sidecar.
//
// Kept apart from ClassPack (which is a live buffer being written to all lesson)
// so that this is a pure-ish transform: given the collected arrays, produce the
// JSON. That is what makes "export the same session twice and get identical
// bytes" testable, and it is the reason ids are derived from content and order
// rather than from a counter that happens to be running.

export interface RawSnapshot {
  t: number;                  // ms from session start
  dataUrl: string;
  width: number;
  height: number;
  label: string;
  surfaceId: string;
  reason: PackSnapshot['reason'];
  hasNewInk: boolean;
  inkBbox: [number, number, number, number] | null;
  inkDeltaDataUrl: string | null;
  scrollY: number;
}

export interface RawHomework {
  kind: 'previous_worksheet' | 'submission';
  name: string;
  mime: string;
  dataUrl?: string;
  bytesBase64?: string;
}

export interface RawMaterial {
  id: string;
  type: PackMaterial['type'];
  name: string;
  shownFrom: number;
  shownTo: number | null;
  dataUrl?: string | null;
  source: string;
  sourceHtml?: string | null;
}

export interface PackInputs {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  room: string;
  subject: string;
  lessonNumber: number | null;
  participants: PackParticipant[];
  /** Free text from the student's dashboard: "NCERT Class 9 Maths". */
  textbook?: string | null;
  /** grade / level / goals, also from the dashboard. */
  studentProfile?: { grade: string | null; level: string | null; goals: string[] } | null;
  intentBefore: string | null;
  noteAfter: string | null;
  narration: NarrationLine[];
  /** Confidence keyed by "speaker|t|text" so it survives the merge. */
  confidenceOf?: (line: NarrationLine) => { confidence: number | null; alternates: string[] };
  /** 1.2 — the model's reading of the lesson, when one ran. */
  derived?: PackDerived | null;
  /** 1.2 — the human-readable summary written alongside `derived`. */
  summaryMd?: string | null;
  /** 1.2 — what was set for next time. */
  homeworkAssigned?: { text: string | null; material_id?: string | null; item_range?: string | null } | null;
  events: PackEvent[];
  surfaces: PackSurface[];
  snapshots: RawSnapshot[];
  materials: RawMaterial[];
  outlines: PackExplainerOutline[];
  interactives: PackInteractive[];
  homework?: RawHomework[];
  duplicatesSuppressed: number;
  failures: Array<{ what: string; why: string }>;
  /** Injected so re-exporting the same session is byte-identical apart from this. */
  generatedAt?: string;
}

export const LOW_CONFIDENCE_THRESHOLD = 0.72;

const secs = (ms: number) => Math.round(ms) / 1000;
const pad4 = (n: number) => String(n).padStart(4, '0');

/**
 * A profile the tutor never filled in is null, not an object of empty strings.
 *
 * `{grade: null, level: null, goals: []}` in the file reads as "we recorded
 * this student's profile and it is blank", which is a different and wrong
 * claim. Absent means we don't know.
 */
function emptyProfile(p: PackInputs['studentProfile']): boolean {
  return !p || (!p.grade && !p.level && (p.goals || []).length === 0);
}

/** Which surface was on screen at time t, from the surface_changed events. */
export function surfaceAt(events: PackEvent[], tSeconds: number, fallback: string | null): string | null {
  let current = fallback;
  for (const e of events) {
    if (e.type !== 'surface_changed' || !e.surface_id) continue;
    if (e.t <= tSeconds) current = e.surface_id;
    else break;
  }
  return current;
}

/**
 * Transcript ids are position-based (t0001, t0002…) so they are stable for a
 * given session and readable in a diff. They are only stable because the
 * merge that produces them is deterministic — same lines in, same lines out.
 */
export function buildTranscript(inputs: PackInputs): PackTranscriptLine[] {
  const merged = mergeTranscript(inputs.narration);
  const tutor = inputs.participants.find(p => p.role === 'tutor')?.display_name;
  return merged.map((line, i) => {
    const conf = inputs.confidenceOf?.(line) ?? { confidence: null, alternates: [] };
    const t = secs(line.t);
    return {
      id: `t${pad4(i + 1)}`,
      t,
      speaker: line.speaker,
      role: line.speaker === tutor ? 'tutor' : (tutor ? 'student' : 'unknown'),
      text: line.text,
      confidence: conf.confidence,
      low_confidence: conf.confidence !== null && conf.confidence < LOW_CONFIDENCE_THRESHOLD,
      alternates: conf.alternates || [],
      // 1.2: why this line is suspect when the engine offers no number. The
      // text itself is left exactly as recognised — flagging is not editing.
      flags: flagsFor(line.text),
      surface_id: surfaceAt(inputs.events, t, inputs.surfaces[0]?.id ?? null),
    };
  });
}

/**
 * Lines spoken around a moment — the window a reader would want beside a frame.
 *
 * 30s each way, not less: the exchange around a piece of writing is "here is
 * what we do" then, half a minute later, the student's answer. A tighter window
 * captured the tutor's setup and cut off the reply that shows whether she
 * followed it, which is the half that matters for the next worksheet.
 */
export function transcriptWindow(lines: PackTranscriptLine[], tSeconds: number, windowS = 30): string[] {
  return lines
    .filter(l => Math.abs(l.t - tSeconds) <= windowS)
    .map(l => l.id);
}

/**
 * P2-3: spans where nobody said anything for a while.
 *
 * A reader cannot otherwise tell working-in-silence from a stall, and the two
 * mean opposite things: a quiet stretch while she works through a problem is
 * the lesson going well; the same gap while she is stuck is the thing the next
 * worksheet should target. Only gaps BETWEEN speech count — the quiet before
 * the first word is someone setting up, not a silence in the lesson.
 */
export function silenceSpans(
  transcript: PackTranscriptLine[],
  minGapS = 30,
  endsAtS?: number,
): PackEvent[] {
  const out: PackEvent[] = [];
  for (let i = 1; i < transcript.length; i++) {
    const gap = transcript[i].t - transcript[i - 1].t;
    if (gap >= minGapS) {
      out.push({ t: transcript[i - 1].t, type: 'silence', duration_s: Math.round(gap) });
    }
  }
  // A long quiet run at the very end is real too — she was finishing something.
  if (endsAtS !== undefined && transcript.length > 0) {
    const last = transcript[transcript.length - 1].t;
    if (endsAtS - last >= minGapS) {
      out.push({ t: last, type: 'silence', duration_s: Math.round(endsAtS - last) });
    }
  }
  return out;
}

export function buildPackJson(inputs: PackInputs): ClassPackJson {
  const transcript = buildTranscript(inputs);
  const durationS = Math.max(0, Math.round((inputs.endedAt - inputs.startedAt) / 1000));

  const snapshots: PackSnapshot[] = inputs.snapshots.map((s, i) => {
    const t = secs(s.t);
    const id = `snap_${pad4(i + 1)}`;
    return {
      id,
      surface_id: s.surfaceId,
      t,
      image: `snapshots/${id}.jpg`,
      reason: s.reason,
      has_new_ink: s.hasNewInk,
      ink_delta_image: s.inkDeltaDataUrl ? `snapshots/${id}_delta.jpg` : null,
      ink_bbox: s.inkBbox,
      scroll_y: s.scrollY,
      ocr_text: null,     // no OCR engine ships with the app — see capture_report
      transcript_window: transcriptWindow(transcript, t),
    };
  });

  const materials: PackMaterial[] = inputs.materials.map((m, i) => ({
    id: `mat_${i + 1}`,
    type: m.type,
    image: m.dataUrl ? `materials/mat_${i + 1}.jpg` : null,
    source: m.source,
    shown_from: secs(m.shownFrom),
    shown_to: m.shownTo === null ? null : secs(m.shownTo),
    ocr_text: null,
    detected_question_numbers: [],
    source_ref: m.sourceHtml ? `materials/mat_${i + 1}.html` : null,
  }));

  const homeworkItems = inputs.homework ?? [];
  // Also listed as materials: a consumer scanning materials[] for "things shown
  // in this lesson" should find her attempt without knowing about homework{}.
  homeworkItems.forEach((h, i) => {
    materials.push({
      id: `hw_${i + 1}`,
      type: 'homework',
      image: h.dataUrl ? `materials/hw_${i + 1}.jpg` : null,
      source: h.kind === 'submission' ? 'student_submission' : 'previous_worksheet',
      shown_from: 0,
      shown_to: null,
      ocr_text: null,
      detected_question_numbers: [],
      source_ref: h.bytesBase64 ? `materials/hw_${i + 1}${extensionFor(h.mime)}` : null,
    });
  });

  // Counted from reality: real confidence numbers where the engine gave them,
  // heuristic flags where it did not. The old zero meant "nothing was ever
  // measured", which read as "nothing was wrong".
  const asrConfidence = summariseAsrConfidence(transcript);
  const capture_report: PackCaptureReport = {
    board_snapshots_kept: snapshots.length,
    duplicates_suppressed: inputs.duplicatesSuppressed,
    snapshots_with_new_ink: snapshots.filter(s => s.has_new_ink).length,
    screens_recorded: materials.filter(m => m.image).length,
    asr_lines_low_confidence: asrConfidence.lowConfidenceCount,
    asr_confidence_available: asrConfidence.available,
    failures: [...inputs.failures],
  };
  // State the known gaps rather than leaving a reader to wonder whether a zero
  // meant "nothing happened" or "this never ran".
  if (!asrConfidence.available && transcript.length > 0
      && !capture_report.failures.some(f => f.what === 'asr_confidence')) {
    capture_report.failures.push({
      what: 'asr_confidence',
      why: 'the speech recogniser returned no per-line confidence; suspect lines '
         + 'are marked with heuristic flags instead, and the count reflects those',
    });
  }
  if (!capture_report.failures.some(f => f.what === 'ocr')) {
    capture_report.failures.push({
      what: 'ocr',
      why: 'no OCR engine is bundled; snapshot and material text is not extracted',
    });
  }
  if (transcript.length === 0) {
    capture_report.failures.push({
      what: 'transcript',
      why: 'narration produced no lines (switched off, refused, or unsupported browser)',
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: inputs.generatedAt ?? new Date().toISOString(),
    session: {
      id: inputs.sessionId,
      started_at: new Date(inputs.startedAt).toISOString(),
      duration_s: durationS,
      room: inputs.room,
      subject: inputs.subject,
      lesson_number: inputs.lessonNumber,
      participants: inputs.participants,
      // One line of the tutor's own words. It is not parsed into an edition or
      // a note — guessing structure out of "Cambridge IGCSE Extended (4th ed)"
      // would put invented facts in a file a model reads as ground truth.
      textbook: inputs.textbook?.trim() ? { title: inputs.textbook.trim(), edition: null, note: null } : null,
      student_profile: emptyProfile(inputs.studentProfile) ? null : inputs.studentProfile!,
      tutor_intent_before: inputs.intentBefore,
      tutor_note_after: inputs.noteAfter,
    },
    transcript,
    // 1.2: each silence is asked whether the board was moving during it, so a
    // seven-minute gap reads as "she was working" or "we have no record",
    // rather than leaving a consumer to guess between them.
    events: classifySilences(
      [...inputs.events, ...silenceSpans(transcript, 30, durationS)].sort((a, b) => a.t - b.t),
      snapshots,
    ),
    surfaces: inputs.surfaces,
    snapshots,
    materials,
    explainer_outlines: inputs.outlines,
    interactives: inputs.interactives,
    homework: {
      previous_pack: homeworkItems.find(h => h.kind === 'previous_worksheet')?.name ?? null,
      submitted: homeworkItems.some(h => h.kind === 'submission'),
      submissions: homeworkItems
        .map((h, i) => ({ h, i }))
        .filter(x => x.h.kind === 'submission')
        .map(x => x.h.dataUrl ? `materials/hw_${x.i + 1}.jpg` : `materials/hw_${x.i + 1}${extensionFor(x.h.mime)}`),
      assigned: inputs.homeworkAssigned ?? null,
    },
    capture_report,
    ...(inputs.derived ? { derived: inputs.derived } : {}),
  };
}

/**
 * The whole pack as one archive: the PDF exactly as before, the sidecar, and the
 * folders it references. A browser has no directory to write into, so the
 * directory travels as a zip.
 */
export function buildPackArchive(pdf: Uint8Array, json: ClassPackJson, inputs: PackInputs, baseName: string): Blob {
  const entries: ZipEntry[] = [];
  const text = (s: string) => new TextEncoder().encode(s);

  // summary.md sits at the root, before the PDF, because it is the entry point
  // for the readers this pack is mostly for.
  if (inputs.summaryMd) entries.push({ name: 'summary.md', data: text(inputs.summaryMd) });
  entries.push({ name: `${baseName}.pdf`, data: pdf });
  entries.push({ name: `${baseName}.json`, data: text(JSON.stringify(json, null, 2)) });

  json.snapshots.forEach((snap, i) => {
    const raw = inputs.snapshots[i];
    if (!raw) return;
    try { entries.push({ name: snap.image, data: dataUrlToBytes(raw.dataUrl) }); } catch { /* skip a bad frame */ }
    if (snap.ink_delta_image && raw.inkDeltaDataUrl) {
      try { entries.push({ name: snap.ink_delta_image, data: dataUrlToBytes(raw.inkDeltaDataUrl) }); } catch { /* noop */ }
    }
  });

  json.materials.forEach((mat, i) => {
    const raw = inputs.materials[i];
    if (!raw) return;
    if (mat.image && raw.dataUrl) {
      try { entries.push({ name: mat.image, data: dataUrlToBytes(raw.dataUrl) }); } catch { /* noop */ }
    }
    if (mat.source_ref && raw.sourceHtml) {
      entries.push({ name: mat.source_ref, data: text(raw.sourceHtml) });
    }
  });

  (inputs.homework ?? []).forEach((h, i) => {
    const base = `materials/hw_${i + 1}`;
    try {
      if (h.dataUrl) entries.push({ name: `${base}.jpg`, data: dataUrlToBytes(h.dataUrl) });
      else if (h.bytesBase64) entries.push({ name: `${base}${extensionFor(h.mime)}`, data: dataUrlToBytes(h.bytesBase64) });
    } catch { /* an unreadable attachment should not sink the archive */ }
  });

  entries.push({ name: 'README.txt', data: text(readme(baseName, json, !!inputs.summaryMd)) });
  return buildZip(entries);
}

function extensionFor(mime: string): string {
  if (/pdf/i.test(mime)) return '.pdf';
  if (/png/i.test(mime)) return '.png';
  if (/jpe?g/i.test(mime)) return '.jpg';
  return '.bin';
}

/**
 * The manifest, generated from what the archive actually contains.
 *
 * It used to be a fixed string promising materials, explainer content and
 * "every practice question the student attempted and what she chose" — in a
 * pack where all three were empty. An agent that trusts the manifest then goes
 * looking for data that was never there and reports the pack as broken; one
 * that learns not to trust it stops reading the manifest at all. Either way
 * the promise cost more than it bought.
 *
 * So: a section is listed only if it has contents. Nothing is promised.
 */
function readme(baseName: string, pack: ClassPackJson, hasSummary: boolean): string {
  const lines: string[] = [`${PRODUCT.name} class pack`, ''];
  const has = (n: number) => n > 0;

  if (hasSummary) {
    lines.push('summary.md        - a short, plain-language reading of the lesson,');
    lines.push('                    written by a model from the data in this pack.');
  }
  lines.push(`${baseName}.pdf   - the lesson, for a person to read.`);
  lines.push(`${baseName}.json  - the same lesson as data.`);

  const inJson: string[] = [];
  inJson.push(`transcript (${pack.transcript.length} lines)`);
  if (pack.derived) inJson.push('derived: segments, attempts and error patterns, each citing evidence');
  if (has(pack.snapshots.length)) inJson.push(`snapshots (${pack.snapshots.length}) linked to what was being said`);
  if (has(pack.materials.length)) inJson.push(`materials (${pack.materials.length})`);
  if (has(pack.interactives.length)) inJson.push(`interactives (${pack.interactives.length}) with what was attempted`);
  if (has(pack.explainer_outlines.length)) inJson.push(`explainer outlines (${pack.explainer_outlines.length})`);
  for (const item of inJson) lines.push(`                    - ${item}`);

  if (has(pack.snapshots.length)) {
    lines.push('snapshots/        - board and lesson frames referenced by the JSON.');
    if (pack.snapshots.some(s => s.ink_delta_image)) {
      lines.push('                    *_delta.jpg crops show only what was newly written.');
    }
  }
  if (has(pack.materials.length)) {
    lines.push('materials/        - what was shown during the lesson.');
  }

  lines.push('');
  lines.push('For AI agents: read summary.md first, then `derived` in the JSON, then');
  lines.push('follow evidence pointers into transcript/snapshots. The full snapshot set');
  lines.push('is fallback, not the entry point.');
  lines.push('');

  // The gaps, in the manifest rather than buried in the JSON. A reader who
  // knows the student was never recorded reads the transcript differently.
  const failures = pack.capture_report.failures ?? [];
  if (failures.length > 0) {
    lines.push('Known gaps in this pack:');
    for (const f of failures) lines.push(`  - ${f.what}: ${f.why}`);
    lines.push('');
  }

  lines.push('Every id is stable across re-exports of the same session, so two packs');
  lines.push('can be diffed.');
  lines.push('');
  return lines.join('\n');
}

/** A stable, readable id fragment from a display name. */
export function slugId(name: string): string {
  return (name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'unknown';
}
