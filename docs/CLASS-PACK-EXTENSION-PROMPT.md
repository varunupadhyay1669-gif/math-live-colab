# Build prompt: "Class Pack Recorder" Chrome extension

Paste everything below the line into a coding agent. It is written to be handed
over whole — it states the goal, the output format it must match, the parts that
are genuinely hard, and the traps that have already been paid for once.

---

## What you are building

A Chrome extension called **Class Pack Recorder** that sits alongside an online
maths lesson taught on *someone else's* platform — Preply's classroom, a shared
Google Doc, Miro, Jamboard, Excalidraw, a PDF in a tab, a Zoom screen-share
viewed in the browser — and produces, at the end of the lesson, a single
**class pack**: a machine-readable record of what was actually taught.

The pack is not for a human to read. It is fed to a language model that then
writes the follow-up worksheet, the revision note, and the parent summary. So
the pack must answer, without a person in the loop:

- What was on screen, and when
- What was said, and when, and by whom
- What the student got right, got wrong, and struggled with
- What changed on the board, rather than sixty near-identical pictures of it

The tutor already has this for lessons taught on their own platform
(MathsLive). This extension extends it to lessons taught anywhere else, and
**must produce the same format** so both go through one downstream pipeline.

## Non-negotiable: the output format

Emit a `.zip` containing:

```
pack.json            the record below
images/              PNG or WebP snapshots referenced by pack.json
audio/               (optional) the raw recording
```

`pack.json` must satisfy this shape. It is schema version `1.x`; a consumer
accepts any `1.*`. Fields you cannot populate must be present and `null` (or an
empty array) — never absent, never invented.

```ts
interface ClassPackJson {
  schema_version: string;      // "1.1"
  generated_at: string;        // ISO 8601 with offset
  session: {
    id: string;
    started_at: string;        // ISO 8601 with offset
    duration_s: number;
    room: string;              // where it happened, e.g. "preply"
    subject: string;
    lesson_number: number | null;
    participants: Array<{
      role: 'tutor' | 'student';
      id: string;
      display_name: string;
      timezone: string | null;
    }>;
    textbook: { title: string; edition: string | null; note: string | null } | null;
    student_profile: { grade: string | null; level: string | null; goals: string[] } | null;
    tutor_intent_before: string | null;   // asked before recording starts
    tutor_note_after: string | null;      // asked when recording stops
  };
  transcript: Array<{
    id: string;                // "t0001", stable by order
    t: number;                 // seconds from session start
    speaker: string;
    role: 'tutor' | 'student' | 'unknown';
    text: string;
    confidence: number | null;
    low_confidence: boolean;
    alternates: string[];
    surface_id: string | null; // what was on screen when this was said
  }>;
  events: Array<{
    t: number;
    type: 'surface_changed' | 'silence' | 'note'
        | 'control_handed_to_student' | 'control_taken_back'
        | 'narration_started' | 'narration_stopped';
    surface_id?: string;
    duration_s?: number;
    text?: string;
  }>;
  surfaces: Array<{
    id: string;                            // "wb_1", "lesson_1"
    type: 'whiteboard' | 'explainer' | 'lesson';
    title: string | null;
  }>;
  snapshots: Array<{
    id: string;
    surface_id: string;
    t: number;
    image: string;             // path inside the archive, e.g. "images/s0007.webp"
    reason: 'ink_committed' | 'surface_changed' | 'scrolled'
          | 'interactive_answered' | 'periodic' | 'session_end';
    has_new_ink: boolean;
    ink_delta_image: string | null;
    ink_bbox: [number, number, number, number] | null;
    scroll_y: number;
    ocr_text: string | null;
    transcript_window: string[];  // ids of lines spoken around this moment
  }>;
  materials: Array<{
    id: string;
    type: 'textbook_page' | 'lesson_page' | 'explainer' | 'image' | 'homework';
    image: string | null;
    source: string;            // URL or filename it came from
    shown_from: number;
    shown_to: number | null;
    ocr_text: string | null;
    detected_question_numbers: string[];
    source_ref: string | null;
  }>;
  explainer_outlines: unknown[];   // [] is fine for this extension
  interactives: unknown[];         // [] unless you can detect quiz widgets
  homework: { previous_pack: string | null; submitted: boolean; submissions: string[] };
  capture_report: {
    board_snapshots_kept: number;
    duplicates_suppressed: number;
    snapshots_with_new_ink: number;
    screens_recorded: number;
    asr_lines_low_confidence: number;
    failures: Array<{ what: string; why: string }>;
  };
}
```

`transcript_window` is what makes a pack useful rather than merely complete: it
links a picture of the board to the words spoken while it was drawn. Populate it
by selecting transcript ids within roughly ±20 seconds of the snapshot's `t`.

