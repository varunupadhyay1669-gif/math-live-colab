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
  users: Map<string, { name: string; role: 'teacher' | 'student'; joinedAt: number; whiteboardSync: boolean }>;
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
    shapes: any[];
    view: any | null;
    gridMode?: 'blank' | 'grid' | 'graph';
    instruments?: any[];
    texts?: any[];
  };
  // AUTONOMOUS: HTML-overlay annotations (the pen strokes that go on
  // top of the iframe lesson, not the whiteboard's own strokes).
  // Previously these were fire-and-forget — broadcast on draw_stroke
  // but never stored — so a student who joined late saw zero of the
  // teacher's earlier annotations. Now persisted server-side just
  // like whiteboard.strokes, replayed on join via session_state.
  // Each entry carries senderId so a per-stroke eraser can scope to
  // "only delete strokes I drew" for students (teachers can delete
  // any). Capped at 2000 strokes per room to bound memory.
  annotations: Array<{ senderId: string; stroke: any }>;
  // Is the teacher currently showing the whiteboard (vs an HTML simulation)?
  // Persisted server-side so a late-joining student can land on the right
  // surface — without this, students who joined while the teacher was on
  // the whiteboard saw the "Waiting for teacher" placeholder forever
  // because the room had no lastRunHtml to deliver.
  whiteboardMode: boolean;
  // AUTONOMOUS: Grace-period state when teacher's socket disconnects.
  // Holds a setTimeout handle; if the same-name teacher reconnects
  // before the timer fires, the seat is restored transparently and no
  // teacher_disconnected announcement is made.
  pendingTeacherDisconnect?: {
    socketId: string;
    expectedName: string | undefined;
    timer: ReturnType<typeof setTimeout>;
  };
  // AUTONOMOUS: Miro-style "save to my boards" model.
  //   claimed = false → 24h auto-expiry from createdAt (anonymous board)
  //   claimed = true  → 30d expiry (much longer; effectively "saved")
  // The full forever-persistence promise needs Postgres + auth (Phases
  // 2-3); this gives the right UX today on a constrained backend.
  claimed: boolean;
  // Display name of the person who claimed it (the teacher's name at
  // claim time). Used to populate the "saved by" hint in the UI. Not
  // used for auth — anyone with the room id can still join. The proper
  // ownership model arrives with auth.
  claimedBy?: string | null;
  claimedAt?: number | null;
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
    shapes: any[];
    view: any | null;
    gridMode?: 'blank' | 'grid' | 'graph';
    instruments?: any[];
    texts?: any[];
  };
  // Persisted HTML-overlay annotation strokes. Each entry is
  // `{ senderId, stroke }` server-side; clients only need to read the
  // stroke part for rendering.
  annotations: Array<{ senderId: string; stroke: any }>;
  whiteboardMode: boolean;
  // AUTONOMOUS: claim status surfaced to clients so the UI can render
  // the "X hours left to save" countdown banner (anonymous) or hide it
  // (claimed). expiresAt is server-authoritative — clients display it
  // but never compute it themselves.
  claimed: boolean;
  claimedBy: string | null;
  expiresAt: number;
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
    // AUTONOMOUS: Survive backgrounded tabs.
    // Browsers heavily throttle setInterval/setTimeout (and therefore
    // Socket.IO's heartbeats) on tabs that aren't focused. With Socket.IO's
    // default pingTimeout=20s + pingInterval=25s, a teacher who alt-tabs
    // away for 45 seconds gets disconnected — server then declares
    // "teacher left", clears room.teacherSocketId, and any student who
    // joins during that window sees "Waiting for teacher" forever.
    // Bumping the timeout to 60s + interval to 25s gives a generous
    // buffer for Chrome's 1-minute background-throttle pulse before we
    // give up on the client.
    pingTimeout: 60_000,
    pingInterval: 25_000,
  });

  const rooms = new Map<string, RoomData>();

  // ─── MEMORY MANAGEMENT ───
  // Sweep every 10 minutes:
  //  - Rooms past their claim-aware TTL (24h anonymous OR 30d claimed)
  //  - Rooms where last student left > 2 hours ago AND no students currently connected
  setInterval(() => {
    const now = Date.now();
    const studentLeftExpiryMs = 2 * 60 * 60 * 1000; // 2 hours after last student leaves
    let deletedCount = 0;

    for (const [roomId, room] of rooms.entries()) {
      // AUTONOMOUS: Claim-aware expiry. Anonymous rooms die at
      // createdAt+24h; claimed rooms get 30 days. Mirrors Miro.
      const expiresAt = computeExpiresAt(room);
      if (now > expiresAt) {
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
  const RATE_LIMIT_SOFT = 200;  // soft cap/sec for loss-tolerant events (cursor/scroll/drag-move)
  const RATE_LIMIT_HARD = 400;  // hard cap/sec — past this even critical events drop (abuse guard)
  const RATE_LIMIT_WINDOW = 1000; // 1 second window

  // Loss-tolerant high-frequency events (cursor, scroll, drag-move) are
  // rejected at the soft cap so a flood can never starve sync-critical
  // discrete events — clicks, inputs, key presses — which pass up to the hard
  // cap. This keeps teacher↔student state aligned under load: a fast-moving
  // cursor or drag must not be allowed to drop the click that actually mutates
  // the simulation. Under normal load (well under 200/s) everything passes,
  // preserving the original behaviour.
  function checkRateLimit(socketId: string, lossTolerant: boolean = false): boolean {
    const now = Date.now();
    let entry = rateLimits.get(socketId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
      rateLimits.set(socketId, entry);
    }
    entry.count++;
    if (entry.count <= RATE_LIMIT_SOFT) return true;
    if (!lossTolerant && entry.count <= RATE_LIMIT_HARD) return true;
    return false;
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
      whiteboard: { objects: [], strokes: [], shapes: [], view: null, gridMode: 'grid', instruments: [], texts: [] },
      annotations: [],
      whiteboardMode: false,
      // AUTONOMOUS: anonymous by default. Becomes true the moment any
      // user clicks "Save to my boards" — the room then gets a 30-day
      // window instead of 24h.
      claimed: false,
      claimedBy: null,
      claimedAt: null,
      lastTeacherScroll: null,
      zoomLevel: 1,
    };
  }

  // AUTONOMOUS: Compute when this room expires.
  //   anonymous → createdAt + 24h (Miro's "save your board" framing)
  //   claimed   → claimedAt + 30 days (effectively "saved" until Postgres
  //               + auth let us promise true forever-persistence)
  // The lastActivityAt-based 48h hard cap from earlier remains as a
  // safety net for genuinely-abandoned rooms; whichever expires sooner
  // wins. Returns ms-since-epoch.
  const ANON_TTL_MS = 24 * 60 * 60 * 1000;
  const CLAIMED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  function computeExpiresAt(room: RoomData): number {
    if (room.claimed && room.claimedAt) {
      return room.claimedAt + CLAIMED_TTL_MS;
    }
    return room.createdAt + ANON_TTL_MS;
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
      annotations: room.annotations,
      whiteboardMode: room.whiteboardMode,
      claimed: !!room.claimed,
      claimedBy: room.claimedBy ?? null,
      claimedAt: room.claimedAt ?? null,
      lastTeacherScroll: room.lastTeacherScroll,
      zoomLevel: room.zoomLevel,
    };
  }

  // AUTONOMOUS: [ORDER-1 CRITICAL] - saveRooms used to call fs.writeFileSync
  // for every room. With 50 large rooms during a SIGTERM redeploy that
  // serialized 50 blocking writes (~100MB+) on the event loop, freezing
  // every other socket handler — including the disconnect handlers that
  // also call saveRooms. Now writes happen in parallel via fs.promises and
  // never block the loop.
  // Also: a single failing write no longer aborts the whole batch — each
  // file is independently caught and logged.
  // Concurrency guard: if a save is already in flight, skip the new one
  // instead of stacking saves. This avoids fs contention during a burst of
  // disconnects on shutdown.
  let saveInFlight = false;
  async function saveRooms() {
    if (saveInFlight) return;
    saveInFlight = true;
    try {
      const writes: Promise<void>[] = [];
      let attempted = 0;
      for (const [roomId, room] of rooms.entries()) {
        // Skip rooms with literally nothing in them. Whiteboard-only rooms
        // (no files, no lastRunHtml, but with strokes / objects / shapes)
        // SHOULD persist — otherwise a teacher who teaches purely on the
        // whiteboard loses their work on every redeploy.
        const hasContent =
          room.files.length > 0 ||
          !!room.lastRunHtml ||
          !!room.tempContent ||
          (room.chat?.length ?? 0) > 0 ||
          (room.whiteboard?.objects?.length ?? 0) > 0 ||
          (room.whiteboard?.strokes?.length ?? 0) > 0 ||
          (room.whiteboard?.shapes?.length ?? 0) > 0 ||
          (room.whiteboard?.texts?.length ?? 0) > 0;
        if (!hasContent) continue;
        attempted++;
        const data = JSON.stringify(serializeRoom(roomId, room));
        writes.push(
          fs.promises.writeFile(path.join(PERSIST_DIR, `${roomId}.json`), data, 'utf-8')
            .catch(err => {
              console.error(`Failed to persist room ${roomId}:`, err);
            })
        );
      }
      await Promise.all(writes);
      if (attempted > 0) console.log(`💾 Persisted ${attempted} rooms (parallel, non-blocking)`);
    } finally {
      saveInFlight = false;
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
          room.whiteboard = raw.whiteboard
            ? {
                objects: raw.whiteboard.objects || [],
                strokes: raw.whiteboard.strokes || [],
                shapes: raw.whiteboard.shapes || [],
                view: raw.whiteboard.view ?? null,
                // gridMode and instruments were added later — restore them too
                // so a server restart doesn't silently reset the teacher's
                // graph-mode choice or wipe rulers/protractors off the board.
                gridMode: raw.whiteboard.gridMode || 'grid',
                instruments: raw.whiteboard.instruments || [],
                texts: raw.whiteboard.texts || [],
              }
            : { objects: [], strokes: [], shapes: [], view: null };
          // AUTONOMOUS: Restore HTML-overlay annotations on server restart
          // too. Defensively coerce to array — old persisted rooms (before
          // this field existed) will be `undefined` and would crash the
          // first draw_stroke push without this guard.
          room.annotations = Array.isArray(raw.annotations)
            ? raw.annotations.filter((s: any) => s && typeof s === 'object' && s.senderId && s.stroke)
            : [];
          // Whiteboard mode (teacher on whiteboard surface vs HTML) — persist
          // so a server restart leaves the teacher and any rejoining student
          // on the same surface they were on before.
          room.whiteboardMode = !!raw.whiteboardMode;
          // AUTONOMOUS: Restore claim status. Anonymous rooms older
          // than 24h would have been swept but were missed if the
          // server was down — the next sweep will catch them.
          room.claimed = !!raw.claimed;
          room.claimedBy = raw.claimedBy ?? null;
          room.claimedAt = raw.claimedAt ?? null;
          room.lastTeacherScroll = raw.lastTeacherScroll || null;
          room.zoomLevel = raw.zoomLevel || 1;
          rooms.set(raw.roomId, room);
          restored++;
        } catch (err) {
          // AUTONOMOUS: [ORDER-1 CRITICAL] - was silently fs.unlinkSync.
          // A corrupt parse used to delete the file with no log, no
          // recovery path. Now: log the error AND move to a .corrupt
          // suffix so a human can inspect / recover. Bad bytes shouldn't
          // erase a teacher's lesson.
          console.error(`Failed to restore ${file}:`, err);
          try {
            const corruptPath = filePath + '.corrupt';
            fs.renameSync(filePath, corruptPath);
            console.error(`  → moved to ${corruptPath} for recovery`);
          } catch (renameErr) {
            console.error('  → also failed to quarantine:', renameErr);
          }
          cleaned++;
        }
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

  // Save on process exit. Now that saveRooms() is async, the previous
  // fire-and-forget pattern lost the in-flight writes when process.exit()
  // ran before they finished. Await — but with a deadline so we don't hang
  // forever if a write is wedged.
  // AUTONOMOUS: [ORDER-1 CRITICAL] - prevents data loss on redeploy.
  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, persisting rooms before exit…`);
    const deadline = new Promise<void>(resolve => setTimeout(resolve, 4000));
    Promise.race([saveRooms(), deadline]).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

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

  // AUTONOMOUS: [ORDER-2 ESSENTIAL] - For collab actions where students get
  // write access when the teacher has explicitly enabled interactive mode.
  // Currently used for whiteboard image upload/move/delete so a student can
  // paste a question photo onto the shared canvas. The teacher controls the
  // gate via the studentInteractionAllowed toggle.
  function requireTeacherOrInteractive(room: RoomData | undefined, socketId: string): room is RoomData {
    if (!room || !room.users.has(socketId)) return false;
    if (room.teacherSocketId === socketId) return true;
    return !!room.studentInteractionAllowed;
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
      // AUTONOMOUS: HTML-overlay annotations replayed on join so a
      // late-joining student sees the same markup the teacher's been
      // building up over the class so far.
      annotations: room.annotations,
      whiteboardMode: room.whiteboardMode,
      // AUTONOMOUS: Claim status + expiry surfaced for the countdown banner.
      claimed: !!room.claimed,
      claimedBy: room.claimedBy ?? null,
      expiresAt: computeExpiresAt(room),
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

    // AUTONOMOUS: [ORDER-3 FRICTION] - ping/pong for the client-side
    // latency indicator. Client emits `ping` with a timestamp; we echo it
    // back as `pong` and the client measures RTT. Stateless, cheap (only
    // emitted when the user has the room open), and no impact on
    // existing flows because nothing else listens for these events.
    socket.on('ping', (data: { ts: number }) => {
      socket.emit('pong', { ts: data?.ts ?? Date.now() });
    });

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

      // ── Teacher-takeover gate ──
      // If someone else is already the teacher (alive socket connected), reject
      // a duplicate teacher claim — only the original teacher (matched by name)
      // can reclaim the seat after a disconnect. Without this gate, any user
      // who knows the room id could claim role:'teacher' and become
      // authoritative over the whole room (sync-hijack vector).
      if (role === 'teacher' && room.teacherSocketId) {
        const sittingTeacher = room.users.get(room.teacherSocketId);
        if (sittingTeacher && sittingTeacher.name !== safeName) {
          socket.emit('join_error', { message: 'Another teacher is already in this room.' });
          return;
        }
      }

      // AUTONOMOUS: [ORDER-1 CRITICAL] - Dedupe same-name student sockets.
      //
      // Real-world bug: a student opens the room on a tab, sync works, then
      // they switch to another tab (or rejoin via a copy of the link). The
      // new tab gets a fresh socket and `join_room` runs — but the OLD
      // socket is still half-alive (browser hasn't dropped it, Socket.IO
      // hasn't yet hit pingTimeout). The room now contains TWO student
      // entries for the same person.
      //
      // Symptoms the teacher sees: the student's typing stops appearing.
      // Cause: events from BOTH sockets get serverSeq-stamped and
      // broadcast, but the teacher's UI keys cursors by socket.id, the
      // user_list shows two students under one name, and worse, the
      // old socket's lingering events confuse client-side state machines
      // that expect a single identity.
      //
      // Fix: when a student with the same name is already a member,
      // disconnect the old socket BEFORE adding the new one. The new
      // tab becomes the authoritative socket and the teacher's sync
      // continues uninterrupted.
      if (role === 'student') {
        for (const [otherId, otherUser] of room.users.entries()) {
          if (otherId === socket.id) continue;
          if (otherUser.role === 'student' && otherUser.name === safeName) {
            console.log(`👤 Same-name student "${safeName}" rejoined; disconnecting stale socket ${otherId}`);
            // Drop from our records FIRST so the disconnecting handler
            // doesn't double-emit user_left.
            room.users.delete(otherId);
            room.pendingSyncStudents.delete(otherId);
            const stale = io.sockets.sockets.get(otherId);
            if (stale) {
              // Notify the old tab so it can gracefully tear down rather
              // than ghost-emit events for another 60s until pingTimeout.
              stale.emit('session_taken_over', { reason: 'Same name joined from another tab' });
              stale.disconnect(true);
            }
          }
        }
      }

      socket.join(roomId);
      room.users.set(socket.id, { name: safeName, role, joinedAt: Date.now(), whiteboardSync: true });

      // If a student just joined, clear the studentLeftAt timer
      if (role === 'student') {
        room.studentLeftAt = null;
      }

      if (role === 'teacher') {
        const previousTeacherSocketId = room.teacherSocketId;

        // AUTONOMOUS: Cancel any pending teacher-disconnect timer if
        // this is the same teacher rejoining (after a tab switch).
        // The grace timer scheduled in the disconnecting handler would
        // have fired teacher_disconnected to all students otherwise.
        const wasPendingDisconnect =
          !!room.pendingTeacherDisconnect &&
          room.pendingTeacherDisconnect.expectedName === safeName;
        if (wasPendingDisconnect && room.pendingTeacherDisconnect) {
          clearTimeout(room.pendingTeacherDisconnect.timer);
          room.pendingTeacherDisconnect = undefined;
          console.log(`✅ Teacher ${safeName} returned within grace period — seat restored, no disconnect announced`);
        }

        // AUTONOMOUS: Tell the previous teacher socket (if it's still
        // alive — same name, different tab) that it's been deposed.
        // Without this notification, the old window had every
        // teacher-only emit silently fail the requireTeacher check on
        // the server.
        room.teacherSocketId = socket.id;
        if (previousTeacherSocketId && previousTeacherSocketId !== socket.id) {
          io.to(previousTeacherSocketId).emit('teacher_replaced', { takenOverBySocketId: socket.id });
        }

        // AUTONOMOUS: On teacher reconnect (any kind — fresh tab, grace
        // recovery, page refresh) push the current HTML state to every
        // student in the room. Students who joined while the teacher was
        // gone may have seen "Waiting for teacher" placeholder; this is
        // their unblock. Idempotent on the client (setCurrentHtml is
        // value-equality-checked, won't rebuild iframe needlessly).
        if (room.lastRunHtml && room.activeFileId) {
          io.to(roomId).emit('run_preview', {
            fileId: room.activeFileId,
            html: room.lastRunHtml,
            revision: room.revision,
          });
          console.log(`📺 Re-broadcast HTML on teacher reconnect: room=${roomId} fileId=${room.activeFileId}`);
        }

        // Reconnecting teacher: re-request a fresh DOM snapshot for any
        // student who was waiting for one when the previous socket dropped.
        if (room.pendingSyncStudents.size > 0) {
          io.to(socket.id).emit('request_html_sync', { requestId: `reconnect-${Date.now()}`, reason: 'teacher_reconnect' });
        }
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

      // AUTONOMOUS: Immediately push content to the joining student so
      // they don't stay on "Waiting for teacher".
      //
      // Previously this required BOTH lastRunHtml AND activeFileId. If
      // the room was restored from disk after a server restart and
      // activeFileId got dropped (or if the teacher had never explicitly
      // hit Run, only uploaded), the student would see the placeholder
      // forever.
      //
      // Now: emit if we have ANY usable HTML — last-run, live snapshot,
      // OR the source HTML of any file. The fallback chain mirrors the
      // session_state's effectiveHtml computation. fileId can be null
      // (the client tolerates it).
      if (role === 'student') {
        const fallbackFile = room.activeFileId ? null : (room.files[0] || null);
        const fileId = room.activeFileId || fallbackFile?.id || null;
        const html =
          room.lastRunHtml ||
          room.liveSnapshotHtml ||
          (fallbackFile ? fallbackFile.html : null) ||
          (room.activeFileId ? room.files.find(f => f.id === room.activeFileId)?.html : null) ||
          null;
        if (html) {
          socket.emit('run_preview', { fileId, html, revision: room.revision });
        }
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
      // Uploading a new HTML file is an unambiguous "show this to the
      // student" intent. If the teacher was on the whiteboard surface,
      // exit whiteboard mode so the broadcast iframe actually surfaces
      // for students (otherwise the student render branch falls through
      // to the whiteboard and the new HTML is invisible to them).
      const wasWhiteboardMode = room.whiteboardMode;
      if (wasWhiteboardMode) room.whiteboardMode = false;
      const revision = bumpRevision(room);
      io.to(roomId).emit('file_uploaded', file);
      io.to(roomId).emit('active_file_changed', { fileId: file.id, fileName: file.name, html: file.html, currentStep: room.currentStep, revision });
      if (wasWhiteboardMode) {
        io.to(roomId).emit('whiteboard_mode_changed', { active: false });
      }
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
      // AUTONOMOUS: dropped the `!room.activeFileId` guard. Previously we
      // rejected any DOM snapshot if no file was active server-side. But
      // after a Render redeploy wipes .rooms/, the server has no
      // activeFileId — and the teacher's iframe is still loaded with
      // content. Rejecting the snapshot left students stuck on "Waiting
      // for teacher." Now: accept the HTML; if the room has no active
      // file yet, the html still lands in liveSnapshotHtml so a student
      // join's HTML-delivery fallback can use it.
      if (!requireTeacher(room, socket.id)) return;
      // Same reasoning as in dom_snapshot above: a passive snapshot ack does
      // NOT rewrite lastRunHtml or the persisted file source — only the live
      // snapshot. Otherwise every late-joiner silently corrupts the teacher's
      // uploaded HTML by overwriting it with whatever DOM state happened to
      // be in the iframe at the moment they joined.
      room.liveSnapshotHtml = html;
      const revision = bumpRevision(room);
      // Send to any students waiting for the teacher's live DOM
      // (these students joined after the teacher and need the current content).
      // We snapshot the pending set FIRST (delivery loop is async), then
      // delete each student id only after delivering to them. Any student
      // who joined the room (and was added to pendingSyncStudents) AFTER we
      // started this loop stays in the set and will be picked up by the
      // next snapshot — they're not silently dropped by a blanket .clear().
      if (room.pendingSyncStudents.size > 0) {
        const pending = Array.from(room.pendingSyncStudents);
        for (const studentId of pending) {
          room.pendingSyncStudents.delete(studentId);
          emitSessionState(studentId, roomId, room, 'snapshot_ack', requestId);
          io.to(studentId).emit('run_preview', { fileId: room.activeFileId, html, revision });
        }
        logSync('pending_snapshot_ack', { roomId, revision, requestId, reason: `pending=${pending.length}` });
      }
    });

    socket.on('dom_snapshot', ({ roomId, html, requestId }: { roomId: string; html: string; requestId?: string }) => {
      const room = rooms.get(roomId);
      // AUTONOMOUS: dropped the `!room.activeFileId` guard, same reasoning
      // as sync_html_update above. Post-redeploy the teacher's iframe is
      // still loaded but server has no activeFileId; we want the snapshot
      // to land so pending students get unblocked.
      if (!requireTeacher(room, socket.id)) return;
      const isForceSync = requestId?.startsWith('force-');
      // ── Don't corrupt the source HTML on every late-join ack ──
      // `liveSnapshotHtml` is the "current DOM right now" and is meant to
      // change every snapshot. `lastRunHtml` is the last HTML the teacher
      // actually ran (the file's pristine starting point); `file.html` is
      // the saved source. Overwriting those on every late-join silently
      // drifted the teacher's uploaded file away from what they uploaded —
      // after a few lessons the "original" file was actually some random
      // mid-state snapshot. Only force-sync (an explicit teacher request to
      // re-baseline everyone) should rewrite the run/source.
      room.liveSnapshotHtml = html;
      if (isForceSync) {
        room.lastRunHtml = html;
        const file = room.files.find(f => f.id === room.activeFileId);
        if (file) file.html = html;
      }
      const revision = bumpRevision(room);

      if (isForceSync) {
        // Genuine force-sync: every client should re-render to match the snapshot.
        broadcastFullState(roomId, room, 'force_sync', requestId);
        io.to(roomId).emit('dom_snapshot', { fileId: room.activeFileId, html, revision, requestId });
      } else {
        // Snapshot-ack triggered by a join/retry: only the late-joining students
        // need this fresh HTML. Existing students already have a coherent state
        // from their own SYNC_* event stream — broadcasting the snapshot to them
        // would force a needless iframe reload (the auto-refresh-during-use bug).
        // Same reasoning as the sync_html_update handler above: snapshot the
        // pending set, deliver one-by-one and remove only those we delivered
        // to. Newly-arriving pending students don't get blanket-cleared.
        if (room.pendingSyncStudents.size > 0) {
          const pending = Array.from(room.pendingSyncStudents);
          for (const studentId of pending) {
            room.pendingSyncStudents.delete(studentId);
            emitSessionState(studentId, roomId, room, 'snapshot_ack', requestId);
            io.to(studentId).emit('run_preview', { fileId: room.activeFileId, html, revision });
            io.to(studentId).emit('dom_snapshot', { fileId: room.activeFileId, html, revision, requestId });
          }
        }
      }
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
      // No broadcastFullState — clients update from `scroll_sync_changed` alone.
      // Sending full state here would re-emit the latest iframe HTML snapshot,
      // forcing a student iframe reload on every settings toggle.
    });

    // ─── STUDENT INTERACTION TOGGLE ───
    socket.on('toggle_student_interaction', ({ roomId, allowed }: { roomId: string; allowed: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return; // Only teacher
      room.studentInteractionAllowed = allowed;
      const revision = bumpRevision(room);
      io.to(roomId).emit('student_interaction_changed', { allowed, revision });
      // No broadcastFullState — see comment in toggle_scroll_sync above.
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

    // ─── DRAWING / ANNOTATION (overlay over the iframe simulation) ───
    // The payload flows through unchanged so future fields (id, tool
    // variants, shape kinds) reach the other clients automatically.
    //
    // AUTONOMOUS: Annotations are now PERSISTED in room.annotations.
    // Previously they were fire-and-forget, which meant a student who
    // joined 5 minutes into a class saw zero of the teacher's earlier
    // markup. Persisting them lets session_state replay the full
    // overlay on join. Transient strokes (the fading laser-pointer
    // trail) are NOT persisted — by definition they disappear, and
    // replaying them on join would be visual noise from a long-ago
    // moment.
    const MAX_ANNOTATIONS = 2000;
    socket.on('draw_stroke', ({ roomId, ...rest }: any) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      if (!rest || !Array.isArray(rest.points) || rest.points.length === 0) return;
      // Validate every point — one bad coord would corrupt the persisted state
      for (const p of rest.points) {
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' ||
            !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      }
      // Persist non-transient strokes only.
      if (!rest.transient) {
        room!.annotations.push({ senderId: socket.id, stroke: { ...rest } });
        // Bound memory — drop the oldest if we overflow.
        if (room!.annotations.length > MAX_ANNOTATIONS) {
          room!.annotations = room!.annotations.slice(-MAX_ANNOTATIONS);
        }
      }
      socket.to(roomId).emit('draw_stroke', { ...rest, senderId: socket.id });
    });

    // Delete a single annotation stroke by id (used by the per-stroke
    // eraser; pixel-eraser strokes are drawn with destination-out and use
    // the regular draw_stroke path).
    //
    // AUTONOMOUS: Scope the delete. Teachers can erase anything.
    // Students can only erase strokes THEY drew — otherwise a curious
    // student could click and delete the teacher's diagram out from
    // under them. The senderId on each persisted entry is the
    // authoritative check; falling through to broadcast also requires
    // the stroke actually exists in our persisted list (so a malicious
    // client can't make up an id).
    socket.on('draw_delete_stroke', ({ roomId, strokeId }: { roomId: string; strokeId: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      if (typeof strokeId !== 'string') return;
      const isTeacher = room!.teacherSocketId === socket.id;
      const idx = room!.annotations.findIndex(a => a.stroke?.id === strokeId);
      if (idx >= 0) {
        const entry = room!.annotations[idx];
        if (!isTeacher && entry.senderId !== socket.id) {
          // Student trying to erase the teacher's (or another student's)
          // stroke — reject silently. The client's optimistic erase will
          // self-correct on the next session_state.
          return;
        }
        room!.annotations.splice(idx, 1);
      } else if (!isTeacher) {
        // Stroke not in our persisted list and the caller isn't the
        // teacher — could be a stale id from a prior reset. Don't broadcast
        // a delete the server can't authoritatively confirm.
        return;
      }
      socket.to(roomId).emit('draw_delete_stroke', { strokeId });
    });

    socket.on('draw_clear', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room!.annotations = [];
      // Broadcast to the FULL room including sender — the teacher who
      // pressed Clear also needs their own canvas cleared.
      io.to(roomId).emit('draw_clear');
    });

    // ─── WHITEBOARD ───
    // Per-stroke caps. A typical pen stroke is ~50-200 points — anything an
    // order of magnitude larger is either a buggy client or an attack. Anyone
    // can draw (this is a shared canvas), but the payload must be sane.
    const MAX_STROKE_POINTS = 5000;
    socket.on('whiteboard_draw', ({ roomId, stroke }: any) => {
      const room = rooms.get(roomId);
      // AUTONOMOUS: gate on requireTeacherOrInteractive (matches the
      // image / shape / instrument permission model). Previously any
      // room member could emit whiteboard_draw — legitimate UI gates
      // students at canEdit=interactive, but a curious student in
      // DevTools could bypass that and scribble even in view-only
      // mode.
      if (!requireTeacherOrInteractive(room, socket.id)) return;
      // Validate stroke shape — reject anything malformed instead of writing it
      // to canonical state and persisting the corruption to disk.
      if (!stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) return;
      if (stroke.points.length > MAX_STROKE_POINTS) {
        // Truncate rather than reject — a long but legitimate stroke (eg a
        // student drawing a long underline) shouldn't fail silently.
        stroke.points = stroke.points.slice(0, MAX_STROKE_POINTS);
      }
      // Numeric sanity: every point must have finite x/y. One bad point would
      // make the entire stroke unrenderable everywhere.
      for (const p of stroke.points) {
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' ||
            !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      }
      room.whiteboard.strokes.push(stroke);
      if (room.whiteboard.strokes.length > 5000) room.whiteboard.strokes = room.whiteboard.strokes.slice(-5000);
      socket.to(roomId).emit('whiteboard_stroke', { stroke, senderId: socket.id });
    });

    socket.on('whiteboard_set_image', ({ roomId, imageUrl }: { roomId: string; imageUrl: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      io.to(roomId).emit('whiteboard_image', { imageUrl });
    });

    // AUTONOMOUS: [ORDER-1 CRITICAL] - Server-side image size cap. The
    // client downscales before send, but a malicious or modified client
    // could push an arbitrary base64 blob and we'd persist + broadcast it.
    // Cap each image's serialized size at 6MB (some headroom over the
    // client's 4MB byte cap because base64 inflates by ~33%).
    const MAX_IMAGE_OBJECT_BYTES = 6 * 1024 * 1024;
    // AUTONOMOUS: [ORDER-2 ESSENTIAL] - Image add/move/remove now allows
    // students when the teacher has flipped the studentInteractionAllowed
    // toggle on. Lets a student paste a question photo onto the shared
    // whiteboard, drag it where it belongs, and remove it later. The 6MB
    // size cap above is the abuse mitigation; it applies equally to anyone
    // who can mutate.
    socket.on('whiteboard_add_image', ({ roomId, object }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacherOrInteractive(room, socket.id)) return;
      if (!object || typeof object.id !== 'string' || typeof object.src !== 'string') return;
      // Quick byte cap on the data URL. JSON.stringify cost would be
      // dominated by .src for any reasonable image object.
      if (object.src.length > MAX_IMAGE_OBJECT_BYTES) {
        console.warn(`Rejected oversize whiteboard image from ${socket.id}: ${object.src.length} bytes`);
        return;
      }
      room.whiteboard.objects.push(object);
      io.to(roomId).emit('whiteboard_add_image', { object });
    });

    socket.on('whiteboard_update_object', ({ roomId, object }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacherOrInteractive(room, socket.id)) return;
      room.whiteboard.objects = room.whiteboard.objects.map(obj => obj.id === object.id ? object : obj);
      socket.to(roomId).emit('whiteboard_update_object', { object });
    });

    socket.on('whiteboard_remove_object', ({ roomId, objectId }: { roomId: string; objectId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacherOrInteractive(room, socket.id)) return;
      room.whiteboard.objects = room.whiteboard.objects.filter(obj => obj.id !== objectId);
      io.to(roomId).emit('whiteboard_remove_object', { objectId });
    });

    socket.on('whiteboard_set_view', ({ roomId, view }: any) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const sender = room.users.get(socket.id);
      if (!sender) return;
      // Treat missing/undefined whiteboardSync as ENABLED (default-on, opt-out).
      // Only an explicit false suppresses the relay. This also makes the server
      // forgiving toward any user object that might have been created before
      // the field existed.
      if (sender.whiteboardSync === false) return;

      // ── Validate payload ──
      // A malicious or buggy client could send NaN / Infinity / strings; if we
      // wrote those into room.whiteboard.view (the canonical state) every
      // sync-on user's canvas math would break. Hard-reject anything that
      // isn't three finite numbers, with sane bounds.
      const isFinite01 = (v: any) => typeof v === 'number' && Number.isFinite(v);
      if (!view || !isFinite01(view.boardScale) || !isFinite01(view.boardOffsetX) || !isFinite01(view.boardOffsetY)) return;
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
      const safeView = {
        boardScale: clamp(view.boardScale, 0.01, 100),
        boardOffsetX: clamp(view.boardOffsetX, -1e7, 1e7),
        boardOffsetY: clamp(view.boardOffsetY, -1e7, 1e7),
      };

      // ── Authority ──
      // Persist the canonical view ONLY for teachers. Students with
      // whiteboardSync on still get to broadcast their movement to peers (so
      // mutual "follow my view" works), but a student can no longer overwrite
      // the persisted view that late-joiners restore to. The teacher's last
      // movement is the authoritative one across reloads.
      if (sender.role === 'teacher') {
        room.whiteboard.view = safeView;
      }
      // Mutual sync: relay to every OTHER user whose whiteboardSync isn't
      // explicitly off. The "shared book" model — pan/zoom happens for both
      // sides at once.
      let recipientCount = 0;
      for (const [otherId, otherUser] of room.users.entries()) {
        if (otherId === socket.id) continue;
        if (otherUser.whiteboardSync === false) continue;
        io.to(otherId).emit('whiteboard_set_view', { view: safeView });
        recipientCount++;
      }
      // One-line diagnostic so it's obvious in the server log whether sync is
      // flowing both ways. Safe to leave in; very low volume.
      console.log(`🪟 whiteboard_set_view from ${sender.role} ${sender.name} → ${recipientCount} recipient(s)`);
    });

    // ─── WHITEBOARD: SYNC TOGGLE ───
    socket.on('set_whiteboard_sync', ({ roomId, enabled }: { roomId: string; enabled: boolean }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const user = room.users.get(socket.id);
      if (!user) return;
      user.whiteboardSync = !!enabled;
      io.to(roomId).emit('whiteboard_sync_changed', {
        userId: socket.id,
        userName: user.name,
        enabled: user.whiteboardSync,
      });
    });

    // ─── WHITEBOARD: SHAPES ───
    socket.on('whiteboard_add_shape', ({ roomId, shape }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !shape || typeof shape.id !== 'string') return;
      // Avoid duplicates if the same shape arrives twice
      if (room.whiteboard.shapes.some((s: any) => s.id === shape.id)) return;
      room.whiteboard.shapes.push(shape);
      // Cap to prevent unbounded growth
      if (room.whiteboard.shapes.length > 2000) room.whiteboard.shapes = room.whiteboard.shapes.slice(-2000);
      io.to(roomId).emit('whiteboard_add_shape', { shape });
    });

    socket.on('whiteboard_update_shape', ({ roomId, shape }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !shape || typeof shape.id !== 'string') return;
      room.whiteboard.shapes = room.whiteboard.shapes.map((s: any) => s.id === shape.id ? shape : s);
      socket.to(roomId).emit('whiteboard_update_shape', { shape });
    });

    socket.on('whiteboard_remove_shape', ({ roomId, shapeId }: { roomId: string; shapeId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || typeof shapeId !== 'string') return;
      room.whiteboard.shapes = room.whiteboard.shapes.filter((s: any) => s.id !== shapeId);
      io.to(roomId).emit('whiteboard_remove_shape', { shapeId });
    });

    // ── Grid mode + geometry instruments (ruler / protractor) ──
    // Grid mode is a board-level setting. Persisted alongside view + shapes.
    socket.on('whiteboard_set_grid_mode', ({ roomId, gridMode }: { roomId: string; gridMode: 'blank' | 'grid' | 'graph' }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (gridMode !== 'blank' && gridMode !== 'grid' && gridMode !== 'graph') return;
      room.whiteboard.gridMode = gridMode;
      io.to(roomId).emit('whiteboard_set_grid_mode', { gridMode });
    });

    // Instruments are persistent so a late-joining student sees what's on
    // the board. Capped to a sane limit to prevent runaway growth.
    socket.on('whiteboard_add_instrument', ({ roomId, instrument }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !instrument || typeof instrument.id !== 'string') return;
      if (!Array.isArray(room.whiteboard.instruments)) room.whiteboard.instruments = [];
      if (room.whiteboard.instruments.some((i: any) => i.id === instrument.id)) return;
      room.whiteboard.instruments.push(instrument);
      if (room.whiteboard.instruments.length > 16) {
        room.whiteboard.instruments = room.whiteboard.instruments.slice(-16);
      }
      io.to(roomId).emit('whiteboard_add_instrument', { instrument });
    });

    socket.on('whiteboard_update_instrument', ({ roomId, instrument }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !instrument || typeof instrument.id !== 'string') return;
      if (!Array.isArray(room.whiteboard.instruments)) room.whiteboard.instruments = [];
      room.whiteboard.instruments = room.whiteboard.instruments.map((i: any) => i.id === instrument.id ? instrument : i);
      socket.to(roomId).emit('whiteboard_update_instrument', { instrument });
    });

    socket.on('whiteboard_remove_instrument', ({ roomId, instrumentId }: { roomId: string; instrumentId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || typeof instrumentId !== 'string') return;
      if (!Array.isArray(room.whiteboard.instruments)) room.whiteboard.instruments = [];
      room.whiteboard.instruments = room.whiteboard.instruments.filter((i: any) => i.id !== instrumentId);
      io.to(roomId).emit('whiteboard_remove_instrument', { instrumentId });
    });

    // ── Text labels ──
    // Match the shape pattern: teacher-only mutations, capped to a sane
    // limit so a buggy/malicious client can't fill the room.
    const MAX_TEXTS_PER_ROOM = 1000;
    const MAX_TEXT_LENGTH = 4000;
    // AUTONOMOUS: Server-side clamp on the client-supplied `updatedAt` /
    // `createdAt` timestamps. The text update handler uses updatedAt for
    // last-write-wins arbitration on the client; without server clamping a
    // client whose system clock is wrong (or a malicious one) could send
    // Number.MAX_SAFE_INTEGER and PERMANENTLY pin its version — every
    // subsequent legitimate edit by another user would lose the conflict
    // because their updatedAt is smaller. Now the server rewrites both
    // timestamps to its own Date.now() at the moment of receipt, so the
    // ordering is server-authoritative.
    const stampText = (text: any) => {
      const now = Date.now();
      if (typeof text.createdAt !== 'number' || !Number.isFinite(text.createdAt) || text.createdAt > now) {
        text.createdAt = now;
      }
      // updatedAt is always rewritten — server is the source of truth for
      // when the change happened (this matches what other CRDT-ish systems do).
      text.updatedAt = now;
    };

    socket.on('whiteboard_add_text', ({ roomId, text }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !text || typeof text.id !== 'string' || typeof text.text !== 'string') return;
      if (!Array.isArray(room.whiteboard.texts)) room.whiteboard.texts = [];
      if (room.whiteboard.texts.some((t: any) => t.id === text.id)) return;
      // Cap individual text length so no single label can be megabytes.
      if (text.text.length > MAX_TEXT_LENGTH) text.text = text.text.slice(0, MAX_TEXT_LENGTH);
      stampText(text);
      room.whiteboard.texts.push(text);
      if (room.whiteboard.texts.length > MAX_TEXTS_PER_ROOM) {
        room.whiteboard.texts = room.whiteboard.texts.slice(-MAX_TEXTS_PER_ROOM);
      }
      io.to(roomId).emit('whiteboard_add_text', { text });
    });

    socket.on('whiteboard_update_text', ({ roomId, text }: any) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || !text || typeof text.id !== 'string') return;
      if (!Array.isArray(room.whiteboard.texts)) room.whiteboard.texts = [];
      if (typeof text.text === 'string' && text.text.length > MAX_TEXT_LENGTH) {
        text.text = text.text.slice(0, MAX_TEXT_LENGTH);
      }
      stampText(text);
      room.whiteboard.texts = room.whiteboard.texts.map((t: any) => t.id === text.id ? text : t);
      socket.to(roomId).emit('whiteboard_update_text', { text });
    });

    socket.on('whiteboard_remove_text', ({ roomId, textId }: { roomId: string; textId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id) || typeof textId !== 'string') return;
      if (!Array.isArray(room.whiteboard.texts)) room.whiteboard.texts = [];
      room.whiteboard.texts = room.whiteboard.texts.filter((t: any) => t.id !== textId);
      io.to(roomId).emit('whiteboard_remove_text', { textId });
    });

    socket.on('whiteboard_clear', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.whiteboard = { objects: [], strokes: [], shapes: [], view: null, gridMode: room.whiteboard.gridMode ?? 'grid', instruments: [], texts: [] };
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

    socket.on('whiteboard_delete_strokes', ({ roomId, strokeIds, strokeIndices }: { roomId: string; strokeIds?: string[]; strokeIndices?: number[] }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const user = room.users.get(socket.id);
      if (user?.role !== 'teacher' && !room.studentInteractionAllowed) return;

      // ── Resolve to a set of stroke ids ──
      // Prefer id-based deletion. Index-based delete (the legacy path) is
      // unsafe under concurrency: if two clients each submit their own
      // index list against the same array, the first .splice() shifts
      // every subsequent index, so the second client deletes whichever
      // strokes happen to land at those positions — not the ones they
      // selected. Map any incoming legacy indices to the current ids
      // FIRST (under the same tick), then do the actual delete by id.
      const idsToDelete = new Set<string>();
      if (Array.isArray(strokeIds)) {
        for (const id of strokeIds) {
          if (typeof id === 'string' && id) idsToDelete.add(id);
        }
      }
      if (Array.isArray(strokeIndices)) {
        for (const idx of strokeIndices) {
          if (Number.isInteger(idx) && idx >= 0 && idx < room.whiteboard.strokes.length) {
            const s = room.whiteboard.strokes[idx];
            if (s && typeof s.id === 'string' && s.id) idsToDelete.add(s.id);
          }
        }
      }
      if (idsToDelete.size === 0) return;

      const before = room.whiteboard.strokes.length;
      room.whiteboard.strokes = room.whiteboard.strokes.filter((s: any) =>
        !(s && typeof s.id === 'string' && idsToDelete.has(s.id))
      );
      if (room.whiteboard.strokes.length === before) return;

      const deletedIds = Array.from(idsToDelete);
      // Broadcast both for back-compat: new clients use strokeIds (race-free),
      // old clients fall back to strokeIndices (computed against current
      // server array, but unsafe if those clients had drifted).
      socket.to(roomId).emit('whiteboard_delete_strokes', { strokeIds: deletedIds });
    });

    socket.on('whiteboard_mode_toggle', ({ roomId, active }: { roomId: string; active: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      // Persist BEFORE broadcasting. Without server-side persistence, a
      // student who joins after the toggle never learns the teacher is on
      // the whiteboard (the broadcast was a one-shot event), so they'd
      // sit on the "Waiting for teacher" placeholder forever.
      room.whiteboardMode = !!active;
      io.to(roomId).emit('whiteboard_mode_changed', { active: room.whiteboardMode });
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
      const evtType = event?.type;
      const lossTolerant = evtType === 'SYNC_CURSOR' || evtType === 'SYNC_SCROLL'
        || evtType === 'SYNC_DRAG' || evtType === 'SYNC_MOUSEMOVE';
      if (!checkRateLimit(socket.id, lossTolerant)) return; // Rate limited
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
        // AUTONOMOUS: Defensive teacher-socket lookup. The cached
        // room.teacherSocketId can briefly point to a stale socket
        // (teacher tab switched, mid-grace-window, etc.). When that
        // happens, io.to(staleId).emit() silently routes nowhere and
        // student events vanish — the teacher reports "sync broke after
        // student rejoined." Fall back to scanning room.users for the
        // CURRENT live teacher socket so the routing self-heals.
        const resolveTeacherSocketId = (): string | null => {
          const cached = room.teacherSocketId;
          if (cached && room.users.get(cached)?.role === 'teacher') return cached;
          for (const [sid, u] of room.users.entries()) {
            if (u.role === 'teacher') {
              // Heal the cache while we're here.
              room.teacherSocketId = sid;
              return sid;
            }
          }
          return null;
        };
        // Student → only relay if interaction is allowed, and only cursor to teacher
        if (event.type === 'SYNC_CURSOR') {
          // Always allow cursor so teacher can see where students are looking
          const teacherId = resolveTeacherSocketId();
          if (teacherId) {
            io.to(teacherId).emit('interaction', event);
          }
        } else if (room.studentInteractionAllowed) {
          // Student interactions → only to teacher (not other students)
          const teacherId = resolveTeacherSocketId();
          if (teacherId) {
            io.to(teacherId).emit('interaction', event);
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
      // No broadcastFullState — `step_changed` carries everything clients need.
    });

    socket.on('add_gate', ({ roomId, step, question, options, correctIndex }: { roomId: string; step: number; question: string; options: string[]; correctIndex: number }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.gates[step] = { question, options, correctIndex };
      const revision = bumpRevision(room);
      io.to(roomId).emit('gate_added', { step, revision });
      // No broadcastFullState — `gate_added` carries everything clients need.
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
    // AUTONOMOUS: Miro-style "Save to my boards" claim.
    // Anyone in the room can claim it (anyone with the link can already
    // edit anyway — the takeover gate from PR #42 protects against
    // teacher-role abuse). The claim flips expiry from 24h → 30d and
    // records claimedBy so the UI can show "saved by NAME". Real
    // ownership semantics (only-original-owner-can-claim, transferable)
    // arrive with auth in Phase 3.
    socket.on('claim_room', ({ roomId, name }: { roomId: string; name: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const safeName = sanitizeString(name, MAX_USERNAME_LENGTH) || 'Anonymous';
      if (!room.claimed) {
        room.claimed = true;
        room.claimedAt = Date.now();
        room.claimedBy = safeName;
        console.log(`💾 Room ${roomId} claimed by ${safeName} → 30-day TTL`);
      }
      // Always re-broadcast the (possibly-updated) expiry so the banner
      // disappears for everyone in the room, not just the claimer.
      io.to(roomId).emit('room_claimed', {
        claimed: true,
        claimedBy: room.claimedBy,
        expiresAt: computeExpiresAt(room),
      });
    });

    socket.on('hard_reset', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return; // Only teacher
      room.chat = [];
      room.currentStep = 1;
      room.gates = {};
      room.isPaused = false;
      room.scores = {};
      // Bump the canonical revision. Without this, any subsequent
      // session_state / force_sync_state carries the OLD revision and clients
      // with a higher local revision (stored before the reset) silently drop
      // the post-reset state via the freshness guard.
      bumpRevision(room);
      updateRoomActivity(roomId);
      io.to(roomId).emit('room_reset', {
        // Include preserved content so clients can restore it after clearing local state
        activeFileId: room.activeFileId,
        files: room.files,
        lastRunHtml: room.lastRunHtml,
        revision: room.revision,
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
            // AUTONOMOUS: Grace period before declaring "teacher left".
            //
            // The most common reason for this disconnect is a tab switch:
            // browser throttles the backgrounded tab, Socket.IO heartbeat
            // misses, server gets `disconnecting`. The teacher is still
            // sitting at their desk; they'll be back in seconds.
            //
            // If we IMMEDIATELY emit teacher_disconnected and null the
            // teacherSocketId, any student who joins during the gap sees
            // "Waiting for teacher" with no recovery once teacher returns
            // (because their reconnect generates a NEW socketId and
            // existing students don't re-fetch).
            //
            // Now: the slot is held for GRACE_MS (45s — a bit longer than
            // the new pingTimeout). If the same-named teacher reconnects
            // within the grace window, the timer is cancelled and no
            // disconnect notification is ever sent. Truly-gone teachers
            // still get cleaned up, just delayed.
            const TEACHER_DISCONNECT_GRACE_MS = 45_000;
            const expectedTeacherName = user?.name;
            const oldSocketId = socket.id;
            // Mark the slot as "pending-disconnect" but don't null it yet —
            // join_room's takeover gate uses teacherSocketId existence,
            // and we want a same-name reconnect to slip in transparently.
            // If a previous grace timer was running, replace it.
            if (room.pendingTeacherDisconnect?.timer) clearTimeout(room.pendingTeacherDisconnect.timer);
            room.pendingTeacherDisconnect = {
              socketId: oldSocketId,
              expectedName: expectedTeacherName,
              timer: setTimeout(() => {
                // Grace expired — teacher really did leave. Clear the
                // seat and notify students NOW.
                const r = rooms.get(roomId);
                if (!r) return;
                if (r.teacherSocketId === oldSocketId) {
                  r.teacherSocketId = null;
                  io.to(roomId).emit('teacher_disconnected');
                  console.log(`👋 Teacher ${expectedTeacherName} declared gone after ${TEACHER_DISCONNECT_GRACE_MS}ms grace`);
                }
                r.pendingTeacherDisconnect = undefined;
              }, TEACHER_DISCONNECT_GRACE_MS),
            };
            console.log(`⏳ Teacher ${expectedTeacherName} disconnected — holding seat for ${TEACHER_DISCONNECT_GRACE_MS / 1000}s`);
          }

          // Check if any students remain — if not, start the 2hr expiry countdown
          if (user?.role === 'student') {
            const hasStudents = Array.from(room.users.values()).some(u => u.role === 'student');
            if (!hasStudents) {
              room.studentLeftAt = Date.now();
              console.log(`⏰ Room ${roomId}: Last student left. 2hr expiry countdown started.`);
            }
          }

          // When the last user leaves: persist + decide what to do with the
          // room. Rooms with ANY content (uploaded HTML, whiteboard work,
          // chat history, explanation overlay) stay alive for the full
          // 48-hour absolute-inactivity expiry handled by the periodic
          // sweep above — so a teacher can share a link and have a
          // student join hours later. Only completely empty rooms (a stray
          // /room URL that nobody put anything in) get the 5-min cleanup.
          if (room.users.size === 0) {
            const hasContent =
              room.files.length > 0 ||
              !!room.lastRunHtml ||
              !!room.tempContent ||
              (room.chat?.length ?? 0) > 0 ||
              (room.whiteboard?.objects?.length ?? 0) > 0 ||
              (room.whiteboard?.strokes?.length ?? 0) > 0 ||
              (room.whiteboard?.shapes?.length ?? 0) > 0;
            if (hasContent) {
              // Persist immediately so a quick server restart (Render cold
              // sleep, redeploy, etc.) doesn't lose work that's only been
              // in memory since the last 5-min interval tick.
              saveRooms();
              console.log(`Room ${roomId} kept (has content) — link valid until 48h expiry`);
            } else {
              setTimeout(() => {
                const r = rooms.get(roomId);
                if (!r || r.users.size > 0) return; // someone joined back
                rooms.delete(roomId);
                console.log(`Room ${roomId} cleaned up (empty, no content)`);
              }, 5 * 60 * 1000);
            }
          }
        }
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
  });

  // AUTONOMOUS: [ORDER-4 FUTURE-PROOFING] - /healthz for monitoring.
  // Render's free tier sleeps after 15min idle; a periodic ping at /healthz
  // is the standard wake-up trick. Also gives us a single endpoint to
  // verify the server is alive (uptime monitoring, load balancer health
  // checks, manual debugging "is it up").
  // Returns 200 with a small JSON payload — cheap enough to hammer.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      rooms: rooms.size,
      ts: Date.now(),
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
    // AUTONOMOUS: Same permissive fallback as join_room — use any HTML
    // we have. Previously this only checked lastRunHtml, so a room with
    // only liveSnapshotHtml (which is what we have post-redeploy when
    // the teacher's iframe re-seeds) returned 204 and the stuck student
    // got no fallback.
    const file = room.activeFileId ? room.files.find(f => f.id === room.activeFileId) : (room.files[0] || null);
    const html = room.lastRunHtml || room.liveSnapshotHtml || (file ? file.html : null);
    if (!html) {
      res.status(204).send(); // No content yet
      return;
    }
    res.json({
      html,
      activeFileId: room.activeFileId || (file?.id ?? null),
      fileName: file?.name || 'Simulation',
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
