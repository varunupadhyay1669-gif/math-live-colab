// Round-1 lifecycle & quiz-consistency stress — the scenarios the user named
// plus combinations. Focus: do ALL screens agree (same seed + same journal),
// and does state survive every join/leave/rejoin permutation.
// PORT=3000 node stress4.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3000';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const assert = (c, n, d) => c ? ok(n) : bad(n, d);
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, { timeout = 5000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 1000) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const SEEDED_QUIZ = `<!doctype html><html><body><h1 id="q">Q</h1><button id="n">next</button>
<script>var r=0;function go(){r++;var v=Math.floor(Math.random()*1000);document.getElementById('q').textContent='R'+r+':'+v;}
document.getElementById('n').addEventListener('click',go);</script></body></html>`;

async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); const ss = on1(s, 'session_state').catch(() => null); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return { s, ss: await ss }; }
async function joinStudent(room, name) {
  const s = conn(); await on1(s, 'connect');
  const ssP = on1(s, 'session_state', { timeout: 5000 }).catch(() => null);
  const replayP = on1(s, 'interaction_replay', { timeout: 3500 }).catch(() => null);
  s.emit('join_room', { roomId: room, userName: name, role: 'student' });
  await on1(s, 'room_state').catch(() => {});
  return { s, ss: await ssP, replay: await replayP };
}
// NOTE: on JOIN the server sends 'session_state'; for in-room broadcasts
// (upload, restore, file switch) it sends 'sync_full_state'. The teacher is
// already in the room when these fire, so we capture the canonical seed from
// 'sync_full_state' here.
async function upload(t, room, html = SEEDED_QUIZ) { const ssP = on1(t, 'sync_full_state', { match: p => p.randomSeed > 0, timeout: 4000 }).catch(() => null); t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Quiz', html, uploadedAt: 1 } }); return await ssP; }
async function advance(t, room, n) { for (let i = 0; i < n; i++) { t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'c' + i, path: '#n' } }); await delay(55); } }

// A1: 3 students join after N quiz advances -> ALL get the SAME seed + SAME journal
async function A1_allScreensAgree() {
  console.log('A1: every screen agrees — same seed, same journal');
  const room = rid('a1');
  const { s: t } = await joinTeacher(room);
  const up = await upload(t, room);
  const seed = up?.randomSeed;
  assert(typeof seed === 'number' && seed > 0, 'teacher baseline issues a positive seed', `seed=${seed}`);
  await advance(t, room, 5);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  const c = await joinStudent(room, 'Cy');
  const seeds = [a.ss?.randomSeed, b.ss?.randomSeed, c.ss?.randomSeed];
  assert(seeds.every(x => x === seed), 'all 3 late joiners get the SAME seed as the teacher baseline', JSON.stringify(seeds) + ' vs ' + seed);
  const lens = [a.replay?.events?.length, b.replay?.events?.length, c.replay?.events?.length];
  assert(lens.every(x => x === 5), 'all 3 late joiners replay the SAME 5-event journal', JSON.stringify(lens));
  // serverSeqs identical across joiners (same ordering)
  const seqA = (a.replay?.events || []).map(e => e.serverSeq).join(',');
  const seqB = (b.replay?.events || []).map(e => e.serverSeq).join(',');
  assert(seqA === seqB && seqA.length > 0, 'journal serverSeq ordering is identical across joiners', `${seqA} | ${seqB}`);
}

// A2: student leaves mid-session and rejoins -> seed UNCHANGED, journal complete
async function A2_leaveRejoinSeedStable() {
  console.log('A2: leave mid-session + rejoin keeps the same seed & full journal');
  const room = rid('a2');
  const { s: t } = await joinTeacher(room);
  const up = await upload(t, room); const seed = up?.randomSeed;
  await advance(t, room, 3);
  const a1 = await joinStudent(room, 'Ann');
  assert(a1.ss?.randomSeed === seed, 'first join: same seed', `${a1.ss?.randomSeed} vs ${seed}`);
  a1.s.disconnect(); await delay(300);
  await advance(t, room, 2); // 5 total now
  const a2 = await joinStudent(room, 'Ann');
  assert(a2.ss?.randomSeed === seed, 'rejoin: seed STILL unchanged (no spurious re-baseline)', `${a2.ss?.randomSeed} vs ${seed}`);
  assert(a2.replay?.events?.length === 5, 'rejoin: replays the full 5-event journal', `n=${a2.replay?.events?.length}`);
}

