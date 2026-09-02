# AGENTS.md — Read this first

This is the **single source of truth for any AI coding agent** (Codex, Claude,
Cursor, Windsurf, Copilot, etc.) working on this project. Read all of it before
making changes. If something here conflicts with intuition, this file wins.

---

## 1. Project identity

- **Product name:** MathsLive (one word; "Math Live" is the old name and survives only in stale docs)
- **What it is:** A live teaching platform for running **custom HTML
  simulations** built elsewhere (notably *Math Vis Vault*). Teachers import
  pre-made HTML, present it live, annotate, and stay in deterministic sync
  with students.
- **What it is NOT:**
  - It is not a math content-authoring tool.
  - It is not a generic classroom dashboard.
  - It is not a screen-sharing replacement.
  - Do not redesign it as any of those.

---

## 2. Project root and folder layout

> Important: there is exactly **one** real project root.

**The project root is the folder containing this file.** Everything outside it
(parent folders, `anigraviti html collab`, the workspace path on disk) is just
the user's machine layout and is **not part of the codebase**. Do not create
"copy" projects, do not nest a second project inside `src/`, do not create new
top-level folders unless adding a real new concern.

```
<project root>/
├── AGENTS.md              ← this file
├── SYNC.md                ← sync architecture contract (read before touching sync)
├── README.md
├── package.json
├── server.ts              ← Node + Socket.IO + Vite SSR dev server
├── vite.config.ts
├── index.html
├── tsconfig.json
├── .rooms/                ← persisted room snapshots (runtime only)
└── src/
    ├── main.tsx
    ├── index.css          ← all design tokens + components live here
    ├── pages/
    │   ├── Home.tsx       ← landing (uses Design System v3)
    │   ├── Room.tsx       ← teacher view
    │   └── StudentView.tsx
    ├── components/        ← shared UI (TeacherControls, ChatPanel, Whiteboard, ...)
    ├── lib/               ← syncScript.ts (injected into iframes), sounds, etc.
    └── ...
```

**Rule:** if you cannot place a change inside an existing file or folder
listed above, stop and ask before adding a new top-level folder.

---

## 3. How to run

```bash
npm install
npm run dev      # starts Vite + Socket.IO server on PORT (default 4000)
```

There is **no separate front-end server**. `server.ts` boots Vite in middleware
mode and Socket.IO in the same process.

---

## 3.5 How sync ACTUALLY works, as of September 2026

Read this before SYNC.md, most of which still describes an engine that no
longer runs. If the two disagree, this section is right.

**The Live Mirror.** The teacher's lesson iframe is the ONE instance of the
lesson that executes. It injects `mirrorScriptFor('source')`
(`src/lib/mirrorScript.ts`) which streams its real DOM — serialised body HTML,
the head's runtime CSS, and up to four canvases as WebP frames — over
`mirror_dom` / `mirror_canvas`. Every learner's iframe is a
`stripLessonScripts(html)` shell plus `mirrorScriptFor('follower')`, and it
runs no lesson code at all. It paints what arrives by MORPHING the DOM in place
(id-keyed), never `innerHTML =`, because re-creating an element restarts its
CSS animation, blanks a canvas and drops focus and caret.

A learner who has been given control has their pointer events forwarded to the
teacher's copy as fractions of the target element's box, applied there, and
mirrored back. So there is never a second running instance to diverge.

**The retired engine.** `src/lib/syncScript.ts` is the old input-replay
engine: seeded RNG, an interaction journal, `REMOTE_*` replays. It is NOT
injected into any live lesson any more — only `src/pages/ReplayView.tsx` uses
it, to play back a downloaded recording. `verify-mirror.mjs` fails the build
if `seededSyncScript(` reappears in Room.tsx or StudentView.tsx. Do not
reintroduce it, and do not "fix" a sync problem by adding a path that rebuilds
the teacher's iframe.

