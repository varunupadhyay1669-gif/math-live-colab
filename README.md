# MathsLive 🧮

A live teaching platform for **interactive HTML simulations**. The teacher
imports a pre-made HTML sim (or generates one with AI), presents it live, and
every student's screen runs the same simulation in deterministic sync — clicks,
inputs, drags, annotations, whiteboard, the lot.

**Live deployment:** https://mathslive.matheinstein.com (AWS Lightsail, Mumbai). The Render and Railway addresses in older docs are dead.

## What makes it different

- **Live Mirror sync** — the lesson runs ONCE, in the teacher's iframe. Every
  student's iframe is a script-stripped shell that paints the teacher's real
  DOM and canvas pixels, so a student structurally cannot be on a different
  screen. A student given control has their taps forwarded to the teacher's
  copy and mirrored back. (The older "replay-first" engine described in
  SYNC.md was retired in August 2026; see AGENTS.md §3.5.)
- **Control handoff** — hand "the chalk" to any student (✋ in the
  participants list): their screen drives the whole class until you take it
  back. The global view-only/interactive toggle is independent.
- **Student Peek** — open a live, read-only window into any student's *real*
  screen (👁️), give them control from there, or resync just them.
- **Lesson Time Machine** — bookmark moments (HTML + whiteboard + annotations
  + step) and rewind the entire class to any of them.
- **Element pings** — anyone (even view-only students) can Alt+click to drop
  a synced "look here" ripple on the exact element.
- **Checkpoints & XP** — gate steps behind a quiz; server-graded, anti-farm,
  with a live leaderboard.
- **Whiteboard** — infinite shared canvas: pen/highlighter/eraser, shapes,
  KaTeX labels, images (upload/paste/drag-drop), ruler & protractor,
  per-author undo, grid/graph paper.
- **Annotations over the sim**, laser pointer, reactions, raise-hand, chat,
  challenge timer, attention checks, session recording.

## Run locally

Prerequisites: Node.js ≥ 20.

```bash
npm install
npm run dev        # Vite + Socket.IO on http://localhost:4000 (PORT to override)
```

There is **no separate frontend server** — `server.ts` boots Vite in
middleware mode and Socket.IO in one process.

Open `/` → *Start teaching* → upload an HTML sim. Join from a second
tab/device via the room code (`/live/<code>`).

### Optional features (all env-gated, see `.env.example`)

| Env | Enables |
|---|---|
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | Teacher accounts (magic-link login + dashboard with permanent per-student rooms) |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY` | Server-side teacher-ownership enforcement for registered classes |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Durable rooms across restarts/redeploys |
| `GEMINI_API_KEY` | ✨ AI Lesson — generate an interactive widget from a prompt (server-side only) |

## Scripts

```bash
npm run dev          # dev server (tsx server.ts — restart after server.ts edits)
npm run build        # production bundle → dist/
npm start            # production server (POSIX; on Windows set NODE_ENV manually)
npm run lint         # tsc --noEmit
npm run verify:sync  # Socket.IO integration suite (needs a running server)
```

## Documentation

- [`AGENTS.md`](AGENTS.md) — ground rules for anyone (human or AI) changing this codebase. **Read first.**
- [`SYNC.md`](SYNC.md) — the sync architecture contract (canonical revisioned state, event replay, snapshots, control handoff, event journal).
- [`DEPLOY.md`](DEPLOY.md) — deployment (Render blueprint included; Railway/Fly/VPS notes).
- [`SUPABASE.md`](SUPABASE.md) — teacher accounts setup.

## Writing sims that sync well

Any self-contained HTML file works. For best results:

- Keep visible state in the DOM (text content, input values, classes).
- Stable element `id`s help replay target the right elements.
- Mark progressive content with `data-step="1"`, `data-step="2"`, … to use
  Step Lock.
- `Math.random()` is automatically seeded per-document for deterministic
  replay across screens.
- No external network calls — sims run sandboxed and offline.
