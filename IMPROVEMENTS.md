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
