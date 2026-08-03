// The class pack: one file holding a whole lesson, for handing to a model.
//
// A hand-written PDF writer lives or dies on its cross-reference table — every
// object's byte offset is recorded in it, and a reader that finds the wrong
// bytes there rejects the file. So this checks the actual bytes, not just that
// the code ran.
// node --import tsx test-classpack.mjs
import { PdfBuilder, dataUrlToBytes, PAGE_W, PAGE_H } from './src/lib/pdf.ts';
import { ClassPack, stamp, humanDuration, paginate } from './src/lib/classPack.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

// Node has no atob/Blob-to-bytes helper wired the way the browser does.
globalThis.atob ||= (b64) => Buffer.from(b64, 'base64').toString('binary');
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const textOf = (bytes) => Buffer.from(bytes).toString('latin1');

// A 1x1 JPEG — real bytes, so the DCTDecode path is genuinely exercised.
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const jpeg = dataUrlToBytes('data:image/jpeg;base64,' + JPEG_B64);

console.log('C1: the PDF is structurally valid');
const b = new PdfBuilder();
b.addTextPage([{ text: 'Cover', size: 20, bold: true }, { text: 'Hello' }]);
b.addImagePage({ jpeg, width: 1, height: 1 }, 'Board — 3:20', 'sub');
b.addTextPage([{ text: 'Tail' }]);
const bytes = await bytesOf(b.build());
const txt = textOf(bytes);
assert(txt.startsWith('%PDF-1.4'), 'starts with a PDF header');
assert(txt.trimEnd().endsWith('%%EOF'), 'ends with %%EOF');
assert(/\/Type \/Catalog/.test(txt), 'has a catalog');
assert(/\/Count 3\b/.test(txt), 'the page tree counts all 3 pages');
assert((txt.match(/\/Type \/Page[^s]/g) || []).length === 3, 'and there are 3 page objects');
assert(/\/Filter \/DCTDecode/.test(txt), 'the image is embedded as JPEG, not re-encoded');
assert(txt.includes(`/MediaBox [0 0 ${PAGE_W} ${PAGE_H}]`), 'pages are A4');

console.log('C2: every cross-reference offset points at its object');
// The trailer's startxref value IS the contract: a reader seeks there and must
// land on the table. (Careful: "startxref" itself contains "xref".)
const startxref = Number(txt.slice(txt.lastIndexOf('startxref') + 9).trim().split(/\s/)[0]);
assert(txt.slice(startxref, startxref + 4) === 'xref',
  `seeking to startxref lands on the table (found "${txt.slice(startxref, startxref + 4)}")`);
const xrefPos = startxref;
const sizeMatch = txt.match(/\/Size (\d+)/);
const size = Number(sizeMatch?.[1]);
const entries = [...txt.slice(xrefPos).matchAll(/^(\d{10}) (\d{5}) ([nf])\s*$/gm)];
assert(entries.length === size, `the table has one entry per object (${entries.length}/${size})`);
let allGood = true, firstBad = '';
for (let n = 1; n < size; n++) {
  const off = Number(entries[n][1]);
  const here = txt.slice(off, off + 24);
  if (!here.startsWith(`${n} 0 obj`)) { allGood = false; firstBad = `obj ${n} at ${off} → "${here.slice(0, 16)}"`; break; }
}
assert(allGood, 'each offset lands exactly on "N 0 obj"', firstBad);
assert(entries[0][3] === 'f', 'entry 0 is the free-object head');

console.log('C3: the image bytes survive verbatim');
const streamAt = bytes.indexOf(jpeg[0]);
const idx = txt.indexOf('/DCTDecode');
const streamStart = txt.indexOf('stream\n', idx) + 7;
const embedded = bytes.slice(streamStart, streamStart + jpeg.length);
assert(Buffer.compare(Buffer.from(embedded), Buffer.from(jpeg)) === 0, 'the JPEG in the file is byte-identical to the input');

console.log('C4: text that would break the format is escaped');
const b2 = new PdfBuilder();
b2.addTextPage([{ text: 'a (paren) and \\ backslash' }, { text: 'emoji 🦊 and — dash' }]);
const t2 = textOf(await bytesOf(b2.build()));
assert(t2.includes('\\(paren\\)'), 'parentheses are escaped');
assert(t2.includes('\\\\ backslash'), 'backslashes are escaped');
assert(!/🦊/.test(t2), 'emoji is dropped rather than written as broken bytes');
assert(t2.includes('- dash'), 'an em dash becomes a plain hyphen Helvetica can draw');

