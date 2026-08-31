// The derive pass: ask a model to read the pack, then refuse to believe it.
//
// The output of a language model is not evidence. What makes `derived` worth
// putting in a pack is not that a model wrote it — it is that every sentence
// carries pointers a reader can follow back into the raw record, and that we
// check those pointers before shipping.
//
// So this file does three things in order:
//
//   1. Give the model only what it needs, in a form it can cite (ids, not prose).
//   2. Ask.
//   3. Throw away anything it says that does not check out.
//
// Step 3 is the important one. A claim citing a snapshot that does not exist is
// dropped, not repaired: a model that invents an id has also, probably,
// invented the observation attached to it.
import type {
  ClassPackJson, PackDerived, DerivedAttempt, DerivedErrorPattern, DerivedSegment,
} from './packSchema';
import { askModel, extractJson, llmConfigFromEnv, type LlmConfig } from './llmClient';

/** Kept under the validator's ceiling so a long summary is trimmed, not rejected. */
const MAX_SUMMARY_BYTES = 6 * 1024;
const MAX_KEY_FRAMES = 10;

export interface DeriveResult {
  derived: PackDerived | null;
  summaryMd: string | null;
  /** Present when nothing was produced, for capture_report.failures. */
  failure: { what: string; why: string } | null;
}

/** Anything that can answer a prompt. Injected so tests need no network. */
export type AskFn = (system: string, user: string) => Promise<{ ok: boolean; text?: string; model?: string; reason?: string }>;

/**
 * What the model is shown.
 *
 * Deliberately not the whole pack: images are omitted (Phase 3 sends crops),
 * and every line is prefixed with the id it must cite. Making the ids
 * unmissable is most of what makes the citations come back correct.
 */
export function buildDeriveInput(pack: ClassPackJson): string {
  const out: string[] = [];
  const s = pack.session;

  out.push('## Session');
  out.push(`duration: ${s.duration_s}s · subject: ${s.subject}` +
    (s.lesson_number ? ` · lesson ${s.lesson_number}` : ''));
  if (s.textbook?.title) out.push(`textbook: ${s.textbook.title}`);
  if (s.tutor_intent_before) out.push(`tutor's plan beforehand: ${s.tutor_intent_before}`);
  if (s.tutor_note_after) out.push(`tutor's note afterwards: ${s.tutor_note_after}`);
  if (s.student_profile) {
    out.push(`student: grade ${s.student_profile.grade ?? '?'}, level ${s.student_profile.level ?? '?'}` +
      (s.student_profile.goals?.length ? `, goals: ${s.student_profile.goals.join('; ')}` : ''));
  }

  // What is missing matters as much as what is here, and it goes near the top
  // so it frames everything the model reads afterwards.
  const roles = new Set(pack.transcript.map(l => l.role));
  out.push('', '## What this record is missing');
  if (!roles.has('student')) {
    out.push('- No student speech was captured. Every transcript line is the tutor.');
  }
  if (pack.capture_report.asr_confidence_available === false) {
    out.push('- The recogniser gave no confidence scores; lines with `flags` are the suspect ones.');
  }
  const firstSnap = pack.snapshots[0];
  if (firstSnap && firstSnap.t > 60) {
    out.push(`- The board has no visual record before t=${Math.round(firstSnap.t)}s.`);
  }
  for (const f of pack.capture_report.failures ?? []) out.push(`- ${f.what}: ${f.why}`);

  out.push('', '## Transcript');
  for (const l of pack.transcript) {
    const flag = l.flags?.length ? `  [${l.flags.join(',')}]` : '';
    out.push(`${l.id} t=${l.t} ${l.role}: ${l.text}${flag}`);
  }

  out.push('', '## Board frames');
  for (const sn of pack.snapshots) {
    const bits = [`${sn.id} t=${sn.t}`, sn.surface_id, sn.reason];
    if (sn.has_new_ink) bits.push('new ink');
    if (sn.ocr_text) bits.push(`text: ${sn.ocr_text}`);
    if (sn.material_ids?.length) bits.push(`materials: ${sn.material_ids.join(',')}`);
    if (sn.transcript_window?.length) bits.push(`said around then: ${sn.transcript_window.join(',')}`);
    out.push(`- ${bits.join(' · ')}`);
  }

  if (pack.materials.length) {
    out.push('', '## Materials');
    for (const m of pack.materials) {
      out.push(`- ${m.id} t=${m.t_added ?? m.shown_from} ${m.type} from ${m.origin ?? m.source}` +
        (m.ocr_text ? ` — ${m.ocr_text}` : ''));
    }
  }

  const silences = pack.events.filter(e => e.type === 'silence');
  if (silences.length) {
    out.push('', '## Silences');
    for (const e of silences) {
      out.push(`- t=${e.t} for ${e.duration_s}s · board ${e.board_activity ?? 'unknown'}` +
        (e.ink_snapshots_during?.length ? ` (${e.ink_snapshots_during.join(',')})` : ''));
    }
  }

  if (pack.interactives.length) {
    out.push('', '## Interactive questions answered');
    for (const it of pack.interactives) {
      out.push(`- ${it.question_id}: ${it.prompt} → ${it.final_state}`);
    }
  }

  return out.join('\n');
}

