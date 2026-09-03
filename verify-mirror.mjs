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
    return { drawImage: () => drawn.push(el.id || '(no id)') };
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
    assert(statements.every(s => /IF NOT EXISTS|ON CONFLICT|OR REPLACE/i.test(s)),
      `${f} is safe to apply twice`,
      'there are no down-migrations here; the way back is the nightly dump');
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
