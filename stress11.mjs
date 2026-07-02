// Round-11: 3D-sim DELIVERY + diagnostics (the "3D simulation doesn't load
// for the student" audit). Root causes fixed:
//  (1) optimistic teacher preview + silent/racing server rejection of large
//      lessons (paste path had no size check; run_preview dropped silently)
//      -> teacher taught a sim only they could see.
//  (2) zero observability when a lesson fails ON the student's machine
//      (blocked CDN, WebGL unavailable, JS crash) -> new sim_error channel.
// Contracts pinned here:
//  - a 3D-shaped lesson (CDN script + canvas + module script) reaches the
//    student BYTE-IDENTICAL via upload broadcast.
//  - oversized upload -> upload_error AND students receive nothing.
//  - oversized run_preview -> upload_error (was a silent drop) + room state unchanged.
//  - oversized show_temp_content -> upload_error + not broadcast.
//  - sim_error routes student -> TEACHER ONLY with the student's name
//    (works for view-only students too; teacher-role senders are ignored).
//  - dom_snapshot with hasCanvas -> late joiner still boots the PRISTINE 3D sim.
// PORT=3100 node stress11.mjs
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
function on1(s, ev, { timeout = 4000, match } = {}) {
  return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, timeout); function h(p) { if (match && !match(p)) return; clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); });
}
function none(s, ev, ms = 900) { return new Promise(res => { let g = null; const h = p => { g = p; }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(g); }, ms); }); }
const rid = (p) => p + Math.floor((Date.now() + Math.random() * 1e6) % 1e6);

// A faithful 3D-sim shape: CDN script tag, import map + module script, canvas.
const SIM3D = `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="https://unpkg.com/three@0.160.0/build/three.min.js"><\/script>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js"}}<\/script>
</head><body>
<canvas id="c"></canvas>
<script type="module">import * as THREE from 'three'; window.__mod = true;<\/script>
<script>window.__cls = true;<\/script>
</body></html>`;
const BIG = '<!DOCTYPE html><html><body>' + 'x'.repeat(2 * 1024 * 1024 + 64) + '</body></html>';

async function joinTeacher(room, name = 'T') { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'teacher' }); await on1(s, 'room_state'); return s; }
async function joinStudent(room, name) { const s = conn(); await on1(s, 'connect'); s.emit('join_room', { roomId: room, userName: name, role: 'student' }); await on1(s, 'room_state').catch(() => {}); return s; }

// T1: a 3D-shaped lesson reaches the student byte-identical
async function T1_sim3dDelivered() {
  console.log('T1: 3D-shaped lesson reaches the student byte-identical');
  const room = rid('t1');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  const got = on1(s, 'run_preview', { timeout: 3000 });
  t.emit('upload_file', { roomId: room, file: { id: 'sim', name: '3D', html: SIM3D, uploadedAt: 1 } });
  const p = await got.catch(() => null);
  assert(!!p && p.html === SIM3D, 'student receives the 3D lesson BYTE-IDENTICAL (CDN+importmap+canvas intact)', p ? `len ${p.html?.length} vs ${SIM3D.length}` : 'no run_preview');
}

// T2: oversized upload -> upload_error, student receives NOTHING
async function T2_oversizedUpload() {
  console.log('T2: oversized upload -> upload_error, nothing reaches the student');
  const room = rid('t2');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  const errP = on1(t, 'upload_error', { timeout: 3000 });
  const leakP = none(s, 'run_preview', 1200);
  t.emit('upload_file', { roomId: room, file: { id: 'big', name: 'BIG', html: BIG, uploadedAt: 1 } });
  await errP.then(p => assert(/too large/i.test(p.message || ''), 'server answers upload_error (too large)', p.message)).catch(e => bad('upload_error emitted', e.message));
  assert((await leakP) === null, 'student receives NOTHING for the rejected upload', '');
}

