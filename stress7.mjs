// Round-4 FUZZ — fire malformed payloads at EVERY socket event and assert the
// server never crashes. A single uncaught throw in an async socket handler kills
// the whole process (every room), so "server still answers /healthz" after each
// event is the invariant. PORT=3100 node stress7.mjs   (use an ISOLATED port —
// this is destructive if a handler is unguarded.)
import { io } from 'socket.io-client';

const PORT = process.env.PORT || '3100';
const URL = `http://localhost:${PORT}`;
let pass = 0, fail = 0; const fails = [];
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; fails.push(n + (d ? ' — ' + d : '')); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const sockets = [];
function conn() { const s = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true }); sockets.push(s); return s; }
function on1(s, ev, t = 4000) { return new Promise((res, rej) => { const tm = setTimeout(() => { s.off(ev, h); rej(new Error('timeout ' + ev)); }, t); function h(p) { clearTimeout(tm); s.off(ev, h); res(p); } s.on(ev, h); }); }
async function alive() { try { const r = await fetch(URL + '/healthz', { signal: AbortSignal.timeout(2500) }); return r.ok; } catch { return false; } }

const R = 'fuzz' + Math.floor((Date.now()) % 1e6);

// Every socket event the server listens for.
const EVENTS = ['ping','join_room','request_content','set_room_password','upload_file','update_file','delete_file',
  'switch_file','run_preview','sync_html_update','dom_snapshot','force_sync','pause_session','resume_session',
  'toggle_scroll_sync','toggle_student_interaction','zoom_changed','reset_view','attention_check','attention_ack',
  'send_reaction','send_chat','send_quiz','quiz_answer','raise_hand','spotlight','draw_stroke','draw_delete_stroke',
  'draw_clear','whiteboard_draw','whiteboard_set_image','whiteboard_add_image','whiteboard_update_object',
  'whiteboard_remove_object','whiteboard_set_view','set_whiteboard_sync','whiteboard_add_shape','whiteboard_update_shape',
  'whiteboard_remove_shape','whiteboard_set_grid_mode','whiteboard_add_instrument','whiteboard_update_instrument',
  'whiteboard_remove_instrument','whiteboard_add_text','whiteboard_update_text','whiteboard_remove_text',
  'whiteboard_clear','whiteboard_reset','whiteboard_delete_stroke','whiteboard_delete_strokes','whiteboard_mode_toggle',
  'whiteboard_scroll','show_temp_content','clear_temp_content','laser_pointer','start_timer','stop_timer',
  'trigger_celebration','student_reaction','focus_mode','interaction','student_state','attention_change','grant_control',
  'peek_student','student_snapshot','resync_student','bookmark_create','bookmark_restore','bookmark_delete','set_step',
  'add_gate','gate_answer','claim_room','hard_reset','kick_user'];

// A broad spray of malformed payloads aimed at the common param shapes.
function payloads() {
  return [
    undefined, null, 'a-string', 42, true, [], [1,2,3], {},
    { roomId: null }, { roomId: 42 }, { roomId: {} }, { roomId: R },
    { roomId: R, event: null }, { roomId: R, event: 42 }, { roomId: R, event: {} }, { roomId: R, event: { type: 42 } },
    { roomId: R, file: null }, { roomId: R, file: 'x' }, { roomId: R, file: { html: 42 } },
    { roomId: R, object: null }, { roomId: R, object: { src: 42 } },
    { roomId: R, stroke: null }, { roomId: R, stroke: { points: 'nope' } }, { roomId: R, stroke: { points: [null, {}] } },
    { roomId: R, points: null }, { roomId: R, points: 'x' },
    { roomId: R, options: null }, { roomId: R, options: 'x' }, { roomId: R, options: [null, 1] },
    { roomId: R, studentName: 42 }, { roomId: R, studentName: {} }, { roomId: R, studentName: [] },
    { roomId: R, step: {}, answerIndex: [], studentName: 7 },
    { roomId: R, step: NaN }, { roomId: R, step: 'x', correctIndex: 'y', question: 42, options: 5 },
    { roomId: R, html: 42 }, { roomId: R, html: {} },
    { roomId: R, view: 'nope' }, { roomId: R, view: { boardScale: 'x', boardOffsetX: NaN } },
    { roomId: R, holderName: {} }, { roomId: R, holderName: 42 },
    { roomId: R, message: 42 }, { roomId: R, message: {} }, { roomId: R, userName: 42 },
    { roomId: R, userId: 42 }, { roomId: R, userId: {} }, { roomId: R, studentId: {} },
    { roomId: R, fileId: {} }, { roomId: R, id: null }, { roomId: R, bookmarkId: 42 },
    { roomId: R, text: null }, { roomId: R, text: { text: 42 } }, { roomId: R, shape: { points: 'x' } },
    { roomId: R, instrument: null }, { roomId: R, strokeIds: 'nope' }, { roomId: R, strokeId: {} },
    { roomId: R, zoomLevel: 'x' }, { roomId: R, scale: {}, offsetX: NaN }, { roomId: R, enabled: 'x' },
    { roomId: R, allowed: 'x' }, { roomId: R, active: 'x' }, { roomId: R, step: Infinity, answerIndex: -999 },
  ];
}

async function run() {
  console.log('FUZZ: malformed payloads against every socket event (server must survive)');
  if (!await alive()) { console.log('server not up on ' + PORT); process.exit(2); }
  // Authenticated teacher + a student, in a room with content, to reach handler bodies.
  const t = conn(); await on1(t, 'connect');
  t.emit('join_room', { roomId: R, userName: 'FuzzT', role: 'teacher' }); await on1(t, 'room_state').catch(()=>{});
  t.emit('upload_file', { roomId: R, file: { id: 'f', name: 'f', html: '<!doctype html><body>fuzz</body>', uploadedAt: 1 } });
  await delay(200);
  const st = conn(); await on1(st, 'connect');
  st.emit('join_room', { roomId: R, userName: 'FuzzS', role: 'student' }); await on1(st, 'room_state').catch(()=>{});
  await delay(150);

  const pls = payloads();
  let crashedAt = null;
  for (const ev of EVENTS) {
    for (const p of pls) { try { t.emit(ev, p); st.emit(ev, p); } catch {} }
    await delay(40);
    if (!await alive()) { crashedAt = ev; break; }
  }
  if (crashedAt) {
    bad(`server CRASHED while fuzzing '${crashedAt}'`, 'a malformed payload to this handler killed the process');
  } else {
    ok(`server survived malformed payloads across all ${EVENTS.length} events`);
    // sanity: server still functional — a fresh client can join + get state
    const v = conn(); await on1(v, 'connect');
    const ss = on1(v, 'session_state', 4000).catch(() => null);
    v.emit('join_room', { roomId: R, userName: 'After', role: 'student' });
    const got = await ss;
    got ? ok('server still fully functional after the fuzz (new student gets session_state)')
        : bad('server alive but a new student did not get session_state', '');
  }
  console.log(`\nSTRESS7 RESULT: ${pass} passed, ${fail} failed`);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  for (const s of sockets) { try { s.close(); } catch {} }
  process.exit(fail === 0 ? 0 : 1);
}
run().catch(e => { console.error('FATAL', e); process.exit(2); });
