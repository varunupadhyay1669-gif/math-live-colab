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
  /** Last time the engine proved it was alive (a result, or a clean end). */
  private lastAlive = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lang = 'en-GB';
  /** Set only when the user (or their browser) refused the microphone. */
  denied = false;

  constructor(onLine: Listener) { this.onLine = onLine; }

  get running() { return this.wantRunning; }
  /** ms since the engine last showed a sign of life. */
  get quietFor() { return this.lastAlive ? Date.now() - this.lastAlive : 0; }

  start(lang = 'en-GB'): boolean {
    const Rec = getRecogniser();
    if (!Rec) return false;
    if (this.wantRunning) return true;
    this.lang = lang;
    this.wantRunning = true;
    this.lastAlive = Date.now();
    // Nothing about a lesson should depend on the engine behaving. Browsers
    // end continuous recognition on their own, drop it on a network blip, and
    // occasionally stop firing without ever calling onend — all silently. A
    // teacher mid-explanation will not notice, and the context is simply gone.
    // So: check every 15s that it is still alive, and rebuild it if not.
    if (!this.watchdog) {
      this.watchdog = setInterval(() => {
        if (!this.wantRunning || this.denied) return;
        if (this.quietFor > 45_000) this.revive();
      }, 15_000);
    }
    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = false;      // only settled text — interim lines churn badly
    rec.lang = lang;
    rec.onresult = (e: any) => {
      this.lastAlive = Date.now();
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r || !r.isFinal) continue;
        const text = String(r[0]?.transcript || '').trim();
        if (text) this.onLine(text);
      }
    };
    rec.onerror = (e: any) => {
      // 'no-speech' and 'aborted' are routine in a quiet classroom, and
      // 'network' happens on any wobble — none of them should end the lesson's
      // record. Only an actual refusal of the microphone is final, because
      // retrying that would just nag.
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
        this.denied = true;
        this.stop();
        return;
      }
      this.lastAlive = Date.now();   // it spoke to us, so it is still there
    };
    // Browsers end a continuous session on their own every minute or so. Keep
    // it alive, but never synchronously — an immediate restart inside onend
    // throws InvalidStateError.
    rec.onend = () => {
      this.lastAlive = Date.now();
      if (!this.wantRunning || this.restarting) return;
      this.restarting = true;
      this.restartTimer = setTimeout(() => {
        this.restarting = false;
        if (!this.wantRunning) return;
        try { rec.start(); } catch { this.revive(); }
      }, 400);
    };
    this.rec = rec;
    try { rec.start(); } catch { this.wantRunning = false; this.rec = null; return false; }
    return true;
  }

  /** Throw away a wedged engine and build a fresh one. */
  private revive() {
    if (!this.wantRunning || this.denied) return;
    const old = this.rec;
    this.rec = null;
    // Detach first: a dying instance can still fire onend and start a race
    // between the old restart timer and this rebuild.
    if (old) { old.onend = null; old.onresult = null; old.onerror = null; try { old.abort(); } catch { /* gone */ } }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.restarting = false;
    this.wantRunning = false;      // so start() doesn't early-return
    this.start(this.lang);
  }

  stop() {
    this.wantRunning = false;
    this.restarting = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
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

// ── Remembering the decision ──
// Asking again every lesson is how a feature ends up switched off forever. A
// choice is remembered per room: the teacher's preference, and the student's
// consent. Either can be changed at any time from the on-air indicator.

const KEY = 'mathslive:narration';

function readPrefs(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export function getNarrationChoice(roomId: string): 'yes' | 'no' | null {
  const v = readPrefs()[roomId || ''];
  return v === 'yes' || v === 'no' ? v : null;
}

export function setNarrationChoice(roomId: string, choice: 'yes' | 'no') {
  try {
    const prefs = readPrefs();
    prefs[roomId || ''] = choice;
    // Keep it small: a tutor with hundreds of rooms should not carry them all.
    const keys = Object.keys(prefs);
    if (keys.length > 100) delete prefs[keys[0]];
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { /* private mode — we simply ask again next time */ }
}
