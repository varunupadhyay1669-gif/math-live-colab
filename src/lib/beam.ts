// Beam — showing the class a picture of what is on the tutor's screen, over
// the connection that already works.
//
// "My screen" is WebRTC, and WebRTC is the part of this product that most
// reliably does not come up. screenShare.ts hard-codes two Google STUN servers
// and never asks getIceConfig() the way the video call does, and TURN_URLS is
// blank, so there is no relay at all: on a school network or Indian mobile data
// the peer connection simply never establishes. Worse, Room.tsx set myScreenOn
// from getDisplayMedia alone, so the toolbar said "Sharing" whether one student
// was connected or none — a tutor could talk over a PDF for ten minutes to a
// child who was looking at the last thing the mirror sent.
//
// The other route a PDF has ever taken to a student is being imported into the
// whiteboard as up to twenty JPEG data URLs, which are PERSISTED into room
// state. That is the exact shape that has OOM-killed this 1GB box with Postgres
// beside it, so it is not the answer either.
//
// So: still frames, encoded as WebP, deduped on the encoded string, sent over
// the Socket.IO connection that is already carrying the lesson. No negotiation,
// no relay, nothing that can be blocked separately from the app itself. It is
// not video and it is not interactive, and it is not pretending to be either:
// the student is told VIEW ONLY in words, and the tutor is told BY NAME who is
// actually receiving it. "I thought he could see it" is the failure this
// exists to fix, and a fallback that can fail silently just reproduces it.
//
// Everything above BeamRunner is pure and is tested in verify-mirror.mjs.
// BeamRunner touches the DOM only inside its methods, so this file still
// imports cleanly in Node.

export type BeamSource = 'board' | 'screen';

/**
 * Half a second between frames.
 *
 * This is a lecture aid, not a video codec. A PDF being talked over changes
 * when the tutor scrolls, and a person scrolling produces a handful of
 * distinguishable states per second — 2fps is enough to follow along, and the
 * dedupe below means a page nobody is scrolling costs literally nothing.
 */
export const BEAM_TICK_MS = 500;

/**
 * A whole frame every ten ticks (~5s) whether it changed or not.
 *
 * Dedupe means a STILL page is sent exactly once. If that one frame is lost —
 * dropped in transit, or sent before a student had joined — they are left with
 * an empty overlay and nothing ever corrects it. The same reasoning as
 * mirrorScript.ts's KEYFRAME_EVERY, and it is what makes a late joiner
 * self-correcting without the server holding a single byte per room.
 */
export const BEAM_KEYFRAME_EVERY = 10;

/** Longest edge of the scratch canvas. A 4K monitor is not worth 4K of wire. */
export const BEAM_MAX_EDGE = 1280;

export const BEAM_QUALITY = 0.6;
export const BEAM_MIN_QUALITY = 0.3;
const BEAM_QUALITY_STEP = 0.15;

/**
 * The ceiling, per second, per beam.
 *
 * Past this the beam gets worse rather than stopping. A tutor mid-explanation
 * cannot act on "your connection is too slow"; they can act on a picture that
 * is still arriving, slightly blurrier. Never stop — a slower beam is still a
 * beam.
 */
export const BEAM_BUDGET_BYTES_PER_SEC = 120 * 1024;
/** Comfortably under budget for a whole second: earn a step of quality back. */
const BEAM_RECOVER_BYTES_PER_SEC = 60 * 1024;
/** Slowest the beam is ever allowed to run. Two halvings from 500ms. */
export const BEAM_MAX_TICK_MS = 2000;

/**
 * Hard ceiling on one frame.
 *
 * Socket.IO's maxHttpBufferSize is 5e6 and it does not drop an oversize
 * message — it KILLS the connection. On this product that means the student's
 * lesson dies, not just the picture. So an oversize frame is never put on the
 * wire; the quality drops and the next tick tries again.
 */
export const BEAM_MAX_FRAME_BYTES = 900 * 1024;

