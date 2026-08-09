# Prompt: build MathsLive from scratch

Hand the whole of this to a capable coding agent. It is written as instructions
to that agent.

The most valuable part is not the feature list — it is **§3, the traps**. Every
item there is a bug that was actually hit and cost real lesson time. A rebuild
that ignores §3 will hit all of them again in the same order.

---

## 1. What you are building

A **one-to-one live maths tutoring platform**. One tutor, one student (rooms
must tolerate two or three), running a lesson together in the browser for an
hour at a time.

The tutor shares a **whiteboard** and/or an **interactive HTML lesson** (a
single self-contained HTML file with its own JavaScript — a simulation, a quiz,
a worksheet). Both people see the same thing, at the same time, and can write
over it. Afterwards the tutor exports the whole lesson as one file to hand to a
language model that writes the follow-up worksheet.

**Stack:** React 19 + Vite + TypeScript on the front, Express + Socket.IO +
TypeScript on the back, one process serving both. Supabase for auth and durable
data. No other required services.

**Who is actually using it:** the tutor is on a desktop browser. **The students
are on iPads and iPhones.** That single fact invalidates a lot of otherwise
reasonable design and is the source of several traps below.

---

## 2. Architecture decisions that are not negotiable

Each of these exists because the obvious alternative was built first and failed.

### 2.1 One authoritative lesson instance, never two

An HTML lesson is real JavaScript with its own internal state. If the tutor and
the student each run their own copy, they diverge within seconds — a random
number, a timer, one click landing in a different order — and no amount of
state-copying afterwards fixes it, because the divergence is inside closures
you cannot read.

So: **the tutor's iframe is the only instance that runs.** It streams its real
DOM to the students, who render a script-stripped follower. A student who is
allowed to interact does not click their own copy — their input is **forwarded
and replayed inside the tutor's iframe**, and the resulting DOM change comes
back down the same pipe.

Consequences to design for from the start:
- **Attribution.** The tutor's page sees both people's clicks. To know who did
  something, you must know a forwarded input just arrived — the DOM event
  cannot tell you.
- Late joiners need the current DOM snapshot **plus** a replayable journal of
  interactions since the last baseline, or they boot to a different frame.
- Morph the DOM on update; never swap `innerHTML` wholesale, or every CSS
  animation restarts and canvases blank.

### 2.2 Cap the Node heap explicitly

`node --max-old-space-size=<N>` in the start command, always, with N set below
the container's memory limit.

V8 sizes its heap from the **machine's** memory, not the container's cgroup. On
a 512MB instance it reported a **4288MB** ceiling — so it never collected
aggressively, grew past the limit, and was killed. The restarts burned the
host's monthly quota and the whole account was suspended. Application-level
cleanup cannot save you: the process dies before any of it runs.

Measured, on a 512MB box: `--max-old-space-size=256` yields a 448MB total heap
ceiling, leaving room for code, buffers and native allocations.

### 2.3 Rooms live in memory only while occupied

Hold rooms in a `Map` for the lesson, but **write them to a durable store and
drop them once everyone leaves.** A room is not small — lesson HTML, images,
whiteboard content, and a full copy of the tutor's iframe DOM. Keeping every
room ever taught resident is the memory leak.

Restore lazily on join. Then memory tracks *lessons happening now* rather than
everything ever taught.

Never evict an occupied room, at any memory pressure. Ending a lesson to save
memory is the outage arriving by another route.

### 2.4 The security boundary is the server, never the page

Anything the browser enforces is decoration: a person can edit the page, or
skip it entirely and talk to your server with a socket client. So:
- A site-wide access code is checked at the **socket handshake**, and on any
  HTTP route that does real work.
- Teacher-only actions are checked against the server's record of who holds the
  teacher seat, on every event.
- Cross-tenant admin reads go through a database function that checks the
  caller. Never ship a service-role key to the client or the server.

---

## 3. The traps (read this twice)

**Sync and rendering**

1. **`blob:` URLs race on slow devices.** Revoking one before a slow iPad has
   finished loading it yields a permanently blank iframe. Use `srcdoc`.
2. **Applying a shared pan/zoom mid-stroke tears the ink.** The stroke's points
   are captured under one transform and drawn under another; the visible result
   is a red zig-zag band on the student's screen only. Hold incoming view
   updates while a stroke is in progress and freeze the transform per stroke.
