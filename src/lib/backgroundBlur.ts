// ─────────────────────────────────────────────────────────────────────────
// Background blur for the video call.
//
// Browsers can do this natively via a `backgroundBlur` track constraint, but
// only on some platforms — VideoCall feature-detects that first and only falls
// back here when it is missing. Doing it ourselves means actually separating
// the person from the background, which needs a segmentation model.
//
// Cost is deliberately deferred: the model and its WebAssembly runtime (~12MB)
// are fetched from a CDN the FIRST time someone turns blur on, never at page
// load, and the whole module is dynamically imported so it stays out of the
// main bundle. If the download is blocked (some school networks), blur simply
// reports that it is unavailable and the plain camera keeps working.
//
// Pipeline per frame: segment → draw a blurred copy of the frame → draw the
// person back on top at full sharpness, using the mask as their alpha.
// ─────────────────────────────────────────────────────────────────────────

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';

export type BlurStrength = 'light' | 'strong';
const BLUR_PX: Record<BlurStrength, number> = { light: 6, strong: 14 };

export type BlurHandle = {
  /** The processed stream to send in place of the raw camera. */
  stream: MediaStream;
  /** Change strength without rebuilding the model. */
  setStrength: (s: BlurStrength) => void;
  /** Tear down the loop, the canvas and the model. */
  stop: () => void;
};

let segmenterPromise: Promise<any> | null = null;

/** Loaded once per page and reused — the model download is the expensive part. */
async function getSegmenter(): Promise<any> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision: any = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
      return vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })().catch(err => {
      segmenterPromise = null;      // let a later attempt retry
      throw err;
    });
  }
  return segmenterPromise;
}

/**
 * Wrap a camera stream so its background is blurred.
 * Throws if the model cannot be loaded — the caller should fall back to the
 * unprocessed camera and say so.
 */
export async function createBlurredStream(
  source: MediaStream,
  strength: BlurStrength = 'strong',
): Promise<BlurHandle> {
  const track = source.getVideoTracks()[0];
  if (!track) throw new Error('no camera track to blur');

  const segmenter = await getSegmenter();

  const settings = track.getSettings();
  const w = settings.width || 640;
  const h = settings.height || 480;

  // Hidden <video> to pull frames from — a track alone can't be drawn.
  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true; video.muted = true;
  video.srcObject = new MediaStream([track]);
  await video.play().catch(() => { /* muted autoplay is permitted */ });

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d')!;

  // Scratch canvas holding the person with a transparent background.
  const person = document.createElement('canvas');
  person.width = w; person.height = h;
  const pctx = person.getContext('2d', { willReadFrequently: true })!;

  let current: BlurStrength = strength;
  let running = true;
  let raf = 0;

  const frame = () => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (video.readyState < 2) return;
    try {
      const result = segmenter.segmentForVideo(video, performance.now());
      const mask = result?.categoryMask;

      // 1) blurred backdrop
      octx.save();
      octx.filter = `blur(${BLUR_PX[current]}px)`;
      octx.drawImage(video, 0, 0, w, h);
      octx.restore();

      if (mask) {
        // 2) the person, with the mask as their alpha channel
        pctx.drawImage(video, 0, 0, w, h);
        const img = pctx.getImageData(0, 0, w, h);
        const m = mask.getAsUint8Array();
        const data = img.data;
        for (let i = 0, p = 3; i < m.length; i++, p += 4) {
          // selfie_segmenter: 0 = person, non-zero = background
          data[p] = m[i] === 0 ? 255 : 0;
        }
        pctx.putImageData(img, 0, 0);
        octx.drawImage(person, 0, 0);
        mask.close?.();
      }
    } catch {
      // A dropped frame must never kill the call — the next tick retries.
    }
  };
  raf = requestAnimationFrame(frame);

  const stream = out.captureStream(24);
  return {
    stream,
    setStrength: (s) => { current = s; },
    stop: () => {
      running = false;
      cancelAnimationFrame(raf);
      stream.getTracks().forEach(t => { try { t.stop(); } catch { /* noop */ } });
      video.srcObject = null;
    },
  };
}
