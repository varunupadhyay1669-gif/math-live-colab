# IMPROVEMENTS.md — continuous improvement log

Two-phase loop: PHASE 1 (correctness: build/test) → PHASE 2 (research-driven features) → repeat.
App: **MathsLive** — 1-to-1 live visual math tutoring (React/Vite/Express/Socket.IO/TS, Render free tier).
Goal: fast, engaging 1-to-1 math classes. Constraints: free-tier hostable, no data-model break, no bloat.

---

## Cycle 1 — research the live-tutoring space

**PHASE 1 baseline (green):** tsc 0, vite build 0, full socket suite **151 checks** (verify-sync 48,
stress 19, stress2 16, stress3 11, stress4 26, stress5 13, stress6 16, stress7 2). Core flows
browser-verified (sync, interactive-click + Pointer tool, scroll, reconnect). Live deploy keep-warm.

**Research (web, June 2026):**
- Best online math tutoring / whiteboard features — thirdspacelearning, learner.com, ziteboard,
  myengineeringbuddy: real-time whiteboard, **equation editors / function graphing / grids**,
  **session recording + re-watch**, screen-share, gamification, mobile (≈73% of sessions on mobile).
- Engagement/retention — moldstud, monsoonfish, research.com: interactive quizzes + **instant
  positive feedback** (retention +30%), gamification (badges/leaderboards ≈2× DAU), adaptive paths.
- Open-source whiteboards (ideas only, not code; licenses noted):
  - WBO / whitebophir — https://github.com/lovasoa/whitebophir (AGPL-3.0 → ideas only)
  - Spacedeck Open — https://github.com/spacedeck/spacedeck-open
  - Channelize Whiteboard SDK — https://github.com/ChannelizeIO/Channelize-Whiteboard-SDK
  (We already have a Socket.IO whiteboard, so limited borrowing — these confirm feature parity.)

**What MathsLive already has:** real-time whiteboard, gamification (XP/streak/level/leaderboard),
quizzes/gates with instant feedback + confetti, control handoff, student peek, time machine,
element ping, reactions, chat, session recorder (record/autosave/download/`playback()` infra).

**Gaps vs. the field (ranked by impact-to-effort, within constraints):**

| # | Idea | Source | Why it serves the goal | Effort | Risk | Impact |
|---|------|--------|------------------------|--------|------|--------|
| 1 | **Math equation input (KaTeX-rendered text on the whiteboard)** | ziteboard / thirdspacelearning (equation editors) | Writing real math (fractions, exponents, roots, symbols) every session — freehand pen is slow/messy. Reuses existing whiteboard text sync **and an existing dep (KaTeX)** — no new dep, no data-model change. | M | M (whiteboard render path) | 8 |
| 2 | **Session re-watch player** (load a recording → replay) | thirdspacelearning / learner.com (re-watch lessons) | Students re-watch lessons. Recorder + `playback()` already exist; needs a player UI. | M | M | 7 |
| 3 | **Mobile student polish** | "≈73% sessions on mobile" (research.com) | Students join on phones; ensure the student view is fully usable on small screens. | M | L–M | 7 |
| 4 | **Function graphing tool** | ziteboard / myengineeringbuddy (graphing) | Plot y=f(x) live. **Needs a new dep (graphing lib)** → pauses per constraints. | L | M | 7 |
| 5 | Math symbol quick-insert palette | ziteboard | Quick √ π ² ½ ≤ ≥ … into whiteboard text. Small, on-goal. | S | L | 5 |
| 6 | Persistent cross-session progress | research.com (progress tracking) | **Needs a DB → data-model change** → out of scope per constraints. | L | H | 6 |

**Pick:** #1 — Math equation input via KaTeX.