/** Trim to the byte ceiling on a line boundary, saying that it was trimmed. */
function clampSummary(md: string): string {
  const enc = new TextEncoder();
  if (enc.encode(md).length < MAX_SUMMARY_BYTES) return md;
  const note = '\n\n_(truncated)_\n';
  const budget = MAX_SUMMARY_BYTES - enc.encode(note).length - 1;
  let out = '';
  for (const line of md.split('\n')) {
    if (enc.encode(out + line + '\n').length > budget) break;
    out += line + '\n';
  }
  return out + note;
}

/**
 * Keep only what the pack can back up.
 *
 * Every id the model produced is checked against the real pack, and anything
 * unresolvable is dropped. This is what stands between "a model said so" and
 * something a downstream agent should act on.
 */
export function sanitiseDerived(
  raw: any,
  pack: ClassPackJson,
  meta: { generator: string; promptVersion: string; generatedAt: string },
): { derived: PackDerived; dropped: number } {
  const lineIds = new Set(pack.transcript.map(l => l.id));
  const snapIds = new Set(pack.snapshots.map(s => s.id));
  const matIds = new Set(pack.materials.map(m => m.id));
  let dropped = 0;

  const cleanEvidence = (ev: any) => {
    const transcript_ids = (Array.isArray(ev?.transcript_ids) ? ev.transcript_ids : []).filter((i: any) => lineIds.has(i));
    const snapshot_ids = (Array.isArray(ev?.snapshot_ids) ? ev.snapshot_ids : []).filter((i: any) => snapIds.has(i));
    return { transcript_ids, snapshot_ids };
  };
  const hasEvidence = (ev: { transcript_ids: string[]; snapshot_ids: string[] }) =>
    ev.transcript_ids.length + ev.snapshot_ids.length > 0;
  const conf = (v: any): 'high' | 'medium' | 'low' =>
    v === 'high' || v === 'medium' || v === 'low' ? v : 'low';

  const segments: DerivedSegment[] = (Array.isArray(raw?.segments) ? raw.segments : [])
    .filter((s: any) => s && typeof s.id === 'string')
    .map((s: any, i: number) => ({
      id: String(s.id || `seg_${i + 1}`),
      t_start: Number.isFinite(s.t_start) ? s.t_start : 0,
      t_end: Number.isFinite(s.t_end) ? Math.max(s.t_end, s.t_start ?? 0) : (pack.session.duration_s || 0),
      label: String(s.label ?? 'segment'),
      description: String(s.description ?? ''),
    }));
  const segIds = new Set(segments.map(s => s.id));

  const attempts: DerivedAttempt[] = (Array.isArray(raw?.attempts) ? raw.attempts : [])
    .filter((a: any) => a && typeof a.question?.text === 'string' && segIds.has(a.segment_id))
    .map((a: any, i: number) => {
      const responses = (Array.isArray(a.responses) ? a.responses : [])
        .map((r: any) => ({
          t_approx: Number.isFinite(r?.t_approx) ? r.t_approx : 0,
          answer: String(r?.answer ?? ''),
          verdict: (['correct', 'incorrect', 'unclear'].includes(r?.verdict) ? r.verdict : 'unclear') as
            'correct' | 'incorrect' | 'unclear',
          evidence: cleanEvidence(r?.evidence),
        }))
        // A response nobody can check is not a response.
        .filter((r: any) => { if (hasEvidence(r.evidence)) return true; dropped++; return false; });
      return {
        id: String(a.id || `att_${i + 1}`),
        segment_id: String(a.segment_id),
        question: {
          text: String(a.question.text),
          ...(a.question.material_id && matIds.has(a.question.material_id)
            ? { material_id: a.question.material_id } : {}),
          first_seen_t: Number.isFinite(a.question.first_seen_t) ? a.question.first_seen_t : 0,
        },
        responses,
        resolution: {
          ...(a.resolution?.final_answer ? { final_answer: String(a.resolution.final_answer) } : {}),
          how: (['independent', 'tutor_led', 'unresolved'].includes(a.resolution?.how)
            ? a.resolution.how : 'unresolved') as 'independent' | 'tutor_led' | 'unresolved',
        },
        confidence: conf(a.confidence),
      };
    });
  const attemptIds = new Set(attempts.map(a => a.id));

  const error_patterns: DerivedErrorPattern[] = (Array.isArray(raw?.error_patterns) ? raw.error_patterns : [])
    .map((e: any, i: number) => ({
      id: String(e?.id || `err_${i + 1}`),
      pattern: String(e?.pattern ?? ''),
      example_attempt_ids: (Array.isArray(e?.example_attempt_ids) ? e.example_attempt_ids : [])
        .filter((x: any) => attemptIds.has(x)),
      evidence: cleanEvidence(e?.evidence),
      confidence: conf(e?.confidence),
    }))
    .filter((e: DerivedErrorPattern) => {
      if (e.pattern && hasEvidence(e.evidence)) return true;
      dropped++;
      return false;
    });

  const key_frames = (Array.isArray(raw?.key_frames) ? raw.key_frames : [])
    .filter((id: any) => snapIds.has(id))
    .slice(0, MAX_KEY_FRAMES);

  return {
    derived: {
      generated_at: meta.generatedAt,
      generator: meta.generator,
      prompt_version: meta.promptVersion,
      segments, attempts, error_patterns, key_frames,
    },
    dropped,
  };
}