3. **Ink bleeds between surfaces.** Whiteboard, lesson, and each explanation are
   different surfaces. Tag every stroke with its surface or writing on one
   appears on another (measured: 11,467 stray pixels).
4. **A dropped DOM frame desyncs silently.** Send a hash with each snapshot and
   let students detect a missed frame and ask for a resend.

**Devices**

5. **iPadOS and iOS Safari have no `getDisplayMedia`.** A student there can
   never share their screen — no flag changes it. Check the capability *before*
   prompting, and tell the tutor plainly. Note the corollary: **receiving**
   video works fine, so tutor→student screen sharing is the direction that
   works on an iPad, and it is the escape hatch when a lesson will not render.
6. **Camera, microphone and screen capture all require HTTPS.** On plain HTTP
   they fail silently. A bare IP address is not enough.
7. **iOS refuses muted autoplay often enough to matter.** Offer a "tap to
   watch" surface rather than showing a black rectangle.

**Rooms and joining**

8. **A student arriving before the tutor is normal, not an error.** Returning
   "room not found" with a dead end teaches them to reload repeatedly. Mark the
   refusal retryable, show a waiting room, and let the page retry until the
   tutor opens the room.
9. **A server restart hands the reconnecting tutor an empty room.** Their
   browser still holds the whole board — push it back. Guard it hard: only on a
   reconnect, only when the server's copy is empty, only once, or you will
   duplicate every stroke on a board the server actually kept.
10. **Same-name rejoins produce two ghost members.** Disconnect the stale socket
    before adding the new one.
11. **Give the tutor a disconnect grace period** (~45s). A backgrounded tab
    misses heartbeats; announcing "teacher left" immediately breaks the lesson
    for a tutor who never went anywhere.

**Data and export**

12. **`data-correct="0"` on a question block is an INDEX, not a verdict.** Read
    as a boolean it marks wrong answers correct, and the worksheet then skips
    exactly what the student got wrong. A number is an index; only a
    non-numeric attribute is a verdict.
13. **Record "unknown" honestly.** If the page says nothing about correctness,
    store null, not false. A worksheet built on a false "she got this wrong" is
    worse than one built on a gap.
14. **A validator must report faults, not raise them.** `(x || []).entries()`
    throws when x is a string. Its only real caller is checking a file it did
    not write.
15. **Distinguish "not installed" from "not allowed".** PostgREST answers a
    missing function with `PGRST202` and puts the explanation in `details`, not
    `message`. Collapsing that into "you do not have access" tells the owner
    they lack permission to their own platform.

**Time and numbers**

16. **"Hours taught" is not last-save minus first-save** — that measures saving.
    Nor is it wall-clock in the room — that bills the setup and the lunch break.
    Count only while a tutor **and** a student are both present.
17. **Lessons before a metric existed are unknown, not zero.** Zeros drag every
    average down and read as a collapse in usage.
18. **Record each participant's timezone.** Tutor and student are routinely in
    different countries; without it every clock time in an export is unreadable.

**Infrastructure**

19. **A keep-warm self-ping costs ~730 of a 750-hour monthly free allowance.**
    Make it switchable. One always-on service consumes an entire free tier.
20. **`StartLimitBurst` / `StartLimitIntervalSec` belong in systemd's `[Unit]`,
    not `[Service]`.** In the wrong section systemd logs "Unknown key name …
    ignoring" and your crash-loop protection silently does nothing.
21. **Test WebSockets through your reverse proxy.** A proxy that mishandles the
    `Upgrade` header breaks the whole app while the health check stays green.

---

## 4. Features, in build order

Build in this order; each layer depends on the one above.

**Layer 1 — the room**
- Room by code. Roles: tutor (one, authoritative) and student.
- Join, presence list, reconnect, disconnect grace, waiting room (trap 8).
- Health endpoint reporting uptime, rooms in memory, build commit.

**Layer 2 — the shared surface**
- Live Mirror: tutor's iframe DOM + canvas frames streamed to students;
  script-stripped follower; DOM morphing; hash heartbeat; interaction journal
  for late joiners; deterministic seeded RNG so any local randomness agrees.
- Upload / paste / switch HTML lessons. Cap file size and count.
- Scroll and zoom sync; per-student "resync from canonical state".

**Layer 3 — the whiteboard**
- Infinite pan/zoom canvas. Pen, highlighter (fades), eraser (pixel and
  whole-stroke), text, images, PDF import.
