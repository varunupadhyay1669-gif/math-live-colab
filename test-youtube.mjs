// Parsing whatever a teacher pastes into the "show a video" box.
// Runs the REAL helper via tsx so it can't drift from the app.
// node --import tsx test-youtube.mjs
import { parseYouTube, embedUrl } from './src/lib/youtube.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const ID = 'dQw4w9WgXcQ';

console.log('Y1: the shapes people actually paste');
const forms = {
  'full watch link':        `https://www.youtube.com/watch?v=${ID}`,
  'short youtu.be link':    `https://youtu.be/${ID}`,
  'mobile link':            `https://m.youtube.com/watch?v=${ID}`,
  'no protocol':            `youtube.com/watch?v=${ID}`,
  'embed link':             `https://www.youtube.com/embed/${ID}`,
  'shorts link':            `https://www.youtube.com/shorts/${ID}`,
  'live link':              `https://www.youtube.com/live/${ID}`,
  'bare video id':          ID,
  'with share tracking':    `https://youtu.be/${ID}?si=AbCdEfGhIjK`,
  'inside a playlist':      `https://www.youtube.com/watch?v=${ID}&list=PL123&index=4`,
  'copied with spaces':     `   https://youtu.be/${ID}   `,
};
for (const [label, url] of Object.entries(forms)) {
  const r = parseYouTube(url);
  assert(r && r.id === ID, `${label} → correct video`, r ? `got ${r.id}` : 'no match');
}

console.log('Y2: start times survive');
assert(parseYouTube(`https://youtu.be/${ID}?t=90`)?.start === 90, '"?t=90" starts 90s in');
assert(parseYouTube(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)?.start === 90, '"1m30s" starts 90s in');
assert(parseYouTube(`https://www.youtube.com/watch?v=${ID}&t=1h2m3s`)?.start === 3723, '"1h2m3s" is parsed fully');
assert(parseYouTube(`https://www.youtube.com/embed/${ID}?start=45`)?.start === 45, '"?start=45" works too');
assert(parseYouTube(`https://youtu.be/${ID}`)?.start === 0, 'no timestamp means start at the beginning');

console.log('Y3: things that are NOT a video are rejected, not half-accepted');
const junk = {
  'empty box': '',
  'just spaces': '   ',
  'random words': 'show me a video please',
  'another site': 'https://vimeo.com/12345678',
  'a lookalike domain': 'https://youtube.evil.com/watch?v=' + ID,
  'youtube homepage': 'https://www.youtube.com/',
  'a channel page': 'https://www.youtube.com/@somechannel',
  'truncated id': `https://youtu.be/abc`,
};
for (const [label, url] of Object.entries(junk)) {
  assert(parseYouTube(url) === null, `${label} → rejected`, JSON.stringify(parseYouTube(url)));
}

console.log('Y4: the embed URL we build');
const e = embedUrl(ID, { start: 30, autoplay: true, mute: true });
assert(e.includes(`/embed/${ID}`), 'points at the right video');
assert(e.includes('youtube-nocookie.com'), 'uses the no-cookie host (no ad cookies on a student\'s browser)');
assert(e.includes('start=30'), 'carries the start time');
assert(e.includes('enablejsapi=1'), 'enables the API so playback can be kept in sync');
assert(e.includes('rel=0'), 'suppresses unrelated video suggestions at the end');
assert(!embedUrl(ID).includes('autoplay=1'), 'no autoplay unless asked for');

console.log(`\nYOUTUBE PARSE RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
