import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { pressureFrom, idleWindowFor, describeMemory, type MemoryPolicy } from './src/lib/memoryGuard';
import fs from 'fs';
import { createHmac, randomBytes } from 'crypto';
// pg is CommonJS; this file is ESM. Named imports off a CJS module are the
// classic ERR_MODULE_NOT_FOUND at boot, so take the default and destructure.
import pg from 'pg';
const { Pool } = pg;
import { IDENTITY_SCHEMA_SQL, mountAuthRoutes, userFromCookieHeader } from './src/server/identity';
import { mountRecordRoutes } from './src/server/records';
import { BOARD_IMAGE_SCHEMA_SQL, mountBoardImageRoutes, externaliseBoardImages } from './src/server/boardImages';
import { BILLING_SCHEMA_SQL, mountBillingRoutes, accessForTeacher } from './src/server/billing';
import { mountOwnerDashRoutes, type LiveRoom } from './src/server/ownerDash';
import { mountPeopleRoutes } from './src/server/people';
import { MAIL_LOG_SCHEMA_SQL, startDailyJobs } from './src/server/scheduler';
import { rateLimit, makeLimiter, handshakeIp } from './src/server/rateLimit';
import { runMigrations } from './src/server/migrate';

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
  users: Map<string, { name: string; role: 'teacher' | 'student'; joinedAt: number; whiteboardSync: boolean; tz?: string;
    /** Stable per-browser id, so the owner can tell devices apart from names. */
    clientId?: string }>;
  isPaused: boolean;
  teacherSocketId: string | null;
  /**
   * B4 — when an anonymous demo room stops teaching, or null if this is not
   * a demo. Set the first time someone takes the teacher seat with no signed-in
   * account in a room that is not a registered class; cleared the moment a real
   * teacher takes the seat, because then it is somebody's lesson.
   */
  demoUntil?: number | null;
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
  // Is the tutor currently sharing their screen? Kept on the room so a student
  // who joins or reconnects mid-share is told, instead of sitting on a lesson
  // the tutor has already given up on and moved past.
  teacherScreenOn: boolean;
  // Room password (optional)
  password: string | null;
  // Students waiting for HTML sync from teacher (joined before teacher's DOM capture arrives)
  pendingSyncStudents: Set<string>;
  // Gamification: track XP and streaks per student name (keyed by studentName for persistence across reconnects)
  scores: Record<string, { xp: number; streak: number; bestStreak: number; correct: number; total: number }>;
  // Transient (NOT persisted): "<studentName>:<step>" keys that have already
  // earned gate XP, so re-answering the same checkpoint can't farm XP.
  gateAwarded: Set<string>;
  // Monotonic interaction sequence for ordering guarantees
  interactionSeq: number;
  // Temporary explanation content (persists so late-joining students see it).
  // Mirrors whichever entry in `explanations` is active, so students and the
  // hydration path never need to know the list exists.
  tempContent: { html: string; name: string } | null;
  // The teacher's kept explanations. Closing one returns to the lesson but
  // leaves it here to reopen; only an explicit delete discards it.
  explanations: Array<{ id: string; name: string; html: string }>;
  activeExplanationId: string | null;
  /** Has the teacher asked the room to transcribe what's said? */
  narrationOn: boolean;
  liveSnapshotHtml: string | null;
  // LIVE MIRROR: the teacher's authoritative iframe DOM (latest snapshot),
  // relayed to students and cached so a late-joiner renders instantly.
  // Transient (NOT persisted) — re-sent by the source on the next mutation.
  // mirrorAttrs/mirrorHead carry the styling envelope (body attributes and
  // runtime-injected head CSS) so a cache-served joiner looks identical, and
  // mirrorHash is the fingerprint students compare against to detect a lost frame.
  mirrorBody: string | null;
  mirrorAttrs: string | null;
  mirrorHead: string | null;
  mirrorHash: string | null;
  // ── Video call ──
  // Who is currently IN the call, by socket id. The call is a thing the room
  // owns, not something the two browsers negotiate between themselves.
  //
  // It used to be the latter, and the result was that whoever pressed the
  // button first decided whether the call connected at all: a side that had not
  // joined yet threw away any offer it received, and once both sides had an
  // unanswered offer out, neither ever retried. Teacher-first — the normal way a
  // lesson starts — deadlocked every time; student-first worked. That is the
  // whole "sometimes the call won't connect".
  //
  // With the room holding the state there is exactly one offerer, chosen here,
  // and it is only chosen once both parties are actually present. No offer can
  // arrive at a side that is not ready for it, so none can be dropped, and there
  // is no collision to resolve because there is never a second offer.
  // What each student's screen actually holds, by socket id. Transient: it
  // describes a live connection and means nothing once that connection is gone.
  mirrorAcks: Map<string, { h: string | null; ok: boolean; at: number }>;
  // Where the lesson had got to, as the lesson itself describes it.
  //
  // The one thing the mirror cannot do alone is survive the death of the tab the
  // lesson runs in — so a lesson that implements window.mathslive.getState()
  // tells us, and after a reload we hand it straight back. Tagged with the
  // lesson it came from: restoring question 5 of a bus problem into a different
  // lesson entirely would be worse than restarting.
  lessonState: { forHtml: string; state: string; at: number } | null;
  callMembers: Set<string>;
  /** The socket the server told to make the offer for the current pairing. */
  callOfferer: string | null;
  // Shared YouTube clip playing over the lesson, if any. Held here (not just
  // broadcast) so a student joining or reloading mid-clip lands on the same
  // video at roughly the teacher's position instead of seeing nothing.
  sharedVideo: { videoId: string; time: number; playing: boolean; updatedAt: number } | null;
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
  // ── Deterministic shared randomness ──
  // A single seed every client injects into the sim's Math.random override,
  // so a non-deterministic lesson (e.g. a quiz that rolls a random question
  // on "Next") produces the IDENTICAL sequence on the teacher and every
  // student. Regenerated on each content baseline (new lesson load), so each
  // lesson run is fresh but locked across screens. 0 = none (legacy / clients
  // fall back to a body-text hash).
  randomSeed: number;
  // ── Control handoff ──
  // Display name of the student currently holding exclusive control ("the
  // chalk"). Keyed by NAME (like scores) so it survives the student's socket
  // reconnecting. null = nobody; the global studentInteractionAllowed toggle
  // is independent ("everyone may interact"). The teacher ALWAYS drives
  // regardless of this field.
  controlHolderName: string | null;
  // ── Event journal (late-join convergence) ──
  // The discrete interaction stream (clicks/inputs/keys — not cursor/scroll)
  // since the last content BASELINE (upload / run / restore / stored DOM
  // snapshot). A late-joining student boots the baseline HTML and then
  // replays this journal in order, so their sim instance — including
  // canvas/WebGL and JS-stateful sims that DOM snapshots can't capture —
  // converges to the class's current state. Cleared whenever a new baseline
  // is established. If it overflows EVENT_LOG_MAX, replay is disabled until
  // the next baseline (a partial replay would diverge worse than none).
  eventLog: any[];
  eventLogOverflow: boolean;
  // ── Lesson Time Machine ──
  // Teacher-captured moments of canonical state. Restoring one rewinds the
  // whole class (HTML + whiteboard + annotations + step). Capped at
  // MAX_BOOKMARKS, FIFO. Full payload lives server-side only; clients get
  // {id,name,ts} metadata via session state.
  bookmarks: Array<{
    id: string;
    name: string;
    ts: number;
    html: string | null;
    whiteboard: RoomData['whiteboard'];
    annotations: Array<{ senderId: string; stroke: any }>;
    currentStep: number;
    zoomLevel: number;
  }>;
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
  /** Where the lesson had got to, if it can say — see RoomData.lessonState. */
  lessonState?: string | null;
  effectiveHtml: string | null;
  files: FileEntry[];
  isPaused: boolean;
  scrollSyncEnabled: boolean;
  /** Is the tutor sharing their screen right now? */
  teacherScreenOn: boolean;
  studentInteractionAllowed: boolean;
  currentStep: number;
  gates: Record<number, { question: string; options: string[]; correctIndex: number }>;
  tempContent: { html: string; name: string } | null;
  /** The teacher's kept explanations, names only. */
  explanations: Array<{ id: string; name: string }>;
  activeExplanationId: string | null;
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
  // Control handoff: who currently holds "the chalk" (null = nobody).
  controlHolderName: string | null;
  // Time Machine metadata only — full bookmark payloads stay server-side.
  bookmarks: Array<{ id: string; name: string; ts: number }>;
  // Shared deterministic-random seed (see RoomData.randomSeed).
  randomSeed: number;
  // The room's CURRENT interaction sequence counter. Clients keep a
  // "highest serverSeq applied" filter that deliberately survives socket
  // blips — but after a server restart / room reset the counter restarts
  // from 0, and if the lesson HTML is identical the client iframe never
  // rebuilds, so the stale high filter silently DROPS every new event
  // ("sync dead after redeploy"). Hydration handing over the server's
  // true counter lets clients detect the restart (server seq BEHIND their
  // filter) and adopt it. See stress12 R1.
  interactionSeq: number;
  // A YouTube clip the teacher is currently showing over the lesson, with the
  // position already wound forward to now, so a late joiner starts in step.
  sharedVideo: { videoId: string; time: number; playing: boolean } | null;
}

