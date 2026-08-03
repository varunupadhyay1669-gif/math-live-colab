// The machine-readable class pack.
//
// The four checks the spec asked for, plus the schema itself:
//   - a fixture from a real session validates against the schema
//   - duplicate suppression keeps the frame BEFORE and AFTER a correction
//   - a student answering an interactive produces an attempts entry
//   - exporting twice is identical apart from the generation timestamp
// node --import tsx test-packexport.mjs
import { validatePack, SCHEMA_VERSION } from './src/lib/packSchema.ts';
import { buildPackJson, buildTranscript, transcriptWindow, surfaceAt, LOW_CONFIDENCE_THRESHOLD } from './src/lib/packExport.ts';
import { averageHash, hammingDistance, isNearDuplicate, lumaGrid, newStrokesSince, strokeBounds, boardRectToScreen, padRect } from './src/lib/inkDelta.ts';
import { summariseInteractives, withUnattempted, readCorrectness, optionIndexOf, closestQuestionBlock } from './src/lib/interactives.ts';
import { outlineExplainer, extractQuestions, extractWorkedExamples, explainerTitle } from './src/lib/explainerOutline.ts';
import { buildZip, crc32 } from './src/lib/zip.ts';
import { silenceSpans } from './src/lib/packExport.ts';
import { ClassPack } from './src/lib/classPack.ts';
import { packKey } from './src/lib/packStore.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const IMG = 'data:image/jpeg;base64,' + JPEG_B64;
globalThis.atob ||= (b64) => Buffer.from(b64, 'base64').toString('binary');

import { fixture } from './fixtures/session-kanishka.mjs';

console.log('E1: a fixture from a real session validates against the schema');
const pack = buildPackJson(fixture());
const errs = validatePack(pack);
assert(errs.length === 0, 'validates cleanly', errs.slice(0, 3).join(' | '));
assert(pack.schema_version === SCHEMA_VERSION, `schema_version is ${SCHEMA_VERSION}`);
assert(pack.session.duration_s === 2880, 'duration in seconds', String(pack.session.duration_s));
assert(pack.session.participants[1].display_name === 'Kanishka Sharma', 'the student is named, not "Student"');
assert(pack.session.tutor_intent_before?.includes('interval notation'), 'the tutor intent is carried');
assert(pack.session.tutor_note_after?.includes('flipping the inequality'), 'and the note after');

console.log('E2: the schema catches malformed packs (so E1 means something)');
assert(validatePack(null).length > 0, 'null is rejected');
assert(validatePack({ ...pack, schema_version: '0.9' }).length > 0, 'a wrong schema_version is rejected');
const orphan = JSON.parse(JSON.stringify(pack));
orphan.snapshots[0].surface_id = 'wb_nope';
assert(validatePack(orphan).some(e => e.includes('not a known surface')), 'a snapshot pointing at a missing surface is rejected');
const badWindow = JSON.parse(JSON.stringify(pack));
badWindow.snapshots[0].transcript_window = ['t9999'];
assert(validatePack(badWindow).some(e => e.includes('unknown line')), 'a dangling transcript reference is rejected');
const inkNoBox = JSON.parse(JSON.stringify(pack));
inkNoBox.snapshots[0].ink_bbox = null;
assert(validatePack(inkNoBox).some(e => e.includes('no ink_bbox')), 'claiming new ink with no bbox is rejected');

console.log('E3: transcript is honest about what the recogniser heard');
assert(pack.transcript.length === 5, 'every line is present', String(pack.transcript.length));
assert(pack.transcript[0].id === 't0001' && pack.transcript[4].id === 't0005', 'ids are positional and readable');
const nonsense = pack.transcript.find(l => l.text.includes('Merry Christmas'));
assert(nonsense.low_confidence === true, 'the garbled line is flagged low confidence');
assert(nonsense.alternates[0] === 'set builder notation', 'and carries the alternate the recogniser offered');
assert(pack.transcript[0].low_confidence === false, 'a confident line is not flagged');
assert(pack.capture_report.asr_lines_low_confidence === 1, 'the count reaches the capture report');
assert(pack.transcript[0].role === 'tutor' && pack.transcript[1].role === 'student', 'speakers are given roles');
assert(LOW_CONFIDENCE_THRESHOLD > 0.5 && LOW_CONFIDENCE_THRESHOLD < 0.9, 'the threshold is sane');