/**
 * How long a student's overlay waits before admitting it is frozen.
 *
 * Longer than two keyframes (~10s), so a single lost frame does not raise a
 * false alarm, and short enough that a child is not staring at a stale diagram
 * believing it is live.
 */
export const BEAM_STALE_MS = 12_000;

/**
 * How recent an ack has to be to count as "receiving".
 *
 * Students ack at most once a second, so four seconds is three missed acks —
 * long enough not to flicker on a hiccup, short enough that the tutor learns
 * within a sentence that somebody dropped off.
 */
export const BEAM_ACK_STALE_MS = 4000;

export interface BeamFrame {
  /** The data: URL exactly as it goes on the wire. */
  data: string;
  source: BeamSource;
  keyframe: boolean;
  /** Monotonic per beam, so a student can ack the frame they actually painted. */
  seq: number;
  w: number;
  h: number;
}

/**
 * What one frame costs.
 *
 * The string IS the wire cost: a data: URL is all ASCII, it is sent as a
 * string, and Socket.IO bills bytes of the encoded message. Measuring the
 * DECODED image instead would under-count by a third and quietly blow the
 * budget this governs — base64 is 4 characters per 3 bytes.
 */
export function frameBytes(dataUrl: unknown): number {
  return typeof dataUrl === 'string' ? dataUrl.length : 0;
}

/** The rolling one-second account, plus what it has decided to do about it. */
export interface BeamBudget {
  /** Bytes charged inside the window that is still open. */
  bytes: number;
  /** When that window opened. */
  windowStart: number;
  /** WebP quality to encode the next frame at. */
  quality: number;
  /** Milliseconds until the next tick. */
  tickMs: number;
}

