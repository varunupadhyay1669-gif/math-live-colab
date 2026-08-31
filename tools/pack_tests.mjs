// Does the 1.2 validator actually catch a bad pack?
//
// Each case bends exactly one thing and asserts the validator complains about
// that thing. Kept beside the validator rather than in the mirror suite because
// these are about the pack contract, and a reader debugging a pack should find
// them without reading anything about canvases.
import { tmpdir } from 'os';
import path from 'path';
import { rmSync, writeFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { validatePack } from '../src/lib/packSchema.ts';
import { syntheticPack, writePackDir } from './synthetic_pack.mjs';
import { derivePack, sanitiseDerived, buildDeriveInput, promptVersionOf } from '../src/lib/packLlm.ts';
import { extractJson, llmConfigFromEnv } from '../src/lib/llmClient.ts';
import { readFileSync as _read } from 'fs';

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failed++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));

/** Bend one thing, and expect a complaint that mentions `needle`. */
function breaks(name, mutate, needle) {
  const p = syntheticPack();
  mutate(p);
  const errs = validatePack(p);
  const hit = errs.some(e => e.toLowerCase().includes(needle.toLowerCase()));
  assert(hit, name, errs.length ? `got: ${errs.slice(0, 2).join(' | ')}` : 'validator found nothing wrong');
}

console.log('\nPACK 1.2 — the shape holds');
assert(validatePack(syntheticPack()).length === 0,
  'a well-formed 1.2 pack passes',
  validatePack(syntheticPack()).join(' | '));

console.log('\nPACK 1.2 — evidence must resolve');
// The whole value of `derived` is that a reader can disbelieve any sentence and
// go check it. A citation pointing at nothing turns the block back into prose.
breaks('a claim citing a transcript line that does not exist is caught',
  p => { p.derived.attempts[0].responses[0].evidence.transcript_ids = ['t9999']; }, 't9999');
breaks('a claim citing a snapshot that does not exist is caught',
  p => { p.derived.attempts[0].responses[0].evidence.snapshot_ids = ['snap_9999']; }, 'snap_9999');
breaks('a claim with no evidence at all is caught',
  p => { p.derived.attempts[0].responses[0].evidence = { transcript_ids: [], snapshot_ids: [] }; }, 'no evidence');
breaks('an error pattern citing an unknown attempt is caught',
  p => { p.derived.error_patterns[0].example_attempt_ids = ['att_nope']; }, 'att_nope');
breaks('an attempt in a segment that does not exist is caught',
  p => { p.derived.attempts[0].segment_id = 'seg_nope'; }, 'seg_nope');
breaks('key_frames pointing at an unknown snapshot is caught',
  p => { p.derived.key_frames = ['snap_nope']; }, 'snap_nope');

console.log('\nPACK 1.2 — the short list stays short');
breaks('more than ten key frames is caught',
  p => { p.derived.key_frames = Array.from({ length: 11 }, () => 'snap_0001'); }, '10 or fewer');

console.log('\nPACK 1.2 — no unevidenced claims about the board');
// "The board was active" with nothing to point at is exactly the kind of
// confident emptiness this pack is supposed to stop producing.
breaks('a silence claiming an active board with no frames is caught',
  p => { p.events[1].ink_snapshots_during = []; }, 'no snapshots');
breaks('a silence citing an unknown snapshot is caught',
  p => { p.events[1].ink_snapshots_during = ['snap_nope']; }, 'snap_nope');

console.log('\nPACK 1.2 — the lying zero');
// The original failure: a metric reporting zero problems because it never ran.
breaks('reporting zero low-confidence lines while lines carry flags is caught',
  p => { p.capture_report.asr_lines_low_confidence = 0; }, 'carry flags');

console.log('\nPACK 1.2 — cross-references');
breaks('a snapshot naming an unknown material is caught',
  p => { p.snapshots[0].material_ids = ['mat_nope']; }, 'mat_nope');
breaks('an attempt naming an unknown material is caught',
  p => { p.derived.attempts[0].question.material_id = 'mat_nope'; }, 'mat_nope');

console.log('\nPACK 1.2 — 1.1 packs still validate');
// Additive means additive: last month's pack must not stop being valid because
// the app moved on.
{
  const p = syntheticPack();
  p.schema_version = '1.1';
  delete p.derived;
  delete p.homework.assigned;
  delete p.capture_report.asr_confidence_available;
  for (const l of p.transcript) delete l.flags;
  for (const e of p.events) { delete e.board_activity; delete e.ink_snapshots_during; }
  for (const s of p.snapshots) delete s.material_ids;
  for (const m of p.materials) { delete m.t_added; delete m.origin; delete m.sha256; delete m.bbox; delete m.surface_id; }
  const errs = validatePack(p);
  assert(errs.length === 0, 'a 1.1 pack with none of the new fields still validates', errs.join(' | '));
}

