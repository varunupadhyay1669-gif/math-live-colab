import { PdfBuilder, dataUrlToBytes, type TextLine, type PdfImage } from './pdf';
import { mergeTranscript, type NarrationLine } from './narration';
import { averageHash, lumaGrid, isNearDuplicate } from './inkDelta';
import type { SnapshotReason } from './packSchema';

// ─────────────────────────────────────────────────────────────────────────
// The class pack — everything that happened in a lesson, in one file you can
// hand to a language model.
//
// Tutors already paste whiteboard work into an LLM to get a recap, a worksheet
// or a parent note out of it. The bit that's always missing is the rest of the
// lesson: which HTML you ran, which explainer you layered on top, what was on
// the board at each stage, in what order. This collects all of it as the class
// happens and packages it as a PDF, because a PDF is the one format that
// carries prose AND pictures and can be dropped into any model.
//
// Board snapshots are images; lessons and explainers are kept as SOURCE, not
// pictures — a model reads the HTML far better than a screenshot of it.
// ─────────────────────────────────────────────────────────────────────────

export interface Snapshot {
  t: number;              // ms since the pack started
  dataUrl: string;        // image/jpeg
  width: number;
  height: number;
  label: string;
  surfaceId: string;
  reason: SnapshotReason;
  hasNewInk: boolean;
  inkBbox: [number, number, number, number] | null;
  inkDeltaDataUrl: string | null;
  scrollY: number;
}

/** Why a frame is being offered, and what is new in it. */
export interface SnapshotOpts {
  force?: boolean;
  surfaceId?: string;
  reason?: SnapshotReason;
  inkBbox?: [number, number, number, number] | null;
  inkDeltaDataUrl?: string | null;
  scrollY?: number;
}

export interface Artifact {
  t: number;
  kind: 'lesson' | 'explanation' | 'image' | 'pdf' | 'video';
  name: string;
  /** Source for html kinds; a URL for video; omitted for binary images. */
  body?: string;
}

export interface Moment {
  t: number;
  text: string;
}

/**
 * The worksheet sent after the last lesson, and what she sent back.
 *
 * Without these, every new worksheet is written blind to how the last one went:
 * the model cannot see which questions she got wrong, so it re-tests the wrong
 * things. Attached by the tutor, because there is no student login to upload
 * through and adding one for this would be a service, not a feature.
 */
export interface HomeworkItem {
  kind: 'previous_worksheet' | 'submission';
  name: string;
  mime: string;
  /** Images ride along as data URLs so they can be shown in the PDF. */
  dataUrl?: string;
  width?: number;
  height?: number;
  /** Anything not an image (a PDF) travels in the archive only. */
  bytesBase64?: string;
  addedAt: number;
}

/** A snapshot of the lesson's live DOM — what was actually on screen. */
export interface LessonState {
  t: number;
  /** Readable text of the page at that moment (which question was showing). */
  text: string;
  label: string;
}

/** How different two board snapshots must be before another is worth keeping. */
const MIN_SNAPSHOT_GAP_MS = 20_000;
const MAX_SNAPSHOTS = 60;          // ~60 pages of board is already a lot
const MAX_ARTIFACTS = 40;
const MAX_MOMENTS = 400;
const MAX_BODY_CHARS = 40_000;     // per artifact, so one huge sim can't dominate
const MAX_NARRATION = 4_000;       // ~a very talkative two-hour lesson
const MAX_LESSON_STATES = 300;

/** The serialised form of a pack, as written to the store. */
export interface PackState {
  v: 1;
  startedAt: number;
  meta: ClassPack['meta'];
  snapshots: Snapshot[];
  artifacts: Artifact[];
  moments: Moment[];
  narration: NarrationLine[];
  lessonStates: LessonState[];
  duplicatesSuppressed: number;
  lastHash: string;
  lastSignature: string;
  lastLessonText: string;
  homework?: HomeworkItem[];
}