// T3: oversized run_preview -> upload_error (was a SILENT drop) and lastRunHtml unchanged
async function T3_oversizedRunPreview() {
  console.log('T3: oversized run_preview -> upload_error (no more silent drop)');
  const room = rid('t3');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'ok', name: 'OK', html: SIM3D, uploadedAt: 1 } });
  await delay(200);
  const errP = on1(t, 'upload_error', { timeout: 3000 });
  t.emit('run_preview', { roomId: room, fileId: 'ok', html: BIG });
  await errP.then(p => assert(/too large/i.test(p.message || ''), 'run_preview oversized answers upload_error', p.message)).catch(e => bad('run_preview upload_error', e.message));
  // the room must still serve the previous good lesson
  const late = conn(); await on1(late, 'connect');
  const st = on1(late, 'session_state', { timeout: 3000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const state = await st.catch(() => null);
  assert(!!state && state.effectiveHtml === SIM3D, 'room content unchanged after the rejected run_preview', state ? `len ${state.effectiveHtml?.length}` : 'no state');
}

// T4: sim_error routes to the TEACHER with the student's name (view-only student too)
async function T4_simErrorRouting() {
  console.log('T4: sim_error (student diagnostics) -> teacher only, named');
  const room = rid('t4');
  const t = await joinTeacher(room);
  const a = await joinStudent(room, 'Ann');
  const b = await joinStudent(room, 'Bob');
  // NOTE: interaction toggle deliberately OFF — diagnostics must flow even view-only
  const got = on1(t, 'sim_error', { timeout: 3000 });
  const leak = none(b, 'sim_error', 900);
  a.emit('sim_error', { roomId: room, message: 'Failed to load script: https://unpkg.com/three...', source: 'https://unpkg.com/three...' });
  await got.then(p => assert(p.studentName === 'Ann' && /Failed to load/i.test(p.message), 'teacher receives the named sim_error from a view-only student', JSON.stringify(p).slice(0, 80))).catch(e => bad('teacher gets sim_error', e.message));
  assert((await leak) === null, 'other students do NOT receive the sim_error', '');
}

// T5: a teacher-role sim_error is NOT relayed (own errors surface locally)
async function T5_teacherSimErrorIgnored() {
  console.log('T5: teacher-role sim_error is ignored by the relay');
  const room = rid('t5');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  const leak = none(t, 'sim_error', 900);
  const leak2 = none(s, 'sim_error', 900);
  t.emit('sim_error', { roomId: room, message: 'x', source: '' });
  assert((await leak) === null && (await leak2) === null, 'teacher-role sim_error is not echoed to anyone', '');
}

// T6: oversized show_temp_content -> upload_error + NOT broadcast
async function T6_oversizedTempContent() {
  console.log('T6: oversized explanation -> upload_error, not broadcast');
  const room = rid('t6');
  const t = await joinTeacher(room);
  const s = await joinStudent(room, 'Stu');
  const errP = on1(t, 'upload_error', { timeout: 3000 });
  const leakP = none(s, 'temp_content', 1200);
  t.emit('show_temp_content', { roomId: room, html: BIG, name: 'Big' });
  await errP.then(p => assert(/too large/i.test(p.message || ''), 'show_temp_content oversized answers upload_error', p.message)).catch(e => bad('temp_content upload_error', e.message));
  assert((await leakP) === null, 'oversized explanation is NOT broadcast', '');
}

// T7: canvas-sim snapshot (hasCanvas) -> late joiner still boots the PRISTINE 3D lesson
async function T7_canvasSnapshotPristine() {
  console.log('T7: hasCanvas snapshot -> late joiner boots pristine 3D lesson');
  const room = rid('t7');
  const t = await joinTeacher(room);
  t.emit('upload_file', { roomId: room, file: { id: 'sim', name: '3D', html: SIM3D, uploadedAt: 1 } });
  await delay(200);
  // teacher's heartbeat snapshots the LIVE DOM (blank canvas shell) with hasCanvas
  t.emit('sync_html_update', { roomId: room, html: '<!DOCTYPE html><html><body><canvas id="c"></canvas><div>rendered shell</div></body></html>', requestId: 'snap-hb-1', hasCanvas: true });
  await delay(250);
  const late = conn(); await on1(late, 'connect');
  const st = on1(late, 'session_state', { timeout: 3000 });
  late.emit('join_room', { roomId: room, userName: 'Late', role: 'student' });
  const state = await st.catch(() => null);
  assert(!!state && state.effectiveHtml === SIM3D, 'late joiner gets the pristine 3D lesson, not the blank canvas shell', state ? `len ${state.effectiveHtml?.length}` : 'no state');
}

async function run() {
  const tests = [T1_sim3dDelivered, T2_oversizedUpload, T3_oversizedRunPreview, T4_simErrorRouting, T5_teacherSimErrorIgnored, T6_oversizedTempContent, T7_canvasSnapshotPristine];
  for (const test of tests) { try { await test(); } catch (e) { bad(test.name + ' threw', e.message); } await delay(150); }
  console.log(`\nSTRESS11 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