console.log('\nDERIVE — the model is not trusted');

const PROMPT = _read('export/derive_prompt.md', 'utf8');
const basePack = syntheticPack();
const stub = (payload) => async () => ({ ok: true, text: JSON.stringify(payload), model: 'test-stub' });

assert(promptVersionOf(PROMPT) === 'v1', 'the prompt declares its version', promptVersionOf(PROMPT));

// The input must carry the ids the model is required to cite; without them it
// cannot obey the contract however well the prompt is written.
{
  const input = buildDeriveInput(basePack);
  assert(input.includes('t0001') && input.includes('snap_0002'),
    'the model is shown the ids it must cite');
  // The warning must appear only when it is TRUE. A pack that did capture the
  // student must not be told its student is missing — a false gap is as
  // misleading as a hidden one.
  const withStudent = syntheticPack();
  withStudent.transcript.push({
    id: 't0003', t: 55, speaker: 'Student', role: 'student', text: 'Four hundred and twenty.',
    confidence: null, low_confidence: false, alternates: [], flags: [], surface_id: 'wb_1',
  });
  assert(!buildDeriveInput(withStudent).includes('No student speech was captured'),
    'a pack that did capture the student is not told otherwise');
  assert(input.includes('[number_garble]'),
    'suspect transcript lines are marked for the model');
}

// A pack whose transcript is tutor-only must say so, loudly, in the input.
{
  const tutorOnly = syntheticPack();
  tutorOnly.transcript = tutorOnly.transcript.map(l => ({ ...l, role: 'tutor' }));
  assert(buildDeriveInput(tutorOnly).includes('No student speech was captured'),
    'a tutor-only transcript is declared to the model');
}

// The core defence: invented ids are dropped, not repaired.
{
  const { derived, dropped } = sanitiseDerived({
    segments: [{ id: 'seg_1', t_start: 0, t_end: 10, label: 'x', description: 'y' }],
    attempts: [{
      id: 'att_1', segment_id: 'seg_1', question: { text: '4 x 21 x 5', first_seen_t: 10 },
      responses: [
        { t_approx: 40, answer: '2100', verdict: 'incorrect',
          evidence: { transcript_ids: ['t0002'], snapshot_ids: [] } },
        { t_approx: 50, answer: '420', verdict: 'correct',
          evidence: { transcript_ids: ['t9999'], snapshot_ids: ['snap_9999'] } },
      ],
      resolution: { how: 'tutor_led' }, confidence: 'high',
    }],
    error_patterns: [], key_frames: ['snap_0002', 'snap_nope'],
  }, basePack, { generator: 'stub', promptVersion: 'v1', generatedAt: 'now' });

  assert(derived.attempts[0].responses.length === 1,
    'a response whose evidence does not resolve is dropped');
  assert(dropped === 1, 'the drop is counted so it can be reported', String(dropped));
  assert(derived.key_frames.length === 1 && derived.key_frames[0] === 'snap_0002',
    'invented key frames are removed');
}

// Whatever the model returns, the result must pass the validator.
{
  const r = await derivePack(basePack, PROMPT, {
    ask: stub({
      segments: [{ id: 'seg_1', t_start: 0, t_end: 600, label: 'Convenient order', description: 'Regrouping.' }],
      attempts: [{
        id: 'att_1', segment_id: 'seg_1', question: { text: '4 x 21 x 5', material_id: 'mat_1', first_seen_t: 10 },
        responses: [{ t_approx: 40, answer: '2100', verdict: 'incorrect',
                      evidence: { transcript_ids: ['t0002'], snapshot_ids: ['snap_0002'] } }],
        resolution: { final_answer: '420', how: 'tutor_led' }, confidence: 'medium',
      }],
      error_patterns: [{ id: 'err_1', pattern: 'multiplies by ten instead of regrouping',
                         example_attempt_ids: ['att_1'],
                         evidence: { transcript_ids: ['t0002'], snapshot_ids: [] }, confidence: 'medium' }],
      key_frames: ['snap_0002'],
      summary_md: '# Lesson\n\nConvenient order.\n',
    }),
    config: null,
  });
  assert(r.derived !== null && r.summaryMd !== null, 'a good model reply produces derived + summary');
  const merged = { ...basePack, derived: r.derived };
  assert(validatePack(merged).length === 0,
    'the sanitised derive block passes the 1.2 validator', validatePack(merged).join(' | '));
}