**Two sandboxes, and the reason (`src/lib/iframeAttrs.ts`).** The lesson is a
`blob:` URL made by the parent, so `allow-same-origin` would put lesson code
at the app's own origin. The teacher's frame keeps it — it runs the lesson, and
the class-pack recorder reads that document. Every frame that only DISPLAYS —
both learner frames and the teacher's Dual View mirror pane — uses
`LESSON_IFRAME_SANDBOX_VIEW_ONLY`, which omits it, so those documents have an
opaque origin. Never hand a learner frame the app's origin.

**Every mirrored frame is sanitised before it is painted** (`sanitizeInto` in
mirrorScript.ts): scripts, iframes, objects, embeds, `base`, `meta
http-equiv`, every `on*` attribute and `javascript:` URL. Forms, inputs and
their values are deliberately KEPT — a worksheet the learner types into and is
marked instantly is a first-class lesson type here.

---

## 4. Architectural pillars (do not violate)

### 4.1 Teacher-authoritative live sync
- The **server** holds canonical room state.
- Each room has a monotonically increasing `revision`.
- Every sync-critical broadcast carries `revision`.
- Clients **must** ignore stale revisions.
- Only the teacher can mutate canonical state. Server enforces this with
  `requireTeacher(room, socket.id)`.

### 4.2 Single canonical session payload
- The canonical message is `sync_full_state` (broadcast) and `session_state`
  (unicast on join/request).
- Both are built by `buildSessionState()` in `server.ts`.
- Both clients hydrate via `applySessionState(state)` in `Room.tsx` and
  `StudentView.tsx`.
- New synced state must be added in **all four places**:
  1. `RoomData` in `server.ts`
  2. `SessionStatePayload` in `server.ts`
  3. `buildSessionState()` in `server.ts`
  4. `applySessionState()` in both `Room.tsx` and `StudentView.tsx`

### 4.3 Source HTML vs live snapshot
- `sourceHtml` = the uploaded/pasted HTML file content.
- `liveSnapshotHtml` = the teacher iframe's current DOM snapshot.
- `effectiveHtml` = what clients should render (live first, then source).
- Never collapse these into a single field.

### 4.4 Request/ack snapshots, not timeouts
- Snapshot requests carry `requestId`.
- Force sync = server asks teacher for a fresh snapshot, then broadcasts
  canonical state when the snapshot ack arrives. Do not add timing hacks.

### 4.5 No fallback-on-fallback
- If you find yourself adding a fourth fallback path for the same problem,
  fix the root cause instead. The sync system is teacher → server → students.
  Anything else is a bug.

For the full sync contract see `SYNC.md`.

---

## 5. Design System v3

All visual work uses the v3 primitives in `src/index.css` (search for
`MATH LIVE — Design System v3`). Do **not** invent ad-hoc inline styles for
new UI. Do **not** introduce a competing design system.

### Use these classes
- **Surfaces:** `.ml-surface`, `.ml-surface-elevated`, `.ml-surface-muted`,
  `.ml-divider`
- **Typography:** `.ml-display`, `.ml-headline`, `.ml-title`, `.ml-body`,
  `.ml-caption`, `.ml-eyebrow`
- **Buttons:** `.ml-btn` + variant
  (`.ml-btn-primary`, `.ml-btn-secondary`, `.ml-btn-ghost`, `.ml-btn-danger`,
  `.ml-btn-success`, `.ml-btn-violet`) + size (`.ml-btn-sm`, `.ml-btn-lg`,
  `.ml-btn-block`)
- **Icon buttons:** `.ml-icon-btn` (+ `.ml-icon-btn-sm`)
- **Toolbar:** `.ml-toolbar`, `.ml-toolbar-group`, `.ml-toolbar-divider`
- **Inputs:** `.ml-input`, `.ml-input-mono`, `.ml-field-label`
- **Badges:** `.ml-badge` (+ `-indigo`/`-emerald`/`-rose`/`-amber`),
  `.ml-badge-dot`
- **Brand:** `.ml-brandmark`, `.ml-page-bg`

### Reference implementation
`src/pages/Home.tsx` is the canonical example. When redesigning a screen,
study it first.

### Hard rules
- No new `style={{ ... }}` for colors, shadows, radii, or spacing — use the
  tokens.
