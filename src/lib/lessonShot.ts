// A picture of the lesson as the student saw it — the HTML page WITH the ink
// drawn on top of it.
//
// The class pack had the board but not this, and explaining over an HTML lesson
// is half of what happens in a class. The lesson page's own text is already
// captured (a model reads that better than pixels), but text alone loses where
// the teacher circled, underlined and pointed — which is exactly the bit that
// carries the teaching.
//
// The lesson lives in a same-origin iframe, so its document can be rasterised.
// html2canvas is loaded ONLY when a shot is actually taken, so a teacher who
// never opens the class pack never downloads it.

export interface LessonShot {
  dataUrl: string;
  width: number;
  height: number;
}

/** Cap the rendered pixels: a tall lesson page can be enormous. */
const MAX_W = 1400;
const MAX_H = 1800;

let loader: Promise<typeof import('html2canvas')['default']> | null = null;
function loadRenderer() {
  if (!loader) {
    loader = import('html2canvas')
      .then(m => m.default)
      .catch((e) => { loader = null; throw e; });
  }
  return loader;
}

/**
 * Rasterise the lesson iframe and composite the annotation ink over it.
 *
 * Returns null rather than throwing: a failed screenshot must never interrupt
 * a lesson, and the pack is still worth having without this one frame.
 */
export async function captureLesson(
  iframe: HTMLIFrameElement | null,
  inkCanvas: HTMLCanvasElement | null,
): Promise<LessonShot | null> {
  try {
    const doc = iframe?.contentDocument;
    const body = doc?.body;
    if (!iframe || !doc || !body) return null;

    const win = iframe.contentWindow;
    // Measure the DOCUMENT's own viewport, not the iframe element's box. The
    // preview is zoomable, and under a CSS transform the element rect is the
    // scaled size while the page inside still lays out at its own width — so
    // sizing from the rect would crop or letterbox the shot.
    const rect = iframe.getBoundingClientRect();
    const viewW = Math.max(1, Math.round(win?.innerWidth || rect.width));
    const viewH = Math.max(1, Math.round(win?.innerHeight || rect.height));
    if (viewW < 8 || viewH < 8) return null;      // not laid out / not on screen

    const html2canvas = await loadRenderer();
    // Only the part that is actually VISIBLE. A lesson that scrolls for pages
    // would otherwise produce one giant image of mostly-unseen content, when
    // what matters is what was on screen while it was being explained.
    const scrollX = win?.scrollX || 0;
    const scrollY = win?.scrollY || 0;
    const shot = await html2canvas(body, {
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
      allowTaint: false,        // a tainted canvas cannot be read back at all
      scale: 1,
      x: scrollX,
      y: scrollY,
      width: viewW,
      height: viewH,
      windowWidth: viewW,
      windowHeight: viewH,
      scrollX: -scrollX,
      scrollY: -scrollY,
      // Skip our own overlays if they ever end up inside the lesson document.
      ignoreElements: (el) => el.id === 'mathslive-mirror-head',
    });

    // Composite: page first, then the ink exactly as it sat over it.
    const out = document.createElement('canvas');
    const scale = Math.min(1, MAX_W / shot.width, MAX_H / shot.height);
    out.width = Math.max(1, Math.round(shot.width * scale));
    out.height = Math.max(1, Math.round(shot.height * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(shot, 0, 0, out.width, out.height);
    if (inkCanvas && inkCanvas.width > 0 && inkCanvas.height > 0) {
      // The ink canvas covers the same on-screen rectangle as the iframe, so
      // stretching it to the output matches the two coordinate spaces.
      ctx.drawImage(inkCanvas, 0, 0, out.width, out.height);
    }

    const dataUrl = out.toDataURL('image/jpeg', 0.72);
    if (!dataUrl || dataUrl.length < 64) return null;
    return { dataUrl, width: out.width, height: out.height };
  } catch {
    return null;   // never let a screenshot break a lesson
  }
}

/**
 * Downscale a photo before it enters a class pack.
 *
 * A phone picture of a worksheet is several megabytes at a resolution nobody
 * reads at. Capping the long edge keeps the page legible while keeping the
 * archive small enough to actually upload.
 */
export async function shrinkImage(file: File, maxEdge = 1600, quality = 0.78):
  Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas context');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return { dataUrl: canvas.toDataURL('image/jpeg', quality), width: w, height: h };
}