export class ClassPack {
  readonly startedAt = Date.now();
  private snapshots: Snapshot[] = [];
  private artifacts: Artifact[] = [];
  private moments: Moment[] = [];
  private lastSnapshotAt = 0;
  private lastSignature = '';
  private lastHash = '';
  private duplicatesSuppressed = 0;
  private narration: NarrationLine[] = [];
  private lessonStates: LessonState[] = [];
  private lastLessonText = '';
  private homework: HomeworkItem[] = [];

  meta: { room: string; teacher: string; student?: string; topic?: string;
          intentBefore?: string; noteAfter?: string } = { room: '', teacher: '' };

  private since() { return Date.now() - this.startedAt; }

  /** Something worth remembering happened. */
  note(text: string) {
    if (!text) return;
    if (this.moments.length >= MAX_MOMENTS) this.moments.shift();
    this.moments.push({ t: this.since(), text });
  }

  addArtifact(kind: Artifact['kind'], name: string, body?: string) {
    // Re-running the same lesson, or a re-render that re-reports it, must not
    // stack identical copies — the pack would fill with duplicates of the one
    // page and bury everything else.
    const clipped = body ? body.slice(0, MAX_BODY_CHARS) : undefined;
    if (this.artifacts.some(a => a.kind === kind && a.name === name && a.body === clipped)) return;
    if (this.artifacts.length >= MAX_ARTIFACTS) this.artifacts.shift();
    this.artifacts.push({ t: this.since(), kind, name: name || kind, body: clipped });
    this.note(`${kindLabel(kind)}: ${name || kind}`);
  }

  /**
   * Offer a board snapshot. Ignored if one was taken recently or the board
   * hasn't changed — an unchanged board every 20s would pad the pack with
   * dozens of identical pages and bury the moments that matter.
   */
  /**
   * A ready-made image (the lesson page with the ink over it — see lessonShot).
   * Same recency and change rules as a board snapshot, so a still page costs
   * nothing and a page being explained is captured as it changes.
   */
  offerImage(dataUrl: string, width: number, height: number, label: string, opts: SnapshotOpts = {}): boolean {
    const now = Date.now();
    if (!opts.force && now - this.lastSnapshotAt < MIN_SNAPSHOT_GAP_MS) return false;
    if (!dataUrl || dataUrl.length < 64) return false;
    // A rendered lesson page has no canvas to hash, so fall back to comparing
    // the encoded bytes. Weaker than the board's perceptual check, but a lesson
    // page that has not changed re-encodes to the same length far more reliably
    // than a hand-drawn board does.
    const signature = `${dataUrl.length}:${dataUrl.slice(2000, 2200)}`;
    if (!opts.force && signature === this.lastSignature) { this.duplicatesSuppressed++; return false; }
    this.lastSignature = signature;
    this.lastSnapshotAt = now;
    if (this.snapshots.length >= MAX_SNAPSHOTS) this.snapshots.shift();
    this.snapshots.push({
      t: this.since(), dataUrl, width, height, label,
      surfaceId: opts.surfaceId || 'lesson_1',
      reason: opts.reason || 'periodic',
      hasNewInk: !!opts.inkBbox,
      inkBbox: opts.inkBbox ?? null,
      inkDeltaDataUrl: opts.inkDeltaDataUrl ?? null,
      scrollY: opts.scrollY ?? 0,
    });
    return true;
  }

  offerSnapshot(canvas: HTMLCanvasElement, label: string, opts: SnapshotOpts = {}): boolean {
    const now = Date.now();
    if (!opts.force && now - this.lastSnapshotAt < MIN_SNAPSHOT_GAP_MS) return false;
    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    } catch {
      return false;   // tainted canvas — nothing we can do, and not worth throwing over
    }
    // A failed toDataURL returns "data:," — that's what this rejects. It must
    // NOT reject a genuinely small image: an almost-blank board early in a
    // lesson compresses to very little, and that snapshot is still real.
    if (!dataUrl || dataUrl.length < 64) return false;

