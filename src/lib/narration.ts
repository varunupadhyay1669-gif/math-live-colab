// What was actually SAID in the lesson, as timestamped text.
//
// The obvious approach — record audio — is the wrong one here. The whole point
// is to hand the lesson to a language model, and a model wants a transcript it
// can read, not a .webm it may not accept and cannot line up with the board.
// Text also keeps the pack a single file, costs nothing to store, and never
// puts a child's voice on a server.
//
// So each device transcribes its OWN microphone using the browser's built-in
// recogniser and relays short lines of text. The teacher's copy merges both
// sides into one timeline alongside the board snapshots and the materials.
//
// This is off until switched on, and the student is asked before their device
// starts listening — see the consent flow in StudentView.

export interface NarrationLine {
  /** ms since the pack started. */
  t: number;
  speaker: string;
  text: string;
}

type Listener = (text: string) => void;

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
}

function getRecogniser(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition || w.webkitSpeechRecognition) as (new () => SpeechRecognitionLike) | null;
}

/** Can this browser turn speech into text at all? Safari/iOS cannot. */
export function narrationSupported(): boolean {
  return typeof window !== 'undefined' && !!getRecogniser();
}

export class Narrator {
  private rec: SpeechRecognitionLike | null = null;
  private wantRunning = false;
  private onLine: Listener;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while a restart is pending so a burst of `onend` can't stack timers. */
  private restarting = false;

  constructor(onLine: Listener) { this.onLine = onLine; }

  get running() { return this.wantRunning; }

  start(lang = 'en-GB'): boolean {
    const Rec = getRecogniser();
    if (!Rec) return false;
    if (this.wantRunning) return true;
    this.wantRunning = true;
    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = false;      // only settled text — interim lines churn badly
    rec.lang = lang;
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r || !r.isFinal) continue;
        const text = String(r[0]?.transcript || '').trim();
        if (text) this.onLine(text);
      }
    };
    rec.onerror = (e: any) => {
      // 'no-speech' and 'aborted' are routine in a quiet classroom; only a
      // permission refusal is worth giving up over.
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') this.stop();
    };
    // Browsers end a continuous session on their own every minute or so. Keep
    // it alive, but never synchronously — an immediate restart inside onend
    // throws InvalidStateError.
    rec.onend = () => {
      if (!this.wantRunning || this.restarting) return;
      this.restarting = true;
      this.restartTimer = setTimeout(() => {
        this.restarting = false;
        if (!this.wantRunning) return;
        try { rec.start(); } catch { /* already going, or gone */ }
      }, 400);
    };
    this.rec = rec;
    try { rec.start(); } catch { this.wantRunning = false; this.rec = null; return false; }
    return true;
  }

  stop() {
    this.wantRunning = false;
    this.restarting = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    try { this.rec?.stop(); } catch { /* not started */ }
    this.rec = null;
  }
}

/**
 * Merge the two sides' lines into one readable script.
 *
 * Lines arrive from two devices whose clocks are their own, so they are ordered
 * by the timestamp each side recorded against the shared session start. Runs by
 * the same speaker are joined into a paragraph — "Varun: so if we take away
 * eight…" reads like a lesson, whereas one line per utterance reads like noise.
 */
export function mergeTranscript(lines: NarrationLine[], joinWithinMs = 12_000): NarrationLine[] {
  const sorted = [...(lines || [])].filter(l => l && l.text).sort((a, b) => a.t - b.t);
  const out: NarrationLine[] = [];
  for (const line of sorted) {
    const last = out[out.length - 1];
    if (last && last.speaker === line.speaker && line.t - last.t < joinWithinMs) {
      last.text += ' ' + line.text;
    } else {
      out.push({ ...line });
    }
  }
  return out;
}