export function freshBudget(now: number): BeamBudget {
  return { bytes: 0, windowStart: now, quality: BEAM_QUALITY, tickMs: BEAM_TICK_MS };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** Quality is a float; compare and store it rounded so 0.6-0.15-0.15 is 0.3. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Charge a frame and, once a second has passed, react to what it cost.
 *
 * Pure: takes the account and returns the next one, so the whole governor can
 * be driven from a test with a fake clock. Both dials move together on
 * purpose — halving the rate alone leaves each frame just as fat, and dropping
 * quality alone leaves the frame count untouched, and the two failures this
 * has to survive (a school's uplink, a phone on 3G) are budget failures rather
 * than either one separately.
 */
export function accountFrame(budget: BeamBudget, bytes: number, now: number): BeamBudget {
  const bytesInWindow = budget.bytes + Math.max(0, bytes);
  if (now - budget.windowStart < 1000) {
    return { ...budget, bytes: bytesInWindow };
  }
  // The window that just closed, normalised to a per-second rate: a window
  // that ran long (a backgrounded tab, a slow encode) must not be read as a
  // spike it was not.
  const elapsed = Math.max(1, now - budget.windowStart);
  const rate = (bytesInWindow * 1000) / elapsed;

  let { quality, tickMs } = budget;
  if (rate > BEAM_BUDGET_BYTES_PER_SEC) {
    quality = round2(clamp(quality - BEAM_QUALITY_STEP, BEAM_MIN_QUALITY, BEAM_QUALITY));
    tickMs = clamp(tickMs * 2, BEAM_TICK_MS, BEAM_MAX_TICK_MS);
  } else if (rate < BEAM_RECOVER_BYTES_PER_SEC) {
    quality = round2(clamp(quality + BEAM_QUALITY_STEP, BEAM_MIN_QUALITY, BEAM_QUALITY));
    tickMs = clamp(Math.round(tickMs / 2), BEAM_TICK_MS, BEAM_MAX_TICK_MS);
  }
  return { bytes: 0, windowStart: now, quality, tickMs };
}

/**
 * One frame came back over the hard cap. Get smaller immediately.
 *
 * Not a budget matter and not something to average over a second: this frame
 * cannot be sent at all, so the next one has to be cheaper right now.
 */
export function shrinkAfterOversize(budget: BeamBudget): BeamBudget {
  return {
    ...budget,
    quality: round2(clamp(budget.quality - BEAM_QUALITY_STEP, BEAM_MIN_QUALITY, BEAM_QUALITY)),
  };
}

/**
 * The scratch canvas size for a source of this shape.
 *
 * Never upscales. A whiteboard canvas is already backing-store sized (device
 * pixel ratio), and blowing a 900px board up to 1280 would cost bandwidth to
 * transmit interpolation.
 */
export function fitScratch(srcW: number, srcH: number, maxEdge = BEAM_MAX_EDGE): { width: number; height: number } {
  const w = Math.max(1, Math.floor(srcW) || 0);
  const h = Math.max(1, Math.floor(srcH) || 0);
  const longest = Math.max(w, h);
  if (!Number.isFinite(longest) || longest <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** The two calls paintScratch makes, so a test can record them without a browser. */
export interface ScratchContext {
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * White first, then the picture.
 *
 * WebP keeps its alpha channel, and the student's beam overlay is dark. A
 * whiteboard is transparent everywhere the tutor has not drawn, so a frame
 * composited straight onto that overlay is black paper with black ink — the
 * board looks empty, which is indistinguishable from the beam being broken.
 * The fill has to happen BEFORE the draw, which is the thing worth asserting.
 */
export function paintScratch(ctx: ScratchContext, source: CanvasImageSource, width: number, height: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
}

/** Where an 8x8 probe grid lands on a frame of this size. */
export function samplePoints(width: number, height: number, n = 8): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      // Cell CENTRES, not corners. Sampling at 0 and at width-1 puts a quarter
      // of the probes in the border, which on a captured window is chrome
      // rather than content.
      pts.push({
        x: Math.min(width - 1, Math.floor(((ix + 0.5) / n) * width)),
        y: Math.min(height - 1, Math.floor(((iy + 0.5) / n) * height)),
      });
    }
  }
  return pts;
}

/**
 * Did we capture nothing at all?
 *
 * Chrome will happily hand back a tab capture of a PDF that is entirely white
 * or entirely black — the plugin's surface is not in the captured layer — and
 * the tutor has no way to know: their own screen looks right. Sixty-four
 * probes that all agree on one colour is the signature, and the fix is always
 * the same sentence: share the WINDOW, not the tab.
 *
 * Deliberately a small tolerance rather than exact equality, so a captured
 * page with a faint background gradient is still read as blank. Samples are
 * packed 0xRRGGBB.
 */
export function looksBlank(samples: number[], tolerance = 6): boolean {
  if (!samples || samples.length === 0) return true;
  let rLo = 255, rHi = 0, gLo = 255, gHi = 0, bLo = 255, bHi = 0;
  for (const s of samples) {
    const r = (s >> 16) & 255, g = (s >> 8) & 255, b = s & 255;
    if (r < rLo) rLo = r; if (r > rHi) rHi = r;
    if (g < gLo) gLo = g; if (g > gHi) gHi = g;
    if (b < bLo) bLo = b; if (b > bHi) bHi = b;
  }
  return (rHi - rLo) <= tolerance && (gHi - gLo) <= tolerance && (bHi - bLo) <= tolerance;
}

export interface BeamViewer { id: string; name: string }

export interface BeamReach {
  /** Names of students whose ack is recent enough to believe. */
  seeing: string[];
  /** Names of students in the room who are not acking. */
  notSeeing: string[];
  /** One sentence for the tutor, naming people. */
  text: string;
}

/** "Aarav", "Aarav and Meera", "Aarav, Meera and Sam". */
function listNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Who can actually see this, by name.
 *
 * The whole point of the feature. The old share reported its own
 * getDisplayMedia call — a fact about the tutor's browser, not about the
 * child — so "Sharing" was true while nobody received anything, and the tutor
 * found out at the end of the lesson or not at all. This reports the acks that
 * came back from students, which is the only evidence that exists.
 *
 * Names, not a count: "1 of 2 connected" tells a tutor with two students
 * nothing they can act on, and in a one-to-one lesson a count is not even a
 * sentence.
 */
export function reachSummary(
  viewers: BeamViewer[],
  ackAt: Record<string, number>,
  now: number,
  staleMs = BEAM_ACK_STALE_MS,
): BeamReach {
  const seeing: string[] = [];
  const notSeeing: string[] = [];
  for (const v of viewers) {
    const at = ackAt[v.id];
    if (typeof at === 'number' && now - at <= staleMs) seeing.push(v.name);
    else notSeeing.push(v.name);
  }
  let text: string;
  if (viewers.length === 0) text = 'Nobody has joined this room yet.';
  else if (notSeeing.length === 0) text = `${listNames(seeing)} can see this.`;
  else if (seeing.length === 0) text = `Not reaching ${listNames(notSeeing)} yet.`;
  else text = `${listNames(seeing)} can see this. Not reaching ${listNames(notSeeing)}.`;
  return { seeing, notSeeing, text };
}

/** What the tutor's menu calls each source, and what the student's badge says. */
export function beamLabel(source: BeamSource): string {
  return source === 'board' ? 'The whiteboard' : "The tutor's screen";
}

// ─────────────────────────────────────────────────────────────────────────
// The runner. Everything below touches the DOM, and only inside a method, so
// the module above stays importable in Node.
// ─────────────────────────────────────────────────────────────────────────

export interface BeamRunnerOptions {
  source: BeamSource;
  /** Put one frame on the wire. */
  send: (frame: BeamFrame) => void;
  /** Re-read every tick: <Whiteboard> renders null when it is not in front. */
  getBoardCanvas?: () => HTMLCanvasElement | null;
  /** A keyframe came back as one flat colour — see looksBlank. Told once. */
  onBlank?: (source: BeamSource) => void;
  /** The capture ended on its own (the browser's "Stop sharing" bar). */
  onEnded?: () => void;
  /** Injected in tests; the real one is the clock. */
  now?: () => number;
}

export class BeamRunner {
  private opts: BeamRunnerOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private scratch: HTMLCanvasElement | null = null;
  private budget: BeamBudget;
  private ticks = 0;
  private seq = 0;
  private lastData = '';
  private forceKeyframe = false;
  private blankReported = false;
  private stopped = false;

  constructor(opts: BeamRunnerOptions) {
    this.opts = opts;
    this.budget = freshBudget(this.clock());
  }

  private clock(): number { return this.opts.now ? this.opts.now() : Date.now(); }

  /**
   * Ask for the capture and start ticking.
   *
   * Throws whatever getDisplayMedia throws, so the caller can tell a refusal
   * ("NotAllowedError" — they closed the picker) apart from a device that
   * cannot do it at all. Nothing is broadcast until a frame actually exists.
   */
  async start(): Promise<void> {
    if (this.opts.source === 'screen') {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
        // Same reasoning as screenShare.ts: Chrome defaults selfBrowserSurface
        // to 'exclude', which hides MathsLive itself from the picker — the one
        // thing a tutor showing their own board is trying to pick.
        selfBrowserSurface: 'include',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);
      this.stream = stream;
      // The browser's own "Stop sharing" bar is what most people reach for,
      // and a beam that kept sending the last frame after it would be a lie.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => this.opts.onEnded?.());

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      // Off-screen rather than detached: a detached <video> is allowed to stop
      // decoding, and a decoder that has stopped hands drawImage the frame it
      // stopped on for ever.
      video.setAttribute('data-mathslive-beam', '1');
      video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      document.body.appendChild(video);
      this.video = video;
      try { await video.play(); } catch { /* the first tick will find it not ready and wait */ }
    }
    this.schedule(0);
  }

  /** Next frame goes out whole, whatever the dedupe thinks. */
  requestKeyframe(): void { this.forceKeyframe = true; }

  /** Safe to call twice; leaves nothing capturing and nothing scheduled. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* already stopped */ } });
    this.stream = null;
    if (this.video) {
      try { this.video.srcObject = null; this.video.remove(); } catch { /* already gone */ }
      this.video = null;
    }
    this.scratch = null;
    this.lastData = '';
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.tick(); }, ms);
  }

  /** The element to draw, and the size it really is. */
  private sourceNow(): { el: CanvasImageSource; w: number; h: number } | null {
    if (this.opts.source === 'board') {
      const c = this.opts.getBoardCanvas?.() || null;
      if (!c || !c.width || !c.height) return null;
      return { el: c, w: c.width, h: c.height };
    }
    const v = this.video;
    // readyState < HAVE_CURRENT_DATA means drawImage would paint nothing, and
    // a frame of nothing is worse than a frame late: it would be sent, deduped
    // against, and become the still picture the student is left staring at.
    if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    return { el: v, w: v.videoWidth, h: v.videoHeight };
  }

  private tick(): void {
    if (this.stopped) return;
    // Reschedule FIRST. Everything below can throw — a tainted canvas, a
    // capture that has gone away — and a beam that stops ticking because one
    // frame failed is the silent failure this feature exists to remove.
    this.schedule(this.budget.tickMs);

    const src = this.sourceNow();
    if (!src) return;

    const { width, height } = fitScratch(src.w, src.h);
    let scratch = this.scratch;
    if (!scratch) { scratch = document.createElement('canvas'); this.scratch = scratch; }
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    let data: string;
    try {
      paintScratch(ctx, src.el, width, height);
      data = scratch.toDataURL('image/webp', this.budget.quality);
    } catch {
      // A tainted canvas throws SecurityError for ever. Nothing here can fix
      // it, and the beam has already been rescheduled, so say nothing.
      return;
    }

    // Counted unconditionally, not inside the || chain: short-circuiting past
    // it on a requested keyframe would leave the periodic one drifting, and a
    // student who asks often enough would silently stop getting them.
    this.ticks++;
    const keyframe = this.forceKeyframe || (this.ticks % BEAM_KEYFRAME_EVERY === 0) || this.lastData === '';
    this.forceKeyframe = false;

    // The whole saving: a PDF nobody is scrolling encodes to the same string
    // every time, so it costs one string compare instead of a network send.
    if (!keyframe && data === this.lastData) return;

    const bytes = frameBytes(data);
    if (bytes > BEAM_MAX_FRAME_BYTES) {
      // Never put this on the wire. Socket.IO kills the connection on an
      // oversize message, which would take the student's whole lesson with it.
      this.budget = shrinkAfterOversize(this.budget);
      return;
    }

    if (keyframe && !this.blankReported && this.opts.source === 'screen' && this.isBlank(ctx, width, height)) {
      // Only for a screen capture. An empty whiteboard is legitimately one
      // flat colour and warning about it would be nonsense.
      this.blankReported = true;
      this.opts.onBlank?.(this.opts.source);
    }

    this.lastData = data;
    const before = this.budget.tickMs;
    this.budget = accountFrame(this.budget, bytes, this.clock());
    // The next tick was booked at the top of this one, at the old rate. If the
    // governor has just changed its mind, re-book it — otherwise slowing down
    // takes one extra frame at each step, which is a whole second of the wrong
    // rate on a line that is already struggling.
    if (this.budget.tickMs !== before) this.schedule(this.budget.tickMs);
    this.opts.send({ data, source: this.opts.source, keyframe, seq: ++this.seq, w: width, h: height });
  }

  private isBlank(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
    try {
      const samples = samplePoints(width, height).map(({ x, y }) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return (d[0] << 16) | (d[1] << 8) | d[2];
      });
      return looksBlank(samples);
    } catch {
      return false;   // unreadable is not the same as blank; never guess
    }
  }
}