/** The prompt version declared in derive_prompt.md's front matter. */
export function promptVersionOf(promptMd: string): string {
  return /prompt_version:\s*(\S+)/.exec(promptMd)?.[1] ?? 'unknown';
}

/**
 * Run the pass. Never throws; returns a failure entry instead.
 *
 * `ask` is injectable so the contract can be tested without a key, a network,
 * or a bill — which is also the only way it can be tested today.
 */
export async function derivePack(
  pack: ClassPackJson,
  promptMd: string,
  opts: { ask?: AskFn; config?: LlmConfig | null; now?: string } = {},
): Promise<DeriveResult> {
  const cfg = opts.config !== undefined ? opts.config : llmConfigFromEnv();
  const ask: AskFn | null = opts.ask
    ?? (cfg ? (system, user) => askModel(cfg, system, user) : null);

  if (!ask) {
    return {
      derived: null, summaryMd: null,
      failure: {
        what: 'derive_pass',
        why: 'no model is configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY); '
           + 'the pack ships without the derived reading or summary.md',
      },
    };
  }

  const res = await ask(promptMd, buildDeriveInput(pack));
  if (!res.ok || !res.text) {
    return {
      derived: null, summaryMd: null,
      failure: { what: 'derive_pass', why: `the model call failed: ${res.reason ?? 'unknown'}` },
    };
  }

  const raw = extractJson(res.text) as any;
  if (!raw || typeof raw !== 'object') {
    return {
      derived: null, summaryMd: null,
      failure: { what: 'derive_pass', why: 'the model did not return usable JSON' },
    };
  }

  const { derived, dropped } = sanitiseDerived(raw, pack, {
    generator: res.model ?? cfg?.model ?? 'unknown',
    promptVersion: promptVersionOf(promptMd),
    generatedAt: opts.now ?? new Date().toISOString(),
  });

  const summaryMd = typeof raw.summary_md === 'string' && raw.summary_md.trim()
    ? clampSummary(raw.summary_md.trim() + '\n')
    : null;

  // A pass that produced nothing checkable is a failure, however much prose
  // came back with it.
  if (derived.attempts.length === 0 && derived.segments.length === 0) {
    return {
      derived: null, summaryMd: null,
      failure: { what: 'derive_pass', why: 'the model returned nothing that could be corroborated against this pack' },
    };
  }
  if (!summaryMd) {
    return {
      derived: null, summaryMd: null,
      failure: { what: 'derive_pass', why: 'the model returned no summary; derived is withheld so the two cannot disagree' },
    };
  }

  return {
    derived, summaryMd,
    failure: dropped > 0
      ? { what: 'derive_pass_partial', why: `${dropped} claim(s) were dropped because their evidence did not resolve` }
      : null,
  };
}
