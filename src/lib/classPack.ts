import { PdfBuilder, dataUrlToBytes, type TextLine, type PdfImage } from './pdf';

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

/** How different two board snapshots must be before another is worth keeping. */
const MIN_SNAPSHOT_GAP_MS = 20_000;
const MAX_SNAPSHOTS = 60;          // ~60 pages of board is already a lot
const MAX_ARTIFACTS = 40;
const MAX_MOMENTS = 400;
const MAX_BODY_CHARS = 40_000;     // per artifact, so one huge sim can't dominate

export class ClassPack {
  readonly startedAt = Date.now();
  private snapshots: Snapshot[] = [];
  private artifacts: Artifact[] = [];
  private moments: Moment[] = [];
  private lastSnapshotAt = 0;
  private lastSignature = '';

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

  get counts() {
    return { snapshots: this.snapshots.length, artifacts: this.artifacts.length, moments: this.moments.length };
  }

  get isEmpty() {
    return this.snapshots.length === 0 && this.artifacts.length === 0 && this.moments.length === 0;
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
      { text: '', gap: 10 },
      { text: 'How to read this pack', size: 12, bold: true },
      ...PdfBuilder.wrap(
        'The timeline below lists what happened, in order, with a timestamp from the start of the ' +
        'lesson. After it comes the source of every lesson page and explainer that was shown — read ' +
        'these as the material being taught. Finally, each board snapshot appears as its own page, ' +
        'captioned with the time it was taken, so the handwritten working can be followed in sequence.',
        10,
      ).map((text) => ({ text, size: 10 })),
    ];
    b.addTextPage(cover);

    // ── Timeline, paginated ──
    const timelineLines: TextLine[] = [{ text: 'Timeline', size: 16, bold: true }];
    if (this.moments.length === 0) {
      timelineLines.push({ text: 'Nothing was recorded for this session.', size: 10, gap: 6 });
    }
    for (const m of this.moments) {
      for (const [i, line] of PdfBuilder.wrap(`${stamp(m.t)}  ${m.text}`, 10).entries()) {
        timelineLines.push({ text: i === 0 ? line : '        ' + line, size: 10 });
      }
    }
    for (const chunk of paginate(timelineLines, 44)) b.addTextPage(chunk);

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