// A3: teacher leaves (grace) with students present, new student still gets the lesson, teacher returns, seed preserved
async function A3_teacherGraceKeepsSeed() {
  console.log('A3: teacher leaves (grace) -> students keep seed -> teacher returns same seed');
  const room = rid('a3');
  const { s: t } = await joinTeacher(room, 'MrT');
  const up = await upload(t, room); const seed = up?.randomSeed;
  await advance(t, room, 4);
  const a = await joinStudent(room, 'Ann');
  assert(a.ss?.randomSeed === seed, 'student before teacher-leave: same seed', `${a.ss?.randomSeed}`);
  t.disconnect(); await delay(400); // grace armed
  const late = await joinStudent(room, 'Late');
  assert(late.ss?.randomSeed === seed, 'student joining during teacher grace STILL gets the seed', `${late.ss?.randomSeed}`);
  assert(late.replay?.events?.length === 4, 'grace-time joiner still replays the journal', `n=${late.replay?.events?.length}`);
  const { ss: tback } = await joinTeacher(room, 'MrT');
  assert(tback?.randomSeed === seed, 'returning teacher sees the SAME seed (no reset)', `${tback?.randomSeed} vs ${seed}`);
}

// A4: control handoff chain — single writer enforced at each step
async function A4_controlChainSingleWriter() {
  console.log('A4: control handoff chain keeps exactly one writer');
  const room = rid('a4');
  const { s: t } = await joinTeacher(room);
  await upload(t, room);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  // grant Ann
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(a.s, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  // Ann drives -> Bob receives it
  const bGetsAnn = on1(b.s, 'interaction', { match: p => p?.type === 'SYNC_CLICK' && p.id === 'ann1' });
  a.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ann1', path: '#n' } });
  await bGetsAnn.then(() => ok('control holder Ann drives -> Bob receives')).catch(e => bad('Ann drives reaches Bob', e.message));
  // teacher is a MIRROR now: teacher click must NOT reach Bob
  const bNoTeacher = none(b.s, 'interaction', 700);
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'teach1', path: '#n' } });
  const leaked = await bNoTeacher;
  assert(!(leaked && leaked.type === 'SYNC_CLICK' && leaked.id === 'teach1'), 'teacher click is SUPPRESSED while Ann holds control', leaked ? 'leaked ' + leaked.id : '');
  // Bob (non-holder) drive must NOT reach Ann
  const aNoBob = none(a.s, 'interaction', 700);
  b.s.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'bob1', path: '#n' } });
  const leaked2 = await aNoBob;
  assert(!(leaked2 && leaked2.id === 'bob1'), 'non-holder Bob drive is dropped', leaked2 ? 'leaked ' + leaked2.id : '');
  // revoke -> teacher drives again
  t.emit('grant_control', { roomId: room, holderName: null }); // revoke uses null (UserList sends null too)
  await on1(a.s, 'control_changed', { match: p => !p.holderName }).catch(() => {});
  const bGetsTeacher = on1(b.s, 'interaction', { match: p => p?.id === 'teach2' });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'teach2', path: '#n' } });
  await bGetsTeacher.then(() => ok('after revoke, teacher drives again -> Bob receives')).catch(e => bad('teacher resumes after revoke', e.message));
}

// A5: interactive toggle survives a student reconnect (the scroll-fix's data path)
async function A5_interactivePersistsReconnect() {
  console.log('A5: interactive mode persists across student reconnect');
  const room = rid('a5');
  const { s: t } = await joinTeacher(room);
  await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  await delay(200);
  const a1 = await joinStudent(room, 'Ann');
  assert(a1.ss?.studentInteractionAllowed === true, 'joiner sees interactive=true in session_state', `${a1.ss?.studentInteractionAllowed}`);
  a1.s.disconnect(); await delay(250);
  const a2 = await joinStudent(room, 'Ann');
  assert(a2.ss?.studentInteractionAllowed === true, 'reconnecting student STILL sees interactive=true (scroll stays unlocked)', `${a2.ss?.studentInteractionAllowed}`);
}