console.log('E4: snapshots and transcript link both ways (P0-4)');
const snapAt1640 = pack.snapshots.find(s => s.t === 1640);
assert(snapAt1640.transcript_window.includes('t0001'), 'a snapshot names the lines spoken around it');
assert(snapAt1640.transcript_window.includes('t0002'), 'including the reply seconds later');
assert(!snapAt1640.transcript_window.includes('t0004'), 'but not a line four minutes away');
assert(pack.transcript[0].surface_id === 'wb_1', 'a transcript line knows which surface was showing', String(pack.transcript[0].surface_id));
assert(surfaceAt(pack.events, 2000, 'wb_1') === 'exp_1', 'surface lookup follows the change events');
assert(surfaceAt(pack.events, 100, 'wb_1') === 'wb_1', 'and falls back before the first change');

console.log('E5: duplicate suppression keeps BOTH sides of a correction');
// Three frames: board with "x <= -18", the same board nudged by a scroll, then
// the correction to "x >= -18". The middle one must go; the outer two must not.
const flat = (v) => new Array(64).fill(v);
const before = averageHash(flat(10).map((v, i) => (i % 8 < 3 ? 200 : 10)));
const nudged = averageHash(flat(10).map((v, i) => (i % 8 < 3 ? 198 : 12)));
const after = averageHash(flat(10).map((v, i) => (i % 8 < 6 ? 200 : 10)));
assert(isNearDuplicate(before, nudged), 'the same board scrolled slightly is recognised as a duplicate');
assert(!isNearDuplicate(before, after), 'the correction is NOT treated as a duplicate');
assert(hammingDistance(before, after) > 4, 'because it differs in many cells', String(hammingDistance(before, after)));
const kept = [before, nudged, after].filter((h, i, all) => i === 0 || !isNearDuplicate(h, all[i - 1]));
assert(kept.length === 2 && kept[0] === before && kept[1] === after,
  'so the frames either side of the correction both survive', JSON.stringify(kept.length));
assert(hammingDistance('1010', '') === Number.MAX_SAFE_INTEGER, 'an empty hash never counts as a match');

console.log('E6: what is new on the board comes from the strokes themselves');
const strokes = [
  { id: 's1', points: [{ x: 10, y: 10 }, { x: 60, y: 20 }], width: 4 },
  { id: 's2', points: [{ x: 220, y: 300 }, { x: 470, y: 360 }], width: 6 },
];
const fresh = newStrokesSince(new Set(['s1']), strokes);
assert(fresh.length === 1 && fresh[0].id === 's2', 'only strokes added since last time');
const box = strokeBounds(fresh);
assert(box[0] === 217 && box[3] === 363, 'bounded and padded by pen width', JSON.stringify(box));
assert(strokeBounds([]) === null, 'no new strokes means no box, not a zero box');
assert(strokeBounds([{ id: 'x', points: [{ x: NaN, y: 1 }] }]) === null, 'corrupt points do not produce a box');
const screen = boardRectToScreen([100, 100, 200, 200], { boardScale: 0.5, boardOffsetX: 30, boardOffsetY: -10 });
assert(JSON.stringify(screen) === '[80,40,130,90]', 'board coords convert with the same transform the board draws with', JSON.stringify(screen));
const padded = padRect([10, 10, 20, 20], 30, 100, 100);
assert(JSON.stringify(padded) === '[0,0,50,50]', 'the crop is padded for context and clamped to the frame', JSON.stringify(padded));
assert(lumaGrid([255, 255, 255, 255], 1, 1, 1)[0] > 250, 'luma of white is high');

