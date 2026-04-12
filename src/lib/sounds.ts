/**
 * Sound effects for MathsLive using Web Audio API.
 * No external dependencies — self-contained audio synthesis.
 */

let audioCtx: AudioContext | null = null;
let masterVolume = 0.3;
let muted = false;

function getContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

function getGain(): GainNode {
  const ctx = getContext();
  const gain = ctx.createGain();
  gain.gain.value = muted ? 0 : masterVolume;
  gain.connect(ctx.destination);
  return gain;
}

/** Play a pure tone with optional envelope */
function playTone(freq: number, duration: number, type: OscillatorType = 'sine', volume = 1) {
  try {
    const ctx = getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime((muted ? 0 : masterVolume) * volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {}
}

/** Play a chord (multiple tones) */
function playChord(freqs: number[], duration: number, type: OscillatorType = 'sine') {
  freqs.forEach((f, i) => {
    setTimeout(() => playTone(f, duration, type, 0.6), i * 30);
  });
}

export const sounds = {
  /** Gentle chime — student joins */
  join() {
    playTone(880, 0.15, 'sine');
    setTimeout(() => playTone(1100, 0.2, 'sine'), 100);
  },

  /** Alert tone — raise hand */
  raiseHand() {
    playTone(660, 0.1, 'triangle');
    setTimeout(() => playTone(880, 0.1, 'triangle'), 80);
    setTimeout(() => playTone(1100, 0.15, 'triangle'), 160);
  },

  /** Alarm — timer ending */
  timerEnd() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => playTone(800, 0.15, 'square', 0.3), i * 200);
    }
  },

  /** Party horn — celebration */
  celebration() {
    playChord([523, 659, 784], 0.3, 'triangle');
    setTimeout(() => playChord([587, 740, 880], 0.4, 'triangle'), 200);
  },

  /** Success ding — correct answer */
  success() {
    playTone(523, 0.08, 'sine');
    setTimeout(() => playTone(659, 0.08, 'sine'), 60);
    setTimeout(() => playTone(784, 0.15, 'sine'), 120);
  },

  /** Error buzz — wrong answer */
  error() {
    playTone(200, 0.2, 'square', 0.2);
  },

  /** Subtle tick — button click */
  tick() {
    playTone(1200, 0.03, 'sine', 0.4);
  },

  /** Chat message received */
  message() {
    playTone(600, 0.05, 'sine', 0.3);
    setTimeout(() => playTone(800, 0.08, 'sine', 0.3), 50);
  },

  // ── Volume Controls ──
  setVolume(v: number) {
    masterVolume = Math.max(0, Math.min(1, v));
  },

  getVolume(): number {
    return masterVolume;
  },

  toggleMute(): boolean {
    muted = !muted;
    return muted;
  },

  isMuted(): boolean {
    return muted;
  },
};
