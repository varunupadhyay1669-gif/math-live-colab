// Round-12: adversarial SYNC scenarios not covered by earlier suites.
// Focus: sequence integrity, journal limits, control-grant lifecycle,
// room isolation, toggle races, and hardening of the newer channels
// (request_replay, sim_error). Written contract-first: each test states
// the DESIRED behaviour; failures indicate real bugs to fix.
//
// R1  session_state carries interactionSeq (server-restart detection contract)
// R2  strict serverSeq ordering under a 120-event burst (no gaps, no dupes, in order)
// R3  journal overflow latch: past EVENT_LOG_MAX a late joiner gets NO partial replay
// R4a zombie-overlap reconnect: same-name second socket keeps the control grant driving
// R4b clean holder exit: grant auto-clears and the TEACHER is unmuted again
// R5  revoke while interactive: holder falls back to teacher-only routing, still journaled
// R6  multi-room isolation under concurrent bursts
// R7  interaction-toggle storm: fresh joiner sees the FINAL toggle state
// R8  request_replay hardening: non-member/malformed rejected, member spam safe
// R9  250-stroke whiteboard burst hydrates completely and in order
// R10 sim_error hardening: truncation + malformed payloads never crash
// PORT=3100 node stress12.mjs
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
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
function none(s, ev, ms = 900) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
function collect(s, ev, ms) { const got = []; const h = p => got.push(p); s.on(ev, h); return new Promise(res => setTimeout(() => { s.off(ev, h); res(got); }, ms)); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);
const QUIZ = `<!doctype html><body><h1 id="q">Q</h1><button id="n">next</button></body>`;
async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }
async function upload(t, room) { t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } }); await delay(200); }

// R1: session_state carries the room's true interactionSeq
async function R1_sessionStateCarriesSeq() {
  console.log('R1: session_state.interactionSeq matches the room counter');
  const room = rid('r1');
  const t = await joinTeacher(room); await upload(t, room);
  for (const id of ['a', 'b', 'c']) { t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id, path: '#n' } }); await delay(40); }
  await delay(200);
  const fresh = conn(); await on1(fresh, 'connect');
  const st = on1(fresh, 'session_state', { timeout: 3000 });
  fresh.emit('join_room', { roomId: room, userName: 'F', role: 'student' });
  const state = await st.catch(() => null);
  assert(!!state && state.interactionSeq === 3, 'interactionSeq === 3 after three interactions (restart-detection contract)', state ? `got ${state.interactionSeq}` : 'no state');
}

// R2: strict ordering — 120-event burst arrives complete, in order, no dupes
async function R2_strictOrdering() {
  console.log('R2: 120-event burst — complete, strictly increasing serverSeq');
  const room = rid('r2');
  const t = await joinTeacher(room); await upload(t, room);
  const s = await joinStudent(room, 'Stu');
  await delay(150);
  const gotP = collect(s, 'interaction', 4500);
  for (let i = 0; i < 120; i++) t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'b' + i, path: '#n' } });
  const got = (await gotP).filter(e => typeof e.id === 'string' && e.id.startsWith('b'));
  const ids = got.map(e => Number(e.id.slice(1)));
  const seqs = got.map(e => e.serverSeq);
  const inOrder = seqs.every((v, i) => i === 0 || v > seqs[i - 1]);
  const noDupes = new Set(ids).size === ids.length;
  assert(got.length === 120, 'all 120 events delivered', `got ${got.length}`);
  assert(inOrder, 'serverSeq strictly increasing at the receiver', '');
  assert(noDupes, 'no duplicate events', '');
}

// R3: journal overflow — past EVENT_LOG_MAX a late joiner gets NO partial replay
async function R3_overflowLatch() {
  console.log('R3: journal overflow latch (this one takes ~10s of paced traffic)');
  const room = rid('r3');
  const t = await joinTeacher(room); await upload(t, room);
  // 2050 discrete events paced under the 400/s rate limit (batches of 290/s)
  let sent = 0;
  while (sent < 2050) {
    const n = Math.min(290, 2050 - sent);
    for (let i = 0; i < n; i++) t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ov' + (sent + i), path: '#n' } });
    sent += n;
    await delay(1050);
  }
  await delay(400);
  const late = conn(); await on1(late, 'connect');
  const replayP = none(late, 'interaction_replay', 1500);
  const stP = on1(late, 'session_state', { timeout: 3000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const replay = await replayP;
  const state = await stP.catch(() => null);
  assert(replay === null, 'late joiner receives NO interaction_replay after overflow (no partial story)', replay ? `got ${replay.count} events` : '');
  assert(!!state && typeof state.effectiveHtml === 'string' && state.effectiveHtml.length > 0, 'late joiner still gets bootable HTML after overflow', '');
}

// R4a: zombie-overlap reconnect keeps the grant driving
async function R4a_overlapReconnectKeepsGrant() {
  console.log('R4a: same-name second socket keeps control driving (zombie overlap)');
  const room = rid('r4a');
  const t = await joinTeacher(room); await upload(t, room);
  const a1 = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(b, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  // New tab joins with the SAME name while the old socket is still alive
  const a2 = await joinStudent(room, 'Ann');
  await delay(250);
  // Old tab dies AFTER the new one is in (the realistic blip/tab-switch order)
  a1.close();
  await delay(350);
  const bGets = on1(b, 'interaction', { match: p => p?.id === 'reconn1', timeout: 3000 });
  a2.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'reconn1', path: '#n' } });
  await bGets.then(() => ok('reconnected holder still drives room-wide')).catch(e => bad('reconnected holder drives', e.message));
}

