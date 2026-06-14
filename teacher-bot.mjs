// Headless teacher I can drive across tool calls via a command file.
// Commands (write into .bot-cmd, one per line): upload | answer | roll | next | leave | rejoin | quit
import { io } from 'socket.io-client';
import { readFileSync, existsSync, writeFileSync } from 'fs';

const PORT = process.env.PORT || '61669';
const ROOM = process.env.ROOM || 'live3d';
const QUIZ_PATH = process.env.QUIZ || 'C:\\Users\\ac\\Desktop\\fraction simulation\\3d-quiz-stress.html';
const CMD = process.env.CMD || './.bot-cmd';
const html = readFileSync(QUIZ_PATH, 'utf8');
function log(m) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m); }

let s;
function connect() {
  s = io('http://localhost:' + PORT, { transports: ['websocket'], reconnection: false, forceNew: true });
  s.on('connect', () => { log('connected ' + s.id); s.emit('join_room', { roomId: ROOM, userName: 'MsTeacher', role: 'teacher' }); });
  s.on('room_state', () => log('room_state received'));
  s.on('session_state', p => log('session_state seed=' + p.randomSeed + ' rev=' + p.revision + ' holder=' + p.controlHolderName));
  s.on('teacher_replaced', () => log('!! teacher_replaced'));
  s.on('disconnect', r => log('socket disconnect: ' + r));
}
function emit(ev, p) { if (s && s.connected) { s.emit(ev, p); } else { log('  (drop ' + ev + ' — not connected)'); } }

function doCmd(c) {
  c = c.trim(); if (!c) return; log('CMD: ' + c);
  if (c === 'upload') emit('upload_file', { roomId: ROOM, file: { id: 'q3d', name: '3D Dice Quiz', html, uploadedAt: 1 } });
  else if (c === 'answer') emit('interaction', { roomId: ROOM, event: { type: 'SYNC_CLICK', path: '#ans-0' } });
  else if (c === 'roll') emit('interaction', { roomId: ROOM, event: { type: 'SYNC_CLICK', path: '#roll' } });
  else if (c === 'next') { emit('interaction', { roomId: ROOM, event: { type: 'SYNC_CLICK', path: '#ans-0' } }); setTimeout(() => emit('interaction', { roomId: ROOM, event: { type: 'SYNC_CLICK', path: '#roll' } }), 150); }
  else if (c === 'leave') { if (s) s.disconnect(); log('LEFT (grace armed)'); }
  else if (c === 'rejoin') connect();
  else if (c === 'quit') { if (s) s.disconnect(); process.exit(0); }
  else log('  unknown command: ' + c);
}

setInterval(() => {
  try { if (existsSync(CMD)) { const c = readFileSync(CMD, 'utf8'); if (c.trim()) { writeFileSync(CMD, ''); c.split('\n').forEach(doCmd); } } } catch (e) {}
}, 200);
connect();
log('teacher-bot up — room=' + ROOM + ' port=' + PORT);