console.log('E7: a student answering an interactive produces attempts (P0-1)');
const attempts = [
  { questionId: 'q4', prompt: 'Find the intersection of I1 and I2', options: ['(-inf, inf)', '(-2, 5]', '[-2, 5)', 'empty set'], correctIndex: 2, optionIndex: 1, correct: false, widget: 'practice_zone', by: 'student', t: 2540 },
  { questionId: 'q4', prompt: '', options: [], correctIndex: null, optionIndex: 2, correct: true, widget: 'practice_zone', by: 'student', t: 2562 },
  { questionId: 'q5', prompt: 'Is (-2,5) closed?', options: ['yes', 'no'], correctIndex: 1, optionIndex: 1, correct: true, widget: 'trap_or_truth', by: 'student', t: 2600 },
  { questionId: 'q6', prompt: 'Solve 4x < 9 - 2x', options: ['x<1.5', 'x>1.5'], correctIndex: 0, optionIndex: 1, correct: false, widget: 'practice_zone', by: 'student', t: 2700 },
];
const summary = summariseInteractives(attempts, 'exp_1');
assert(summary.length === 3, 'three questions recorded', String(summary.length));
const q4 = summary.find(s => s.question_id === 'q4');
assert(q4.attempts.length === 2, 'both of her goes at q4 are kept');
assert(q4.attempts[0].correct === false && q4.attempts[1].correct === true, 'wrong then right, in order');
assert(q4.final_state === 'correct_after_retry', 'and the retry is called what it is', q4.final_state);
assert(q4.correct_option_index === 2, 'the right answer is carried even though the second event omitted it');
assert(summary.find(s => s.question_id === 'q5').final_state === 'correct_first_try', 'a clean answer reads as first try');
assert(summary.find(s => s.question_id === 'q6').final_state === 'incorrect', 'and a wrong one stays wrong');
assert(q4.attempts.every(a => a.by === 'student'), 'attributed to the student, not the tutor');

console.log('E8: correctness is read honestly, never guessed');
const el = (cls, attrs = {}) => ({ tagName: 'DIV', className: cls, textContent: 'x', getAttribute: (n) => attrs[n] ?? null, querySelectorAll: () => [], querySelector: () => null });
assert(readCorrectness(el('option correct'), null) === true, 'a "correct" class is read as correct');
assert(readCorrectness(el('option wrong'), null) === false, 'a "wrong" class as incorrect');
assert(readCorrectness(el('option'), null) === null, 'a page that says nothing yields null, not a guess');
assert(readCorrectness(el('option', { 'data-correct': 'false' }), null) === false, 'data-correct="false" is respected');
const unanswered = summariseInteractives([{ questionId: 'q7', prompt: 'p', options: ['a', 'b'], correctIndex: 0, optionIndex: null, correct: null, widget: 'w', by: 'student', t: 1 }], 'exp_1');
assert(unanswered[0].final_state === 'unanswered', 'a non-answer is not scored');

console.log('E9: the explainer becomes structure, not source (P0-2)');
// A stand-in DOM: the shape a lesson page actually has.
function mkEl(tag, text, attrs = {}, kids = []) {
  const e = {
    tagName: tag, textContent: text, className: attrs.class || '',
    getAttribute: (n) => (n === 'class' ? (attrs.class ?? null) : (attrs[n] ?? null)),
    _kids: kids,
    querySelectorAll: (sel) => matchAll(e, sel),
    querySelector: (sel) => matchAll(e, sel)[0] || null,
  };
  return e;
}
function matches(el, sel) {
  return sel.split(',').map(s => s.trim()).some(s => {
    if (s.startsWith('[') && s.endsWith(']')) { const n = s.slice(1, -1).split('=')[0]; return el.getAttribute(n) !== null; }
    if (s.startsWith('.')) return (el.className || '').split(/\s+/).includes(s.slice(1));
    return el.tagName.toLowerCase() === s.toLowerCase();
  });
}
function walk(el, out = []) { for (const k of el._kids || []) { out.push(k); walk(k, out); } return out; }
function matchAll(el, sel) { return walk(el).filter(k => matches(k, sel)); }

