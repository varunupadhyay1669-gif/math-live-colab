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
  pendingSyncStudents: Set<string>;
  // Gamification: track XP and streaks per student name (keyed by studentName for persistence across reconnects)
  scores: Record<string, { xp: number; streak: number; bestStreak: number; correct: number; total: number }>;
  // Monotonic interaction sequence for ordering guarantees
  interactionSeq: number;
  // Temporary explanation content (persists so late-joining students see it)
  tempContent: { html: string; name: string } | null;
  liveSnapshotHtml: string | null;
  revision: number;
  whiteboard: {
    objects: any[];
    strokes: any[];
    view: any | null;
  };
  lastTeacherScroll: any | null;
  zoomLevel: number;
}

interface SessionStatePayload {
  type: 'session_state' | 'sync_full_state';
  reason: 'join' | 'reconnect' | 'request_content' | 'run_preview' | 'snapshot_ack' | 'force_sync' | 'restore';
  roomId: string;
  requestId?: string;
  revision: number;
  activeFileId: string | null;
  sourceHtml: string | null;
  liveSnapshotHtml: string | null;
  effectiveHtml: string | null;
  files: FileEntry[];
  isPaused: boolean;
  scrollSyncEnabled: boolean;
  studentInteractionAllowed: boolean;
  currentStep: number;
  gates: Record<number, { question: string; options: string[]; correctIndex: number }>;
  tempContent: { html: string; name: string } | null;
  whiteboard: {
    objects: any[];
    strokes: any[];
    view: any | null;
  };
  lastTeacherScroll: any | null;
  zoomLevel: number;
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
      pendingSyncStudents: new Set(),
      scores: {},
      interactionSeq: 0,
      tempContent: null,
      liveSnapshotHtml: null,
      revision: 0,
      whiteboard: { objects: [], strokes: [], view: null },
      lastTeacherScroll: null,
      zoomLevel: 1,
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
      scores: room.scores,
      revision: room.revision,
      liveSnapshotHtml: room.liveSnapshotHtml,
      whiteboard: room.whiteboard,
      lastTeacherScroll: room.lastTeacherScroll,
      zoomLevel: room.zoomLevel,
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
          room.scores = raw.scores || {};
          room.revision = raw.revision || 0;
          room.liveSnapshotHtml = raw.liveSnapshotHtml || null;
          room.whiteboard = raw.whiteboard || { objects: [], strokes: [], view: null };
          room.lastTeacherScroll = raw.lastTeacherScroll || null;
          room.zoomLevel = raw.zoomLevel || 1;
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

  function isMember(room: RoomData | undefined, socketId: string): room is RoomData {
    return !!room && room.users.has(socketId);
  }

  function requireTeacher(room: RoomData | undefined, socketId: string): room is RoomData {
    return !!room && room.teacherSocketId === socketId && room.users.get(socketId)?.role === 'teacher';
  }

  function bumpRevision(room: RoomData): number {
    room.revision += 1;
    return room.revision;
  }

  function getSourceHtml(room: RoomData): string | null {
    if (room.activeFileId) {
      const file = room.files.find(f => f.id === room.activeFileId);
      if (file?.html) return file.html;
    }
    return room.lastRunHtml;
  }

  function buildSessionState(roomId: string, room: RoomData, type: SessionStatePayload['type'], reason: SessionStatePayload['reason'], requestId?: string): SessionStatePayload {
    const sourceHtml = getSourceHtml(room);
    const effectiveHtml = room.liveSnapshotHtml || room.lastRunHtml || sourceHtml;
    return {
      type,
      reason,
      roomId,
      requestId,
      revision: room.revision,
      activeFileId: room.activeFileId,
      sourceHtml,
      liveSnapshotHtml: room.liveSnapshotHtml,
      effectiveHtml,
      files: room.files,
      isPaused: room.isPaused,
      scrollSyncEnabled: room.scrollSyncEnabled,
      studentInteractionAllowed: room.studentInteractionAllowed,
      currentStep: room.currentStep,
      gates: room.gates,
      tempContent: room.tempContent,
      whiteboard: room.whiteboard,
      lastTeacherScroll: room.lastTeacherScroll,
      zoomLevel: room.zoomLevel,
    };
  }

