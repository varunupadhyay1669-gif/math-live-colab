// Round-13: adversarial SYNC batch 2 — crash-recovery and edge fidelity.
// Self-contained: spawns its OWN server on PORT 3101 (and hard-kills it
// mid-suite to model a real crash — the only honest cold-start test).
//
// S1 crash + restart: room state (lesson, seed, journal, interactionSeq)
//    survives via the file store; sync works again after respawn.
// S2 baseline churn: rapid upload x3 — everyone converges on the LAST seed.
// S3 disconnect mid-burst: rejoining student replays the FULL story.
// S4 unicode fidelity: math symbols/emoji survive journal + hydration byte-identical.
// S5 oversized interaction event: dropped (not relayed, not journaled), server healthy.
// S6 grant flip-flop: routing is correct at every moment; only the CURRENT
//    holder drives; a stale holder's events never reach other students.
// node stress13.mjs   (no external server needed)
import { io } from 'socket.io-client';
import { spawn } from 'child_process';
import path from 'path';

const PORT = '3101';
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

// ── Server lifecycle (own child process; direct node → killable) ──
let server = null;
function startServer() {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  server = spawn(process.execPath, [tsxCli, 'server.ts'], {
    env: { ...process.env, PORT, NODE_ENV: 'production' },
    cwd: process.cwd(),
    stdio: 'ignore',
  });
}
async function waitHealthy(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${URL}/healthz`);
      if (r.ok) return true;
    } catch {}
    await delay(300);
  }
  throw new Error('server not healthy in time');
}
function killServerHard() { try { server?.kill('SIGKILL'); } catch {} }

// S1: hard crash + restart — room survives via the file store
async function S1_crashRestartRecovery() {
  console.log('S1: hard-kill + respawn — lesson/seed/journal survive, sync resumes');
  const room = rid('cr');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } });
  await delay(250);
  const st0 = on1(t, 'session_state', { timeout: 3000 });
  t.emit('request_content', { roomId: room });
  const before = await st0.catch(() => null);
  const seedBefore = before?.randomSeed;
  for (const id of ['c1', 'c2', 'c3']) { t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id, path: '#n' } }); await delay(60); }
  t.emit('toggle_student_interaction', { roomId: room, allowed: true });
  // Let the journal-save throttle (4s) + save debounce (3s) flush to disk.
  await delay(7000);
  killServerHard();
  await delay(800);
  startServer();
  await waitHealthy();
  // Teacher rejoins the SAME room id on the fresh process.
  const t2 = await joinTeacher(room, 'T');
  const stP = on1(t2, 'session_state', { timeout: 4000 });
  const rpP = on1(t2, 'interaction_replay', { timeout: 4000 }).catch(() => null);
  t2.emit('request_content', { roomId: room });
  const state = await stP.catch(() => null);
  const replay = await rpP;
  assert(!!state && state.effectiveHtml === QUIZ, 'lesson HTML restored after crash', state ? `len ${state.effectiveHtml?.length}` : 'no state');
  assert(!!state && typeof seedBefore === 'number' && state.randomSeed === seedBefore, 'randomSeed IDENTICAL across the crash (deterministic replay intact)', `before ${seedBefore} after ${state?.randomSeed}`);
  assert(!!replay && replay.events.filter(e => ['c1','c2','c3'].includes(e.id)).length === 3, 'journal survived the crash (all 3 events replay)', replay ? `events ${replay.count}` : 'no replay');
  assert(!!state && state.studentInteractionAllowed === true, 'interaction toggle restored', String(state?.studentInteractionAllowed));
  assert(!!state && typeof state.interactionSeq === 'number' && state.interactionSeq >= 3, 'interactionSeq restored (no seq-poisoning on rejoin)', `seq ${state?.interactionSeq}`);
  // Sync must WORK again post-restart
  const s = await joinStudent(room, 'Stu');
  await delay(150);
  const live = on1(s, 'interaction', { match: p => p?.id === 'post-crash', timeout: 3000 });
  t2.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'post-crash', path: '#n' } });
  await live.then(() => ok('live sync flows again after the restart')).catch(e => bad('post-restart live sync', e.message));
}

// S2: rapid baseline churn — everyone converges on the LAST seed
async function S2_baselineChurnConverges() {
  console.log('S2: upload x3 rapid — fresh joiner and mid-churn student converge on the final seed');
  const room = rid('ch');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'f1', name: 'A', html: QUIZ, uploadedAt: 1 } });
  await delay(120);
  const midStudent = await joinStudent(room, 'Mid');
  const midGets = collect(midStudent, 'run_preview', 2500);
  t.emit('upload_file', { roomId: room, file: { id: 'f2', name: 'B', html: QUIZ.replace('Q', 'Q2'), uploadedAt: 2 } });
  await delay(120);
  t.emit('upload_file', { roomId: room, file: { id: 'f3', name: 'C', html: QUIZ.replace('Q', 'Q3'), uploadedAt: 3 } });
  await delay(400);
  const fresh = conn(); await on1(fresh, 'connect');
  const stP = on1(fresh, 'session_state', { timeout: 3000 });
  fresh.emit('join_room', { roomId: room, userName: 'F', role: 'student' });
  const state = await stP.catch(() => null);
  const teacherSt = on1(t, 'session_state', { timeout: 3000 });
  t.emit('request_content', { roomId: room });
  const tState = await teacherSt.catch(() => null);
  assert(!!state && state.activeFileId === 'f3', 'fresh joiner lands on the LAST upload', state?.activeFileId);
  assert(!!state && !!tState && state.randomSeed === tState.randomSeed, 'fresh joiner seed === teacher seed after churn', `${state?.randomSeed} vs ${tState?.randomSeed}`);
  const mid = await midGets;
  const sawFinal = mid.some(p => p?.fileId === 'f3');
  assert(sawFinal, 'mid-churn student received the final baseline broadcast', `saw ${mid.map(p => p?.fileId).join(',')}`);
}

// S3: student drops mid-burst — rejoin replays the FULL story
async function S3_dropMidBurstFullReplay() {
  console.log('S3: disconnect at event ~20 of 40 — rejoin replays all 40');
  const room = rid('db');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } });
  await delay(200);
  const s1 = await joinStudent(room, 'Flaky');
  for (let i = 0; i < 20; i++) t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'mb' + i, path: '#n' } });
  await delay(250);
  s1.close(); // drop mid-class
  for (let i = 20; i < 40; i++) t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'mb' + i, path: '#n' } });
  await delay(300);
  const s2 = conn(); await on1(s2, 'connect');
  const rpP = on1(s2, 'interaction_replay', { timeout: 4000 });
  s2.emit('join_room', { roomId: room, userName: 'Flaky', role: 'student' });
  const replay = await rpP.catch(() => null);
  const mine = replay ? replay.events.filter(e => typeof e.id === 'string' && e.id.startsWith('mb')).length : 0;
  assert(mine === 40, 'rejoined student replays the COMPLETE 40-event story', `got ${mine}`);
  const live = on1(s2, 'interaction', { match: p => p?.id === 'mb-live', timeout: 3000 });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'mb-live', path: '#n' } });
  await live.then(() => ok('live tail continues after replay')).catch(e => bad('live tail after replay', e.message));
}

// S4: unicode fidelity through journal + whiteboard hydration
async function S4_unicodeFidelity() {
  console.log('S4: math symbols + emoji survive sync byte-identical');
  const room = rid('uni');
  const MATH = 'π ≈ 3.14159 · √2 ≠ ½ · ∑ᵢ xᵢ 🎯²';
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } });
  await delay(200);
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_INPUT', id: 'u1', path: '#q', value: MATH } });
  t.emit('whiteboard_add_text', { roomId: room, text: { id: 'ut1', x: 10, y: 10, text: MATH, fontSize: 24, color: '#000', createdAt: Date.now() } });
  await delay(300);
  const late = conn(); await on1(late, 'connect');
  const rpP = on1(late, 'interaction_replay', { timeout: 3000 });
  const stP = on1(late, 'session_state', { timeout: 3000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const replay = await rpP.catch(() => null);
  const state = await stP.catch(() => null);
  const ev = replay?.events.find(e => e.id === 'u1');
  const wt = (state?.whiteboard?.texts || []).find(x => x.id === 'ut1');
  assert(!!ev && ev.value === MATH, 'journaled SYNC_INPUT value byte-identical (no mojibake at the sync layer)', ev ? ev.value?.slice(0, 30) : 'missing');
  assert(!!wt && wt.text === MATH, 'whiteboard text hydrates byte-identical', wt ? wt.text?.slice(0, 30) : 'missing');
}

// S5: oversized interaction event — dropped entirely, server healthy
async function S5_oversizedInteractionDropped() {
  console.log('S5: 200KB interaction event — dropped (not relayed, not journaled), server healthy');
  const room = rid('big');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } });
  await delay(200);
  const s = await joinStudent(room, 'Stu');
  await delay(150);
  const leakP = none(s, 'interaction', 1200);
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_INPUT', id: 'huge', path: '#q', value: 'X'.repeat(200 * 1024) } });
  const leaked = await leakP;
  assert(!(leaked && leaked.id === 'huge'), 'oversized event is NOT relayed to students', leaked ? `leaked ${JSON.stringify(leaked).length} bytes` : '');
  const late = conn(); await on1(late, 'connect');
  const rpP = none(late, 'interaction_replay', 1200);
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const replay = await rpP;
  const inJournal = replay && Array.isArray(replay.events) && replay.events.some(e => e.id === 'huge');
  assert(!inJournal, 'oversized event is NOT journaled (no 200KB x 2000 memory bomb)', '');
  const live = on1(s, 'interaction', { match: p => p?.id === 'after-huge', timeout: 3000 });
  t.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'after-huge', path: '#n' } });
  await live.then(() => ok('normal sync continues after the oversized event')).catch(e => bad('sync after oversized', e.message));
}

// S6: grant flip-flop — only the CURRENT holder ever drives
async function S6_grantFlipFlopRouting() {
  console.log('S6: grant A -> B -> A — routing correct at every step');
  const room = rid('ff');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'q', name: 'Q', html: QUIZ, uploadedAt: 1 } });
  await delay(200);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  const c = await joinStudent(room, 'Cam'); // observer
  const grantAndWait = async (name) => {
    t.emit('grant_control', { roomId: room, holderName: name });
    await on1(c, 'control_changed', { match: p => p.holderName === name, timeout: 3000 }).catch(() => {});
    await delay(120);
  };
  await grantAndWait('Ann');
  const p1 = on1(c, 'interaction', { match: p => p?.id === 'ffA1', timeout: 2500 });
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ffA1', path: '#n' } });
  await p1.then(() => ok('holder Ann drives (step 1)')).catch(e => bad('Ann drives step 1', e.message));
  await grantAndWait('Bob');
  const staleA = none(c, 'interaction', 900);
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ffA2', path: '#n' } });
  assert(!((await staleA)?.id === 'ffA2'), 'STALE holder Ann cannot drive after handoff to Bob', '');
  const p2 = on1(c, 'interaction', { match: p => p?.id === 'ffB1', timeout: 2500 });
  b.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ffB1', path: '#n' } });
  await p2.then(() => ok('holder Bob drives (step 2)')).catch(e => bad('Bob drives step 2', e.message));
  await grantAndWait('Ann');
  const p3 = on1(c, 'interaction', { match: p => p?.id === 'ffA3', timeout: 2500 });
  a.emit('interaction', { roomId: room, event: { type: 'SYNC_CLICK', id: 'ffA3', path: '#n' } });
  await p3.then(() => ok('Ann drives again after the grant returns (step 3)')).catch(e => bad('Ann drives step 3', e.message));
}

async function run() {
  startServer();
  await waitHealthy();
  const tests = [S1_crashRestartRecovery, S2_baselineChurnConverges, S3_dropMidBurstFullReplay,
    S4_unicodeFidelity, S5_oversizedInteractionDropped, S6_grantFlipFlopRouting];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(250); }
  console.log(`\nSTRESS13 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  killServerHard();
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); killServerHard(); process.exit(2); });