const optA = mkEl('LI', '(-inf, inf)', { 'data-option': '' });
const optB = mkEl('LI', '(-2, 5]', { 'data-option': '' });
const optC = mkEl('LI', '[-2, 5)', { 'data-option': '', 'data-correct': 'true' });
const q = mkEl('DIV', '', { 'data-question-id': 'q4', class: 'question' }, [
  mkEl('P', 'Find the intersection of I1 and I2', { class: 'prompt' }), optA, optB, optC,
]);
const example = mkEl('DIV', '', { class: 'worked-example' }, [
  mkEl('H3', 'Worked example 1'),
  mkEl('LI', 'Subtract 2 from both sides'),
  mkEl('LI', 'Divide by -3 and flip the sign'),
]);
const doc = mkEl('BODY', '', {}, [
  mkEl('H1', 'Mastering Sets & Interval Notation'),
  mkEl('H2', 'Why it matters'),
  mkEl('P', 'Intervals describe a continuous run of numbers.'),
  example, q,
]);
const questions = extractQuestions(doc);
assert(questions.length === 1, 'the practice question is found');
assert(questions[0].question_id === 'q4', 'using its declared id');
assert(questions[0].prompt.includes('intersection'), 'with its prompt');
assert(questions[0].options.length === 3, 'and all its options', String(questions[0].options.length));
assert(questions[0].correct_option_index === 2, 'and which one is right');
const examples = extractWorkedExamples(doc);
assert(examples.length === 1 && examples[0].steps.length === 2, 'the worked example and its steps come through', JSON.stringify(examples));
assert(examples[0].steps[1].includes('flip the sign'), 'including the step that matters here');
const sections = outlineExplainer(doc);
assert(sections.length >= 2, 'the document is sectioned by heading', String(sections.length));
assert(sections.some(s => s.heading === 'Why it matters'), 'headings are kept');
assert(explainerTitle(doc, null) === 'Mastering Sets & Interval Notation', 'and the title');
const allText = JSON.stringify(sections);
assert(!/font-family|@media|<style/.test(allText), 'no stylesheet leaks into the outline');

console.log('E10: questions never attempted still appear');
const withAll = withUnattempted(doc, 'exp_1', summariseInteractives([], 'exp_1'));
assert(withAll.length === 1 && withAll[0].final_state === 'unanswered', 'a question she never touched is listed as unanswered');

console.log('E11: exporting twice is identical apart from the timestamp');
const a = buildPackJson(fixture({ generatedAt: '2026-08-03T21:30:00.000Z' }));
const b = buildPackJson(fixture({ generatedAt: '2026-08-04T09:00:00.000Z' }));
assert(a.generated_at !== b.generated_at, 'the timestamps do differ');
const stripA = JSON.stringify({ ...a, generated_at: null });
const stripB = JSON.stringify({ ...b, generated_at: null });
assert(stripA === stripB, 'everything else is byte-identical');
assert(JSON.stringify(a.snapshots.map(s => s.id)) === JSON.stringify(b.snapshots.map(s => s.id)), 'snapshot ids are stable across exports');
assert(JSON.stringify(a.transcript.map(l => l.id)) === JSON.stringify(b.transcript.map(l => l.id)), 'so are transcript ids');

console.log('E12: the archive is a real zip');
const zipBlob = buildZip([
  { name: 'a.txt', data: new TextEncoder().encode('hello') },
  { name: 'snapshots/snap_0001.jpg', data: new Uint8Array([1, 2, 3, 4]) },
]);
const zbytes = new Uint8Array(await zipBlob.arrayBuffer());
const ztxt = Buffer.from(zbytes).toString('latin1');
assert(ztxt.startsWith('PK' + String.fromCharCode(3, 4)), 'starts with the local file header signature');
assert(ztxt.includes('snapshots/snap_0001.jpg'), 'paths keep their folders');
assert(ztxt.includes('PK' + String.fromCharCode(5, 6)), 'ends with an end-of-central-directory record');
assert(crc32(new TextEncoder().encode('hello')) === 0x3610a686, 'CRC-32 matches the known value for "hello"', crc32(new TextEncoder().encode('hello')).toString(16));
const zipTwice = new Uint8Array(await buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]).arrayBuffer());
const zipAgain = new Uint8Array(await buildZip([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]).arrayBuffer());
assert(Buffer.compare(Buffer.from(zipTwice), Buffer.from(zipAgain)) === 0, 'and two builds of the same content are byte-identical');