// R4b: clean holder exit clears the grant AND unmutes the teacher
async function R4b_holderExitUnmutesTeacher() {
  console.log('R4b: holder leaves cleanly — grant clears, teacher can drive again');
  const room = rid('r4b');
  const t = await joinTeacher(room); await upload(t, room);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(b, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  // While Ann holds the chalk the teacher is muted (single-writer)
  const mutedProbe = none(b, 'interaction', 700);
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'muted1', path: '#n' } });
  assert(!((await mutedProbe)?.id === 'muted1'), 'teacher is muted while a student holds the chalk', '');
  // Ann leaves cleanly (no other same-name socket)
  const cleared = on1(b, 'control_changed', { match: p => p.holderName === null, timeout: 4000 });
  a.close();
  await cleared.then(() => ok('grant auto-clears when the holder truly leaves')).catch(e => bad('grant auto-clear', e.message));
  await delay(150);
  const bGets = on1(b, 'interaction', { match: p => p?.id === 'unmuted1', timeout: 3000 });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'unmuted1', path: '#n' } });
  await bGets.then(() => ok('teacher drives again after the holder left (room not frozen)')).catch(e => bad('teacher unmuted after holder exit', e.message));
}

// R5: revoke while interactive → holder falls back to teacher-only + journaled
async function R5_revokeFallsBackToInteractive() {
  console.log('R5: revoke with toggle ON — ex-holder becomes interactive (teacher-only, journaled)');
  const room = rid('r5');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('toggle_student_interaction', { roomId: room, allowed: true }); await delay(150);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  t.emit('grant_control', { roomId: room, holderName: 'Ann' });
  await on1(a, 'control_changed', { match: p => p.holderName === 'Ann' }).catch(() => {});
  t.emit('grant_control', { roomId: room, holderName: null });
  await on1(a, 'control_changed', { match: p => p.holderName === null }).catch(() => {});
  await delay(150);
  const tGets = on1(t, 'interaction', { match: p => p?.id === 'fb1', timeout: 3000 });
  const bLeak = none(b, 'interaction', 900);
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'fb1', path: '#n' } });
  await tGets.then(() => ok('ex-holder still reaches the TEACHER (interactive fallback)')).catch(e => bad('fallback to teacher', e.message));
  assert(!((await bLeak)?.id === 'fb1'), 'ex-holder does NOT drive other students after revoke', '');
  const late = conn(); await on1(late, 'connect');
  const replay = on1(late, 'interaction_replay', { match: p => Array.isArray(p.events) && p.events.some(e => e.id === 'fb1'), timeout: 3000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  await replay.then(() => ok('fallback event IS journaled (late joiner replays it)')).catch(e => bad('fallback journaled', e.message));
}

// R6: multi-room isolation under concurrent traffic
async function R6_roomIsolation() {
  console.log('R6: concurrent rooms never leak interactions');
  const roomA = rid('r6a'), roomB = rid('r6b');
  const tA = await joinTeacher(roomA, 'TA'); await upload(tA, roomA);
  const tB = await joinTeacher(roomB, 'TB'); await upload(tB, roomB);
  const sA = await joinStudent(roomA, 'SA');
  const sB = await joinStudent(roomB, 'SB');
  const sbGotP = collect(sB, 'interaction', 2500);
  const saGotP = collect(sA, 'interaction', 2500);
  for (let i = 0; i < 50; i++) tA.emit('interaction', { roomId: roomA, event: { type: 'SYNC_CLICK', id: 'A' + i, path: '#n' } });
  for (let i = 0; i < 50; i++) tB.emit('interaction', { roomId: roomB, event: { type: 'SYNC_CLICK', id: 'B' + i, path: '#n' } });
  const sbGot = await sbGotP; const saGot = await saGotP;
  const leakToB = sbGot.filter(e => typeof e.id === 'string' && e.id.startsWith('A')).length;
  const leakToA = saGot.filter(e => typeof e.id === 'string' && e.id.startsWith('B')).length;
  const bOwn = sbGot.filter(e => typeof e.id === 'string' && e.id.startsWith('B')).length;
  const aOwn = saGot.filter(e => typeof e.id === 'string' && e.id.startsWith('A')).length;
  assert(leakToA === 0 && leakToB === 0, 'zero cross-room leakage under concurrent bursts', `A←${leakToA} B←${leakToB}`);
  assert(aOwn === 50 && bOwn === 50, 'both rooms delivered their own full bursts', `A ${aOwn}/50, B ${bOwn}/50`);
}

// R7: toggle storm — fresh joiner sees the FINAL state
async function R7_toggleStorm() {
  console.log('R7: 21-toggle storm — fresh joiner sees the final state');
  const room = rid('r7');
  const t = await joinTeacher(room); await upload(t, room);
  for (let i = 0; i < 21; i++) { t.emit('toggle_student_interaction', { roomId: room, allowed: i % 2 === 0 }); }
  // final i=20 → allowed=true
  await delay(400);
  const fresh = conn(); await on1(fresh, 'connect');
  const st = on1(fresh, 'session_state', { timeout: 3000 });
  fresh.emit('join_room', { roomId: room, userName: 'F', role: 'student' });
  const state = await st.catch(() => null);
  assert(!!state && state.studentInteractionAllowed === true, 'fresh joiner sees the final toggle state (true)', state ? String(state.studentInteractionAllowed) : 'no state');
}

// R8: request_replay hardening
async function R8_requestReplayHardening() {
  console.log('R8: request_replay — non-member rejected, malformed safe, spam safe');
  const room = rid('r8');
  const t = await joinTeacher(room); await upload(t, room);
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'rr', path: '#n' } });
  await delay(200);
  // Non-member: connected socket that never joined the room
  const outsider = conn(); await on1(outsider, 'connect');
  const leakP = none(outsider, 'interaction_replay', 900);
  outsider.emit('request_replay', { roomId: room });
  assert((await leakP) === null, 'non-member request_replay gets NOTHING', '');
  // Malformed payloads must not crash the server
  t.emit('request_replay', null);
  t.emit('request_replay', {});
  t.emit('request_replay', { roomId: 12345 });
  t.emit('request_replay', { roomId: { nested: true } });
  await delay(200);
  // Member spam ×10 still answers and the server stays healthy
  let got = 0;
  const h = () => got++;
  t.on('interaction_replay', h);
  for (let i = 0; i < 10; i++) t.emit('request_replay', { roomId: room });
  await delay(800);
  t.off('interaction_replay', h);
  assert(got >= 1, 'member request_replay still answered after malformed + spam', `answers=${got}`);
  const s2 = await joinStudent(room, 'Health');
  assert(!!s2.connected, 'server healthy after request_replay abuse', '');
}