console.log('C5: wrapping keeps long text on the page');
const wrapped = PdfBuilder.wrap('word '.repeat(400), 10);
assert(wrapped.length > 1, 'a long paragraph is split over many lines');
assert(wrapped.every(l => l.length <= 100), 'and no line is absurdly long', String(Math.max(...wrapped.map(l => l.length))));
assert(PdfBuilder.wrap('a\n\nb').join('|') === 'a||b', 'blank lines are preserved');

console.log('C6: a whole class pack');
const pack = new ClassPack();
pack.meta = { room: 'anika', teacher: 'Varun', student: 'Anika' };
pack.note('Opened the whiteboard');
pack.addArtifact('lesson', 'Fractions lab', '<html><body><h1>Fractions</h1></body></html>');
pack.addArtifact('explanation', 'Second method', '<html><body>Move the 5 across</body></html>');
pack.addArtifact('video', 'Ratios explained', 'https://youtu.be/abc');
const fakeCanvas = { width: 400, height: 300, toDataURL: () => 'data:image/jpeg;base64,' + JPEG_B64 };
assert(pack.offerSnapshot(fakeCanvas, 'Whiteboard') === true, 'the first board snapshot is taken');
assert(pack.offerSnapshot(fakeCanvas, 'Whiteboard') === false, 'an identical board seconds later is not duplicated');
assert(pack.offerSnapshot(fakeCanvas, 'Whiteboard', { force: true }) === true, 'but a forced snapshot always lands');
assert(pack.counts.artifacts === 3 && pack.counts.snapshots === 2, 'counts add up', JSON.stringify(pack.counts));
assert(pack.isEmpty === false, 'a pack with content is not empty');

const packBytes = await bytesOf(pack.buildPdf());
const packTxt = textOf(packBytes);
assert(packBytes.length > 2000, `produces a real file (${packBytes.length} bytes)`);
assert(packTxt.startsWith('%PDF'), 'which is a PDF');
assert(packTxt.includes('MathsLive - class pack'), 'with the cover title');
assert(packTxt.includes('Anika'), 'naming the student');
assert(packTxt.includes('Fractions lab'), 'listing the lesson that was used');
assert(packTxt.includes('Second method'), 'and the explainer');
assert(/\/Filter \/DCTDecode/.test(packTxt), 'and embedding the board snapshots as images');

console.log('C7: an empty pack still produces a readable file, not a crash');
const empty = new ClassPack();
assert(empty.isEmpty === true, 'a fresh pack reports itself empty');
const emptyTxt = textOf(await bytesOf(empty.buildPdf()));
assert(emptyTxt.startsWith('%PDF') && emptyTxt.includes('Nothing was recorded'), 'and says so rather than failing');

console.log('C8: timestamps and names read the way a person would say them');
assert(stamp(0) === '0:00', 'the start of the lesson');
assert(stamp(65_000) === '1:05', 'a minute in');
assert(stamp(3_725_000) === '1:02:05', 'past an hour');
assert(humanDuration(30_000) === 'under a minute', 'a very short session');
assert(humanDuration(60_000) === '1 minute', 'singular');
assert(humanDuration(45 * 60_000) === '45 minutes', 'a normal lesson');
assert(humanDuration(95 * 60_000) === '1h 35m', 'a long one');
const p = new ClassPack();
p.meta = { room: 'r', teacher: 't', student: 'Anika Kapoor' };
assert(/^class-pack-Anika-Kapoor-\d{4}-\d{2}-\d{2}\.pdf$/.test(p.suggestedFilename()), 'the filename says who and when', p.suggestedFilename());
assert(paginate([1, 2, 3, 4, 5], 2).length === 3, 'long content is split across pages');
assert(paginate([], 10).length === 1, 'and an empty list still yields one page');

console.log('C9: speech from both sides becomes one readable script');
const { mergeTranscript } = await import('./src/lib/narration.ts');
const raw = [
  { t: 9000, speaker: 'Anika', text: 'is it eight?' },
  { t: 1000, speaker: 'Varun', text: 'so we take away eight' },
  { t: 3000, speaker: 'Varun', text: 'and again' },
  { t: 40000, speaker: 'Varun', text: 'right, next question' },
];
const merged = mergeTranscript(raw);
assert(merged[0].speaker === 'Varun' && merged[0].t === 1000, 'sorted by time, whichever device sent it first');
assert(merged[0].text === 'so we take away eight and again', 'a run by one speaker joins into a sentence', merged[0].text);
assert(merged[1].speaker === 'Anika', 'the other speaker starts a new line');
assert(merged.length === 3, 'a long pause starts a fresh line even for the same speaker', String(merged.length));
assert(mergeTranscript([]).length === 0, 'no speech is not a crash');
assert(mergeTranscript(null).length === 0, 'nor is nothing at all');
assert(mergeTranscript([{ t: 1, speaker: 'A', text: '' }]).length === 0, 'empty utterances are dropped');

