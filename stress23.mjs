// Round-23: PARTICIPANT TIMEZONES — making the clock times in a class pack mean
// something to whoever reads it later.
//
// A pack is full of wall-clock times: when a line was said, when the board was
// captured, when homework is due. The tutor is in one country and the student
// is often in another, so "10:42" is ambiguous unless each person's zone is on
// the record. Each browser reports its own IANA zone at join; the server keeps
// it with the user and hands it back on the user list. Contract:
//   Z1  a zone sent at join comes back on the user list
//   Z2  tutor and student can be in different zones and both survive
//   Z3  a client that sends nothing leaves the field absent — never guessed
//   Z4  junk is dropped rather than stored (this string ends up in a file)
//   Z5  a rejoin can correct a zone (travel, a fixed clock)
// PORT=4000 node stress23.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 4000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const find = (list, name) => (list || []).find(u => u.name === name);

async function joinTeacher(room, tz) {
  const s = conn(); await on1(s, 'connect');
  s.emit('join_room', { roomId: room, userName: 'Varun', role: 'teacher', tz });
  await on1(s, 'room_state'); return s;
}
async function joinStudent(room, name, tz) {
  const s = conn(); await on1(s, 'connect');
  s.emit('join_room', { roomId: room, userName: name, role: 'student', tz });
  await on1(s, 'room_state'); return s;
}

async function run() {
  console.log('Z1/Z2: both people report a zone, and they differ');
  const room = rid('tz');
  const t = await joinTeacher(room, 'Asia/Kolkata');
  const listP = on1(t, 'user_list', { match: l => !!find(l, 'Kanishka') });
  await joinStudent(room, 'Kanishka', 'Asia/Dubai');
  const list = await listP;
  assert(find(list, 'Varun')?.tz === 'Asia/Kolkata', 'the tutor zone comes back on the user list', String(find(list, 'Varun')?.tz));
  assert(find(list, 'Kanishka')?.tz === 'Asia/Dubai', 'and the student is in their own zone', String(find(list, 'Kanishka')?.tz));

  console.log('Z3: silence stays silent');
  const room2 = rid('tz');
  const t2 = await joinTeacher(room2, 'Europe/London');
  const p2 = on1(t2, 'user_list', { match: l => !!find(l, 'Quiet') });
  await joinStudent(room2, 'Quiet', undefined);
  const l2 = await p2;
  assert(find(l2, 'Quiet') !== undefined, 'the student is still listed');
  assert(find(l2, 'Quiet').tz === undefined,
    'a client that sends no zone gets no zone — the pack says null rather than borrowing the tutor\'s',
    String(find(l2, 'Quiet').tz));

  console.log('Z4: junk never reaches the record');
  const room3 = rid('tz');
  const t3 = await joinTeacher(room3, 'Asia/Kolkata');
  const junk = ['GMT+5:30', 'Kolkata', '../../etc/passwd', '<script>x</script>', 'A'.repeat(200), 42, null, { a: 1 }];
  for (const [i, bad_] of junk.entries()) {
    const p = on1(t3, 'user_list', { match: l => !!find(l, 'J' + i) });
    await joinStudent(room3, 'J' + i, bad_);
    const l = await p;
    assert(find(l, 'J' + i).tz === undefined, `rejected: ${JSON.stringify(bad_).slice(0, 24)}`, String(find(l, 'J' + i).tz));
  }

  console.log('Z5: a rejoin corrects the zone');
  const room4 = rid('tz');
  const t4 = await joinTeacher(room4, 'Asia/Kolkata');
  const pA = on1(t4, 'user_list', { match: l => !!find(l, 'Traveller') });
  await joinStudent(room4, 'Traveller', 'Asia/Dubai');
  assert(find(await pA, 'Traveller').tz === 'Asia/Dubai', 'first zone recorded');
  // Same name from a new tab: the server drops the stale socket and seats this
  // one, so the newer zone is the one that counts.
  const pB = on1(t4, 'user_list', { match: l => find(l, 'Traveller')?.tz === 'Europe/London' });
  await joinStudent(room4, 'Traveller', 'Europe/London');
  const lB = await pB;
  assert(find(lB, 'Traveller').tz === 'Europe/London', 'a rejoin from a new zone replaces it');
  assert(lB.filter(u => u.name === 'Traveller').length === 1, 'and there is still only one of her');
}

run().catch(e => { bad('harness', e.message); }).finally(async () => {
  sockets.forEach(s => { try { s.close(); } catch {} });
  console.log(`\nTIMEZONE RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
});
