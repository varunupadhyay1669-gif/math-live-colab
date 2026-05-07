/**
 * SessionRecorder — records all socket events with timestamps for playback.
 */

interface RecordedEvent {
  timestamp: number;
  type: string;
  data: unknown;
}

// AUTONOMOUS: Cap and recovery behaviour.
//
// Before this change, `events` grew without bound for as long as the
// teacher had Record on. A 90-min lesson can easily produce 100k+
// entries (server rate limits to 200/sec, teacher nowhere near that, but
// long sessions add up); the singleton survived component unmounts
// because it's a module-level object. Closing the tab mid-recording
// silently lost everything — only `download()` saves, and beforeunload
// can't reliably trigger a file download.
//
// Now: bounded ring buffer (FIFO), and a periodic autosave to
// localStorage so a tab close / browser crash leaves a recoverable
// blob behind. Recovery is opt-in: the next time start() runs we
// surface any pending recording so the user can choose to download it.

const MAX_EVENTS = 50_000;            // ~5MB JSON in worst case
const AUTOSAVE_INTERVAL_MS = 30_000;  // every 30s while recording
const STORAGE_KEY = 'mathlive:lastRecording';

interface SerializedRecording {
  version: number;
  startTime: number;
  totalDuration: number;
  eventCount: number;
  truncated: boolean;
  events: RecordedEvent[];
}

function safeWriteStorage(value: string) {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // private mode / quota exceeded — silently no-op. Worst case the
    // user loses recovery on this device, but the live recording in
    // memory continues to work.
  }
}

function safeReadStorage(): string | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

function safeClearStorage() {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export class SessionRecorder {
  private events: RecordedEvent[] = [];
  private startTime: number = 0;
  private isRecording: boolean = false;
  private truncated: boolean = false;
  private autosaveTimer: ReturnType<typeof setInterval> | null = null;

  start() {
    this.events = [];
    this.startTime = Date.now();
    this.isRecording = true;
    this.truncated = false;
    // Periodic autosave so a crash / accidental close leaves a recoverable
    // recording in localStorage. We still encourage the explicit download()
    // for canonical export.
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    this.autosaveTimer = setInterval(() => this.autosave(), AUTOSAVE_INTERVAL_MS);
  }

  stop() {
    this.isRecording = false;
    if (this.autosaveTimer) {
      clearInterval(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    // Final autosave on stop — covers the gap between the last interval
    // tick and the actual stop.
    this.autosave();
  }

  get recording(): boolean {
    return this.isRecording;
  }

  get eventCount(): number {
    return this.events.length;
  }

  get duration(): number {
    if (this.events.length === 0) return 0;
    return this.events[this.events.length - 1].timestamp;
  }

  /** Was the recording capped (oldest events dropped)? */
  get isTruncated(): boolean {
    return this.truncated;
  }

  record(type: string, data: unknown) {
    if (!this.isRecording) return;
    this.events.push({
      timestamp: Date.now() - this.startTime,
      type,
      data,
    });
    if (this.events.length > MAX_EVENTS) {
      // FIFO drop the oldest. Mark as truncated so the user knows the
      // exported file isn't a complete record.
      this.events = this.events.slice(-MAX_EVENTS);
      this.truncated = true;
    }
  }

  /**
   * Snapshot the recording into localStorage so a tab close / crash
   * leaves a recoverable blob. Best-effort: silently skips on quota /
   * private mode.
   */
  autosave() {
    if (!this.isRecording || this.events.length === 0) return;
    safeWriteStorage(this.export());
  }

  /**
   * Returns a previously-autosaved recording (from a prior session that
   * ended without an explicit download), or null if none exists.
   * Caller can prompt the user to download it then call clearAutosaved.
   */
  getAutosavedRecording(): SerializedRecording | null {
    const raw = safeReadStorage();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as SerializedRecording;
      if (parsed && Array.isArray(parsed.events)) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  clearAutosaved() {
    safeClearStorage();
  }

  export(): string {
    const payload: SerializedRecording = {
      version: 1,
      startTime: this.startTime,
      totalDuration: this.duration,
      eventCount: this.events.length,
      truncated: this.truncated,
      events: this.events,
    };
    return JSON.stringify(payload, null, 2);
  }

  download(filename?: string) {
    const blob = new Blob([this.export()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `mathslive-session-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    // Once the user has explicitly downloaded, drop the autosave —
    // they have the canonical file now and don't need the recovery copy.
    this.clearAutosaved();
  }

  async playback(emit: (type: string, data: unknown) => void): Promise<void> {
    let lastTimestamp = 0;
    for (const event of this.events) {
      const delay = event.timestamp - lastTimestamp;
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
      emit(event.type, event.data);
      lastTimestamp = event.timestamp;
    }
  }
}

// Global singleton
export const sessionRecorder = new SessionRecorder();