**OUTCOME (after go-ahead): already implemented — verified, not rebuilt.**
On inspection, `Whiteboard.tsx` already has the full feature (a prior autonomous build):
`katex` import, `renderLatexToHtml()` (throwOnError:false + try/catch fallback), `MathLabel`
DOM overlay (pointer-events:none, scales with zoom, measures bbox), a `latex` flag on
`BoardText`, a math-mode toggle, a **symbol palette** (×÷π√x²x³≤≥≠≈∞∫Σ∠θ⅓ — this was list
item #5, also already done), and a live preview. The server preserves the `latex` flag on
`whiteboard_add_text`/`update_text` and stores it in `room.whiteboard.texts` (hydrated to late
joiners via `session_state`).

**Verification (run, not assumed):**
- Browser (teacher): Text tool → editor → math toggle → typed `x^2 + \frac{1}{2} = \sqrt{a+b}`
  → live preview rendered a real `.katex` element; on commit, a `.katex` MathLabel rendered on
  the board (content `x²+½=√(a+b)`).
- Socket: teacher `whiteboard_add_text {latex:true}` → student `session_state.whiteboard.texts`
  contains it with `latex===true` and the LaTeX source verbatim. **PASS.**
- Mobile: student view at 375px has **no horizontal overflow** (clean responsive layout).
- **New regression test:** stress2 **T11** (math label syncs to late joiner, latex preserved).
  Full suite now 153 checks.
- No new code needed for the feature itself; the cycle's artifact is the missing test coverage.

**Next candidates (still open):** #2 session re-watch PLAYER (recorder + `playback()` exist;
a playback *renderer* is Large) · #3 mobile is already clean (no work needed) · #4 graphing
(needs a new dep → pause). The app already meets/exceeds competitor feature parity, so future
cycles must guard against bloat (per Constraints) — prefer depth/quality over new surface.

---

## Cycle 2 — BIDIRECTIONAL sync (student → teacher) [reported bug]

**Bug (from user screenshots):** teacher→student sync worked, but when a student in
**interactive mode** clicked/scrolled, the **teacher could not see it**. Wanted: bidirectional.

**Root cause:** StudentView only emitted interactions when `canDrive` (control-holder), and the
server only relayed a student's events room-wide for the control-holder. An interactive
(non-control) student's events never left the client → teacher saw nothing.

**Fix (determinism-safe, no DOM-swap — preserves handlers):**
- StudentView: emit interactions when `canInteract` (interactive OR control), not just `canDrive`.
- server.ts `interaction` handler: new branch — an interactive student's events relay to the
  **TEACHER ONLY** (not room-wide, not journaled), so the teacher mirrors via `REMOTE_*` + shows a
  student-click indicator. Single-writer among students preserved (no random-sim divergence).

