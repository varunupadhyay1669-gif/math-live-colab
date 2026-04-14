import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';

interface FileEntry {
  id: string;
  name: string;
  html: string;
  uploadedAt: number;
}

interface RoomData {
  files: FileEntry[];
  activeFileId: string | null;
  lastRunHtml: string | null;
  users: Map<string, { name: string; role: 'teacher' | 'student'; joinedAt: number }>;
  isPaused: boolean;
  teacherSocketId: string | null;
  createdAt: number;
  lastActivityAt: number;
  studentLeftAt: number | null; // When the last student disconnected (for 2hr expiry)
  chat: Array<{ id: string; userId: string; userName: string; message: string; timestamp: number }>;
  // Step-lock
  currentStep: number;
  gates: Record<number, { question: string; options: string[]; correctIndex: number }>;
  // Sync modes
  scrollSyncEnabled: boolean;
  studentInteractionAllowed: boolean; // When false, students are view-only (like screen share)
  // Room password (optional)
  password: string | null;
  // Students waiting for HTML sync from teacher (joined before teacher's DOM capture arrives)
  pendingSyncStudents: string[];
}

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 5e6, // 5MB for large HTML files
  });

  const rooms = new Map<string, RoomData>();

  // ─── MEMORY MANAGEMENT ───
  // Sweep every 10 minutes:
  //  - Rooms inactive for > 48 hours (no activity at all)
  //  - Rooms where last student left > 2 hours ago AND no students currently connected
  setInterval(() => {
    const now = Date.now();
    const absoluteExpiryMs = 48 * 60 * 60 * 1000; // 48 hours hard cap
    const studentLeftExpiryMs = 2 * 60 * 60 * 1000; // 2 hours after last student leaves
    let deletedCount = 0;

    for (const [roomId, room] of rooms.entries()) {
      // Hard expiry: 48 hours of no activity at all
      if (now - room.lastActivityAt > absoluteExpiryMs) {
        rooms.delete(roomId);
        deletedCount++;
        continue;
      }

      // Student-left expiry: 2 hours after last student disconnected
      if (room.studentLeftAt && (now - room.studentLeftAt > studentLeftExpiryMs)) {
        // Only expire if no students are currently connected
        const hasStudents = Array.from(room.users.values()).some(u => u.role === 'student');
        if (!hasStudents) {
          rooms.delete(roomId);
          deletedCount++;
          continue;
        }
      }
    }

    if (deletedCount > 0) {
      console.log(`🧹 Memory Sweep: Cleared ${deletedCount} expired rooms.`);
    }
  }, 10 * 60 * 1000);

  function updateRoomActivity(roomId: string) {
    const room = rooms.get(roomId);
    if (room) room.lastActivityAt = Date.now();
  }

  // ─── RATE LIMITING ───
  const rateLimits = new Map<string, { count: number; resetAt: number }>();
  const RATE_LIMIT_EVENTS = 200; // max events per second (needs headroom for scroll + cursor + input)
  const RATE_LIMIT_WINDOW = 1000; // 1 second window

  function checkRateLimit(socketId: string): boolean {
    const now = Date.now();
    let entry = rateLimits.get(socketId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
      rateLimits.set(socketId, entry);
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_EVENTS;
  }

  // Clean up rate limit entries periodically
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of rateLimits.entries()) {
      if (now > entry.resetAt + 5000) rateLimits.delete(id);
    }
  }, 30000);

  function createRoom(): RoomData {
    return {
      files: [],
      activeFileId: null,
      lastRunHtml: null,
      users: new Map(),
      isPaused: false,
      teacherSocketId: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      studentLeftAt: null,
      chat: [],
      currentStep: 1,
      gates: {},
      scrollSyncEnabled: true,
      studentInteractionAllowed: false, // View-only by default
      password: null,
      pendingSyncStudents: [],
    };
  }

  // ─── ROOM PERSISTENCE ───
  const PERSIST_DIR = path.join(process.cwd(), '.rooms');
  const PERSIST_INTERVAL = 5 * 60 * 1000; // Save every 5 minutes
  const PERSIST_MAX_AGE = 48 * 60 * 60 * 1000; // Clean files older than 48 hours

  // Ensure persist directory exists
  try { if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch {}

  function serializeRoom(roomId: string, room: RoomData): object {
    return {
      roomId,
      files: room.files,
      activeFileId: room.activeFileId,
      lastRunHtml: room.lastRunHtml,
      isPaused: room.isPaused,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      chat: room.chat.slice(-100),
      currentStep: room.currentStep,
      gates: room.gates,
      scrollSyncEnabled: room.scrollSyncEnabled,
      studentInteractionAllowed: room.studentInteractionAllowed,
      password: room.password,
    };
  }

  function saveRooms() {
    try {
      let saved = 0;
      for (const [roomId, room] of rooms.entries()) {
        if (room.files.length === 0 && !room.lastRunHtml) continue; // Skip empty rooms
        const data = JSON.stringify(serializeRoom(roomId, room));
        fs.writeFileSync(path.join(PERSIST_DIR, `${roomId}.json`), data, 'utf-8');
        saved++;
      }
      if (saved > 0) console.log(`💾 Persisted ${saved} rooms`);
    } catch (err) {
      console.error('Failed to persist rooms:', err);
    }
  }

  function restoreRooms() {
    try {
      if (!fs.existsSync(PERSIST_DIR)) return;
      const files = fs.readdirSync(PERSIST_DIR).filter(f => f.endsWith('.json'));
      const now = Date.now();
      let restored = 0;
      let cleaned = 0;
      for (const file of files) {
        const filePath = path.join(PERSIST_DIR, file);
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          // Clean up old files
          if (raw.lastActivityAt && (now - raw.lastActivityAt > PERSIST_MAX_AGE)) {
            fs.unlinkSync(filePath);
            cleaned++;
            continue;
          }
          const room = createRoom();
          room.files = raw.files || [];
          room.activeFileId = raw.activeFileId || null;
          room.lastRunHtml = raw.lastRunHtml || null;
          room.isPaused = false; // Always start unpaused
          room.createdAt = raw.createdAt || now;
          room.lastActivityAt = raw.lastActivityAt || now;
          room.chat = raw.chat || [];
          room.currentStep = raw.currentStep || 1;
          room.gates = raw.gates || {};
          room.scrollSyncEnabled = raw.scrollSyncEnabled !== false;
          room.studentInteractionAllowed = !!raw.studentInteractionAllowed;
          room.password = raw.password || null;
          rooms.set(raw.roomId, room);
          restored++;
        } catch { fs.unlinkSync(filePath); cleaned++; }
      }
      if (restored > 0) console.log(`📂 Restored ${restored} rooms from disk`);
      if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale room files`);
    } catch (err) {
      console.error('Failed to restore rooms:', err);
    }
  }

  // Restore rooms on startup
  restoreRooms();

  // Periodic save
  setInterval(saveRooms, PERSIST_INTERVAL);

  // Save on process exit
  process.on('SIGINT', () => { saveRooms(); process.exit(0); });
  process.on('SIGTERM', () => { saveRooms(); process.exit(0); });

  function getRoomUserList(room: RoomData) {
    const list: Array<{ id: string; name: string; role: string }> = [];
    room.users.forEach((user, id) => {
      list.push({ id, name: user.name, role: user.role });
    });
    return list;
  }

  // ─── INPUT VALIDATION HELPERS ───
  const MAX_CHAT_LENGTH = 2000;
  const MAX_USERNAME_LENGTH = 50;
  const MAX_ROOM_ID_LENGTH = 20;
  const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file
  const MAX_QUIZ_QUESTION_LENGTH = 500;
  const MAX_FILES_PER_ROOM = 50;

  function sanitizeString(str: unknown, maxLen: number): string {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLen).trim();
  }

  function isValidRoomId(roomId: unknown): roomId is string {
    return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH && /^[a-zA-Z0-9_-]+$/.test(roomId);
  }

  // ─── CHAT RATE LIMITING ───
  const chatRateLimits = new Map<string, { count: number; resetAt: number }>();
  const CHAT_RATE_LIMIT = 10; // max messages per window
  const CHAT_RATE_WINDOW = 5000; // 5 seconds

  function checkChatRateLimit(socketId: string): boolean {
    const now = Date.now();
    let entry = chatRateLimits.get(socketId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + CHAT_RATE_WINDOW };
      chatRateLimits.set(socketId, entry);
    }
    entry.count++;
    return entry.count <= CHAT_RATE_LIMIT;
  }

  // Clean up chat rate limit entries
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of chatRateLimits.entries()) {
      if (now > entry.resetAt + 10000) chatRateLimits.delete(id);
    }
  }, 30000);

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // ─── JOIN ROOM ───
    socket.on('join_room', ({ roomId, userName, role, password }: { roomId: string; userName: string; role: 'teacher' | 'student'; password?: string }) => {
      // Validate inputs
      if (!isValidRoomId(roomId)) {
        socket.emit('join_error', { message: 'Invalid room code' });
        return;
      }
      const safeName = sanitizeString(userName, MAX_USERNAME_LENGTH) || 'Anonymous';
      if (role !== 'teacher' && role !== 'student') {
        socket.emit('join_error', { message: 'Invalid role' });
        return;
      }

      updateRoomActivity(roomId);
      if (!rooms.has(roomId)) {
        rooms.set(roomId, createRoom());
      }
      const room = rooms.get(roomId)!;

      // Check room password (if set)
      if (room.password && role === 'student' && password !== room.password) {
        socket.emit('join_error', { message: 'Incorrect room password' });
        return;
      }

      socket.join(roomId);
      room.users.set(socket.id, { name: safeName, role, joinedAt: Date.now() });

      // If a student just joined, clear the studentLeftAt timer
      if (role === 'student') {
        room.studentLeftAt = null;
      }

      if (role === 'teacher') {
        room.teacherSocketId = socket.id;
      } else if (role === 'student' && room.teacherSocketId) {
        // Track this student as needing fresh HTML from teacher's live DOM
        room.pendingSyncStudents.push(socket.id);
        // Auto-request the teacher to send their live DOM state to catch up this student
        io.to(room.teacherSocketId).emit('request_html_sync');
      }

      // Send current state to the newly joined user
      socket.emit('room_state', {
        files: room.files,
        activeFileId: room.activeFileId,
        lastRunHtml: room.lastRunHtml,
        isPaused: room.isPaused,
        scrollSyncEnabled: room.scrollSyncEnabled,
        studentInteractionAllowed: room.studentInteractionAllowed,
        currentStep: room.currentStep,
        gates: room.gates,
        users: getRoomUserList(room),
        chat: room.chat.slice(-50), // Last 50 messages
      });

      // Broadcast updated user list
      io.to(roomId).emit('user_list', getRoomUserList(room));
    });

    // ─── REQUEST CONTENT (student fallback) ───
    // If a student missed the initial HTML delivery, they can request it again
    socket.on('request_content', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (room.lastRunHtml) {
        socket.emit('run_preview', { fileId: room.activeFileId, html: room.lastRunHtml });
      }
      // Also ask teacher for fresh DOM if available
      if (room.teacherSocketId) {
        room.pendingSyncStudents.push(socket.id);
        io.to(room.teacherSocketId).emit('request_html_sync');
      }
    });

    // ─── SET ROOM PASSWORD ───
    socket.on('set_room_password', ({ roomId, password }: { roomId: string; password: string | null }) => {
      const room = rooms.get(roomId);
      if (!room || room.teacherSocketId !== socket.id) return;
      room.password = password;
      console.log(`🔒 Room ${roomId}: Password ${password ? 'set' : 'removed'}`);
    });

    // ─── FILE MANAGEMENT ───
    socket.on('upload_file', ({ roomId, file }: { roomId: string; file: FileEntry }) => {
      if (!isValidRoomId(roomId)) return;
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      // Validate file size
      if (file?.html && file.html.length > MAX_FILE_SIZE) {
        socket.emit('upload_error', { message: 'File too large (max 2MB)' });
        return;
      }
      // Validate file count
      if (room.files.length >= MAX_FILES_PER_ROOM) {
        socket.emit('upload_error', { message: `Too many files (max ${MAX_FILES_PER_ROOM})` });
        return;
      }
      room.files.push(file);
      room.activeFileId = file.id;
      room.lastRunHtml = file.html;
      io.to(roomId).emit('file_uploaded', file);
      io.to(roomId).emit('active_file_changed', { fileId: file.id, fileName: file.name, html: file.html });
      // Auto-push HTML to all connected clients immediately
      io.to(roomId).emit('run_preview', { fileId: file.id, html: file.html });
    });

    socket.on('update_file', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
        socket.to(roomId).emit('file_updated', { fileId, html });
      }
    });

    socket.on('delete_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.files = room.files.filter(f => f.id !== fileId);
      if (room.activeFileId === fileId) {
        room.activeFileId = room.files.length > 0 ? room.files[0].id : null;
      }
      io.to(roomId).emit('file_deleted', { fileId, newActiveId: room.activeFileId });
    });

    socket.on('switch_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.activeFileId = fileId;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        room.lastRunHtml = file.html;
        // Send file content WITH the active_file_changed so student never reads stale state
        io.to(roomId).emit('active_file_changed', { fileId, fileName: file.name, html: file.html });
        io.to(roomId).emit('run_preview', { fileId, html: file.html });
      }
    });

    // ─── RUN / REFRESH PREVIEW ───
    socket.on('run_preview', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      // Update the file content
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
      }
      room.activeFileId = fileId;
      room.lastRunHtml = html;
      // Send to everyone (including sender for confirmation)
      io.to(roomId).emit('run_preview', { fileId, html });
    });

    socket.on('sync_html_update', ({ roomId, html }: { roomId: string; html: string }) => {
      const room = rooms.get(roomId);
      if (!room || !room.activeFileId) return;
      // Store for future students
      room.lastRunHtml = html;
      // Send to any students waiting for the teacher's live DOM
      // (these students joined after the teacher and need the current content)
      if (room.pendingSyncStudents.length > 0) {
        const pending = room.pendingSyncStudents;
        room.pendingSyncStudents = [];
        for (const studentId of pending) {
          io.to(studentId).emit('run_preview', { fileId: room.activeFileId, html });
        }
        console.log(`📤 Sent live HTML to ${pending.length} pending student(s) in room ${roomId}`);
      }
    });

    // ─── FORCE SYNC (Server-authoritative) ───
    socket.on('force_sync', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      updateRoomActivity(roomId);

      // Build the authoritative state snapshot
      const syncPayload = {
        files: room.files,
        activeFileId: room.activeFileId,
        lastRunHtml: room.lastRunHtml,
        isPaused: room.isPaused,
      };

      // Broadcast to all clients in the room
      io.to(roomId).emit('force_sync_state', syncPayload);
      console.log(`🔄 Force Sync triggered for room ${roomId}`);
    });

    // ─── TEACHER CONTROLS ───
    socket.on('pause_session', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.isPaused = true;
      io.to(roomId).emit('session_paused');
    });

    socket.on('resume_session', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.isPaused = false;
      io.to(roomId).emit('session_resumed');
    });

    // ─── SCROLL SYNC TOGGLE ───
    socket.on('toggle_scroll_sync', ({ roomId, enabled }: { roomId: string; enabled: boolean }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.scrollSyncEnabled = enabled;
      io.to(roomId).emit('scroll_sync_changed', { enabled });
    });

    // ─── STUDENT INTERACTION TOGGLE ───
    socket.on('toggle_student_interaction', ({ roomId, allowed }: { roomId: string; allowed: boolean }) => {
      const room = rooms.get(roomId);
      if (!room || room.teacherSocketId !== socket.id) return; // Only teacher
      room.studentInteractionAllowed = allowed;
      io.to(roomId).emit('student_interaction_changed', { allowed });
      console.log(`${allowed ? '🖐️' : '👁️'} Room ${roomId}: Student interaction ${allowed ? 'enabled' : 'disabled (view-only)'}`);
    });

    // ─── RESET VIEW (scroll everyone to top) ───
    socket.on('reset_view', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room || room.teacherSocketId !== socket.id) return;
      io.to(roomId).emit('reset_view');
    });

    // ─── ATTENTION CHECK ───
    socket.on('attention_check', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!room || room.teacherSocketId !== socket.id) return;
      io.to(roomId).emit('attention_check', { timestamp: Date.now() });
    });

    socket.on('attention_ack', ({ roomId, studentName }: { roomId: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!room || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('attention_ack', { studentId: socket.id, studentName, timestamp: Date.now() });
    });

    // ─── REACTIONS ───
    socket.on('send_reaction', ({ roomId, emoji, fromName }: { roomId: string; emoji: string; fromName: string }) => {
      io.to(roomId).emit('reaction', { emoji, fromName, senderId: socket.id });
    });

    // ─── CHAT ───
    socket.on('send_chat', ({ roomId, message, userName }: { roomId: string; message: string; userName: string }) => {
      if (!isValidRoomId(roomId)) return;
      if (!checkChatRateLimit(socket.id)) return; // Rate limited
      const safeMessage = sanitizeString(message, MAX_CHAT_LENGTH);
      const safeName = sanitizeString(userName, MAX_USERNAME_LENGTH) || 'Anonymous';
      if (!safeMessage) return; // Empty message after sanitization
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!room) return;
      const chatMsg = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        userId: socket.id,
        userName: safeName,
        message: safeMessage,
        timestamp: Date.now(),
      };
      room.chat.push(chatMsg);
      // Keep only last 200 messages
      if (room.chat.length > 200) room.chat = room.chat.slice(-200);
      io.to(roomId).emit('chat_message', chatMsg);
    });

    // ─── QUIZ / QUESTIONS ───
    socket.on('send_quiz', ({ roomId, question, options }: { roomId: string; question: string; options?: string[] }) => {
      if (!isValidRoomId(roomId)) return;
      const safeQuestion = sanitizeString(question, MAX_QUIZ_QUESTION_LENGTH);
      if (!safeQuestion) return;
      io.to(roomId).emit('quiz', { question: safeQuestion, options, senderId: socket.id });
    });

    socket.on('quiz_answer', ({ roomId, answer, studentName }: { roomId: string; answer: string; studentName: string }) => {
      // Send answer to teacher
      const room = rooms.get(roomId);
      if (!room || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('quiz_answer_received', { answer, studentName, studentId: socket.id });
    });

    // ─── RAISE HAND ───
    socket.on('raise_hand', ({ roomId, studentName }: { roomId: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      io.to(roomId).emit('hand_raised', { studentName, studentId: socket.id });
    });

    // ─── SPOTLIGHT / ANNOTATION ───
    socket.on('spotlight', ({ roomId, x, y, active }: { roomId: string; x: number; y: number; active: boolean }) => {
      socket.to(roomId).emit('spotlight', { x, y, active, senderId: socket.id });
    });

    // ─── DRAWING / ANNOTATION ───
    socket.on('draw_stroke', ({ roomId, points, color, width, transient }: any) => {
      socket.to(roomId).emit('draw_stroke', { points, color, width, transient, senderId: socket.id });
    });

    socket.on('draw_clear', ({ roomId }: { roomId: string }) => {
      socket.to(roomId).emit('draw_clear');
    });

    // ─── LASER POINTER ───
    socket.on('laser_pointer', ({ roomId, x, y, active }: { roomId: string; x: number; y: number; active: boolean }) => {
      socket.to(roomId).emit('laser_pointer', { x, y, active });
    });

    // ─── CHALLENGE TIMER ───
    socket.on('start_timer', ({ roomId, seconds }: { roomId: string; seconds: number }) => {
      io.to(roomId).emit('timer_started', { seconds, startedAt: Date.now() });
    });

    socket.on('stop_timer', ({ roomId }: { roomId: string }) => {
      io.to(roomId).emit('timer_stopped');
    });

    // ─── CELEBRATION ───
    socket.on('trigger_celebration', ({ roomId, type }: { roomId: string; type: string }) => {
      io.to(roomId).emit('celebration', { type });
    });

    // ─── STUDENT QUICK REACTIONS ───
    socket.on('student_reaction', ({ roomId, emoji, label, studentName }: { roomId: string; emoji: string; label: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!room || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('student_feedback', { emoji, label, studentName, studentId: socket.id });
    });

    // ─── FOCUS MODE ───
    socket.on('focus_mode', ({ roomId, active, x, y, radius }: { roomId: string; active: boolean; x: number; y: number; radius: number }) => {
      updateRoomActivity(roomId);
      socket.to(roomId).emit('focus_mode', { active, x, y, radius });
    });

    // ─── INTERACTION SYNC ───
    socket.on('interaction', ({ roomId, event }: { roomId: string; event: any }) => {
      if (!checkRateLimit(socket.id)) return; // Rate limited
      updateRoomActivity(roomId);
      event.userId = socket.id;
      const room = rooms.get(roomId);
      if (!room) return;

      const user = room.users.get(socket.id);
      if (user) event.userName = user.name;
      event.role = user?.role || 'unknown';

      if (user?.role === 'teacher') {
        // Teacher → broadcast to all students (one-way sync)
        socket.to(roomId).emit('interaction', event);
      } else if (user?.role === 'student') {
        // Student → only relay if interaction is allowed, and only cursor to teacher
        if (event.type === 'SYNC_CURSOR') {
          // Always allow cursor so teacher can see where students are looking
          if (room.teacherSocketId) {
            io.to(room.teacherSocketId).emit('interaction', event);
          }
        } else if (room.studentInteractionAllowed) {
          // Student interactions → only to teacher (not other students)
          if (room.teacherSocketId) {
            io.to(room.teacherSocketId).emit('interaction', event);
          }
        }
        // When not allowed: student events are silently dropped (view-only mode)
      }
    });

    // ─── ATTENTION DETECTION ───
    socket.on('attention_change', ({ roomId, userName, isAttentive, timestamp }: { roomId: string; userName: string; isAttentive: boolean; timestamp: number }) => {
      const room = rooms.get(roomId);
      if (!room || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('student_attention', {
        studentId: socket.id,
        studentName: userName,
        isAttentive,
        timestamp,
      });
    });

    // ─── STEP-LOCK SYSTEM ───
    socket.on('set_step', ({ roomId, step }: { roomId: string; step: number }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.currentStep = step;
      io.to(roomId).emit('step_changed', { step });
    });

    socket.on('add_gate', ({ roomId, step, question, options, correctIndex }: { roomId: string; step: number; question: string; options: string[]; correctIndex: number }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      room.gates[step] = { question, options, correctIndex };
      io.to(roomId).emit('gate_added', { step });
    });

    socket.on('gate_answer', ({ roomId, step, answerIndex, studentName }: { roomId: string; step: number; answerIndex: number; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!room) return;
      const gate = room.gates[step];
      if (!gate) { socket.emit('gate_result', { correct: false }); return; }
      const isCorrect = gate.correctIndex === answerIndex;
      socket.emit('gate_result', { correct: isCorrect });
      if (room.teacherSocketId) {
        io.to(room.teacherSocketId).emit('gate_answered', {
          studentName, step, correct: isCorrect,
        });
      }
    });

    // ─── KICK USER ───
    socket.on('kick_user', ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.get(roomId);
      if (!room || room.teacherSocketId !== socket.id) return; // Only teacher can kick
      io.to(userId).emit('kicked');
      const targetSocket = io.sockets.sockets.get(userId);
      if (targetSocket) {
        targetSocket.leave(roomId);
        room.users.delete(userId);
        io.to(roomId).emit('user_list', getRoomUserList(room));
        io.to(roomId).emit('user_left', { userId, userName: 'Kicked user' });
        console.log(`👢 Room ${roomId}: User ${userId} was kicked`);
      }
    });

    // ─── DISCONNECT ───
    socket.on('disconnecting', () => {
      for (const roomId of socket.rooms) {
        if (rooms.has(roomId)) {
          const room = rooms.get(roomId)!;
          const user = room.users.get(socket.id);
          room.users.delete(socket.id);

          io.to(roomId).emit('user_list', getRoomUserList(room));
          io.to(roomId).emit('user_left', { userId: socket.id, userName: user?.name || 'Unknown' });

          if (room.teacherSocketId === socket.id) {
            room.teacherSocketId = null;
            // Notify students that teacher disconnected
            io.to(roomId).emit('teacher_disconnected');
          }

          // Check if any students remain — if not, start the 2hr expiry countdown
          if (user?.role === 'student') {
            const hasStudents = Array.from(room.users.values()).some(u => u.role === 'student');
            if (!hasStudents) {
              room.studentLeftAt = Date.now();
              console.log(`⏰ Room ${roomId}: Last student left. 2hr expiry countdown started.`);
            }
          }

          // Clean up truly empty rooms after 5 minutes
          if (room.users.size === 0) {
            setTimeout(() => {
              if (rooms.has(roomId) && rooms.get(roomId)!.users.size === 0) {
                rooms.delete(roomId);
                console.log(`Room ${roomId} cleaned up (empty)`);
              }
            }, 5 * 60 * 1000);
          }
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  // ─── HTTP API: Room content fallback ───
  // Students can fetch room HTML via plain HTTP if Socket.io delivery fails
  app.use(express.json());
  app.get('/api/room/:roomId/content', (req, res) => {
    const { roomId } = req.params;
    const room = rooms.get(roomId);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    if (!room.lastRunHtml) {
      res.status(204).send(); // No content yet
      return;
    }
    res.json({
      html: room.lastRunHtml,
      activeFileId: room.activeFileId,
      fileName: room.files.find(f => f.id === room.activeFileId)?.name || 'Simulation',
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  🧮 MathsLive server running on http://localhost:${PORT}\n`);
  });
}

startServer();