- Shapes from a drag box, behind ONE palette entry rather than one rail button
  each: line, arrow, rectangle, parallelogram, trapezium, rhombus, triangle,
  right triangle, circle, ellipse, pentagon, hexagon, star. Derive the corners
  from a single pure function shared by the renderer AND the hit test, or a
  shape ends up visible and unselectable.
- Geometry instruments: ruler, protractor, compass.
- Grid modes: blank, grid, graph paper (with snapping).
- Select, multi-select, group move, undo/redo.
- Shared vs independent view (trap 2).

**Layer 4 — teaching controls**
- Per-student control handoff ("who holds the chalk").
- View-only vs interactive; students cannot write when view-only.
- Pause, laser pointer, annotation over the lesson, element ping.
- Challenge timer: presets from 10s to 15min plus a custom field; validate the
  duration on the server (it reaches every student's screen).
- Step-lock with gate questions; pop quizzes; XP, streaks, leaderboard.
- Time Machine: bookmark and rewind canonical state.

**Layer 5 — presence**
- WebRTC video call (perfect negotiation, two-sided teardown — one side hanging
  up must stop the other's camera).
- Screen sharing **both ways**, on its own signalling channel so it cannot
  collide with the call. Student→tutor for diagnosis; tutor→student as the
  escape hatch (trap 5).
- Shared YouTube overlay, tutor-authoritative, with drift correction.
- Speech-to-text narration from both sides, merged on the tutor's clock.

**Layer 6 — the record**
- Per-student dashboard: grade, level, goals, avatar, textbook, lesson history.
- Lessons stored per day. Saving updates the day rather than adding a row.
- Switch students and lesson days from inside the room; loading a past day
  replaces the live board (save first).
- Real teaching time (trap 16). Autosave every couple of minutes and on
  page-hide.

**Layer 7 — the class pack**
- Export one file containing everything: deduplicated board snapshots (a
  perceptual hash keeps the frames either side of a correction and drops the
  near-identical middle), HTML render screenshots with ink, materials, the
  merged transcript with confidence and silence spans, explainer outlines,
  every interactive attempt with what was chosen and whether it was right,
  homework in and out.
- A PDF for a person **and** a machine-readable JSON sidecar for a model, with
  a validator, stable ids across re-exports, and a capture report that states
  plainly what could NOT be captured.

**Layer 8 — the platform**
- Supabase auth; RLS scoping every row to its owning tutor.
- Owner-only admin surface with cross-tutor usage, gated in the database.
- Site-wide access code at the handshake.

---

## 5. How you must verify

The standard is not "the tests pass". Several tests here passed while testing
nothing at all:

- A rate-limit flood test used an event that was never rate-limited, so it
  passed against the *broken* code and proved nothing.
- An eviction test passed while never evicting anything, because a grace period
  it did not know about kept the room in memory the whole run.
- A PDF structure check used `lastIndexOf('xref')`, which matched inside
  `startxref`.

So:

1. **Make the test fail first.** If you cannot see it red, you have not tested
   the thing you named.
2. **Measure the mechanism, not the symptom.** "Still works" is not "left
   memory". Assert the count changed.
3. **Drive the real app**, not a component in isolation — through the actual
   page, the actual proxy, the actual socket. Bugs live in the wiring.
4. **Test the failure direction too.** For anything reversible (restoring a
   board, retrying a join) prove the bad case as well: measure the duplication
   that would happen if the guard were removed.
5. **Say what you could not verify.** Some things need real hardware or a real
   account. Name them rather than implying coverage.

Keep two suites: pure logic tests that run without a server, and socket-level
tests that drive a real running server and assert the wire protocol including
who is refused.

---

## 6. Deployment constraints

- One process serves the API, the sockets and the built front end.
- Cap the heap (§2.2). Make the idle-eviction window and the keep-warm ping
  configurable (trap 19). Shed idle rooms under memory pressure, never
  occupied ones.
- Rooms need a durable store (Redis or equivalent) to survive restarts; without
  one, a redeploy mid-lesson loses the board unless the tutor's client
  re-seeds it (trap 9).
- HTTPS is mandatory, not cosmetic (trap 6).
- Free tiers are being withdrawn across this market. Size the memory settings
  for the box you are actually on, and make them environment variables so the
  next box does not require a code change.

---

## 7. Tone of the thing

It is used live, with a child waiting. When something fails it should say what
happened in words the tutor can act on — "the server restarted, put your board
back (14 items)" — not fail silently and not show a stack trace. Prefer
recovering automatically and saying so.