**Tests (multiple, as requested):** new **stress8** (6 checks) — BD1 click→teacher, BD2
scroll→teacher, BD3 view-only stays one-way, BD4 no leak to other students, BD5 control-holder
still room-wide, BD6 teacher→student still works. Proven to catch the bug: **pre-fix BD1/BD2 FAIL,
post-fix all 6 PASS.** Updated verify-sync **Test R** to the new requirement (was "non-holder
never reaches teacher"; now "reaches teacher only"). Full suite on a clean server: **159 green**
(verify-sync 48, stress 19, stress2 18, stress3 11, stress4 26, stress5 13, stress6 16, stress7 2,
stress8 6). Browser e2e was blocked by a flaky preview process; socket tests are authoritative and
the teacher's render path (REMOTE_* + click indicator) is the same one already used for
control-holder students.

---

## Cycle 3 — PHASE 1 deepening: whiteboard object hydration coverage

The Cycle-1 finding (features ship with no tests) prompted a bug-hunt in the least-tested area:
whiteboard **shapes**, **instruments** (ruler/protractor/compass), and **grid mode** had zero
sync coverage. New **stress9** (9 checks): shape add/update/remove hydration with all fields
preserved, instrument add/remove geometry hydration, grid-mode hydration, and a privilege-escalation
guard (a student cannot add a shape). **Result: 9/9, no bug found** — the area is robust
(whole-object storage + full `session_state` hydration + `requireTeacher` gating). Outcome: a
critical untested surface is now confirmed correct and regression-protected. Full suite **168 green**
(verify-sync 48, stress 19, stress2 18, stress3 11, stress4 26, stress5 13, stress6 16, stress7 2,
stress8 6, stress9 9). No product change — coverage only.

---

## Cycle 4 — session re-watch PLAYER (ranked gap #2, user-approved Large feature)

**Pick:** Cycle-1 ranked gap **#2** — *session re-watch player*. The recorder + `playback()`
infra already existed (record/autosave/download), but there was no **renderer** to replay a
downloaded recording. Sources: thirdspacelearning / learner.com ("students re-watch lessons").
This was the flagged **Large** item → built only after explicit go-ahead.

**What shipped (offline, zero new deps, no data-model change):**
- **`Room.tsx` recorder enhancement** — the recorder now captures `lesson` events (`{html, seed,
  fileId}`) on record-start **and** whenever the lesson/seed changes. This makes a recording
  *self-contained*: it carries the lesson HTML + the deterministic RNG seed, so it can be replayed
  later with **no server and no original lesson file**.
- **`ReplayView.tsx` (new)** — an isolated `/replay` player. Parses an uploaded recording JSON,
  reconstructs each lesson in the **same sandboxed iframe** the live app uses (`seededSyncScript`
  with the recorded seed → deterministic sim state), and replays `interaction` events as
  `REMOTE_*` postMessages up to the playhead. Play/pause, **seek (forward + backward)**, speed
  control (0.5–4×), and a chat sidebar synced to the playhead.
- **`App.tsx`** — lazy `/replay` route (code-split; adds nothing to the live bundle).

**Design choice — backward seek by reconstruction, not undo:** seeking backward rebuilds the
lesson iframe from the latest `lesson` ≤ playhead and re-applies interactions from scratch
(`loadedLessonTsRef`/`lastAppliedIdxRef` reset). No fragile event-inversion; deterministic because
the seed is recorded. This reuses the existing sync primitives wholesale — no new surface to drift.

**Verification (run, not assumed):**
- **Browser e2e** (`/replay`, injected a hand-crafted recording = counter sim + 2 clicks + 1 chat):
  - parse → lesson iframe + timeline render ✓
  - **seek to t=2.0s → state deterministically reconstructed: counter = 2 (both clicks replayed),
    chat message appears at the correct playhead, time reads `0:02 / 0:03`** ✓
  - **play → playhead auto-advances** 0:00 → 0:01 at 1× ✓
- **Gates:** tsc **0**, vite build **✓**. Full socket suite **168 green** (unchanged — the player is
  an offline route + a record-only enhancement, so it touches **no** live-sync path; verified no
  regression).

**No bloat:** reuses recorder + `seededSyncScript` + iframe sandbox already in the tree; the only
net-new is one lazy route component. Closes the last competitor-parity gap from Cycle 1 that didn't
require a new dep or a data-model change (remaining open items — function graphing #4, cross-session
progress #6 — both need a new dep / DB and stay paused per Constraints).

---

## Cycle 5 — live-class DESYNC fix (reported bug, first-principles)

**Bug (live class):** teacher uploaded a stateful, click-navigated quiz lesson (screens toggled via
JS + `localStorage`); mid-class the **teacher saw the home/map screen while the student was on a
question** ("it got out of sync in between").

**Root causes (3 subagents traced teacher / student / server; all confirmed in code):**
1. An interactive student's navigation was relayed **teacher-only and NEVER journaled**
   (`server.ts` interactive branch). So the live mirror worked, but the instant the teacher's lesson
   iframe rebuilt — **switching to the whiteboard / another file and back, or a reconnect** — it
   reloaded the pristine home screen with **nothing in the journal to replay the student's nav** →
   stuck on the map. (Reproduced in-browser.)
2. `REMOTE_CLICK` replay **silently dropped** when the target wasn't rendered yet (`syncScript`),
   with no self-heal — one missed navigation = permanent drift.
3. The lesson's **`localStorage`** (blob inherits parent origin) persisted across rebuilds and
   diverged teacher↔student, making replay non-deterministic.
4. On Render free-tier cold-start the journal/seed were lost and interactions weren't durably saved.

**Fix (layered, each independently tested):**
- **server.ts** — journal the interactive student's driver events (1-to-1 = de-facto driver), still
  relayed teacher-only live; throttled durable journal save (cold-start); new `request_replay` event
  so a remounted iframe pulls + replays the journal on demand.
- **syncScript.ts** — shim `localStorage`/`sessionStorage` to an in-memory store per load (clean,
  deterministic boot for every screen — same idea as the `Math.random` seed shim); `REMOTE_CLICK`
  waits/retries for its target (~600ms) instead of dropping.
- **Room.tsx** — when the lesson iframe remounts after the teacher was on the whiteboard/temp
  content, reset the seq filter and `request_replay` so the teacher catches up to the room's real
  screen (only that transition trips it — normal flow untouched).

**Verification (run, not assumed):**
- **Faithful 2-iframe browser repro with the REAL `seededSyncScript`:** drove an interactive student
  into a quiz, remounted the teacher iframe → **bug reproduced** (teacher `home`, student `world`);
  then catch-up replay → **fixed** (both `world`). Journal carried the 3 nav events; storage shim
  isolated (`leakedToParent:null`); `REMOTE_CLICK` retry fired on a late-added element.
- **New stress10** (6 checks): interactive nav journaled + replayed to a late joiner, `request_replay`
  returns the journal, live bidirectional preserved, no live leak to other students, order preserved,
  view-only not journaled. Updated verify-sync Test R's stale "not journaled" comment.
- Full socket suite **174 green** (verify-sync 48, stress 19, stress2 18, stress3 11, stress4 26,
  stress5 13, stress6 16, stress7 2, stress8 6, stress9 9, stress10 6). tsc 0, build clean.

**Residual (user action):** cold-start durability needs **Upstash Redis** (the file store is
ephemeral on Render). Turnkey env vars already in `render.yaml`; without it, a server spin-down
mid-class still resets the room. Flagged, not silently assumed fixed.

---

## Cycle 6 — 3D-sim delivery audit ("the simulation does not load for the student")

**Reported:** platform fine generally, but a 3D simulation the teacher loads never appears for the
student. Audited the entire content-delivery pipeline (upload/paste/run/reopen → server caps →
student receive → iframe render).

**Bugs found (all confirmed in code):**
1. **Split-brain optimistic uploads** — every send path applied the lesson to the TEACHER's preview
   *before* server validation (`emit → setSimPreviewHtml → "✅"`). The **paste path had NO size
   check**; the server rejects >2MB (`upload_error` toast racing the ✅) and **>5MB payloads kill
   the socket silently** (Socket.IO `maxHttpBufferSize`) with auto-reconnect — teacher teaches a sim
   only they can see. 3D sims are the classic oversized case (embedded models/textures).
2. **`run_preview` silently dropped oversized HTML** (bare `return`, no error) while the client
   toasted "▶ Preview updated **& synced**" — a lie.
3. **`show_temp_content` had zero validation** (unbounded memory, same split-brain).
4. **No observability**: a lesson failing ON the student's machine (CDN blocked by their network,
   WebGL unavailable, JS crash) produced no signal anywhere — the student just "wasn't following".
5. Stored DOM snapshots (`liveSnapshotHtml`) were uncapped (up to 5MB/room memory + persistence).

**Fixes:**
- Client pre-flight `lessonTooLarge()` on paste / Run / reopen (file/drop already checked bytes),
  with a CDN-assets tip in the message; oversized content is never applied locally nor emitted.
- `upload_error` now **reverts** the teacher's preview to `lastRoomAcceptedHtmlRef` (the last HTML
  the server echoed back) — the teacher can no longer keep teaching unsynced content.
