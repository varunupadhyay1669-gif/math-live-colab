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

**Pick:** #1 — **Math equation input via KaTeX.** Highest impact-to-effort for a *math* tutor,
reuses an existing dependency, no data-model change, free-tier safe, contained to the whiteboard.

**Status:** It touches the core (live-class) whiteboard, so per the "pause for Medium/risky in a
live app" rule — **awaiting go-ahead before building.** (Sources cited above.)
