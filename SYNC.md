# SYNC.md — Math Live sync architecture contract

Read `AGENTS.md` first, then this file. Do not modify the sync system without
understanding everything below.

---

## 0. One-line summary

> The server holds canonical, revisioned room state. Clients hydrate from
> `session_state` (unicast) and `sync_full_state` (broadcast). Stale revisions
> are dropped. Snapshots are request/ack. Teacher is authoritative.

---

## 1. Authority model

| Actor   | What they may mutate                                              |
|---------|--------------------------------------------------------------------|
| Teacher | Active file, live snapshot HTML, scroll/zoom, whiteboard, gates,  |
|         | step, scroll-sync flag, student-interaction flag, temp content.   |
| Server  | `revision`, persisted state, derived `effectiveHtml`.             |
| Student | Own cursor, own answers, optionally interaction events            |
|         | (only when `studentInteractionAllowed`).                          |

**Server enforces** authority via `requireTeacher(room, socket.id)` for every
sync-critical event. Clients **must not** trust each other.

---

## 2. Canonical room state (server)

`RoomData` in `server.ts` is the source of truth. Sync-critical fields:

```
files[]                  // FileEntry[] — uploaded HTML files (source)
activeFileId             // which file is the active simulation
lastRunHtml              // last broadcast HTML (source-or-snapshot, persistence-friendly)
liveSnapshotHtml         // teacher iframe DOM snapshot (live)
revision                 // monotonic, bumped on every canonical mutation
isPaused
scrollSyncEnabled
studentInteractionAllowed
currentStep
gates
tempContent              // temporary explanation HTML (overlay, not main)
whiteboard.objects       // image/object array
whiteboard.strokes       // ink strokes
whiteboard.view          // pan/zoom view
lastTeacherScroll        // last teacher SYNC_SCROLL event (for late-join catch-up)
zoomLevel                // app-level zoom of the simulation viewport
```

If you add a new sync-critical field, you **must** update:

1. `RoomData` in `server.ts`
2. `SessionStatePayload` in `server.ts`
3. `buildSessionState()` (so the field is included)
4. `serializeRoom()` and `restoreRooms()` (so it survives restart)
5. `applySessionState()` in `Room.tsx`
6. `applySessionState()` in `StudentView.tsx`

Skipping any of these silently breaks reconnect/late-join recovery.

---

## 3. Source HTML vs live snapshot

These are different things and must remain different:

- **`sourceHtml`** — derived from `files[activeFileId].html` (what the teacher
  uploaded/pasted; what we want when restarting from scratch).
- **`liveSnapshotHtml`** — DOM serialization of the teacher's running iframe
  (carries current input values, sliders, runtime state).
- **`effectiveHtml`** — what clients should render now:
  `liveSnapshotHtml ?? lastRunHtml ?? sourceHtml`.

`buildSessionState()` computes `effectiveHtml`. Clients render that.

---

## 4. Message types

### 4.1 Canonical (always prefer these)

| Event              | Direction       | Purpose                                       |
|--------------------|-----------------|-----------------------------------------------|
| `session_state`    | server → client | Unicast hydration on join / request_content. |
| `sync_full_state`  | server → room   | Broadcast canonical state after a mutation.  |

Payload shape: `SessionStatePayload` in `server.ts`. Includes `revision`,
`reason`, optional `requestId`.

### 4.2 Snapshot request/ack (no timing hacks)

```
server → teacher : request_html_sync { requestId, reason }
teacher → server : dom_snapshot      { roomId, html, requestId, hasCanvas }
server → room    : sync_full_state   { revision, requestId, reason }
```

**Snapshots are for late-join catch-up and explicit Force Sync ONLY.**
Already-connected students are never pushed a DOM snapshot — they stay in
step via the interaction event-replay stream (§4.3). The former `live_dom`
continuous body-swap mirror is RETIRED: swapping `body.innerHTML` destroyed
the student sim's event listeners (their clicks stopped doing anything),
detached the nodes the sim's own scripts animate (canvas/3D sims froze or
blanked), and raced the replay stream (quiz drift). Do not reintroduce it.

**`hasCanvas` rule:** `<canvas>`/WebGL content cannot be serialized via
outerHTML — the snapshot is an empty shell. When the iframe reports
`hasCanvas: true`, the server stores NO `liveSnapshotHtml` (and Force Sync
does NOT rewrite `lastRunHtml` / `file.html`); late-joiners boot the pristine
source and the replay stream brings them forward.

`requestId` rules:
- `late-<sid>-<ts>` — student joined late, needs current state.
- `force-<sid>-<ts>` — teacher pressed Force Sync.
- `retry-<sid>-<ts>` — student requested fresh content.
- `snap-<...>`      — teacher debounced auto-snapshot after interaction
                      (and `snap-hb-` 2.5s heartbeat) — feeds the SERVER's
                      liveSnapshotHtml for future late-joins; never pushed
                      to connected students.

### 4.3 Incremental interactions

`interaction { roomId, event }` — small deltas (`SYNC_CURSOR`, `SYNC_CLICK`,
`SYNC_SCROLL`, `SYNC_INPUT`, ...). Broadcast teacher → all students.
Student events (when `studentInteractionAllowed`): `SYNC_CURSOR` relays to
the teacher only; discrete events broadcast to everyone EXCEPT the sender
(teacher's authoritative sim + every other student's sim replay them, so all
instances advance by the same event stream).
Server stamps `serverSeq` and `serverTs`. Clients drop events with
`serverSeq <= lastInboundSeqRef.current`.

If `event.type === 'SYNC_SCROLL'` from teacher, server stores it as
`room.lastTeacherScroll` so late-joining students can catch up via canonical
state.