  function logSync(eventType: string, details: { roomId: string; revision?: number; requestId?: string; role?: string; socketId?: string; reason?: string }) {
    console.log(JSON.stringify({
      scope: 'sync',
      eventType,
      roomId: details.roomId,
      revision: details.revision,
      requestId: details.requestId,
      role: details.role,
      socketId: details.socketId,
      reason: details.reason,
      at: Date.now(),
    }));
  }

  function emitSessionState(socketId: string, roomId: string, room: RoomData, reason: SessionStatePayload['reason'], requestId?: string) {
    const payload = buildSessionState(roomId, room, 'session_state', reason, requestId);
    io.to(socketId).emit('session_state', payload);
    logSync('session_state', { roomId, revision: payload.revision, requestId, socketId, reason });
  }

  function broadcastFullState(roomId: string, room: RoomData, reason: SessionStatePayload['reason'], requestId?: string) {
    const payload = buildSessionState(roomId, room, 'sync_full_state', reason, requestId);
    io.to(roomId).emit('sync_full_state', payload);
    logSync('sync_full_state', { roomId, revision: payload.revision, requestId, reason });
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

      const existingRoom = rooms.get(roomId);
      if (!existingRoom && role !== 'teacher') {
        socket.emit('join_error', { message: 'Room not found. Ask the teacher to start the room first.' });
        return;
      }
      updateRoomActivity(roomId);
      if (!existingRoom) {
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
        room.pendingSyncStudents.add(socket.id);
        // Auto-request the teacher to send their live DOM state to catch up this student
        io.to(room.teacherSocketId).emit('request_html_sync', { requestId: `late-${socket.id}-${Date.now()}` });
      }

      // Send current state to the newly joined user (legacy + canonical)
      const legacyState = {
        files: room.files,
        activeFileId: room.activeFileId,
        lastRunHtml: room.lastRunHtml,
        isPaused: room.isPaused,
        scrollSyncEnabled: room.scrollSyncEnabled,
        studentInteractionAllowed: room.studentInteractionAllowed,
        currentStep: room.currentStep,
        gates: room.gates,
        revision: room.revision,
        users: getRoomUserList(room),
        chat: room.chat.slice(-50), // Last 50 messages
      };
      socket.emit('room_state', legacyState);
      emitSessionState(socket.id, roomId, room, 'join');
      if (role === 'student' && room.lastTeacherScroll) {
        socket.emit('interaction', room.lastTeacherScroll);
      }

      // Immediately push content to the joining student so they don't stay on "Waiting for teacher"
      if (role === 'student' && room.lastRunHtml && room.activeFileId) {
        socket.emit('run_preview', { fileId: room.activeFileId, html: room.lastRunHtml, revision: room.revision });
      }

      // If temp explanation content is active, send it to the joining student
      if (role === 'student' && room.tempContent) {
        socket.emit('temp_content', { html: room.tempContent.html, name: room.tempContent.name });
      }

      // Broadcast updated user list
      io.to(roomId).emit('user_list', getRoomUserList(room));
    });

    // ─── REQUEST CONTENT (student fallback) ───
    // If a student missed the initial HTML delivery, they can request it again
    socket.on('request_content', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      emitSessionState(socket.id, roomId, room, 'request_content');
      if (room.lastRunHtml) {
        socket.emit('run_preview', { fileId: room.activeFileId, html: room.lastRunHtml, revision: room.revision });
      }
      // Also ask teacher for fresh DOM if available
      if (room.teacherSocketId) {
        room.pendingSyncStudents.add(socket.id);
        io.to(room.teacherSocketId).emit('request_html_sync', { requestId: `retry-${socket.id}-${Date.now()}` });
      }
    });

    // ─── SET ROOM PASSWORD ───
    socket.on('set_room_password', ({ roomId, password }: { roomId: string; password: string | null }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.password = password;
      console.log(`🔒 Room ${roomId}: Password ${password ? 'set' : 'removed'}`);
    });

    // ─── FILE MANAGEMENT ───
    socket.on('upload_file', ({ roomId, file }: { roomId: string; file: FileEntry }) => {
      if (!isValidRoomId(roomId)) return;
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) {
        socket.emit('upload_error', { message: 'Room not found' });
        return;
      }
      // Validate file object
      if (!file || typeof file !== 'object') {
        socket.emit('upload_error', { message: 'Invalid file data' });
        return;
      }
      // Validate HTML content exists
      if (!file.html || typeof file.html !== 'string') {
        socket.emit('upload_error', { message: 'File content is missing or invalid' });
        return;
      }
      // Validate non-empty content (after trimming)
      const trimmedHtml = file.html.trim();
      if (trimmedHtml.length === 0) {
        socket.emit('upload_error', { message: 'File is empty' });
        return;
      }
      // Validate file size
      if (file.html.length > MAX_FILE_SIZE) {
        socket.emit('upload_error', { message: `File too large (${(file.html.length / 1024 / 1024).toFixed(1)}MB, max 2MB)` });
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
      room.liveSnapshotHtml = null;
      const revision = bumpRevision(room);
      io.to(roomId).emit('file_uploaded', file);
      io.to(roomId).emit('active_file_changed', { fileId: file.id, fileName: file.name, html: file.html, currentStep: room.currentStep, revision });
      broadcastFullState(roomId, room, 'run_preview');
      // Auto-push HTML to all connected clients immediately
      io.to(roomId).emit('run_preview', { fileId: file.id, html: file.html, revision });
    });

    socket.on('update_file', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
        socket.to(roomId).emit('file_updated', { fileId, html });
      }
    });

    socket.on('delete_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.files = room.files.filter(f => f.id !== fileId);
      if (room.activeFileId === fileId) {
        room.activeFileId = room.files.length > 0 ? room.files[0].id : null;
      }
      io.to(roomId).emit('file_deleted', { fileId, newActiveId: room.activeFileId });
    });

    socket.on('switch_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.activeFileId = fileId;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        room.lastRunHtml = file.html;
        room.liveSnapshotHtml = null;
        const revision = bumpRevision(room);
        // Send file content WITH the active_file_changed so student never reads stale state
        io.to(roomId).emit('active_file_changed', { fileId, fileName: file.name, html: file.html, currentStep: room.currentStep, revision });
        broadcastFullState(roomId, room, 'run_preview');
        io.to(roomId).emit('run_preview', { fileId, html: file.html, revision });
      }
    });

    // ─── RUN / REFRESH PREVIEW ───
    socket.on('run_preview', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      // Update the file content
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
      }
      room.activeFileId = fileId;
      room.lastRunHtml = html;
      room.liveSnapshotHtml = null;
      const revision = bumpRevision(room);
      broadcastFullState(roomId, room, 'run_preview');
      // Send to everyone (including sender for confirmation)
      io.to(roomId).emit('run_preview', { fileId, html, revision });
    });

    socket.on('sync_html_update', ({ roomId, html, requestId }: { roomId: string; html: string; requestId?: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !room.activeFileId) return;
      // Store for future students
      room.lastRunHtml = html;
      room.liveSnapshotHtml = html;
      const file = room.files.find(f => f.id === room.activeFileId);
      if (file) file.html = html;
      const revision = bumpRevision(room);
      // Send to any students waiting for the teacher's live DOM
      // (these students joined after the teacher and need the current content)
      if (room.pendingSyncStudents.size > 0) {
        const pending = Array.from(room.pendingSyncStudents);
        room.pendingSyncStudents.clear();
        for (const studentId of pending) {
          emitSessionState(studentId, roomId, room, 'snapshot_ack', requestId);
          io.to(studentId).emit('run_preview', { fileId: room.activeFileId, html, revision });
        }
        logSync('pending_snapshot_ack', { roomId, revision, requestId, reason: `pending=${pending.length}` });
      }
    });

    socket.on('dom_snapshot', ({ roomId, html, requestId }: { roomId: string; html: string; requestId?: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !room.activeFileId) return;
      room.liveSnapshotHtml = html;
      room.lastRunHtml = html;
      const file = room.files.find(f => f.id === room.activeFileId);
      if (file) file.html = html;
      const revision = bumpRevision(room);
      broadcastFullState(roomId, room, requestId?.startsWith('force-') ? 'force_sync' : 'snapshot_ack', requestId);
      io.to(roomId).emit('dom_snapshot', { fileId: room.activeFileId, html, revision, requestId });
      logSync('snapshot_ack', { roomId, revision, requestId });
    });

    // ─── FORCE SYNC (Server-authoritative) ───
    socket.on('force_sync', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      updateRoomActivity(roomId);

      const requestId = `force-${socket.id}-${Date.now()}`;
      if (room.teacherSocketId) {
        io.to(room.teacherSocketId).emit('request_html_sync', { requestId, reason: 'force_sync' });
        logSync('snapshot_request', { roomId, revision: room.revision, requestId, role: 'teacher', socketId: socket.id, reason: 'force_sync' });
      } else {
        broadcastFullState(roomId, room, 'force_sync', requestId);
      }
    });

    // ─── TEACHER CONTROLS ───
    socket.on('pause_session', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.isPaused = true;
      io.to(roomId).emit('session_paused');
    });

    socket.on('resume_session', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.isPaused = false;
      io.to(roomId).emit('session_resumed');
    });

    // ─── SCROLL SYNC TOGGLE ───
    socket.on('toggle_scroll_sync', ({ roomId, enabled }: { roomId: string; enabled: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.scrollSyncEnabled = enabled;
      const revision = bumpRevision(room);
      io.to(roomId).emit('scroll_sync_changed', { enabled, revision });
      broadcastFullState(roomId, room, 'force_sync');
    });

    // ─── STUDENT INTERACTION TOGGLE ───
    socket.on('toggle_student_interaction', ({ roomId, allowed }: { roomId: string; allowed: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return; // Only teacher
      room.studentInteractionAllowed = allowed;
      const revision = bumpRevision(room);
      io.to(roomId).emit('student_interaction_changed', { allowed, revision });
      broadcastFullState(roomId, room, 'force_sync');
      console.log(`${allowed ? '🖐️' : '👁️'} Room ${roomId}: Student interaction ${allowed ? 'enabled' : 'disabled (view-only)'}`);
    });

    // ─── RESET VIEW (scroll everyone to top) ───
    socket.on('zoom_changed', ({ roomId, zoom }: { roomId: string; zoom: number }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const safeZoom = Math.max(0.5, Math.min(3, Number(zoom) || 1));
      room.zoomLevel = safeZoom;
      const revision = bumpRevision(room);
      io.to(roomId).emit('zoom_changed', { zoom: safeZoom, revision });
    });

    socket.on('reset_view', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      io.to(roomId).emit('reset_view');
    });

    // ─── ATTENTION CHECK ───
    socket.on('attention_check', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      io.to(roomId).emit('attention_check', { timestamp: Date.now() });
    });

    socket.on('attention_ack', ({ roomId, studentName }: { roomId: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!room || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('attention_ack', { studentId: socket.id, studentName, timestamp: Date.now() });
    });

    // ─── REACTIONS ───
    socket.on('send_reaction', ({ roomId, emoji, fromName }: { roomId: string; emoji: string; fromName: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
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
      if (!isMember(room, socket.id)) return;
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
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const safeQuestion = sanitizeString(question, MAX_QUIZ_QUESTION_LENGTH);
      if (!safeQuestion) return;
      io.to(roomId).emit('quiz', { question: safeQuestion, options, senderId: socket.id });
    });

    socket.on('quiz_answer', ({ roomId, answer, studentName }: { roomId: string; answer: string; studentName: string }) => {
      // Send answer to teacher
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id) || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('quiz_answer_received', { answer, studentName, studentId: socket.id });
    });

    // ─── RAISE HAND ───
    socket.on('raise_hand', ({ roomId, studentName }: { roomId: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      io.to(roomId).emit('hand_raised', { studentName, studentId: socket.id });
    });

    // ─── SPOTLIGHT / ANNOTATION ───
    socket.on('spotlight', ({ roomId, x, y, active }: { roomId: string; x: number; y: number; active: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      socket.to(roomId).emit('spotlight', { x, y, active, senderId: socket.id });
    });

    // ─── DRAWING / ANNOTATION ───
    socket.on('draw_stroke', ({ roomId, points, color, width, transient }: any) => {
      socket.to(roomId).emit('draw_stroke', { points, color, width, transient, senderId: socket.id });
    });

    socket.on('draw_clear', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      // Broadcast to the FULL room including sender — the teacher who
      // pressed Clear also needs their own canvas cleared.
      io.to(roomId).emit('draw_clear');
    });

    // ─── WHITEBOARD ───
    socket.on('whiteboard_draw', ({ roomId, stroke }: any) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      room.whiteboard.strokes.push(stroke);
      if (room.whiteboard.strokes.length > 5000) room.whiteboard.strokes = room.whiteboard.strokes.slice(-5000);
      socket.to(roomId).emit('whiteboard_stroke', { stroke, senderId: socket.id });
    });

    socket.on('whiteboard_set_image', ({ roomId, imageUrl }: { roomId: string; imageUrl: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      io.to(roomId).emit('whiteboard_image', { imageUrl });
    });

    socket.on('whiteboard_add_image', ({ roomId, object }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.whiteboard.objects.push(object);
      io.to(roomId).emit('whiteboard_add_image', { object });
    });

    socket.on('whiteboard_update_object', ({ roomId, object }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.whiteboard.objects = room.whiteboard.objects.map(obj => obj.id === object.id ? object : obj);
      socket.to(roomId).emit('whiteboard_update_object', { object });
    });

    socket.on('whiteboard_remove_object', ({ roomId, objectId }: { roomId: string; objectId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.whiteboard.objects = room.whiteboard.objects.filter(obj => obj.id !== objectId);
      io.to(roomId).emit('whiteboard_remove_object', { objectId });
    });

    socket.on('whiteboard_set_view', ({ roomId, view }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.whiteboard.view = view;
      socket.to(roomId).emit('whiteboard_set_view', { view });
    });

    socket.on('whiteboard_clear', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.whiteboard = { objects: [], strokes: [], view: null };
      io.to(roomId).emit('whiteboard_clear');
    });

    socket.on('whiteboard_reset', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.whiteboard.strokes = [];
      io.to(roomId).emit('whiteboard_reset');
    });

    socket.on('whiteboard_delete_stroke', ({ roomId, strokeIndex }: { roomId: string; strokeIndex: number }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (strokeIndex >= 0 && strokeIndex < room.whiteboard.strokes.length) {
        room.whiteboard.strokes.splice(strokeIndex, 1);
      }
      socket.to(roomId).emit('whiteboard_delete_stroke', { strokeIndex });
    });

    socket.on('whiteboard_mode_toggle', ({ roomId, active }: { roomId: string; active: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      // Broadcast whiteboard mode change to all users in room
      io.to(roomId).emit('whiteboard_mode_changed', { active });
    });

    socket.on('whiteboard_scroll', ({ roomId, scrollX, scrollY }: { roomId: string; scrollX: number; scrollY: number }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      socket.to(roomId).emit('whiteboard_scroll', { scrollX, scrollY });
    });

    // ─── TEMPORARY EXPLANATION CONTENT ───
    socket.on('show_temp_content', ({ roomId, html, name }: { roomId: string; html: string; name: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (room) room.tempContent = { html, name };
      // Broadcast temporary explanation content to all users in room
      io.to(roomId).emit('temp_content', { html, name });
    });

    socket.on('clear_temp_content', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (room) room.tempContent = null;
      // Clear temporary content and return to main content
      io.to(roomId).emit('clear_temp_content');
    });

    // ─── LASER POINTER ───
    socket.on('laser_pointer', ({ roomId, x, y, active }: { roomId: string; x: number; y: number; active: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      socket.to(roomId).emit('laser_pointer', { x, y, active });
    });

    // ─── CHALLENGE TIMER ───
    socket.on('start_timer', ({ roomId, seconds }: { roomId: string; seconds: number }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      io.to(roomId).emit('timer_started', { seconds, startedAt: Date.now() });
    });

    socket.on('stop_timer', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      io.to(roomId).emit('timer_stopped');
    });

    // ─── CELEBRATION ───
    socket.on('trigger_celebration', ({ roomId, type }: { roomId: string; type: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      io.to(roomId).emit('celebration', { type });
    });

    // ─── STUDENT QUICK REACTIONS ───
    socket.on('student_reaction', ({ roomId, emoji, label, studentName }: { roomId: string; emoji: string; label: string; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id) || !room.teacherSocketId) return;
      io.to(room.teacherSocketId).emit('student_feedback', { emoji, label, studentName, studentId: socket.id });
    });

    // ─── FOCUS MODE ───
    socket.on('focus_mode', ({ roomId, active, x, y, radius }: { roomId: string; active: boolean; x: number; y: number; radius: number }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      updateRoomActivity(roomId);
      socket.to(roomId).emit('focus_mode', { active, x, y, radius });
    });

    // ─── INTERACTION SYNC ───
    socket.on('interaction', ({ roomId, event }: { roomId: string; event: any }) => {
      if (!checkRateLimit(socket.id)) return; // Rate limited
      updateRoomActivity(roomId);
      event.userId = socket.id;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;

      const user = room.users.get(socket.id);
      if (user) event.userName = user.name;
      event.role = user?.role || 'unknown';
      room.interactionSeq += 1;
      event.serverSeq = room.interactionSeq;
      event.serverTs = Date.now();

      if (user?.role === 'teacher') {
        if (event.type === 'SYNC_SCROLL') {
          room.lastTeacherScroll = event;
        }
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
      if (!isMember(room, socket.id) || !room.teacherSocketId) return;
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
      if (!requireTeacher(room, socket.id)) return;
      const safeStep = Math.max(1, Math.floor(Number(step) || 1));
      room.currentStep = safeStep;
      const revision = bumpRevision(room);
      io.to(roomId).emit('step_changed', { step: safeStep, revision });
      broadcastFullState(roomId, room, 'force_sync');
    });

    socket.on('add_gate', ({ roomId, step, question, options, correctIndex }: { roomId: string; step: number; question: string; options: string[]; correctIndex: number }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.gates[step] = { question, options, correctIndex };
      const revision = bumpRevision(room);
      io.to(roomId).emit('gate_added', { step, revision });
      broadcastFullState(roomId, room, 'force_sync');
    });

    socket.on('gate_answer', ({ roomId, step, answerIndex, studentName }: { roomId: string; step: number; answerIndex: number; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const gate = room.gates[step];
      if (!gate) { socket.emit('gate_result', { correct: false }); return; }
      const isCorrect = gate.correctIndex === answerIndex;

      // ── Gamification: update XP & streaks ──
      const name = (studentName || 'Student').trim().slice(0, 40);
      if (!room.scores[name]) {
        room.scores[name] = { xp: 0, streak: 0, bestStreak: 0, correct: 0, total: 0 };
      }
      const s = room.scores[name];
      s.total += 1;
      let xpGained = 0;
      let levelUp = false;
      if (isCorrect) {
        s.streak += 1;
        s.correct += 1;
        // Base 10 XP + streak bonus (capped)
        xpGained = 10 + Math.min(s.streak - 1, 10) * 2;
        const oldLevel = Math.floor(s.xp / 100);
        s.xp += xpGained;
        const newLevel = Math.floor(s.xp / 100);
        levelUp = newLevel > oldLevel;
        if (s.streak > s.bestStreak) s.bestStreak = s.streak;
      } else {
        s.streak = 0;
      }

      socket.emit('gate_result', {
        correct: isCorrect,
        xpGained,
        xp: s.xp,
        streak: s.streak,
        level: Math.floor(s.xp / 100) + 1,
        levelUp,
      });
      if (room.teacherSocketId) {
        io.to(room.teacherSocketId).emit('gate_answered', {
          studentName: name, step, correct: isCorrect, xpGained, streak: s.streak, xp: s.xp,
        });
      }
      // Broadcast leaderboard to everyone in room
      const leaderboard = Object.entries(room.scores)
        .map(([n, sc]) => ({ studentName: n, xp: sc.xp, streak: sc.streak, bestStreak: sc.bestStreak, correct: sc.correct, total: sc.total }))
        .sort((a, b) => b.xp - a.xp)
        .slice(0, 20);
      io.to(roomId).emit('leaderboard_update', leaderboard);
    });

    // ─── HARD RESET (teacher only) ───
    // Resets session progress but PRESERVES uploaded content (files, activeFile,
    // lastRunHtml) so teachers don't lose their lesson material. The effect is
    // "start from the beginning": chat cleared, steps reset, gates/scores cleared,
    // scroll to top, unpaused.
    socket.on('hard_reset', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return; // Only teacher
      room.chat = [];
      room.currentStep = 1;
      room.gates = {};
      room.isPaused = false;
      room.scores = {};
      updateRoomActivity(roomId);
      io.to(roomId).emit('room_reset', {
        // Include preserved content so clients can restore it after clearing local state
        activeFileId: room.activeFileId,
        files: room.files,
        lastRunHtml: room.lastRunHtml,
      });
      io.to(roomId).emit('leaderboard_update', []);
      // Also scroll everyone to top for a clean start
      io.to(roomId).emit('reset_view');
      console.log(`🔄 Room ${roomId}: Session reset by teacher (content preserved)`);
    });

    // ─── KICK USER ───
    socket.on('kick_user', ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return; // Only teacher can kick
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
    if (!isValidRoomId(roomId)) {
      res.status(400).json({ error: 'Invalid room code' });
      return;
    }
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
      revision: room.revision,
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
