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
import {
  accessFrom, standingOf, businessFigures, TRIAL_DAYS, PRICE_RUPEES, GRACE_DAYS, PLANS, priceFor, perMonth,
} from './src/server/billing.ts';
import { _warningFor, _warningsDue, _warningMail, _digestLines, _warningClaim, _sendDailyMail } from './src/server/scheduler.ts';
import { SEED_LESSONS } from './src/lib/seedLessons.ts';
import { makeLimiter } from './src/server/rateLimit.ts';
import { listMigrationFiles } from './src/server/migrate.ts';
import { EMPTY_MIRROR, cacheMirrorFrame, mirrorSurfaceKey, servableFrame } from './src/server/mirrorCache.ts';
import * as tplServer from './src/server/templates.ts';
import * as tplClient from './src/lib/templatesApi.ts';
import * as tplPrefs from './src/lib/prefs.ts';
import * as tplClassData from './src/server/classData.ts';
import tplExpress from 'express';
import { createHmac as tplHmac } from 'node:crypto';
import { readdirSync as tplReaddir } from 'node:fs';
import { PRODUCT, subjectFor } from './src/lib/product.ts';
import { can, permissionsOf } from './src/server/authz.ts';
import { LESSON_HISTORY_KEEP, LESSON_TTL_HOURS } from './src/server/records.ts';
import { cutoffFrom } from './src/server/classData.ts';
import { explainerKey, touchLiveExplainer, whiteboardSurfaceToggle, MAX_LIVE_EXPLAINERS } from './src/lib/liveExplainers.ts';
import { contentRetryDelay, contentRetryOffset, CONTENT_RETRY_STEADY_MS } from './src/lib/contentRetry.ts';
import {
  calculate, compile, parse, evaluate, tokenize, formatResult, freeVariables,
  ExpressionError, FUNCTION_NAMES,
} from './src/lib/mathExpr.ts';
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