- No new font sizes — use a typography class.
- No emoji-driven UI for primary controls. Use `lucide-react` or inline SVG.
- Buttons must use `.ml-btn` + variants. Do not nest `<button>`-styled `<div>`s.
- Modal/overlay z-index must respect the iframe layering (the simulation
  is the visual hero — chrome recedes).
- The simulation viewport always remains the visual focus. Decorative styling
  must not overpower it.

### Legacy classes
The older `.btn`, `.btn-primary`, `.tb-btn`, `.toolbar-group`, etc. still work
for backwards compatibility, but **all new code should use `.ml-*`**. When
touching a screen significantly, migrate it.

---

## 6. Whiteboard

- Whiteboard works in **board space** (not browser zoom).
- Images are first-class objects: `{id, src, x, y, width, height, scale,
  rotation, zIndex}` — they are persisted on the server and restored to
  late-joining students via canonical state.
- Pan/zoom is **app-level**. Never tell users to use Ctrl+Scroll browser zoom.
- Strokes and image objects are server-persisted and broadcast through
  teacher-authoritative events: `whiteboard_add_image`,
  `whiteboard_update_object`, `whiteboard_remove_object`,
  `whiteboard_set_view`, `whiteboard_draw`, `whiteboard_clear`,
  `whiteboard_reset`, `whiteboard_delete_stroke[s]`.

---

## 7. Things that have been a recurring source of confusion

These are the patterns that previous agents have re-introduced. Don't.

1. **Multiple sources of truth for the rendered HTML.**
   - The server has exactly: `files[].html` (source) and `liveSnapshotHtml`
     (DOM). Clients hydrate from `effectiveHtml`.
2. **Browser zoom for whiteboard image scaling.**
   - The whiteboard is its own coordinate space. Images are objects.
3. **Fixed-timeout "force sync".**
   - Force sync uses a `force-` requestId and waits for a `dom_snapshot` ack.
4. **Direct `iframe.contentWindow.postMessage` during rebuild windows.**
   - Use the queued transport (`pendingMessagesRef` + `iframeReadyRef` flush
     on `onLoad`) on both teacher and student.
5. **Re-creating "the same project" inside `src/` or in a sibling folder.**
   - The root containing this file is the only project. If you see a nested
     duplicate, treat it as garbage and stop.
6. **Adding new sync events without updating `SessionStatePayload` /
   `applySessionState`.**
   - Late-join recovery silently breaks. Always close the loop in all four
     places listed in §4.2.
7. **Inline `style` props for spacing, color, shadows.**
   - Use `.ml-*` classes and tokens. No exceptions for "just this once".

---

## 8. Output and commit conventions

- **TypeScript must compile clean** (`node node_modules/typescript/bin/tsc
  --noEmit`) before committing.
- Prefer minimal, focused commits with clear messages, e.g.
  `Refactor sync around canonical revisioned session state`.
- When touching the sync system, also update `SYNC.md`.
- When touching the design system, update §5 of this file and `src/index.css`.

---

## 9. Quick decision tree

- **Is the change visual?** → Use Design System v3. Migrate inline styles you
  touch.
- **Is the change about teacher↔student state?** → It must flow through
  canonical session state. Read `SYNC.md`.
- **Is the change about the whiteboard?** → Coordinates are board-space.
  State is server-persisted. Authority is teacher.
- **Is it a "quick fix" with a `setTimeout`?** → Probably wrong. Find the
  root cause.
- **Are you about to create a new top-level folder?** → Stop and ask.

When in doubt, prefer the smallest change that addresses the root cause.

## 10. Where the plan lives

`PLAN.md` at the repo root is the current product and engineering blueprint
(Steps 1–9, phased tasks, what is deliberately NOT being built). `QUESTIONS.md`
holds every open question with the working assumption in force until it is
answered. Both are kept up to date as work lands, including when they turn out
to have been wrong — corrections are made in place and left visible.

Before starting anything substantial, check which Phase of `PLAN.md` Step 8 it
belongs to, and whether Step 6.4 has already argued against it.