console.log('C10: the pack tells one story in time order');
const p2 = new ClassPack();
p2.meta = { room: 'r', teacher: 'Varun', student: 'Anika' };
p2.addNarration('Varun', 'lets look at question two', 5000);
p2.offerLessonState('Question 2: divide 3128 by 8', 'Lesson');
p2.addNarration('Anika', 'do I take away eight each time', 9000);
p2.note('Switched to the whiteboard');
assert(p2.counts.narration === 2, 'both speakers are captured', JSON.stringify(p2.counts));
assert(p2.offerLessonState('Question 2: divide 3128 by 8', 'Lesson') === false, 'an unchanged screen is not recorded twice');
assert(p2.offerLessonState('Question 3: divide 4256 by 7', 'Lesson') === true, 'but a new question is');
const t2b = textOf(await bytesOf(p2.buildPdf()));
assert(t2b.includes('What happened, in order'), 'the account is one section, not three lists');
assert(t2b.includes('lets look at question two'), 'the teacher is quoted');
assert(t2b.includes('do I take away eight each time'), 'and so is the student');
assert(t2b.includes('Question 2: divide 3128 by 8'), 'with what was on screen at the time');
const iVarun = t2b.indexOf('lets look at question two');
const iAnika = t2b.indexOf('do I take away eight each time');
assert(iVarun > 0 && iAnika > iVarun, 'and it reads in the order it happened', `${iVarun} vs ${iAnika}`);

console.log('C11: a pack with speech but nothing drawn is still worth having');
const p3 = new ClassPack();
p3.addNarration('Varun', 'we did this all verbally today');
assert(p3.isEmpty === false, 'speech alone counts as content');
assert(textOf(await bytesOf(p3.buildPdf())).includes('we did this all verbally today'), 'and reaches the file');

console.log('C12: the recogniser keeps itself alive without anyone watching it');
const { Narrator, getNarrationChoice, setNarrationChoice } = await import('./src/lib/narration.ts');
// A stand-in that behaves like the browser's: it ends on its own, errors on a
// network wobble, and can go silent without ever calling onend.
let built = 0, started = 0;
class FlakyRec {
  constructor() { built++; FlakyRec.last = this; this.onresult = null; this.onerror = null; this.onend = null; }
  start() { started++; this.alive = true; }
  stop() { this.alive = false; this.onend && this.onend(); }
  abort() { this.alive = false; }
  say(t) { this.onresult && this.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: t } }] }); }
}
globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
})();
window.SpeechRecognition = FlakyRec;

const heard = [];
const n = new Narrator(t => heard.push(t));
assert(n.start() === true, 'it starts');
FlakyRec.last.say('hello');
assert(heard[0] === 'hello', 'and passes speech through');

const beforeNetwork = built;
FlakyRec.last.onerror({ error: 'network' });
assert(n.running === true, 'a network wobble does NOT end the lesson record');
assert(built === beforeNetwork, 'and does not thrash a rebuild');

FlakyRec.last.onerror({ error: 'no-speech' });
assert(n.running === true, 'nor does a quiet classroom');

const denied = new Narrator(() => {});
denied.start();
FlakyRec.last.onerror({ error: 'not-allowed' });
assert(denied.running === false, 'a refused microphone stops, rather than nagging forever');
assert(denied.denied === true, 'and is remembered as refused');
n.stop();
assert(n.running === false, 'stop means stop');

console.log('C13: a decision is remembered, so nobody is asked every lesson');
assert(getNarrationChoice('room-a') === null, 'a new room has no decision yet');
setNarrationChoice('room-a', 'yes');
assert(getNarrationChoice('room-a') === 'yes', 'a yes is remembered');
setNarrationChoice('room-a', 'no');
assert(getNarrationChoice('room-a') === 'no', 'and can be changed to no');
assert(getNarrationChoice('room-b') === null, 'one room does not decide for another');
assert(getNarrationChoice('') === null, 'a missing room id is not a decision');

console.log(`\nCLASS PACK RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