    // Perceptual hash, not a byte comparison. Re-encoding the same board — or
    // nudging it by a scroll — changes the bytes completely while the picture is
    // unchanged, which is how runs of four near-identical frames used to survive.
    const hash = this.hashCanvas(canvas);
    if (!opts.force && hash && this.lastHash && isNearDuplicate(hash, this.lastHash)) {
      this.duplicatesSuppressed++;
      return false;
    }
    if (hash) this.lastHash = hash;
    this.lastSnapshotAt = now;
    if (this.snapshots.length >= MAX_SNAPSHOTS) this.snapshots.shift();
    this.snapshots.push({
      t: this.since(), dataUrl, width: canvas.width, height: canvas.height, label,
      surfaceId: opts.surfaceId || 'wb_1',
      reason: opts.reason || 'periodic',
      hasNewInk: !!opts.inkBbox,
      inkBbox: opts.inkBbox ?? null,
      inkDeltaDataUrl: opts.inkDeltaDataUrl ?? null,
      scrollY: opts.scrollY ?? 0,
    });
    return true;
  }

  /** Downscale to an 8×8 luma grid and hash it. Cheap enough to run per frame. */
  private hashCanvas(canvas: HTMLCanvasElement): string {
    try {
      const small = document.createElement('canvas');
      small.width = 32; small.height = 32;
      const ctx = small.getContext('2d', { willReadFrequently: true });
      if (!ctx) return '';
      ctx.drawImage(canvas, 0, 0, 32, 32);
      const { data } = ctx.getImageData(0, 0, 32, 32);
      return averageHash(lumaGrid(data, 32, 32));
    } catch {
      return '';
    }
  }

  get suppressedCount() { return this.duplicatesSuppressed; }

  /** A line somebody said, from either side of the call. */
  addNarration(speaker: string, text: string, t = this.since()) {
    const clean = (text || '').trim();
    if (!clean) return;
    if (this.narration.length >= MAX_NARRATION) this.narration.shift();
    this.narration.push({ t, speaker: speaker || 'Someone', text: clean.slice(0, 600) });
  }

  /**
   * What the lesson page actually said at this moment — which question was up,
   * what the sim was showing. Recorded only when it CHANGES, so a page sitting
   * still costs nothing and a quiz advancing is captured every time.
   */
  offerLessonState(text: string, label: string) {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean === this.lastLessonText) return false;
    this.lastLessonText = clean;
    if (this.lessonStates.length >= MAX_LESSON_STATES) this.lessonStates.shift();
    this.lessonStates.push({ t: this.since(), text: clean.slice(0, 4000), label });
    return true;
  }

  addHomework(item: HomeworkItem) {
    // Only one "previous worksheet" makes sense; attaching another replaces it.
    if (item.kind === 'previous_worksheet') {
      this.homework = this.homework.filter(h => h.kind !== 'previous_worksheet');
    }
    if (this.homework.length >= 12) this.homework.shift();
    this.homework.push(item);
    this.note(item.kind === 'submission'
      ? `Attached the student's homework: ${item.name}`
      : `Attached last lesson's worksheet: ${item.name}`);
  }

  removeHomework(name: string, kind: HomeworkItem['kind']) {
    this.homework = this.homework.filter(h => !(h.name === name && h.kind === kind));
  }

  get allHomework(): HomeworkItem[] { return this.homework; }

  /** Read-only views for the exporter. */
  get allSnapshots(): Snapshot[] { return this.snapshots; }
  get allNarration(): NarrationLine[] { return this.narration; }
  get allMoments(): Moment[] { return this.moments; }
  get allArtifacts(): Artifact[] { return this.artifacts; }
  get allLessonStates(): LessonState[] { return this.lessonStates; }

  get counts() {
    return {
      snapshots: this.snapshots.length,
      artifacts: this.artifacts.length,
      moments: this.moments.length,
      narration: this.narration.length,
      lessonStates: this.lessonStates.length,
    };
  }

  get isEmpty() {
    return this.snapshots.length === 0 && this.artifacts.length === 0
      && this.moments.length === 0 && this.narration.length === 0;
  }

  // ── Surviving a reload ──
  // The pack is the lesson's only record while the lesson is running, so it has
  // to be recoverable. Serialised as plain data (images stay as data URLs) so
  // the store never needs to understand the class.
  toState(): PackState {
    return {
      v: 1,
      startedAt: this.startedAt,
      meta: this.meta,
      snapshots: this.snapshots,
      artifacts: this.artifacts,
      moments: this.moments,
      narration: this.narration,
      lessonStates: this.lessonStates,
      duplicatesSuppressed: this.duplicatesSuppressed,
      lastHash: this.lastHash,
      lastSignature: this.lastSignature,
      lastLessonText: this.lastLessonText,
      homework: this.homework,
    };
  }

  /**
   * Rebuild from stored state. Returns null on anything unrecognisable rather
   * than half-restoring: a partially-restored pack would silently export a
   * lesson missing its middle, which is worse than starting clean.
   */
  static fromState(state: unknown): ClassPack | null {
    const st = state as PackState;
    if (!st || typeof st !== 'object' || st.v !== 1 || typeof st.startedAt !== 'number') return null;
    if (!Array.isArray(st.snapshots) || !Array.isArray(st.narration)) return null;
    const pack = new ClassPack();
    (pack as { startedAt: number }).startedAt = st.startedAt;   // readonly by intent, restored here only
    pack.meta = st.meta || { room: '', teacher: '' };
    pack.snapshots = st.snapshots;
    pack.artifacts = st.artifacts || [];
    pack.moments = st.moments || [];
    pack.narration = st.narration;
    pack.lessonStates = st.lessonStates || [];
    pack.duplicatesSuppressed = st.duplicatesSuppressed || 0;
    pack.lastHash = st.lastHash || '';
    pack.lastSignature = st.lastSignature || '';
    pack.lastLessonText = st.lastLessonText || '';
    pack.homework = Array.isArray(st.homework) ? st.homework : [];
    return pack;
  }

  /** Everything, as one PDF. */
  buildPdf(): Blob {
    const b = new PdfBuilder();
    const dur = Date.now() - this.startedAt;

    // ── Cover: what a model should know before reading anything else ──
    const cover: TextLine[] = [
      { text: 'MathsLive — class pack', size: 20, bold: true },
      { text: 'Everything from one lesson, for context.', size: 10, gap: 4 },
      { text: '', gap: 8 },
      { text: 'Session', size: 12, bold: true, gap: 8 },
      ...kv('Student', this.meta.student || '(not recorded)'),
      ...kv('Teacher', this.meta.teacher || '(not recorded)'),
      ...kv('Room', this.meta.room),
      ...kv('Started', new Date(this.startedAt).toLocaleString()),
      ...kv('Length', humanDuration(dur)),
      ...kv('Board snapshots', String(this.snapshots.length)),
      ...kv('Materials used', String(this.artifacts.length)),
      ...kv('Spoken lines captured', this.narration.length ? String(this.narration.length) : 'none (narration was off)'),
      ...kv('Lesson screens recorded', String(this.lessonStates.length)),
      { text: '', gap: 10 },
      ...(this.meta.intentBefore ? [
        { text: 'What this lesson was for', size: 12, bold: true, gap: 6 } as TextLine,
        ...PdfBuilder.wrap(this.meta.intentBefore, 10).map((text) => ({ text, size: 10 } as TextLine)),
      ] : []),
      ...(this.meta.noteAfter ? [
        { text: 'Note after the lesson', size: 12, bold: true, gap: 8 } as TextLine,
        ...PdfBuilder.wrap(this.meta.noteAfter, 10).map((text) => ({ text, size: 10 } as TextLine)),
      ] : []),
      { text: '', gap: 8 },
      { text: 'How to read this pack', size: 12, bold: true },
      ...PdfBuilder.wrap(
        'First comes the lesson as it happened, in order: what was said (with the speaker), what the ' +
        'lesson page was showing at that moment, and what the teacher did. Then the full source of ' +
        'every lesson page and explainer that was used - read these as the material being taught. ' +
        'Finally each board snapshot, captioned with its time, so the handwritten working can be ' +
        'followed in sequence against the account above.',
        10,
      ).map((text) => ({ text, size: 10 })),
    ];
    b.addTextPage(cover);

    // ── One chronological account ──
    // Speech, what was on the lesson page, and what the teacher did are all
    // interleaved by time. Read top to bottom it's the lesson as it happened:
    // "here's what was on screen, here's what was said about it, then we moved
    // to the board." Three separate lists would leave the model to guess the
    // ordering, which is the one thing it cannot recover.
    const entries: Array<{ t: number; kind: 'said' | 'screen' | 'did'; who?: string; text: string }> = [
      ...mergeTranscript(this.narration).map(l => ({ t: l.t, kind: 'said' as const, who: l.speaker, text: l.text })),
      ...this.lessonStates.map(s => ({ t: s.t, kind: 'screen' as const, text: `[${s.label}] ${s.text}` })),
      ...this.moments.map(m => ({ t: m.t, kind: 'did' as const, text: m.text })),
    ].sort((a, b) => a.t - b.t);

    const timelineLines: TextLine[] = [
      { text: 'What happened, in order', size: 16, bold: true },
      { text: 'Speech is marked with the speaker. [Lesson] lines are what the page showed at that moment.', size: 8.5, gap: 2 },
      { text: '', gap: 6 },
    ];
    if (entries.length === 0) {
      timelineLines.push({ text: 'Nothing was recorded for this session.', size: 10, gap: 6 });
    }
    for (const e of entries) {
      const head = e.kind === 'said' ? `${stamp(e.t)}  ${e.who}:` : `${stamp(e.t)}  ·`;
      const body = e.kind === 'said' ? e.text : e.text;
      const wrapped = PdfBuilder.wrap(`${head} ${body}`, e.kind === 'screen' ? 8.5 : 10);
      wrapped.forEach((line, i) => timelineLines.push({
        text: i === 0 ? line : '        ' + line,
        size: e.kind === 'screen' ? 8.5 : 10,
        bold: e.kind === 'did' && i === 0,
        gap: i === 0 ? 2 : 0,
      }));
    }
    for (const chunk of paginate(timelineLines, 42)) b.addTextPage(chunk);

    // ── The material itself, as source ──
    for (const a of this.artifacts) {
      if (!a.body) continue;
      const head: TextLine[] = [
        { text: `${kindLabel(a.kind)} — ${a.name}`, size: 14, bold: true },
        { text: `Shown at ${stamp(a.t)}`, size: 9, gap: 2 },
        { text: '', gap: 6 },
      ];
      // The raw document used to go in whole — stylesheet, scripts and all —
      // so a reader scrolled eighteen pages of CSS to reach two pages of maths.
      // The readable content goes in the PDF; the source travels in the archive.
      const readable = this.outlineFor(a.name) ?? stripToText(a.body);
      const body = PdfBuilder.wrap(readable, 8.5).map((text) => ({ text, size: 8.5 }));
      const pages = paginate(body, 62);
      pages.forEach((chunk, i) => b.addTextPage(i === 0 ? [...head, ...chunk] : [
        { text: `${a.name} (continued)`, size: 9, bold: true }, ...chunk,
      ]));
    }

    // ── Homework: last time's worksheet and what came back ──
    if (this.homework.length) {
      b.addTextPage([
        { text: 'Homework', size: 16, bold: true },
        { text: 'Attached by the tutor, so the next worksheet can build on the last one.', size: 9, gap: 2 },
        { text: '', gap: 8 },
        ...this.homework.flatMap(h => PdfBuilder.wrap(
          `${h.kind === 'submission' ? 'Her attempt' : 'Worksheet sent last time'}: ${h.name}`, 10,
        ).map(text => ({ text, size: 10 } as TextLine))),
      ]);
      for (const h of this.homework) {
        if (!h.dataUrl || !h.width || !h.height) continue;
        try {
          b.addImagePage(
            { jpeg: dataUrlToBytes(h.dataUrl), width: h.width, height: h.height },
            h.kind === 'submission' ? `Her attempt — ${h.name}` : `Last worksheet — ${h.name}`,
            h.kind === 'submission' ? 'What the student sent back.' : 'What was set after the previous lesson.',
          );
        } catch { /* skip an unreadable attachment */ }
      }
    }

    // ── The board, in order ──
    for (const s of this.snapshots) {
      let image: PdfImage;
      try {
        image = { jpeg: dataUrlToBytes(s.dataUrl), width: s.width, height: s.height };
      } catch { continue; }
      const headline = s.hasNewInk
        ? `${s.label} at ${stamp(s.t)} — new writing`
        : `${s.label} at ${stamp(s.t)}`;
      const why = s.reason === 'ink_committed' ? 'Captured because something was written.'
        : s.reason === 'surface_changed' ? 'Captured on switching away from this surface.'
        : s.reason === 'scrolled' ? 'Captured after scrolling to a new part of the page.'
        : s.reason === 'interactive_answered' ? 'Captured when a practice question was answered.'
        : s.reason === 'session_end' ? 'The last thing on screen.'
        : 'Periodic capture.';
      b.addImagePage(image, headline, why);
    }

    // ── P2-1: say what was captured and what was not ──
    b.addTextPage([
      { text: 'Capture report', size: 16, bold: true },
      { text: 'What this pack contains, and what it could not.', size: 9, gap: 2 },
      { text: '', gap: 8 },
      ...kv('Board and lesson snapshots kept', String(this.snapshots.length)),
      ...kv('Near-duplicates suppressed', String(this.duplicatesSuppressed)),
      ...kv('Snapshots with new writing', String(this.snapshots.filter(s => s.hasNewInk).length)),
      ...kv('Spoken lines captured', String(this.narration.length)),
      ...kv('Lesson screens recorded', String(this.lessonStates.length)),
      ...kv('Materials', String(this.artifacts.length)),
      { text: '', gap: 8 },
      { text: 'Not captured', size: 12, bold: true },
      ...PdfBuilder.wrap('Text inside images is not extracted - no OCR engine is bundled with the app.', 10).map(text => ({ text, size: 10 })),
      ...(this.narration.length === 0
        ? PdfBuilder.wrap('No speech was captured: narration was off, refused, or this browser cannot transcribe.', 10).map(text => ({ text, size: 10 }))
        : []),
      { text: '', gap: 8 },
      ...PdfBuilder.wrap('A machine-readable version of everything here travels alongside this PDF as a .json file, with the transcript timings, every practice question attempted, and the explainer content as structure.', 10).map(text => ({ text, size: 10 })),
    ]);

    return b.build();
  }

  /** Set by the exporter so the PDF can print an outline instead of source. */
  outlines: Map<string, string> = new Map();
  private outlineFor(name: string): string | null { return this.outlines.get(name) ?? null; }

  suggestedFilename(): string {
    const who = (this.meta.student || this.meta.room || 'class').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
    const d = new Date(this.startedAt);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `class-pack-${who}-${date}.pdf`;
  }
}