section('OFFLINE — a learner with an empty screen keeps asking');
{
  // Reported 10 Sep 2026 with photographs: "the student cannot see the
  // animation. He can see the slider but cannot see the animation." That lesson
  // draws its matchsticks with script into an <svg> that is EMPTY in the
  // uploaded file, so a learner who never receives a frame sees the entire page
  // — nav, slider, stat cards — with one empty box where the teaching is.
  //
  // The mirror delivers that lesson correctly: reproduced end to end in
  // Chromium and in WebKit, with a second viewer joining, and the learner
  // received every matchstick. The learner in the report was simply never given
  // a frame, and could not tell, because the only staleness check compares the
  // teacher's fingerprint — which arrives down the very channel that can stick.
  const followerJs = mirrorScriptFor('follower')
    .replace(/^[\s\S]*?<script[^>]*>/i, '').replace(/<\/script>[\s\S]*$/i, '');
  const dom = new JSDOM('<!doctype html><html><body><p>the shell</p></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  window.parent = { postMessage: (m) => sent.push(m && m.type) };
  window.eval(followerJs);

  assert(sent.includes('MIRROR_FOLLOWER_READY'), 'it announces itself once at boot');

  // The upward channel is never gated on readiness, which is what makes this
  // rescue possible at all — a follower being told nothing can still shout.
  const src = readFileSync('src/lib/mirrorScript.ts', 'utf8');
  const rescue = src.slice(src.indexOf('function askForSomethingToPaint'), src.indexOf('function askForSomethingToPaint') + 900);
  assert(/if \(lastBody !== null\) return;/.test(rescue),
    'it stops the moment anything is painted',
    'a learner who can see the lesson must not keep asking for it');
  assert(/MIRROR_FOLLOWER_READY/.test(rescue) && /MIRROR_STALE/.test(rescue),
    'it asks for a frame AND re-announces',
    'the announce is what makes the parent flush a queue it was holding — that was the 4 Sep freeze');
  assert(/asksLeft-- <= 0/.test(rescue),
    'it gives up eventually',
    'a message every two seconds for the rest of a lesson is noise on top of a problem');
  assert(/Math\.min\(askDelay \* 1\.5, 10000\)/.test(rescue), 'and backs off while it tries');
}

section('OFFLINE — a student copy lines up with where the tutor is on the page');
{
  // 15 Sep 2026, mid-class: a reopened explanation came back where the tutor had
  // left it, but the student's copy sat at the top. Two holes, both needed for it:
  // the server answers a (re)joining copy with its cached frame first, which
  // carries no scroll and used to use up the copy's one chance to align; and the
  // app's request for the tutor's scroll position was one the mirror never
  // answered. The walk itself is a smoke test ('reopening an explanation puts the
  // learner where the tutor left it').
  const engine = readFileSync('src/lib/mirrorScript.ts', 'utf8');
  assert(/d\.type === 'EMIT_CURRENT_SCROLL' && !d\.mirrorOnly\)\s*\{\s*post\(\{ type: 'SYNC_MIRROR_SCROLL'/.test(engine),
    'the source answers a request for where the tutor is scrolled, with the message a real scroll sends');
  assert(/var alignScroll = !scrollAligned && \(typeof d\.scrollX === 'number'/.test(engine)
    && /if \(painted\) scrollAligned = true;/.test(engine)
    && !/var firstPaint = \(lastBody === null\)/.test(engine),
    'a student copy aligns on the first frame that says where the tutor is, not merely the first frame to paint',
    'the cached frame served on (re)join carries no scroll');
  const roomSrc = readFileSync('src/pages/Room.tsx', 'utf8');
  const onRequest = roomSrc.slice(roomSrc.indexOf('newSocket.on("mirror_request"'), roomSrc.indexOf('newSocket.on("mirror_request"') + 900);
  assert(/EMIT_CURRENT_SCROLL/.test(onRequest),
    "answering a student's resync also re-announces where the tutor is scrolled");
}

section('OFFLINE — a cached frame and its fingerprint describe the same document');
{
  // 17 Sep 2026, and it is the whole of "the student somewhere else, I'm
  // somewhere else" for a student who joined or asked for help. The room keeps
  // ONE mirror frame, fed by whichever of the tutor's surfaces is streaming,
  // and it used to be handed out with no idea which document it came from —
  // and with a fingerprint the 2s heartbeat could overwrite on its own, with no
  // body beside it. Both were measured, live, on this build.
  const lessonFrame = { body: '<h1>page 1</h1>', attrs: '[]', head: '<style>a{}</style>', h: 'hash-lesson-1' };
  const lesson = cacheMirrorFrame(EMPTY_MIRROR, lessonFrame, 'lesson');
  assert(lesson.mirrorBody === lessonFrame.body && lesson.mirrorHash === 'hash-lesson-1' && lesson.mirrorSurface === 'lesson',
    'a frame is cached whole: body, envelope, fingerprint and the document it came from');
  assert(servableFrame(lesson, 'lesson')?.h === 'hash-lesson-1',
    'and it is served to a screen showing that document');

  // The tutor opens an explanation. Until the explanation has actually sent a
  // frame, the slot holds the lesson — measured at 22 of 330 samples across
  // twelve switches, in both directions, before this rule existed.
  assert(servableFrame(lesson, 'explanation:e1') === null,
    'the lesson frame is NOT served to a student whose screen is showing an explanation',
    'this is the tutor on the whiteboard and the student on the worksheet, from the server side');

  // The explanation's first frame is forced, so it carries its own head CSS.
  const exp = cacheMirrorFrame(lesson, { body: '<h2>worked example</h2>', attrs: '[]', head: '<style>b{}</style>', h: 'hash-exp-1' }, 'explanation:e1');
  assert(exp.mirrorHead === '<style>b{}</style>' && servableFrame(exp, 'lesson') === null,
    "the explanation replaces the slot, and the lesson's screens are told nothing rather than shown it");

  // Back to the lesson. Its next frame is an ordinary mutation frame, and the
  // source only ships head CSS when it CHANGED against that iframe's own last
  // send — so this one carries head:null.
  const back = cacheMirrorFrame(exp, { body: '<h1>page 1</h1>', attrs: '[]', head: null, h: 'hash-lesson-1' }, 'lesson');
  assert(back.mirrorHead !== '<style>b{}</style>',
    "the explanation's stylesheet does not survive onto the lesson's body",
    'the right content laid out with another document’s CSS reads as "the app is broken on their iPad"');
  assert(back.mirrorHash === null,
    'and a frame we cannot dress completely travels without a fingerprint',
    'a hash covers body + attributes + head together, so claiming it while missing the head is the same lie');
  assert(servableFrame(back, 'lesson')?.body === '<h1>page 1</h1>',
    'the body is still served — something real on screen beats a blank page, and the heartbeat asks for the rest');

  // The forced frame that follows carries the head, and the fingerprint returns.
  const whole = cacheMirrorFrame(back, { body: '<h1>page 1</h1>', attrs: '[]', head: '<style>a{}</style>', h: 'hash-lesson-1' }, 'lesson');
  assert(whole.mirrorHash === 'hash-lesson-1' && whole.mirrorHead === '<style>a{}</style>',
    'a whole frame restores the fingerprint');

  assert(mirrorSurfaceKey({ activeExplanationId: null }) === 'lesson'
    && mirrorSurfaceKey({ activeExplanationId: 'e1' }) === 'explanation:e1',
    'the surfaces that swap the streaming document are the lesson and the explanations');

  // The two lines in the server that this depends on, because no unit test of a
  // pure module can see them.
  const serverSrc = readFileSync('server.ts', 'utf8');
  const ping = serverSrc.slice(serverSrc.indexOf("socket.on('mirror_ping'"), serverSrc.indexOf("socket.on('mirror_canvas'"))
    // The handler's own comment quotes the line that used to be there, which is
    // worth keeping and is not code.
    .split(String.fromCharCode(10)).filter(l => !l.trim().startsWith('//')).join(String.fromCharCode(10));
  assert(!/room\.mirrorHash\s*=/.test(ping),
    'the fingerprint heartbeat does not write the cached hash',
    'one line, `room.mirrorHash = h`, is what paired page 0’s body with page 2’s fingerprint and froze a student for a lesson');
  assert(/servableFrame\(room, mirrorSurfaceKey\(room\)\)/.test(serverSrc.slice(serverSrc.indexOf("socket.on('mirror_request'"))),
    'a late joiner is answered through the surface check, not from the raw slot');
  assert(/servableFrame\(room, mirrorSurfaceKey\(room\)\)/.test(serverSrc.slice(serverSrc.indexOf("socket.on('resync_student'"))),
    "and so is the tutor's Resend");
  // The third and busiest of them, added by a different fix on the same day:
  // the student's own "there is nothing on my screen". 80 of these in the 48
  // hours to 17 Sep against 18 resyncs, so this is the path most of the
  // traffic takes and the one it would hurt most to leave reading the raw slot.
  const askHandler = serverSrc.slice(serverSrc.indexOf("socket.on('request_content'"), serverSrc.indexOf("socket.on('set_room_password'"));
  assert(/servableFrame\(room, mirrorSurfaceKey\(room\)\)/.test(askHandler)
    && !/room\.mirrorBody,/.test(askHandler),
    'a student asking for help is answered through the surface check too',
    'it is the one person in the room we KNOW has nothing on screen: handing them the other document is the whole bug');
  assert(/armRepair\(room, socket\.id\)/.test(askHandler),
    'and is owed the next live frame on the guaranteed channel',
    'a volatile frame has already failed this student — that is why they are asking');
  const domHandler = serverSrc.slice(serverSrc.indexOf("socket.on('mirror_dom'"), serverSrc.indexOf("socket.on('mirror_ping'"));
  assert(/socket\.volatile\.to\(roomId\)\.emit\('mirror_dom'/.test(domHandler),
    'the live frame fan-out is still volatile',
    '4 Sep 2026: queueing 3 MiB frames for one student on slow wifi filled the heap and ended a lesson for everybody');
  assert(/deliverRepairs\(room,/.test(domHandler) && /armRepair\(room,/.test(serverSrc),
    'but the student who ASKED is handed the next live frame guaranteed, once',
    'the cached answer went out guaranteed and the frame correcting it went out volatile, on the very transport that had just dropped one — that asymmetry is a tutor pressing Resend eighteen times in ten seconds');
  assert(/logSync\('mirror_frame_dropped'/.test(serverSrc),
    'a frame too big for the mirror is recorded rather than silently discarded',
    'the 3 MiB ceiling used to be a bare return: nothing in 48h of journal said a lesson had outgrown the mirror');
}

section('OFFLINE — a student copy fingerprints what it painted, not what it was told');
{
  // The other half of the same fault. The follower used to adopt whatever
  // fingerprint a frame arrived wearing — `appliedHash = d.h` — without ever
  // checking that it described the frame. Hand it one document's body carrying
  // another document's hash and it agrees with every heartbeat afterwards: the
  // student sits on the wrong page, MIRROR_STALE is never posted again, and the
  // tutor's status pill is green next to a child who is somewhere else.
  const strip = (s) => s.replace(/^[\s\S]*?<script[^>]*>/i, '').replace(/<\/script>[\s\S]*$/i, '');
  const LESSON = '<!doctype html><html><head><style>#t{color:rgb(1,2,3)}</style></head><body class="k"><h1 id="t">page 1</h1></body></html>';

  // A REAL source, so the fingerprint under test is the one that actually ships.
  const sdom = new JSDOM(LESSON, { runScripts: 'outside-only', pretendToBeVisual: true });
  const posted = [];
  sdom.window.parent = { postMessage: (m) => posted.push(m) };
  sdom.window.eval(strip(mirrorScriptFor('source')));
  await new Promise(r => setTimeout(r, 300));
  const frame = posted.filter(m => m && m.type === 'SYNC_MIRROR').pop();
  assert(!!frame && typeof frame.h === 'string', 'the source produced a frame with a fingerprint');

  // A REAL follower, painted by that frame.
  const fdom = new JSDOM(stripLessonScripts(LESSON), { runScripts: 'outside-only', pretendToBeVisual: true });
  const back = [];
  fdom.window.parent = { postMessage: (m) => back.push(m) };
  fdom.window.eval(strip(mirrorScriptFor('follower')));
  const send = (msg) => fdom.window.dispatchEvent(new fdom.window.MessageEvent('message', { data: msg, source: fdom.window.parent }));
  const lastAck = () => back.filter(m => m && m.type === 'MIRROR_ACK').pop();

  send({ type: 'MIRROR_APPLY', body: frame.body, attrs: frame.attrs, head: frame.head, h: frame.h });
  send({ type: 'MIRROR_PING', h: frame.h });
  assert(lastAck()?.ok === true && lastAck()?.h === frame.h,
    'a copy that painted the frame computes the source’s own fingerprint for it',
    'the two halves build the signature separately, and they must agree character for character — a NUL separator on one side and a space on the other would report every student permanently stale');

  // Now the poisoned pair: the body of a DIFFERENT document, wearing the
  // fingerprint the source is currently advertising. This is exactly what the
  // room's cache used to hand a joining or resyncing student.
  back.length = 0;
  send({ type: 'MIRROR_APPLY', body: '<h2 id="e">a different document</h2>', attrs: frame.attrs, head: frame.head, h: frame.h });
  send({ type: 'MIRROR_PING', h: frame.h });
  assert(lastAck()?.ok === false,
    'a copy handed the wrong body wearing the right fingerprint says so',
    'it used to adopt the hash, agree with every heartbeat and never ask again');
  send({ type: 'MIRROR_PING', h: frame.h });
  assert(back.some(m => m && m.type === 'MIRROR_STALE'),
    'and asks for a real one',
    'this is the repair the pre-acknowledged hash removed');

  // The "nothing to do" path is the same hole: re-delivering a body the copy
  // already holds, with a newer hash attached, used to relabel it as in step.
  back.length = 0;
  send({ type: 'MIRROR_APPLY', body: '<h2 id="e">a different document</h2>', attrs: frame.attrs, head: frame.head, h: 'a-newer-hash' });
  send({ type: 'MIRROR_PING', h: 'a-newer-hash' });
  assert(lastAck()?.ok === false,
    'an unchanged body does not take on a newer fingerprint either',
    'pressing Resend was what performed the relabelling: the repair silenced the alarm');
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
    // Comments stripped BEFORE splitting, not after. Splitting first meant a
    // semicolon inside a `--` comment cut a statement in half and the front
    // half lost its IF NOT EXISTS — 0004 was reported unguarded because one
    // of its comments contained "in five different rooms; without".
    const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
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

section('OFFLINE — a student handed the controls can construct, but not wipe');
{
  // 10 Sep 2026. The founder asked for "protractor and compass … and if he want
  // for the students also", and the geometry tools turned out to exist already
  // — verified by driving them in a browser: the compass draws a centre-out
  // circle with a centre mark, the protractor drops with its degree scale.
  //
  // What did not exist was a learner being able to touch any of it. Images
  // accepted a student whenever the tutor had turned interaction on; shapes,
  // text and the instruments required a teacher on BOTH sides. So "now you
  // construct the perpendicular bisector" was impossible, which is most of what
  // a geometry lesson is.
  const srv = readFileSync('server.ts', 'utf8');
  const guardFor = (ev) => {
    const i = srv.indexOf(`socket.on('${ev}'`);
    if (i < 0) return 'MISSING';
    const m = /requireTeacher[A-Za-z]*/.exec(srv.slice(i, i + 700));
    return m ? m[0] : 'NONE';
  };

  // Handed over with the tutor's existing interaction toggle.
  for (const ev of ['whiteboard_add_shape', 'whiteboard_update_shape', 'whiteboard_remove_shape',
                    'whiteboard_add_text', 'whiteboard_add_instrument', 'whiteboard_update_instrument',
                    'whiteboard_remove_instrument']) {
    assert(guardFor(ev) === 'requireTeacherOrInteractive',
      `${ev} follows the interaction toggle`,
      `it is ${guardFor(ev)} — a learner cannot construct even when handed the controls`);
  }

  // Never handed over. These are not construction, they are destruction and
  // room-wide settings, and a student reaching them would wipe a lesson.
  for (const ev of ['whiteboard_clear', 'whiteboard_reset', 'whiteboard_set_grid_mode']) {
    assert(guardFor(ev) === 'requireTeacher',
      `${ev} stays with the teacher`,
      `it is ${guardFor(ev)} — a student could clear everyone's board`);
  }

  // The two sides must agree, or the tools appear and then silently do nothing
  // — which is worse than not showing them.
  const wb = readFileSync('src/components/Whiteboard.tsx', 'utf8');
  assert(/const canMutateBoard = isTeacher \|\| interactive;/.test(wb),
    'the client uses one permission for the whole board');
  assert(/visibleTools = \(isTeacher \|\| interactive\)/.test(wb),
    'and shows the geometry tools to a student who may use them');
  assert(!/isTeacher\) socket\.emit\('whiteboard_(add|update|remove)_(shape|text|instrument)'/.test(wb),
    'no board mutation is still gated on isTeacher alone',
    'the server would accept it and the client would never send it');
  assert(/isTeacher\) socket\.emit\('whiteboard_clear'/.test(wb),
    'clearing the board is still the teacher alone on the client too');
}

section('OFFLINE — nothing a room holds may grow without a ceiling');
{
  // The generalisation of the crash week, written so the next one is caught by
  // a test rather than by a tutor.
  //
  // Twice now the fault has been the same shape: one way into a list is
  // guarded and another way in is not. Whiteboard strokes were capped at 5000
  // from the day they were written and objects never were — one board reached
  // 441,195 and killed the server on every join. Then on 9 Sep the upload path
  // checked MAX_FILES_PER_ROOM and the AI-generation path, three hundred lines
  // away, pushed a whole lesson document with no check at all.
  //
  // So this does not test a list. It finds every place the server grows one and
  // demands a ceiling near it — naming that list, so a cap belonging to its
  // neighbour cannot be mistaken for its own.
  const srv = readFileSync('server.ts', 'utf8');
  const sites = [
    ...srv.matchAll(/room\.(?:whiteboard\.)?([a-zA-Z]+)\.push\(/g),
    ...srv.matchAll(/upsertById\(room\.(?:whiteboard\.)?([a-zA-Z]+),/g),
  ];
  assert(sites.length >= 7, 'the growth sites are actually being found', `found ${sites.length}`);
  const uncapped = [];
  for (const m of sites) {
    const name = m[1];
    // Wide enough for a guard that returns early before the push, tight enough
    // that it is still the same handler.
    const near = srv.slice(Math.max(0, m.index - 900), m.index + 500);
    if (!new RegExp(`${name}\.length`).test(near)) uncapped.push(name);
  }
  assert(uncapped.length === 0,
    'every list a room grows has a ceiling beside it',
    uncapped.length ? `no ceiling near: ${[...new Set(uncapped)].join(', ')}` : '');
}

section('OFFLINE — closing an explanation does not wipe what the student typed');
{
  // 15 Sep 2026, from the founder: a student filled in half a worksheet opened as
  // an explanation; the teacher closed it to explain question 4 on the
  // whiteboard, opened it again, and every answer was gone. Closing unmounted the
  // explanation's iframe, so reopening loaded the file from scratch.
  const html = '<!doctype html><html><head></head><body><input id="q4"></body></html>';
  assert(explainerKey(html, 0) === explainerKey(html.slice(0), 0),
    'the same explanation, reopened, finds the same document',
    'a reopen and a reconnect hand over a new object carrying the same HTML');
  assert(explainerKey(html, 0) !== explainerKey(html, 1),
    'restarting the lesson is the one time a fresh document is wanted');
  assert(explainerKey(html, 0) !== explainerKey(html.replace('q4', 'q5'), 0),
    'a different explanation is a different document');

  let made = 0;
  const create = () => `blob:test-${++made}`;
  let r = touchLiveExplainer([], 'a', create, 1);
  assert(r.created && r.next.length === 1 && made === 1, 'the first showing builds a document');
  const firstUrl = r.next[0].url;
  r = touchLiveExplainer(r.next, 'a', create, 2);
  assert(!r.created && made === 1 && r.next[0].url === firstUrl,
    'showing it again reuses the running document instead of loading the file again',
    'a new URL is a reload, and a reload is an empty worksheet');

  r = touchLiveExplainer(r.next, 'b', create, 3);
  r = touchLiveExplainer(r.next, 'c', create, 4);
  const order = r.next.map(e => e.key).join();
  r = touchLiveExplainer(r.next, 'a', create, 5);
  assert(r.next.map(e => e.key).join() === order,
    'bringing one forward never reorders the others',
    'React moves a keyed node whose position changes, and a moved iframe reloads');

  r = touchLiveExplainer(r.next, 'd', create, 6);
  assert(r.next.length === MAX_LIVE_EXPLAINERS && r.evicted.map(e => e.key).join() === 'b',
    'past the cap, the least recently used document goes',
    JSON.stringify(r.next.map(e => e.key)));
  assert(r.next.some(e => e.key === 'a') && r.next[r.next.length - 1].key === 'd',
    'the one used most recently survives, and a new document is appended at the end');
  assert(touchLiveExplainer([{ key: 'x', url: 'u', usedAt: 1 }], 'y', create, 2, 1).next.map(e => e.key).join() === 'y',
    'even at a cap of one, the explanation being shown is the one kept');

  // The wiring: every kept explanation rendered from the list, hidden rather than
  // unmounted.
  const roomSrc = readFileSync('src/pages/Room.tsx', 'utf8');
  assert(!/\{showTempContent && tempContent && tempContentUrl && \(/.test(roomSrc),
    'the explanation iframe is no longer mounted only while it is showing',
    'that condition is what threw the document away on close');
  const at = roomSrc.indexOf('liveExplainers.map(');
  const explainers = at >= 0 ? roomSrc.slice(at, at + 1600) : '';
  assert(at >= 0 && /key=\{entry\.key\}/.test(explainers) && /src=\{entry\.url\}/.test(explainers),
    'every kept explanation renders its own keyed iframe');
  assert(/visibility: 'hidden'/.test(explainers) && !/display: 'none'/.test(explainers),
    'a closed explanation is hidden with visibility, never display:none',
    'display:none hands a canvas back at zero width');
}

section('OFFLINE — the whiteboard and an explanation cannot both be the class\'s screen');
{
  // 17 Sep 2026, the founder's own journey: a worksheet open as an explanation,
  // tap Whiteboard to work question 4 through, come back. Before this, tapping
  // Whiteboard left the tutor's screen blank — lesson hidden, explanation hidden,
  // and the board refusing to render because an explanation was still "active"
  // — while the student carried on watching the worksheet. Two independent
  // booleans, and the two sides broke the tie in opposite directions.
  const kept = (...ids) => (id) => ids.includes(id);
  const none = { whiteboardMode: false, activeExplanationId: null, explanationBeforeWhiteboard: null };
  const onExp = { whiteboardMode: false, activeExplanationId: 'exp-1', explanationBeforeWhiteboard: null };

  const enter = whiteboardSurfaceToggle(onExp, true, kept('exp-1'));
  assert(enter.next.whiteboardMode && enter.showExplanation === null,
    'asking for the board while an explanation is open closes the explanation for everyone',
    'the tutor saw nothing and the student saw the worksheet: the class in two places');
  assert(enter.next.explanationBeforeWhiteboard === 'exp-1',
    'the board remembers which explanation the class was on');

  const back = whiteboardSurfaceToggle(enter.next, false, kept('exp-1'));
  assert(back.showExplanation === 'exp-1' && back.next.activeExplanationId === 'exp-1',
    'leaving the board puts the class back on the same explanation',
    'the tutor left mid-worksheet and must come back to it, not to the lesson behind it');
  assert(back.next.explanationBeforeWhiteboard === null,
    'and the board stops holding it, so the next trip cannot reopen a stale one');

  // Every reachable combination, from every starting point.
  for (const prev of [none, onExp, enter.next, { ...enter.next, explanationBeforeWhiteboard: null }]) {
    for (const active of [true, false]) {
      const r = whiteboardSurfaceToggle(prev, active, kept('exp-1'));
      assert(!(r.next.whiteboardMode && r.next.activeExplanationId !== null),
        `the board and an explanation are never both the class's screen (${prev.whiteboardMode}/${prev.activeExplanationId} → ${active})`,
        JSON.stringify(r));
    }
  }

  // A file the tutor deleted while the board was up must not come back.
  assert(whiteboardSurfaceToggle(enter.next, false, kept()).showExplanation === undefined,
    'an explanation deleted while the board was up is not reopened on the way out');
  // An upload turns the flag off too, and it means "show the class this lesson".
  assert(whiteboardSurfaceToggle(onExp, false, kept('exp-1')).showExplanation === undefined,
    'turning the flag off when the class was never on the board changes nothing',
    'an upload flips whiteboardMode off; it must not drag an old explanation back');
  // A board template flips the mode on when it may already be on.
  const again = whiteboardSurfaceToggle(enter.next, true, kept('exp-1'));
  assert(again.next.explanationBeforeWhiteboard === 'exp-1' && again.showExplanation === undefined,
    'entering the board twice does not forget what the first entry set aside',
    'loading a board template emits the toggle whether or not the board is already up');

  // The wiring: the student's overlay is gated the same way the tutor's is.
  const studentSrc = readFileSync('src/pages/StudentView.tsx', 'utf8');
  assert(/\{showTempContent && tempContent && tempUrl && !whiteboardMode && \(/.test(studentSrc),
    "the student's explanation overlay is refused while the board is up",
    'the tutor\'s copy has carried !whiteboardMode all along; the student\'s did not');
  // Nothing is the lesson mirror while the board is the class's surface.
  const room17 = readFileSync('src/pages/Room.tsx', 'utf8');
  assert(/whiteboardModeRef\.current && type\.indexOf\('SYNC_MIRROR'\) === 0/.test(room17),
    'the hidden lesson stops streaming while the class is on the board',
    'it was pushing full-DOM and canvas frames to iPads for a surface nobody was watching');
  // The tutor's own flip is optimistic — it does not wait for the server — so it
  // has to set the explanation aside in the same batch or the tutor's screen
  // passes through the blank state for a round trip, and stays there for good if
  // the server refuses the toggle (a teacher socket outside its seat grace).
  const toggle = room17.slice(room17.indexOf('const toggleWhiteboardMode ='), room17.indexOf('const toggleWhiteboardMode =') + 1400);
  assert(/setShowTempContent\(false\);/.test(toggle) && !/setTempContent\(null\)/.test(toggle),
    'asking for the board sets the explanation aside on the tutor\'s own screen, without discarding it',
    'clearing tempContent would throw the running document away — the 15 Sep bug');
}

section('OFFLINE — a student with an empty screen never stops asking');
{
  // 17 Sep 2026, from the production journal: 80 "request_content" across 95
  // joins, and 14 of 17 student sockets sent them at offsets [0, 3, 8, 18] —
  // every rung of the ladder, so every one of those students still had a blank
  // screen when it ran out. After the fourth there was nothing: the effect's
  // dependencies do not change while a student is stuck, so it was never
  // re-armed. One student pressed Retry Loading fourteen times in 4.3 seconds
  // and then reloaded the page. The class carried on without them.
  assert([0, 1, 2, 3].map(contentRetryOffset).join() === [2000, 5000, 10000, 20000].join(),
    'the first four attempts still land at 2s, 5s, 10s and 20s',
    'a lesson usually arrives in the first seconds, and a student who is merely early must not be made to wait');

  // The whole point: there is no attempt number that means "stop".
  const far = [4, 5, 50, 5000, 100000].map(contentRetryDelay);
  assert(far.every(d => Number.isFinite(d) && d > 0),
    'there is no attempt count at which the student gives up',
    JSON.stringify(far));
  assert(far.every(d => d === CONTENT_RETRY_STEADY_MS),
    'past the ladder it settles into one steady cadence');

  // And it stays cheap. These are iPads on hotel wifi and the server has 1 GB:
  // a stuck student may keep asking, but not faster than a person would.
  assert(CONTENT_RETRY_STEADY_MS >= 10000 && CONTENT_RETRY_STEADY_MS <= 30000,
    'the steady cadence is somewhere between ten and thirty seconds',
    `${CONTENT_RETRY_STEADY_MS}ms`);
  const anHour = 3600000;
  let n = 0;
  while (contentRetryOffset(n) < anHour) n++;
  assert(n < 260, 'an hour of being stuck is a few hundred asks, not thousands', `${n} in an hour`);

  // Nonsense in, first rung out — never NaN, never a timer that fires forever.
  assert(contentRetryDelay(-1) === 2000 && contentRetryDelay(NaN) === 2000,
    'a bad attempt number still schedules a real attempt');

  // The wiring. A schedule that never gives up is worth nothing if the page
  // still builds its own fixed list of timers.
  const studentSrc = readFileSync('src/pages/StudentView.tsx', 'utf8');
  assert(/contentRetryDelay\(/.test(studentSrc),
    'the student page asks the schedule how long to wait');
  assert(!/\[\s*2000\s*,\s*5000\s*,\s*10000\s*,\s*20000\s*\]/.test(studentSrc),
    'the student page no longer holds a ladder that ends',
    'four timers and then silence is exactly what the journal recorded');
  // And it only runs while there is genuinely nothing to look at — an
  // explanation or the whiteboard means the class IS on screen.
  const ladderAt = studentSrc.indexOf('contentRetryDelay(');
  const ladder = ladderAt >= 0 ? studentSrc.slice(Math.max(0, ladderAt - 900), ladderAt) : '';
  assert(/showTempContent \|\| whiteboardMode/.test(ladder),
    'a student who is watching an explanation or the whiteboard is not chasing anything',
    'asking forever for a lesson nobody is showing is bandwidth a hotel wifi cannot spare');
}

section('OFFLINE — one board cannot grow until it kills the server');
{
  // The actual cause of the 4 Sep 2026 crash loop, found after two other real
  // memory bugs had been fixed and it kept dying anyway. The log named the
  // room:
  //
  //   Lazy-restored room anna-r from postgres on join
  //   memory critical — shedding every idle room: 585MB of 300MB (195%),
  //     1 rooms in memory
  //   FATAL ERROR: Reached heap limit
  //
  // anna-r held 441,195 whiteboard objects — a 130MB board that Postgres
  // compressed to 2MB, so nothing looked wrong until somebody opened it. The
  // strokes beside those objects had been capped at 5000 since they were
  // written. The objects never were.
  const srv = readFileSync('server.ts', 'utf8');

  assert(/const MAX_BOARD_OBJECTS = \d+/.test(srv), 'a board has a ceiling at all');
  const cap = Number(/const MAX_BOARD_OBJECTS = (\d+)/.exec(srv)[1]);
  assert(cap > 100 && cap <= 5000,
    'the ceiling is past any real lesson and far below a runaway',
    `it is ${cap}`);

  const add = srv.slice(srv.indexOf("socket.on('whiteboard_add_image'"), srv.indexOf("socket.on('whiteboard_update_object'"));
  assert(/slice\(-MAX_BOARD_OBJECTS\)/.test(add),
    'adding past the ceiling drops the oldest, as the strokes already did');

  // The room that already grew is the one that matters: it is reloaded on every
  // join, and every join killed the process.
  const hydrate = srv.slice(srv.indexOf('function hydrateRoom'), srv.indexOf('function hydrateRoom') + 4000);
  assert(/capBoard\(raw\.whiteboard\.objects, MAX_BOARD_OBJECTS/.test(hydrate),
    'a board that grew before the cap existed is trimmed when it is loaded',
    'otherwise it is permanently unopenable — every join reloads all of it');
  assert(/capBoard\(raw\.whiteboard\.strokes, 5000/.test(hydrate),
    'and so are the strokes');
  assert(/return list\.slice\(-max\)/.test(srv),
    'the NEWEST are kept',
    'the recent end of a board is the part the lesson is using');
  assert(/console\.warn\(`✂️/.test(srv),
    "and it says so, rather than silently discarding a tutor's work");
}

section('OFFLINE — saving every room does not serialise every room at once');
{
  // 4 Sep 2026, from the production log, and the WHERE is the point:
  //
  //   Received SIGTERM, persisting rooms before exit…
  //   Mark-Compact (reduce) 575.8 -> 570.0 MB
  //   FATAL ERROR: Reached heap limit
  //
  // It died in the shutdown path, so every restart risked killing the process
  // before it saved anything. saveRooms built a write per room and awaited
  // Promise.all, so every room's serialised JSON was in memory at the same
  // moment — and the same function runs on a five-minute timer during ordinary
  // teaching, which is the shape of "it says reconnecting in the middle of a
  // class".
  const srv = readFileSync('server.ts', 'utf8');
  const save = srv.slice(srv.indexOf('async function saveRooms'), srv.indexOf('DEBOUNCED PER-ROOM SAVE'));

  assert(!/Promise\.all\(writes\)/.test(save),
    'the rooms are not all serialised at once',
    'a few dozen boards stringified together is hundreds of megabytes on a 448MB heap');
  assert(/await saveSingleRoom\(roomId, room\)/.test(save),
    'each room is written before the next one is built');
  assert(/catch/.test(save),
    'one unwritable room does not abandon the rest',
    'the shutdown path is the worst place to give up early');
}

section('OFFLINE — a lesson outlives the room that ran it');
{
  // Found on 9 Sep 2026 while looking at the clear-class-data button built
  // three days earlier: 33 lesson files were living inside 31 rooms, and the
  // library was browser localStorage. So the database's only copy of
  // "12_times_table_adventure" and thirty-two others was inside the very rows
  // that button deletes, and the founder had asked to press it.
  const mig = readFileSync('src/server/migrations/0004_lesson_library.sql', 'utf8');
  const api = readFileSync('src/server/lessons.ts', 'utf8');

  assert(/CREATE TABLE IF NOT EXISTS lessons/.test(mig), 'lessons have a table of their own');
  assert(/UNIQUE \(teacher_id, content_key\)/.test(mig),
    'the same lesson taught in five rooms is filed once',
    'the rescue reads every room; without this it files five copies');
  assert(/ON CONFLICT \(teacher_id, content_key\) DO NOTHING/.test(mig),
    'and running the rescue twice inserts nothing');
  assert(/LEFT JOIN classes c ON c\.room_code = r\.room_id/.test(mig),
    'ownership comes from the class the room belongs to');
  assert(/owner unknown/.test(mig),
    'a guessed owner says it is a guess',
    '14 of the files are in rooms with no class; dropping them was the alternative');

  // Every statement scoped to the signed-in teacher.
  for (const q of ['WHERE teacher_id = $1', 'WHERE id = $1 AND teacher_id = $2']) {
    assert(api.includes(q), `the API is scoped by teacher (${q})`);
  }
  // The list query must report the SIZE of each lesson and never the lesson.
  // Checked by removing the one legitimate mention and looking for any other.
  const listQuery = api.slice(api.indexOf('SELECT id, name, topic, source'), api.indexOf('ORDER BY updated_at DESC'));
  assert(/length\(html\) AS bytes/.test(listQuery), 'the list reports how big each lesson is');
  assert(!listQuery.replace('length(html) AS bytes', '').includes('html'),
    'and never the lesson body itself',
    'a teacher with fifty lessons should not download all of them to read a list of names');

  // The client must not lose what was already in the browser.
  const lib = readFileSync('src/components/SimulationLibrary.tsx', 'utf8');
  assert(/local\.filter\(x => !seen\.has\(x\.id\)\)/.test(lib),
    'the account and the browser copies are merged, not replaced',
    'a tutor signed out, offline or in a demo room still has their library');
  assert(/if \(item\.html\) \{ onLoad/.test(lib),
    'a lesson already in hand opens without a round trip');
}

section('OFFLINE — a board template follows the teacher to the iPad');
{
  // 14 Sep 2026, PLAN.md task 2.5. The founder teaches from a laptop and an
  // iPad. The lesson library moved into the account on 9 Sep; board templates
  // were still localStorage, so a template saved on the laptop did not exist on
  // the iPad. They live in the account now: migration 0005 and templates.ts.
  const mig = readFileSync('src/server/migrations/0005_board_templates.sql', 'utf8').replace(/--[^\n]*/g, '');
  const src = readFileSync('src/server/templates.ts', 'utf8');

  assert(/CREATE TABLE IF NOT EXISTS board_templates/.test(mig), 'templates have a table of their own');
  const migStatements = mig.split(';').map(s => s.trim()).filter(Boolean);
  assert(migStatements.length >= 2 && migStatements.every(s => /IF NOT EXISTS/.test(s)),
    '0005 only creates what is missing, so applying it twice changes nothing',
    String(migStatements.find(s => !/IF NOT EXISTS/.test(s)) || '').slice(0, 120));
  assert(/PRIMARY KEY \(owner_user_id, id\)/.test(mig),
    'a template id is unique per teacher, not across every teacher',
    "ids were minted in separate browsers; a global key would let one teacher's import collide with, and reveal, another's");
  assert(/owner_user_id\s+text NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/.test(mig),
    'every template belongs to a teacher');
  assert(mig.includes("CHECK (id ~ '^[a-z0-9]{6}$')"), 'the table itself refuses an id a link cannot carry');

  // Every statement names the owner. Read from the source, so a query added
  // later without one fails here rather than in somebody else's account.
  const statements = [...src.matchAll(/pool\.query\(\s*(`[^`]*`|'[^']*')/g)].map(m => m[1]);
  assert(statements.length === 6, `all of the template SQL is found (${statements.length} statements)`);
  assert(statements.every(q => /owner_user_id = \$1|owner_user_id, workspace_id/.test(q)),
    'every statement in templates.ts is scoped by owner',
    String(statements.find(q => !/owner_user_id/.test(q)) || ''));

  // The routes themselves, against a database that records what it is asked.
  const SECRET = 'template-test-secret';
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const cookieFor = (uid) => {
    const payload = b64url(Buffer.from(JSON.stringify({ uid, em: `${uid}@example.com`, exp: Date.now() + 600_000 })));
    return `ml_session=${payload}.${b64url(tplHmac('sha256', SECRET).update(payload).digest())}`;
  };
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const db = { calls: [], have: { n: 0, same: 0 }, imagesDown: false, collide: 0 };
  const pool = {
    async query(sql, params = []) {
      db.calls.push({ sql, params });
      if (/INSERT INTO board_images/.test(sql)) {
        if (db.imagesDown) throw new Error('the image store is down');
        return { rows: [], rowCount: 1 };
      }
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [db.have], rowCount: 1 };
      if (/INSERT INTO board_templates/.test(sql)) {
        if (/DO NOTHING/.test(sql) && db.collide > 0) { db.collide--; return { rows: [], rowCount: 0 }; }
        return { rows: [{ id: params[0], name: params[2], bytes: params[4], saved_at: params[5] }], rowCount: 1 };
      }
      if (/^SELECT id, name, bytes/.test(sql.trim())) {
        return { rows: [{ id: 'abc234', name: 'Pythagoras', bytes: 12, saved_at: new Date() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const routes = {};
  const app = {};
  for (const verb of ['get', 'post', 'delete']) {
    app[verb] = (path, ...handlers) => { routes[`${verb.toUpperCase()} ${path}`] = handlers; };
  }
  tplServer.mountTemplateRoutes(app, pool, { secret: SECRET });
  const reply = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const hit = async (route, { as, params = {}, body } = {}) => {
    db.calls = [];
    const res = reply();
    await routes[route].find(h => h.length === 2)({ headers: { cookie: as ? cookieFor(as) : undefined }, params, body }, res);
    return res;
  };
  const templateWrites = () => db.calls.filter(c => /INSERT INTO board_templates/.test(c.sql));

  for (const route of ['GET /api/templates', 'GET /api/templates/:id', 'POST /api/templates', 'DELETE /api/templates/:id']) {
    const r = await hit(route, { params: { id: 'abc234' }, body: { snapshot: {} } });
    assert(r.statusCode === 401 && db.calls.length === 0,
      `${route} needs a signed-in teacher, and asks the database nothing without one`);
  }

  // Nobody's 8MB is parsed before they are known: the sign-in check sits in
  // front of the template body parser (found in review, 15 Sep 2026).
  assert(/app\.post\('\/api\/templates', writeLimit, signedInFirst, templateBody,/.test(src),
    'a template save is checked for a signed-in teacher before its body is read',
    'the body can be 8MB, and parsing it for a caller with no account is memory spent on nobody');
  {
    const gate = routes['POST /api/templates'][1];
    const anon = reply(); let anonPassed = false;
    gate({ headers: {} }, anon, () => { anonPassed = true; });
    const known = reply(); let knownPassed = false;
    gate({ headers: { cookie: cookieFor('u_anna') } }, known, () => { knownPassed = true; });
    assert(anon.statusCode === 401 && !anonPassed && knownPassed,
      'and a caller with no session is turned away there, before the parser runs');
  }
  assert(/TEMPLATE_WRITES_PER_MIN\) \|\| 20/.test(src),
    'template writes are capped at twenty a minute, the same as the 8MB lesson save');

  let r = await hit('GET /api/templates', { as: 'u_anna' });
  assert(r.statusCode === 200 && r.body.templates.length === 1, 'a teacher lists their templates');
  assert(db.calls[0].params.length === 1 && db.calls[0].params[0] === 'u_anna',
    'the list is read for the signed-in teacher only');
  assert(!/snapshot/.test(db.calls[0].sql), 'and never carries the boards themselves',
    'forty templates should not mean downloading forty boards to read their names on an iPad');

  r = await hit('GET /api/templates/:id', { as: 'u_anna', params: { id: 'abc234' } });
  assert(r.statusCode === 404 && db.calls[0].params[0] === 'u_anna' && db.calls[0].params[1] === 'abc234',
    "a template that is not this teacher's is simply not found",
    'the lookup is by owner AND id, so a guessed id opens nothing');

  r = await hit('POST /api/templates', { as: 'u_anna', body: {
    name: 'Pythagoras', snapshot: { shapes: [{ id: 's1' }] },
    owner_user_id: 'u_bob', ownerUserId: 'u_bob', teacher_id: 'u_bob', userId: 'u_bob',
  } });
  assert(r.statusCode === 200 && tplServer.isTemplateId(r.body.template.id),
    'a new template is saved with an id a link can carry');
  assert(db.calls.length > 0 && db.calls.every(c => c.params.includes('u_anna') && !c.params.includes('u_bob')),
    'the owner comes from the session cookie, never from the body',
    'a body naming another teacher changed whose template this is');
  assert(/DO NOTHING/.test(templateWrites()[0].sql),
    'a template saved without an id can never overwrite one');
  db.collide = 1;
  r = await hit('POST /api/templates', { as: 'u_anna', body: { name: 'Again', snapshot: {} } });
  const drawn = templateWrites().map(c => c.params[0]);
  assert(r.statusCode === 200 && drawn.length === 2 && drawn[0] !== drawn[1] && r.body.template.id === drawn[1],
    'a fresh id that collides draws another instead of replacing a template', drawn.join(' then '));

  const legacyId = tplPrefs.newTemplateId();
  r = await hit('POST /api/templates', { as: 'u_anna', body: {
    id: legacyId, name: 'From June', savedAt: Date.UTC(2025, 5, 1), snapshot: { texts: [] },
  } });
  const kept = templateWrites()[0];
  assert(r.statusCode === 200 && kept && kept.params[0] === legacyId && /DO UPDATE/.test(kept.sql),
    'an imported template keeps its browser id, so old ?template= links still open', legacyId);
  assert(kept && kept.params[5] instanceof Date && kept.params[5].getTime() === Date.UTC(2025, 5, 1),
    'and keeps the day it was saved');
  r = await hit('POST /api/templates', { as: 'u_anna', body: { id: 'ABC-12', name: 'x', snapshot: {} } });
  assert(r.statusCode === 400 && templateWrites().length === 0, 'an id no link can carry is refused');

  // No inline pictures, ever: they are what made one room 128MB.
  r = await hit('POST /api/templates', { as: 'u_anna', body: { name: 'Photo', snapshot: { objects: [{ id: 'i1', src: PNG }] } } });
  const stored = String(templateWrites()[0]?.params[3] || '');
  assert(r.statusCode === 200 && r.body.picturesMoved === 1 && /\/api\/board-image\/[0-9a-f]{32}/.test(stored),
    'a pasted picture is moved to the image store on the way in', `status ${r.statusCode}`);
  assert(stored.length > 0 && !/data:/.test(stored), 'and no inline data: URL is stored',
    'inline pictures made one room 128MB and crash-looped the server on 3-4 Sep 2026');
  r = await hit('POST /api/templates', { as: 'u_anna', body: {
    name: 'Vector', snapshot: { objects: [{ id: 'i1', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }] },
  } });
  assert(r.statusCode === 422 && templateWrites().length === 0,
    'a picture that cannot be moved out is refused rather than stored inline', r.body && r.body.error);
  assert(!db.calls.some(c => /INSERT INTO board_images/.test(c.sql)),
    'and nothing is put in the image store for a save that is refused',
    'the first version stored the pictures first and refused after, leaving them with nothing using them');
  r = await hit('POST /api/templates', { as: 'u_anna', body: {
    name: 'No type', snapshot: { objects: [{ id: 'i1', src: PNG.replace('data:image/png;', 'data:;') }] },
  } });
  assert(r.statusCode === 422 && templateWrites().length === 0,
    'a data: URL with no media type is caught too, not stored inline',
    'browsers draw data:;base64,iVBOR... as a PNG, and the first pattern let it through');
  r = await hit('POST /api/templates', { as: 'u_anna', body: { name: 'Hidden', snapshot: { shapes: [{ id: 's', fill: `url(${PNG})` }] } } });
  assert(r.statusCode === 422 && templateWrites().length === 0,
    'an inline picture anywhere on the board is caught, not only on image objects');
  db.imagesDown = true;
  r = await hit('POST /api/templates', { as: 'u_anna', body: { name: 'Photo', snapshot: { objects: [{ id: 'i1', src: PNG }] } } });
  db.imagesDown = false;
  assert(r.statusCode === 503 && templateWrites().length === 0,
    'with the image store down, the save is "try again" and nothing is stored inline');
  r = await hit('POST /api/templates', { as: 'u_anna', body: { name: 'Stats', snapshot: { texts: [{ id: 't', text: 'data: 3, 5, 8' }] } } });
  assert(r.statusCode === 200, 'a teacher writing "data: 3, 5, 8" on the board is not mistaken for a picture');
  assert(tplServer.findInlineDataUrls({ a: [{ b: PNG }] })[0]?.path === 'a[0].b',
    'an inline picture is reported with where it is');

  // Caps, each with a sentence that says what to do next.
  r = await hit('POST /api/templates', { as: 'u_anna', body: {
    name: 'Huge', snapshot: { strokes: [{ id: 'k', points: 'x'.repeat(tplServer.MAX_TEMPLATE_BYTES) }] },
  } });
  assert(r.statusCode === 413 && templateWrites().length === 0 && typeof r.body.error === 'string',
    `a board over ${tplServer.MAX_TEMPLATE_BYTES / 1048576}MB is refused with a reason`);
  r = await hit('POST /api/templates', { as: 'u_anna', body: {
    name: 'Huge, with a photo',
    snapshot: { objects: [{ id: 'i1', src: PNG }], strokes: [{ id: 'k', points: 'x'.repeat(tplServer.MAX_TEMPLATE_BYTES) }] },
  } });
  assert(r.statusCode === 413 && !db.calls.some(c => /INSERT INTO board_images/.test(c.sql)),
    'a board too large to keep is refused before any of its pictures are stored');
  db.have = { n: tplServer.MAX_TEMPLATES_PER_TEACHER, same: 0 };
  r = await hit('POST /api/templates', { as: 'u_anna', body: { name: 'One more', snapshot: {} } });
  assert(r.statusCode === 409 && templateWrites().length === 0 && /delete one/.test(r.body.error),
    `an account holds at most ${tplServer.MAX_TEMPLATES_PER_TEACHER} templates, and says what to do about it`);
  db.have = { n: tplServer.MAX_TEMPLATES_PER_TEACHER, same: 1 };
  r = await hit('POST /api/templates', { as: 'u_anna', body: { id: legacyId, name: 'Replaced', snapshot: {} } });
  assert(r.statusCode === 200, 'but replacing a template the teacher already has never counts against the cap');
  db.have = { n: 0, same: 0 };

  r = await hit('DELETE /api/templates/:id', { as: 'u_anna', params: { id: legacyId } });
  assert(db.calls.length === 1 && /DELETE FROM board_templates WHERE owner_user_id = \$1 AND id = \$2/.test(db.calls[0].sql)
    && db.calls[0].params[0] === 'u_anna', 'a teacher can delete only their own template');

  // server.ts parses JSON at 100kB before these routes exist, and a board with
  // a few hundred strokes passes that. A template body must be one that parser
  // leaves alone, and the route must parse that type itself.
  const globalParser = tplExpress.json();
  const parsedReq = { headers: { 'content-type': tplServer.TEMPLATE_MEDIA_TYPE, 'content-length': '4' } };
  let passedOn = false;
  globalParser(parsedReq, {}, (err) => { passedOn = !err; });
  assert(passedOn && !parsedReq._body, "server.ts's 100kB JSON parser leaves a template body to the template route");
  assert(/express\.json\(\{ type: TEMPLATE_MEDIA_TYPE/.test(src) && tplServer.TEMPLATE_MEDIA_TYPE === tplClient.TEMPLATE_MEDIA_TYPE,
    'which parses that type itself, and the browser sends exactly that type');
  const tooBig = reply();
  routes['POST /api/templates'].find(h => h.length === 4)({ type: 'entity.too.large', status: 413 }, {}, tooBig, () => {});
  assert(tooBig.statusCode === 413 && typeof tooBig.body?.error === 'string',
    'an oversize body gets a sentence back, not an HTML error page the client cannot read');

  const server = readFileSync('server.ts', 'utf8');
  const lessonsAt = server.indexOf('mountLessonRoutes(app, appPool');
  assert(lessonsAt > 0 && /mountTemplateRoutes\(app, appPool, \{ secret: sessionSecret \}\)/.test(server.slice(lessonsAt, lessonsAt + 300)),
    'the template routes are mounted beside the lesson library');
  assert(server.indexOf('mountTemplateRoutes') < server.indexOf("app.get('*'"),
    'before the page fallback, which would otherwise answer /api/templates with index.html');

  // Clearing class data must spare a template's pictures. A template keeps its
  // pictures in board_images like any board, and the clear (classData.ts)
  // deletes the pictures nothing references — where "nothing" used to mean no
  // room. Clearing last term would have punched holes in the boards next term
  // starts from. And the preview must count exactly what the delete deletes.
  const clearRecorder = (largeRooms = 0) => {
    const calls = [];
    const answer = async (sql, params = []) => {
      calls.push({ sql, params });
      if (/pg_column_size/.test(sql)) return { rows: [{ count: String(largeRooms) }], rowCount: 1 };
      if (/^\s*SELECT count/.test(sql)) return { rows: [{ count: '0' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    return { calls, query: answer, connect: async () => ({ query: answer, release() {} }) };
  };
  // A template's pictures count as in use on its board or as its thumbnail.
  // Since 15 Sep 2026 every mentioned id is gathered once, rather than searched
  // for picture by picture (mentionedPicturesSql in classData.ts).
  const sparesTemplates = (sql) => /FROM board_templates t, regexp_matches\(t\.snapshot::text, /.test(sql)
    && /SELECT t\.preview_image_id FROM board_templates t WHERE t\.preview_image_id IS NOT NULL/.test(sql);
  const whereOf = (sql) => sql.slice(sql.indexOf(' WHERE ') + ' WHERE '.length);
  const standingAs = (w) => w.replace(/(FROM rooms r, regexp_matches\(r\.data::text, '[^']*', 'g'\) AS m WHERE) (r\.updated_at >= \$1|false|true)/, '$1 <standing>');
  for (const before of [null, new Date('2026-09-01T00:00:00Z')]) {
    const label = before ? 'with a date' : 'for everything';
    const previewDb = clearRecorder();
    await tplClassData.previewClear(previewDb, before);
    const clearDb = clearRecorder();
    await tplClassData.clearClassData(clearDb, before);
    const counted = previewDb.calls.find(c => /FROM board_images/.test(c.sql));
    const deleted = clearDb.calls.find(c => /DELETE FROM board_images/.test(c.sql));
    assert(!!counted && sparesTemplates(counted.sql),
      `the clear's preview (${label}) counts a picture a saved template uses as in use`);
    assert(!!deleted && sparesTemplates(deleted.sql),
      `the clear itself (${label}) spares a picture a saved template uses`,
      'clearing a term of class data would punch holes in the boards next term starts from');
    assert(!!counted && !!deleted
      && whereOf(counted.sql) === tplClassData.unusedPictureWhere(before, 'preview')
      && whereOf(deleted.sql) === tplClassData.unusedPictureWhere(before, 'delete'),
      `the preview and the delete (${label}) are built from the one definition of an unused picture`,
      'a confirmation that counts differently from the delete is a confirmation that lies');
    assert(standingAs(tplClassData.unusedPictureWhere(before, 'preview')) === standingAs(tplClassData.unusedPictureWhere(before, 'delete')),
      `and differ (${label}) only in which rooms are still standing when they ask`);
    assert([...previewDb.calls, ...clearDb.calls].every(c => (/\$1(?!\d)/.test(c.sql) ? 1 : 0) === c.params.length),
      `every clear statement (${label}) binds exactly the parameters it uses`,
      'Postgres refuses a bind with one to spare, which would fail the whole clear');
  }
  assert(/regexp_matches\(r\.data::text, '[^']*', 'g'\) AS m WHERE r\.updated_at >= \$1/.test(tplClassData.unusedPictureWhere(new Date(), 'preview'))
    && /regexp_matches\(r\.data::text, '[^']*', 'g'\) AS m WHERE false/.test(tplClassData.unusedPictureWhere(null, 'preview'))
    && /regexp_matches\(r\.data::text, '[^']*', 'g'\) AS m WHERE true/.test(tplClassData.unusedPictureWhere(null, 'delete')),
    'the preview counts pictures on the rooms that will still stand: newer than the date, or none when everything goes',
    'a condition of "true" in the preview would count pictures on boards about to be deleted as safe');
  {
    const token = /regexp_matches\(r\.data::text, '([^']*)', 'g'\)/.exec(tplClassData.unusedPictureWhere(null, 'delete'))?.[1];
    const idA = 'a'.repeat(32);
    const idB = '0123456789abcdef0123456789abcdef';
    const boardText = JSON.stringify({
      objects: [{ src: `/api/board-image/${idA}` }, { src: `/api/board-image/${idB}` }],
      note: 'f'.repeat(64),
    });
    const found = token ? [...boardText.matchAll(new RegExp(token, 'g'))].map(m => m[1]) : [];
    assert(found.length === 2 && found.includes(idA) && found.includes(idB),
      'the scan finds every picture link on a board, and not a longer hex run that merely contains 32 characters',
      JSON.stringify(found));
  }
  assert(tplClassData.unusedPictureWhere(new Date(), 'delete').startsWith('bi.created_at < $1'),
    'with a date, a picture newer than it is kept even when no saved board mentions it yet',
    'it may be on a live board that has not been saved since — keeping it is the safe direction');
  const bigPreview = clearRecorder(1);
  const bigCounts = await tplClassData.previewClear(bigPreview, null);
  const bigClear = clearRecorder(1);
  await tplClassData.clearClassData(bigClear, null);
  assert(bigCounts.boardImages === 0
    && !bigPreview.calls.some(c => /FROM board_images/.test(c.sql))
    && !bigClear.calls.some(c => /FROM board_images/.test(c.sql)),
    'while a standing board is too big to scan, neither the preview nor the delete touches pictures');

  // Anything else that ever deletes pictures would have to know about
  // templates too, so for now there must not be anything else.
  const scanned = [
    'server.ts',
    ...tplReaddir('src/server').filter(f => f.endsWith('.ts')).map(f => `src/server/${f}`),
    ...listMigrationFiles().map(f => `src/server/migrations/${f}`),
    ...tplReaddir('scripts').filter(f => /\.(mjs|js|ts|sh|sql)$/.test(f)).map(f => `scripts/${f}`),
    ...tplReaddir('deploy').filter(f => /\.(sh|sql|mjs|js)$/.test(f)).map(f => `deploy/${f}`),
  ];
  const deleters = scanned.filter(f => /(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+board_images/i.test(readFileSync(f, 'utf8')));
  assert(deleters.length === 1 && deleters[0] === 'src/server/classData.ts',
    'the class-data clear is the only code anywhere that deletes pictures', deleters.join(', '));

  // The browser's side: one list from two, and a move into the account that
  // happens once and deletes nothing.
  const acct = (id, savedAt, name = `account ${id}`) => ({ id, name, savedAt, source: 'account' });
  const dev = (id, savedAt, name = `device ${id}`) => ({ id, name, savedAt, source: 'device' });
  const merged = tplClient.mergeTemplateLists(
    [acct('aaaaaa', 100, 'Pythagoras (account)')],
    [dev('aaaaaa', 900, 'Pythagoras (old copy)'), dev('bbbbbb', 500), dev('bbbbbb', 400, 'duplicate')],
  );
  assert(merged.length === 2 && merged.filter(t => t.id === 'aaaaaa').length === 1 && merged.filter(t => t.id === 'bbbbbb').length === 1,
    'the account and browser lists merge to one entry per id', merged.map(t => t.id).join(', '));
  assert(merged.find(t => t.id === 'aaaaaa')?.name === 'Pythagoras (account)' && merged.find(t => t.id === 'aaaaaa')?.source === 'account',
    'where both hold a template, the account copy wins',
    'it is the one every device sees, and its pictures are out of line');
  assert(merged.find(t => t.id === 'bbbbbb')?.source === 'device' && merged.find(t => t.id === 'bbbbbb')?.savedAt === 500,
    'a template only this browser has is kept, marked as this device only');
  assert(merged[0].id === 'bbbbbb', 'newest first, as the browser list always was');
  assert(tplClient.mergeTemplateLists([], [dev('cccccc', 1)], ['cccccc']).length === 0,
    'a template this browser moved to the account and was then deleted there does not come back from the local copy',
    'deleting it on the iPad must not leave it on the laptop');

  const importWb = { shapes: [] };
  const plan = tplClient.planTemplateImport([
    { id: 'aaaaaa', name: 'in the account', savedAt: 1, whiteboard: importWb },
    { id: 'dddddd', name: 'sent before', savedAt: 1, whiteboard: importWb },
    { id: 'eeeeee', name: 'refused before', savedAt: 1, whiteboard: importWb },
    { id: 'NOT-OK', name: 'odd id', savedAt: 1, whiteboard: importWb },
    { id: 'ffffff', name: 'no board', savedAt: 1 },
    { id: 'gggggg', name: 'to move', savedAt: 1, whiteboard: importWb },
  ], ['aaaaaa'], tplClient.readImportRecord({ imported: ['dddddd'], refused: ['eeeeee'], noticeShown: false }));
  assert(plan.length === 1 && plan[0].id === 'gggggg',
    'only browser copies the account has not got, been sent or refused are offered to it', plan.map(t => t.id).join(', '));
  assert(tplClient.readImportRecord('garbage').imported.length === 0, 'a corrupt import record reads as a fresh one');
  // A laptop two teachers share: the second to sign in must not get the first
  // one's templates copied into their account (found in review, 15 Sep 2026).
  const owners = tplClient.readImportOwners({ aaaaaa: 'u_anna', gggggg: 'u_anna', bogus: 7 });
  const bobPlan = tplClient.planTemplateImport([
    { id: 'aaaaaa', name: "Anna's", savedAt: 1, whiteboard: importWb },
    { id: 'hhhhhh', name: 'nobody has moved this', savedAt: 1, whiteboard: importWb },
  ], [], tplClient.readImportRecord(null), tplClient.importedByOtherAccounts(owners, 'u_bob'));
  assert(bobPlan.map(t => t.id).join() === 'hhhhhh',
    "a template this browser already moved into another teacher's account is not offered to this one",
    bobPlan.map(t => t.id).join());
  assert(tplClient.importedByOtherAccounts(owners, 'u_anna').length === 0 && !('bogus' in owners),
    'while its own owner still sees it as theirs, and a corrupt entry is dropped');

  // Ids stay link-compatible: /room/X?template=abc234 made before today opens.
  assert(tplPrefs.TEMPLATE_ID_ALPHABET === tplServer.TEMPLATE_ID_ALPHABET,
    'the browser and the server mint template ids from the same alphabet');
  const minted = [
    ...Array.from({ length: 300 }, () => tplPrefs.newTemplateId()),
    ...Array.from({ length: 300 }, () => tplServer.newTemplateId()),
  ];
  assert(minted.every(id => tplServer.isTemplateId(id) && tplClient.isLinkableTemplateId(id)),
    'every id either side mints is one the server accepts', String(minted.find(id => !tplServer.isTemplateId(id))));
  assert(minted.every(id => encodeURIComponent(id) === id
    && new URL(`https://mathslive.test/room/r1?name=T&template=${id}`).searchParams.get('template') === id),
    'and passes through a ?template= link unchanged');
  assert(['abc23', 'abc2345', 'abc 23', '../etc', 'ABC123'].every(id => !tplServer.isTemplateId(id)),
    'anything else is not a template id');

  // The move itself, end to end, against a browser and a server made of Maps.
  const kv = new Map();
  const fakeStorage = {
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => { kv.set(k, String(v)); },
    removeItem: (k) => { kv.delete(k); },
  };
  const realGlobals = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    fetch: globalThis.fetch,
  };
  const inAccount = new Map();
  const sentRequests = [];
  let offline = false;
  let signedIn = true;
  let accountFull = false;
  const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(globalThis, 'window', { value: { localStorage: fakeStorage, dispatchEvent: () => true }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true, writable: true });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    sentRequests.push({ url: String(url), method, type: init.headers?.['Content-Type'], body: init.body });
    if (offline) throw new TypeError('Failed to fetch');
    if (!signedIn) return answer(401, { error: 'Sign in to save templates to your account.' });
    const one = /^\/api\/templates\/([a-z0-9]{6})$/.exec(String(url));
    if (String(url) === '/api/templates' && method === 'GET') {
      return answer(200, { templates: [...inAccount.values()].map(({ id, name, saved_at }) => ({ id, name, bytes: 1, saved_at })) });
    }
    if (String(url) === '/api/templates' && method === 'POST') {
      if (accountFull) return answer(409, { error: 'Your account holds 100 templates — delete one to save another.', code: 'template_limit' });
      const b = JSON.parse(init.body);
      const id = b.id || tplServer.newTemplateId();
      inAccount.set(id, { id, name: b.name, saved_at: new Date(b.savedAt || Date.now()).toISOString(), snapshot: b.snapshot });
      return answer(200, { template: { id, name: b.name, bytes: 1, saved_at: inAccount.get(id).saved_at } });
    }
    if (one && method === 'GET') {
      return inAccount.has(one[1]) ? answer(200, { template: inAccount.get(one[1]) }) : answer(404, { error: 'No such template.' });
    }
    if (one && method === 'DELETE') { inAccount.delete(one[1]); return answer(200, { ok: true, deleted: 1 }); }
    return answer(404, { error: 'unexpected request' });
  };
  try {
    const june = Date.UTC(2026, 5, 1);
    kv.set('mathlive:templates', JSON.stringify([
      { id: 'abc234', name: 'Pythagoras starter', savedAt: june, whiteboard: { shapes: [{ id: 's1' }] } },
      { id: 'xyz789', name: 'Number line', savedAt: june + 1000, whiteboard: { texts: [{ id: 't1', text: '0 1 2' }] } },
    ]));

    const signedOutList = await tplClient.loadTemplateList(null);
    assert(signedOutList.from === 'device' && signedOutList.templates.length === 2 && sentRequests.length === 0,
      "signed out, the list is this browser's templates and nothing is asked of the server");

    const firstLoad = await tplClient.loadTemplateList('u_anna');
    const firstPosts = sentRequests.filter(q => q.method === 'POST');
    assert(firstPosts.length === 2 && firstPosts.every(q => q.type === tplClient.TEMPLATE_MEDIA_TYPE),
      "the first signed-in load moves each of this browser's templates into the account", `${firstPosts.length} sent`);
    assert(inAccount.has('abc234') && inAccount.has('xyz789') && firstLoad.templates.every(t => t.source === 'account'),
      'keeping their ids, so ?template= links made before today still open');
    assert(inAccount.get('abc234')?.saved_at === new Date(june).toISOString(), 'and the day each one was saved');
    assert(firstLoad.notice === 'Your board templates are now saved to your account' && firstLoad.notice === tplClient.IMPORT_NOTICE,
      'and says so: "Your board templates are now saved to your account"');
    assert(JSON.parse(kv.get('mathlive:templates')).length === 2,
      'every local copy is still there afterwards', 'this release deletes nothing a teacher saved in the browser');

    tplClient.markImportNoticeShown('u_anna');
    sentRequests.length = 0;
    const secondLoad = await tplClient.loadTemplateList('u_anna');
    assert(sentRequests.filter(q => q.method === 'POST').length === 0 && secondLoad.notice === null && secondLoad.templates.length === 2,
      'the next load sends nothing again, and the notice is not shown twice');

    inAccount.delete('abc234');
    const thirdLoad = await tplClient.loadTemplateList('u_anna');
    assert(thirdLoad.templates.map(t => t.id).join() === 'xyz789' && JSON.parse(kv.get('mathlive:templates')).length === 2,
      'a template deleted on another device stays gone here, and its local copy is left alone');

    const opened = await tplClient.getTemplate('xyz789');
    assert(opened.from === 'account' && opened.template?.whiteboard?.texts?.[0]?.text === '0 1 2',
      'a template link opens from the account');

    offline = true;
    const offlineList = await tplClient.loadTemplateList('u_anna');
    assert(offlineList.from === 'unreachable' && offlineList.templates.length === 2 && typeof offlineList.problem === 'string',
      "with the server out of reach the list falls back to this browser's copies, and says so");
    const openedOffline = await tplClient.getTemplate('abc234');
    assert(openedOffline.from === 'device' && openedOffline.template?.name === 'Pythagoras starter',
      "and a template link still opens from this browser's copy");
    const offlineSave = await tplClient.saveTemplate('Fractions wall', { shapes: [] });
    assert(offlineSave.ok && offlineSave.saved?.source === 'device' && /could not be reached/.test(offlineSave.message),
      'a save the account cannot receive is kept on this device, and the toast says so', offlineSave.message);
    offline = false;

    signedIn = false;
    const signedOutSave = await tplClient.saveTemplate('Angles', { shapes: [] });
    assert(signedOutSave.ok && signedOutSave.saved?.source === 'device' && /^✓ Saved on this device/.test(signedOutSave.message),
      'signed out, a save lands on this device as it always did');
    signedIn = true;

    const onlineSave = await tplClient.saveTemplate('Circles', { shapes: [] });
    assert(onlineSave.ok && onlineSave.saved?.source === 'account' && inAccount.has(onlineSave.saved.id),
      'signed in, a save lands in the account');

    sentRequests.length = 0;
    const fourthLoad = await tplClient.loadTemplateList('u_anna');
    const movedLater = sentRequests.filter(q => q.method === 'POST').map(q => JSON.parse(q.body).name).sort();
    assert(movedLater.join() === 'Angles,Fractions wall',
      'templates saved on this device while the account was out of reach move there on the next load', movedLater.join());
    assert(fourthLoad.notice === null, 'without showing the notice again');

    // A full account stops the move without writing anything off for good.
    kv.set('mathlive:templates', JSON.stringify([
      ...JSON.parse(kv.get('mathlive:templates')),
      { id: 'full22', name: 'Waiting 1', savedAt: Date.UTC(2026, 6, 1), whiteboard: { shapes: [] } },
      { id: 'full33', name: 'Waiting 2', savedAt: Date.UTC(2026, 6, 2), whiteboard: { shapes: [] } },
    ]));
    accountFull = true;
    sentRequests.length = 0;
    const fullLoad = await tplClient.loadTemplateList('u_anna');
    const fullRecord = JSON.parse(kv.get('mathlive:templatesImport:u_anna') || '{}');
    assert(sentRequests.filter(q => q.method === 'POST').length === 1 && /full/.test(fullLoad.problem || ''),
      'a full account stops the move at the first refusal, and says the account is full', String(fullLoad.problem));
    assert(!(fullRecord.refused || []).includes('full22') && !(fullRecord.refused || []).includes('full33'),
      'without marking those templates refused for ever', JSON.stringify(fullRecord.refused));
    accountFull = false;
    await tplClient.loadTemplateList('u_anna');
    assert(inAccount.has('full22') && inAccount.has('full33'), 'so they move once the account has room');

    signedIn = false;
    const removal = await tplClient.removeTemplate({ id: 'full22', source: 'account' }, 'u_anna');
    signedIn = true;
    assert(!removal.ok && /Sign in again/.test(removal.problem || '') && inAccount.has('full22'),
      'removing a template while signed out is reported as not done, rather than quietly half done',
      'the account copy would come back on the next load and stay on the iPad');
  } finally {
    if (realGlobals.window) Object.defineProperty(globalThis, 'window', realGlobals.window); else delete globalThis.window;
    if (realGlobals.localStorage) Object.defineProperty(globalThis, 'localStorage', realGlobals.localStorage); else delete globalThis.localStorage;
    globalThis.fetch = realGlobals.fetch;
  }
}

section('OFFLINE — clearing a class does not clear the student');
{
  // 4 Sep 2026: "delete all the data of the classes. Don't delete the name of
  // the student, just the data of the classes. And also give an option in the
  // admin section where I can directly click on clear data of the classes and
  // select date."
  //
  // The distinction in that sentence is the whole design, and it is one table
  // away from being got wrong: `classes` holds the student's name, grade, goals
  // and room code. Losing it means re-adding every student by hand and
  // reissuing every learner link.
  const cd = readFileSync('src/server/classData.ts', 'utf8');

  assert(!/classes/.test(cd.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'no statement in the clear path can reach the students table',
    'the roster is who he teaches; the boards are only what a class produced');
  for (const t of ['rooms', 'board_images', 'teaching_sessions']) {
    assert(cd.includes(`FROM ${t}`), `${t} is cleared`);
  }

  // A date that silently becomes Invalid Date compares false against every row,
  // so the delete would quietly remove NOTHING and report success.
  assert(/Number\.isNaN\(d\.getTime\(\)\)/.test(cd),
    'an unreadable date is refused, not treated as "everything"');
  assert(cutoffFrom('') === null && cutoffFrom(undefined) === null,
    'no date means everything');
  assert(cutoffFrom('2026-09-01').toISOString().startsWith('2026-09-01'),
    'a date is read as given');
  let threw = false;
  try { cutoffFrom('not a date'); } catch { threw = true; }
  assert(threw, 'nonsense is rejected');

  // The count shown in the confirmation must be the count that goes.
  assert(/updated_at < \$1/.test(cd) && /created_at < \$1/.test(cd) && /started_at < \$1/.test(cd),
    'each table is filtered by its own timestamp');

  // A picture is content-addressed and shared between boards, so age alone
  // cannot decide it: an old picture may sit on a board that is not going.
  // Since 15 Sep 2026 the references are gathered once (every picture id the
  // standing boards mention) rather than searched for picture by picture.
  assert(/bi\.id NOT IN \(/.test(cd) && /regexp_matches\(r\.data::text, /.test(cd),
    'pictures are collected by reference, not by age',
    'deleting an old picture still used by a surviving board leaves a hole in it');
  assert(!/position\(bi\.id in r\.data::text\)/.test(cd),
    'and not by searching every board once for every picture',
    'that was pictures x rooms x size on the live database; on 15 Sep 2026 it ran past 20 seconds on production');
  assert(/pg_column_size\(data\) > 8388608/.test(cd),
    'the reference scan is skipped when a board is still large',
    'casting a big jsonb to text has taken this database down twice; skipping keeps a picture that could have gone, which is the safe direction');

  assert(/confirm !== true/.test(cd), 'the delete needs an explicit confirmation');
  assert(/'users\.manage'/.test(cd),
    'it takes the same permission as suspending an account',
    'erasing every board is not a lesser act than disabling one login');
  assert(/action: 'class_data\.clear'/.test(cd), 'and it is written to the audit log');
  assert(cd.indexOf("client.query('COMMIT')") < cd.indexOf("action: 'class_data.clear'"),
    'the audit line is written after the transaction commits',
    'a rolled-back delete that still logged would be worse than no log');
}

section('OFFLINE — production does not compile TypeScript while it teaches');
{
  // 4 Sep 2026, 03:10 UTC: the app died 75 seconds after a deploy with no rooms
  // open, and the V8 stack said where —
  //
  //   Runtime_CompileLazy -> Compiler::Compile -> Scope::AllocateScopeInfos
  //
  // It ran out of memory COMPILING JAVASCRIPT. Production ran through tsx,
  // which transpiles every .ts file at runtime inside the same heap the lessons
  // live in, so the compiler and its scope info competed with the class for a
  // 448MB ceiling on a 911MB box that also runs Postgres. Measured on one
  // machine with 61 rooms loaded: tsx 135MB across two processes, the prebuilt
  // bundle 61MB in one.
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert(!/tsx/.test(pkg.scripts.start),
    'the start script does not run TypeScript through tsx',
    'the transpiler is a bigger process than the app, and it allocates while a class is running');
  assert(/dist-server\/server\.mjs/.test(pkg.scripts.start),
    'production runs a bundle built ahead of time');
  assert(typeof pkg.scripts['build:server'] === 'string',
    'and there is a step that builds it');

  // A bundle that is never shipped is worse than no bundle: the box would run
  // whatever stale copy it already had.
  const pack = readFileSync('tools/pack_release.mjs', 'utf8');
  assert(/'dist-server'/.test(pack), 'the release carries the built server');
  assert(/build:server/.test(pack), 'and rebuilds it on every pack');
  const rel = readFileSync('deploy/release.sh', 'utf8');
  assert(/PARTS=\(.*dist-server.*\)/.test(rel),
    'a rollback restores the server build belonging to the release it restores');

  // .sql files are data; no bundler carries them. Resolving the wrong directory
  // does not throw — it silently finds nothing and reports "nothing to do".
  const mig = readFileSync('src/server/migrate.ts', 'utf8');
  assert(/existsSync\(beside\)/.test(mig),
    'the migration runner checks the folder is really there before trusting it',
    'bundled, this file no longer sits beside its own migrations');
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
import { readFileSync, readdirSync } from 'fs';
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

section('OFFLINE — free access is not a trial that ran out');
{
  // 14 Sep 2026. The teacher seat honoured grants from the day they shipped.
  // Nothing else that reads billing did: the expiry emails and the figures on
  // /admin read the dates alone, where a free-forever teacher looks exactly
  // like a trial that ended. So Vani, free forever since 3 Sep, was emailed
  // eight times between 5 and 10 Sep that the access was ending and then that
  // it had ended, and /admin counted both teachers on free access as lapsed.
  const IST = (s) => new Date(`${s}+05:30`);
  const counts = { claims_pending: 0, collected_month: 0, lessons_yesterday: 0, new_signups: 0 };
  const teacher = (over) => ({
    id: 'u', email: 'x@y', trial_started_at: null, paid_until: null,
    grant_active: false, grant_until: null, monthly_rupees: null, last_lesson: null, ...over,
  });

  // That account, as it stood: a trial from 31 Aug, and a grant with no end.
  const vani = teacher({ id: 'u_v', email: 'v@x', trial_started_at: IST('2026-08-31T09:00:00'),
    grant_active: true });
  const datesOnly = { ...vani, grant_active: false };
  for (const at of ['2026-09-06T08:04:00', '2026-09-08T08:12:00', '2026-09-10T08:12:47']) {
    assert(_warningsDue([datesOnly], IST(at)).length === 1,
      `read from the dates alone, it was owed a warning at ${at}`,
      'the control: without it the next check proves nothing');
    assert(_warningsDue([vani], IST(at)).length === 0,
      `with its grant, it is owed nothing at ${at}`,
      'these are the emails that went out');
  }
  const trialDue = _warningsDue([datesOnly], IST('2026-09-06T08:04:00'))[0];
  const trialMail = trialDue && _warningMail(trialDue.kind, trialDue.access, trialDue.standing);
  assert(trialMail && /free trial ends in 2 days/.test(trialMail.body) && /days of grace/.test(trialMail.body),
    'a trial is still called a trial, and still promised its grace', trialMail && trialMail.body);

  // A dated grant ends like anything else and is warned about like anything
  // else, but in words that fit: it was never a trial or a subscription.
  const rachel = teacher({ id: 'u_r', email: 'r@x', trial_started_at: IST('2026-09-02T16:00:00'),
    grant_active: true, grant_until: IST('2027-09-13T15:29:46') });
  assert(_warningsDue([rachel], IST('2026-09-14T11:00:00')).length === 0,
    'a year of free access earns no warning today');
  const due = _warningsDue([rachel], IST('2027-09-11T16:00:00'));
  assert(due.length === 1 && due[0].kind === 'warn_2', 'two days before a dated grant ends, it is warned',
    JSON.stringify(due.map(d => d.kind)));
  const mail = due[0] && _warningMail(due[0].kind, due[0].access, due[0].standing);
  assert(mail && /free access ends in 2 days/.test(mail.body) && !/subscription|free trial/.test(mail.body),
    'and the email calls it free access', mail && mail.body);
  assert(mail && !/grace/.test(mail.body),
    'and promises no grace days',
    'grace follows paid and trial time; when a grant ends the seat goes by the dates underneath');

  // The owner's numbers.
  const now = IST('2026-09-14T11:00:00');
  const payer = teacher({ id: 'u_p', email: 'p@x', trial_started_at: IST('2026-07-01T10:00:00'),
    paid_until: IST('2026-09-18T10:00:00'), monthly_rupees: '400.0000000000000000',
    last_lesson: IST('2026-08-01T10:00:00') });
  const lapsed = teacher({ id: 'u_l', email: 'l@x', trial_started_at: IST('2026-08-01T10:00:00') });
  const trying = teacher({ id: 'u_t', email: 't@x', trial_started_at: IST('2026-09-13T10:00:00') });
  const everyone = [vani, rachel, payer, lapsed, trying];

  assert(standingOf(vani, now).standing === 'free' && standingOf(vani, now).access.state === 'active',
    'to the gate a grant is active; to the owner it is free access');
  assert(standingOf({ ...rachel, grant_until: IST('2026-09-13T00:00:00') }, now).standing === 'lapsed',
    'a grant that has ended is not free access');

  const f = businessFigures(everyone, now);
  const shown = JSON.stringify(f);
  assert(f.free === 2, 'both grants count as free access', shown);
  assert(f.expired === 1 && f.in_grace === 0, 'only the teacher who really lapsed counts as lapsed', shown);
  assert(f.paying === 1 && f.mrr === 400, 'a grant adds nothing to paying or to the revenue', shown);
  assert(f.trialing === 1, 'or to the trials', shown);
  assert(f.expiring_7d === 1 && f.trials_ending_3d === 0,
    'a renewal on the 18th is expiring; a grant ending next September is not', shown);

  const text = _digestLines(everyone, counts, now).lines.join('\n');
  assert(/Paying 1\s+·\s+on trial 1\s+·\s+free access 2\s+·\s+₹400\/month/.test(text),
    'the morning digest counts the same way', text);
  assert(!/v@x|r@x/.test(text), 'and lists neither grant as running out or gone quiet', text);
  assert(/Running out within 7 days:\n\s+· p@x/.test(text), 'while the real renewal still heads the list', text);
  assert(/no lesson in 14 days[^\n]*\n\s+· p@x/.test(text), 'and a quiet payer is still flagged', text);

  const ending = { ...rachel, grant_until: IST('2026-09-17T10:00:00') };
  const soonText = _digestLines([ending], counts, now).lines.join('\n');
  assert(/r@x — .+\(free access\)/.test(soonText),
    'a dated grant about to end is listed, and says what is ending', soonText);

  // The class of bug, not only this instance. A query that hands rows to
  // accessFrom() without the grant compiles, passes every other check here,
  // and quietly turns free access into a lapsed trial.
  for (const file of readdirSync('src/server').filter(n => n.endsWith('.ts') && n !== 'billing.ts')) {
    const code = readFileSync(`src/server/${file}`, 'utf8');
    if (/\b(accessFrom|standingOf|businessFigures)\((?!\))/.test(code)) {
      assert(/LIVE_GRANT_JOIN|BILLABLE_TEACHERS_SQL/.test(code),
        `${file} reads billing with grants joined`,
        'without them a free-forever teacher reads as a trial that ran out');
    }
    assert(!/JOIN LATERAL[\s\S]{0,200}plan_grants/.test(code),
      `${file} keeps no private copy of the grant join`,
      'a copy is how the emails and /admin fell out of step with the gate');
  }
  assert(!/AS (paying|trialing|expired|in_grace|mrr)\b/.test(readFileSync('src/server/ownerDash.ts', 'utf8')),
    'the /admin strip does not recount teachers in SQL', 'that copy is the one that forgot grants');
  assert(!/AS (paying|trialing|mrr)\b/.test(readFileSync('src/server/scheduler.ts', 'utf8')),
    'nor does the digest');
}

section('OFFLINE — an expiry email goes out once, not on consecutive days');
{
  // 14 Sep 2026, from production mail_log: every teacher whose access ended was
  // told "ends in 2 days" twice, "ends tomorrow" twice, and "your access ended"
  // on every day of grace. Rachel's ended at 16:18 IST, and she was sent warn_2
  // on 7 and 8 Sep, warn_1 on 8 and 9 Sep, and grace on 9, 10, 11 and 12 Sep.
  // Each was claimed under the day it went out, and "two days left" is true on
  // two dates whenever access ends after the 8am run.
  //
  // So the real mail run is put through a run every 15 minutes from 08:00 IST,
  // for days on end, against a mail_log that keeps its primary key the way
  // Postgres does, and what arrives in each inbox is read back.
  const IST = (s) => new Date(`${s}+05:30`);
  const DAY = 86_400_000, QUARTER = 15 * 60_000, IST_OFFSET = 5.5 * 3_600_000;
  const inIST = (t) => new Date(new Date(t).getTime() + IST_OFFSET).toISOString().slice(0, 16).replace('T', ' ');
  // Every quarter hour, plus any restarts, behind the tick's own gate: nothing
  // before 8am in India.
  const runsBetween = (from, until, extra = []) => {
    const at = extra.map(d => d.getTime());
    for (let t = from.getTime(); t < until.getTime(); t += QUARTER) at.push(t);
    return at.filter(t => new Date(t + IST_OFFSET).getUTCHours() >= 8).sort((a, b) => a - b);
  };
  const kindOf = (subject) => /ends in 2 days/.test(subject) ? 'warn_2'
    : /ends tomorrow/.test(subject) ? 'warn_1'
    : /grace left/.test(subject) ? 'grace'
    : /paying/.test(subject) ? 'digest'
    : `unknown: ${subject}`;
  const teacher = (id, ends, over = {}) => ({
    id, email: `${id}@x`, trial_started_at: new Date(ends.getTime() - TRIAL_DAYS * DAY), paid_until: null,
    grant_active: false, grant_until: null, monthly_rupees: null, last_lesson: null, ...over,
  });

  // A pretend Postgres and a pretend Resend, kept across every run in a world.
  const world = (teachers, legacyRows = []) => {
    const log = legacyRows.map(r => ({ ...r }));
    const inbox = [];
    let now = null, failFor = null;
    const pool = { async query(sql, params = []) {
      const [kind, target, day] = params;
      const same = (r) => r.kind === kind && r.target === target && r.day === day;
      if (/^\s*INSERT INTO mail_log/.test(sql)) {
        if (log.some(same)) return { rows: [], rowCount: 0 };
        log.push({ kind, target, day, sent_at: now });
        return { rows: [{}], rowCount: 1 };
      }
      if (/^\s*DELETE FROM mail_log/.test(sql)) {
        const i = log.findIndex(same);
        if (i >= 0) log.splice(i, 1);
        return { rows: [], rowCount: i >= 0 ? 1 : 0 };
      }
      // Every row, whatever the WHERE says. Nothing here can run that SQL, so
      // the decision has to come out right without leaning on its filter.
      if (/FROM mail_log/.test(sql)) return { rows: log.map(r => ({ ...r })), rowCount: log.length };
      if (/claims_pending/.test(sql)) {
        return { rows: [{ claims_pending: 0, collected_month: 0, lessons_yesterday: 0, new_signups: 0 }], rowCount: 1 };
      }
      if (/plan_grants/.test(sql)) return { rows: teachers.map(t => ({ ...t })), rowCount: teachers.length };
      throw new Error(`the pretend database did not expect: ${sql.trim().slice(0, 60)}`);
    } };
    const send = async (to, subject) => {
      if (failFor && to.includes(failFor)) { failFor = null; return { ok: false, reason: 'Resend is down' }; }
      inbox.push({ to: to.join(','), line: `${kindOf(subject)} ${inIST(now)}` });
      return { ok: true };
    };
    return {
      log,
      failOnce: (email) => { failFor = email; },
      to: (email) => inbox.filter(m => m.to === email).map(m => m.line),
      async run(from, until, extra) {
        const loud = [console.log, console.error];
        console.log = console.error = () => {};
        try {
          for (const t of runsBetween(from, until, extra)) {
            now = new Date(t);
            await _sendDailyMail(pool, now, send);
          }
        } finally {
          [console.log, console.error] = loud;
        }
      },
    };
  };

  const ownerWas = process.env.OWNER_EMAIL;
  process.env.OWNER_EMAIL = 'owner@x';

  // Her shape: a trial ending at 16:18 IST, from three days out to past the end
  // of grace, with restarts at the moments the old key sent the second copy.
  const END = IST('2026-09-09T16:18:00');
  const rachel = teacher('rachel', END);
  // The same dates under a grant with no end. From the dates alone this account
  // is owed every one of those emails.
  const vani = teacher('vani', END, { grant_active: true, grant_until: null });

  // The control: the same runs, claimed under the day each one ran, send what
  // production sent. Without it the counts below would prove nothing.
  const byDay = { warn_2: new Set(), warn_1: new Set(), grace: new Set() };
  for (const t of runsBetween(IST('2026-09-06T00:00:00'), IST('2026-09-14T00:00:00'))) {
    const due = _warningsDue([rachel], new Date(t))[0];
    if (due) byDay[due.kind].add(inIST(t).slice(5, 10));
  }
  const oldKey = Object.entries(byDay).map(([k, days]) => `${k}: ${[...days].join(' ')}`).join('; ');
  assert(oldKey === 'warn_2: 09-07 09-08; warn_1: 09-08 09-09; grace: 09-09 09-10 09-11 09-12',
    'claimed under the day it ran, the same runs send what production sent', oldKey);

  const w = world([rachel, vani]);
  await w.run(IST('2026-09-06T00:00:00'), IST('2026-09-14T00:00:00'),
    [IST('2026-09-08T08:01:00'), IST('2026-09-09T08:01:00'), IST('2026-09-10T08:01:00')]);
  const got = w.to('rachel@x');
  assert(JSON.stringify(got) === JSON.stringify(['warn_2 2026-09-07 16:30', 'warn_1 2026-09-08 16:30', 'grace 2026-09-09 16:30']),
    'each warning goes out once, at the first run after it falls due', JSON.stringify(got));
  const keys = w.log.filter(r => r.target === 'rachel' && r.day === '2026-09-09').map(r => `${r.kind} ${r.day}`);
  assert(JSON.stringify(keys) === JSON.stringify(['warn_2 2026-09-09', 'warn_1 2026-09-09', 'grace 2026-09-09']),
    'each is claimed under the date the access ends, not the date it went out', JSON.stringify(keys));
  // A rollback runs code that only asks "did this kind go out today?", and
  // guarded-restart.sh performs one by itself when a release fails its health
  // check. Each send also holds that day-keyed row, so an older release switched
  // on the same afternoon finds it and stays quiet instead of sending it again.
  const heldForOldCode = w.log.filter(r => r.target === 'rachel' && r.day !== '2026-09-09').map(r => `${r.kind} ${r.day}`);
  assert(JSON.stringify(heldForOldCode) === JSON.stringify(['warn_2 2026-09-07', 'warn_1 2026-09-08']),
    'each send also holds the day-keyed row an older release would look for', JSON.stringify(heldForOldCode));
  assert(w.to('vani@x').length === 0, 'free forever is sent none of it', JSON.stringify(w.to('vani@x')));
  const forever = _warningClaim('warn_2', accessFrom(vani, IST('2026-09-08T09:00:00')), []);
  assert(!forever.send && forever.day === null, 'and has no end to claim a warning under', JSON.stringify(forever));
  const digests = w.to('owner@x');
  assert(digests.length === 8 && digests.every((line, i) => line === `digest 2026-09-${String(6 + i).padStart(2, '0')} 08:00`),
    'the owner digest still goes once a day, at eight', JSON.stringify(digests));

  // A payment moves the end. Rachel's shape again, paying on the morning of the
  // 8th, between "ends in 2 days" and "ends tomorrow". confirmPayment() extends
  // from the end of the trial, so the end moves a month, and the new one earns
  // every warning the first one would have.
  {
    const payer = teacher('payer', END);
    const p = world([payer]);
    await p.run(IST('2026-09-06T00:00:00'), IST('2026-09-08T10:00:00'));
    payer.paid_until = IST('2026-10-09T16:18:00');
    await p.run(IST('2026-09-08T10:00:00'), IST('2026-10-14T00:00:00'));
    const paid = p.to('payer@x');
    assert(JSON.stringify(paid) === JSON.stringify([
      'warn_2 2026-09-07 16:30',
      'warn_2 2026-10-07 16:30', 'warn_1 2026-10-08 16:30', 'grace 2026-10-09 16:30',
    ]), 'a payment that moves the end earns a fresh set of warnings before the new one', JSON.stringify(paid));

    // A grant moves it the same way, and the warn_2 the trial left behind does
    // not stand in for the grant's own.
    const trialRows = [{ kind: 'warn_2', day: '2026-09-09', sent_at: IST('2026-09-07T16:30:00') }];
    const granted = accessFrom(teacher('g', END, { grant_active: true, grant_until: IST('2026-09-30T12:00:00') }),
      IST('2026-09-28T12:00:00'));
    const fresh = _warningClaim('warn_2', granted, trialRows);
    assert(fresh.send && fresh.day === '2026-09-30', 'so does a grant that moves it', JSON.stringify(fresh));
    const again = _warningClaim('warn_2', granted,
      [...trialRows, { kind: 'warn_2', day: '2026-09-30', sent_at: IST('2026-09-28T12:00:00') }]);
    assert(!again.send, "and the grant's own warning, once sent, is not sent again", again.reason);
  }

  // The deploy. Rows the old key wrote carry the day they went out, which the
  // new key (the day the access ends, 16 Sep here) never matches, so they must
  // be recognised another way or the deploy sends one last duplicate. Each is an
  // email the old code sent before the deploy and would have sent again after.
  const ENDS = IST('2026-09-16T16:18:00');
  const deploys = [
    { kind: 'warn_2', sent: '2026-09-15T08:00:00', deploy: '2026-09-15T09:00:00',
      what: 'a warn_2 from earlier the same morning', after: ['warn_1 2026-09-15 16:30', 'grace 2026-09-16 16:30'] },
    { kind: 'warn_2', sent: '2026-09-14T16:30:00', deploy: '2026-09-15T07:30:00',
      what: 'a warn_2 from the afternoon before', after: ['warn_1 2026-09-15 16:30', 'grace 2026-09-16 16:30'] },
    { kind: 'warn_1', sent: '2026-09-15T16:30:00', deploy: '2026-09-16T07:30:00',
      what: 'a warn_1 from the afternoon before', after: ['grace 2026-09-16 16:30'] },
    { kind: 'grace', sent: '2026-09-17T08:00:00', deploy: '2026-09-17T09:00:00',
      what: 'a grace email from earlier the same morning', after: [] },
  ];
  for (const { kind, sent, deploy, what, after } of deploys) {
    const control = world([teacher('old', ENDS)]);
    await control.run(IST(deploy), IST('2026-09-21T00:00:00'));
    assert(control.to('old@x').filter(line => line.startsWith(`${kind} `)).length === 1,
      `without ${what}, the deploy would send ${kind}`, JSON.stringify(control.to('old@x')));
    const legacy = [{ kind, target: 'old', day: sent.slice(0, 10), sent_at: IST(sent) }];
    const deployed = world([teacher('old', ENDS)], legacy);
    await deployed.run(IST(deploy), IST('2026-09-21T00:00:00'));
    assert(JSON.stringify(deployed.to('old@x')) === JSON.stringify(after),
      `${what} stops the deploy sending it again, and loses nothing after it`, JSON.stringify(deployed.to('old@x')));
  }

  // Resend has a bad minute. The claim is handed back, so the next run sends it
  // after all, and it still goes only once.
  {
    const f = world([teacher('flaky', END)]);
    await f.run(IST('2026-09-06T00:00:00'), IST('2026-09-07T16:30:00'));
    f.failOnce('flaky@x');
    await f.run(IST('2026-09-07T16:30:00'), IST('2026-09-07T16:45:00'));
    assert(f.to('flaky@x').length === 0 && !f.log.some(r => r.target === 'flaky'),
      'a send that fails leaves no claim behind', JSON.stringify(f.log));
    await f.run(IST('2026-09-07T16:45:00'), IST('2026-09-14T00:00:00'));
    const retried = f.to('flaky@x');
    assert(JSON.stringify(retried) === JSON.stringify(['warn_2 2026-09-07 16:45', 'warn_1 2026-09-08 16:30', 'grace 2026-09-09 16:30']),
      'and the next run sends it, once', JSON.stringify(retried));
  }

  if (ownerWas === undefined) delete process.env.OWNER_EMAIL; else process.env.OWNER_EMAIL = ownerWas;
}

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

// ─────────────────────────────────────────────────────────────────────────
section('OFFLINE — the calculator works a sum out, it never runs it');
{
  // Asked for on 10 Sep 2026: "different calculator options for the teacher and
  // if he want for the students also." What that turns into is an engine that
  // reads text a person typed into a browser — the one kind of string this
  // codebase does not execute — and that the function plotter will then call at
  // several hundred sample points a frame. Both of those are load-bearing, so
  // both are checked here.
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
  const failure = (src, opts) => {
    try { calculate(src, opts); return null; } catch (err) { return err; }
  };
  const deg = { degrees: true };
  const atX = (x) => ({ vars: { x } });

  // ── Precedence, and which way a chain leans ──
  //
  // 2^3^2 is the one that separates a parser from a fold over a token list:
  // right-associative it is 2^9, left it is 8^2, and a tutor demonstrating
  // powers on the board is owed the first one.
  assert(calculate('2^3^2') === 512, 'powers are right-associative: 2^3^2 is 512',
    `it came out ${calculate('2^3^2')} — 64 means the tree was built the wrong way round`);
  assert(calculate('2+3*4') === 14, 'multiplication binds tighter than addition');
  assert(calculate('(2+3)*4') === 20, 'and a bracket beats both');
  assert(calculate('8/4/2') === 1, 'division leans left: 8/4/2 is 1, not 4');
  assert(calculate('2^3!') === 64, 'a factorial inside an exponent is worked out first');
  assert(calculate('3!^2') === 36, 'and a factorial under one is too');

  // ── A minus sign is two different things ──
  assert(calculate('-2^2') === -4, '-2^2 is -4, not 4',
    'the minus is applied to the whole power; binding it to the 2 would contradict the lesson being taught');
  assert(calculate('2-3') === -1, 'a minus between two numbers is a subtraction');
  assert(calculate('2--3') === 5, 'and a minus straight after an operator is a sign');
  assert(calculate('2 - -3') === 5, 'spacing does not change which one it is');
  assert(calculate('2^-3') === 0.125, 'an exponent is allowed to be negative');
  assert(calculate('-5!') === -120, 'the factorial happens before the sign, so -5! is -120');

  // ── The × nobody types ──
  assert(calculate('2x', atX(4)) === 8, '2x is two times x');
  assert(calculate('3(x+1)', atX(4)) === 15, '3(x+1) needs no multiplication sign');
  assert(near(calculate('2sin(30)', deg), 1), '2sin(30) is 1 in degrees');
  assert(calculate('2x^2', atX(4)) === 32, '2x^2 is 2(x²) and not (2x)²',
    'the implicit product takes a whole power on its right, or a plotted parabola is the wrong parabola');
  assert(calculate('(2)(3)') === 6, 'two bracketed values side by side multiply');
  assert(calculate('2pi') === Math.PI * 2, 'a number in front of a constant multiplies it');
  const sideBySide = failure('12 34');
  assert(sideBySide instanceof ExpressionError && /two numbers in a row/.test(sideBySide.message),
    'two numbers side by side are refused, not multiplied',
    '12 34 quietly answering 408 is a wrong number that gets copied onto a board and believed');

  // ── Degrees or radians: the same three characters, two answers ──
  assert(near(calculate('sin(30)', deg), 0.5), 'sin(30) is 0.5 in degrees');
  assert(near(calculate('sin(30)'), Math.sin(30)) && calculate('sin(30)') < 0,
    'the same sin(30) in radians is -0.988',
    'a toggle that did nothing would be worse than no toggle — both answers look plausible');
  assert(calculate('cos(90)', deg) === 0, 'cos(90) is exactly 0 in degrees',
    'Math.cos(90 * π/180) is 6.1e-17, which a student who has just been taught cos 90 = 0 should never be shown');
  assert(Number.isNaN(calculate('tan(90)', deg)), 'tan(90) has no value at all',
    'Math.tan of the same angle is 1.6e16, which reads as an answer');
  assert(near(calculate('asin(1)', deg), 90), 'the inverse functions answer in degrees too');
  assert(near(calculate('atan(1)', deg), 45), 'atan(1) is 45 degrees');
  assert(calculate('sinh(1)') === calculate('sinh(1)', deg),
    'the hyperbolic functions ignore the toggle entirely',
    'sinh takes a number, not an angle — converting it would be a silent wrong answer');
  assert(calculate('log(100)') === 2 && calculate('ln(e)') === 1 && calculate('log2(8)') === 3,
    'log is base ten, ln is natural, log2 is base two',
    'that is what those three mean in a school exercise book');

  // ── A question with no answer is a value, not an exception ──
  //
  // The plotter will call this thousands of times per frame. An asymptote must
  // cost a NaN and a gap in the line, never a throw and a dead render.
  for (const [src, what] of [
    ['1/0', 'dividing by zero'],
    ['0/0', 'zero over zero'],
    ['sqrt(-1)', 'the root of a negative'],
    ['ln(0)', 'the log of zero'],
    ['(-8)^0.5', 'a fractional power of a negative'],
    ['0.5!', 'the factorial of a half'],
    ['171!', 'a factorial past what a double can hold'],
  ]) {
    let value, threw = false;
    try { value = calculate(src); } catch { threw = true; }
    assert(!threw && Number.isNaN(value), `${src} comes back NaN — ${what}`,
      threw ? 'it threw instead' : `it answered ${value}, and Infinity is not an answer a tutor can use`);
  }

  // ── A typo gets a sentence, not a stack trace ──
  for (const [src, expected] of [
    ['2+)', /unexpected '\)'/],
    ['(2+3', /never closed/],
    ['foo(3)', /unknown function 'foo'/],
    ['sin', /needs brackets/],
    ['sin(1,2)', /takes 1 value/],
    ['2+', /stops after/],
    ['3..4', /decimal points/],
    ['2 @ 3', /can't read '@'/],
    ['2y', /don't know what 'y' is/],
  ]) {
    const err = failure(src);
    assert(err instanceof ExpressionError && expected.test(err.message),
      `"${src}" is answered with a readable message`,
      err ? err.message : 'it did not complain at all');
  }
  const pointed = failure('2+)');
  assert(pointed.at === 2, 'and the message knows which character it was',
    `at=${pointed && pointed.at} — a calculator that cannot point is a calculator he has to re-read`);

  // ── Nothing typed into it can execute ──
  //
  // The whole reason this file exists rather than a one-line eval(). These are
  // the shapes that reach for a JavaScript engine through a lookup table; a
  // plain object literal would answer `constructor` with the Function
  // constructor, so the tables are Maps with no prototype behind them.
  globalThis.__calcEscaped = false;
  const attacks = [
    'constructor.constructor("globalThis.__calcEscaped=true")()',
    'constructor(1)',
    'hasOwnProperty(1)',
    '__proto__',
    'alert(1)',
    'globalThis.__calcEscaped=true',
    '0;globalThis.__calcEscaped=true',
    'process.exit(1)',
    'require("fs")',
    'import("fs")',
    '`${1}`',
  ];
  let allRefused = true;
  for (const src of attacks) {
    const err = failure(src);
    if (!(err instanceof ExpressionError)) { allRefused = false; console.log(`      (${src} was not refused)`); }
  }
  assert(allRefused, 'every string that reaches for JavaScript is refused as a typo',
    'these are the inputs that turn an expression evaluator into remote code execution');
  assert(globalThis.__calcEscaped === false, 'and none of them ran',
    'the sentinel was set, which means something in there executed');
  assert(Number.isNaN(evaluate(parse('constructor'), {})),
    'a variable named after something on Object.prototype is simply unknown',
    'reading it off a plain {} would hand a caller a function where a number belongs');

  const engineSrc = await readFile(new URL('./src/lib/mathExpr.ts', import.meta.url), 'utf8');
  const engineCode = engineSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(!/\beval\s*\(/.test(engineCode) && !/new\s+Function\b/.test(engineCode),
    'the engine contains no eval and no new Function',
    'the day one appears "just for the plotter", every lesson on the platform is running whatever was typed');

  // ── Parse once, sample many ──
  assert(failure('2+)') && (() => { try { compile('2+)'); return false; } catch { return true; } })(),
    'compile() reports a typo before a plotter draws anything',
    'discovering it at sample 400 means an empty canvas and no explanation');
  let unknownAtCompile = '';
  try { compile('2y'); } catch (err) { unknownAtCompile = err.message; }
  assert(/don't know what 'y' is/.test(unknownAtCompile),
    'and it checks the names once, up front',
    `got: ${unknownAtCompile || '(no complaint)'}`);

  const parabola = compile('2x^2 + 3x - 1');
  assert(parabola(2) === 13 && parabola(-1) === -2 && parabola(0) === -1,
    'a compiled expression is a plain (x) => number');
  const asymptote = compile('tan(x)');
  let sampled = 0, exploded = false;
  try {
    for (let i = 0; i < 1000; i++) asymptote(-Math.PI + (i * 2 * Math.PI) / 999);
    sampled = 1000;
  } catch { exploded = true; }
  assert(!exploded && sampled === 1000, 'and it can be sampled across an asymptote 1000 times without throwing',
    'this is the loop the plotter runs every frame of a drag');
  assert(Number.isNaN(compile('1/x')(0)) && compile('1/x')(4) === 0.25,
    'a hole in a curve is NaN at that point and fine either side of it');

  // Relative, not absolute, because the box this runs on is a 1GB Lightsail
  // instance and a millisecond budget would be a flaky test. What is being
  // proved is structural: sampling does not re-read the text.
  {
    const src = 'sin(x)*cos(2x)+sqrt(abs(x))';
    const f = compile(src);
    const N = 20000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) f(i * 0.001);
    const compiled = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < N; i++) calculate(src, { vars: { x: i * 0.001 } });
    const reparsed = performance.now() - t1;
    assert(compiled * 4 < reparsed, 'sampling a compiled expression is far cheaper than re-reading the text',
      `compiled ${compiled.toFixed(1)}ms vs ${reparsed.toFixed(1)}ms for ${N} points — the plotter needs the first number`);
  }

  // ── The small things a calculator is judged on ──
  assert(formatResult(0.1 + 0.2) === '0.3', '0.1 + 0.2 shows as 0.3',
    'a class watching 0.30000000000000004 appear has learned the wrong thing about arithmetic');
  assert(formatResult(1 / 3) === '0.333333333333' && formatResult(NaN) === 'undefined',
    'a third keeps its digits and an impossible sum says so');
  assert(calculate('50%') === 0.5 && near(calculate('200*15%'), 30),
    'percent is a hundredth, so 15% of 200 is 30');
  assert(calculate('round(-2.5)') === -3, 'rounding a half goes away from zero: -2.5 is -3',
    'Math.round answers -2, and being marked wrong by the tutor\'s own calculator is indefensible');
  assert(calculate('√16') === 4 && calculate('3 × 4') === 12 && calculate('5 ÷ 2') === 2.5,
    'the symbols on an iPad keyboard and in a pasted worksheet are read as themselves');
  assert(freeVariables(parse('2x + ans')).join(',') === 'x,ans',
    'the engine can say which names an expression still needs');
  for (const name of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
    'sqrt', 'cbrt', 'abs', 'ln', 'log', 'log2', 'exp', 'floor', 'ceil', 'round', 'sign',
    'min', 'max', 'pow']) {
    if (!FUNCTION_NAMES.includes(name)) { assert(false, `the engine knows ${name}`); break; }
  }
  assert(FUNCTION_NAMES.length >= 23, 'every function the keypad and the plotter offer exists',
    `only ${FUNCTION_NAMES.length} are defined`);
  assert(tokenize('2x').length === 2 && tokenize('log2(8)')[0].text === 'log2',
    'log2 is one name and 2x is two tokens',
    'splitting names into letters would turn ans into a × n × s');

  // ── And the panel that uses it stays out of the sync path ──
  const panelSrc = await readFile(new URL('./src/components/Calculator.tsx', import.meta.url), 'utf8');
  const panelCode = panelSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  assert(!/socket/i.test(panelCode) && !/roomId/.test(panelCode),
    'the calculator holds no socket and no room',
    'a floating panel that can emit is a second source of truth; the room does the sending or nobody does');
  assert(!/\beval\s*\(/.test(panelCode) && !/new\s+Function\b/.test(panelCode),
    'and it does not evaluate anything itself either');
  assert(/!open \|\| !canUse/.test(panelCode),
    'a student without permission gets no calculator at all',
    'the whole second half of the request was "and for the students IF he wants"');
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

  section('LIVE — a student may construct, and may not wipe');
  {
    // The permission half of "and if he want for the students also", asserted
    // against the real server rather than against the source. A tool that
    // appears on the learner's screen and is then silently refused is worse
    // than one that never appeared.
    const gRoom = 'gm' + Math.random().toString(36).slice(2, 8);
    const t = connect();
    await waitFor(t, 'connect');
    t.emit('join_room', { roomId: gRoom, userName: 'T', role: 'teacher' });
    await waitFor(t, 'session_state', { timeout: 4000 }).catch(() => null);

    const stu = connect();
    await waitFor(stu, 'connect');
    stu.emit('join_room', { roomId: gRoom, userName: 'S', role: 'student' });
    await waitFor(stu, 'session_state', { timeout: 4000 }).catch(() => null);

    // The teacher puts something on the board first, so "the board was wiped"
    // is distinguishable from "the board was always empty".
    t.emit('whiteboard_add_shape', { roomId: gRoom, shape: { id: 'sh-teacher', kind: 'circle', x1: 0, y1: 0, x2: 5, y2: 5 } });
    // Now the student constructs — a compass circle and a protractor.
    stu.emit('whiteboard_add_shape', { roomId: gRoom, shape: { id: 'sh-student', kind: 'circle', x1: 1, y1: 1, x2: 4, y2: 4, centerMark: true } });
    stu.emit('whiteboard_add_instrument', { roomId: gRoom, instrument: { id: 'in-student', kind: 'protractor', x: 10, y: 10, rotation: 0, radius: 240 } });
    // And tries to wipe the room, which is not construction.
    stu.emit('whiteboard_clear', { roomId: gRoom });
    await new Promise(r => setTimeout(r, 500));

    const j = connect();
    await waitFor(j, 'connect');
    j.emit('join_room', { roomId: gRoom, userName: 'S2', role: 'student' });
    const st = await waitFor(j, 'session_state', { timeout: 4000 }).catch(() => null);
    const wb = st && st.whiteboard ? st.whiteboard : {};

    assert((wb.shapes || []).some(x => x && x.id === 'sh-student'),
      "a student's compass circle reaches the room",
      'the tool is on their screen; the server must accept what it draws');
    assert((wb.instruments || []).some(x => x && x.id === 'in-student'),
      "and so does a student's protractor");
    assert((wb.shapes || []).some(x => x && x.id === 'sh-teacher'),
      "the teacher's work is still there",
      'the student asked the room to clear — that must have been refused');

    [t, stu, j].forEach(x => x.close());
  }

  section('LIVE — replaying a saved board does not double it');
  {
    // How a whiteboard reached 441,195 objects and killed the server on every
    // join. Three places in Room.tsx replay a saved board by re-emitting every
    // item on it, and the server appended each one every time — so a board
    // saved at 200 reopened to 400, was saved at 400, reopened to 800.
    //
    // Every one of those handlers already required an `id` and then ignored it.
    // This is the behaviour that proves it no longer does.
    const wbRoom = 'wb' + Math.random().toString(36).slice(2, 8);
    const t = connect();
    await waitFor(t, 'connect');
    t.emit('join_room', { roomId: wbRoom, userName: 'T', role: 'teacher' });
    await waitFor(t, 'session_state', { timeout: 4000 }).catch(() => null);

    const pic = { id: 'img-same', src: '/api/board-image/abc', x: 1, y: 1, w: 10, h: 10 };
    // Twice with the same id — exactly what a replay sends.
    t.emit('whiteboard_add_image', { roomId: wbRoom, object: pic });
    t.emit('whiteboard_add_image', { roomId: wbRoom, object: { ...pic, x: 2 } });
    t.emit('whiteboard_add_shape', { roomId: wbRoom, shape: { id: 'sh-same', kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1 } });
    t.emit('whiteboard_add_shape', { roomId: wbRoom, shape: { id: 'sh-same', kind: 'line', x1: 0, y1: 0, x2: 2, y2: 2 } });
    await new Promise(r => setTimeout(r, 400));

    // Read it the way a joining student would.
    const joiner = connect();
    await waitFor(joiner, 'connect');
    joiner.emit('join_room', { roomId: wbRoom, userName: 'S', role: 'student' });
    const st = await waitFor(joiner, 'session_state', { timeout: 4000 }).catch(() => null);
    const wb = st && st.whiteboard ? st.whiteboard : null;

    assert(!!wb, 'a joiner is sent the board at all');
    const sameId = (wb?.objects || []).filter(o => o && o.id === 'img-same');
    assert(sameId.length === 1,
      'the same picture replayed twice is on the board once',
      `it is there ${sameId.length} times — this is the doubling that reached 441,195`);
    assert(sameId[0]?.x === 2,
      'and it is the LATER one that survived',
      'a replay carries the current position; keeping the older copy would move it back');
    const sameShape = (wb?.shapes || []).filter(x => x && x.id === 'sh-same');
    assert(sameShape.length === 1, 'and the same holds for shapes');

    // A genuinely different picture must still be added — the whole risk of
    // deduping by id is that it silently swallows real work.
    t.emit('whiteboard_add_image', { roomId: wbRoom, object: { ...pic, id: 'img-other' } });
    await new Promise(r => setTimeout(r, 300));
    const j2 = connect();
    await waitFor(j2, 'connect');
    j2.emit('join_room', { roomId: wbRoom, userName: 'S2', role: 'student' });
    const st2 = await waitFor(j2, 'session_state', { timeout: 4000 }).catch(() => null);
    assert((st2?.whiteboard?.objects || []).length === 2,
      'a different picture is still added',
      'deduping by id must never swallow a real second picture — duplicate and paste both mint a fresh id');

    [t, joiner, j2].forEach(x => x.close());
  }

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
