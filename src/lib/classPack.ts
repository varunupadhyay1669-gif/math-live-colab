import { PdfBuilder, dataUrlToBytes, type TextLine, type PdfImage } from './pdf';
import { mergeTranscript, type NarrationLine } from './narration';

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

export class ClassPack {
  readonly startedAt = Date.now();
  private snapshots: Snapshot[] = [];
  private artifacts: Artifact[] = [];
  private moments: Moment[] = [];
  private lastSnapshotAt = 0;
  private lastSignature = '';
  private narration: NarrationLine[] = [];
  private lessonStates: LessonState[] = [];
  private lastLessonText = '';

  meta: { room: string; teacher: string; student?: string; topic?: string } = { room: '', teacher: '' };

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
  offerImage(dataUrl: string, width: number, height: number, label: string, opts: { force?: boolean } = {}): boolean {
    const now = Date.now();
    if (!opts.force && now - this.lastSnapshotAt < MIN_SNAPSHOT_GAP_MS) return false;
    if (!dataUrl || dataUrl.length < 64) return false;
    const signature = `${dataUrl.length}:${dataUrl.slice(2000, 2200)}`;
    if (!opts.force && signature === this.lastSignature) return false;
    this.lastSignature = signature;
    this.lastSnapshotAt = now;
    if (this.snapshots.length >= MAX_SNAPSHOTS) this.snapshots.shift();
    this.snapshots.push({ t: this.since(), dataUrl, width, height, label });
    return true;
  }

  offerSnapshot(canvas: HTMLCanvasElement, label: string, opts: { force?: boolean } = {}): boolean {
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
    // Cheap change check: sample the encoded string rather than the pixels.
    const signature = `${dataUrl.length}:${dataUrl.slice(2000, 2200)}`;
    if (!opts.force && signature === this.lastSignature) return false;
    this.lastSignature = signature;
    this.lastSnapshotAt = now;
    if (this.snapshots.length >= MAX_SNAPSHOTS) this.snapshots.shift();
    this.snapshots.push({ t: this.since(), dataUrl, width: canvas.width, height: canvas.height, label });
    return true;
  }

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
      const body = PdfBuilder.wrap(a.body, 7.5).map((text) => ({ text, size: 7.5 }));
      const pages = paginate(body, 62);
      pages.forEach((chunk, i) => b.addTextPage(i === 0 ? [...head, ...chunk] : [
        { text: `${a.name} (continued)`, size: 9, bold: true }, ...chunk,
      ]));
    }

    // ── The board, in order ──
    for (const s of this.snapshots) {
      let image: PdfImage;
      try {
        image = { jpeg: dataUrlToBytes(s.dataUrl), width: s.width, height: s.height };
      } catch { continue; }
      b.addImagePage(image, `${s.label} — ${stamp(s.t)}`, `Board as it stood ${stamp(s.t)} into the lesson.`);
    }

    return b.build();
  }

  suggestedFilename(): string {
    const who = (this.meta.student || this.meta.room || 'class').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40);
    const d = new Date(this.startedAt);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `class-pack-${who}-${date}.pdf`;
  }
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