- Server: `run_preview` + `show_temp_content` answer `upload_error` instead of silent drops;
  snapshot storage capped at MAX_FILE_SIZE.
- **Sim-error reporting channel**: the injected sync script captures script/link load failures,
  JS errors and unhandled rejections (max 3/load, deduped) → `SYNC_SIM_ERROR` → StudentView relays
  as `sim_error` (bypasses the interaction gate — view-only students report too; never enters the
  REMOTE_* replay path) → server routes to the TEACHER ONLY (rate-limited, sanitized, student role
  only) → toast: "⚠️ Ann's lesson hit an error: Failed to load script …". Teacher's own iframe
  errors toast locally.

**Verification (run, not assumed):**
- **New stress11 (11 checks):** 3D-shaped lesson (CDN script + importmap + module + canvas) reaches
  the student **byte-identical**; oversized upload/run_preview/temp-content all answer
  `upload_error` with nothing leaked to students and room state unchanged; `sim_error` routes
  named to the teacher only (view-only student included; teacher-role senders ignored); `hasCanvas`
  snapshot → late joiner boots the pristine 3D lesson.
- **Browser (real Three.js from unpkg, REAL seededSyncScript, student view-only mode):** renderer
  boots, **628 rAF frames**, and `gl.readPixels` right after a render shows **5,185/10,000 lit
  pixels** — the cube is actually drawn. The broken-sim iframe reported both "Failed to load
  script" and the JS ReferenceError through the new channel.