// A6: bookmark + restore re-baselines (new seed, journal reset) and broadcasts
async function A6_bookmarkRestoreRebaseline() {
  console.log('A6: time-machine restore re-baselines seed + resets journal');
  const room = rid('a6');
  const { s: t } = await joinTeacher(room);
  const up = await upload(t, room); const seed1 = up?.randomSeed;
  await advance(t, room, 3);
  t.emit('bookmark_create', { roomId: room, name: 'M1' });
  const bms = await on1(t, 'bookmarks_changed').catch(() => null);
  const bmId = bms?.bookmarks?.[0]?.id;
  assert(!!bmId, 'bookmark created', JSON.stringify(bms?.bookmarks?.length));
  await advance(t, room, 2);
  // restore -> new baseline (broadcast => sync_full_state)
  const reBaseline = on1(t, 'sync_full_state', { match: p => p.randomSeed > 0, timeout: 4000 }).catch(() => null);
  t.emit('bookmark_restore', { roomId: room, bookmarkId: bmId });
  const after = await reBaseline;
  assert(after && after.randomSeed > 0 && after.randomSeed !== seed1, 'restore issues a FRESH seed (re-baseline)', `${seed1} -> ${after?.randomSeed}`);
  // a joiner after restore sees the fresh seed and an EMPTY/reset journal
  const j = await joinStudent(room, 'Joe');
  assert(j.ss?.randomSeed === after?.randomSeed, 'post-restore joiner gets the fresh seed', `${j.ss?.randomSeed} vs ${after?.randomSeed}`);
  assert((j.replay?.events?.length || 0) === 0, 'post-restore joiner has an empty journal (clean rewind)', `n=${j.replay?.events?.length}`);
}

// A7: same-name dedup (incognito 2nd tab) — new socket gets full state, room stays consistent
async function A7_sameNameDedup() {
  console.log('A7: same-name rejoin (incognito) gets full state');
  const room = rid('a7');
  const { s: t } = await joinTeacher(room);
  const up = await upload(t, room); const seed = up?.randomSeed;
  await advance(t, room, 3);
  const sam1 = await joinStudent(room, 'Sam');
  assert(sam1.ss?.randomSeed === seed, 'first Sam gets the seed', `${sam1.ss?.randomSeed}`);
  // second Sam (new socket, same name) — the incognito case
  const sam2 = await joinStudent(room, 'Sam');
  assert(sam2.ss?.randomSeed === seed, 'second Sam (incognito) ALSO gets the same seed', `${sam2.ss?.randomSeed}`);
  assert(sam2.replay?.events?.length === 3, 'second Sam replays the full journal (follows the teacher)', `n=${sam2.replay?.events?.length}`);
}

// A8: rapid file switch issues a fresh baseline each time, journal resets
async function A8_fileSwitchRebaselines() {
  console.log('A8: switching files re-baselines (fresh seed, reset journal)');
  const room = rid('a8');
  const { s: t } = await joinTeacher(room);
  const up1 = await upload(t, room); const seed1 = up1?.randomSeed;
  await advance(t, room, 2);
  // upload a 2nd file (new baseline)
  const reB = on1(t, 'sync_full_state', { match: p => p.randomSeed > 0 && p.randomSeed !== seed1, timeout: 4000 }).catch(() => null);
  t.emit('upload_file', { roomId: room, file: { id: 'q2', name: 'Quiz2', html: SEEDED_QUIZ, uploadedAt: 2 } });
  const after = await reB;
  assert(after && after.randomSeed !== seed1, 'second upload issues a different seed', `${seed1} -> ${after?.randomSeed}`);
  const j = await joinStudent(room, 'Joe');
  assert((j.replay?.events?.length || 0) === 0, 'joiner after new upload has a reset journal', `n=${j.replay?.events?.length}`);
}

async function run() {
  const tests = [A1_allScreensAgree, A2_leaveRejoinSeedStable, A3_teacherGraceKeepsSeed, A4_controlChainSingleWriter,
    A5_interactivePersistsReconnect, A6_bookmarkRestoreRebaseline, A7_sameNameDedup, A8_fileSwitchRebaselines];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(200); }
  console.log(`\nSTRESS4 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