// A confident model with no resolvable evidence gets nothing published.
{
  const r = await derivePack(basePack, PROMPT, {
    ask: stub({
      segments: [], attempts: [], error_patterns: [], key_frames: [],
      summary_md: 'She did very well today.',
    }),
    config: null,
  });
  assert(r.derived === null && r.failure?.what === 'derive_pass',
    'a pass that corroborates nothing is withheld, not shipped');
}

// Over-long summaries are trimmed rather than failing validation later.
{
  const r = await derivePack(basePack, PROMPT, {
    ask: stub({
      segments: [{ id: 'seg_1', t_start: 0, t_end: 600, label: 'x', description: 'y' }],
      attempts: [], error_patterns: [], key_frames: [],
      summary_md: 'padding line\n'.repeat(2000),
    }),
    config: null,
  });
  const bytes = new TextEncoder().encode(r.summaryMd ?? '').length;
  assert(bytes > 0 && bytes < 6 * 1024, 'an over-long summary is trimmed under the ceiling', String(bytes));
}

// No key, no derive — and the pack says why rather than going quiet.
{
  const r = await derivePack(basePack, PROMPT, { config: null });
  assert(r.derived === null && /no model is configured/i.test(r.failure?.why ?? ''),
    'with no API key the pass skips and records an honest failure', r.failure?.why);
}
assert(llmConfigFromEnv({}) === null, 'no keys in the environment means no provider');
assert(llmConfigFromEnv({ GEMINI_API_KEY: 'k' })?.provider === 'gemini', 'a Gemini key selects Gemini');
assert(llmConfigFromEnv({ ANTHROPIC_API_KEY: 'k' })?.provider === 'anthropic', 'an Anthropic key selects Anthropic');
assert(llmConfigFromEnv({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', DERIVE_PROVIDER: 'gemini' })?.provider === 'gemini',
  'DERIVE_PROVIDER decides when both keys are present');
assert(extractJson('Here you go:\n```json\n{"a":1}\n```')?.a === 1,
  'JSON is recovered from a fenced, chatty reply');

// ── The archive layer, on real files ───────────────────────────────────────
console.log('\nPACK 1.2 — the archive on disk');
const root = path.join(tmpdir(), 'mathslive-pack-tests');
const runTool = (dir) => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', 'tools/validate_pack.mjs', dir],
      { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

{
  const dir = writePackDir(path.join(root, 'good'), syntheticPack());
  const r = runTool(dir);
  assert(r.code === 0, 'a complete archive passes the tool', r.out.trim());
}
{
  const p = syntheticPack();
  const dir = writePackDir(path.join(root, 'missing-image'), p);
  rmSync(path.join(dir, p.snapshots[0].image));
  const r = runTool(dir);
  assert(r.code !== 0 && /missing from archive/i.test(r.out),
    'a snapshot whose image is not in the archive is caught', r.out.trim());
}
{
  const dir = writePackDir(path.join(root, 'no-summary'), syntheticPack(), { summary: null });
  const r = runTool(dir);
  assert(r.code !== 0 && /summary\.md is missing/i.test(r.out),
    'derived without summary.md is caught', r.out.trim());
}
{
  const dir = writePackDir(path.join(root, 'fat-summary'), syntheticPack(),
    { summary: 'x'.repeat(7000) });
  const r = runTool(dir);
  assert(r.code !== 0 && /under 6144/i.test(r.out),
    'a summary longer than a page is caught', r.out.trim());
}
{
  // The original sin: a manifest advertising data the pack does not contain.
  const p = syntheticPack();
  p.materials = [];
  p.snapshots[0].material_ids = [];
  p.derived.attempts[0].question.material_id = undefined;
  p.homework.assigned.material_id = undefined;
  const dir = writePackDir(path.join(root, 'lying-readme'), p, {
    readme: 'MathsLive class pack\n\nmaterials/  - everything shown in the lesson.\n\nFor AI agents: read summary.md first.\n',
  });
  const r = runTool(dir);
  assert(r.code !== 0 && /promises materials/i.test(r.out),
    'a README promising materials the pack lacks is caught', r.out.trim());
}
{
  const p = syntheticPack();
  p.session.participants[1].display_name = 'Kanishka';
  const dir = writePackDir(path.join(root, 'named-student'), p);
  const r = runTool(dir);
  assert(r.code !== 0 && /anonymised/i.test(r.out),
    'a pack that names the student is caught', r.out.trim());
}
rmSync(root, { recursive: true, force: true });

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