- Full socket suite **185 green** (verify-sync 48, stress 19, stress2 18, stress3 11, stress4 26,
  stress5 13, stress6 16, stress7 2, stress8 6, stress9 9, stress10 6, stress11 11). tsc 0, build ✓.

**Honest scope note:** if a student's *network* blocks the CDN or their device lacks WebGL, the sim
still can't run there — but the teacher now sees exactly that reason in real time instead of
silence, and oversized lessons fail loudly with a revert instead of splitting the class.

---

## Cycle 7 — HD whiteboard export (user-requested: session snapshot for LLM context)

**Request:** one button that converts everything written on the whiteboard during the session into
a high-definition image, suitable as context for large language models.

**Audit of the existing "Export" button:** it was a naive `canvas.toDataURL()` — captured ONLY the
visible viewport at screen resolution, with a TRANSPARENT background, and MISSED KaTeX math labels
entirely (they're DOM overlays, not canvas pixels). Inadequate for the stated purpose.

**Shipped: `exportBoardHD` (replaces the old export in place — no new UI surface).**
- Computes the WORLD-SPACE bounding box of all content (strokes ± width, shapes incl. circle radii
  + rough.js margin, texts measured line-by-line, images incl. rotation) + padding — the export
  covers the whole session's writing regardless of pan/zoom.
- Renders to an offscreen canvas at ~3.4k long edge (scale 1–4×, hard-capped 8k for canvas limits)
  using the SAME draw routines as the live board (chronological z-order, rough.js shapes,
  quadratic-smoothed ink, pixel-eraser compositing). Grid/axes render per the room's grid mode
  (axes labels give an LLM coordinates). White page composited UNDER content (`destination-over`)
  so eraser holes export white, never transparent.
- **LaTeX labels export as their raw LaTeX source in monospace** — the KaTeX render is a DOM
  overlay the canvas cannot rasterise, and raw LaTeX is the most faithful text form an LLM can
  read anyway. Deliberate, documented trade-off.
- Skips teaching chrome (selection handles, instruments, in-flight gestures) — content only.
- Button: "📸 HD Export" in the whiteboard action bar; file `mathslive-board-<room>-<stamp>.png`.

**Verification (run, not assumed):** seeded a real room over sockets (red pen stroke near origin,
blue rect at ~(2600–3000, 1800–2100) — far OFF-VIEWPORT — plain text + a latex label), opened it
as the teacher in the browser, clicked the real button with the download intercepted: PNG came out
**3400×2349**, red stroke pixels 3,896, **blue far-shape pixels 8,714 (full-bounds proven — the
old export would have cropped it out)**, 164k ink pixels, **0 transparent pixels** (white page).
tsc 0, build ✓, verify-sync 48 + stress9 9 sanity green (no server/sync changes in this cycle —
client-only; full 185-check suite unaffected by construction).

---

## Cycle 8 — adversarial SYNC stress loop (user-requested; loop-until-dry)

**Request:** run a loop of sync-specific stress scenarios until the product is extremely good.
Method: contract-first — enumerate scenarios NOT covered by the existing 185 checks, write tests
for the DESIRED behaviour, let failures expose real bugs, fix, re-run everything until two
consecutive fully-green rounds.

**Bugs found by the loop (both fixed):**
1. **Server-restart seq poisoning (found by first-principles enumeration, pinned by stress12 R1 +
   stress13 S1).** Clients keep a "highest serverSeq applied" filter that deliberately survives
   socket blips — but after a redeploy/cold-start the server's counter restarts near 0, and if the
   re-served lesson HTML is IDENTICAL the iframe never rebuilds, the filter is never zeroed, and
   **every fresh event is silently dropped as stale** (sync appears dead after a mid-class
   restart). Compounding: the hydration `revision` guard also rejected the fresh state (small
   revision < big tracker). **Fix:** `session_state`/`sync_full_state` now carry the room's true
   `interactionSeq`; both clients adopt it (and reset the revision guard) whenever the server's
   counter is BEHIND their filter — the unambiguous restart signature.
2. **Unbounded interaction events (found by stress13 S5 — failed pre-fix, exactly as designed).**
   A 200KB `SYNC_INPUT` was relayed to every student AND journaled; with the journal at 2000
   entries, persisted, and re-sent to every late joiner, one buggy/abusive client could grow room
   memory + replay payloads by hundreds of MB. **Fix:** 32KB per-event cap (~1000× a normal click)
   at the top of the `interaction` handler — oversized events are dropped entirely.

**New coverage (43 checks across 2 suites):**
- **stress12 (23):** session_state carries `interactionSeq`; 120-event burst arrives complete,
  strictly seq-ordered, no dupes; journal-overflow latch (2050 paced events → late joiner gets NO
  partial replay but still boots); zombie-overlap reconnect keeps the control grant driving;
  clean holder exit auto-clears the grant AND unmutes the teacher (room can't freeze); revoke with
  interaction ON falls back to teacher-only + journaled; zero cross-room leakage under concurrent
  bursts; 21-toggle storm converges; request_replay hardening (non-member/malformed/spam);
  250-stroke burst hydrates fully in order; sim_error truncation + malformed flood.
- **stress13 (20, self-managed server on :3101 — includes a REAL hard-kill):** crash + respawn
  restores lesson/seed/journal/toggle/interactionSeq from the file store and live sync resumes;
  rapid upload×3 churn converges everyone on the final seed; student dropped mid-40-event-burst
  replays the complete story on rejoin; math symbols/emoji survive journal + hydration
  byte-identical; oversized-event cap; grant flip-flop A→B→A routes correctly at every step
  (stale holder can never drive).

**Convergence:** full 14-suite matrix (**228 checks**) run twice back-to-back on a live server —
**228/228 green both rounds** (second round against the same server instance: no cross-run
contamination). tsc 0, build ✓.

---

## Cycle 9 — 3D camera sync: wheel zoom + OrbitControls drag (reported bug)

**Reported:** teacher's 3D sim (three r128 + OrbitControls + post-processing) loads and syncs its
buttons, but **zooming and 360° orbiting don't reach the student**.

**Root causes (both engine gaps, not the sim's fault):**
1. **Wheel was never captured.** The sync script listened to wheel ONLY to block it in view-only
   mode — there was no SYNC_WHEEL event, so no sim's zoom could ever sync.
2. **Drag replay used the wrong event type.** OrbitControls (r128+) listens for POINTER events;
   the engine replayed drags as synthetic MouseEvents, which pointer-based libraries never hear.
   (Simple mouse-handler sims worked, which masked the gap.)

**Fix (syncScript.ts + plumbing):**
- **SYNC_WHEEL capture** — coalesces bursts but **preserves the tick count** (OrbitControls zooms a
  fixed factor per EVENT, sign-only; N teacher ticks must replay as N events or zoom levels drift).
  Direction changes flush immediately. View-only students don't emit; remote replays don't echo.
- **REMOTE_WHEEL replay** — re-dispatches count WheelEvents on the path-resolved element
  (elementFromPoint fallback).
- **Dual Pointer+Mouse dispatch** for REMOTE_MOUSEDOWN/MOUSEMOVE/MOUSEUP (pointer first, native
  ordering) so both modern pointer-based and legacy mouse-based sims follow drags.
- **setPointerCapture shim** — newer OrbitControls (r137+) call setPointerCapture(pointerId) on our
  synthetic pointer id and would throw NotFoundError inside their own handler; degraded to
  best-effort.
- Plumbing: SYNC_WHEEL rate-limited as loss-tolerant; excluded from both clients' snapshot-request
  triggers; journal saves now gated to replayable types (wheel streams no longer schedule disk
  writes). Not journaled (high-frequency, like scroll/mousemove — camera state for late joiners
  remains out of scope, same as drags).

**Verification (run, not assumed):** 2-iframe harness with the USER'S EXACT sim (byte-identical
except let→var on one line so the harness can read the camera) + the real seededSyncScript:
- **Zoom full loop:** 6 synthetic wheel ticks on the teacher canvas → 6/6 captured through the
  coalescer → replayed → **student camera distance 33.54 → 24.66, exactly matching the teacher's**.
- **Orbit replay:** REMOTE_MOUSEDOWN/8×MOVE/UP → student's r128 OrbitControls rotated the camera
  (azimuth 0 → −0.053 rad) — was completely dead pre-fix.
- **Click regression:** REMOTE_CLICK still advances the sim's step button.
- New **stress8 BD7/BD8** (suite 6→10 checks): teacher wheel broadcasts with count+delta intact;
  interactive student wheel relays teacher-only, no leak to other students.
- Full 14-suite matrix: **232 green** (one stress13 crash-respawn timing flake in the matrix run;
  clean on three direct runs). tsc 0, build ✓.

**Honest scope note:** touch pinch-zoom (two-finger dolly on tablets) is not yet captured — only
wheel + drag. Multi-touch replay is a separate, larger piece if it's ever needed.

---

## Cycle 10 — the REAL desync root cause: run_preview wiped the journal (browser-found)

**Reported (3rd time on this lesson pattern):** a screen-flipping quiz lesson still desynced — the
teacher ended up on the home/map screen while the student was mid-quiz — despite all prior fixes.

**Method that finally caught it: browser reproduction of the FULL flow** (reasoning alone had
missed it three times). In a real teacher Room + a socket student driving the actual Ratio-Rush
lesson: Phase 1 (student answers Q1–Q3) mirrored fine; teacher → whiteboard; student → Q5; teacher
returns → **STUCK ON HOME, 0 stars**. The console logs were the smoking gun:
`teacher re-seeded HTML from cache in response to request_html_sync`.

**Root cause:** `run_preview` is emitted not only for NEW content but also to **re-seed the server
from the teacher's cache** — on reconnect, and (critically) when a student joins while the teacher
is on the whiteboard (`request_html_sync`). Those carry the SAME html, but `run_preview`
**unconditionally called `newContentBaseline`**, which **wiped the interaction journal and reseeded
the shared RNG mid-lesson**. So when the teacher's iframe remounted and asked for the journal to
catch up, there was almost nothing left to replay — stranding them on the lesson's home screen.
This silently sabotaged EVERY catch-up / late-join whenever a join or reconnect happened mid-lesson.

**Fix (server):** `run_preview` now resets the baseline **only when the html actually changed**; an
identical re-seed preserves the journal + seed. (verify-sync Test N still passes — it re-runs
*different* html.)

**Client hardening (same cycle, all browser-verified):**
- **Catch-up drops the stale queued events** instead of flushing them: events captured while the
  lesson iframe was unmounted target a screen the fresh iframe isn't on and, with REMOTE_CLICK's
  retry, would DOUBLE-APPLY against the authoritative replay and over-advance the quiz.
- **Live events are held during the replay window** (3s watchdog so it can never wedge), so a click
  landing mid-catch-up can't double-apply.
- **Self-heal backstop:** a replayed click that can't resolve after ~600ms of retries means the two
  sides have drifted to different screens → the iframe posts `SYNC_REPLAY_MISS` → the teacher force-
  remounts + full-journal catch-up (rate-limited to once / 4s). This corrects ANY residual drift,
  whatever the cause. The student side intercepts the signal so it never leaks to the room stream.

**Verification (run, not assumed):** browser end-to-end on the user's EXACT Ratio-Rush lesson —
after the whiteboard round-trip the teacher lands **exactly on "Question 5 of 7", 4 stars, "What is
the ratio of apples to bananas?"** (was stuck on home pre-fix). New **stress14 (6 checks)** pins the
run_preview idempotency contract (same html preserves journal + seed; new html resets both; nav
survives a mid-lesson re-seed). Full **15-suite matrix: 238 green** (verify-sync 48, stress 19,
stress2 18, stress3 11, stress4 26, stress5 13, stress6 16, stress7 2, stress8 10, stress9 9,
stress10 6, stress11 11, stress12 23, stress13 20, stress14 6). tsc 0, build clean.
