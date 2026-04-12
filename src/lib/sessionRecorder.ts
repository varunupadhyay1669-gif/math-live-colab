/**
 * SessionRecorder — records all socket events with timestamps for playback.
 */

interface RecordedEvent {
  timestamp: number;
  type: string;
  data: unknown;
}

export class SessionRecorder {
  private events: RecordedEvent[] = [];
  private startTime: number = 0;
  private isRecording: boolean = false;

  start() {
    this.events = [];
    this.startTime = Date.now();
    this.isRecording = true;
  }

  stop() {
    this.isRecording = false;
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

  record(type: string, data: unknown) {
    if (!this.isRecording) return;
    this.events.push({
      timestamp: Date.now() - this.startTime,
      type,
      data,
    });
  }

  export(): string {
    return JSON.stringify({
      version: 1,
      startTime: this.startTime,
      totalDuration: this.duration,
      eventCount: this.events.length,
      events: this.events,
    }, null, 2);
  }

  download(filename?: string) {
    const blob = new Blob([this.export()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `mathslive-session-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