/**
 * Last-resort readable text from an HTML document.
 *
 * Used only when the exporter could not produce a real outline (the page was
 * never rendered, so its DOM was never available). Strips the two things that
 * made the old packs unreadable — the stylesheet and the scripts — rather than
 * pasting them in and hoping the reader scrolls past.
 */
export function stripToText(html: string): string {
  return (html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function kv(label: string, value: string): TextLine[] {
  return [{ text: `${label}: ${value}`, size: 10 }];
}

function kindLabel(kind: Artifact['kind']): string {
  return kind === 'lesson' ? 'Lesson page'
    : kind === 'explanation' ? 'Explainer'
    : kind === 'image' ? 'Image'
    : kind === 'pdf' ? 'Worksheet'
    : 'Video';
}

/** ms → "12:03" from the start of the lesson. */
export function stamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function humanDuration(ms: number): string {
  // Test on the raw milliseconds: rounding first turns 30s into "1 minute",
  // because Math.round(0.5) is 1.
  if (ms < 60_000) return 'under a minute';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Split lines into page-sized chunks so text never runs off the bottom. */
export function paginate<T>(lines: T[], perPage: number): T[][] {
  if (lines.length === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i < lines.length; i += perPage) out.push(lines.slice(i, i + perPage));
  return out;
}
