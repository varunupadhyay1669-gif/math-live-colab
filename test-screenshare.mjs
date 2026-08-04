// Screen sharing — the student's real screen, live, in the teacher's window.
//
// The pure parts: what a device can do, what the teacher is told, and the
// one-way peer's negotiation. The relay itself is stress24.
// node --import tsx test-screenshare.mjs
import { screenShareSupported, shareFailureMessage, statusMessage, ScreenPeer } from './src/lib/screenShare.ts';

let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);

console.log('S1: which devices can actually do this');
// This is not a nicety. iPadOS and iOS Safari ship NO getDisplayMedia, and the
// tutor's own student is on an iPad — so the answer has to be checked, not
// assumed, or they wait forever on a share that cannot arrive.
assert(screenShareSupported({ mediaDevices: { getDisplayMedia: () => {} } }), 'a desktop browser can share');
assert(!screenShareSupported({ mediaDevices: {} }), 'an iPad — mediaDevices, but no getDisplayMedia — cannot');
assert(!screenShareSupported({}), 'nor a browser with no mediaDevices at all');
assert(!screenShareSupported({ mediaDevices: { getDisplayMedia: 'yes' } }), 'and a non-function does not count');

console.log('S2: the teacher is told what happened, in words');
assert(statusMessage('asking', 'Kanishka').includes('waiting'), 'waiting is named as waiting');
assert(statusMessage('live', 'Kanishka') === "Watching Kanishka's screen.", 'live says whose screen');
assert(statusMessage('declined', 'Kanishka') === 'Kanishka declined.', 'a no is reported plainly, without blame');
const unsupported = statusMessage('unsupported', 'Kanishka');
assert(unsupported.includes('iPad'), 'an iPad is named, so the tutor stops waiting', unsupported);
assert(unsupported.includes('See their screen'), 'and is pointed at the fallback that does work on it');
assert(statusMessage('idle', 'Kanishka') === '', 'idle says nothing');
assert(!statusMessage('failed', 'Kanishka').includes('undefined'), 'no half-built strings reach the screen');

console.log('S3: failures are explained, not dumped');
assert(shareFailureMessage({ name: 'NotAllowedError' }, 'Kanishka').includes('chose not to share'),
  'a refusal reads as a refusal, not an error');
assert(shareFailureMessage({ name: 'NotReadableError' }, 'Kanishka').includes('another app'),
  'a busy capture device suggests the actual cause');
const weird = shareFailureMessage({ name: 'SomeBrandNewError' }, 'Kanishka');
assert(weird.includes('Kanishka') && !weird.includes('SomeBrandNewError'),
  'an unknown DOM error becomes a sentence, not a stack trace', weird);

console.log('S4: the peer negotiates one way only');
// A fake RTCPeerConnection: enough to see who offers, who answers, and that
// nothing is dropped on the way.
function FakePc() {
  const pc = {
    _tracks: [], _remote: null, _added: [], connectionState: 'new',
    localDescription: null, remoteDescription: null,
    onicecandidate: null, ontrack: null, onconnectionstatechange: null,
    addTrack: (t) => pc._tracks.push(t),
    createOffer: async () => ({ type: 'offer', sdp: 'OFFER' }),
    createAnswer: async () => ({ type: 'answer', sdp: 'ANSWER' }),
    setLocalDescription: async (d) => { pc.localDescription = d; },
    setRemoteDescription: async (d) => { pc.remoteDescription = d; },
    addIceCandidate: async (c) => { pc._added.push(c); },
    close: () => { pc.connectionState = 'closed'; },
  };
  FakePc.last = pc;
  return pc;
}
const fakeStream = (n = 1) => ({
  _stopped: 0,
  getTracks() { return Array.from({ length: n }, () => ({ stop: () => { this._stopped++; }, kind: 'video' })); },
});

const studentSent = [];
const student = new ScreenPeer({ send: (s) => studentSent.push(s), PeerConnection: FakePc });
const stream = fakeStream(1);
await student.share(stream);
assert(studentSent.length === 1 && studentSent[0].description.type === 'offer',
  'the student offers — they are the one with a screen to show');
assert(FakePc.last._tracks.length === 1, 'and publishes their track');

const teacherSent = [];
let gotStream = null;
const teacher = new ScreenPeer({ send: (s) => teacherSent.push(s), onStream: (s) => { gotStream = s; }, PeerConnection: FakePc });
teacher.prepare();
const teacherPc = FakePc.last;
await teacher.accept({ description: { type: 'offer', sdp: 'OFFER' } });
assert(teacherSent.length === 1 && teacherSent[0].description.type === 'answer', 'the teacher answers');
assert(teacherPc._tracks.length === 0, 'and never publishes anything — this is one-way, they send no video back');
teacherPc.ontrack({ streams: [{ id: 'screen' }] });
assert(gotStream?.id === 'screen', 'the incoming screen reaches the viewer');

console.log('S5: candidates that arrive early are held, not thrown away');
// The normal race: ICE candidates outrun the description. Dropping them costs
// connectivity on exactly the restricted networks that need every candidate.
const early = new ScreenPeer({ send: () => {}, PeerConnection: FakePc });
early.prepare();
const earlyPc = FakePc.last;
await early.accept({ candidate: { candidate: 'a' } });
await early.accept({ candidate: { candidate: 'b' } });
assert(earlyPc._added.length === 0, 'nothing is applied before the description — that would throw');
await early.accept({ description: { type: 'offer', sdp: 'OFFER' } });
assert(earlyPc._added.length === 2, 'both are applied the moment it lands', String(earlyPc._added.length));
await early.accept({ candidate: { candidate: 'c' } });
assert(earlyPc._added.length === 3, 'and later ones go straight through');

console.log('S6: closing leaves nothing capturing');
const live = fakeStream(2);
let stopped = 0;
const tracks = [{ stop: () => stopped++, kind: 'video' }, { stop: () => stopped++, kind: 'audio' }];
live.getTracks = () => tracks;
const closer = new ScreenPeer({ send: () => {}, PeerConnection: FakePc });
await closer.share(live);
const closerPc = FakePc.last;
closer.close();
assert(closerPc.connectionState === 'closed', 'the connection is closed');
assert(stopped === 2, 'and EVERY track is stopped — a live track is a recording indicator on their screen', String(stopped));
let threw = false;
try { closer.close(); } catch { threw = true; }
assert(!threw, 'closing twice is safe — teardown runs from several places at once');

console.log(`\nSCREEN SHARE RESULT: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
