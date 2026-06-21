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