## How it should work

**Manifest V3.** A popup with three states: idle, recording (elapsed time,
snapshot count, a visible dot), and finishing.

**Starting.** The tutor picks the tab to record, or the whole screen, using
`chrome.tabCapture` / `chrome.desktopCapture`. Before recording begins, ask two
short questions and store the answers: *what are you teaching today?*
(`tutor_intent_before`) and the student's name. Do not block on them.

**Capturing the board.** Sample the captured stream to a canvas on an interval
(start at 1000ms — see "Traps" for why not faster). Compare each frame to the
last kept one and keep it only if it differs materially. Record every skipped
frame in `duplicates_suppressed`.

**Capturing speech.** Use the Web Speech API against the microphone for the
tutor, and the captured tab's audio track for the student where the platform
plays it through the tab. Keep interim results out of the final transcript, but
keep `confidence` and set `low_confidence` when it is below ~0.6 — a downstream
model should be able to discount a line it cannot trust rather than treat a
mis-heard "sine" as fact.

**Detecting surfaces.** A "surface" is one thing being taught on. Start a new
one when the tab's URL changes, when the visible frame changes wholesale rather
than incrementally, or when the tutor presses a "new surface" button in the
popup. Emit a `surface_changed` event and a snapshot with that reason.

**Finishing.** Ask for a one-line `tutor_note_after`. Build the zip. Download it
via `chrome.downloads`. Show the tutor the `capture_report` — how many snapshots
were kept, how many suppressed, and anything that failed.

## Traps. These have already cost someone a week.

**Do not sample at 8 frames a second.** An earlier system streamed a full image
every 120ms whether or not anything had changed. It produced ~400MB–1GB per
lesson-hour and blew through a hosting bandwidth allowance. Sample at 1s, and
keep only what changed.

**But do not deduplicate without a keyframe.** The same system then skipped
unchanged frames, and a *static* board silently produced exactly one image — so
when that one was lost, there was nothing after it, and the record was blank for
the rest of the lesson. Keep a full snapshot every ~30 seconds regardless
(`reason: 'periodic'`). A lost frame must be self-correcting.

**Compare frames properly.** Two visually identical screenshots are rarely
byte-identical — compression noise, a blinking cursor, an antialiased edge. Do
not compare data URLs. Downscale to something small (e.g. 64×64 greyscale) and
compare mean absolute pixel difference against a threshold. Tune the threshold
on a real lesson, not a blank page.

**Never fail silently.** Every failure — microphone denied, tab capture stopped,
a frame that would not encode, storage full — must land in
`capture_report.failures` with a `what` and a `why`, and be visible in the popup.
A recorder that quietly captures nothing is worse than one that refuses to start,
because the tutor only discovers it after the lesson is over.

**Do not hold the lesson in memory.** An hour of snapshots will exhaust a
service worker. Write each snapshot to IndexedDB as it is taken and assemble the
zip at the end, streaming. Assume the tutor's laptop is not fast.

**MV3 service workers are killed when idle.** Anything that must survive the
whole lesson — timers, the recording state — cannot live only in the worker. Use
an offscreen document for capture and keep durable state in `chrome.storage`.

**Time is relative to session start**, in seconds, everywhere. Not wall clock,
not milliseconds. Mixing these is the most common way a pack becomes unusable.

## Privacy, and this part is not optional

This records a real child in a real lesson.

- Recording must be **explicitly started** by the tutor every time. Never
  automatic, never on a schedule, never remembered as "always on".
- The popup must show an unmistakable indicator whenever capture is live.
- Everything stays **on the tutor's machine**. No server, no analytics, no
  telemetry, no third-party API. The pack is a local file the tutor chooses what
  to do with.
- The tutor is responsible for telling the student and, for a minor, their
  parent. Put that sentence in the extension's own onboarding screen, in plain
  words. Do not bury it in a policy document.
- Request the narrowest permissions that work. `activeTab` over `<all_urls>` if
  you can manage it.

## What "done" looks like

1. Record a 10-minute lesson on a real third-party whiteboard.
2. The zip opens; `pack.json` validates against the shape above.
3. `snapshots` contains the moments that mattered and not sixty copies of one
   board. `duplicates_suppressed` is large; `board_snapshots_kept` is small.
4. Each snapshot's `transcript_window` contains the words actually spoken while
   it was on screen — spot-check three by hand.
5. Feed `pack.json` to a language model with the instruction "write a revision
   note for this lesson" and get something a tutor would recognise as their own
   lesson, without a person having explained it first.

Point 5 is the only test that matters. The rest is how you get there.