async function startServer() {
  const app = express();
  // Caddy terminates TLS and forwards to 127.0.0.1:4000, so every request
  // arrives from localhost and `req.ip` would be 127.0.0.1 for the whole
  // internet — one rate-limit bucket for everybody. Trusting exactly ONE hop
  // makes `req.ip` the address Caddy saw, and no more: a client that sets its
  // own X-Forwarded-For gets that header ignored, because Express only reads
  // the entry the trusted proxy appended. `true` here would be a bug — it
  // would let anyone choose their own rate-limit bucket.
  app.set('trust proxy', 1);
  // Default to 4000 locally so MathsLive never collides with the MathEinstein
  // Next.js app (which owns :3000). Hosting platforms always inject their own
  // PORT, so this default only affects local `npm run dev` / `npm start`.
  const PORT = parseInt(process.env.PORT || '4000', 10);

  const httpServer = createServer(app);
  // CORS: open by default (same-origin serving means the browser never
  // actually needs cross-origin socket access), lockable for production by
  // setting ALLOWED_ORIGINS to a comma-separated list of exact origins,
  // e.g. ALLOWED_ORIGINS=https://math-live-colab.onrender.com
  // This closes the DEPLOY.md production-checklist item without changing
  // behaviour for anyone who hasn't set the variable.
  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (ALLOWED_ORIGINS.length > 0) {
    console.log(`🔐 Socket CORS restricted to: ${ALLOWED_ORIGINS.join(', ')}`);
  }
  const io = new Server(httpServer, {
    cors: { origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : '*' },
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
    // Socket.IO v4 ships perMessageDeflate DISABLED by default, so every Live
    // Mirror frame — which is literally HTML, the most compressible payload
    // there is — was crossing the wire raw. Turning it on is a large,
    // essentially free bandwidth win for the mirror, the lesson uploads and the
    // whiteboard alike. threshold skips tiny control frames (cursor, ping,
    // fingerprint heartbeat) where the compression round-trip would cost more
    // CPU than the bytes it saves.
    perMessageDeflate: { threshold: 1024 },
  });

  const rooms = new Map<string, RoomData>();

  // ─── MEMORY MANAGEMENT ───
  // How long a room with nobody in it stays in RAM before being written to the
  // store and dropped. Long enough that stepping out of a lesson for a coffee
  // costs nothing (the room is still warm), short enough that a day of
  // back-to-back students does not accumulate.
  // Env-tunable so the behaviour can actually be exercised in a test rather
  // than asserted about — a 30-minute timer is not testable, and an untested
  // eviction path is how a live room gets dropped.
  const IDLE_EVICT_MS = Number(process.env.IDLE_EVICT_MS) || 30 * 60 * 1000;
  // What the JS heap may use before rooms start being shed. A Render free
  // instance is 512MB for EVERYTHING — node itself, buffers, the heap — so the
  // heap budget is deliberately well under it. Raise MEMORY_BUDGET_MB on a
  // larger instance.
  const MEMORY_POLICY: MemoryPolicy = {
    // Sized against the ACTUAL heap ceiling, not the container. The start
    // script caps old-space at 256MB (a ~448MB total heap limit, leaving the
    // rest of a 512MB container for code, buffers and native allocations).
    // Shedding has to begin well before V8 is out of room, so the budget is
    // the old-space cap, not the container size.
    budgetBytes: (Number(process.env.MEMORY_BUDGET_MB) || 256) * 1024 * 1024,
    idleMs: IDLE_EVICT_MS,
  };
  // Re-read every sweep, so the window in force reflects the heap right now.
  function currentIdleWindow(): number {
    return idleWindowFor(pressureFrom(process.memoryUsage().heapUsed, MEMORY_POLICY), MEMORY_POLICY);
  }
  const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 10 * 60 * 1000;
  /** B4 — how long an anonymous "Start teaching" room may run. */
  const DEMO_MINUTES = Number(process.env.DEMO_MINUTES) || 30;
  // Sweep every 10 minutes:
  //  - Rooms past their claim-aware TTL (24h anonymous OR 30d claimed)
  //  - Rooms where last student left > 2 hours ago AND no students currently connected
  setInterval(() => {
    const now = Date.now();
    const studentLeftExpiryMs = 2 * 60 * 60 * 1000; // 2 hours after last student leaves
    let deletedCount = 0;
    let evictedCount = 0;
    // Under memory pressure this collapses toward zero, so idle rooms are shed
    // before the process is killed rather than after.
    const idleWindow = currentIdleWindow();

    for (const [roomId, room] of rooms.entries()) {
      // B4: a demo that is still running past its clock. Ends the lesson
      // rather than only refusing the next join — otherwise one anonymous room
      // opened this morning teaches all day.
      //
      // Reuses join_error because both clients already show it: a person is
      // told why, in a sentence, instead of watching the board stop responding.
      if (room.demoUntil && now > room.demoUntil && room.users.size > 0) {
        io.to(roomId).emit('join_error', {
          code: 'demo_over',
          retryable: false,
          message: 'This free demo has ended. Sign up to keep teaching — the first 7 days are free.',
        });
        for (const socketId of room.users.keys()) {
          io.sockets.sockets.get(socketId)?.disconnect(true);
        }
        room.users.clear();
        room.teacherSocketId = null;
        console.log(`⏳ Demo room ${roomId} reached its ${DEMO_MINUTES}-minute limit`);
      }

      // AUTONOMOUS: Claim-aware expiry. Anonymous rooms die at
      // createdAt+24h; claimed rooms get 30 days. Mirrors Miro.
      const expiresAt = computeExpiresAt(room);
      if (now > expiresAt) {
        rooms.delete(roomId);
        void roomStore.remove(roomId).catch(() => {});
        deletedCount++;
        continue;
      }

      // Student-left expiry: 2 hours after last student disconnected. Only
      // delete if the room is TRULY empty — a connected teacher (e.g. a long
      // prep session, or a teacher who arrived before any student) counts as
      // activity and must not have their room (and its durable copy) swept out
      // from under them.
      if (room.studentLeftAt && (now - room.studentLeftAt > studentLeftExpiryMs)) {
        // Only a throwaway room dies here. "Empty for two hours" is the NORMAL
        // state of a claimed board between weekly lessons, and this branch used
        // to remove the durable copy too — so the claim-aware 30-day promise a
        // few lines above was quietly void. Claimed rooms and rooms with
        // content are left to the idle eviction below (persist, then drop from
        // memory) and to their own TTL.
        if (room.users.size === 0 && !room.claimed && !roomHasContent(room)) {
          rooms.delete(roomId);
          void roomStore.remove(roomId).catch(() => {});
          deletedCount++;
          continue;
        }
      }
    }

    // ── Idle-room eviction: memory should track lessons happening NOW ──
    //
    // Render restarted this service for exceeding its memory limit, which is
    // what made joining unreliable and boards vanish mid-lesson. The cause is
    // here: a room stays in RAM for its whole life — 24 hours anonymous, THIRTY
    // DAYS once claimed — with nobody in it. And a room is not small: up to 50
    // files at 2MB each, 8 explanations at 2MB, the last-run HTML, and a
    // continuously-updated copy of the teacher's entire iframe DOM. A handful
    // of taught-and-left rooms is enough to exhaust a small instance.
    //
    // Nothing needs them in memory once everyone has gone. The durable store
    // already holds them and join_room already lazily restores on demand —
    // that path is how a student opens a permanent class link after a
    // cold start. So: persist, then drop. Memory becomes proportional to
    // concurrent lessons instead of to everything ever taught.
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.size > 0) continue;                       // someone is in it
      if (room.pendingTeacherDisconnect) continue;             // inside the grace window
      if (now - room.lastActivityAt < idleWindow) continue;    // still warm
      const keep = roomHasContent(room);
      // Persist BEFORE dropping, or eviction becomes deletion.
      const done = keep ? saveSingleRoom(roomId, room) : Promise.resolve();
      void done.then(() => {
        // Re-check: someone may have joined during the write, which would
        // lazily restore a STALE copy over their live room.
        const still = rooms.get(roomId);
        if (!still || still.users.size > 0) return;
        if (still.pendingTeacherDisconnect) return;
        rooms.delete(roomId);
        evictedCount++;
      }).catch(err => {
        // A failed write means the only copy is the one in memory. Keep it.
        console.warn(`Eviction skipped for ${roomId} — persist failed:`, err?.message || err);
      });
    }

    if (deletedCount > 0) {
      console.log(`🧹 Memory Sweep: Cleared ${deletedCount} expired rooms.`);
    }
    // evictedCount is incremented asynchronously (after each persist), so read
    // it on the next tick rather than reporting zero every time.
    setTimeout(() => {
      if (evictedCount > 0) {
        const mb = Math.round(process.memoryUsage().heapUsed / 1048576);
        console.log(`💤 Evicted ${evictedCount} idle rooms to the store (heap now ${mb}MB, ${rooms.size} in memory)`);
      }
    }, 5000);
  }, SWEEP_INTERVAL_MS);

  // ── Memory watchdog ──
  //
  // The sweep above runs every ten minutes. A heap can go from comfortable to
  // killed in far less than that — which is what happened here: repeated
  // "exceeded its memory limit" restarts, and eventually a suspended service.
  // This checks often and sheds empty rooms the moment pressure appears, so
  // the process survives to keep teaching the lesson it is in the middle of.
  //
  // It NEVER touches an occupied room. Ending a lesson to save memory is not a
  // fix, it is the outage arriving by another route.
  let lastPressure: ReturnType<typeof pressureFrom> = 'ok';
  setInterval(() => {
    const heap = process.memoryUsage().heapUsed;
    const pressure = pressureFrom(heap, MEMORY_POLICY);
    if (pressure !== lastPressure) {
      const how = pressure === 'ok' ? '🟢 memory back to normal' :
                  pressure === 'high' ? '🟡 memory high — shedding idle rooms sooner' :
                  '🔴 memory critical — shedding every idle room now';
      console.warn(`${how}: ${describeMemory(heap, MEMORY_POLICY)}, ${rooms.size} rooms in memory`);
      lastPressure = pressure;
    }
    if (pressure === 'ok') return;

    const window = idleWindowFor(pressure, MEMORY_POLICY);
    const now = Date.now();
    let shed = 0;
    for (const [roomId, room] of rooms.entries()) {
      if (room.users.size > 0) continue;                    // NOT negotiable
      if (room.pendingTeacherDisconnect) continue;          // teacher may be back
      if (now - room.lastActivityAt < window) continue;
      const keep = roomHasContent(room);
      const done = keep ? saveSingleRoom(roomId, room) : Promise.resolve();
      void done.then(() => {
        const still = rooms.get(roomId);
        if (!still || still.users.size > 0 || still.pendingTeacherDisconnect) return;
        rooms.delete(roomId);
      }).catch(() => { /* the only copy is the one in memory — keep it */ });
      shed++;
    }
    if (shed > 0) console.warn(`💧 Shed ${shed} idle rooms under memory pressure`);
  }, 30_000);

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
      // Students may click and scroll the lesson from the moment they join.
      //
      // This was false — view-only until the tutor explicitly granted it — and
      // that default cost more than it protected. A student on an iPad could
      // not press a single button in a worksheet, could not scroll to read the
      // bottom of a question, and had no way to ask; the tutor had to notice
      // and grant it every lesson, for every student, before anything worked.
      //
      // The guarantee it bought (everyone is looking at exactly what I am) is
      // still available and still one click away: the interaction toggle turns
      // it off per room, and "Linked" additionally pins scrolling to the
      // tutor's. Defaulting to participation and switching to lockstep when
      // needed is the right way round for a one-to-one maths lesson.
      studentInteractionAllowed: true,
      teacherScreenOn: false,
      password: null,
      pendingSyncStudents: new Set(),
      scores: {},
      gateAwarded: new Set(),
      interactionSeq: 0,
      tempContent: null,
      explanations: [],
      activeExplanationId: null,
      narrationOn: false,
      liveSnapshotHtml: null,
      mirrorBody: null,
      mirrorAttrs: null,
      mirrorHead: null,
      mirrorHash: null,
      sharedVideo: null,
      mirrorAcks: new Map<string, { h: string | null; ok: boolean; at: number }>(),
      lessonState: null,
      callMembers: new Set<string>(),
      callOfferer: null,
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
      controlHolderName: null,
      bookmarks: [],
      eventLog: [],
      eventLogOverflow: false,
      randomSeed: 0,
    };
  }

  // A fresh positive 31-bit seed for a new lesson baseline. Server-side
  // Math.random is fine here (plain Node, not a workflow context).
  function newRandomSeed(): number {
    return (Math.floor(Math.random() * 2147483646) + 1);
  }
  // Establishing a new content baseline: a brand-new lesson is on screen, so
  // the journal restarts AND every client re-seeds its RNG identically.
  function newContentBaseline(room: RoomData) {
    resetEventJournal(room);
    // A different lesson is a different place; the old position means nothing.
    room.lessonState = null;
    room.randomSeed = newRandomSeed();
    // Drop the old lesson's mirror snapshot so a student joining right after a
    // lesson switch never renders the previous lesson's DOM (the source will
    // stream the new one within a frame of its iframe rebuilding).
    room.mirrorBody = null;
    room.mirrorAttrs = null;
    room.mirrorHead = null;
    room.mirrorHash = null;
  }

  // ── Event journal helpers ──
  // Discrete, replayable interaction types. Cursor/scroll/zoom/drag-move are
  // continuous and view-only; pings are ephemeral — none of them belong in
  // the journal a late joiner replays.
  const REPLAYABLE_EVENT_TYPES = new Set([
    'SYNC_CLICK', 'SYNC_INPUT', 'SYNC_CHANGE', 'SYNC_KEYDOWN', 'SYNC_KEYUP',
    'SYNC_MOUSEDOWN', 'SYNC_MOUSEUP', 'SYNC_POINTERDOWN',
    'SYNC_DRAGSTART', 'SYNC_DRAGEND', 'SYNC_DROP',
  ]);
  // Cap chosen high: each journaled event is tiny (a click/key/input delta),
  // so 2000 is only a few hundred KB worst case, but it covers essentially any
  // realistic lesson without the journal overflowing. Overflow disables replay
  // (a partial replay would diverge worse than none) — and for a canvas/3D sim
  // there's no snapshot fallback, so a late joiner after overflow would reset
  // to frame 0. Keeping the cap generous makes that path practically
  // unreachable; Force Sync remains the manual re-baseline if it ever is.
  const EVENT_LOG_MAX = 2000;
  function journalEvent(room: RoomData, event: any) {
    if (!event || !REPLAYABLE_EVENT_TYPES.has(event.type)) return;
    if (room.eventLogOverflow) return;
    if (room.eventLog.length >= EVENT_LOG_MAX) {
      // Past the cap a partial journal would replay HALF the story and leave
      // the late joiner in a state nobody else ever had. Disable until the
      // next baseline instead.
      room.eventLogOverflow = true;
      room.eventLog = [];
      return;
    }
    room.eventLog.push(event);
  }
  // A new content baseline (fresh HTML everyone rebuilds from, or a stored
  // DOM snapshot late-joiners boot from) makes the old journal obsolete.
  function resetEventJournal(room: RoomData) {
    room.eventLog = [];
    room.eventLogOverflow = false;
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

  // The same promise, asked of a STORED blob before it is hydrated.
  //
  // The old gate was flat: anything idle for 48 hours was refused. But a
  // weekly class link is idle for seven days BY DESIGN, and refusing the
  // teacher did not merely hide the board — the join path then created a
  // fresh empty room under the same id, and the next persist overwrote the
  // saved copy with the emptiness. The claim was honoured everywhere except
  // the one moment it mattered: coming back.
  function storedRoomFresh(raw: any): boolean {
    if (!raw) return false;
    if (raw.claimed && raw.claimedAt) return Date.now() < raw.claimedAt + CLAIMED_TTL_MS;
    if (raw.createdAt) return Date.now() < raw.createdAt + ANON_TTL_MS;
    // A blob from before these stamps existed: the old activity rule is all
    // there is to go on.
    return !(raw.lastActivityAt && Date.now() - raw.lastActivityAt > PERSIST_MAX_AGE);
  }

  // ─── ROOM PERSISTENCE ───
  const PERSIST_DIR = path.join(process.cwd(), '.rooms');
  const PERSIST_INTERVAL = 5 * 60 * 1000; // Save every 5 minutes
  const PERSIST_MAX_AGE = 48 * 60 * 60 * 1000; // Clean files older than 48 hours

  // Ensure persist directory exists
  try { if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch {}

  // ─── DURABLE STORE ADAPTER ─────────────────────────────────────────────
  // Each room persists as one JSON blob. Locally (and on hosts without a
  // configured database) we keep using the .rooms/ directory exactly as
  // before. When Upstash Redis REST credentials are present we use those
  // instead, so rooms survive cold-starts, redeploys and ephemeral
  // filesystems — the requirement for "permanent" class links that work
  // every time, even before the teacher arrives.
  //
  // The Redis path talks to Upstash's plain REST API over global fetch
  // (Node 20+), so there is NO new npm dependency — the feature is purely
  // env-var activated and cannot break the existing deploy.
  interface RoomStore {
    readonly kind: string;
    save(roomId: string, data: object, ttlSeconds: number): Promise<void>;
    load(roomId: string): Promise<any | null>;
    loadAll(): Promise<Array<{ roomId: string; data: any }>>;
    remove(roomId: string): Promise<void>;
  }

  const fileRoomStore: RoomStore = {
    kind: 'file',
    async save(roomId, data) {
      await fs.promises.writeFile(path.join(PERSIST_DIR, `${roomId}.json`), JSON.stringify(data), 'utf-8');
    },
    async load(roomId) {
      try {
        const raw = await fs.promises.readFile(path.join(PERSIST_DIR, `${roomId}.json`), 'utf-8');
        return JSON.parse(raw);
      } catch { return null; }
    },
    async loadAll() {
      const out: Array<{ roomId: string; data: any }> = [];
      try {
        if (!fs.existsSync(PERSIST_DIR)) return out;
        const files = (await fs.promises.readdir(PERSIST_DIR)).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const raw = await fs.promises.readFile(path.join(PERSIST_DIR, file), 'utf-8');
            out.push({ roomId: file.replace(/\.json$/, ''), data: JSON.parse(raw) });
          } catch (err) {
            // Quarantine corrupt files (preserve recovery) rather than delete.
            console.error(`Failed to read ${file}:`, err);
            try { await fs.promises.rename(path.join(PERSIST_DIR, file), path.join(PERSIST_DIR, file + '.corrupt')); } catch {}
          }
        }
      } catch (err) { console.error('loadAll failed:', err); }
      return out;
    },
    async remove(roomId) {
      try { await fs.promises.unlink(path.join(PERSIST_DIR, `${roomId}.json`)); } catch {}
    },
  };

  function makeRedisRoomStore(restUrl: string, token: string): RoomStore {
    const base = restUrl.replace(/\/+$/, '');
    async function cmd(args: (string | number)[]): Promise<any> {
      const res = await fetch(base, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!res.ok) throw new Error(`Upstash ${String(args[0])} failed: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: any; error?: string };
      if (json.error) throw new Error(`Upstash error: ${json.error}`);
      return json.result;
    }
    const key = (roomId: string) => `room:${roomId}`;
    return {
      kind: 'redis',
      async save(roomId, data, ttlSeconds) {
        const ttl = Math.max(60, Math.floor(ttlSeconds));
        await cmd(['SET', key(roomId), JSON.stringify(data), 'EX', ttl]);
      },
      async load(roomId) {
        const result = await cmd(['GET', key(roomId)]);
        if (result == null) return null;
        try { return typeof result === 'string' ? JSON.parse(result) : result; } catch { return null; }
      },
      async loadAll() {
        const out: Array<{ roomId: string; data: any }> = [];
        let cursor = '0';
        do {
          const scan = (await cmd(['SCAN', cursor, 'MATCH', 'room:*', 'COUNT', 100])) as [string, string[]];
          cursor = scan[0];
          for (const k of scan[1] || []) {
            try {
              const result = await cmd(['GET', k]);
              if (result != null) {
                const data = typeof result === 'string' ? JSON.parse(result) : result;
                out.push({ roomId: k.replace(/^room:/, ''), data });
              }
            } catch (err) { console.error(`Failed to load ${k}:`, err); }
          }
        } while (cursor !== '0');
        return out;
      },
      async remove(roomId) { await cmd(['DEL', key(roomId)]); },
    };
  }

  // ── THE SCHEMA ─────────────────────────────────────────────────────────
  // Idempotent, and run on every boot. That costs one round trip and removes a
  // migration step somebody would otherwise have to remember on a new
  // environment — which, for a thing that is only ever set up twice, is the
  // trade worth making.
  // The identity tables ride the SAME idempotent boot DDL as the rest, so
  // replacing Supabase adds no migration step anyone has to remember.
  // Billing comes after identity because it ALTERs users, and these run in
  // order as one statement batch.
  const SCHEMA_SQL = IDENTITY_SCHEMA_SQL + BOARD_IMAGE_SCHEMA_SQL + BILLING_SCHEMA_SQL
    + MAIL_LOG_SCHEMA_SQL + `
    -- The durable copy of a live class. One JSON document per room, which is
    -- the shape the server already used; what Postgres adds is surviving a
    -- redeploy. Rooms used to live on the container filesystem, so every deploy
    -- silently threw away every saved lesson.
    CREATE TABLE IF NOT EXISTS rooms (
      room_id    text PRIMARY KEY,
      data       jsonb       NOT NULL,
      expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS rooms_expires_at_idx ON rooms (expires_at);

    -- ── The intelligence layer (spec P0/F0.1) ──
    -- Created now, written later. They are here so that a new environment is
    -- one deploy away from complete rather than one deploy plus a migration
    -- nobody documented.
    CREATE TABLE IF NOT EXISTS students (
      id         text PRIMARY KEY,
      name       text NOT NULL,
      grade      text,
      interests  jsonb       NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         text PRIMARY KEY,
      student_id text REFERENCES students(id) ON DELETE CASCADE,
      room_id    text,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at   timestamptz,
      topic      text,
      summary    jsonb
    );
    CREATE INDEX IF NOT EXISTS sessions_student_idx ON sessions (student_id, started_at DESC);

    -- The event spine (P1/F1.1). Append-only. The copilot, the student model
    -- and ParentLive are all derived from this one table, which is why it is
    -- worth creating before anything reads it.
    CREATE TABLE IF NOT EXISTS events (
      id         bigserial PRIMARY KEY,
      session_id text,
      room_id    text,
      student_id text,
      at         timestamptz NOT NULL DEFAULT now(),
      actor      text NOT NULL,
      kind       text NOT NULL,
      payload    jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id, at);
    CREATE INDEX IF NOT EXISTS events_student_idx ON events (student_id, at DESC);
    CREATE INDEX IF NOT EXISTS events_kind_idx    ON events (kind, at DESC);

    CREATE TABLE IF NOT EXISTS mastery (
      student_id text NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      skill_code text NOT NULL,
      band       text NOT NULL,
      evidence   integer NOT NULL DEFAULT 0,
      trend      text,
      last_seen  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (student_id, skill_code)
    );

    CREATE TABLE IF NOT EXISTS student_model (
      student_id     text PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
      misconceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
      preferences    jsonb NOT NULL DEFAULT '{}'::jsonb,
      reactions      jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id             text PRIMARY KEY,
      kind           text NOT NULL,
      topic          text,
      skill_codes    text[] NOT NULL DEFAULT '{}',
      html           text,
      section_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS artifacts_topic_idx ON artifacts (topic);

    CREATE TABLE IF NOT EXISTS parents (
      id         text PRIMARY KEY,
      student_id text REFERENCES students(id) ON DELETE CASCADE,
      email      text NOT NULL,
      token      text UNIQUE NOT NULL,
      consents   jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `;

  // Postgres — durable rooms, and the home the intelligence layer will need
  // anyway. Preferred over Redis for the reason a lesson is not a cache: a
  // class link is meant to work in a month, and Redis is built to forget.
  //
  // Note what this quietly fixes. restoreRooms() below returns early for any
  // store that is not `file`, so rooms lazy-load on join instead of every room
  // being hydrated into the heap at boot. That eager scan is what turned an
  // out-of-memory crash into an eight-hour crash loop: each retry re-loaded the
  // same too-large set and died at the same point.
  // ONE Pool, shared. Auth and records use the same database as the room
  // store, and a second pool would double connections against a Postgres
  // deliberately capped at 20 on a 1GB box.
  let appPool: InstanceType<typeof Pool> | null = null;
  // Set when the auth routes mount; the socket handshake verifies the same
  // cookie with it, so HTTP and WebSocket agree on who a teacher is.
  let sessionSecret: string | null = null;

  function makePostgresRoomStore(connectionString: string): RoomStore {
    // Railway's private network is already inside the trust boundary and
    // presents no TLS; anything reachable from outside needs it, and managed
    // providers routinely present certs a strict client refuses.
    const isInternal = /\.railway\.internal|@localhost|@127\.0\.0\.1/.test(connectionString);
    const pool = new Pool({
      connectionString,
      max: Number(process.env.PGPOOL_MAX) || 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ...(isInternal ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    // An idle client killed by the network must not take the process with it.
    pool.on('error', (err: Error) => console.error('Postgres pool error:', err.message));
    appPool = pool;

    // Deliberately never rejects. Nothing awaits this at boot, and an unhandled
    // rejection ends the process — which is the exact failure this whole change
    // exists to stop. A store that cannot answer is survivable: every caller
    // already handles it (a failed save is logged, a failed lazy-restore reads
    // as "room not here yet"), so the class degrades to non-durable instead of
    // going down.
    // The idempotent boot DDL first, then the versioned migrations on top of
    // it. Order matters and is not negotiable: a migration may ALTER a table
    // the batch above creates, so the batch has to have run. See migrate.ts for
    // why both exist rather than one replacing the other.
    const ready = pool.query(SCHEMA_SQL)
      .then(async () => {
        console.log('🗃️  Postgres schema ready');
        // Never allowed to reject: this whole promise is awaited by the room
        // store on every save, and an unhandled rejection here would end the
        // process — the exact failure the store was rewritten to avoid.
        try { await runMigrations(pool); }
        catch (err) { console.error('migrations could not run:', (err as Error).message); }
      })
      .catch((err: Error) => {
        console.error('Postgres schema failed — rooms will NOT persist:', err.message);
      });

    return {
      kind: 'postgres',
      async save(roomId, data, ttlSeconds) {
        await ready;
        const ttl = Math.max(60, Math.floor(ttlSeconds));
        await pool.query(
          `INSERT INTO rooms (room_id, data, expires_at, updated_at)
                VALUES ($1, $2::jsonb, now() + ($3::int * interval '1 second'), now())
           ON CONFLICT (room_id) DO UPDATE SET
                data       = EXCLUDED.data,
                expires_at = EXCLUDED.expires_at,
                updated_at = now()`,
          [roomId, JSON.stringify(data), ttl],
        );
      },
      async load(roomId) {
        await ready;
        const r = await pool.query(
          `SELECT data FROM rooms
            WHERE room_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
          [roomId],
        );
        return r.rows.length ? r.rows[0].data : null;
      },
      async loadAll() {
        await ready;
        const r = await pool.query(
          `SELECT room_id, data FROM rooms
            WHERE expires_at IS NULL OR expires_at > now()`,
        );
        return r.rows.map((row: { room_id: string; data: any }) => ({ roomId: row.room_id, data: row.data }));
      },
      async remove(roomId) {
        await ready;
        await pool.query('DELETE FROM rooms WHERE room_id = $1', [roomId]);
      },
    };
  }

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  // Railway injects DATABASE_URL when a Postgres service is attached, so the
  // durable path turns itself on. Upstash stays supported for anyone already
  // on it; files remain the local default so `npm run dev` needs no database.
  const DATABASE_URL = process.env.DATABASE_URL;
  const roomStore: RoomStore = DATABASE_URL
    ? makePostgresRoomStore(DATABASE_URL)
    : (UPSTASH_URL && UPSTASH_TOKEN)
      ? makeRedisRoomStore(UPSTASH_URL, UPSTASH_TOKEN)
      : fileRoomStore;
  console.log(
    roomStore.kind === 'postgres'
      ? '🗄️  Room store: Postgres — durable rooms enabled'
      : roomStore.kind === 'redis'
        ? '🗄️  Room store: Upstash Redis — durable rooms enabled'
        : '🗄️  Room store: .rooms/ files — set DATABASE_URL for durable rooms'
  );

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
      // So a student joining or reconnecting mid-share knows to expect the
      // tutor's screen rather than the lesson.
      teacherScreenOn: room.teacherScreenOn,
      password: room.password,
      scores: room.scores,
      revision: room.revision,
      // Persist the interaction sequence so it doesn't restart at 0 when a
      // restored room resumes — otherwise reconnecting clients (whose inbound
      // guard survives) would drop the "lower" fresh seqs. Clients also reset
      // their guard on reconnect, but keeping the server monotonic is belt-
      // and-suspenders for the durable-store path.
      interactionSeq: room.interactionSeq,
      liveSnapshotHtml: room.liveSnapshotHtml,
      whiteboard: room.whiteboard,
      annotations: room.annotations,
      whiteboardMode: room.whiteboardMode,
      // Persist the temporary explanation overlay so a server restart mid-class
      // doesn't drop it (SYNC.md lists tempContent as canonical state — it must
      // survive restart like every other canonical field).
      tempContent: room.tempContent,
      // Persist which gates each student already earned XP for — without this a
      // server restart forgets awards and the same checkpoint pays out again.
      gateAwarded: Array.from(room.gateAwarded),
      controlHolderName: room.controlHolderName,
      bookmarks: room.bookmarks,
      randomSeed: room.randomSeed,
      // Persisted, so a server restart mid-lesson does not cost the class its
      // place either — the tab that survives it re-seeds the room, and this puts
      // the lesson back where it was.
      lessonState: room.lessonState,
      // Bounded (EVENT_LOG_MAX) — survives restart so a late joiner right
      // after a redeploy still converges.
      eventLog: room.eventLog,
      eventLogOverflow: room.eventLogOverflow,
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
  // Whiteboard-only rooms (no files / lastRunHtml, but with strokes / objects
  // / shapes) SHOULD persist — otherwise a teacher who teaches purely on the
  // whiteboard loses their work on every redeploy.
  function roomHasContent(room: RoomData): boolean {
    return (
      room.files.length > 0 ||
      !!room.lastRunHtml ||
      !!room.tempContent ||
      (room.chat?.length ?? 0) > 0 ||
      (room.whiteboard?.objects?.length ?? 0) > 0 ||
      (room.whiteboard?.strokes?.length ?? 0) > 0 ||
      (room.whiteboard?.shapes?.length ?? 0) > 0 ||
      (room.whiteboard?.texts?.length ?? 0) > 0
    );
  }

  // TTL mirrors the room's claim-aware expiry so the durable store self-cleans
  // even for rooms that are only ever lazy-loaded (never resident in memory
  // for the in-process sweep to catch).
  function saveSingleRoom(roomId: string, room: RoomData): Promise<void> {
    const ttlSeconds = Math.max(60, Math.floor((computeExpiresAt(room) - Date.now()) / 1000));
    return roomStore.save(roomId, serializeRoom(roomId, room), ttlSeconds)
      .catch(err => { console.error(`Failed to persist room ${roomId}:`, err); });
  }

  let saveInFlight = false;
  async function saveRooms() {
    if (saveInFlight) return;
    saveInFlight = true;
    try {
      const writes: Promise<void>[] = [];
      let attempted = 0;
      for (const [roomId, room] of rooms.entries()) {
        if (!roomHasContent(room)) continue;
        attempted++;
        writes.push(saveSingleRoom(roomId, room));
      }
      await Promise.all(writes);
      if (attempted > 0) console.log(`💾 Persisted ${attempted} rooms → ${roomStore.kind}`);
    } finally {
      saveInFlight = false;
    }
  }

  // ─── DEBOUNCED PER-ROOM SAVE (near-instant durability) ──────────────────
  // The 5-min interval + save-on-teacher-disconnect already cover graceful
  // shutdowns, but a hard crash could lose up to ~5 min of the latest work.
  // To shrink that window we persist a room a few seconds after any mutating
  // event. A per-room debounce (skip if one is already scheduled) coalesces
  // bursts — e.g. a flurry of whiteboard strokes results in ONE write, not
  // hundreds — keeping us well within Upstash free-tier command budgets.
  const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
  const SAVE_DEBOUNCE_MS = 3000;
  async function persistRoom(roomId: string) {
    const room = rooms.get(roomId);
    if (!room || !roomHasContent(room)) return;
    await saveSingleRoom(roomId, room);
  }
  function scheduleSave(roomId: string) {
    if (!roomId || pendingSaves.has(roomId)) return;
    const timer = setTimeout(() => {
      pendingSaves.delete(roomId);
      void persistRoom(roomId);
    }, SAVE_DEBOUNCE_MS);
    // Don't let a pending save keep the process alive at shutdown.
    if (typeof timer.unref === 'function') timer.unref();
    pendingSaves.set(roomId, timer);
  }

  // Journaled interactions are deliberately NOT in MUTATING_EVENTS (a save on
  // every click would storm). But the interaction journal is what a
  // reconnecting / late-joining client replays to rebuild the lesson's live
  // screen — if a cold-start/restart loses it, the whole class rebuilds from
  // the pristine baseline and desyncs ("works at the start, drifts in between").
  // So persist the journal on a COARSE throttle (coalesced): fresh enough that
  // a restart loses at most a few seconds of navigation, cheap enough that
  // rapid clicking doesn't thrash the store. Only meaningful with a durable
  // store (Upstash); on the ephemeral file store it is a harmless no-op-ish.
  const lastJournalSaveAt = new Map<string, number>();
  const JOURNAL_SAVE_MIN_INTERVAL_MS = 4000;
  function scheduleJournalSave(roomId: string) {
    if (!roomId) return;
    const now = Date.now();
    if (now - (lastJournalSaveAt.get(roomId) || 0) < JOURNAL_SAVE_MIN_INTERVAL_MS) return;
    lastJournalSaveAt.set(roomId, now);
    scheduleSave(roomId);
  }

  // Events that change persisted room state. A mutation in any of these
  // schedules a debounced save for that room. High-frequency / transient
  // events (interaction, cursor, laser, pan/zoom view, scroll) are
  // deliberately excluded — they'd cause save storms and carry no durable
  // state worth flushing eagerly.
  const MUTATING_EVENTS = new Set<string>([
    'set_room_password', 'upload_file', 'update_file', 'delete_file', 'switch_file',
    'run_preview', 'sync_html_update', 'dom_snapshot',
    'toggle_scroll_sync', 'toggle_student_interaction', 'zoom_changed',
    'draw_stroke', 'draw_delete_stroke', 'draw_clear',
    'whiteboard_draw', 'whiteboard_set_image', 'whiteboard_add_image',
    'whiteboard_update_object', 'whiteboard_remove_object',
    'whiteboard_add_shape', 'whiteboard_update_shape', 'whiteboard_remove_shape',
    'whiteboard_set_grid_mode', 'whiteboard_add_instrument', 'whiteboard_update_instrument',
    'whiteboard_remove_instrument', 'whiteboard_add_text', 'whiteboard_update_text',
    'whiteboard_remove_text', 'whiteboard_clear', 'whiteboard_reset',
    'whiteboard_delete_stroke', 'whiteboard_delete_strokes', 'whiteboard_mode_toggle',
    'show_temp_content', 'clear_temp_content',
    'explanation_show', 'explanation_delete', 'explanation_clear',
    'set_step', 'add_gate', 'gate_answer', 'claim_room', 'hard_reset', 'send_chat',
    'grant_control', 'bookmark_create', 'bookmark_restore', 'bookmark_delete',
  ]);

  // Build an in-memory RoomData from a persisted blob. Shared by the eager
  // boot restore AND the lazy on-join restore, so both paths hydrate rooms
  // identically.
  function hydrateRoom(raw: any): RoomData {
    const now = Date.now();
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
    // `!== false`, not `!!`. A room saved before interaction defaulted to on
    // has no such field, and `!!undefined` would restore it view-only — so a
    // tutor's existing class would silently keep the old locked behaviour
    // while new rooms behaved differently. A tutor who deliberately switched
    // interaction OFF stored an explicit false, and that is still honoured.
    room.studentInteractionAllowed = raw.studentInteractionAllowed !== false;
    room.password = raw.password || null;
    room.scores = raw.scores || {};
    room.revision = raw.revision || 0;
    room.interactionSeq = raw.interactionSeq || 0;
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
    room.lessonState = raw.lessonState && typeof raw.lessonState.state === 'string' ? raw.lessonState : null;
    room.zoomLevel = raw.zoomLevel || 1;
    // Restore the temporary explanation overlay (see serializeRoom).
    room.tempContent = (raw.tempContent && typeof raw.tempContent === 'object')
      ? { html: String(raw.tempContent.html ?? ''), name: String(raw.tempContent.name ?? '') }
      : null;
    // Restore gate-XP awards so a restart can't be used to re-farm checkpoints.
    room.gateAwarded = new Set(Array.isArray(raw.gateAwarded) ? raw.gateAwarded.filter((k: unknown) => typeof k === 'string') : []);
    room.controlHolderName = typeof raw.controlHolderName === 'string' ? raw.controlHolderName : null;
    room.bookmarks = Array.isArray(raw.bookmarks)
      ? raw.bookmarks.filter((b: any) => b && typeof b.id === 'string').slice(0, 8)
      : [];
    room.eventLog = Array.isArray(raw.eventLog) ? raw.eventLog.slice(0, EVENT_LOG_MAX) : [];
    room.eventLogOverflow = !!raw.eventLogOverflow;
    room.randomSeed = typeof raw.randomSeed === 'number' ? raw.randomSeed : 0;
    return room;
  }

  async function restoreRooms() {
    // Durable stores (Redis) lazy-load rooms on join — see join_room — so we
    // skip the eager boot scan: it would burn commands and add cold-start
    // latency, and it races a fast first joiner anyway. The file store is
    // cheap to scan eagerly and keeps the in-memory expiry sweep populated.
    if (roomStore.kind !== 'file') {
      console.log('📂 Durable store active — rooms lazy-load on join');
      return;
    }
    try {
      const entries = await roomStore.loadAll();
      const now = Date.now();
      let restored = 0;
      let cleaned = 0;
      for (const { roomId, data: raw } of entries) {
        try {
          if (!storedRoomFresh(raw)) {
            await roomStore.remove(roomId);
            cleaned++;
            continue;
          }
          rooms.set(raw.roomId || roomId, hydrateRoom(raw));
          restored++;
        } catch (err) {
          console.error(`Failed to restore ${roomId}:`, err);
        }
      }
      if (restored > 0) console.log(`📂 Restored ${restored} rooms from disk`);
      if (cleaned > 0) console.log(`🧹 Cleaned ${cleaned} stale room files`);
    } catch (err) {
      console.error('Failed to restore rooms:', err);
    }
  }

  // Restore rooms on startup (async; durable stores lazy-load on join instead)
  void restoreRooms().catch(err => console.error('restoreRooms failed:', err));

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
    const list: Array<{ id: string; name: string; role: string; tz?: string }> = [];
    room.users.forEach((user, id) => {
      const entry: { id: string; name: string; role: string; tz?: string } = { id, name: user.name, role: user.role };
      // Only present when the client sent one. A class pack records each
      // participant's timezone so the clock times in it mean something to a
      // reader who wasn't in the room; an old client that doesn't send it
      // leaves the field null rather than guessing the tutor's zone.
      if (user.tz) entry.tz = user.tz;
      list.push(entry);
    });
    return list;
  }

  // IANA zone names only ("Asia/Kolkata", "Europe/London", "UTC"). Anything
  // else — including a free-text offset a caller might invent — is dropped, so
  // this field can never carry arbitrary client text into the pack.
  function safeTimezone(tz: unknown): string | undefined {
    if (typeof tz !== 'string' || tz.length > 64) return undefined;
    if (!/^(UTC|[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2})$/.test(tz)) return undefined;
    return tz;
  }

  function buildLeaderboard(room: RoomData) {
    return Object.entries(room.scores)
      .map(([n, sc]) => ({ studentName: n, xp: sc.xp, streak: sc.streak, bestStreak: sc.bestStreak, correct: sc.correct, total: sc.total }))
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 20);
  }

  // ─── INPUT VALIDATION HELPERS ───
  const MAX_CHAT_LENGTH = 2000;
  const MAX_USERNAME_LENGTH = 50;
  const MAX_ROOM_ID_LENGTH = 20;
  const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file
  // Explanations are kept in memory for the life of the room, so the list is
  // bounded: 8 × 2MB is a sane ceiling for one lesson's worth of explainers.
  const MAX_EXPLANATIONS = 8;
  const MAX_QUIZ_QUESTION_LENGTH = 500;
  // 50 files at 2MB each allowed ONE room to hold 100MB — on an instance with
  // 512MB for everything. That ceiling could never be honoured; a room that
  // approached it took the whole service down, which is how this ended up
  // suspended. Twelve is still more lessons than a room needs and caps the
  // worst case at ~24MB. Raise MAX_FILES_PER_ROOM on a bigger instance.
  const MAX_FILES_PER_ROOM = Number(process.env.MAX_FILES_PER_ROOM) || 12;

  function sanitizeString(str: unknown, maxLen: number): string {
    if (typeof str !== 'string') return '';
    return str.slice(0, maxLen).trim();
  }

  function isValidRoomId(roomId: unknown): roomId is string {
    return typeof roomId === 'string' && roomId.length > 0 && roomId.length <= MAX_ROOM_ID_LENGTH && /^[a-zA-Z0-9_-]+$/.test(roomId);
  }

  // ─── TEACHER OWNERSHIP ENFORCEMENT (Stage 3) ───
  // When Supabase is configured server-side, a room that corresponds to a
  // registered class can only be DRIVEN by its owning teacher. We offload the
  // crypto to Supabase: verify the access token via /auth/v1/user, then read
  // the class owner via the service role (bypassing RLS so we can tell
  // "not the owner" apart from "no such class"). Ad-hoc rooms (no class row)
  // keep the legacy name-based behaviour. Entirely gated by env — absent →
  // no enforcement, identical to before.
  // Ownership is enforced from OUR database now. It used to require three
  // Supabase environment variables, one of which (the service-role key) was
  // never set — so this protection has in practice been off. With the classes
  // table local, "is this room registered, and is this socket its owner" is a
  // single query against data we already hold.
  const ownershipEnabled = () => !!(appPool && sessionSecret);

  // ─── AI LESSON GENERATION (server-side; key never reaches the browser) ───
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  console.log(
    GEMINI_API_KEY
      ? '✨ AI lesson generation: ON'
      : '✨ AI lesson generation: OFF (set GEMINI_API_KEY to enable)'
  );
  // Ownership is reported where the auth routes mount, not here: this runs
  // before sessionSecret is assigned, so any answer given now would be a guess
  // that reads as fact.

  // Returns 'allow' | 'reject'. Fails OPEN (allow) on any transient error so a
  // Supabase hiccup never locks a teacher out of their own class; only a
  // definitive "this class belongs to someone else" rejects.
  async function verifyTeacherOwnership(roomId: string, cookieHeader: unknown): Promise<'allow' | 'reject'> {
    if (!ownershipEnabled()) return 'allow';
    try {
      // 1) Is this room a REGISTERED class, and who owns it? An ad-hoc room —
      //    the ordinary /live link a tutor makes on the spot — has no row here
      //    and is deliberately unenforced, exactly as before.
      const cls = await appPool!.query(
        'SELECT teacher_id FROM classes WHERE room_code = $1',
        [roomId],
      );
      if (cls.rowCount === 0) return 'allow';
      const ownerId = cls.rows[0].teacher_id as string;

      // 2) Registered class → the socket must carry a valid session cookie
      //    whose user IS the owner. The cookie is verified by HMAC here, not
      //    by asking a third party over the network: no round trip, and no
      //    outage in someone else's service can lock a teacher out of a class
      //    they own.
      const user = userFromCookieHeader(
        typeof cookieHeader === 'string' ? cookieHeader : undefined,
        sessionSecret!,
      );
      return user && user.id === ownerId ? 'allow' : 'reject';
    } catch (err) {
      // Fail OPEN, on purpose. This check protects against one teacher opening
      // another's room; a database hiccup must not lock a tutor out of their
      // own lesson with a child waiting.
      console.error(`Ownership check failed for ${roomId} (failing open):`, (err as Error).message);
      return 'allow';
    }
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

  // May this socket SKETCH over the lesson (annotation overlay)? Teacher
  // always; a student only when interaction is enabled OR they hold control.
  // A view-only student is a pure viewer — strokes are rejected so they can't
  // scribble on everyone's screen via devtools.
  function requireTeacherOrAnnotator(room: RoomData | undefined, socketId: string): room is RoomData {
    if (!room || !room.users.has(socketId)) return false;
    if (room.teacherSocketId === socketId) return true;
    if (room.studentInteractionAllowed) return true;
    const u = room.users.get(socketId);
    return !!(u && u.name && u.name === room.controlHolderName);
  }

  function bumpRevision(room: RoomData): number {
    room.revision += 1;
    return room.revision;
  }

  // Which lesson a stored state belongs to. Cheap and stable — the point is
  // only to notice that the lesson CHANGED, not to identify it cryptographically.
  function contentKey(html: string | null): string {
    if (!html) return '';
    let h = 5381;
    for (let i = 0; i < html.length; i++) h = ((h * 33) ^ html.charCodeAt(i)) >>> 0;
    return h.toString(36) + '-' + html.length.toString(36);
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
    // ── effectiveHtml policy (first principles) ──
    // When a replayable event journal exists, clients boot the PRISTINE
    // lesson and re-live the journal — that reconstructs JS-internal sim
    // state exactly. A DOM snapshot can't: the lesson's scripts restart from
    // zero on load and repaint their initial screen right over the
    // snapshot's HTML (the "joined mid-quiz but landed on the welcome
    // screen" bug). Snapshots remain the fallback when no journal is
    // available (overflowed or empty) — still right for DOM/form-state
    // content.
    const replayable = room.eventLog.length > 0 && !room.eventLogOverflow;
    const effectiveHtml = replayable
      ? (room.lastRunHtml || sourceHtml || room.liveSnapshotHtml)
      : (room.liveSnapshotHtml || room.lastRunHtml || sourceHtml);
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
      // Where the lesson had got to — but only if it belongs to the lesson we
      // are about to hand over. A state from a different lesson is worse than
      // none: it would put the class somewhere that never existed.
      lessonState: (room.lessonState && room.lessonState.forHtml === contentKey(room.lastRunHtml))
        ? room.lessonState.state : null,
      files: room.files,
      isPaused: room.isPaused,
      scrollSyncEnabled: room.scrollSyncEnabled,
      studentInteractionAllowed: room.studentInteractionAllowed,
      currentStep: room.currentStep,
      gates: room.gates,
      tempContent: room.tempContent,
      // Names only — the teacher's tab strip needs to survive a reload without
      // shipping every explainer's body on every hydration.
      explanations: room.explanations.map(e => ({ id: e.id, name: e.name })),
      activeExplanationId: room.activeExplanationId,
      // So a student joining or reconnecting mid-share expects the tutor's
      // screen rather than sitting on a lesson they have moved past.
      teacherScreenOn: room.teacherScreenOn,
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
      controlHolderName: room.controlHolderName,
      bookmarks: room.bookmarks.map(b => ({ id: b.id, name: b.name, ts: b.ts })),
      randomSeed: room.randomSeed,
      interactionSeq: room.interactionSeq,
      // A clip the teacher is showing right now. The stored position is from
      // the last heartbeat, so wind it forward by the time since — otherwise a
      // student joining 20s later starts 20s behind everyone else.
      sharedVideo: room.sharedVideo
        ? {
            videoId: room.sharedVideo.videoId,
            playing: room.sharedVideo.playing,
            time: room.sharedVideo.playing
              ? room.sharedVideo.time + Math.max(0, (Date.now() - room.sharedVideo.updatedAt) / 1000)
              : room.sharedVideo.time,
          }
        : null,
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

  // Quiz/gate answers must never reach students. buildSessionState includes
  // the full gate definition (with correctIndex) because the teacher needs it;
  // before any student-bound emit we replace correctIndex with -1 so the answer
  // key can't be read out of devtools. Server-side grading (gate_answer) is
  // unaffected — it reads from room.gates, not the wire payload.
  function sanitizeGatesForStudent(gates: SessionStatePayload['gates']): SessionStatePayload['gates'] {
    const out: SessionStatePayload['gates'] = {};
    for (const [step, gate] of Object.entries(gates)) {
      out[Number(step)] = { question: gate.question, options: gate.options, correctIndex: -1 };
    }
    return out;
  }
  function payloadForStudent(payload: SessionStatePayload): SessionStatePayload {
    return { ...payload, gates: sanitizeGatesForStudent(payload.gates) };
  }

  function emitSessionState(socketId: string, roomId: string, room: RoomData, reason: SessionStatePayload['reason'], requestId?: string) {
    const payload = buildSessionState(roomId, room, 'session_state', reason, requestId);
    const isTeacher = room.users.get(socketId)?.role === 'teacher';
    io.to(socketId).emit('session_state', isTeacher ? payload : payloadForStudent(payload));
    // Hand the event journal to EVERY hydrating member (teacher included — a
    // reloaded teacher must re-live their own lesson back to the current
    // state). Clients filter by serverSeq against what their current sim
    // instance already applied, so re-sending the same journal is always
    // safe: fresh sims replay everything, live sims replay only the gap,
    // up-to-date sims replay nothing.
    if (room.eventLog.length > 0 && !room.eventLogOverflow) {
      io.to(socketId).emit('interaction_replay', { events: room.eventLog, count: room.eventLog.length });
      logSync('interaction_replay', { roomId, revision: room.revision, socketId, reason: `events=${room.eventLog.length}` });
    }
    logSync('session_state', { roomId, revision: payload.revision, requestId, socketId, reason });
  }

  function broadcastFullState(roomId: string, room: RoomData, reason: SessionStatePayload['reason'], requestId?: string) {
    const payload = buildSessionState(roomId, room, 'sync_full_state', reason, requestId);
    // Teacher gets the answer key; everyone else gets the sanitized copy. When
    // no live teacher socket is resolvable, the whole room gets sanitized — the
    // safe default (students never receive correctIndex).
    const teacherId = room.teacherSocketId;
    const teacherLive = !!teacherId && room.users.get(teacherId)?.role === 'teacher';
    if (teacherLive) {
      io.to(teacherId!).emit('sync_full_state', payload);
      io.to(roomId).except(teacherId!).emit('sync_full_state', payloadForStudent(payload));
    } else {
      io.to(roomId).emit('sync_full_state', payloadForStudent(payload));
    }
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

  // ─── SITE PASSCODE ───
  //
  // A single shared code that everyone — tutor and student — must present
  // before the app will do anything. It exists because this account's monthly
  // quota was exhausted by traffic the owner did not control, and resuming a
  // suspended service without a gate simply hands the quota back to whoever
  // logs in first.
  //
  // Checked at the SOCKET HANDSHAKE, not in the browser. A page that hides
  // itself is not a gate: anyone can open the console, or point a socket
  // client at the server, and the load lands all the same. Refusing the
  // handshake means an unauthorised client cannot make the server do work at
  // all — which is the entire point when the constraint is a usage quota.
  //
  // Unset = disabled, so local development and any deployment that does not
  // want a gate are unaffected. Never hardcoded: a passcode in the repository
  // is a passcode published to anyone who can read the repository.
  const SITE_PASSCODE = (process.env.SITE_PASSCODE || '').trim();
  const passcodeRequired = SITE_PASSCODE.length > 0;
  if (passcodeRequired) {
    console.log('🔒 Site passcode is ON — every connection must present it');
  }

  /** Constant-time-ish compare, so the check cannot be timed character by character. */
  function passcodeOk(given: unknown): boolean {
    if (!passcodeRequired) return true;
    if (typeof given !== 'string' || given.length !== SITE_PASSCODE.length) return false;
    let diff = 0;
    for (let i = 0; i < SITE_PASSCODE.length; i++) diff |= given.charCodeAt(i) ^ SITE_PASSCODE.charCodeAt(i);
    return diff === 0;
  }

  // ─── CONNECTION FLOOD GUARD ───
  //
  // Deliberately loose, and the number matters. A browser whose network is
  // flapping mid-lesson retries roughly once a second before Socket.IO's
  // backoff widens; a tutor and two students on one home connection share one
  // address, so a bad ten minutes can honestly produce a few hundred attempts
  // an hour from a household that is doing nothing wrong. Refusing them would
  // end the lesson this guard exists to protect.
  //
  // 300 a minute from one address is therefore not "busy" — it is a script.
  // The per-event limits inside a connection (200/400 per second) remain the
  // real defence against a connected client behaving badly.
  const connectionLimiter = makeLimiter({
    name: 'socket-connect',
    windowMs: 60_000,
    max: Number(process.env.SOCKET_CONNECT_PER_MIN) || 300,
  });
  io.use((socket, next) => {
    const decision = connectionLimiter.check(handshakeIp(socket.handshake as any));
    if (decision.allowed) return next();
    // Not the passcode message: the client must not turn this into a prompt.
    next(new Error('too_many_connections'));
  });

  io.use((socket, next) => {
    if (!passcodeRequired) return next();
    const given = (socket.handshake.auth as { passcode?: string } | undefined)?.passcode;
    if (passcodeOk(given)) return next();
    // The client turns this exact message into the passcode prompt.
    next(new Error('passcode_required'));
  });

  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // HARDENING (server-wide): almost every handler below destructures its first
    // argument — `socket.on('x', ({ roomId, ... }) => ...)`. Destructuring a
    // `null`/`undefined` payload throws AT THE PARAMETER, before any in-handler
    // guard can run, and because these are async socket handlers that throw is
    // uncaught — it crashes the whole Node process and every room with it. A
    // hostile or buggy client emitting `socket.emit('join_room', null)` should
    // never be able to do that. This middleware runs before every event on this
    // socket and coerces a nullish first payload to `{}`, so destructuring is
    // always safe and each handler's own validation handles the empty object.
    socket.use((packet, next) => {
      try {
        if (Array.isArray(packet) && packet.length >= 2 && (packet[1] === null || packet[1] === undefined)) {
          packet[1] = {};
        }
      } catch (ignore) {}
      next();
    });

    // AUTONOMOUS: [ORDER-3 FRICTION] - ping/pong for the client-side
    // latency indicator. Client emits `ping` with a timestamp; we echo it
    // back as `pong` and the client measures RTT. Stateless, cheap (only
    // emitted when the user has the room open), and no impact on
    // existing flows because nothing else listens for these events.
    socket.on('ping', (data: { ts: number }) => {
      socket.emit('pong', { ts: data?.ts ?? Date.now() });
    });

    // Near-instant durability: any mutating event schedules a debounced save
    // for that room. Single observer — touches no handler logic. Reads roomId
    // from the (conventional) first-arg payload; non-mutating or roomId-less
    // events are ignored, and scheduleSave no-ops if the room isn't resident.
    socket.onAny((eventName: string, ...eventArgs: any[]) => {
      if (!MUTATING_EVENTS.has(eventName)) return;
      const rid = eventArgs?.[0]?.roomId;
      if (typeof rid === 'string') scheduleSave(rid);
    });

    // ─── JOIN ROOM ───
    socket.on('join_room', async ({ roomId, userName, role, password, authToken, tz, clientId }: { roomId: string; userName: string; role: 'teacher' | 'student'; password?: string; authToken?: string; tz?: string; clientId?: string }) => {
      // Validate inputs
      if (!isValidRoomId(roomId)) {
        socket.emit('join_error', { code: 'bad_room', retryable: false, message: 'Invalid room code' });
        return;
      }
      const safeName = sanitizeString(userName, MAX_USERNAME_LENGTH) || 'Anonymous';
      if (role !== 'teacher' && role !== 'student') {
        socket.emit('join_error', { code: 'bad_role', retryable: false, message: 'Invalid role' });
        return;
      }

      let existingRoom = rooms.get(roomId);
      // Durable lazy-restore: if the room isn't live in memory (server
      // cold-started, was evicted, or this is the first joiner after a
      // redeploy) try to bring it back from the durable store before deciding
      // anything. This is the mechanism that lets a student open a *permanent*
      // class link at any time — even after the server slept and even before
      // the teacher arrives. Without it the student would hit "Room not found".
      if (!existingRoom) {
        try {
          const raw = await roomStore.load(roomId);
          const fresh = storedRoomFresh(raw);
          if (fresh) {
            // Move any pasted pictures out of the room BEFORE it is hydrated.
            //
            // Whiteboard images used to be data: URLs on the board objects, so
            // a room was as big as every photo ever pasted into it. One reached
            // 128MB and took the heap from 78MB to 454MB the moment it opened,
            // killing the process every few minutes. Converting on the way IN
            // is the point: externalising only at save time would still mean
            // holding all of it for the length of the lesson.
            //
            // Safe to run on an already-converted board — a src that is a URL
            // rather than a data: URL is left untouched — so this both fixes
            // the boards that exist and costs nothing once they are fixed.
            if (appPool && raw && raw.whiteboard) {
              try {
                const moved = await externaliseBoardImages(appPool, raw.whiteboard);
                if (moved > 0) {
                  console.log(`🖼️  Moved ${moved} board image(s) out of room ${roomId}`);
                  // Write the slimmed room straight back, so the next open is
                  // cheap even if this process dies before the next save.
                  void roomStore.save(roomId, raw, 30 * 24 * 3600).catch(() => {});
                }
              } catch (err) {
                console.error(`Board image conversion failed for ${roomId}:`, (err as Error).message);
              }
            }
            existingRoom = hydrateRoom(raw);
            rooms.set(roomId, existingRoom);
            console.log(`📂 Lazy-restored room ${roomId} from ${roomStore.kind} on join`);
          }
        } catch (err) {
          console.error(`Lazy restore failed for ${roomId}:`, err);
        }
      }
      if (!existingRoom && role !== 'teacher') {
        // NOT an error — the teacher simply has not opened the room yet, which
        // is the normal state for a student who clicks their link two minutes
        // early. It used to render a dead end whose only button was "Go home",
        // so the student reloaded until the teacher happened to be in. The
        // code lets the client tell "wait, it's coming" apart from "this will
        // never work" (wrong password, someone else's class) and wait instead.
        socket.emit('join_error', {
          code: 'room_not_open',
          retryable: true,
          message: 'Your teacher has not opened the room yet.',
        });
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

      // ── Ownership enforcement (Stage 3) ──
      // For a registered class, only the owning (signed-in) teacher may take
      // the teacher seat. No-op unless Supabase is configured server-side and
      // the room is a registered class; ad-hoc rooms fall through to the
      // legacy name-based gate below.
      if (role === 'teacher' && ownershipEnabled()) {
        // The session travels as an HttpOnly cookie now, which the browser
        // attaches to the socket handshake automatically — the client no
        // longer has to (and no longer can) read a token out of storage and
        // hand it over. authToken stays accepted in the payload for older
        // tabs still open on the previous build.
        const decision = await verifyTeacherOwnership(roomId, socket.handshake.headers.cookie);
        if (decision === 'reject') {
          socket.emit('join_error', { code: 'not_owner', retryable: false, message: 'This class belongs to another teacher. Please sign in as the owner.' });
          return;
        }
      }

      // ── Subscription gate ──
      // A signed-in teacher whose free trial has ended, and who has not paid,
      // cannot take the teacher seat. Two things this deliberately does NOT do:
      //
      //   * It never runs for students. A child must never be locked out of a
      //     lesson because the adult's card expired.
      //   * It never interrupts a lesson already in progress — it is checked
      //     when taking the seat, not on a timer.
      if (role === 'teacher' && appPool && sessionSecret) {
        const who = userFromCookieHeader(socket.handshake.headers.cookie, sessionSecret);
        if (who) {
          try {
            const access = await accessForTeacher(appPool, who.id);
            if (access.state === 'expired') {
              socket.emit('join_error', {
                code: 'subscription_expired',
                retryable: false,
                message: 'Your free trial has ended. Subscribe to keep teaching.',
              });
              return;
            }
          } catch (err) {
            // Fail OPEN, for the same reason ownership does: a database hiccup
            // must not cancel a lesson with a child already waiting.
            console.error(`Subscription check failed for ${who.email} (failing open):`, (err as Error).message);
          }
        }
      }

      // ── B4: the anonymous demo has a clock ──
      //
      // "Start teaching" needs no account, which is right — a tutor deciding
      // whether this is for them should not have to sign up to find out. Left
      // unbounded it is also a way to use the product forever without ever
      // meeting the paywall.
      //
      // So it stays, with a limit: an ad-hoc room driven by nobody in
      // particular teaches for DEMO_MINUTES and then stops. That converts
      // better as a demo than it costs as a leak.
      //
      // The instant a signed-in teacher in good standing takes the seat, the
      // clock is cleared — at that point it is somebody's lesson, not a demo.
      if (role === 'teacher') {
        const signedIn = sessionSecret
          ? userFromCookieHeader(socket.handshake.headers.cookie, sessionSecret)
          : null;
        if (signedIn) {
          room.demoUntil = null;
        } else if (!room.demoUntil) {
          let registered = false;
          if (appPool && ownershipEnabled()) {
            try {
              const cls = await appPool.query('SELECT 1 FROM classes WHERE room_code = $1', [roomId]);
              registered = (cls.rowCount ?? 0) > 0;
            } catch {
              // Fail OPEN: a database hiccup must not start a countdown on a
              // real teacher's lesson.
              registered = true;
            }
          }
          if (!registered) room.demoUntil = Date.now() + DEMO_MINUTES * 60_000;
        }
      }
      if (room.demoUntil && Date.now() > room.demoUntil) {
        socket.emit('join_error', {
          code: 'demo_over', retryable: false,
          message: `This free demo room has ended. Sign up — it takes a minute, and the first ${'7'} days are free.`,
        });
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
          socket.emit('join_error', { code: 'teacher_taken', retryable: false, message: 'Another teacher is already in this room.' });
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
      room.users.set(socket.id, { name: safeName, role, joinedAt: Date.now(), whiteboardSync: true, tz: safeTimezone(tz),
        clientId: typeof clientId === 'string' ? clientId.slice(0, 40).replace(/[^0-9a-f]/g, '') : undefined });

      // Any join (teacher OR student) means the room is active again — clear the
      // last-student-left expiry countdown so the sweep won't target a room
      // that now has someone in it.
      room.studentLeftAt = null;

      if (role === 'teacher') {
        const previousTeacherSocketId = room.teacherSocketId;

        // Cancel any pending teacher-disconnect grace timer on ANY successful
        // teacher (re)seat — not only an exact-name match. The seat is being
        // taken right here (below), so the timer's job is done; leaving it
        // armed leaks the handle and risks a late "teacher_disconnected" if the
        // returning teacher's display name differs (e.g. a co-teacher, or a
        // name edit). Keying the cancel strictly by name was a mismatch with
        // the unconditional re-seat that follows.
        if (room.pendingTeacherDisconnect) {
          clearTimeout(room.pendingTeacherDisconnect.timer);
          room.pendingTeacherDisconnect = undefined;
          console.log(`✅ Teacher ${safeName} (re)took the seat within grace — no disconnect announced`);
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
        // Don't re-push the lesson HTML while on the whiteboard — students are
        // (correctly) showing the whiteboard surface; a run_preview here would
        // rebuild their hidden lesson iframe needlessly and risk a race.
        if (room.lastRunHtml && room.activeFileId && !room.whiteboardMode) {
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
        gates: role === 'teacher' ? room.gates : sanitizeGatesForStudent(room.gates),
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

      // Deliver existing scores to the joining client so a refreshed student's
      // XP/streak pill doesn't reset to 0 until the next gate answer (the
      // client derives its own stats from leaderboard_update).
      if (Object.keys(room.scores).length > 0) {
        socket.emit('leaderboard_update', buildLeaderboard(room));
      }

      // (Event-journal replay is attached by emitSessionState above — every
      // hydrating member gets it, and clients seq-filter what they've
      // already applied.)

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
      newContentBaseline(room);
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

    // ─── AI LESSON GENERATION ───
    // Teacher describes a concept; we generate a self-contained interactive
    // HTML widget with Gemini (server-side) and load it into the room exactly
    // like an uploaded file. Key stays on the server.
    socket.on('generate_lesson', async ({ roomId, prompt }: { roomId: string; prompt: string }) => {
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (!GEMINI_API_KEY) {
        socket.emit('generate_lesson_error', { message: 'AI is not configured on the server (set GEMINI_API_KEY).' });
        return;
      }
      const safePrompt = sanitizeString(prompt, 2000);
      if (!safePrompt) {
        socket.emit('generate_lesson_error', { message: 'Describe the lesson you want generated.' });
        return;
      }
      try {
        const { GoogleGenAI } = await import('@google/genai');
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const instruction = `You are an expert creator of single-file, self-contained INTERACTIVE HTML teaching widgets for a LIVE maths classroom shown inside a sandboxed iframe.
Output ONLY raw HTML — no markdown, no code fences, no commentary before or after.
Hard requirements:
- One single HTML document. ALL CSS and JavaScript inline. NO external resources, CDNs, web fonts, images by URL, or network calls (the iframe is sandboxed and offline).
- Large, high-contrast, readable typography. Centered, responsive layout that fills the viewport.
- Genuinely INTERACTIVE: buttons/inputs the student manipulates, with clear step-by-step feedback.
- Prefer keeping visible state in the DOM (text content, classes, input values) so it mirrors cleanly between screens.
- Must run immediately on load with zero console errors. Keep it robust and self-contained.
Build a widget that teaches: ${safePrompt}`;
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: instruction });
        let html = (response.text || '').trim();
        // Strip accidental markdown fences if the model added them.
        html = html.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
        if (html.length < 30) {
          socket.emit('generate_lesson_error', { message: 'The AI returned an empty lesson. Try rephrasing.' });
          return;
        }
        if (html.length > MAX_FILE_SIZE) html = html.slice(0, MAX_FILE_SIZE);

        // Load it like an uploaded file (same broadcast as upload_file).
        const file: FileEntry = {
          id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: safePrompt.length > 40 ? safePrompt.slice(0, 40) + '…' : safePrompt,
          html,
          uploadedAt: Date.now(),
        };
        room.files.push(file);
        room.activeFileId = file.id;
        room.lastRunHtml = html;
        room.liveSnapshotHtml = null;
        newContentBaseline(room);
        const wasWhiteboard = room.whiteboardMode;
        if (wasWhiteboard) room.whiteboardMode = false;
        const revision = bumpRevision(room);
        io.to(roomId).emit('file_uploaded', file);
        io.to(roomId).emit('active_file_changed', { fileId: file.id, fileName: file.name, html, currentStep: room.currentStep, revision });
        if (wasWhiteboard) io.to(roomId).emit('whiteboard_mode_changed', { active: false });
        broadcastFullState(roomId, room, 'run_preview');
        io.to(roomId).emit('run_preview', { fileId: file.id, html, revision });
        socket.emit('generate_lesson_done', { fileId: file.id, name: file.name });
        logSync('generate_lesson', { roomId, revision });
      } catch (err) {
        console.error('generate_lesson failed:', err);
        socket.emit('generate_lesson_error', { message: 'AI generation failed — check the server API key / quota and try again.' });
      }
    });

    socket.on('update_file', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      // Same 2MB cap as upload_file — otherwise the upload size limit is
      // trivially bypassed by uploading a small file then "updating" it.
      if (typeof html !== 'string' || html.length > MAX_FILE_SIZE) return;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
        socket.to(roomId).emit('file_updated', { fileId, html });
      }
    });

    socket.on('delete_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const wasActive = room.activeFileId === fileId;
      room.files = room.files.filter(f => f.id !== fileId);
      if (!wasActive) {
        io.to(roomId).emit('file_deleted', { fileId, newActiveId: room.activeFileId });
        return;
      }
      // The active file was deleted — repoint canonical HTML at the next file
      // (or clear it) and bump the revision, otherwise lastRunHtml /
      // liveSnapshotHtml still hold the deleted lesson and students keep seeing
      // it. Without the bump, late-join / reconnect would re-deliver the
      // deleted content via session_state.
      const nextFile = room.files[0] || null;
      room.activeFileId = nextFile ? nextFile.id : null;
      room.lastRunHtml = nextFile ? nextFile.html : null;
      room.liveSnapshotHtml = null;
      newContentBaseline(room);
      const revision = bumpRevision(room);
      io.to(roomId).emit('file_deleted', { fileId, newActiveId: room.activeFileId });
      if (nextFile) {
        io.to(roomId).emit('active_file_changed', { fileId: nextFile.id, fileName: nextFile.name, html: nextFile.html, currentStep: room.currentStep, revision });
        io.to(roomId).emit('run_preview', { fileId: nextFile.id, html: nextFile.html, revision });
      }
      broadcastFullState(roomId, room, 'run_preview');
    });

    socket.on('switch_file', ({ roomId, fileId }: { roomId: string; fileId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const file = room.files.find(f => f.id === fileId);
      // Validate the file exists BEFORE repointing activeFileId — otherwise a
      // bad id leaves activeFileId dangling at a non-existent file.
      if (!file) return;
      room.activeFileId = fileId;
      room.lastRunHtml = file.html;
      room.liveSnapshotHtml = null;
      newContentBaseline(room);
      const revision = bumpRevision(room);
      // Send file content WITH the active_file_changed so student never reads stale state
      io.to(roomId).emit('active_file_changed', { fileId, fileName: file.name, html: file.html, currentStep: room.currentStep, revision });
      broadcastFullState(roomId, room, 'run_preview');
      io.to(roomId).emit('run_preview', { fileId, html: file.html, revision });
    });

    // ─── RUN / REFRESH PREVIEW ───
    socket.on('run_preview', ({ roomId, fileId, html }: { roomId: string; fileId: string; html: string }) => {
      updateRoomActivity(roomId);
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      // Cap the broadcast HTML at the same 2MB limit as upload (this path also
      // writes file.html / lastRunHtml, so an uncapped payload would bypass it).
      // MUST answer with upload_error, not a silent return: the client applies
      // the preview optimistically and toasts "synced" — a silent drop left the
      // teacher teaching content the room never received (split-brain).
      if (typeof html !== 'string' || html.length === 0) return;
      if (html.length > MAX_FILE_SIZE) {
        socket.emit('upload_error', { message: `Lesson too large (${(html.length / 1024 / 1024).toFixed(1)}MB, max 2MB)` });
        return;
      }
      // ── Idempotent re-seed vs. genuine new content ──
      // run_preview is emitted not only when the teacher runs NEW html, but
      // ALSO to re-seed the server from the teacher's cache: on reconnect, and
      // when answering request_html_sync (a student joined while the teacher was
      // on the whiteboard). Those carry the SAME html. Resetting the baseline
      // there was a silent class-killer: it wiped the interaction journal (and
      // reseeded the shared RNG) mid-lesson, so any later catch-up / late-join
      // had nothing to replay — the teacher (or student) was stranded on the
      // lesson's home screen while everyone else was mid-quiz. Only a genuine
      // content change starts a fresh baseline; an identical re-seed preserves
      // the journal + seed. (Found by browser-reproducing the whiteboard
      // round-trip — see stress14.)
      const htmlChanged = room.lastRunHtml !== html;
      const file = room.files.find(f => f.id === fileId);
      if (file) {
        file.html = html;
      }
      room.activeFileId = fileId;
      room.lastRunHtml = html;
      if (htmlChanged) {
        room.liveSnapshotHtml = null;
        newContentBaseline(room);
      }
      const revision = bumpRevision(room);
      broadcastFullState(roomId, room, 'run_preview');
      // Send to everyone (including sender for confirmation)
      io.to(roomId).emit('run_preview', { fileId, html, revision });
    });

    socket.on('sync_html_update', ({ roomId, html, requestId, hasCanvas }: { roomId: string; html: string; requestId?: string; hasCanvas?: boolean }) => {
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
      if (typeof html !== 'string' || html.length === 0 || html.length > MAX_FILE_SIZE) return;
      // Same reasoning as in dom_snapshot above: a passive snapshot ack does
      // NOT rewrite lastRunHtml or the persisted file source — only the live
      // snapshot. Canvas sims never store a snapshot at all (see dom_snapshot).
      // Never store canvas snapshots (blank shells) or oversized ones (a
      // serialized DOM can exceed the 2MB lesson cap — unbounded room memory).
      room.liveSnapshotHtml = (hasCanvas || html.length > MAX_FILE_SIZE) ? null : html;
      // Journal survives passive snapshots — see the dom_snapshot handler.
      const revision = bumpRevision(room);
      const replayableNow = room.eventLog.length > 0 && !room.eventLogOverflow;
      const deliverHtml = (hasCanvas || replayableNow) ? (room.lastRunHtml || getSourceHtml(room) || html) : html;
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
          io.to(studentId).emit('run_preview', { fileId: room.activeFileId, html: deliverHtml, revision });
        }
        logSync('pending_snapshot_ack', { roomId, revision, requestId, reason: `pending=${pending.length}` });
      }
    });

    socket.on('dom_snapshot', ({ roomId, html, requestId, hasCanvas }: { roomId: string; html: string; requestId?: string; hasCanvas?: boolean }) => {
      const room = rooms.get(roomId);
      // AUTONOMOUS: dropped the `!room.activeFileId` guard, same reasoning
      // as sync_html_update above. Post-redeploy the teacher's iframe is
      // still loaded but server has no activeFileId; we want the snapshot
      // to land so pending students get unblocked.
      if (!requireTeacher(room, socket.id)) return;
      if (typeof html !== 'string' || html.length === 0 || html.length > MAX_FILE_SIZE) return;
      const isForceSync = requestId?.startsWith('force-');
      // ── Canvas/WebGL sims never snapshot usefully ──
      // outerHTML of a <canvas> is an empty shell — rebuilding a late-joiner
      // (or force-syncing the room) from it produces a blank sim. When the
      // teacher's iframe reports hasCanvas, we keep the pristine lastRunHtml
      // as the canonical boot state instead: late-joiners get a clean,
      // working sim and the event-replay stream brings them forward.
      if (hasCanvas) {
        room.liveSnapshotHtml = null;
        // No new baseline stored — the journal keeps accumulating since the
        // last run/upload so canvas-sim late-joiners can replay it. Force on
        // a canvas sim DOES rebuild everyone from lastRunHtml, which resets
        // each client's sim — the journal restarts with them.
        if (isForceSync) resetEventJournal(room);
      } else {
        // ── Don't corrupt the source HTML on every late-join ack ──
        // `liveSnapshotHtml` is the "current DOM right now" and is meant to
        // change every snapshot. `lastRunHtml` is the last HTML the teacher
        // actually ran; `file.html` is the saved source. Only force-sync (an
        // explicit teacher request to re-baseline everyone) rewrites those.
        // Size-capped like uploads: a serialized DOM can outgrow the lesson
        // cap; storing it would bloat room memory + persistence unboundedly.
        room.liveSnapshotHtml = html.length > MAX_FILE_SIZE ? null : html;
        // NOTE: passive snapshots do NOT clear the journal. A snapshot only
        // captures DOM — a JS-stateful lesson re-initialises its scripts on
        // load and paints its first screen over the snapshot HTML, so the
        // journal (pristine boot + full replay) is the primary late-join
        // mechanism and must survive snapshots. Only real content baselines
        // (upload / run / switch / restore / force / reset) clear it.
        // A force used to REWRITE the lesson here — lastRunHtml and the saved
        // file both replaced by a serialized DOM, and every client rebuilt from
        // it. That is what made the button that promises to fix things reset the
        // class: the lesson's scripts re-run against an already-rendered page, so
        // a quiz returns to question 1 and a lesson that appends its canvas on
        // load ends up with two.
        //
        // In the mirror model a resync means "send my screen again", which is a
        // keyframe from the source — never a new lesson. The snapshot is still
        // stored as liveSnapshotHtml above (a fallback boot state), but it is no
        // longer allowed to become the lesson.
        if (isForceSync) resetEventJournal(room);
      }
      const revision = bumpRevision(room);
      // What a client should boot from right now: pristine when a journal will
      // replay them forward (and always for canvas sims); the raw snapshot
      // only as the no-journal fallback.
      const replayableNow = room.eventLog.length > 0 && !room.eventLogOverflow;
      const deliverHtml = (hasCanvas || replayableNow) ? (room.lastRunHtml || getSourceHtml(room) || html) : html;

      if (isForceSync) {
        // State only — no dom_snapshot, so no client rebuilds its iframe. The
        // teacher's source pushes a fresh keyframe (see the force_sync handler),
        // which is what actually brings a stale student back.
        broadcastFullState(roomId, room, 'force_sync', requestId);
      } else {
        // Snapshot-ack triggered by a join/retry: ONLY the late-joining
        // students need this HTML. Existing students stay in sync through the
        // interaction event-replay stream (SYNC_* → REMOTE_*) — the previous
        // design ALSO pushed a `live_dom` body-swap to every student here,
        // which destroyed the student sim's event listeners (their clicks
        // stopped doing anything), detached the nodes the sim's own scripts
        // animate (canvas/3D sims froze or blanked), and raced the replay
        // stream (quiz drift). The live mirror is retired; snapshots are for
        // late-join catch-up and explicit force-sync only.
        if (room.pendingSyncStudents.size > 0) {
          const pending = Array.from(room.pendingSyncStudents);
          for (const studentId of pending) {
            room.pendingSyncStudents.delete(studentId);
            emitSessionState(studentId, roomId, room, 'snapshot_ack', requestId);
            io.to(studentId).emit('run_preview', { fileId: room.activeFileId, html: deliverHtml, revision });
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
        // The real work: tell the source to send a full frame, which every
        // follower paints. Cheap, immediate, and it cannot restart anything.
        io.to(room.teacherSocketId).emit('mirror_request', {});
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
      // Optional multiple-choice: sanitize each option, drop blanks, cap at 6.
      // Fewer than 2 survivors → free-text quiz (no options field).
      const safeOptions = Array.isArray(options)
        ? options.slice(0, 6).map(o => sanitizeString(o, 200)).filter(Boolean)
        : [];
      io.to(roomId).emit('quiz', {
        question: safeQuestion,
        ...(safeOptions.length >= 2 ? { options: safeOptions } : {}),
        senderId: socket.id,
      });
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
      // Sketching the lesson is gated: teacher always, students only when
      // interaction is enabled or they hold control. A view-only student is a
      // pure viewer (the toolbar is also hidden client-side).
      if (!requireTeacherOrAnnotator(room, socket.id)) return;
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
      if (!object || typeof object.id !== 'string') return;
      // Same byte cap as whiteboard_add_image — otherwise the cap is bypassed
      // by adding a tiny image then "updating" its src to an arbitrary blob.
      if (typeof object.src === 'string' && object.src.length > MAX_IMAGE_OBJECT_BYTES) {
        console.warn(`Rejected oversize whiteboard image update from ${socket.id}: ${object.src.length} bytes`);
        return;
      }
      let found = false;
      room.whiteboard.objects = room.whiteboard.objects.map(obj => {
        if (obj.id === object.id) { found = true; return object; }
        return obj;
      });
      // Don't broadcast updates for objects that don't exist (a stale/forged id).
      if (!found) return;
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

    // ─── EXPLANATIONS (extra HTML shown over the lesson) ───
    // These used to be a single slot: showing a second one replaced the first,
    // and closing one threw it away — the teacher had to re-upload a file they
    // had already sent. They are now a KEPT LIST the teacher opens and closes
    // like tabs. Closing hides; deleting is the only thing that discards.
    //
    // Students are unchanged: whichever explanation is active is still relayed
    // as `temp_content`, and `room.tempContent` still mirrors it for hydration.
    function broadcastExplanations(roomId: string, room: RoomData) {
      // The list without bodies — a tab strip needs names, not megabytes.
      io.to(roomId).emit('explanations_state', {
        list: room.explanations.map(e => ({ id: e.id, name: e.name })),
        activeId: room.activeExplanationId,
      });
    }
    /** Point the room at one explanation (or none) and tell everyone. */
    function activateExplanation(roomId: string, room: RoomData, id: string | null) {
      const found = id ? room.explanations.find(e => e.id === id) : null;
      room.activeExplanationId = found ? found.id : null;
      room.tempContent = found ? { html: found.html, name: found.name } : null;
      if (found) io.to(roomId).emit('temp_content', { html: found.html, name: found.name, id: found.id });
      else io.to(roomId).emit('clear_temp_content');
      broadcastExplanations(roomId, room);
    }

    socket.on('show_temp_content', ({ roomId, html, name }: { roomId: string; html: string; name: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      // Same validation as uploads — this path stored + broadcast unvalidated
      // HTML (unbounded memory; oversized payloads split teacher/student views).
      if (typeof html !== 'string' || html.trim().length === 0) return;
      if (html.length > MAX_FILE_SIZE) {
        socket.emit('upload_error', { message: `Explanation too large (${(html.length / 1024 / 1024).toFixed(1)}MB, max 2MB)` });
        return;
      }
      if (room.explanations.length >= MAX_EXPLANATIONS) {
        socket.emit('upload_error', { message: `You can keep ${MAX_EXPLANATIONS} explanations at a time — delete one first.` });
        return;
      }
      const safeName = sanitizeString(name, 100) || 'Explanation';
      // Re-adding the same body just reopens the tab you already have, rather
      // than stacking near-identical copies every time a file is re-sent.
      const existing = room.explanations.find(e => e.html === html);
      if (existing) { activateExplanation(roomId, room, existing.id); return; }
      const entry = { id: `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: safeName, html };
      room.explanations.push(entry);
      updateRoomActivity(roomId);
      activateExplanation(roomId, room, entry.id);
    });

    // Reopen one that's already in the list — the whole point of keeping them.
    socket.on('explanation_show', ({ roomId, id }: { roomId: string; id: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (typeof id !== 'string' || !room.explanations.some(e => e.id === id)) return;
      activateExplanation(roomId, room, id);
    });

    // Close = back to the main lesson, explanation KEPT.
    socket.on('clear_temp_content', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      activateExplanation(roomId, room, null);
    });

    socket.on('explanation_delete', ({ roomId, id }: { roomId: string; id: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (typeof id !== 'string') return;
      const before = room.explanations.length;
      room.explanations = room.explanations.filter(e => e.id !== id);
      if (room.explanations.length === before) return;
      // Deleting the one on screen must also take it off everyone's screen.
      if (room.activeExplanationId === id) activateExplanation(roomId, room, null);
      else broadcastExplanations(roomId, room);
    });

    socket.on('explanation_clear', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.explanations = [];
      activateExplanation(roomId, room, null);
    });

    // ─── NARRATION (what was said, as text) ───
    // Each device transcribes its OWN microphone and relays short lines. No
    // audio is ever uploaded — only text the speaker's own browser produced.
    // The teacher asks the room to start; each student's browser then asks
    // that student before it listens (see StudentView).
    socket.on('narration_request', ({ roomId, on, elapsed }: { roomId: string; on: boolean; elapsed?: number }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.narrationOn = !!on;
      // `elapsed` is how far into the lesson the TEACHER's pack currently is.
      // Passing it through puts both sides on one clock: the student stamps
      // their lines against it instead of against their own arrival, which is
      // the only way the merged transcript can be in true order.
      socket.to(roomId).emit('narration_request', { on: !!on, elapsed: Math.max(0, Number(elapsed) || 0) });
    });
    socket.on('narration_line', ({ roomId, text, t }: { roomId: string; text: string; t: number }) => {
      if (typeof roomId !== 'string' || typeof text !== 'string') return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id) || !room.teacherSocketId) return;
      if (socket.id === room.teacherSocketId) return;   // the teacher keeps their own
      const user = room.users.get(socket.id);
      io.to(room.teacherSocketId).emit('narration_line', {
        speaker: user?.name || 'Student',
        text: text.slice(0, 600),
        t: Math.max(0, Number(t) || 0),
      });
    });

    // ─── "PLEASE UNLOCK IT" (student → teacher) ───
    // A view-only student tapping the lesson gets nothing back, and the teacher
    // — who simply forgot to allow interaction — has no way to find out. This
    // carries the ask to the teacher with a one-click Allow on the other end.
    socket.on('request_interaction', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id) || !room.teacherSocketId) return;
      const user = room.users.get(socket.id);
      if (user?.role === 'teacher') return;              // teachers grant, not ask
      if (room.studentInteractionAllowed) return;        // already unlocked
      io.to(room.teacherSocketId).emit('interaction_requested', {
        studentName: user?.name || 'A student',
        at: Date.now(),
      });
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
      // The teacher can now type a custom time, so a typo reaches this. An
      // unchecked value here means every student's screen counts down from
      // NaN, or from a number that never ends. 5s..1h, whole seconds.
      const s = Math.round(Number(seconds));
      if (!Number.isFinite(s) || s < 5 || s > 3600) return;
      io.to(roomId).emit('timer_started', { seconds: s, startedAt: Date.now() });
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
      // HARDENING: a null / non-object event must be dropped BEFORE `event.userId
      // = ...` below. Otherwise that assignment throws, and because this is an
      // async socket handler the exception is uncaught and crashes the whole
      // Node process — taking down EVERY room on the server. Any client (even a
      // view-only student) could do this with one malformed packet. Found by
      // stress6 P6 (malformed-payload). Also validate roomId/type defensively.
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return;
      if (typeof roomId !== 'string') return;
      // SIZE CAP (found by stress13 S5): without it a single oversized event
      // (e.g. a 200KB SYNC_INPUT value) was broadcast to every student AND
      // journaled — and the journal (up to 2000 entries) is persisted and
      // re-sent to every late joiner, so one abusive/buggy client could grow
      // room memory + replay payloads by hundreds of MB. 32KB is ~1000x a
      // normal click and far beyond any legitimate lesson input.
      try { if (JSON.stringify(event).length > 32 * 1024) return; } catch { return; }
      const evtType = event.type;
      const lossTolerant = evtType === 'SYNC_CURSOR' || evtType === 'SYNC_SCROLL'
        || evtType === 'SYNC_DRAG' || evtType === 'SYNC_MOUSEMOVE' || evtType === 'SYNC_WHEEL';
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
        // SINGLE-WRITER: when a student holds control, the teacher is a MIRROR
        // of that student — their sim-driving events must NOT enter the stream
        // (two drivers each roll their own Math.random() and diverge). Only
        // ephemeral pointing (cursor / look-here ping) still relays. The
        // teacher client also blocks these locally; this enforces it on the
        // server too so a timing gap or a rogue client can't double-drive.
        if (room.controlHolderName && event.type !== 'SYNC_CURSOR' && event.type !== 'SYNC_PING') {
          return;
        }
        if (event.type === 'SYNC_SCROLL') {
          room.lastTeacherScroll = event;
        }
        // Journal discrete events so late joiners can replay the lesson's
        // interaction stream from the current baseline (see eventLog).
        journalEvent(room, event);
        if (REPLAYABLE_EVENT_TYPES.has(event.type)) scheduleJournalSave(roomId);
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
        } else if (event.type === 'SYNC_PING') {
          // Element pings (Alt+click "look here" ripples) are ephemeral and
          // harmless — always relayed room-wide, even from view-only
          // students, so a confused student can point AT the thing they're
          // confused about. Like reactions, they mutate nothing.
          socket.to(roomId).emit('interaction', event);
        } else if (user.name && user.name === room.controlHolderName) {
          // SINGLE-WRITER: the lesson sim has exactly one driver at a time.
          // A student drives ONLY while they hold the control grant ("the
          // chalk"). The room-wide interaction toggle deliberately does NOT
          // make students drive the lesson sim — two independent drivers each
          // roll their own Math.random() in their own order and diverge
          // instantly (the "she's on a different question" bug). The toggle
          // still governs whiteboard/annotation collaboration, which needs no
          // determinism. When a student holds control the teacher becomes a
          // mirror, so this single stream drives every screen identically.
          journalEvent(room, event);
          if (REPLAYABLE_EVENT_TYPES.has(event.type)) scheduleJournalSave(roomId);
          socket.to(roomId).emit('interaction', event);
        } else if (room.studentInteractionAllowed) {
          // INTERACTIVE MODE (no control grant): the student is working their
          // OWN copy. Relay their interactions to the TEACHER ONLY so the
          // teacher SEES what the student is doing — the teacher mirrors via
          // REMOTE_* and shows a student-click indicator (bidirectional sync).
          //
          // FIRST-PRINCIPLES DESYNC FIX: in a 1-to-1 lesson the interactive
          // student is the de-facto DRIVER while the teacher watches, so their
          // navigation MUST be journaled. Previously it was teacher-only +
          // un-journaled, which meant the moment the teacher's lesson iframe
          // rebuilt (switching to the whiteboard / another file and back) or
          // anyone reconnected, there was NOTHING to replay the student's
          // navigation from — the teacher reloaded to the pristine home/map
          // screen and was stuck there while the student was deep in a quiz
          // (the exact reported bug). Journaling it (serverSeq-ordered, made
          // deterministic by the seed + storage shims in the sync script) lets
          // the teacher's iframe replay forward to the student's real screen on
          // every rebuild/late-join. We still relay LIVE to the teacher ONLY
          // (not room-wide), so a rare multi-student room isn't driven by it.
          journalEvent(room, event);
          if (REPLAYABLE_EVENT_TYPES.has(event.type)) scheduleJournalSave(roomId);
          const teacherId = resolveTeacherSocketId();
          if (teacherId) io.to(teacherId).emit('interaction', event);
        }
        // When not allowed: student events are silently dropped (view-only mode)
      }
    });

    // ─── SIM ERROR REPORTING (student → teacher diagnostics) ───
    // A student's lesson iframe reported a load/runtime failure (CDN script
    // blocked on their network, WebGL unavailable, JS crash). Relay to the
    // TEACHER ONLY so they instantly see WHY a student "isn't following",
    // instead of silence. Loss-tolerant rate limiting; student role only
    // (the teacher's own errors surface locally client-side).
    socket.on('sim_error', ({ roomId, message, source }: { roomId: string; message: string; source?: string }) => {
      if (typeof roomId !== 'string') return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const user = room.users.get(socket.id);
      if (user?.role !== 'student') return;
      let teacherId: string | null = room.teacherSocketId;
      if (!(teacherId && room.users.get(teacherId)?.role === 'teacher')) {
        teacherId = null;
        for (const [sid, u] of room.users.entries()) {
          if (u.role === 'teacher') { teacherId = sid; room.teacherSocketId = sid; break; }
        }
      }
      if (teacherId) {
        io.to(teacherId).emit('sim_error', {
          studentName: user.name || 'Student',
          message: sanitizeString(message, 300) || 'Unknown lesson error',
          source: sanitizeString(source, 300),
        });
      }
    });

    // ─── REPLAY CATCH-UP (a client's lesson iframe remounted) ───
    // When the teacher switches to the whiteboard / another file and comes
    // back, their lesson iframe REMOUNTS and boots a FRESH sim on the pristine
    // home screen. Without a way to catch up it sits on the map while the
    // student is mid-quiz (the reported desync). This lets that client pull the
    // current interaction journal on demand and replay it forward to the room's
    // real screen. Journal-only (no session_state side effects so it can't
    // trigger a rebuild loop); sent to the requester only.
    socket.on('request_replay', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      if (room.eventLog.length > 0 && !room.eventLogOverflow) {
        io.to(socket.id).emit('interaction_replay', { events: room.eventLog, count: room.eventLog.length });
      }
    });

    // ─── SHARED YOUTUBE VIDEO (teacher shows a clip over the lesson) ───
    // Unlike a meeting link, YouTube is designed to be embedded, so we can play
    // it in-place. The teacher is authoritative: they open, close and drive
    // playback, and their position is relayed so every student's clip tracks
    // theirs instead of drifting. Held on the room (not just broadcast) so a
    // student who joins or reloads mid-clip still lands on the right video at
    // roughly the right moment.
    socket.on('video_open', ({ roomId, videoId, start }: { roomId: string; videoId: string; start?: number }) => {
      if (typeof roomId !== 'string' || typeof videoId !== 'string') return;
      // Ids are a fixed alphabet; refuse anything else rather than embedding it.
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const at = Math.max(0, Math.floor(Number(start) || 0));
      room.sharedVideo = { videoId, time: at, playing: true, updatedAt: Date.now() };
      updateRoomActivity(roomId);
      io.to(roomId).emit('video_open', { videoId, start: at });
    });
    socket.on('video_close', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.sharedVideo = null;
      updateRoomActivity(roomId);
      io.to(roomId).emit('video_close', {});
    });
    // Playback heartbeat: position + play/pause. Loss-tolerant — a dropped tick
    // just means the next one corrects it.
    socket.on('video_state', ({ roomId, time, playing }: { roomId: string; time: number; playing: boolean }) => {
      if (typeof roomId !== 'string') return;
      // NOT loss-tolerant. This carries play/pause, and the teacher is usually
      // moving the mouse (→ a burst of cursor events) at the exact moment they
      // click pause. Dropping it at the soft cap loses the transition precisely
      // when it matters; the hard cap still bounds abuse.
      if (!checkRateLimit(socket.id, false)) return;
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (!room.sharedVideo) return;
      room.sharedVideo.time = Math.max(0, Number(time) || 0);
      room.sharedVideo.playing = !!playing;
      room.sharedVideo.updatedAt = Date.now();
      socket.to(roomId).emit('video_state', { time: room.sharedVideo.time, playing: room.sharedVideo.playing });
    });
    // The other direction: a student reporting where their copy actually is.
    // Without this the teacher pauses, nothing happens on the student's screen,
    // and there is no way for either of them to tell — which is exactly how
    // this went unnoticed. Relayed to the teacher only.
    socket.on('video_ack', ({ roomId, time, playing }: { roomId: string; time: number; playing: boolean }) => {
      if (typeof roomId !== 'string') return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id) || !room.teacherSocketId) return;
      if (socket.id === room.teacherSocketId) return;   // teachers don't ack themselves
      const user = room.users.get(socket.id);
      io.to(room.teacherSocketId).emit('video_ack', {
        time: Math.max(0, Number(time) || 0),
        playing: !!playing,
        name: user?.name || 'Your student',
      });
    });

    // ─── VIDEO CALL SIGNALLING (face-to-face inside the lesson) ───
    // Google Meet / Zoom / Teams all send `X-Frame-Options`, so they can never
    // be embedded in a page — pasting a Meet link could never show faces here.
    // Instead the two browsers talk directly (WebRTC) and this room socket is
    // the introduction channel they need: each side's offer/answer/ICE is
    // relayed to the other member of the room. The media itself never touches
    // this server — it flows peer-to-peer, so there's no bandwidth cost here
    // and no third party in the middle of a lesson.
    // The other party in a 1-to-1 call: the only other socket that has joined it.
    function callPeerOf(room: RoomData, socketId: string): string | null {
      for (const id of room.callMembers) {
        if (id !== socketId && room.users.has(id)) return id;
      }
      return null;
    }

    // Both sides are in — name one of them the offerer and tell them to start.
    // Re-pairing after someone leaves and returns picks a fresh offerer, so a
    // rejoin is a clean negotiation rather than a half-finished old one.
    function pairCall(roomId: string, room: RoomData) {
      const ids = Array.from(room.callMembers).filter(id => room.users.has(id));
      if (ids.length < 2) {
        room.callOfferer = null;
        return;
      }
      // The teacher offers when present — arbitrary but stable, and it keeps the
      // side with the better uplink initiating.
      const teacher = ids.find(id => room.users.get(id)?.role === 'teacher');
      const offerer = teacher || ids[0];
      const answerer = ids.find(id => id !== offerer)!;
      room.callOfferer = offerer;
      const nameOf = (id: string) => room.users.get(id)?.name || 'Someone';
      io.to(offerer).emit('call_start', { role: 'offerer', peerName: nameOf(answerer) });
      io.to(answerer).emit('call_start', { role: 'answerer', peerName: nameOf(offerer) });
      console.log(`📞 Room ${roomId}: call paired — ${nameOf(offerer)} offers to ${nameOf(answerer)}`);
    }

    // "Is anyone in a call right now?" — asked by the call widget as soon as it
    // has a socket, and again after a reconnect.
    //
    // A push at join time would race the widget mounting, and losing that race
    // is not cosmetic: a student whose iPad reloaded mid-lesson came back to a
    // button saying "Start call" with no hint that their teacher was sitting in
    // one, so the natural thing to do — wait to be called — was exactly wrong.
    // Asking cannot race.
    socket.on('call_status', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      for (const id of room.callMembers) {
        if (id === socket.id) continue;
        const inCall = room.users.get(id);
        if (!inCall) continue;
        socket.emit('call_presence', { active: true, name: inCall.name, role: inCall.role, socketId: id });
        return;
      }
      socket.emit('call_presence', { active: false, socketId: null });
    });

    // Someone opened their camera and is in the call.
    socket.on('call_join', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      room.callMembers.add(socket.id);
      const user = room.users.get(socket.id);
      // Tell the other side someone is waiting, so their button can say "Join".
      socket.to(roomId).emit('call_presence', {
        active: true, name: user?.name || 'Someone', role: user?.role, socketId: socket.id,
      });
      pairCall(roomId, room);
    });

    // Left the call (hung up, or the page went away).
    function leaveCall(roomId: string, room: RoomData, socketId: string) {
      if (!room.callMembers.delete(socketId)) return;
      const user = room.users.get(socketId);
      if (room.callOfferer === socketId) room.callOfferer = null;
      io.to(roomId).except(socketId).emit('call_presence', {
        active: false, name: user?.name || 'Someone', role: user?.role, socketId,
      });
    }
    socket.on('call_leave', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!room) return;
      leaveCall(roomId, room, socket.id);
    });

    // Offer / answer / candidate, addressed to the one other party.
    //
    // Broadcasting these was its own bug: a second student socket — the tutor
    // watching from another browser, or a parent on a second device — received
    // the same offer and answered it, and the two answers fought.
    socket.on('call_signal', ({ roomId, signal }: { roomId: string; signal: unknown }) => {
      if (typeof roomId !== 'string' || !signal || typeof signal !== 'object') return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      if (!room.callMembers.has(socket.id)) return;
      const peer = callPeerOf(room, socket.id);
      if (!peer) return;
      io.to(peer).emit('call_signal', { signal, from: socket.id });
    });

    // A side wants to renegotiate from scratch (ICE restart after a network
    // change). Re-pair so both ends agree on who offers this time.
    socket.on('call_restart', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id) || !room.callMembers.has(socket.id)) return;
      pairCall(roomId, room);
    });

    // ─── SCREEN SHARE (the teacher watches the student's ACTUAL screen) ───
    //
    // Student Peek shows the lesson iframe's DOM, refreshed every couple of
    // seconds. That answers "what does their lesson look like" and not the
    // question a tutor actually asks when something is wrong: what is on their
    // screen, right now, all of it — the whiteboard, the scroll position, the
    // dialog they have not noticed. This is real getDisplayMedia video over
    // WebRTC, one-way, student to teacher.
    //
    // Its own channel rather than rtc_signal: the video call may be running at
    // the same time, and two negotiations on one broadcast channel would answer
    // each other's offers. These are addressed to a single socket.
    //
    // The student always chooses. A share cannot start without them clicking,
    // because the browser itself demands a gesture for getDisplayMedia — so the
    // consent here is not a courtesy we could skip, it is how the API works.
    socket.on('screen_request', ({ roomId, studentId }: { roomId: string; studentId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (typeof studentId !== 'string') return;
      const target = room.users.get(studentId);
      if (!target || target.role !== 'student') return;
      const teacher = room.users.get(socket.id);
      io.to(studentId).emit('screen_request', { teacherName: teacher?.name || 'Your teacher' });
    });

    // Signalling, addressed. A teacher may signal any member; a student may
    // only ever signal the teacher — so one student can never open a peer
    // connection to another.
    socket.on('screen_signal', ({ roomId, to, signal }: { roomId: string; to?: string; signal: unknown }) => {
      if (typeof roomId !== 'string' || !signal || typeof signal !== 'object') return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const me = room.users.get(socket.id);
      const dest = me?.role === 'teacher' ? to : room.teacherSocketId;
      if (typeof dest !== 'string' || !room.users.has(dest)) return;
      if (me?.role !== 'teacher' && dest !== room.teacherSocketId) return;
      io.to(dest).emit('screen_signal', { signal, from: socket.id, name: me?.name || 'Someone' });
    });

    // What happened to the request: sharing / stopped / declined / unsupported.
    // "unsupported" is the one that matters most in practice — iPadOS Safari
    // has no getDisplayMedia at all, so a tutor waiting on a share that can
    // never arrive needs to be told, not left watching a spinner.
    socket.on('screen_state', ({ roomId, state, to }: { roomId: string; state: string; to?: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      if (!['sharing', 'stopped', 'declined', 'unsupported', 'failed'].includes(state)) return;
      const me = room.users.get(socket.id);
      // A student reports to the teacher; the teacher's "stop watching" goes to
      // the one student they were watching — not to the room, which would tell
      // three other children that someone's share ended.
      const dest = me?.role === 'student' ? room.teacherSocketId : to;
      if (typeof dest !== 'string' || !room.users.has(dest)) return;
      if (me?.role !== 'teacher' && dest !== room.teacherSocketId) return;
      io.to(dest).emit('screen_state', { state, from: socket.id, name: me?.name || 'Someone' });
    });

    // ─── TEACHER SCREEN SHARE (the tutor shows their real screen) ───
    //
    // The other direction, and the more useful one when sync is the problem.
    // Live Mirror can fail for reasons neither person can see — a lesson that
    // will not render, a device that will not run it — and no amount of
    // resyncing helps if the student's browser simply cannot show the thing.
    // Sharing the tutor's actual screen sidesteps the whole question: whatever
    // is wrong with the lesson, the student sees exactly what the tutor sees.
    //
    // It also works on the devices that CANNOT share their own. iPadOS Safari
    // has no getDisplayMedia, so a student there can never send their screen —
    // but receiving video is ordinary WebRTC and works fine. For a tutor whose
    // students are on iPads this is the only screen sharing available at all.
    socket.on('teacher_screen', ({ roomId, on }: { roomId: string; on: boolean }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const teacher = room.users.get(socket.id);
      room.teacherScreenOn = !!on;
      socket.to(roomId).emit('teacher_screen', {
        on: !!on,
        name: teacher?.name || 'Your teacher',
        from: socket.id,
      });
    });

        // ─── LIVE MIRROR relay (the "impossible to desync" engine) ───
    // The teacher's iframe is the single authoritative lesson instance; it
    // streams its REAL DOM here and the server relays it to every student, who
    // render it read-only (they never run the lesson JS, so they cannot be on a
    // different screen). A student that may drive forwards its input to the
    // teacher, who applies it on the real lesson and streams the result back.
    // No journal / replay / seed involved — desync is structurally impossible.
    // Cap for a mirror frame. Deliberately larger than MAX_FILE_SIZE (which
    // governs PERSISTED lesson files): a mirror frame is transient, never
    // written to the store, and dropping it silently freezes the student's
    // screen forever. Kept under Socket.IO's 5MB maxHttpBufferSize so the frame
    // actually reaches the wire; the source separately warns the teacher when a
    // page approaches this size.
    //
    // 3MB, not 4MB, and measured against body + head + attrs rather than body
    // alone. Socket.IO's maxHttpBufferSize (5MB) counts BYTES of the whole
    // encoded message; `.length` counts UTF-16 characters of one field. A maths
    // lesson is full of non-ASCII — π, ≤, ×, √, ≈, − — and each of those costs
    // 2–3 bytes in UTF-8. So a frame that passed a 4MB character check could
    // encode well past 5MB, and Socket.IO drops an oversized frame by KILLING
    // the connection: the student's screen freezes and they get bounced, with
    // nothing in the UI explaining why.
    // Only the SEATED teacher may stream the class's screen.
    //
    // Checking the role alone was not enough. When a teacher opens the room in a
    // second tab, the new socket takes the seat and the old one is told it has
    // been replaced — but it stays in room.users as a teacher until it actually
    // disconnects, and its lesson iframe keeps running and keeps streaming. Two
    // independent lessons then fed the same students, and the class flickered
    // between them.
    function isMirrorSource(room: RoomData | undefined, socketId: string): boolean {
      if (!isMember(room, socketId)) return false;
      return room!.teacherSocketId === socketId && room!.users.get(socketId)?.role === 'teacher';
    }

    const MAX_MIRROR_FRAME = 3 * 1024 * 1024;
    socket.on('mirror_dom', ({ roomId, body, scrollX, scrollY, attrs, head, h }: { roomId: string; body: string; scrollX?: number; scrollY?: number; attrs?: string; head?: string | null; h?: string }) => {
      if (typeof roomId !== 'string' || typeof body !== 'string') return;
      const frameChars = body.length
        + (typeof head === 'string' ? head.length : 0)
        + (typeof attrs === 'string' ? attrs.length : 0);
      if (frameChars > MAX_MIRROR_FRAME) return;
      const room = rooms.get(roomId);
      if (!isMirrorSource(room, socket.id)) return;
      room.mirrorBody = body;
      // Cache the full styling envelope too, so a late joiner served from cache
      // renders with the same body attributes and runtime CSS as everyone else.
      room.mirrorAttrs = typeof attrs === 'string' ? attrs : null;
      if (typeof head === 'string') room.mirrorHead = head;
      room.mirrorHash = typeof h === 'string' ? h : null;
      socket.to(roomId).emit('mirror_dom', { body, scrollX, scrollY, attrs, head, h });
    });
    // Fingerprint heartbeat (a few bytes): lets a student detect that a snapshot
    // never arrived and request a resync. Rate-limited as loss-tolerant.
    socket.on('mirror_ping', ({ roomId, h }: { roomId: string; h?: string }) => {
      if (typeof roomId !== 'string' || typeof h !== 'string') return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMirrorSource(room, socket.id)) return;
      room.mirrorHash = h;
      socket.to(roomId).emit('mirror_ping', { h });
    });
    socket.on('mirror_canvas', ({ roomId, canvases }: { roomId: string; canvases: any }) => {
      if (typeof roomId !== 'string' || !Array.isArray(canvases)) return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMirrorSource(room, socket.id)) return;
      socket.to(roomId).emit('mirror_canvas', { canvases });
    });
    // A student reporting the fingerprint they have actually rendered.
    //
    // The teacher cannot see a frozen student any other way: the mirror is
    // one-directional by design, so silence and perfect sync look identical
    // from the source. This is the return channel, and it is deliberately
    // tiny — a hash and a boolean, once every couple of seconds.
    // The lesson describing its own position. Teacher only — the source is the
    // only copy that is actually running.
    socket.on('mirror_state', ({ roomId, state }: { roomId: string; state: string }) => {
      if (typeof roomId !== 'string' || typeof state !== 'string') return;
      if (state.length > 64 * 1024) return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMirrorSource(room, socket.id)) return;
      room.lessonState = { forHtml: contentKey(room.lastRunHtml), state, at: Date.now() };
    });

    socket.on('mirror_ack', ({ roomId, h, ok }: { roomId: string; h?: string; ok?: boolean }) => {
      if (typeof roomId !== 'string') return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const user = room.users.get(socket.id);
      if (user?.role !== 'student') return;
      room.mirrorAcks.set(socket.id, { h: typeof h === 'string' ? h : null, ok: !!ok, at: Date.now() });
      if (room.teacherSocketId) {
        io.to(room.teacherSocketId).emit('mirror_status', {
          studentId: socket.id, studentName: user.name, ok: !!ok, at: Date.now(),
        });
      }
    });

    socket.on('mirror_scroll', ({ roomId, scrollX, scrollY }: { roomId: string; scrollX?: number; scrollY?: number }) => {
      if (typeof roomId !== 'string') return;
      if (!checkRateLimit(socket.id, true)) return;
      const room = rooms.get(roomId);
      if (!isMirrorSource(room, socket.id)) return;
      // Respect the teacher's scroll-sync ("Linked") toggle. Without this the
      // mirror dragged every student to the teacher's scroll position even when
      // the teacher had explicitly UNLINKED scrolling — the toggle did nothing.
      if (!room.scrollSyncEnabled) return;
      socket.to(roomId).emit('mirror_scroll', { scrollX, scrollY });
    });
    socket.on('mirror_input', ({ roomId, input }: { roomId: string; input: any }) => {
      if (typeof roomId !== 'string' || !input || typeof input !== 'object') return;
      if (!checkRateLimit(socket.id, false)) return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const user = room.users.get(socket.id);
      if (user?.role !== 'student') return;
      // Only a student who may DRIVE (interactive toggle on, or holds control)
      // can forward input to the teacher's authoritative instance.
      const mayDrive = room.studentInteractionAllowed || (!!user.name && user.name === room.controlHolderName);
      if (!mayDrive) return;
      if (room.teacherSocketId) io.to(room.teacherSocketId).emit('mirror_input', { input, studentName: user.name });
    });
    socket.on('mirror_request', ({ roomId }: { roomId: string }) => {
      if (typeof roomId !== 'string') return;
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      // Serve the cached frame immediately (instant late-join), then ask the
      // teacher to push a fresh one (covers canvas + freshest state). Includes
      // the styling envelope so the cache-served render isn't unstyled.
      if (room.mirrorBody) {
        io.to(socket.id).emit('mirror_dom', {
          body: room.mirrorBody, attrs: room.mirrorAttrs, head: room.mirrorHead, h: room.mirrorHash,
        });
      }
      if (room.teacherSocketId) io.to(room.teacherSocketId).emit('mirror_request', {});
    });

    // ─── STUDENT ABSOLUTE-STATE SNAPSHOT (student → teacher) ───
    // When interaction is allowed, the student streams its real iframe DOM up
    // so the teacher's view tracks the student's TRUE current state — the
    // self-healing fix for quiz/sim drift ("student on Q5, teacher on Q2").
    // Loss-tolerant (rate-limited as such) and relayed ONLY to the teacher.
    // (Removed: the 'student_state' relay. A driving student used to send
    //  its whole serialised document here after every click, and the
    //  teacher's handler for it was a documented no-op. Under the mirror a
    //  student cannot hold a state the teacher does not already have.)


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

    // ─── CONTROL HANDOFF ("give the chalk") ───
    // Teacher grants exclusive drive rights to one student (or revokes with
    // null). The holder's interactions relay room-wide exactly like the
    // global interactive toggle, but scoped to a single student. Keyed by
    // display name so it survives the student's socket reconnecting.
    socket.on('grant_control', ({ roomId, holderName }: { roomId: string; holderName: string | null }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const safeName = holderName === null ? null : sanitizeString(holderName, MAX_USERNAME_LENGTH);
      // Only grant to a student actually in the room (or clear with null).
      if (safeName !== null) {
        const exists = Array.from(room.users.values()).some(u => u.role === 'student' && u.name === safeName);
        if (!exists) return;
      }
      room.controlHolderName = safeName || null;
      bumpRevision(room);
      io.to(roomId).emit('control_changed', { holderName: room.controlHolderName });
      logSync('control_changed', { roomId, revision: room.revision, reason: room.controlHolderName ? `granted:${room.controlHolderName}` : 'revoked' });
    });

    // ─── STUDENT PEEK (teacher views a student's REAL screen) ───
    // Teacher asks; server forwards to that student; the student's iframe
    // serializes its actual DOM and the reply relays back to the teacher
    // only. Read-only — nothing about the student's session changes.
    socket.on('peek_student', ({ roomId, studentId }: { roomId: string; studentId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (typeof studentId !== 'string' || !room.users.has(studentId)) return;
      io.to(studentId).emit('request_student_snapshot', { requestId: `peek-${socket.id}-${Date.now()}` });
    });

    socket.on('student_snapshot', ({ roomId, html, requestId }: { roomId: string; html: string; requestId?: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const user = room.users.get(socket.id);
      if (user?.role !== 'student') return;
      if (typeof html !== 'string' || html.length === 0 || html.length > MAX_FILE_SIZE) return;
      if (room.teacherSocketId) {
        io.to(room.teacherSocketId).emit('student_snapshot', {
          html, requestId, studentId: socket.id, studentName: user.name,
        });
      }
    });

    // Per-student re-sync: rebuild ONE drifted student from canonical state
    // without disturbing the rest of the class (the surgical alternative to
    // a room-wide Force Sync).
    socket.on('resync_student', ({ roomId, studentId }: { roomId: string; studentId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      if (typeof studentId !== 'string' || !room.users.has(studentId)) return;
      emitSessionState(studentId, roomId, room, 'force_sync', `resync-${studentId}-${Date.now()}`);
      // Serve the cached frame straight away, then ask the source for a fresh
      // one. Pushing a dom_snapshot here rebuilt the student's iframe, which
      // restarted the lesson on their screen — the opposite of catching up.
      if (room.mirrorBody) {
        io.to(studentId).emit('mirror_dom', {
          body: room.mirrorBody, attrs: room.mirrorAttrs, head: room.mirrorHead, h: room.mirrorHash,
        });
      }
      if (room.teacherSocketId) io.to(room.teacherSocketId).emit('mirror_request', {});
      logSync('resync_student', { roomId, revision: room.revision, socketId: studentId });
    });

    // ─── LESSON TIME MACHINE (bookmark + rewind canonical state) ───
    const MAX_BOOKMARKS = 8;
    const bookmarksMeta = (room: RoomData) => room.bookmarks.map(b => ({ id: b.id, name: b.name, ts: b.ts }));

    socket.on('bookmark_create', ({ roomId, name }: { roomId: string; name?: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const html = room.liveSnapshotHtml || room.lastRunHtml || getSourceHtml(room);
      const bm = {
        id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: sanitizeString(name, 40) || `Moment ${room.bookmarks.length + 1}`,
        ts: Date.now(),
        html,
        // Deep-copy mutable structures so later edits can't mutate the bookmark.
        whiteboard: structuredClone(room.whiteboard),
        annotations: structuredClone(room.annotations),
        currentStep: room.currentStep,
        zoomLevel: room.zoomLevel,
      };
      room.bookmarks.push(bm);
      if (room.bookmarks.length > MAX_BOOKMARKS) room.bookmarks = room.bookmarks.slice(-MAX_BOOKMARKS);
      io.to(roomId).emit('bookmarks_changed', { bookmarks: bookmarksMeta(room) });
      logSync('bookmark_create', { roomId, revision: room.revision, reason: bm.name });
    });

    socket.on('bookmark_restore', ({ roomId, bookmarkId }: { roomId: string; bookmarkId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      const bm = room.bookmarks.find(b => b.id === bookmarkId);
      if (!bm) return;
      const previousHtml = room.lastRunHtml;
      // Rewind canonical state. The bookmark keeps its own deep copies, so we
      // hand out fresh clones — restoring twice must work.
      room.lastRunHtml = bm.html;
      room.liveSnapshotHtml = null;
      newContentBaseline(room);
      room.whiteboard = structuredClone(bm.whiteboard);
      room.annotations = structuredClone(bm.annotations);
      room.currentStep = bm.currentStep;
      room.zoomLevel = bm.zoomLevel;
      const revision = bumpRevision(room);
      // Canonical broadcast hydrates whiteboard/annotations/step on every
      // client; the run_preview rebroadcast rebuilds every iframe from the
      // bookmarked HTML (clean script re-run — same as Force Sync).
      broadcastFullState(roomId, room, 'restore');
      // Only rebuild the lesson when the bookmark actually holds a DIFFERENT
      // lesson. Re-pushing identical HTML restarted a running simulation from
      // the top for the whole class — so restoring a bookmark to get the
      // whiteboard back also threw away the question everyone was on.
      //
      // A running simulation cannot be rewound by replacing its markup; the
      // whiteboard, annotations and step CAN be, and those are what a bookmark
      // is really for.
      if (bm.html && bm.html !== previousHtml) {
        io.to(roomId).emit('run_preview', { fileId: room.activeFileId, html: bm.html, revision });
      } else if (room.teacherSocketId) {
        io.to(room.teacherSocketId).emit('mirror_request', {});
      }
      io.to(roomId).emit('step_changed', { step: room.currentStep, revision });
      logSync('bookmark_restore', { roomId, revision, reason: bm.name });
    });

    socket.on('bookmark_delete', ({ roomId, bookmarkId }: { roomId: string; bookmarkId: string }) => {
      const room = rooms.get(roomId);
      if (!requireTeacher(room, socket.id)) return;
      room.bookmarks = room.bookmarks.filter(b => b.id !== bookmarkId);
      io.to(roomId).emit('bookmarks_changed', { bookmarks: bookmarksMeta(room) });
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
      // Validate so a malformed gate can't poison canonical state or break
      // student rendering. Options must all be non-blank (order preserved so
      // correctIndex stays valid) and correctIndex must be in range.
      const safeStep = Math.floor(Number(step));
      if (!Number.isFinite(safeStep) || safeStep < 1) return;
      const safeQuestion = sanitizeString(question, MAX_QUIZ_QUESTION_LENGTH);
      if (!safeQuestion || !Array.isArray(options) || options.length < 2) return;
      const safeOptions = options.slice(0, 8).map(o => sanitizeString(o, 200));
      if (safeOptions.length < 2 || safeOptions.some(o => !o)) return;
      const safeCorrect = Math.floor(Number(correctIndex));
      if (!Number.isInteger(safeCorrect) || safeCorrect < 0 || safeCorrect >= safeOptions.length) return;
      room.gates[safeStep] = { question: safeQuestion, options: safeOptions, correctIndex: safeCorrect };
      const revision = bumpRevision(room);
      // Broadcast the question + options (NOT correctIndex) so students can
      // render the checkpoint immediately without leaking the answer key.
      io.to(roomId).emit('gate_added', { step: safeStep, revision, question: safeQuestion, options: safeOptions });
    });

    socket.on('gate_answer', ({ roomId, step, answerIndex, studentName }: { roomId: string; step: number; answerIndex: number; studentName: string }) => {
      const room = rooms.get(roomId);
      if (!isMember(room, socket.id)) return;
      const gate = room.gates[step];
      if (!gate) { socket.emit('gate_result', { correct: false }); return; }
      // Coerce answerIndex before the strict compare: correctIndex is stored as a
      // number (add_gate coerces it), but the wire value could arrive as a string
      // ("1"), which `===` would wrongly mark incorrect — a correct quiz answer
      // silently scored wrong. Number() normalizes it; garbage -> NaN -> wrong.
      const isCorrect = gate.correctIndex === Number(answerIndex);

      // ── Gamification: update XP & streaks ──
      // Coerce studentName to a string FIRST: a client can send a non-string
      // (e.g. a number), and calling .trim() on it throws — which, in an async
      // socket handler, crashes the whole process. Found by the crash-vector audit.
      const name = (typeof studentName === 'string' ? studentName : 'Student').trim().slice(0, 40) || 'Student';
      if (!room.scores[name]) {
        room.scores[name] = { xp: 0, streak: 0, bestStreak: 0, correct: 0, total: 0 };
      }
      const s = room.scores[name];

      // Anti-farm: once a student has earned XP for a given checkpoint, a repeat
      // correct answer (e.g. via devtools or a reopened modal) earns nothing.
      // We still return a result so the client UI proceeds. Wrong answers don't
      // mark the gate as awarded, so a genuine retry-after-wrong still counts.
      const awardKey = `${name}:${step}`;
      if (isCorrect && room.gateAwarded.has(awardKey)) {
        socket.emit('gate_result', {
          correct: true, xpGained: 0, xp: s.xp, streak: s.streak,
          level: Math.floor(s.xp / 100) + 1, levelUp: false,
        });
        return;
      }

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
        room.gateAwarded.add(awardKey);
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
      io.to(roomId).emit('leaderboard_update', buildLeaderboard(room));
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
      room.gateAwarded.clear();
      room.controlHolderName = null;
      resetEventJournal(room);
      io.to(roomId).emit('control_changed', { holderName: null });
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
          // Clear any pending-snapshot membership for this socket so a dead id
          // doesn't linger in the set until the next snapshot sweep.
          room.pendingSyncStudents.delete(socket.id);
          // A closed tab is a hang-up as far as the other party is concerned.
          leaveCall(roomId, room, socket.id);
          room.mirrorAcks.delete(socket.id);

          io.to(roomId).emit('user_list', getRoomUserList(room));
          io.to(roomId).emit('user_left', { userId: socket.id, userName: user?.name || 'Unknown' });

          // Room just emptied: release the transient caches immediately rather
          // than holding them until eviction. mirrorBody is a full copy of the
          // teacher's iframe DOM — the largest single thing a room carries, and
          // updated on every mutation — and it is explicitly re-sent by the
          // source on the next change, so keeping it for an empty room buys
          // nothing and costs megabytes across a day of lessons.
          if (room.users.size === 0) {
            room.mirrorBody = null;
            room.mirrorAttrs = null;
            room.mirrorHead = null;
            room.mirrorHash = null;
            room.liveSnapshotHtml = null;
          }

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
            // Tunable for tests: eviction deliberately skips a room inside the
            // grace window, so a test that cannot shorten this window cannot
            // reach the eviction path at all.
            const TEACHER_DISCONNECT_GRACE_MS = Number(process.env.TEACHER_GRACE_MS) || 45_000;
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
                // Grace expired. Only declare the teacher gone if there is NO
                // live teacher socket at all — re-validate against room.users,
                // not just the cached oldSocketId, so a teacher who returned
                // under a different display name (still a real teacher) is
                // never falsely announced as disconnected.
                const r = rooms.get(roomId);
                if (!r) return;
                const liveTeacher = Array.from(r.users.values()).some(u => u.role === 'teacher');
                if (!liveTeacher) {
                  r.teacherSocketId = null;
                  io.to(roomId).emit('teacher_disconnected');
                  console.log(`👋 Teacher ${expectedTeacherName} declared gone after ${TEACHER_DISCONNECT_GRACE_MS}ms grace`);
                }
                r.pendingTeacherDisconnect = undefined;
              }, TEACHER_DISCONNECT_GRACE_MS),
            };
            console.log(`⏳ Teacher ${expectedTeacherName} disconnected — holding seat for ${TEACHER_DISCONNECT_GRACE_MS / 1000}s`);
          }

          // If the departing student held the control grant and no other
          // socket with the same name remains (multi-tab), clear it so the
          // room isn't stuck "driven" by someone who left. Their grant
          // survives a quick reconnect only via the teacher re-granting —
          // deliberate: control is a live privilege, not a persistent one.
          if (user?.role === 'student' && user.name === room.controlHolderName) {
            const stillHere = Array.from(room.users.values()).some(u => u.role === 'student' && u.name === user.name);
            if (!stillHere) {
              room.controlHolderName = null;
              bumpRevision(room);
              io.to(roomId).emit('control_changed', { holderName: null });
            }
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
  // ─── PUBLIC CLIENT CONFIG ───
  //
  // Vite substitutes import.meta.env at BUILD time, so a host that injects
  // environment variables at run time ships a bundle with nothing in it. That
  // is what happened on Google AI Studio: the app ran, but with no database,
  // no login, no dashboard and no admin page — and setting the variables
  // afterwards changed nothing, because the build had already happened.
  //
  // So the client can ask for them instead. Accepts either naming, since a
  // host's variable list may not offer the VITE_ prefixed pair.
  //
  // ONLY the public pair is ever served. The anon key is designed to be shipped
  // to browsers and is protected by row-level security. The service-role key
  // bypasses RLS entirely and must never appear in this response — it is not
  // read here at all, so it cannot be leaked by a future edit to this handler.
  // ─── ICE SERVERS (how the two browsers find each other) ───
  //
  // STUN alone only works when both networks allow a direct connection between
  // them. Indian mobile carriers put subscribers behind a shared address, and so
  // do most school and office networks — for those there is no direct path at
  // all, and a call with no relay simply never connects. That is not a rare edge
  // case; it is a normal share of real lessons.
  //
  // A TURN relay is the fallback. Credentials are minted here, per request, and
  // expire — the browser never holds a long-lived secret, so a shared lesson
  // link can never leak relay access. Two provider shapes are supported:
  //
  //   TURN_URLS + TURN_SECRET          → the standard coturn/Cloudflare HMAC
  //                                      scheme (username is an expiry stamp,
  //                                      password is its HMAC). Preferred.
  //   TURN_URLS + TURN_USERNAME
  //               + TURN_PASSWORD      → a provider issuing static credentials.
  //
  // With none of them set the response is STUN-only and the app still works for
  // everyone whose network permits a direct connection — it just tells the tutor
  // when a call failed for want of a relay, instead of failing silently.
  app.get('/api/turn', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const stun: Array<Record<string, unknown>> = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    const urls = (process.env.TURN_URLS || '').split(',').map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) {
      res.json({ iceServers: stun, relay: false });
      return;
    }
    const ttl = Math.max(60, Number(process.env.TURN_TTL_SECONDS) || 3600);
    const secret = (process.env.TURN_SECRET || '').trim();
    if (secret) {
      // coturn's REST convention: username is "<unix-expiry>", credential is the
      // base64 HMAC-SHA1 of it under the shared secret.
      const username = String(Math.floor(Date.now() / 1000) + ttl);
      const credential = createHmac('sha1', secret).update(username).digest('base64');
      res.json({ iceServers: [...stun, { urls, username, credential }], relay: true, expiresIn: ttl });
      return;
    }
    const username = (process.env.TURN_USERNAME || '').trim();
    const credential = (process.env.TURN_PASSWORD || '').trim();
    if (username && credential) {
      res.json({ iceServers: [...stun, { urls, username, credential }], relay: true, expiresIn: ttl });
      return;
    }
    // URLs without credentials would be rejected by the browser anyway.
    res.json({ iceServers: stun, relay: false });
  });

  // /api/config used to hand the browser a third party's URL and anon key so
  // it could build an auth client. Accounts are served from here now, so there
  // is nothing for a browser to be told: it asks /api/auth/me and is answered.

  // Two paths for the same check. Some hosts reserve /healthz at their edge
  // and answer it themselves — Google AI Studio returns its own 404 there — so
  // the client would conclude the server was unreachable and skip the passcode
  // prompt entirely. /api/healthz is under a prefix hosts leave alone.
  // ─── IS THE DATABASE THERE? ───
  //
  // Added 3 Sep 2026, after the failure this could not see. Postgres was
  // OOM-killed at 06:09 and stayed down for nearly three hours: its unit had
  // no Restart=, and the kernel chose it over the app. Sign-in, saving a
  // lesson and durable rooms were all broken the whole time — two real rooms
  // failed to persist — and this endpoint answered {"ok":true,
  // "durableRooms":true} throughout, because `durableRooms` reports which
  // store was CONFIGURED, not whether it answers. So the watchdog saw a
  // healthy site once a minute and did nothing.
  //
  // Cached for fifteen seconds because the watchdog, the keep-warm ping and
  // the tests all hit this; an uncached probe would add a query per call for a
  // number that cannot change that fast.
  let dbProbe: { ok: boolean; at: number; error: string | null } = { ok: true, at: 0, error: null };
  async function databaseReachable(): Promise<{ ok: boolean; error: string | null }> {
    // No database configured is not the same as a database that is down.
    if (!appPool) return { ok: true, error: null };
    const now = Date.now();
    if (now - dbProbe.at < 15_000) return { ok: dbProbe.ok, error: dbProbe.error };
    try {
      // Bounded, because a hung connection would otherwise hang the health
      // check itself — turning "the database is slow" into "the site is down".
      await Promise.race([
        appPool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 3s')), 3000)),
      ]);
      dbProbe = { ok: true, at: now, error: null };
    } catch (err) {
      dbProbe = { ok: false, at: now, error: (err as Error).message.slice(0, 140) };
    }
    return { ok: dbProbe.ok, error: dbProbe.error };
  }

  app.get(['/healthz', '/api/healthz'], async (_req, res) => {
    const db = await databaseReachable();
    res.status(200).json({
      // Deliberately still true when the database is down. `ok` is what the
      // watchdog restarts the app on, and restarting the app does not start
      // Postgres — it would only cut whatever lesson was still working. The
      // watchdog reads `db` separately and starts the database instead.
      ok: true,
      db: db.ok ? 'up' : 'down',
      ...(db.error ? { dbError: db.error } : {}),
      uptime: process.uptime(),
      rooms: rooms.size,
      // How long since ANY room saw activity. A tab left open overnight keeps
      // rooms>0 forever, so "is a class in progress" cannot be answered by
      // presence alone — a deploy that waits for rooms=0 would wait for ever.
      idleMs: rooms.size === 0 ? null : Date.now() - Math.max(
        ...[...rooms.values()].map(r => r.lastActivityAt || 0),
      ),
      // Which build is actually live. Render injects RENDER_GIT_COMMIT; this
      // lets you curl /healthz and confirm your latest push really deployed
      // (instead of guessing whether a fix is live). Falls back to 'dev' locally.
      commit: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'dev').slice(0, 7),
      durableRooms: roomStore.kind !== 'file',
      // Whether to show the prompt — never the code itself.
      passcodeRequired,
      ts: Date.now(),
    });
  });

  // ─── HTTP API: QUICK DEPLOY (drop HTML → instant shareable page) ───
  // Paste or upload HTML on the landing page and get a live link in one step —
  // no login, no delay. We persist it as an ANONYMOUS room (24h TTL, the same
  // lifecycle as any ad-hoc room), so:
  //   • it's viewable at /p/:id (the standalone viewer renders the REAL HTML,
  //     scripts intact — works with NO teacher present: deploy-and-forget), and
  //   • it can be opened as a live class at /room/:id (Live Mirror) any time.
  // Registered BEFORE the global express.json() below so it gets a large body
  // limit (lesson HTML can be up to MAX_FILE_SIZE, far past the 100kb default).
  function genPageId(): string {
    const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'; // no look-alikes (0/o/1/l)
    let id = '';
    for (let i = 0; i < 8; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
    return id;
  }
  // Registered before the handler below, so it runs first: quick deploy writes
  // a room row per call and needs no account, which makes it the cheapest way
  // to fill this box's disk. Ten an hour is far past what a person publishing
  // pages by hand will ever do.
  app.post('/api/publish', rateLimit({
    name: 'publish', windowMs: 3_600_000,
    max: Number(process.env.PUBLISH_PER_HOUR) || 10,
    body: (s) => ({ error: `Too many pages published. Try again in ${Math.ceil(s / 60)} minutes.`, code: 'rate_limited' }),
  }));
  app.post('/api/publish', express.json({ limit: '6mb' }), async (req, res) => {
    if (!passcodeOk(req.get('x-site-passcode') || (req.body as { passcode?: string } | undefined)?.passcode)) {
      return res.status(401).json({ error: 'passcode_required' });
    }
    try {
      const body = (req.body || {}) as { html?: unknown; name?: unknown };
      const html = typeof body.html === 'string' ? body.html : '';
      if (!html.trim()) { res.status(400).json({ error: 'No HTML provided' }); return; }
      if (html.length > MAX_FILE_SIZE) {
        res.status(413).json({ error: `HTML too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)` });
        return;
      }
      const name = sanitizeString(body.name, 80) || 'Shared page';
      // Unique, valid, hard-to-guess id (retry on the rare in-memory collision).
      let id = genPageId();
      for (let i = 0; i < 5 && rooms.has(id); i++) id = genPageId();
      if (rooms.has(id)) { res.status(503).json({ error: 'Please try again' }); return; }
      const room = createRoom();
      const fileId = 'deploy';
      room.files = [{ id: fileId, name, html, uploadedAt: Date.now() }];
      room.activeFileId = fileId;
      room.lastRunHtml = html;
      room.revision = 1;
      rooms.set(id, room);
      updateRoomActivity(id);
      await persistRoom(id); // durable so the link survives the deployer closing the tab
      console.log(`🚀 Quick-deploy published → /p/${id} (${(html.length / 1024).toFixed(0)}KB, 24h TTL)`);
      res.json({ id, expiresAt: computeExpiresAt(room), viewPath: `/p/${id}`, roomPath: `/room/${id}` });
    } catch (err) {
      console.error('Publish failed:', err);
      res.status(500).json({ error: 'Publish failed' });
    }
  });

  // ─── HTTP API: Room content fallback ───
  // Students can fetch room HTML via plain HTTP if Socket.io delivery fails
  // Board images post a data URL, which is ~33% larger than the bytes and
  // can legitimately reach a few MB. Registered before the global parser so
  // it gets a body limit that fits an image rather than the default 100kb.
  if (appPool) {
    app.post('/api/board-image', express.json({ limit: '12mb' }));
  }

  // ─── SAVING A LESSON MUST NOT FAIL SILENTLY ───
  //
  // A saved lesson carries the whole whiteboard as JSON. The global parser
  // below defaults to 100 kB, which a board with a few hundred strokes passes
  // without trying — and the answer was a bare 413 the client swallowed, so a
  // tutor saw "Saved" (it never checked) and lost the board. Registered here,
  // ahead of the global parser, for the same reason board images are.
  //
  // 8 MB is chosen against what a board actually contains now that pictures
  // live in `board_images` and only their URLs are in the document: strokes,
  // shapes, text and instrument geometry. It is a ceiling under a bug, not a
  // working size, which is why the route is also the most tightly rate-limited
  // one here — 8 MB × an unbounded rate is a memory attack on a 1 GB box.
  const SESSION_BODY_LIMIT = process.env.SESSION_BODY_LIMIT || '8mb';
  const sessionWriteLimit = rateLimit({
    name: 'session-write', windowMs: 60_000,
    max: Number(process.env.SESSION_WRITES_PER_MIN) || 20,
  });
  app.post('/api/sessions', sessionWriteLimit, express.json({ limit: SESSION_BODY_LIMIT }));
  app.patch('/api/sessions/:id', sessionWriteLimit, express.json({ limit: SESSION_BODY_LIMIT }));

  app.use(express.json());

  // ─── EVERY OTHER WRITE ───
  //
  // Reads are deliberately untouched: the dashboard polls `/api/waiting` every
  // ten seconds and the watchdog polls `/api/healthz` every minute, and neither
  // costs anything worth defending. Writes are what create rows, send email and
  // spend money.
  const apiWriteLimit = rateLimit({
    name: 'api-write', windowMs: 60_000,
    max: Number(process.env.API_WRITES_PER_MIN) || 60,
  });
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return apiWriteLimit(req, res, next);
  });

  // ─── Teacher identity and records (replaces Supabase) ───
  //
  // Mounted only with a database: without one there is nothing to sign in to,
  // and the app must still run — link-based rooms and the whiteboard never
  // needed an account.
  //
  // SESSION_SECRET must be stable across restarts or every teacher is signed
  // out on each deploy. It is generated per-boot when unset so local
  // development needs no setup, and that is precisely why production must set
  // it; the warning below is the only thing standing between a missing env var
  // and a mystery.
  if (appPool) {
    sessionSecret = process.env.SESSION_SECRET || null;
    if (!sessionSecret) {
      console.warn('\u26a0\ufe0f  SESSION_SECRET is not set \u2014 teachers will be signed out on every restart.');
      sessionSecret = randomBytes(32).toString('hex');
    }
    // ─── SIGN-IN, THE ONE ROUTE THAT SPENDS SOMEBODY ELSE'S MONEY ───
    //
    // Every call to magic-link sends an email. Unlimited, that is a way to
    // empty a Resend quota, to put this domain's sending reputation in front of
    // a spam filter, and to post a stranger's inbox full of sign-in links they
    // never asked for. Two windows, because they stop different things: the
    // per-address one stops a single inbox being buried, and the per-caller one
    // stops one machine walking an address list.
    //
    // The refusal is a 429 either way, and identical whether or not the address
    // has an account — so it still cannot be used to find out who is a teacher
    // here. (PLAN.md task 0.2 suggested answering "check your email" for that
    // reason; a 429 leaks nothing extra and does not lie to a tutor who
    // double-clicked, so it is the answer given.)
    const magicLinkPerAddress = rateLimit({
      name: 'magic-link/address', windowMs: 3_600_000,
      max: Number(process.env.MAGIC_LINK_PER_EMAIL_PER_HOUR) || 5,
      key: (req) => String((req.body as { email?: string } | undefined)?.email || '').trim().toLowerCase() || null,
      body: (s) => ({
        error: `We have already sent several sign-in links to that address. Check your inbox and spam folder, or try again in ${Math.ceil(s / 60)} minutes.`,
        code: 'rate_limited',
      }),
    });
    const magicLinkPerCaller = rateLimit({
      name: 'magic-link/caller', windowMs: 3_600_000,
      max: Number(process.env.MAGIC_LINK_PER_IP_PER_HOUR) || 20,
      body: (s) => ({
        error: `Too many sign-in requests from this connection. Try again in ${Math.ceil(s / 60)} minutes.`,
        code: 'rate_limited',
      }),
    });
    app.post('/api/auth/magic-link', magicLinkPerCaller, magicLinkPerAddress);
    // The callback is a GET, so the write limiter above never sees it. A link
    // is single-use and its token is 32 random bytes, so this is not guessable
    // — the ceiling is here to stop the guessing being free.
    app.get('/api/auth/callback', rateLimit({
      name: 'auth-callback', windowMs: 3_600_000,
      max: Number(process.env.AUTH_CALLBACK_PER_HOUR) || 30,
    }));

    mountAuthRoutes(app, appPool, {
      secret: sessionSecret,
      secure: process.env.NODE_ENV === 'production',
    });
    mountRecordRoutes(app, appPool, { secret: sessionSecret });
    mountBoardImageRoutes(app, appPool, { secret: sessionSecret });
    mountBillingRoutes(app, appPool, { secret: sessionSecret });
    mountPeopleRoutes(app, appPool, { secret: sessionSecret });
    mountOwnerDashRoutes(app, appPool, {
      secret: sessionSecret,
      // Names only, and only for rooms that are actually occupied. The admin
      // screen answers "who is teaching right now", which needs no lesson
      // content, no board, and no chat — so none of it leaves the process.
      liveRooms: (): LiveRoom[] => {
        const out: LiveRoom[] = [];
        for (const [roomId, room] of rooms) {
          if (room.users.size === 0) continue;
          let teacher: string | null = null;
          const students: string[] = [];
          let teacherDevice: string | null = null;
          const studentDevices: string[] = [];
          for (const [socketId, u] of room.users) {
            if (u.role === 'teacher' && socketId === room.teacherSocketId) {
              teacher = u.name;
              teacherDevice = u.clientId ?? null;
            } else if (u.role === 'student') {
              students.push(u.name);
              if (u.clientId) studentDevices.push(u.clientId);
            }
          }
          out.push({
            roomId, teacher, students,
            teacherDevice, studentDevices,
            // Students in the room with nobody in the teacher seat. This is the
            // state that costs a lesson, so the owner should see it named.
            waiting: students.length > 0 && !room.teacherSocketId,
            startedAt: room.createdAt,
            lastActivityAt: room.lastActivityAt,
            paused: room.isPaused,
          });
        }
        return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      },
    });
    startDailyJobs(appPool);
    console.log('\ud83d\udd11 Teacher accounts: this server\u2019s own database');
    console.log('\ud83d\udd12 Teacher ownership enforcement: ON (registered classes are owner-only)');
  } else {
    console.log('\ud83d\udd11 Teacher accounts: OFF (no DATABASE_URL)');
  }
  app.get('/api/room/:roomId/content', (req, res) => {
    if (!passcodeOk(req.get('x-site-passcode') || (req.query.passcode as string | undefined))) {
      return res.status(401).json({ error: 'passcode_required' });
    }
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
    // Respect the room password. This HTTP fallback is unauthenticated, so a
    // password-protected room must NOT hand out its lesson HTML here — that
    // would let anyone with the room code read content the socket path gates
    // behind the password. Students in a password room join over the socket
    // (with the password) and never need this fallback.
    if (room.password) {
      res.status(403).json({ error: 'This room is password protected' });
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

  // Vite middleware for development.
  //
  // Imported HERE rather than at the top of the file, and that placement is
  // load-bearing. A top-level `import { createServer } from 'vite'` is
  // evaluated on every boot, so production pulled in the entire bundler —
  // rollup, the esbuild binary, the plugin graph — purely to skip past it one
  // line later. On a scale-to-zero host that cost is paid on every cold start,
  // by a real student waiting for the room to open, and it forced vite to stay
  // a production dependency so the runtime image carried the toolchain too.
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
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

  // ─── KEEP-WARM (the real fix for "works at first, then crashes mid-class") ───
  // Render's free tier spins the instance DOWN after ~15 min with no inbound
  // traffic. Because rooms live in memory, that sleep WIPES every live class;
  // the next click then hits a 20–60s cold start and comes back to an empty
  // room. During a lesson there are naturally quiet stretches (the teacher is
  // explaining), so this is exactly what kept breaking sync.
  //
  // Fix: ping our OWN public URL every 10 min. The request leaves the box and
  // re-enters through Render's router, so it counts as inbound traffic and the
  // instance never idles out. RENDER_EXTERNAL_URL is injected by Render; allow
  // SELF_URL as a manual override for other hosts. (One always-on free service
  // ≈ 730 hrs/mo, within Render's 750-hr free allowance.)
  // NOTE: this only prevents IDLE sleep. A redeploy/crash still resets in-memory
  // rooms — set UPSTASH_REDIS_REST_URL + _TOKEN for rooms that survive restarts.
  //
  // ── AND the reason it must be switchable ──
  // "One always-on free service ≈ 730 hrs/mo, within the 750-hr allowance" is
  // a 2.7% margin, for ONE service, on an account that has five. Keeping warm
  // therefore consumes essentially the whole monthly quota whether anyone
  // teaches or not — which is how this account came to be suspended.
  //
  // Set KEEP_WARM=off to let the instance sleep between lessons. On a few
  // hours of teaching a day that is ~120 hrs/mo instead of ~730. The cost is a
  // 20-60s cold start for whoever arrives first, which is now a far softer
  // landing than it used to be: an early student sees the waiting room and is
  // admitted automatically once the server wakes, and with Upstash configured
  // the rooms survive the sleep. Without Upstash, sleeping still wipes live
  // rooms — set it before turning this off.
  const SELF_URL = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/$/, '');
  const keepWarmOn = (process.env.KEEP_WARM || 'on').toLowerCase() !== 'off';
  if (!keepWarmOn) {
    console.log('😴 Keep-warm OFF — the instance may sleep when idle (saves free-tier hours; expect a cold start)');
  }
  if (keepWarmOn && process.env.NODE_ENV === 'production' && SELF_URL && typeof fetch === 'function') {
    const KEEP_WARM_MS = 10 * 60 * 1000;
    setInterval(() => {
      fetch(`${SELF_URL}/healthz`).catch(() => { /* best-effort; ignore */ });
    }, KEEP_WARM_MS).unref?.();
    console.log(`⏰ Keep-warm: self-ping ${SELF_URL}/healthz every 10 min (prevents free-tier idle sleep)`);
  }
}

startServer();
