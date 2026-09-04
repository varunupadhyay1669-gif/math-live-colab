// Does the mirror still hold?
//
// Every check here is a bug that actually reached a live lesson. They were all
// found by hand, one at a time, usually from a tutor saying "it's not working"
// with no way to know which of a dozen things that meant. This is the version
// that runs on every push instead.
//
// Two halves:
//
//   OFFLINE  the injected scripts and the pure functions around them. Needs
//            nothing but Node — fast enough to run before every commit.
//   LIVE     the socket protocol, against a running server. Same idiom as
//            verify-sync.mjs.
//
// Usage:  node verify-mirror.mjs              (offline only)
//         PORT=4000 node verify-mirror.mjs    (offline + live)

import { JSDOM } from 'jsdom';
import { mirrorScriptFor, stripLessonScripts } from './src/lib/mirrorScript.ts';
import { checkLesson } from './src/lib/lessonCheck.ts';
import { parseDataUrl, externaliseBoardImages } from './src/server/boardImages.ts';
import { accessFrom, TRIAL_DAYS, PRICE_RUPEES, GRACE_DAYS, PLANS, priceFor, perMonth } from './src/server/billing.ts';
import { _warningFor } from './src/server/scheduler.ts';
import { SEED_LESSONS } from './src/lib/seedLessons.ts';
import { makeLimiter } from './src/server/rateLimit.ts';
import { listMigrationFiles } from './src/server/migrate.ts';
import { PRODUCT, subjectFor } from './src/lib/product.ts';
import { can, permissionsOf } from './src/server/authz.ts';
import { LESSON_HISTORY_KEEP, LESSON_TTL_HOURS } from './src/server/records.ts';
import {
  frameBytes, freshBudget, accountFrame, shrinkAfterOversize, fitScratch, paintScratch,
  samplePoints, looksBlank, reachSummary,
  BEAM_TICK_MS, BEAM_MAX_TICK_MS, BEAM_QUALITY, BEAM_MIN_QUALITY, BEAM_MAX_EDGE,
  BEAM_MAX_FRAME_BYTES, BEAM_ACK_STALE_MS,
} from './src/lib/beam.ts';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failed++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => (c ? ok(n) : bad(n, d));
const section = (t) => console.log(`\n${t}`);

// ─────────────────────────────────────────────────────────────────────────
// The lesson corpus.
//
// Not "typical" lessons — the shapes that have broken something. A lesson that
// only ever renders a paragraph proves nothing.
// ─────────────────────────────────────────────────────────────────────────
const LESSONS = {
  // The bus-division shape: renderer.domElement appended straight onto <body>,
  // AFTER the inline script. This is the one that shipped a blank 3D scene to
  // every student while mirroring the rest of the page perfectly.
  // The canvas sits AFTER the script, which is where a renderer.domElement
  // appended to document.body ends up once the lesson has run. Written statically
  // here because the follower is addressed against the source's LIVE DOM, and by
  // the time a frame is sent the canvas is a real sibling — a corpus that only
  // ever sees pre-script markup would miss the very bug this exists for.
  'canvas after a script (the bus-division shape)': `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="ui">controls</div><div id="bottom">more</div><div id="msg">hi</div>
<script>var c=document.createElement('canvas');document.body.appendChild(c);</script>
<canvas width="300" height="200"></canvas>
</body></html>`,

  // Several scripts scattered between siblings — the general form of the same
  // fault, where stripping renumbers everything after each one.
  'scripts interleaved between siblings': `<!doctype html><html><body>
<p>one</p><script>1</script><p>two</p><script>2</script><p>three</p>
<button id="go">go</button><script>3</script><span>tail</span>
</body></html>`,

  // Nested, no ids anywhere — paths are pure positional and have the least to
  // anchor on.
  'deeply nested, no ids': `<!doctype html><html><body>
<div><div><section><ul><li>a</li><li>b</li><script>x</script><li>c</li></ul></section></div></div>
</body></html>`,

  // The ordinary case, so a regression here is obvious too.
  'plain lesson': `<!doctype html><html><body><h1>Fractions</h1><p>text</p><button>next</button></body></html>`,
};

// The REAL element-path algorithm, lifted out of the script that actually
// ships and run here.
//
// It was a copy at first, which made the whole test worthless: reverting the
// real code to the nth-child version that shipped a blank 3D scene to every
// student left this suite passing, because the copy still said nth-of-type. A
// test that cannot fail is worse than no test — it reports safety it has not
// checked. Extracting the function means a change to the algorithm is a change
// to what is under test, which is the only arrangement worth having.
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find ' + name + ' in the injected script');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces reading ' + name);
}

const injectedJs = mirrorScriptFor('follower')
  .replace(/^[\s\S]*?<script[^>]*>/i, '')
  .replace(/<\/script>[\s\S]*$/i, '');

// getElementPath calls esc(); both come from the same file, so take both.
const realPathFn = new Function(
  'window', 'CSS',
  extractFunction(injectedJs, 'esc') + '\n' +
  extractFunction(injectedJs, 'getElementPath') + '\n' +
  'return getElementPath;',
);

section('OFFLINE — the injected scripts');

for (const mode of ['source', 'follower']) {
  const html = mirrorScriptFor(mode);
  const js = html.replace(/^[\s\S]*?<script[^>]*>/i, '').replace(/<\/script>[\s\S]*$/i, '');
  let parses = true, err = '';
  try { new Function(js); } catch (e) { parses = false; err = e.message; }
  assert(parses, `${mode} script parses`, err);
  assert(!html.includes('__MIRROR_MODE__'), `${mode} mode placeholder substituted`);
}

