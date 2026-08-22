# Writing a lesson for MathsLive

Paste this into the prompt whenever you generate a lesson with an AI. Everything
here exists because of something that actually went wrong in a live class.

MathsLive mirrors the teacher's copy to the students: the lesson runs **once**,
on the teacher's machine, and every student displays what it produces. That makes
it impossible for a student to end up on a different question — and it puts a
handful of constraints on what a lesson can do.

---

## Paste this into the prompt

```
This page runs inside MathsLive, which mirrors the teacher's copy to students.
The lesson runs once, on the teacher's machine; students see what it produces
and their taps are forwarded back to it. Follow these rules exactly.

1. STATE
   Keep everything that decides what is on screen in ONE plain object, and
   expose it:

     window.mathslive = {
       getState: () => state,
       setState: (s) => { state = s; render(); }
     };

   render() must rebuild the page from `state` alone. Keep the object small —
   the current position, not the whole question bank.

2. STRUCTURE
   Give every container whose contents change an `id`.

3. DO NOT USE
   - <iframe> (GeoGebra, Desmos, YouTube embeds). Each student loads it
     separately and it is never mirrored.
   - localStorage or sessionStorage.
   - Anything that branches on the current date or time of day.
   - More than 4 <canvas> elements.
   - Images from other websites, if you also draw on a canvas.

4. POSITION
   For clicks that depend on WHERE the person clicked (number lines, graphs,
   "tap where the ball lands"), read clientX/clientY relative to the element's
   getBoundingClientRect(). Never decide content from window.innerWidth.

5. SOUND
   Students will not hear it — only the teacher's copy runs. Never put
   information in audio alone.
```

---

## Why each rule is there

**State.** The mirror keeps every student on the teacher's screen. It cannot keep
that screen alive through a reload — the lesson lives in that tab, and closing it
ends the only copy. Rebuilding from a snapshot of the page re-runs the lesson's
scripts over already-rendered markup, which is how a quiz comes back at question
one with two canvases on it.

A lesson that can say where it is can be put straight back. With the hook, a
teacher who reloads mid-class returns to the same question with the same score,
and the class never notices. Without it, MathsLive says so plainly and asks
before you reload — but the lesson does restart.

**Structure.** Elements are matched between the two screens by position among
their siblings. An `id` is an anchor that survives anything.

**No iframes.** `<iframe>` is a whole second page. It loads independently on
every device and the mirror cannot see inside it, so whatever happens in there
happens separately for each person.

**No storage, no clock.** Both make the same lesson behave differently on
different machines, which is the one thing the mirror cannot paper over.

**Four canvases.** Past that they are not sent, and look blank.

**No foreign images with a canvas.** Drawing one onto a canvas "taints" it, after
which the browser refuses to let anything read that canvas — including us. The
student sees a permanently blank area and nothing reports why.

**Position.** A student's tap is forwarded with its position as a fraction of the
element it landed on, so it arrives at the right point on the teacher's copy even
on a different screen size. A lesson that ignores the coordinates throws that
away.

**Sound.** A student's copy runs no scripts at all — that is what stops the
lesson running twice. Anything it would have played plays only for the teacher.

---

## Checking a lesson

MathsLive checks each lesson when you upload it and when you press Run, and tells
you in plain words what it found: embedded pages, too many canvases, foreign
images alongside a canvas, audio, and size. A lesson with no warnings and the
state hook will survive anything short of losing the internet.
