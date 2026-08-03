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

console.log(`\nCLASS PACK RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
