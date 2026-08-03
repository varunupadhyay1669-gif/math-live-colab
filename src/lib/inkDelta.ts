// Deciding which board frames are worth keeping, and what is new in them.
//
// The exporter used to fire on a timer and keep anything whose JPEG bytes
// differed. A page nudged by a few pixels re-encodes differently, so runs of
// four near-identical frames survived while every caption read the same, and a
// reader had no way to tell which frames contained new writing without opening
// all sixty.
//
// Two pieces fix that, and both are pure so they can be tested without a canvas:
//   - a perceptual hash, so "the same board scrolled slightly" is recognised as
//     the same board;
//   - a stroke diff, so "what is new" is answered from the vector ink itself
//     rather than by thresholding a pixel difference.

export interface StrokeLike {
  id?: string;
  points: Array<{ x: number; y: number }>;
  width?: number;
  tool?: string;
}

export interface ViewLike {
  boardScale: number;
  boardOffsetX: number;
  boardOffsetY: number;
}

export type Rect = [number, number, number, number];   // x0, y0, x1, y1

// ── Perceptual hash ─────────────────────────────────────────────────────────

export const HASH_SIZE = 8;   // 8×8 = 64 bits, the classic average hash

/**
 * Average hash from a grid of luma samples. Bits are set where a cell is
 * brighter than the mean, which is stable under small shifts, re-encoding and
 * JPEG noise — the three things that defeated the old byte comparison.
 */
export function averageHash(luma: ArrayLike<number>): string {
  const n = luma.length;
  if (!n) return '';
  let sum = 0;
  for (let i = 0; i < n; i++) sum += luma[i];
  const mean = sum / n;
  let bits = '';
  for (let i = 0; i < n; i++) bits += luma[i] > mean ? '1' : '0';
  return bits;
}

export function hammingDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Close enough to call it the same board.
 *
 * The threshold is deliberately tight. Missing a frame is worse than keeping a
 * near-duplicate: the acceptance case is a tutor crossing out one inequality and
 * writing another, and both of those frames must survive. A handful of differing
 * bits is a scroll or a cursor; a correction moves many more.
 */
export function isNearDuplicate(a: string, b: string, threshold = 4): boolean {
  return hammingDistance(a, b) <= threshold;
}

/** Reduce an RGBA buffer to a HASH_SIZE² luma grid by box-averaging. */
export function lumaGrid(rgba: ArrayLike<number>, width: number, height: number, size = HASH_SIZE): number[] {
  const out: number[] = [];
  if (!width || !height) return out;
  const cw = width / size;
  const ch = height / size;
  for (let gy = 0; gy < size; gy++) {
    for (let gx = 0; gx < size; gx++) {
      const x0 = Math.floor(gx * cw), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cw));
      const y0 = Math.floor(gy * ch), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * ch));
      let sum = 0, count = 0;
      for (let y = y0; y < y1 && y < height; y++) {
        for (let x = x0; x < x1 && x < width; x++) {
          const i = (y * width + x) * 4;
          // Rec. 601 luma — good enough, and cheap.
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          count++;
        }
      }
      out.push(count ? sum / count : 0);
    }
  }
  return out;
}

// ── What is new on the board ────────────────────────────────────────────────

/** Strokes present now that were not present at the last snapshot. */
export function newStrokesSince(previousIds: Set<string>, strokes: StrokeLike[]): StrokeLike[] {
  return (strokes || []).filter(s => s && s.id && !previousIds.has(s.id));
}

/** Bounding box of some strokes, in board coordinates, padded by pen width. */
export function strokeBounds(strokes: StrokeLike[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let any = false;
  for (const s of strokes || []) {
    const pad = Math.max(2, (s?.width || 2) / 2);
    for (const p of s?.points || []) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      any = true;
      if (p.x - pad < x0) x0 = p.x - pad;
      if (p.y - pad < y0) y0 = p.y - pad;
      if (p.x + pad > x1) x1 = p.x + pad;
      if (p.y + pad > y1) y1 = p.y + pad;
    }
  }
  return any ? [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)] : null;
}

/** Board rect → on-screen pixels, using the same transform the board renders with. */
export function boardRectToScreen(rect: Rect, view: ViewLike): Rect {
  const s = view?.boardScale || 1;
  const ox = view?.boardOffsetX || 0;
  const oy = view?.boardOffsetY || 0;
  return [
    Math.round(rect[0] * s + ox),
    Math.round(rect[1] * s + oy),
    Math.round(rect[2] * s + ox),
    Math.round(rect[3] * s + oy),
  ];
}

/**
 * Grow a crop so the correction is readable in context, and keep it inside the
 * frame. A tight crop of "x >= -18" with no surrounding working is not much use
 * to a reader trying to see what changed.
 */
export function padRect(rect: Rect, pad: number, maxW: number, maxH: number): Rect {
  return [
    Math.max(0, Math.round(rect[0] - pad)),
    Math.max(0, Math.round(rect[1] - pad)),
    Math.min(maxW, Math.round(rect[2] + pad)),
    Math.min(maxH, Math.round(rect[3] + pad)),
  ];
}

/**
 * Crop a frame to a rectangle — the "ink delta image" a reader opens to see
 * exactly what was added, without hunting for it in a full board.
 *
 * A crop rather than a re-render of just the new strokes: the correction only
 * makes sense beside the working it corrects, and this keeps that context.
 */
export function cropCanvas(source: HTMLCanvasElement, rect: Rect, quality = 0.75): string | null {
  try {
    const w = Math.max(1, rect[2] - rect[0]);
    const h = Math.max(1, rect[3] - rect[1]);
    if (w < 4 || h < 4) return null;
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, rect[0], rect[1], w, h, 0, 0, w, h);
    const url = out.toDataURL('image/jpeg', quality);
    return url && url.length > 64 ? url : null;
  } catch {
    return null;
  }
}