### 4.4 Legacy events (kept for backwards compat — do not extend)

`room_state`, `run_preview`, `dom_snapshot`, `force_sync_state`,
`active_file_changed`. New code should not depend on these. They are now
duplicated by `session_state` / `sync_full_state` and exist only so older
client builds keep working during rollout.

`live_dom` is fully retired (2026-06): the server no longer emits it and
clients no longer listen. See §4.2 for why.

---

## 5. Lifecycle flows

### 5.1 Teacher joins (creates room)
1. Client emits `join_room { role: 'teacher' }`.
2. Server creates room, sets `teacherSocketId`.
3. Server emits legacy `room_state` + canonical `session_state`.
4. Teacher renders. Iframe boots, starts emitting `SYNC_*`.

### 5.2 Student joins late
1. Client emits `join_room { role: 'student' }`.
2. Server adds to `pendingSyncStudents`, emits `request_html_sync` to teacher.
3. Server unicasts `session_state` (so student sees current files, gates,
   whiteboard, scroll, zoom, temp content immediately, even before the
   teacher's snapshot arrives).
4. Teacher snapshot arrives via `dom_snapshot` → server bumps revision and
   `broadcastFullState('snapshot_ack', requestId)`.
5. Student applies the newer revision; `applySessionState` queues
   `lastTeacherScroll` as a `REMOTE_SCROLL` to the iframe so view aligns
   on first load.

### 5.3 Student reconnects
Same as 5.2. The `revision` guard makes this idempotent — replaying or
duplicating `session_state` does not corrupt the client.

### 5.4 Force sync (teacher)
1. Teacher's local handler (`handleForceSync`) issues a `force-` request to
   its own iframe and emits `dom_snapshot` when the iframe responds. The
   server then `broadcastFullState('force_sync', requestId)`.
2. Alternatively any caller can emit `force_sync` to the server, which calls
   `request_html_sync` on the teacher and broadcasts on ack.

### 5.5 File upload / switch / run_preview
- Server updates `files`, `activeFileId`, `lastRunHtml`, clears
  `liveSnapshotHtml`, bumps `revision`.
- Server emits legacy `run_preview` + canonical `sync_full_state('run_preview')`.

### 5.6 Whiteboard mutation
- Teacher emits `whiteboard_*` event. Server mutates `room.whiteboard.*`,
  rebroadcasts to others, persists. Late-joiners get state via
  `applySessionState`.

### 5.7 Scroll / zoom / mode toggles
- All gate on `requireTeacher`. All bump revision and `broadcastFullState`
  (or store in `lastTeacherScroll` for `SYNC_SCROLL`).

---

## 6. Client hydration rules (`applySessionState`)

```ts
if (state.revision < lastRevisionRef.current) return; // drop stale
lastRevisionRef.current = state.revision;

// hydrate files, activeFileId, isPaused, scroll/interaction flags,
// currentStep, zoomLevel, gates, tempContent, whiteboard, lastTeacherScroll.

const html = state.effectiveHtml ?? state.liveSnapshotHtml
           ?? state.lastRunHtml  ?? state.sourceHtml;
if (html) setPreviewHtml(prev => prev === html ? prev : html);
```

Never branch on legacy fields when canonical fields exist.

---

## 7. Iframe transport rules

- All `iframe.contentWindow.postMessage` goes through `postToIframe()`.
- If `iframeReadyRef.current` is false, the message goes into
  `pendingMessagesRef`.
- On iframe `onLoad`, the queue is flushed and per-session state
  (scroll-sync flag, current step, zoom) is replayed.
- Do **not** set `iframeReadyRef = true` anywhere except the iframe `onLoad`
  handler.
- Do **not** rely on a `setTimeout` to "wait for the iframe to be ready."

---

## 8. Idempotency & ordering guarantees

- **Idempotent:** `session_state`, `sync_full_state`, snapshot acks. They can
  be received twice safely.
- **Ordered:** `interaction` events carry `serverSeq`. Clients drop
  out-of-order seqs.
- **Stale rejection:** every revisioned event must call the revision guard.

If you add a new event and it does not satisfy at least one of these, you are
about to introduce a sync bug.

---

## 9. Observability

Server uses `logSync(eventType, { roomId, revision, requestId, role,
socketId, reason })` for every canonical event. Use it. Do not invent ad-hoc
`console.log` shapes — JSON-line logs are how we trace cross-client issues.

---

## 10. Things explicitly forbidden

1. Adding a new "source of truth" for HTML (e.g. `roomHtmlCache`,
   `lastBroadcastHtml`, an HTTP fallback as primary path).
2. Time-based "wait then send" hacks for snapshot delivery.
3. Direct `postMessage` to the iframe outside the queued transport.
4. Forgetting to bump `revision` after a teacher mutation.
5. Forgetting to update `applySessionState` when adding canonical fields.
6. New top-level events that duplicate `sync_full_state` data.
7. Letting students mutate canonical state when
   `studentInteractionAllowed === false`.

---

## 11. Pre-merge checklist for sync changes

- [ ] `npm install && node node_modules/typescript/bin/tsc --noEmit` passes.
- [ ] New canonical field is present in all 6 places listed in §2.
- [ ] New events use `requestId` if they are request/ack.
- [ ] No new `setTimeout(..., N)` "wait for sync" hacks.
- [ ] Late-join recovery still works (test by joining a 2nd browser tab
      after a few teacher interactions).
- [ ] Reconnect still works (test by killing the student's network briefly).
- [ ] Stale `revision` is dropped on the client (logged or asserted).
- [ ] `SYNC.md` updated if the protocol changed.
