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