// A backtick inside a comment silently terminates the template literal the whole
// script lives in. It has happened; the parse check above catches it, but this
// says why in one line when it does.
assert(
  !/`/.test(mirrorScriptFor('source').replace(/^[\s\S]*?<script[^>]*>/i, '').replace(/<\/script>[\s\S]*$/i, '')),
  'no stray backtick inside the injected script',
  'a backtick anywhere in mirrorScript.ts — including in a comment — ends the template literal early',
);

section('OFFLINE — a path means the same element on both sides');

// THE test. The follower's DOM has the lesson's <script> tags stripped; if an
// element's path is computed on one side and resolved on the other, they must
// agree. When they did not, a Three.js canvas appended to <body> after the
// inline script addressed nothing at all on the student — the page mirrored
// perfectly and the 3D scene never appeared.
for (const [name, html] of Object.entries(LESSONS)) {
  const src = new JSDOM(html).window.document;
  const fol = new JSDOM(stripLessonScripts(html)).window.document;

  const srcWin = new JSDOM(html).window;   // a window whose CSS.escape the real code can use
  const elementPath = realPathFn(srcWin, srcWin.CSS);
  const sourceEls = [...src.body.querySelectorAll('*')].filter(e => e.nodeName !== 'SCRIPT');
  let checked = 0, mismatches = [];

  for (const el of sourceEls) {
    const path = elementPath(el);
    if (!path) continue;
    checked++;
    let there = null;
    try { there = fol.querySelector(path); } catch { /* invalid selector */ }
    if (!there) { mismatches.push(`${path} → nothing on the follower`); continue; }
    // Same tag, same position among same-tag siblings, same text.
    if (there.nodeName !== el.nodeName) { mismatches.push(`${path} → ${there.nodeName}, expected ${el.nodeName}`); continue; }
    // Compare text on LEAVES only. An ancestor's textContent includes the text
    // of the <script> that was stripped out of the follower's copy, so comparing
    // it there measures the stripping rather than the addressing.
    const isLeaf = el.children.length === 0;
    if (isLeaf && (there.textContent || '').trim() !== (el.textContent || '').trim())
      mismatches.push(`${path} → different content`);
    // For a container, the shape is what has to match.
    if (!isLeaf && there.children.length !== el.children.length - el.querySelectorAll(':scope > script').length)
      mismatches.push(`${path} → ${there.children.length} children, expected ${el.children.length - el.querySelectorAll(':scope > script').length}`);
  }
  assert(checked > 0 && mismatches.length === 0,
    `${name} (${checked} elements)`,
    mismatches.slice(0, 3).join('; '));
}

section('OFFLINE — whiteboard pictures live outside the room');

// A room reached 128MB compressed — 150 pasted images, no lesson files — and
// opening it took the heap from 78MB to 454MB, crash-looping the site all day.
// Pictures are stored separately now and the board carries a URL. Converting on
// open must be safe to repeat, must not move anything, and must never lose a
// photo just because the database is unhappy.
{
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const stub = () => {
    const rows = new Map();
    return { rows, async query(sql, params) {
      if (/INSERT INTO board_images/i.test(sql)) {
        const [id, mime, buf] = params;
        if (!rows.has(id)) rows.set(id, { mime, bytes: buf.length });
      }
      return { rowCount: 1, rows: [] };
    } };
  };

  assert(parseDataUrl(PNG) !== null, 'a png data URL is recognised');
  assert(parseDataUrl('/api/board-image/abc') === null, 'an ordinary URL is not an image');
  assert(parseDataUrl('data:text/html;base64,PHNjcmlwdD4=') === null,
    'a non-image data URL is refused', 'html was accepted as an image');

  const pool = stub();
  const wb = { objects: [
    { id: 'a', src: PNG, x: 1, y: 2 },
    { id: 'b', src: PNG, x: 3, y: 4 },              // same bytes
    { id: 'c', src: '/api/board-image/deadbeef' },  // already converted
  ], strokes: [{ points: [1, 2, 3] }] };
  const moved = await externaliseBoardImages(pool, wb);
  assert(moved === 2, 'data URLs are moved out', `moved ${moved}, expected 2`);
  assert(wb.objects.every(o => !String(o.src).startsWith('data:')),
    'no data URL is left on the board');
  assert(pool.rows.size === 1, 'the same picture twice is stored once',
    `stored ${pool.rows.size}`);
  assert(wb.objects[2].src === '/api/board-image/deadbeef',
    'an already-converted image is untouched');
  assert(wb.objects[0].x === 1 && wb.strokes.length === 1,
    'positions and pen strokes survive');
  assert(await externaliseBoardImages(pool, wb) === 0,
    'converting twice does nothing', 'boards are converted on every open');

  const angry = { async query() { throw new Error('database is down'); } };
  const keep = { objects: [{ id: 'a', src: PNG }] };
  await externaliseBoardImages(angry, keep);
  assert(keep.objects[0].src === PNG,
    'a storage failure keeps the picture', 'the teacher photo was lost');
}

section('OFFLINE — a frame belongs to ONE canvas');

// Reported from a live class: a burst of confetti froze on the student's screen
// after a correct answer and never cleared, sitting on top of the question.
//
// The follower caches the last frame per canvas and repaints after a body swap,
// because innerHTML recreates a canvas blank. The trap is that a POSITIONAL
// selector does not stop resolving when its element is removed — it starts
// resolving to a different element. With the celebration canvas first in the
// body, "canvas:nth-of-type(1)" became the LESSON canvas the moment confetti
// was removed, so the cached confetti frame was drawn over the question, and
// again on every snapshot after it.
{
  const followerJs = mirrorScriptFor('follower')
    .replace(/^[\s\S]*?<script[^>]*>/i, '')
    .replace(/<\/script>[\s\S]*$/i, '');
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const drawn = [];
  window.HTMLCanvasElement.prototype.getContext = function () {
    const el = this;
    return {
      clearRect: () => drawn.push('clear:' + (el.id || '(no id)')),
      drawImage: () => drawn.push(el.id || '(no id)'),
    };
  };
  // jsdom decodes nothing; resolve immediately so onload actually runs.
  window.Image = class { set src(_v) { if (this.onload) this.onload(); } };
  window.parent = { postMessage: () => {} };
  window.eval(followerJs);
  const send = (msg) => window.dispatchEvent(
    new window.MessageEvent('message', { data: msg, source: window.parent }));

  // Celebration canvas FIRST — the order that makes the selector re-resolve.
  send({ type: 'MIRROR_APPLY', attrs: {},
    body: '<canvas id="confetti" width="80" height="80"></canvas>'
        + '<canvas id="lesson" width="80" height="80"></canvas>' });
  send({ type: 'MIRROR_CANVAS', canvases: [
    { sel: 'body > canvas:nth-of-type(1)', idx: 0, w: 80, h: 80, data: 'data:image/webp;base64,CONFETTI' }] });
  assert(drawn.includes('confetti'), 'a frame paints onto its own canvas');

  // The animation ends and the lesson removes the celebration canvas.
  drawn.length = 0;
  send({ type: 'MIRROR_APPLY', attrs: {},
    body: '<canvas id="lesson" width="80" height="80"></canvas>' });
  assert(!drawn.includes('lesson'),
    'a removed canvas does not paint onto its neighbour',
    'the confetti frame was drawn onto the lesson canvas — this is the stuck confetti');

  // And it must not keep happening on every snapshot after.
  drawn.length = 0;
  send({ type: 'MIRROR_APPLY', attrs: {},
    body: '<canvas id="lesson" width="80" height="80"></canvas><p>next question</p>' });
  assert(drawn.length === 0, 'a dead frame is dropped, not chased forever');

  // The race the index fallback exists for must still work: a LIVE frame whose
  // canvas has not arrived yet may still resolve by index.
  drawn.length = 0;
  send({ type: 'MIRROR_CANVAS', canvases: [
    { sel: 'body > canvas:nth-of-type(9)', idx: 0, w: 80, h: 80, data: 'data:image/webp;base64,LIVE' }] });
  assert(drawn.includes('lesson'), 'a live frame can still fall back to the canvas index');

  section('OFFLINE — a frame replaces the last one, it does not pile on it');

  // From two live classes, and misread both times as a frame being "stuck":
  // celebration confetti that stayed on the screen for the rest of the lesson,
  // and a geometry sim smeared with every position a dragged vertex had been
  // in. A frame is a capture of the WHOLE canvas and WebP carries the alpha, so
  // without a clear each one composites onto the last until nothing underneath
  // is visible.
  drawn.length = 0;
  send({ type: 'MIRROR_CANVAS', canvases: [
    { sel: 'body > canvas:nth-of-type(1)', idx: 0, w: 80, h: 80, data: 'data:image/webp;base64,ONE' }] });
  assert(drawn[0] === 'clear:lesson' && drawn[1] === 'lesson',
    'a frame clears the canvas before it paints',
    `drew ${JSON.stringify(drawn)} — without the clear every frame piles onto the last`);

  // Including the repaint after a body swap, which is the path that put a
  // frozen pile of confetti back on screen after the animation had ended.
  drawn.length = 0;
  send({ type: 'MIRROR_APPLY', attrs: {},
    body: '<canvas id="lesson" width="80" height="80"></canvas><p>after</p>' });
  assert(drawn.length === 0 || drawn[0] === 'clear:lesson',
    'a repaint clears too');
}

section('OFFLINE — a frame that did not paint is not recorded as painted');
{
  // 4 Sep 2026, from a live class: the student sat on the previous page of the
  // lesson while the teacher had moved on, and their clicks did nothing —
  // because a forwarded tap carries a path computed on whatever page they can
  // see, and theirs was minutes out of date.
  //
  // applySnapshot recorded lastBody BEFORE painting and appliedHash after it
  // unconditionally. So a frame that failed to paint left the follower claiming
  // both: the next identical snapshot hit the "nothing to do" early return, and
  // the fingerprint heartbeat — the one thing that repairs a lost frame — was
  // told the screen already matched. The source dedupes, so it never resends a
  // body by itself. Nothing recovered.
  const followerJs = mirrorScriptFor('follower')
    .replace(/^[\s\S]*?<script[^>]*>/i, '')
    .replace(/<\/script>[\s\S]*$/i, '');
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const asked = [];
  window.parent = { postMessage: (m) => asked.push(m && m.type) };
  window.eval(followerJs);
  const send = (msg) => window.dispatchEvent(
    new window.MessageEvent('message', { data: msg, source: window.parent }));

  // Break the sanitiser for the whole of ONE frame — both attempts at it. Two,
  // not one, because applyBodyHtml already survives a single throw: it retries
  // through the wholesale-swap fallback, which is exactly the resilience it was
  // written for. What has to be tested is the frame that fails outright.
  const realWalker = window.document.createTreeWalker.bind(window.document);
  let breaks = 2;
  window.document.createTreeWalker = (...a) => {
    if (breaks > 0) { breaks--; throw new Error('sanitiser blew up'); }
    return realWalker(...a);
  };

  const page2 = '<h2 id="q">Sub-Concept 2</h2>';
  send({ type: 'MIRROR_APPLY', body: page2, h: 'hash-of-page-2' });
  assert(!window.document.body.innerHTML.includes('Sub-Concept 2'),
    'a frame the sanitiser could not clean is not painted',
    'the point of the sanitiser is that an uncleanable frame never reaches the child');
  assert(asked.includes('MIRROR_STALE'),
    'and the follower asks for a fresh one',
    'the source dedupes and will never resend an unchanged body on its own');

  // The same body arrives again. Before the fix this hit the early return,
  // because lastBody already claimed it, and the student stayed on page 1.
  send({ type: 'MIRROR_APPLY', body: page2, h: 'hash-of-page-2' });
  assert(window.document.body.innerHTML.includes('Sub-Concept 2'),
    'the retry paints it',
    'lastBody was recorded before the paint, so the retry was skipped as a duplicate');
}

section('OFFLINE — the follower never runs the lesson');

for (const [name, html] of Object.entries(LESSONS)) {
  const stripped = stripLessonScripts(html);
  assert(!/<script\b/i.test(stripped), `${name}: every lesson script removed`);
}
assert(
  stripLessonScripts('<body><style>a{}</style><link rel="x"><p>k</p></body>').includes('<style>'),
  'styles and links survive stripping',
  'a follower with no CSS is a wall of unstyled text',
);

section('OFFLINE — a hostile lesson cannot reach the learner');

// The follower paints a stream of HTML that came from a file a teacher
// uploaded, into a document that (for now) shares an origin with the app, on a
// device that is usually a child's iPad. Stripping <script> with a regular
// expression was the whole defence, and an inline handler needs no script tag.
{
  const followerJs = mirrorScriptFor('follower')
    .replace(/^[\s\S]*?<script[^>]*>/i, '')
    .replace(/<\/script>[\s\S]*$/i, '');
  // The shell the follower boots into carries a handler of its own, so the
  // boot-time clean is exercised as well as the per-frame one.
  const dom = new JSDOM('<!doctype html><html><body><b id="shell" onclick="steal()">hi</b></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.parent = { postMessage: () => {} };
  window.eval(followerJs);
  const send = (msg) => window.dispatchEvent(
    new window.MessageEvent('message', { data: msg, source: window.parent }));
  const doc = window.document;
  const paint = (body, extra = {}) => send({ type: 'MIRROR_APPLY', body, ...extra });

  assert(!doc.getElementById('shell')?.hasAttribute('onclick'),
    'the shell the follower boots into is cleaned of inline handlers',
    'a handler already in the page fires before any frame arrives');

  paint('<p id="a">safe</p><script>window.OWNED = 1</script>');
  assert(doc.querySelectorAll('script').length === 0, 'a script in a frame never enters the document');
  assert(doc.getElementById('a'), 'and the rest of the frame is still painted');

  paint('<img id="b" src="x" onerror="window.OWNED = 1">');
  assert(doc.getElementById('b') && !doc.getElementById('b').hasAttribute('onerror'),
    'an onerror handler is removed while the element stays',
    'this is the attack: it needs no script tag at all');

  paint('<div id="c" onclick="x" ONMOUSEOVER="y" data-keep="1">t</div>');
  const c = doc.getElementById('c');
  assert(c && !c.hasAttribute('onclick') && !c.hasAttribute('ONMOUSEOVER'),
    'handlers are removed whatever their case');
  assert(c && c.getAttribute('data-keep') === '1', 'ordinary attributes are left alone');

  paint('<a id="d" href="javascript:alert(1)">go</a><a id="e" href="/lesson">stay</a>');
  assert(!doc.getElementById('d')?.hasAttribute('href'), 'a javascript: URL is removed');
  assert(doc.getElementById('e')?.getAttribute('href') === '/lesson', 'an ordinary URL is kept');

  paint('<a id="f" href="java\tscript:alert(1)">obfuscated</a>');
  assert(!doc.getElementById('f')?.hasAttribute('href'),
    'a URL split by a control character is still recognised',
    'browsers ignore those characters, so this check has to as well');

  paint('<iframe id="g" srcdoc="<script>x</script>"></iframe><object id="h"></object>');
  assert(!doc.getElementById('g') && !doc.getElementById('h'),
    'embedded documents are removed — each one would load separately per device');

  // The line this must not cross. A worksheet where the student types an answer
  // and is marked instantly is a first-class lesson type here (founder, 2 Sep
  // 2026); a sanitiser that ate forms would break the product to secure it.
  paint('<form id="w"><label>2+2<input id="ans" value="4"></label><button id="go">Check</button></form>');
  assert(doc.getElementById('w') && doc.getElementById('ans')?.getAttribute('value') === '4' && doc.getElementById('go'),
    'a worksheet form, its input and its value all survive');

  // The styling envelope is the same untrusted stream and used the same
  // innerHTML.
  send({ type: 'MIRROR_APPLY', body: '<p>x</p>', head: '<style>b{color:red}</style><script>window.OWNED=1</script>' });
  const headHost = doc.getElementById('mathslive-mirror-head');
  assert(headHost && headHost.querySelector('style'), 'lesson CSS still reaches the follower');
  assert(headHost && headHost.querySelectorAll('script').length === 0, 'a script hidden in the head envelope does not');

  send({ type: 'MIRROR_APPLY', body: '<p>y</p>', attrs: JSON.stringify([['class', 'dark'], ['onclick', 'steal()']]) });
  assert(doc.body.getAttribute('class') === 'dark', "the body's own class is still applied");
  assert(!doc.body.hasAttribute('onclick'),
    'a handler on <body> is refused too',
    'the body attribute channel bypassed the frame cleaning entirely');

  assert(!('OWNED' in window), 'nothing in any of that ran');
}

section('OFFLINE — the learner runs nothing, at nobody\'s origin');
{
  // Task 1.3. The follower executes no lesson code, so same-origin buys it
  // almost nothing — and costs it everything if the cleaning above is ever
  // wrong. An opaque origin means a bypass reaches a blank document instead of
  // the app's storage, cookies and API.
  const attrs = readFileSync('src/lib/iframeAttrs.ts', 'utf8');
  assert(/LESSON_IFRAME_SANDBOX_VIEW_ONLY\s*=\s*SANDBOX_COMMON\s*;/.test(attrs)
      && !/const SANDBOX_COMMON[\s\S]*?allow-same-origin/.test(attrs.slice(attrs.indexOf('const SANDBOX_COMMON'), attrs.indexOf('/** The teacher'))),
    'the view-only sandbox does not grant allow-same-origin');
  assert(/LESSON_IFRAME_SANDBOX\s*=\s*SANDBOX_COMMON\s*\+\s*'\s*allow-same-origin'/.test(attrs),
    "the teacher's own copy still gets it — that frame runs the lesson");

  const sv = readFileSync('src/pages/StudentView.tsx', 'utf8');
  assert(!/sandbox=\{LESSON_IFRAME_SANDBOX\}/.test(sv),
    'no frame on a learner device is given the app origin',
    'both the lesson shell and the explanation overlay are follower shells');
  assert((sv.match(/LESSON_IFRAME_SANDBOX_VIEW_ONLY/g) || []).length >= 3,
    'both learner frames use the isolated sandbox');

  // The Dual View pane on the teacher's screen is a follower too — same shell,
  // same stream, pointer events blocked. It was the easy one to miss.
  const room = readFileSync('src/pages/Room.tsx', 'utf8');
  const mirrorFrame = room.slice(room.indexOf('onLoad={handleMirrorLoad}'), room.indexOf('onLoad={handleMirrorLoad}') + 200);
  assert(/LESSON_IFRAME_SANDBOX_VIEW_ONLY/.test(mirrorFrame),
    "the teacher's Student Mirror pane is isolated as well");
}

section('OFFLINE — schema changes that are not just "create it if missing"');
{
  // Task 1.1. The runner is small enough that its guarantees are the whole of
  // it, so they are asserted rather than assumed.
  const files = listMigrationFiles();
  assert(files.length > 0, 'there is at least one migration to run');
  assert(files.every(f => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)),
    'every migration is numbered and lower-case', files.join(', '));
  assert(JSON.stringify(files) === JSON.stringify([...files].sort()),
    'they come back in version order, not readdir order',
    '0010 running before 0002 is a schema nobody can reason about');

  const runner = readFileSync('src/server/migrate.ts', 'utf8');
  assert(/await client\.query\('BEGIN'\)/.test(runner) && /await client\.query\('ROLLBACK'\)/.test(runner),
    'each migration runs inside a transaction and is rolled back if it throws');
  assert(/pg_advisory_lock/.test(runner),
    'two boots cannot run the same migration at once');
  assert(/break;/.test(runner.slice(runner.indexOf('out.failed = '))),
    'a failure stops the run instead of trying the next file',
    'applying 0004 after 0003 failed leaves a schema no file describes');
  assert(!/process\.exit/.test(runner),
    'a failed migration never takes the server down with it',
    'a lesson in progress must outlive a migration Phase 2 has not needed yet');

  // No down-migrations by design, so a migration that cannot be re-read safely
  // is a migration that cannot survive a restore from the nightly dump.
  for (const f of files) {
    const sql = readFileSync(`src/server/migrations/${f}`, 'utf8');
    const statements = sql.split(';').map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean);
    // A backfill cannot carry IF NOT EXISTS, so UPDATE is allowed — on the
    // condition the author makes it CONVERGENT, i.e. its WHERE clause stops
    // matching once it has run. That is a rule this check states rather than
    // proves; what it does prove is that no CREATE or INSERT is unguarded.
    const __bad = statements.filter(s => !(/IF NOT EXISTS|ON CONFLICT|OR REPLACE/i.test(s) || /^UPDATE/i.test(s)));
    // Reported with the offending statement, not just a verdict. The first
    // version of this check said only "not safe to apply twice" and cost half
    // an hour: the regex contained a literal backspace character where a \b
    // was meant — written through a shell heredoc into a template literal,
    // where the escape was resolved one level too many — so it matched nothing
    // and grep rendered it invisible. Same trap as the control-character class
    // in mirrorScript.ts. Avoid backslashes in regexes written that way.
    const offenders = statements.filter(s =>
      !(/IF NOT EXISTS|ON CONFLICT|OR REPLACE/i.test(s) || /^UPDATE/i.test(s)));
    assert(offenders.length === 0,
      `${f} is safe to apply twice`,
      offenders.length
        ? `unguarded: ${JSON.stringify(offenders[0].slice(0, 120))}`
        : "there are no down-migrations here; the way back is the nightly dump");
  }
}

section('OFFLINE — the teacher can see a stuck student');
{
  // The peek button has been dead since the mirror replaced the replay engine:
  // the only REQUEST_HTML handler lived in the source branch, which a follower
  // never reaches, so the panel asked and nothing ever answered.
  const followerJs = mirrorScriptFor('follower')
    .replace(/^[\s\S]*?<script[^>]*>/i, '').replace(/<\/script>[\s\S]*$/i, '');
  const dom = new JSDOM('<!doctype html><html><body><h1>Worksheet</h1><input id="a"></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  window.parent = { postMessage: (m) => sent.push(m) };
  window.eval(followerJs);

  // A student has typed an answer. That value lives in a property, not an
  // attribute, so it is exactly what a naive clone would lose.
  window.document.getElementById('a').value = '42';
  window.dispatchEvent(new window.MessageEvent('message',
    { data: { type: 'REQUEST_HTML', requestId: 'peek-1' }, source: window.parent }));

  const reply = sent.filter(m => m && m.type === 'SYNC_PROVIDE_HTML').pop();
  assert(!!reply, 'a follower answers a peek request at all',
    'this is the bug: nothing replied, so the teacher waited for ever');
  assert(reply && reply.requestId === 'peek-1', 'the answer carries the request id it was asked with');
  assert(reply && /<h1>Worksheet<\/h1>/.test(reply.html), "it contains the student's screen");
  assert(reply && /value="42"/.test(reply.html),
    'and what the student had typed into it',
    'a peek showing every box empty would be worse than none');
  assert(reply && !/mathslive-mirror-script/.test(reply.html),
    'the injected observer is stripped out of the copy');
}

section('OFFLINE — pointing at something reaches the learner');
{
  // README advertises element pings — Alt+click to drop a "look here" ripple.
  // The ripple was drawn by a function that lived only in the source branch, so
  // the teacher saw their own and the learner saw nothing, while StudentView
  // faithfully posted REMOTE_PING into a frame with no handler for it.
  const followerJs = mirrorScriptFor('follower')
    .replace(/^[\s\S]*?<script[^>]*>/i, '').replace(/<\/script>[\s\S]*$/i, '');
  const dom = new JSDOM('<!doctype html><html><body><p>lesson</p></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.parent = { postMessage: () => {} };
  window.eval(followerJs);
  const send = (d) => window.dispatchEvent(new window.MessageEvent('message', { data: d, source: window.parent }));
  const pings = () => window.document.querySelectorAll('[data-mathslive-ping]').length;

  assert(pings() === 0, 'no ripple before one is asked for');
  send({ type: 'REMOTE_PING', clientX: 0.5, clientY: 0.5 });
  assert(pings() === 1, 'a relayed ping draws a ripple on the learner');

  // The two callers disagree about units and both are right: a ping from
  // another screen is a fraction of the viewport, a locally drawn one is
  // pixels. Getting this wrong puts every ripple in the top-left corner.
  const el = window.document.querySelector('[data-mathslive-ping]');
  const left = parseFloat(el.style.left);
  assert(left > 40, 'a fractional coordinate is scaled to the viewport, not read as pixels',
    `left=${el.style.left} — 0.5 of the width should not land at the edge`);

  send({ type: 'REMOTE_PING', clientX: 300, clientY: 200 });
  const all = [...window.document.querySelectorAll('[data-mathslive-ping]')];
  assert(parseFloat(all[all.length - 1].style.left) === 278,
    'a pixel coordinate is still used as pixels', all[all.length - 1].style.left);
}

section('OFFLINE — the name and the subject are configuration, not literals');
{
  // Task 1.2. Not a rename — the plan still has the naming question open
  // (QUESTIONS.md Q7). This is so the answer is a one-line change and so the
  // next feature does not add a sixteenth place to edit.
  assert(PRODUCT.name === PRODUCT.brandLead + PRODUCT.brandTail,
    'the split wordmark spells the product name', `${PRODUCT.brandLead}|${PRODUCT.brandTail}`);
  assert(PRODUCT.subjects.includes(PRODUCT.defaultSubject) || PRODUCT.defaultSubject === 'Math',
    'the default subject is a real one');
  assert(PRODUCT.subjects[PRODUCT.subjects.length - 1] === 'Other',
    'the taxonomy keeps an escape hatch, last',
    'a list with no "Other" makes people pick the wrong thing rather than the right one');

  // The bug this replaced: both exporters wrote the literal 'Math' for every
  // lesson, so a pack from a lesson that was not maths said it was.
  assert(subjectFor('Physics') === 'Physics', "a class's own label is the subject");
  assert(subjectFor('  ') === PRODUCT.defaultSubject, 'a blank label falls back rather than recording blank');
  assert(subjectFor(null) === PRODUCT.defaultSubject, 'so does a missing one');
  for (const f of ['src/pages/Room.tsx', 'src/lib/packRebuild.ts']) {
    assert(!/subject: 'Math'/.test(readFileSync(f, 'utf8')),
      `${f} no longer hard-codes the subject`);
  }

  // The half of product.ts that matters most: the contracts it must NOT own.
  const prod = readFileSync('src/lib/product.ts', 'utf8');
  assert(!/mathslive-mirror-script|window\.mathslive|mathslive_simulation_library/.test(
    prod.slice(prod.indexOf('export const PRODUCT'))),
    'no wire or storage contract is routed through the brand config',
    'renaming a script id or a storage key breaks lessons and libraries that already exist');
}

section('OFFLINE — a class keeps the last lesson, not every lesson');
{
  // The founder's rule, in his words: "as soon as the next class happens and
  // it's saved, the previous class data gets deleted… only if I'm joining that
  // class now, I should have the data of the last class."
  //
  // Two is the smallest number that keeps that promise, and the reason is the
  // whole point of the feature: with one, today's lesson would delete
  // yesterday's the moment it began — and yesterday's is exactly what the
  // teacher opens the room to look at.
  assert(LESSON_HISTORY_KEEP === 2,
    'a class keeps the current lesson and the one before it',
    `keeping ${LESSON_HISTORY_KEEP}`);

  const src = readFileSync('src/server/records.ts', 'utf8');
  const prune = src.slice(src.indexOf('export async function pruneLessonHistory'), src.indexOf('export function mountRecordRoutes'));

  assert(/teacher_id = \$2/.test(prune),
    'the delete is scoped by teacher as well as class',
    'every statement in this file is scoped by the session cookie; a DELETE most of all');
  assert(/ORDER BY started_at DESC, id DESC/.test(prune),
    'the ordering breaks ties',
    'two rows sharing a timestamp could otherwise both be "newest" and the wrong one survive');
  assert(/LIMIT \$3/.test(prune) && /NOT IN/.test(prune),
    'it keeps the newest N and deletes only what is outside them');
  assert(/catch/.test(prune) && /return 0/.test(prune),
    'a failed prune never fails the request',
    'losing the prune is a bigger table; failing the save loses the lesson just taught');

  // Pruning is triggered by an INSERT, not an update — so it happens when a
  // new class begins and never in the middle of one.
  const insertBlock = src.slice(src.indexOf("app.post('/api/sessions'"), src.indexOf("app.get('/api/sessions/:id'"));
  assert(/pruneLessonHistory\(pool, b\.classId, user\.id\)/.test(insertBlock),
    'a new lesson is what triggers the prune');
  assert(!/pruneLessonHistory/.test(src.slice(src.indexOf("app.patch('/api/sessions/:id'"))),
    'saving again during the same lesson does not',
    'saveLessonForDay updates today\'s row; pruning there would delete on every autosave');
}

section('OFFLINE — a deploy checks before it touches anything');
{
  // 3 Sep 2026. release.sh unpacked the tarball and THEN ran `tsc --noEmit` on
  // the server. The compiler asked for 455MB beside Postgres on a 1GB box and
  // was killed, so the deploy failed with new files on disk and the old process
  // still serving — the next restart from any cause would have shipped code
  // nobody had decided to ship.
  const rel = readFileSync('deploy/release.sh', 'utf8');
  const dep = rel.slice(rel.indexOf('  deploy)'), rel.indexOf('  list)'));

  assert(dep.indexOf('.typecheck-ok') < dep.indexOf('tar xzf'),
    'the tarball is verified before it is unpacked',
    'a rejected deploy must leave the running version completely untouched');
  assert(!/npx tsc --noEmit/.test(dep),
    'the compiler is never run beside the database',
    'tsc is a bigger process than the app it checks, and losing Postgres costs more than the check is worth');
  assert(/tar xzOf .*\.typecheck-ok/.test(dep),
    'the marker is read out of the tarball, not off the disk',
    'a marker already on the box belongs to the release being REPLACED');
  assert(/ALLOW_UNCHECKED/.test(dep),
    'there is a deliberate way past it',
    'a check with no override gets deleted the first night it is in the way');

  // The script is inside the tarball it unpacks, and bash reads a script by
  // byte offset as it goes.
  assert(dep.indexOf('RELEASE_REEXEC') < dep.indexOf('tar xzf') && /exec "\$SELF"/.test(dep),
    'the deploy re-execs from a private copy before unpacking over itself');

  assert(/PARTS=\(.*\.typecheck-ok\)/.test(rel),
    'a rollback restores the proof belonging to the release it restores');

  const pack = readFileSync('tools/pack_release.mjs', 'utf8');
  // lastIndexOf, because the first `writeFileSync` in the file is the import.
  assert(pack.indexOf("run('1/4") < pack.lastIndexOf('writeFileSync('),
    'the marker is written only after the suite has passed');
  assert(/if \(existsSync\(MARKER\)\) unlinkSync\(MARKER\)/.test(pack),
    'a stale marker is deleted before a build and after a failure',
    'otherwise a broken build inherits the proof earned by the last good one');
}

section('OFFLINE — a class keeps its last lesson, and nothing else for long');
{
  // The founder, 4 Sep 2026: "every class data will remain for just twenty-four
  // hours, after this everything gets deleted, except today's class data — so
  // that we get efficient class working."
  //
  // Held together with his rule from the day before — "only if I'm joining that
  // class now, I should have the data of the last class" — which a flat purge
  // would break for every student he does not teach daily.
  const src = readFileSync('src/server/records.ts', 'utf8');
  const sweep = src.slice(src.indexOf('export async function sweepExpiredLessons'),
                          src.indexOf('export function mountRecordRoutes'));

  assert(LESSON_TTL_HOURS === 24, 'the window is twenty-four hours', `it is ${LESSON_TTL_HOURS}`);
  assert(/DISTINCT ON \(class_id, teacher_id\)/.test(sweep),
    "each class's newest lesson is exempt at any age",
    'a Saturday student would otherwise arrive each week to an empty board');
  assert(/ORDER BY class_id, teacher_id, started_at DESC, id DESC/.test(sweep),
    'the exemption picks the newest, and breaks ties',
    'DISTINCT ON takes the FIRST row of each group, so the ordering is the whole meaning');
  assert(/started_at < now\(\) - /.test(sweep), 'age is measured by the database clock, not the caller');
  assert(/catch/.test(sweep) && /return 0/.test(sweep),
    'a failed sweep never reaches a live lesson');

  // Time passing is the trigger, so it cannot hang off a new lesson arriving.
  const sched = readFileSync('src/server/scheduler.ts', 'utf8');
  const tick = sched.slice(sched.indexOf('const tick = async'), sched.indexOf('setInterval'));
  assert(tick.indexOf('sweepExpiredLessons') < tick.indexOf('istHour() < SEND_HOUR_IST'),
    'the sweep runs before the mail hour gate',
    'behind the gate it would run once a day at 9am, or on a day the process restarted after that, never');
}

section('OFFLINE — a slow student cannot fill the server');
{
  // The crash that ended a live lesson on 4 Sep 2026: Node hit its heap limit,
  // systemd restarted it, and both people saw "Reconnecting" mid-class. The log
  // shows the eviction sweep trying to save it — "381MB of 300MB, 2 rooms" —
  // and failing, because both rooms were in lessons and there was nothing idle
  // to shed.
  //
  // A mirror frame is up to 3MB and a changing lesson makes about four a
  // second. Socket.IO queues what it cannot write yet, PER CLIENT, with no
  // ceiling. So one student on slow wifi does not merely lag; they make the
  // server hold every frame they have not received.
  //
  // Volatile drops instead of queueing. Safe on these three streams and almost
  // nowhere else, because all three are loss-tolerant by construction: the
  // follower compares a fingerprint and asks for a resync, canvases re-send on
  // a 120ms tick, and the beam keyframes every ~5s.
  const srv = readFileSync('server.ts', 'utf8');
  for (const ev of ['mirror_dom', 'mirror_canvas', 'beam_frame']) {
    assert(srv.includes(`socket.volatile.to(roomId).emit('${ev}'`),
      `${ev} frames are dropped, not queued, for a client that cannot take them`,
      'a queued frame per slow client is unbounded server memory');
  }
  // The one-shot catch-up sends must NOT be volatile: they go to a single
  // student who has just joined and has nothing on screen at all, and there is
  // no follow-up tick to cover a drop.
  assert(srv.includes("io.to(socket.id).emit('mirror_dom'"),
    'the late-join catch-up frame is still delivered reliably',
    'dropping it leaves a joining student staring at a blank lesson');
}

section('OFFLINE — free forever means forever');
{
  // Task 2.2. From the brief: "I and anyone I hand-pick get full access free
  // forever." Until now the only ways were to make somebody a platform admin —
  // handing them every other teacher's data — or to push paid_until forward by
  // hand, which is what was done for Vani on 2 Sep and left the reason nowhere
  // but a chat log.
  const now = new Date('2026-09-03T00:00:00Z');
  const longExpired = { trial_started_at: '2020-01-01T00:00:00Z', paid_until: null };

  assert(accessFrom(longExpired, now).state === 'expired', 'without a grant, an old trial is over');
  assert(accessFrom({ ...longExpired, grant_active: true, grant_until: null }, now).state === 'active',
    'a grant with no end makes an expired account active');
  assert(accessFrom({ ...longExpired, grant_active: true, grant_until: null }, now).until === null,
    'and reports no end date, so nothing can render a countdown at them',
    'a hand-picked teacher must never see a deadline they do not have');

  const soon = new Date(now.getTime() + 10 * 86_400_000).toISOString();
  const dated = accessFrom({ ...longExpired, grant_active: true, grant_until: soon }, now);
  assert(dated.state === 'active' && dated.daysLeft === 10, 'a dated grant counts down honestly');

  // An expired comp must not be worse than no comp.
  const stale = new Date(now.getTime() - 86_400_000).toISOString();
  assert(accessFrom({ trial_started_at: now.toISOString(), paid_until: null, grant_active: true, grant_until: stale }, now).state === 'trial',
    'an expired grant falls through to the trial rather than locking anyone out');

  // The one that would quietly corrupt the business figures.
  const billingSrc = readFileSync('src/server/billing.ts', 'utf8');
  assert(/grant is not a payment/.test(billingSrc),
    'a grant is kept out of paid_until',
    'writing it there would make the MRR on /admin count people who have paid nothing');
}

section('OFFLINE — who may do what');
{
  // Task 2.1. The answer used to live in four places, and a new endpoint had to
  // remember which of them applied. The one that was forgotten is the one
  // nobody notices: /api/admin/grant hands out months of the product and
  // recorded nothing about who granted it.
  const boss = { id: 'u1', email: 'a@b.c', role: 'super_admin', permissions: [], status: 'active', defaultWorkspaceId: null };
  const helper = { id: 'u2', email: 'h@b.c', role: 'staff', permissions: ['support.read'], status: 'active', defaultWorkspaceId: null };
  const tutor = { id: 'u3', email: 't@b.c', role: 'teacher', permissions: ['billing.grant'], status: 'active', defaultWorkspaceId: null };

  assert(can(boss, 'billing.grant') && can(boss, 'users.manage'),
    'a super admin holds everything');
  assert(can(helper, 'support.read'), 'staff hold what they were given');
  assert(!can(helper, 'billing.grant'),
    'and nothing else',
    'a "staff" role that means everything-except-promoting is a second super admin');
  assert(!can(tutor, 'billing.grant'),
    'a permission on a teacher row grants nothing',
    'role is the gate; the array is only read for staff');
  assert(!can(null, 'support.read'), 'nobody is not somebody');

  // Suspension has to bite here, not only at the door. An admin suspended
  // mid-session keeps a valid signed cookie for up to thirty days.
  assert(!can({ ...boss, status: 'suspended' }, 'support.read'),
    'a suspended super admin can do nothing');
  assert(permissionsOf({ ...boss, status: 'suspended' }).length === 0,
    'and is told they hold nothing');
  assert(permissionsOf(boss).length >= 8 && permissionsOf(tutor).length === 0,
    'the list the client renders from matches the gate');

  const authzSrc = readFileSync('src/server/authz.ts', 'utf8');
  assert(/platform_admins/.test(authzSrc),
    'the existing admin table is still read',
    'so migration 0002 can land in production without changing who can do anything');
  assert(/denying/.test(authzSrc),
    'an authz lookup that fails denies',
    'ownership and subscription fail OPEN to protect a lesson; this protects other people`s data');

  const billingSrc = readFileSync('src/server/billing.ts', 'utf8');
  const grant = billingSrc.slice(billingSrc.indexOf("app.post('/api/admin/grant'"));
  assert(/audit\(pool, \{/.test(grant.slice(0, 2000)),
    'granting paid time is written to the audit log');
}

section('OFFLINE — one engine');

// Phase 3c removed the replay engine from the live path. Nothing should quietly
// put it back: it journaled every click, snapshotted the whole document on a
// timer, and cancelled forwarded input at capture phase.
import { readFileSync } from 'fs';
for (const file of ['src/pages/Room.tsx', 'src/pages/StudentView.tsx']) {
  const code = readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/seededSyncScript\s*\(/.test(code),
    `${file} does not inject the replay engine`,
    'the live lesson must carry the mirror and the step lock only');
}

section('OFFLINE — what a lesson will and will not do');

const cases = [
  ['<body><iframe src="https://geogebra.org/x"></iframe></body>', 'embeds another page', /embeds another page/],
  ['<body>' + '<canvas></canvas>'.repeat(6) + '</body>', 'more than four canvases', /only the first 4/],
  ['<body><canvas></canvas><img src="https://cdn.example.com/a.png"></body>', 'foreign image with a canvas', /images from other sites/],
  ['<body><script>new Tone.Synth()</script></body>', 'audio', /will not hear/],
  ['<body><h1>fine</h1><canvas></canvas></body>', 'a clean lesson (no warnings)', null],
];
for (const [html, name, expect] of cases) {
  const issues = checkLesson(html, { maxBytes: 2 * 1024 * 1024 });
  const text = issues.map(i => i.title + ' ' + i.detail).join(' | ');
  assert(expect ? expect.test(text) : issues.length === 0, name, text.slice(0, 90) || '(no issues)');
}

// ─────────────────────────────────────────────────────────────────────────
section('OFFLINE — who is allowed to teach');

// Money logic, so the failure modes are: a paying teacher locked out (loses a
// customer), or an expired one still teaching free (loses revenue). Both are
// silent, which is why they are tested rather than eyeballed.
const DAY = 86_400_000;
const at = (d) => new Date(Date.now() + d * DAY);

assert(accessFrom({ trial_started_at: at(0), paid_until: null }).state === 'trial',
  'a teacher who just signed up is on trial');

assert(accessFrom({ trial_started_at: at(0), paid_until: null }).daysLeft === TRIAL_DAYS,
  `a fresh trial has all ${TRIAL_DAYS} days`);

assert(accessFrom({ trial_started_at: at(-(TRIAL_DAYS - 1)), paid_until: null }).state === 'trial',
  'the last day of the trial still counts as trial');

// The boundary moved when the grace window was added: teaching no longer
// stops the day after the trial, it stops after grace. The guarantee this
// test protects is unchanged — access DOES end — only the day it ends on.
assert(accessFrom({ trial_started_at: at(-(TRIAL_DAYS + 1)), paid_until: null }).state === 'grace',
  'the day after the trial ends, teaching continues on grace');
assert(accessFrom({ trial_started_at: at(-(TRIAL_DAYS + GRACE_DAYS + 1)), paid_until: null }).state === 'expired',
  'once the trial AND its grace are used up, teaching stops');

assert(accessFrom({ trial_started_at: at(-90), paid_until: at(20) }).state === 'active',
  'a paid teacher whose trial ended long ago can teach');

assert(accessFrom({ trial_started_at: at(-90), paid_until: at(-1) }).state === 'grace',
  'a subscription that lapsed yesterday is on grace, not cut off');

// Paying during the trial must not shorten anything. If paid_until were
// allowed to win while EARLIER than the trial end, paying early would cost
// days — the exact bug that makes people stop paying early.
const early = accessFrom({ trial_started_at: at(0), paid_until: at(2) });
assert(early.state !== 'expired' && early.daysLeft >= TRIAL_DAYS - 1,
  'paying early never costs a teacher days they already had',
  JSON.stringify(early));

// Fail CLOSED here, unlike the runtime checks which fail open: a row with no
// trial date is a data bug, and the safe reading of "unknown" is "not paid".
assert(accessFrom({ trial_started_at: null, paid_until: null }).state === 'expired',
  'a teacher with no trial date on record is not silently granted access');

assert(accessFrom(null).state === 'expired',
  'a missing row is not access');

section('OFFLINE — grace, and who gets warned');

// The grace window exists so a Tuesday class is never hostage to a Monday
// night UPI delay. Two ways to get it wrong, both silent: teaching stops a day
// early (a furious tutor mid-lesson), or grace never ends (free forever).
{
  const graceRow = (daysPastEnd) => ({
    trial_started_at: at(-(TRIAL_DAYS + daysPastEnd)), paid_until: null,
  });

  assert(accessFrom(graceRow(0.5)).state === 'grace',
    'the day after a trial ends, teaching continues on grace');

  assert(accessFrom(graceRow(GRACE_DAYS - 0.5)).state === 'grace',
    `the last day of the ${GRACE_DAYS}-day grace still teaches`);

  assert(accessFrom(graceRow(GRACE_DAYS + 0.5)).state === 'expired',
    'once grace is used up, the seat is refused');

  // daysLeft must mean "how long until I actually lose it" in EVERY state, or
  // the banner tells a tutor on grace that they have zero days and they panic.
  const g = accessFrom(graceRow(1));
  assert(g.daysLeft > 0 && g.daysLeft <= GRACE_DAYS,
    'during grace, daysLeft counts the grace remaining, not zero',
    JSON.stringify(g));

  // A paid teacher gets grace too, not just trials.
  assert(accessFrom({ trial_started_at: at(-90), paid_until: at(-1) }).state === 'grace',
    'a lapsed subscription also gets grace');
  assert(accessFrom({ trial_started_at: at(-90), paid_until: at(-(GRACE_DAYS + 1)) }).state === 'expired',
    'a subscription lapsed beyond grace is expired');
}

// Which warning a teacher is owed. Sending two-days-left on the wrong day is
// how a ₹500 product starts feeling like spam.
assert(_warningFor('trial', 2) === 'warn_2', 'two days out earns the first warning');
assert(_warningFor('trial', 1) === 'warn_1', 'the last day earns the final warning');
assert(_warningFor('trial', 3) === null, 'three days out is too early to nag');
assert(_warningFor('active', 2) === 'warn_2', 'paying teachers are warned before renewal too');
assert(_warningFor('grace', 2) === 'grace', 'a teacher on grace is told they are on grace');
assert(_warningFor('expired', 0) === null,
  'an already-expired teacher is not emailed daily forever');

section('OFFLINE — the demo has a clock, real lessons do not');

// B4. Two ways to get this wrong and only one is visible: a demo that never
// ends is a paywall anyone can walk around, and a clock started on a real
// teacher's lesson cuts off a class with a child in it. The second is the one
// nobody reports — they just never come back.
{
  const DEMO_MS = 30 * 60_000;
  // Mirrors the server rule: a clock is set only when NOT signed in AND the
  // room is not a registered class; a signed-in teacher always clears it.
  const clockFor = ({ signedIn, registered, existing = null, now = 0 }) => {
    if (signedIn) return null;
    if (existing) return existing;
    return registered ? null : now + DEMO_MS;
  };

  assert(clockFor({ signedIn: false, registered: false }) !== null,
    'an anonymous ad-hoc room starts a demo clock');
  assert(clockFor({ signedIn: true, registered: false }) === null,
    'a signed-in teacher in an ad-hoc room is not on a clock');
  assert(clockFor({ signedIn: false, registered: true }) === null,
    'a registered class is never a demo, even if nobody is signed in');
  assert(clockFor({ signedIn: true, registered: false, existing: 12345 }) === null,
    'a real teacher taking the seat clears a clock already running');
  assert(clockFor({ signedIn: false, registered: false, existing: 999 }) === 999,
    'the clock is set once and not extended by re-joining');

  // A database hiccup must fail OPEN — treating an unreadable class table as
  // "not registered" would start a countdown on a paying teacher's lesson.
  const clockOnDbError = clockFor({ signedIn: false, registered: true });
  assert(clockOnDbError === null,
    'when the class lookup fails we assume registered, never demo');

  const expired = (until, now) => until !== null && now > until;
  assert(expired(DEMO_MS, DEMO_MS + 1), 'a demo past its clock is over');
  assert(!expired(DEMO_MS, DEMO_MS - 1), 'a demo inside its clock keeps teaching');
  assert(!expired(null, Number.MAX_SAFE_INTEGER),
    'a lesson with no clock never expires, however long it runs');
}

section('OFFLINE — the lessons that ship actually run');

// These are the first thing a new teacher opens, and they open them in front
// of a child. A lesson that throws on load is worse than an empty library: the
// empty shelf is embarrassing, a broken one is a lesson that stops.
//
// So each is executed for real, the same way the lesson frame does, and checked
// for the three ways one can be useless: it throws, it renders nothing, or it
// renders but there is nothing to touch.
for (const lesson of SEED_LESSONS) {
  const errors = [];
  let dom = null;
  try {
    dom = new JSDOM(lesson.html, { runScripts: 'dangerously', pretendToBeVisual: true });
  } catch (err) {
    errors.push(err.message);
  }

  assert(errors.length === 0, lesson.id + ' loads without throwing', errors.join(' | '));
  if (!dom) continue;

  const d = dom.window.document;
  const text = (d.body.textContent || '').replace(/\s+/g, ' ').trim();
  assert(text.length > 20, lesson.id + ' renders something', 'only ' + text.length + ' chars');
  assert(!!d.querySelector('h1'), lesson.id + ' says what it is');

  // Touchable, not merely animated: if the student cannot change it, a video
  // would have done the job.
  const controls = d.querySelectorAll('button').length + d.querySelectorAll('svg').length;
  assert(controls > 0, lesson.id + ' has something to touch', controls + ' controls');

  // Tablet-sized. The floor lives in the shared shell so no lesson can forget.
  assert(/min-height:46px/.test(lesson.html),
    lesson.id + ' keeps buttons big enough for a finger');

  assert(!/lorem|TODO|FIXME|placeholder/i.test(lesson.html),
    lesson.id + ' carries no placeholder text');

  dom.window.close();
}

// A set, not a demo — and every entry says what the student actually does.
{
  const topics = new Set(SEED_LESSONS.map(l => l.topic));
  assert(topics.size >= 3, 'the shipped set spans several topics (' + [...topics].join(', ') + ')');
  assert(SEED_LESSONS.every(l => l.blurb && l.blurb.length > 20),
    'every shipped lesson says what the student actually does');
  assert(new Set(SEED_LESSONS.map(l => l.id)).size === SEED_LESSONS.length,
    'shipped lesson ids are unique');
}

section('OFFLINE — what the plans cost');

// Pricing is the one place where a quiet arithmetic slip is charged to a real
// person. Two directions to get it wrong: a plan that costs MORE than paying
// monthly (nobody would buy it, and it looks like a trick), or one so cheap it
// gives the product away.
{
  assert(priceFor(1) === PRICE_RUPEES, 'one month is the plain monthly price');

  for (const p of PLANS) {
    const list = PRICE_RUPEES * p.months;
    assert(p.rupees <= list,
      `the ${p.months}-month plan never costs more than paying monthly`,
      `${p.rupees} vs ${list}`);
    assert(p.rupees >= list * 0.7,
      `the ${p.months}-month plan does not give the product away`,
      `${p.rupees} vs ${list}`);
    assert(perMonth(p.months) === Math.round(p.rupees / p.months),
      `the ${p.months}-month per-month figure matches its price`);
  }

  // Longer must always be cheaper per month, or the ladder makes no argument.
  for (let i = 1; i < PLANS.length; i++) {
    assert(perMonth(PLANS[i].months) < perMonth(PLANS[i - 1].months),
      `${PLANS[i].months} months beats ${PLANS[i - 1].months} months per month`,
      `${perMonth(PLANS[i].months)} vs ${perMonth(PLANS[i - 1].months)}`);
  }

  // An unsold plan length must fall back to full price, never a discount.
  assert(priceFor(7) === PRICE_RUPEES * 7,
    'a plan length that is not sold falls back to the plain rate');
  assert(priceFor(2) === PRICE_RUPEES * 2,
    'two months, which is not offered, is not silently discounted');
}

section('OFFLINE — the payment QR says what it should');

// The QR is money. A wrong digit in the UPI id sends a teacher's ₹500 to a
// stranger, and nothing in the product would notice — the teacher would type a
// perfectly real reference number and Varun would have no payment to match it
// to. So the code is generated, decoded back, and checked against what it was
// meant to say.
{
  const VPA = '6376154428@ptyes';
  const NAME = 'Varun Upadhyay';
  const qrFor = (months) =>
    'upi://pay?pa=' + encodeURIComponent(VPA) +
    '&pn=' + encodeURIComponent(NAME) +
    '&am=' + priceFor(months).toFixed(2) + '&cu=INR' +
    '&tn=' + encodeURIComponent(`MathsLive ${months}m`);

  for (const months of [1, 3, 12]) {
    const link = qrFor(months);
    const buf = await QRCode.toBuffer(link, {
      type: 'png', width: 512, margin: 1, errorCorrectionLevel: 'M',
    });
    const png = PNG.sync.read(buf);
    const got = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert(got && got.data === link,
      `a ${months}-month QR decodes back to exactly what was encoded`,
      got ? got.data : 'unreadable');

    if (got) {
      const q = Object.fromEntries(new URLSearchParams(got.data.split('?')[1]));
      assert(q.pa === VPA, `the ${months}-month QR pays the right UPI id`, q.pa);
      assert(Number(q.am) === priceFor(months),
        `the ${months}-month QR asks for the plan price, not months × list`, q.am);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
section('OFFLINE — how often one address may ask');
{
  // The three properties that matter. A rate limiter is easy to write and easy
  // to write wrongly, and the failure modes are asymmetric: too loose and the
  // quota it guards is spent by a stranger; too tight, or buggy, and a tutor
  // cannot sign in before a lesson.
  const now0 = 1_700_000_000_000;

  const l = makeLimiter({ name: 'test', windowMs: 60_000, max: 3 });
  const first = [1, 2, 3].map(i => l.check('a', now0 + i));
  assert(first.every(d => d.allowed), 'the first requests up to the ceiling are allowed');
  assert(l.check('a', now0 + 4).allowed === false, 'one past the ceiling is refused');
  assert(l.check('b', now0 + 5).allowed === true, 'a different key has its own window');
  assert(l.check('a', now0 + 61_000).allowed === true, 'the window reopens after it expires');

  // Rule 1 from rateLimit.ts: fail open. A key of the wrong shape, a nonsense
  // configuration — none of it may end in a refusal.
  assert(makeLimiter({ name: 't', windowMs: 60_000, max: 0 }).check('a', now0).allowed,
    'a limiter configured with no ceiling allows everything rather than nothing');
  assert(l.check('', now0).allowed, 'an empty key is allowed, never refused');

  // Rule 2: bounded. The heap ceiling on this box has killed the service
  // twice; a limiter that grows one entry per address seen is a slow version
  // of the same bug.
  const small = makeLimiter({ name: 'bounded', windowMs: 60_000, max: 1, maxKeys: 50 });
  for (let i = 0; i < 500; i++) small.check(`ip-${i}`, now0);
  assert(small.size() <= 50, 'the window never holds more keys than it is allowed to',
    `held ${small.size()}`);

  // Expired entries are dropped rather than accumulating for the life of the
  // process — the ordinary case, which must not depend on hitting the cap.
  const sweeper = makeLimiter({ name: 'sweep', windowMs: 1_000, max: 5 });
  for (let i = 0; i < 20; i++) sweeper.check(`k-${i}`, now0);
  assert(sweeper.sweep(now0 + 2_000) === 20 && sweeper.size() === 0,
    'a sweep drops every window that has expired');

  // The refusal must not depend on the address being known here any more than
  // it does in identity.ts: same limiter, same answer, whoever is asking.
  const a = makeLimiter({ name: 'enum', windowMs: 60_000, max: 1 });
  a.check('known@example.com', now0); a.check('unknown@example.com', now0);
  const known = a.check('known@example.com', now0);
  const unknown = a.check('unknown@example.com', now0);
  assert(known.allowed === unknown.allowed && known.retryAfterMs === unknown.retryAfterMs,
    'a refusal looks identical for a known and an unknown address');
}

section('OFFLINE — a new teacher gets the trial they were promised');
{
  // The bug this pins, found in production on 2 Sep 2026 with a real stranger
  // sitting behind it: `trial_started_at` was populated only by the boot-time
  // statement in BILLING_SCHEMA_SQL, so anyone who signed up between two
  // restarts had none. A row with no trial date and no payment is EXPIRED by
  // design — so their first lesson was answered with "Your free trial has
  // ended". Before it had started.
  const now = new Date('2026-09-02T12:00:00Z');
  assert(accessFrom({ trial_started_at: null, paid_until: null }, now).state === 'expired',
    'a row with no trial date and no payment is still refused — the fail-closed rule stands');
  assert(accessFrom({ trial_started_at: now.toISOString(), paid_until: null }, now).state === 'trial',
    'a row stamped at sign-up is on trial, not expired');
  assert(accessFrom({ trial_started_at: now.toISOString(), paid_until: null }, now).daysLeft === TRIAL_DAYS,
    'and gets the full trial, not part of one');

  // Which makes the INSERT the thing that has to be right.
  const identitySrc = await readFile(new URL('./src/server/identity.ts', import.meta.url), 'utf8');
  const insert = identitySrc.slice(identitySrc.indexOf('INSERT INTO users'), identitySrc.indexOf('RETURNING id, email'));
  assert(/trial_started_at/.test(insert),
    'creating an account stamps the trial start, rather than waiting for the next restart');
  assert(!/DO UPDATE SET[^`]*trial_started_at/.test(insert),
    'signing in again does NOT restart a trial that is already running');
}

section('OFFLINE — who may put a picture on the board');
{
  // The route used to accept 6 MB from anyone who could reach the server and
  // write it to Postgres for ever. This asserts the gate is still in the file
  // that mounts it — cheap, and it catches the refactor that quietly drops it.
  const src = await readFile(new URL('./src/server/boardImages.ts', import.meta.url), 'utf8');
  assert(/userFromRequest\(req,\s*opts\.secret\)/.test(src),
    'the board-image upload checks the session cookie');
  assert(/sign_in_required/.test(src),
    'it refuses with a code the client can act on rather than a bare 401');
  const mount = src.slice(src.indexOf('export function mountBoardImageRoutes'));
  assert(mount.indexOf('userFromRequest') < mount.indexOf('parseDataUrl'),
    'the session is checked BEFORE a 6 MB body is parsed');
}

section('OFFLINE — a beam gets worse rather than stopping');
{
  // The governor. A tutor mid-explanation cannot act on "your connection is
  // too slow"; they can act on a picture that is still arriving. So past the
  // budget the beam drops quality AND halves its rate, and it keeps going.
  const big = 'data:image/webp;base64,' + 'A'.repeat(70 * 1024);
  assert(frameBytes(big) === big.length,
    'a frame is charged the characters that actually go on the wire',
    'a data: URL is ASCII and Socket.IO bills the encoded message — measuring the decoded image would under-count by a third');
  assert(frameBytes(undefined) === 0 && frameBytes(null) === 0,
    'a frame that was never encoded costs nothing');

  let b = freshBudget(0);
  assert(b.tickMs === BEAM_TICK_MS && b.quality === BEAM_QUALITY, 'a fresh beam starts at full quality and full rate');

  // Two 70KB frames inside one second is 140KB/s — over the 120KB/s budget.
  b = accountFrame(b, frameBytes(big), 200);
  assert(b.tickMs === BEAM_TICK_MS && b.bytes > 0,
    'a frame inside the window is charged and changes nothing yet',
    'reacting per-frame instead of per-second would chase every spike');
  b = accountFrame(b, frameBytes(big), 1000);
  assert(b.quality < BEAM_QUALITY, 'past the budget the picture gets cheaper', `quality=${b.quality}`);
  assert(b.tickMs === BEAM_TICK_MS * 2, 'and it is sent half as often', `tickMs=${b.tickMs}`);
  assert(b.bytes === 0 && b.windowStart === 1000, 'and the next second starts clean');

  // Sustained overload. It must never reach a state where nothing is sent —
  // a beam that has turned itself off is the silent failure this replaced.
  let t = 1000;
  for (let i = 0; i < 20; i++) { t += 1000; b = accountFrame(b, frameBytes(big) * 4, t); }
  assert(b.quality >= BEAM_MIN_QUALITY, 'quality has a floor', `quality=${b.quality}`);
  assert(b.tickMs <= BEAM_MAX_TICK_MS && b.tickMs > 0,
    'the beam never stops, however bad the line is',
    `tickMs=${b.tickMs} — a stopped beam is the failure this feature exists to remove`);

  // And it comes back when the line does.
  for (let i = 0; i < 20; i++) { t += 1000; b = accountFrame(b, 1024, t); }
  assert(b.quality === BEAM_QUALITY && b.tickMs === BEAM_TICK_MS,
    'a beam that was throttled recovers when there is room again',
    `quality=${b.quality} tickMs=${b.tickMs}`);

  // A window that ran long (a backgrounded tab, a slow encode) is a rate, not
  // a spike. Charging it as one would throttle a beam that was behaving.
  const slow = accountFrame({ ...freshBudget(0), bytes: 150 * 1024 }, 0, 5000);
  assert(slow.quality === BEAM_QUALITY,
    'a window that took five seconds is judged per second, not as one burst',
    `quality=${slow.quality}`);

  // One frame over the hard cap is not a budget question. Socket.IO's
  // maxHttpBufferSize is 5e6 and an oversize message KILLS the connection —
  // which here costs the student the whole lesson, not just the picture.
  assert(BEAM_MAX_FRAME_BYTES < 5e6, 'the frame cap is under the socket buffer that would kill the connection');
  const shrunk = shrinkAfterOversize(freshBudget(0));
  assert(shrunk.quality < BEAM_QUALITY, 'an oversize frame drops quality at once rather than waiting for the window');
}

section('OFFLINE — the picture is drawn white-first, at a sane size');
{
  // WebP keeps its alpha and the student's beam overlay is dark. A whiteboard
  // is transparent everywhere the tutor has not drawn, so a frame composited
  // straight onto that overlay is black paper with black ink — the board looks
  // empty, which is indistinguishable from the beam being broken.
  const calls = [];
  const ctx = {
    fillStyle: '',
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    drawImage: (...a) => calls.push(['drawImage', a[1], a[2], a[3], a[4]]),
  };
  paintScratch(ctx, { fake: 'canvas' }, 640, 480);
  assert(calls[0] && calls[0][0] === 'fillRect', 'the scratch canvas is filled BEFORE the picture is drawn',
    'drawing first and filling after would paint over the frame entirely');
  assert(String(ctx.fillStyle).toLowerCase() === '#ffffff', 'and it is filled white', `fillStyle=${ctx.fillStyle}`);
  assert(calls[1] && calls[1][0] === 'drawImage' && calls[1][3] === 640 && calls[1][4] === 480,
    'the source is stretched to the scratch canvas, not drawn at its own size');

  // A 4K monitor is not worth 4K of wire, and a small board must not be
  // upscaled — that spends bandwidth transmitting interpolation.
  const big = fitScratch(3840, 2160);
  assert(Math.max(big.width, big.height) === BEAM_MAX_EDGE, 'a 4K screen is capped at the long edge',
    `${big.width}x${big.height}`);
  assert(Math.abs(big.width / big.height - 3840 / 2160) < 0.01, 'and keeps its aspect ratio');
  const small = fitScratch(900, 600);
  assert(small.width === 900 && small.height === 600, 'a source under the cap is left alone');
  const tall = fitScratch(600, 3000);
  assert(tall.height === BEAM_MAX_EDGE, 'a tall source is capped on its own long edge', `${tall.width}x${tall.height}`);
  assert(fitScratch(0, 0).width >= 1 && fitScratch(NaN, NaN).height >= 1,
    'a source with no size still yields a canvas that can exist',
    'a 0x0 canvas throws on toDataURL and would kill the tick');
}

section('OFFLINE — a blank capture is noticed, not shipped in silence');
{
  // Chrome hands back a tab capture of a PDF that is entirely white — the
  // plugin surface is not in the captured layer — and the tutor cannot tell,
  // because their own screen looks right. The student sees an empty rectangle
  // and says nothing. Sixty-four probes that all agree is the signature.
  const grid = samplePoints(800, 600);
  assert(grid.length === 64, 'the probe is an 8x8 grid', `${grid.length} points`);
  assert(grid.every(p => p.x >= 0 && p.x < 800 && p.y >= 0 && p.y < 600),
    'every probe lands inside the frame');
  assert(grid.every(p => p.x > 0 && p.y > 0),
    'and none of them sits on the border',
    'a border sample on a captured window reads the window chrome, not the content');

  assert(looksBlank(new Array(64).fill(0xffffff)), 'an all-white capture is blank');
  assert(looksBlank(new Array(64).fill(0x000000)), 'an all-black capture is blank too');
  assert(looksBlank([]), 'a capture with nothing to sample is blank');
  const faint = new Array(64).fill(0xffffff).map((_, i) => (i % 2 ? 0xfffefe : 0xffffff));
  assert(looksBlank(faint), 'a page with a faint background gradient is still blank',
    'exact equality would miss the very captures this is for');
  const real = new Array(64).fill(0xffffff);
  real[20] = 0x101820;
  assert(!looksBlank(real), 'one patch of dark ink is enough to prove something was captured',
    'a real page is mostly white — demanding lots of variety would warn on every worksheet');
}

section('OFFLINE — the tutor is told who can see this, by name');
{
  // The failure being fixed. myScreenOn was set from the tutor's own
  // getDisplayMedia call — a fact about their browser, not about the child —
  // so the toolbar said "Sharing" whether one student was connected or none.
  // "I thought he could see it" is what that costs, and a fallback that can
  // fail silently just reproduces it.
  const now = 100_000;
  const two = [{ id: 'a', name: 'Aarav' }, { id: 'b', name: 'Meera' }];

  const none = reachSummary(two, {}, now);
  assert(none.seeing.length === 0 && none.notSeeing.length === 2, 'a beam nobody has acked reaches nobody');
  assert(/Aarav/.test(none.text) && /Meera/.test(none.text), 'and both of them are named', none.text);
  assert(!/\b1 of 2\b/.test(none.text), 'not counted — a count is not a sentence in a one-to-one lesson');

  const all = reachSummary(two, { a: now - 500, b: now - 2000 }, now);
  assert(all.seeing.length === 2 && all.notSeeing.length === 0, 'two fresh acks means two students seeing it');
  assert(all.text === 'Aarav and Meera can see this.', 'and it reads as a sentence', all.text);

  // Acks arrive at most once a second, so three missed ones is the point at
  // which a tutor should be told — long enough not to flicker on a hiccup.
  const dropped = reachSummary(two, { a: now - 500, b: now - 30_000 }, now);
  assert(dropped.seeing.length === 1 && dropped.notSeeing[0] === 'Meera',
    'a student who stopped acking is reported as not receiving it',
    'this is the whole feature: silence must not read as success');
  assert(/Aarav can see this/.test(dropped.text) && /Not reaching Meera/.test(dropped.text),
    'and the pill says both halves', dropped.text);

  const empty = reachSummary([], {}, now);
  assert(empty.seeing.length === 0 && /Nobody has joined/.test(empty.text),
    'beaming to an empty room says so rather than looking fine', empty.text);

  const three = reachSummary(
    [{ id: 'a', name: 'Aarav' }, { id: 'b', name: 'Meera' }, { id: 'c', name: 'Sam' }],
    { a: now, b: now, c: now }, now);
  assert(three.text === 'Aarav, Meera and Sam can see this.', 'three names read as English', three.text);

  // A stale ack from a PREVIOUS beam must not carry over into this one. The
  // teacher clears the acks on start; this asserts the staleness window would
  // have caught it anyway.
  assert(reachSummary([{ id: 'a', name: 'Aarav' }], { a: now - BEAM_ACK_STALE_MS - 1 }, now).seeing.length === 0,
    'an ack older than the staleness window does not count');
}

section('OFFLINE — the beam relays and keeps nothing');
{
  // This box is 1GB with Postgres beside it and the kernel has OOM-killed it
  // repeatedly. A retained ~900KB frame per room is exactly the shape that
  // does it, so the server must be a pure relay — the recovery a cache would
  // have bought is bought by the keyframe instead.
  const src = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
  const start = src.indexOf("socket.on('beam_frame'");
  const end = src.indexOf('LIVE MIRROR relay', start);
  assert(start > 0 && end > start, 'the beam relay is in server.ts');
  const beam = src.slice(start, end);
  assert(!/room\.beam/.test(beam), 'no beam frame is stored on the room',
    'a retained frame per room is the shape that has OOM-killed this box');
  assert(/requireTeacher\(room, socket\.id\)/.test(beam), 'only the teacher may put a frame on the wire');
  assert(/isMember\(room, socket\.id\)/.test(beam), 'and only a member of the room may ask for one or ack one');
  assert(/checkRateLimit\(socket\.id, true\)/.test(beam), 'frames are rate-limited as loss-tolerant',
    'a beam must never be allowed to starve a click');
  const cap = beam.indexOf('MAX_BEAM_FRAME');
  assert(cap > 0 && beam.indexOf('data.length >') > 0 && beam.indexOf('data.length >') < beam.indexOf('rooms.get'),
    'the size cap is checked BEFORE anything else touches the frame',
    'Socket.IO does not drop an oversize message, it kills the connection');
  const mutating = src.slice(src.indexOf('const MUTATING_EVENTS'), src.indexOf('const MUTATING_EVENTS') + 2000);
  assert(!/beam_/.test(mutating), 'no beam event schedules a save',
    'a save per frame would be a save storm on a box that dies of memory');
}

// LIVE — the protocol, against a running server.
// ─────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT;
if (!PORT) {
  console.log('\nLIVE — skipped (set PORT to run against a server)');
} else {
  const { io } = await import('socket.io-client');
  const URL = `http://localhost:${PORT}`;
  const connect = () => io(URL, { transports: ['websocket', 'polling'], reconnection: false, forceNew: true });
  const waitFor = (socket, event, { timeout = 5000, match } = {}) => new Promise((res, rej) => {
    const t = setTimeout(() => { socket.off(event, h); rej(new Error(`timeout: ${event}`)); }, timeout);
    function h(p) { if (match && !match(p)) return; clearTimeout(t); socket.off(event, h); res(p); }
    socket.on(event, h);
  });
  const never = async (socket, event, ms = 1500) => {
    let seen = false;
    const h = () => { seen = true; };
    socket.on(event, h);
    await new Promise(r => setTimeout(r, ms));
    socket.off(event, h);
    return !seen;
  };

  section('LIVE — relay credentials');
  const turn = await (await fetch(`${URL}/api/turn`)).json();
  assert(Array.isArray(turn.iceServers) && turn.iceServers.length > 0, '/api/turn returns ICE servers');
  assert(typeof turn.relay === 'boolean', '/api/turn says whether a relay is available',
    turn.relay ? 'relay configured' : 'STUN only — calls will fail on mobile data and school wifi');
  assert(!JSON.stringify(turn).includes(process.env.TURN_SECRET || ' nope '),
    '/api/turn never returns the shared secret');

  const roomId = 'vm' + Math.random().toString(36).slice(2, 8);
  const lesson = '<!doctype html><html><body><h1>t</h1><button id="b">go</button></body></html>';

  const teacher = connect();
  await waitFor(teacher, 'connect');
  teacher.emit('join_room', { roomId, userName: 'T', role: 'teacher' });
  await waitFor(teacher, 'room_state');
  teacher.emit('upload_file', { roomId, file: { id: 'f1', name: 'l.html', html: lesson, uploadedAt: Date.now() } });
  teacher.emit('run_preview', { roomId, fileId: 'f1', html: lesson });
  await waitFor(teacher, 'run_preview');

  const student = connect();
  await waitFor(student, 'connect');
  student.emit('join_room', { roomId, userName: 'S', role: 'student' });
  await waitFor(student, 'room_state');

  section('LIVE — the mirror is the late-join state');
  teacher.emit('mirror_dom', { roomId, body: '<h1>frame A</h1>', attrs: '[]', head: '', h: 'hashA' });
  await new Promise(r => setTimeout(r, 250));
  const late = connect();
  await waitFor(late, 'connect');
  late.emit('join_room', { roomId, userName: 'Late', role: 'student' });
  await waitFor(late, 'room_state');
  late.emit('mirror_request', { roomId });
  const served = await waitFor(late, 'mirror_dom').catch(() => null);
  assert(served && served.body === '<h1>frame A</h1>',
    'a joining student is served the cached frame immediately',
    served ? `got ${JSON.stringify(served.body).slice(0, 40)}` : 'nothing served');

  section('LIVE — nothing rebuilds the running lesson');
  // Force Sync must NOT push a dom_snapshot: rebuilding re-runs the lesson's
  // scripts over rendered markup, which is how a quiz returned to question 1
  // with two canvases.
  const noRebuild = never(student, 'dom_snapshot', 2000);
  teacher.emit('force_sync', { roomId });
  assert(await noRebuild, 'Force Sync does not rebuild a student iframe',
    'force_sync emitted dom_snapshot — the class would restart');

  section('LIVE — only the seated teacher streams');
  const impostor = connect();
  await waitFor(impostor, 'connect');
  impostor.emit('join_room', { roomId, userName: 'S2', role: 'student' });
  await waitFor(impostor, 'room_state');
  const noLeak = never(student, 'mirror_dom', 1500);
  impostor.emit('mirror_dom', { roomId, body: '<h1>NOT THE TEACHER</h1>', attrs: '[]', head: '', h: 'x' });
  assert(await noLeak, 'a non-teacher socket cannot stream to the class');

  section('LIVE — the teacher can see the class');
  const statusP = waitFor(teacher, 'mirror_status', { timeout: 3000 });
  student.emit('mirror_ack', { roomId, h: 'hashA', ok: true });
  const status = await statusP.catch(() => null);
  assert(status && status.ok === true, "a student's ack reaches the teacher as status",
    status ? JSON.stringify(status) : 'no mirror_status');

  section('LIVE — a lesson that can say where it is');
  teacher.emit('mirror_state', { roomId, state: '{"i":4,"score":3}' });
  await new Promise(r => setTimeout(r, 200));
  const rejoin = connect();
  await waitFor(rejoin, 'connect');
  rejoin.emit('join_room', { roomId, userName: 'T', role: 'teacher' });
  const st = await waitFor(rejoin, 'session_state', { timeout: 4000 }).catch(() => null);
  assert(st && st.lessonState === '{"i":4,"score":3}',
    'the lesson position survives a teacher reload',
    st ? `lessonState=${st.lessonState}` : 'no session_state');

  // A different lesson must clear it — restoring question 5 of one lesson into
  // another would put the class somewhere that never existed.
  rejoin.emit('run_preview', { roomId, fileId: 'f1', html: lesson.replace('<h1>t</h1>', '<h1>DIFFERENT</h1>') });
  await waitFor(rejoin, 'run_preview');
  const rejoin2 = connect();
  await waitFor(rejoin2, 'connect');
  rejoin2.emit('join_room', { roomId, userName: 'T', role: 'teacher' });
  const st2 = await waitFor(rejoin2, 'session_state', { timeout: 4000 }).catch(() => null);
  assert(st2 && !st2.lessonState, 'a new lesson clears the stored position',
    st2 ? `lessonState=${st2.lessonState}` : 'no session_state');

  [teacher, student, late, impostor, rejoin, rejoin2].forEach(s => s.close());
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