// R9: 250-stroke whiteboard burst hydrates completely, in order
async function R9_strokeBurstHydration() {
  console.log('R9: 250-stroke burst — full, ordered hydration to a late joiner');
  const room = rid('r9');
  const t = await joinTeacher(room); await upload(t, room);
  for (let i = 0; i < 250; i++) {
    t.emit('whiteboard_draw', { roomId: room, stroke: { id: 'wst' + i, tool: 'pen', color: '#000', width: 2, createdAt: Date.now() + i, points: [{ x: i, y: i }, { x: i + 5, y: i + 5 }] } });
  }
  await delay(700);
  const late = conn(); await on1(late, 'connect');
  const st = on1(late, 'session_state', { timeout: 4000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const state = await st.catch(() => null);
  const strokes = state?.whiteboard?.strokes || [];
  const mine = strokes.filter(s => typeof s.id === 'string' && s.id.startsWith('wst'));
  const ordered = mine.every((s, i) => i === 0 || Number(s.id.slice(3)) > Number(mine[i - 1].id.slice(3)));
  assert(mine.length === 250, 'all 250 strokes hydrated to the late joiner', `got ${mine.length}`);
  assert(ordered, 'stroke order preserved through hydration', '');
}

// R10: sim_error hardening — truncation + malformed payloads never crash
async function R10_simErrorHardening() {
  console.log('R10: sim_error — 50k message truncated, malformed payloads safe');
  const room = rid('r10');
  const t = await joinTeacher(room); await upload(t, room);
  const s = await joinStudent(room, 'Stu');
  const got = on1(t, 'sim_error', { timeout: 3000 });
  s.emit('sim_error', { roomId: room, message: 'X'.repeat(50000), source: 'Y'.repeat(50000) });
  const p = await got.catch(() => null);
  assert(!!p && p.message.length <= 310 && p.source.length <= 310, '50k-char sim_error truncated to ~300 chars', p ? `m=${p.message.length} s=${p.source.length}` : 'not delivered');
  // Malformed: none of these may crash or leak
  s.emit('sim_error', null);
  s.emit('sim_error', {});
  s.emit('sim_error', { roomId: room });
  s.emit('sim_error', { roomId: room, message: { obj: true }, source: 12345 });
  s.emit('sim_error', { roomId: 99, message: 'x' });
  await delay(300);
  const s2 = await joinStudent(room, 'Health2');
  assert(!!s2.connected, 'server healthy after malformed sim_error flood', '');
}

async function run() {
  const tests = [R1_sessionStateCarriesSeq, R2_strictOrdering, R3_overflowLatch,
    R4a_overlapReconnectKeepsGrant, R4b_holderExitUnmutesTeacher, R5_revokeFallsBackToInteractive,
    R6_roomIsolation, R7_toggleStorm, R8_requestReplayHardening, R9_strokeBurstHydration, R10_simErrorHardening];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(200); }
  console.log(`\nSTRESS12 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
