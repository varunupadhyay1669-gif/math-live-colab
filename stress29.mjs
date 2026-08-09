// Round-29: SITE PASSCODE — nobody makes this server work without the code.
//
// The account's monthly quota was exhausted by traffic the owner did not
// control. Resuming a suspended service without a gate hands that quota back to
// whoever arrives first, so the gate has to hold against someone who does not
// use the UI at all — a socket client, or curl.
//
//   P1  no passcode: the handshake is refused outright
//   P2  a wrong passcode is refused, including near-misses
//   P3  the right passcode connects and everything works normally
//   P4  the HTTP endpoints that do real work are gated too
//   P5  /healthz says a code is needed but never says what it is
// SITE_PASSCODE=9456 PORT=4400 node server.ts
// PORT=4400 node stress29.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '4400';
const URL = `http://localhost:${PORT}`;
const CODE = process.env.SITE_PASSCODE || '9456';
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const sockets = [];

/** Resolves 'connected' or the refusal message. */
function tryConnect(auth) {
  return new Promise((res) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true, auth });
    sockets.push(s);
    const done = (v) => { res(v); };
    s.on('connect', () => done('connected'));
    s.on('connect_error', (e) => done(e.message));
    setTimeout(() => done('timeout'), 4000);
  });
}

async function run() {
  console.log('P1: no code, no connection');
  assert(await tryConnect(undefined) === 'passcode_required', 'a client presenting nothing is refused');
  assert(await tryConnect({}) === 'passcode_required', 'and an empty auth object');
  assert(await tryConnect({ passcode: '' }) === 'passcode_required', 'and an empty string');

  console.log('P2: a wrong code, including the near-misses');
  assert(await tryConnect({ passcode: '0000' }) === 'passcode_required', 'a different code');
  assert(await tryConnect({ passcode: '945' }) === 'passcode_required', 'one character short');
  assert(await tryConnect({ passcode: CODE + '0' }) === 'passcode_required', 'one character long');
  assert(await tryConnect({ passcode: ' ' + CODE }) === 'passcode_required', 'padded with a space');
  assert(await tryConnect({ passcode: 9456 }) === 'passcode_required', 'the right value as a NUMBER is not a string match');
  assert(await tryConnect({ passcode: null }) === 'passcode_required', 'and null');

  console.log('P3: the right code works, and the app works through it');
  const okMsg = await tryConnect({ passcode: CODE });
  assert(okMsg === 'connected', 'the correct code connects', okMsg);
  // And a real lesson still functions — the gate must not break the app.
  const t = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { passcode: CODE } });
  sockets.push(t);
  await new Promise(r => t.on('connect', r));
  const room = 'gate' + Math.floor(Math.random() * 1e6);
  const state = await new Promise((res, rej) => {
    const tm = setTimeout(() => rej(new Error('no session_state')), 5000);
    t.on('session_state', (st) => { clearTimeout(tm); res(st); });
    t.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher' });
  });
  assert(!!state, 'a teacher can open a room through the gate');
  t.emit('whiteboard_draw', { roomId: room, stroke: { id: 'g1', points: [{ x: 1, y: 1 }, { x: 9, y: 9 }], color: '#111', width: 3, tool: 'pen', createdAt: 1 } });
  await new Promise(r => setTimeout(r, 400));
  const s2 = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { passcode: CODE } });
  sockets.push(s2);
  await new Promise(r => s2.on('connect', r));
  const seen = await new Promise((res) => {
    s2.on('session_state', (st) => res(st));
    s2.emit('join_room', { roomId: room, userName: 'K', role: 'student' });
    setTimeout(() => res(null), 5000);
  });
  assert(seen && (seen.whiteboard.strokes || []).length === 1,
    'and a student joins and sees the board', seen ? String((seen.whiteboard.strokes || []).length) : 'none');

  console.log('P4: the HTTP endpoints are gated too');
  // Otherwise the socket gate is theatre — the content endpoint would serve
  // a whole lesson to anyone who asked.
  const noCode = await fetch(`${URL}/api/room/${room}/content`);
  assert(noCode.status === 401, 'the content endpoint refuses without a code', String(noCode.status));
  const wrong = await fetch(`${URL}/api/room/${room}/content`, { headers: { 'x-site-passcode': '0000' } });
  assert(wrong.status === 401, 'and with a wrong one', String(wrong.status));
  const right = await fetch(`${URL}/api/room/${room}/content`, { headers: { 'x-site-passcode': CODE } });
  assert(right.status !== 401, 'but not with the right one', String(right.status));
  const pub = await fetch(`${URL}/api/publish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: '<p>x</p>' }),
  });
  assert(pub.status === 401, 'and publishing is refused without a code', String(pub.status));

  console.log('P5: /healthz asks for the code without revealing it');
  const health = await (await fetch(`${URL}/healthz`)).json();
  assert(health.passcodeRequired === true, 'it says a code is required, so the app knows to prompt');
  assert(!JSON.stringify(health).includes(CODE), 'and the code itself appears nowhere in the response');
}

run().catch(e => { bad('harness', e.message); }).finally(() => {
  sockets.forEach(s => { try { s.close(); } catch {} });
  console.log(`\nPASSCODE RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
});