console.log('E13: the capture report states the gaps rather than hiding them');
assert(pack.capture_report.board_snapshots_kept === 14, 'kept count', String(pack.capture_report.board_snapshots_kept));
assert(pack.capture_report.duplicates_suppressed === 46, 'suppressed count is reported');
assert(pack.capture_report.snapshots_with_new_ink === 9, 'and how many had new writing', String(pack.capture_report.snapshots_with_new_ink));
assert(pack.capture_report.failures.some(f => f.what === 'ocr'), 'the missing OCR is declared, not silently absent');
assert(pack.capture_report.failures.some(f => f.what === 'lesson_screen_recording'), 'and so is a capture that did not run');
const silent = buildPackJson(fixture({ narration: [] }));
assert(silent.capture_report.failures.some(f => f.what === 'transcript'), 'an empty transcript explains itself');

console.log('E14: silence spans tell working-in-quiet from a stall (P2-3)');
const lines = (ts) => ts.map((t, i) => ({ id: `t${i}`, t, speaker: 'x', role: 'tutor', text: 'x', confidence: null, low_confidence: false, alternates: [], surface_id: null }));
const gaps = silenceSpans(lines([10, 20, 100, 105]), 30);
assert(gaps.length === 1, 'only the real gap is reported', String(gaps.length));
assert(gaps[0].t === 20 && gaps[0].duration_s === 80, 'starting when the talking stopped, with its length', JSON.stringify(gaps[0]));
assert(silenceSpans(lines([10, 20, 30]), 30).length === 0, 'a chatty stretch has no silences');
assert(silenceSpans(lines([]), 30).length === 0, 'no speech at all yields no spans, not one giant silence');
assert(silenceSpans(lines([10]), 30, 200).length === 1, 'a long quiet run at the end counts');
assert(silenceSpans(lines([10]), 30, 20).length === 0, 'but a short tail does not');
const withSilence = buildPackJson(fixture());
assert(withSilence.events.some(e => e.type === 'silence'), 'silences reach the exported events');
assert(withSilence.events.every((e, i, all) => i === 0 || all[i - 1].t <= e.t), 'and the event list stays in time order');
assert(withSilence.events.some(e => e.type === 'control_handed_to_student'), 'the handover events are still there');

console.log('E15: a pack survives a reload');
const live = new ClassPack();
live.meta = { room: 'kanishka', teacher: 'Varun', student: 'Kanishka' };
live.addNarration('Varun', 'so we subtract two from both sides');
live.addNarration('Kanishka', 'is it minus eighteen');
live.addArtifact('explanation', 'Interval notation', '<html>...</html>');
live.note('Switched to the whiteboard');
live.offerImage(IMG, 400, 300, 'Whiteboard', { force: true, surfaceId: 'wb_1', reason: 'ink_committed', inkBbox: [1, 2, 3, 4] });
const revived = ClassPack.fromState(JSON.parse(JSON.stringify(live.toState())));
assert(revived !== null, 'it comes back');
assert(revived.startedAt === live.startedAt, 'with the same start time, so timestamps stay meaningful');
assert(JSON.stringify(revived.counts) === JSON.stringify(live.counts), 'and nothing is missing', JSON.stringify(revived.counts));
assert(revived.allNarration[1].text === 'is it minus eighteen', 'the student is still quoted');
assert(revived.allSnapshots[0].inkBbox[2] === 3, 'ink metadata survives the round trip');
assert(revived.meta.student === 'Kanishka', 'and who the lesson was with');

console.log('E16: a damaged record is refused rather than half-restored');
assert(ClassPack.fromState(null) === null, 'null is refused');
assert(ClassPack.fromState({ v: 99, startedAt: 1, snapshots: [], narration: [] }) === null, 'an unknown version is refused');
assert(ClassPack.fromState({ v: 1, startedAt: 'nope', snapshots: [], narration: [] }) === null, 'a corrupt start time is refused');
assert(ClassPack.fromState({ v: 1, startedAt: 1, snapshots: 'x', narration: [] }) === null, 'missing snapshots are refused');
assert(packKey('kanishka', Date.parse('2026-08-03T20:00:00Z')).startsWith('kanishka:2026-08-0'), 'the key is room plus day', packKey('kanishka', Date.parse('2026-08-03T20:00:00Z')));
assert(packKey('a', 1) !== packKey('b', 1), 'two rooms never share a record');

console.log(`\nPACK EXPORT RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
