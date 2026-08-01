import React, { useRef, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';

interface AnnotationLayerProps {
  socket: Socket | null;
  roomId: string;
  // Mode control (existing)
  drawMode: boolean;
  laserMode: boolean;
  penType: 'transient' | 'permanent';
  penColor: string;
  penWidth: number;
  // For passthrough scrolling
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  // Interactive (teacher can draw) vs view-only (student watches)
  interactive: boolean;
  // Laser pointer state for display
  laserPointer?: { x: number; y: number; active: boolean };
  // ── Eraser tool (Phase 31)
  // Off by default. When on, takes precedence over drawMode/laserMode.
  // 'stroke' = click on a stroke to delete it (and drag to delete more);
  // 'pixel'  = drag to "paint" an erase path that cuts through ink already
  //            on the overlay (destination-out compositing).
  eraserMode?: 'off' | 'stroke' | 'pixel';
  // Eraser width — pixel eraser uses this directly; stroke eraser uses it
  // as the click hit radius.
  eraserWidth?: number;
  // ── Shape tool (Phase 32)
  // Off by default. When set, takes precedence over draw/laser/eraser.
  // Click and drag to commit a shape stroke using the current pen colour
  // and width.
  shapeTool?: 'off' | 'line' | 'rect' | 'circle' | 'arrow';
  // ── Initial strokes (annotation persistence)
  // AUTONOMOUS: HTML-overlay annotations are now persisted server-side
  // (room.annotations) and replayed on join via session_state. The
  // page hands us this snapshot the first time room_state lands so a
  // late-joining student doesn't see a blank canvas — they see all
  // the markup the teacher has accumulated so far. Updates after the
  // initial hydration flow through the regular draw_stroke socket
  // events. Each item is the server-side `{ senderId, stroke }` shape;
  // we only read `stroke` for rendering.
  initialAnnotations?: Array<{ senderId: string; stroke: any }>;
  // ── Which surface this ink belongs to
  // 'main' for the lesson, `exp:<id>` for an explanation. There is ONE canvas
  // shared by every surface, so without this, ink drawn on an explanation
  // stayed on screen over the lesson after closing it (measured: 11,467 stray
  // pixels) and vice versa. Strokes carry their surface, and each surface only
  // renders — and only accepts — its own. Strokes saved before this existed
  // have no surface and are treated as the lesson's.
  surface?: string;
}

type ShapeKind = 'shape-line' | 'shape-rect' | 'shape-circle' | 'shape-arrow';
type StrokeKind = 'pen' | 'eraser-pixel' | ShapeKind;

interface StrokeData {
  id?: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
  time: number;
  transient?: boolean;
  // 'pen' (default) — coloured freehand stroke.
  // 'eraser-pixel' — rendered with destination-out so it cuts a hole.
  // 'shape-*' — rendered as a vector shape using the FIRST and LAST entries
  //   in `points` (no need for the rest):
  //     shape-line   — straight line
  //     shape-rect   — rectangle outline (corners = first / last)
  //     shape-circle — circle (centre = first, edge = last; radius = distance)
  //     shape-arrow  — line + arrowhead at last
  kind?: StrokeKind;
  // Iframe scroll position at the moment the stroke was captured. Used at
  // render time to offset the stroke's points by (currentScroll - captureScroll)
  // so the annotation moves with the content when the iframe is scrolled.
  // Without this, strokes stayed pinned to the canvas viewport and "floated"
  // away from whatever the teacher was annotating as soon as the page
  // scrolled — exactly the bug reported.
  // In iframe document pixels. Defaults to 0 for back-compat with old
  // peers that didn't send these (those strokes will appear pinned, like
  // before, but new strokes from updated peers will scroll correctly).
  scrollX?: number;
  scrollY?: number;
}

const newStrokeId = () => `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Does this stroke belong on the surface currently being shown?
 *
 * One canvas is shared by the lesson and every explanation, so this is the only
 * thing stopping ink drawn on one from appearing over another. Exported so the
 * rule is unit-testable rather than three inline comparisons that have to agree.
 *
 * Strokes saved before surfaces existed carry none, and belong to the lesson.
 */
export function belongsToSurface(stroke: { surface?: string } | null | undefined, surface: string): boolean {
  return ((stroke && stroke.surface) || 'main') === (surface || 'main');
}

// AUTONOMOUS: Recognisable eraser cursor (pink/cream rubber-block shape).
// The previous `cell` cursor read as a crosshair/+, completely unrelated to
// erasing. This SVG cursor is the same silhouette as the toolbar icon, so
// the user sees the same shape under their hand as on the button. The
// hot-spot sits at the bottom-tip of the eraser block — that's the point
// where the eraser actually deletes ink, matching real-world expectation.
const ERASER_CURSOR = (() => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M19 13l-7.5 7.5a2 2 0 0 1-2.83 0L4.5 16.33a2 2 0 0 1 0-2.83L13.5 4.5a2 2 0 0 1 2.83 0L19.5 7.67a2 2 0 0 1 0 2.83Z" fill="#FBCFE8" stroke="#9D174D" stroke-width="1.6" stroke-linejoin="round"/><path d="m9 11 4 4" stroke="#9D174D" stroke-width="1.6" stroke-linecap="round"/></svg>';
  return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}') 6 18, cell`;
})();

// Minimum perpendicular distance from a point to a line segment, in
// canvas-pixel space. Used by the per-stroke eraser to decide which
// stroke the click landed on.
function distanceToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export default function AnnotationLayer({
  socket, roomId, drawMode, laserMode, penType, penColor, penWidth,
  iframeRef, interactive, laserPointer,
  eraserMode = 'off', eraserWidth = 18,
  shapeTool = 'off',
  initialAnnotations,
  surface = 'main',
}: AnnotationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentStrokeRef = useRef<Array<{ x: number; y: number }>>([]);
  const strokesRef = useRef<StrokeData[]>([]);
  const isTransientRef = useRef(false);
  const isErasingRef = useRef<false | 'stroke' | 'pixel'>(false);
  const erasedDuringDragRef = useRef<Set<string>>(new Set());
  const isDrawingRef = useRef(false);
  const animFrameRef = useRef<number>();
  const localLaserRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const laserDotRef = useRef<HTMLDivElement>(null);

  const eraserActive = interactive && eraserMode !== 'off';
  const shapeActive = interactive && shapeTool !== 'off';
  const isShapingRef = useRef<false | ShapeKind>(false);
  // Per-author undo/redo for ink drawn OVER the HTML (parity with the
  // whiteboard). We only track THIS user's own committed strokes, so Ctrl+Z
  // never removes a peer's marks. Re-uses the existing draw_delete_stroke /
  // draw_stroke events, so undo/redo reflects on every connected screen.
  const myUndoRef = useRef<StrokeData[]>([]);
  const myRedoRef = useRef<StrokeData[]>([]);

  // Read the iframe's current scroll position. Tolerant of cross-origin /
  // not-yet-loaded iframes — falls back to 0,0 in those cases (which means
  // strokes will simply not scroll, the pre-fix behaviour). The iframe is
  // currently sandboxed with allow-same-origin so contentWindow is
  // accessible; if that ever changes, this gracefully degrades.
  const getIframeScroll = useCallback((): { x: number; y: number } => {
    try {
      const win = iframeRef.current?.contentWindow;
      if (!win) return { x: 0, y: 0 };
      return { x: win.scrollX || 0, y: win.scrollY || 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }, [iframeRef]);

  const getCanvasCoords = useCallback((e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height };
  }, []);

  const renderStrokes = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Premium ink: stroke a smoothed path (quadratic curves through the
    // midpoints of consecutive samples) instead of hard polyline segments,
    // and render a single tap as a clean dot. Same {x,y} wire format.
    const drawSmooth = (pts: Array<{ x: number; y: number }>) => {
      if (pts.length === 0) return;
      if (pts.length === 1) {
        const prevFill = ctx.fillStyle;
        ctx.beginPath();
        ctx.fillStyle = ctx.strokeStyle as string;
        ctx.arc(pts[0].x, pts[0].y, Math.max(0.6, ctx.lineWidth / 2), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = prevFill;
        return;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 2) {
        ctx.lineTo(pts[1].x, pts[1].y);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
        }
        ctx.quadraticCurveTo(pts[pts.length - 2].x, pts[pts.length - 2].y, pts[pts.length - 1].x, pts[pts.length - 1].y);
      }
      ctx.stroke();
    };
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width * 2 || canvas.height !== rect.height * 2) {
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      ctx.scale(2, 2);
    }
    ctx.clearRect(0, 0, rect.width, rect.height);
    const now = Date.now();
    const w = rect.width;
    const h = rect.height;

    // Current iframe scroll. Each stroke was captured with its own scroll
    // baseline; subtracting from the current scroll gives the on-screen
    // pixel offset to apply so the annotation moves with the content.
    const currentScroll = getIframeScroll();

    // Filter expired transient strokes
    strokesRef.current = strokesRef.current.filter(s => {
      if (!s.transient) return true;
      return (now - s.time) < 1000;
    });

    // Render a single shape stroke (line / rect / circle / arrow) using the
    // first and last point in canvas-pixel space.
    const drawShapeStroke = (kind: ShapeKind, p0: { x: number; y: number }, p1: { x: number; y: number }) => {
      const x1 = p0.x * w;
      const y1 = p0.y * h;
      const x2 = p1.x * w;
      const y2 = p1.y * h;
      if (kind === 'shape-line' || kind === 'shape-arrow') {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (kind === 'shape-arrow') {
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const headLen = Math.max(ctx.lineWidth * 4, 12);
          const headAngle = Math.PI / 7;
          ctx.beginPath();
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - headLen * Math.cos(angle - headAngle), y2 - headLen * Math.sin(angle - headAngle));
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 - headLen * Math.cos(angle + headAngle), y2 - headLen * Math.sin(angle + headAngle));
          ctx.stroke();
        }
      } else if (kind === 'shape-rect') {
        const x = Math.min(x1, x2);
        const y = Math.min(y1, y2);
        const rw = Math.abs(x2 - x1);
        const rh = Math.abs(y2 - y1);
        ctx.strokeRect(x, y, rw, rh);
      } else if (kind === 'shape-circle') {
        const r = Math.hypot(x2 - x1, y2 - y1);
        ctx.beginPath();
        ctx.arc(x1, y1, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    strokesRef.current.forEach(stroke => {
      const age = now - stroke.time;
      let alpha = 1;
      let blur = 0;

      if (stroke.transient) {
        const fadeStart = 200;
        const fadeDuration = 800;
        alpha = age > fadeStart ? 1 - (age - fadeStart) / fadeDuration : 1;
        blur = 20;
      }

      if (alpha <= 0) return;

      // Scroll offset for this stroke: how far the iframe has scrolled
      // since the stroke was captured, in CANVAS pixels (which is also
      // iframe viewport pixels, since the canvas is positioned over the
      // iframe at 100% size). Old strokes (no scrollX/Y) → offset 0,
      // identical to the pre-fix behaviour for those.
      const offsetX = currentScroll.x - (stroke.scrollX ?? currentScroll.x);
      const offsetY = currentScroll.y - (stroke.scrollY ?? currentScroll.y);

      ctx.save();
      ctx.globalAlpha = alpha;
      if (stroke.kind === 'eraser-pixel') {
        // Cut a hole in the overlay along this path.
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = '#000';
      } else {
        ctx.strokeStyle = stroke.color;
      }
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (stroke.transient && stroke.kind !== 'eraser-pixel') {
        ctx.shadowColor = stroke.color;
        ctx.shadowBlur = blur;
      } else {
        ctx.shadowBlur = 0;
      }
      // Shape strokes: use first/last only.
      if (stroke.kind === 'shape-line' || stroke.kind === 'shape-rect' || stroke.kind === 'shape-circle' || stroke.kind === 'shape-arrow') {
        if (stroke.points.length >= 2) {
          const a = stroke.points[0];
          const b = stroke.points[stroke.points.length - 1];
          // Apply the scroll offset by translating the points before
          // handing them to drawShapeStroke. We adjust the normalized x/y
          // by the offset's normalized equivalent.
          const aOff = { x: a.x - offsetX / w, y: a.y - offsetY / h };
          const bOff = { x: b.x - offsetX / w, y: b.y - offsetY / h };
          drawShapeStroke(stroke.kind, aOff, bOff);
        }
      } else {
        // Scroll offset: subtract the delta between current scroll and
        // capture-time scroll so the stroke moves with the content.
        drawSmooth(stroke.points.map(p => ({ x: p.x * w - offsetX, y: p.y * h - offsetY })));
      }
      ctx.restore();
    });

    // Current active stroke (live preview)
    if (currentStrokeRef.current.length > 1) {
      ctx.save();
      ctx.globalAlpha = 1;
      const liveErasePixel = isErasingRef.current === 'pixel';
      const liveShape = isShapingRef.current;
      if (liveErasePixel) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = eraserWidth;
      } else {
        ctx.strokeStyle = penColor;
        ctx.lineWidth = penWidth;
        if (!liveShape) {
          ctx.shadowColor = penColor;
          ctx.shadowBlur = 14;
        }
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (liveShape) {
        drawShapeStroke(liveShape, currentStrokeRef.current[0], currentStrokeRef.current[currentStrokeRef.current.length - 1]);
      } else {
        drawSmooth(currentStrokeRef.current.map(p => ({ x: p.x * w, y: p.y * h })));
      }
      ctx.restore();
    }
  }, [penColor, penWidth, eraserWidth, getIframeScroll]);

  // Animation loop
  useEffect(() => {
    let running = true;
    const loop = () => {
      if (!running) return;
      if (strokesRef.current.length > 0 || currentStrokeRef.current.length > 0) renderStrokes();
      animFrameRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      running = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [renderStrokes]);

  // ── Iframe scroll listener ──
  // The iframe's scroll position is read at render-time to offset each
  // stroke. We need to RE-RENDER on every scroll so the strokes follow the
  // content visibly. Attach the listener only when the iframe content
  // window becomes available (it's null until the iframe loads), and tear
  // it down on unmount or iframeRef change.
  useEffect(() => {
    let win: Window | null = null;
    let cleanup: (() => void) | null = null;
    const tryAttach = () => {
      try {
        const candidate = iframeRef.current?.contentWindow ?? null;
        if (!candidate || candidate === win) return;
        // Detach any previous listener first.
        if (cleanup) { cleanup(); cleanup = null; }
        win = candidate;
        const handler = () => renderStrokes();
        candidate.addEventListener('scroll', handler, { passive: true });
        cleanup = () => {
          try { candidate.removeEventListener('scroll', handler); } catch {}
        };
      } catch {
        // Cross-origin or detached — silently no-op. Strokes won't follow
        // scroll in that case but everything else still works.
      }
    };
    // Try immediately and again on iframe load events (the contentWindow
    // is replaced on each navigation / srcdoc change).
    tryAttach();
    const iframe = iframeRef.current;
    iframe?.addEventListener('load', tryAttach);
    // Also poll briefly for the case where the iframe is created lazily;
    // a few RAFs is enough to catch the typical mount race.
    let ticks = 0;
    const tick = setInterval(() => {
      tryAttach();
      if (++ticks >= 20) clearInterval(tick); // give up after ~2s
    }, 100);
    return () => {
      clearInterval(tick);
      iframe?.removeEventListener('load', tryAttach);
      if (cleanup) cleanup();
    };
  }, [iframeRef, renderStrokes]);

  // Receive remote strokes
  // AUTONOMOUS: [iPad fix] - Native non-passive touch listener on the
  // annotation canvas. Same reasoning as the Whiteboard component —
  // iOS Safari can hijack touch as scroll/zoom even with
  // touch-action:none. We only block touch when the canvas is actually
  // accepting input (draw/laser/eraser/shape active) so non-drawing
  // touches pass through to the iframe behind for normal interaction.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const inputActive = interactive && (drawMode || laserMode || eraserActive || shapeActive);
    if (!inputActive) return;
    const blockTouch = (e: TouchEvent) => {
      e.preventDefault();
    };
    canvas.addEventListener('touchstart', blockTouch, { passive: false });
    canvas.addEventListener('touchmove', blockTouch, { passive: false });
    return () => {
      canvas.removeEventListener('touchstart', blockTouch);
      canvas.removeEventListener('touchmove', blockTouch);
    };
  }, [interactive, drawMode, laserMode, eraserActive, shapeActive]);

  // AUTONOMOUS: Hydrate from server-persisted annotations. Fires when
  // the parent hands us a fresh snapshot — initially on join, then on
  // every session_state / sync_full_state. We replace strokesRef
  // wholesale (with server truth) so a late-join student picks up the
  // teacher's prior markup, and a reconnecting client snaps back to
  // the canonical state.
  //
  // A live local stroke that hasn't yet been echoed by the server may
  // be momentarily dropped here, but the next session_state (or the
  // server's broadcast for that very stroke) will restore it. Within
  // ~1 RTT.
  useEffect(() => {
    if (!initialAnnotations) return;
    strokesRef.current = initialAnnotations
      .map(a => a?.stroke)
      .filter(Boolean)
      // Only this surface's ink. Anything saved before surfaces existed has
      // none and belongs to the lesson.
      .filter(s => belongsToSurface(s, surface))
      .map(s => ({
        id: s.id ?? newStrokeId(),
        points: s.points || [],
        color: s.color,
        width: s.width,
        transient: s.transient,
        kind: s.kind,
        time: s.time ?? Date.now(),
        scrollX: s.scrollX,
        scrollY: s.scrollY,
      }));
    renderStrokes();
    // Depend ONLY on initialAnnotations. renderStrokes changes identity on
    // every pen colour/width change; including it here re-ran this hydration on
    // each pen tweak and clobbered strokesRef back to the last server snapshot,
    // wiping everything drawn/received since. The rAF render loop (which does
    // depend on renderStrokes) repaints with the fresh pen state.
    // `surface` IS a dependency: switching to an explanation and back has to
    // repaint from that surface's own ink, not keep the previous surface's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAnnotations, surface]);

  // Switching surface with no snapshot to re-seed from (the common case
  // mid-lesson) still has to wipe the canvas — otherwise the ink from the
  // surface you just left is left hanging over the one you arrived at.
  const firstSurfaceRef = useRef(true);
  useEffect(() => {
    if (firstSurfaceRef.current) { firstSurfaceRef.current = false; return; }
    strokesRef.current = (initialAnnotations || [])
      .map(a => a?.stroke)
      .filter(Boolean)
      .filter(s => belongsToSurface(s, surface))
      .map(s => ({
        id: s.id ?? newStrokeId(), points: s.points || [], color: s.color, width: s.width,
        transient: s.transient, kind: s.kind, time: s.time ?? Date.now(),
        scrollX: s.scrollX, scrollY: s.scrollY,
      }));
    renderStrokes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  useEffect(() => {
    if (!socket) return;
    const handleStroke = (data: { id?: string; points: Array<{ x: number; y: number }>; color: string; width: number; transient?: boolean; kind?: StrokeKind; scrollX?: number; scrollY?: number; surface?: string }) => {
      // Someone drawing on a different surface must not paint on ours.
      if (!belongsToSurface(data, surface)) return;
      strokesRef.current.push({
        id: data.id ?? newStrokeId(),
        points: data.points,
        color: data.color,
        width: data.width,
        transient: data.transient,
        kind: data.kind,
        time: Date.now(),
        scrollX: data.scrollX,
        scrollY: data.scrollY,
      });
      renderStrokes();
    };
    const handleDelete = (data: { strokeId: string }) => {
      strokesRef.current = strokesRef.current.filter(s => s.id !== data.strokeId);
      renderStrokes();
    };
    const handleClear = () => {
      strokesRef.current = [];
      renderStrokes();
    };
    socket.on('draw_stroke', handleStroke);
    socket.on('draw_delete_stroke', handleDelete);
    socket.on('draw_clear', handleClear);
    return () => {
      socket.off('draw_stroke', handleStroke);
      socket.off('draw_delete_stroke', handleDelete);
      socket.off('draw_clear', handleClear);
    };
  }, [socket, renderStrokes, surface]);

  // Per-stroke eraser hit-test. Returns the id of the stroke under the
  // cursor (within tolerance), or null. Operates in canvas-pixel space so
  // the tolerance feels consistent regardless of the canvas' rendered
  // dimensions.
  // AUTONOMOUS: Eraser power-up.
  //
  // Old behaviour: tolerance was Math.max(8, eraserWidth/2) — with the
  // default eraserWidth=18 that's ~9px. Click on a thin stroke missing by
  // 12px → no erase. User clicks again, sometimes hits, sometimes doesn't.
  // "Sometimes works, sometimes doesn't" was a real reliability problem.
  //
  // hitStrokeAt now returns ALL stroke ids whose closest segment is within
  // tolerance — not just the first match. Combined with a generous fixed
  // minimum tolerance (24px), one click reliably bites every stroke under
  // the eraser tip. Drag-erase calls this on every move AND interpolates
  // sub-points along the move segment, so a fast trackpad swipe doesn't
  // skip thin strokes between samples.
  const ERASER_HIT_FLOOR_PX = 24;

  const hitStrokesAt = useCallback((nx: number, ny: number): string[] => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const rect = canvas.getBoundingClientRect();
    const px = nx * rect.width;
    const py = ny * rect.height;
    const tol = Math.max(ERASER_HIT_FLOOR_PX, eraserWidth / 2);
    // Hit-test in the SAME coordinate space the strokes are RENDERED in. Each
    // stroke is drawn offset by how far the iframe has scrolled since it was
    // captured (renderStrokes applies `p.x * w - offsetX`). Without applying
    // the identical offset here, the eraser tests the un-scrolled positions and
    // misses every stroke once the lesson has scrolled.
    const currentScroll = getIframeScroll();
    const hits: string[] = [];
    for (let i = strokesRef.current.length - 1; i >= 0; i--) {
      const stroke = strokesRef.current[i];
      if (stroke.kind === 'eraser-pixel') continue; // can't erase the eraser itself
      if (!stroke.id) continue;
      const offsetX = currentScroll.x - (stroke.scrollX ?? currentScroll.x);
      const offsetY = currentScroll.y - (stroke.scrollY ?? currentScroll.y);
      const half = stroke.width / 2 + tol;
      let hit = false;
      // Single-point strokes (a stroke that started and ended at the same
      // point) have only one entry. Treat that as a circle around the point.
      if (stroke.points.length === 1) {
        const a = stroke.points[0];
        const ax = a.x * rect.width - offsetX;
        const ay = a.y * rect.height - offsetY;
        if (distanceToSegment(px, py, ax, ay, ax, ay) <= half) {
          hit = true;
        }
      } else {
        for (let j = 0; j < stroke.points.length - 1; j++) {
          const a = stroke.points[j];
          const b = stroke.points[j + 1];
          if (distanceToSegment(px, py, a.x * rect.width - offsetX, a.y * rect.height - offsetY, b.x * rect.width - offsetX, b.y * rect.height - offsetY) <= half) {
            hit = true;
            break;
          }
        }
      }
      if (hit) hits.push(stroke.id);
    }
    return hits;
  }, [eraserWidth, getIframeScroll]);

  const eraseStrokeAt = useCallback((nx: number, ny: number) => {
    const ids = hitStrokesAt(nx, ny);
    if (ids.length === 0) return;
    let changed = false;
    for (const id of ids) {
      if (erasedDuringDragRef.current.has(id)) continue;
      erasedDuringDragRef.current.add(id);
      strokesRef.current = strokesRef.current.filter(s => s.id !== id);
      if (socket) socket.emit('draw_delete_stroke', { roomId, strokeId: id });
      changed = true;
    }
    if (changed) renderStrokes();
  }, [hitStrokesAt, socket, roomId, renderStrokes]);

  // Interpolate erase between two pointer-move samples. A fast trackpad
  // swipe can fire moves 50+ canvas-px apart; without sub-point interpolation
  // a thin stroke between those samples gets skipped entirely. Step size is
  // tuned to the eraser tolerance — sample at ~1/3 of the tolerance so we
  // can't possibly miss a stroke that crosses our path.
  const lastErasePointRef = useRef<{ x: number; y: number } | null>(null);
  const eraseDragTo = useCallback((nx: number, ny: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const last = lastErasePointRef.current;
    if (!last || !rect) {
      lastErasePointRef.current = { x: nx, y: ny };
      eraseStrokeAt(nx, ny);
      return;
    }
    const tol = Math.max(ERASER_HIT_FLOOR_PX, eraserWidth / 2);
    const stepPx = Math.max(8, tol * 0.6);
    const stepNx = stepPx / rect.width;
    const stepNy = stepPx / rect.height;
    // Choose the larger axis to pick step count.
    const dx = nx - last.x;
    const dy = ny - last.y;
    const distNorm = Math.hypot(dx / stepNx, dy / stepNy);
    const steps = Math.max(1, Math.ceil(distNorm));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      eraseStrokeAt(last.x + dx * t, last.y + dy * t);
    }
    lastErasePointRef.current = { x: nx, y: ny };
  }, [eraseStrokeAt, eraserWidth]);

  // ── Drawing handlers (Pointer Events — supports mouse, pen tablet, and touch) ──
  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;

    // Shape branch (takes precedence over draw / laser / eraser).
    if (shapeTool !== 'off') {
      try { (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch {}
      const pt = getCanvasCoords(e);
      isShapingRef.current = (`shape-${shapeTool}` as ShapeKind);
      currentStrokeRef.current = [pt, pt];
      return;
    }

    // Eraser branch (takes precedence over the pen / laser modes)
    if (eraserMode !== 'off') {
      try { (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch {}
      const pt = getCanvasCoords(e);
      if (eraserMode === 'stroke') {
        isErasingRef.current = 'stroke';
        erasedDuringDragRef.current = new Set();
        // Reset the drag-interpolation anchor at gesture start.
        lastErasePointRef.current = null;
        eraseDragTo(pt.x, pt.y);
      } else {
        // Pixel eraser: draw a stroke tagged 'eraser-pixel'
        isErasingRef.current = 'pixel';
        currentStrokeRef.current = [pt];
      }
      return;
    }

    // Right-click = transient highlight (mouse only; pen tablets use barrel button which also maps to button 2)
    const isRightClick = e.button === 2;
    if (!drawMode && !laserMode) return;
    if (!drawMode && !isRightClick) return;
    try { (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch {}
    isDrawingRef.current = true;
    const pt = getCanvasCoords(e);
    currentStrokeRef.current = [pt];
    isTransientRef.current = isRightClick ? true : (drawMode && penType === 'transient');
  };

  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isShapingRef.current) {
      // Shape draft — keep only [start, current] so render uses first/last only.
      const pt = getCanvasCoords(e);
      currentStrokeRef.current = [currentStrokeRef.current[0], pt];
      renderStrokes();
      return;
    }
    if (isErasingRef.current === 'stroke') {
      const pt = getCanvasCoords(e);
      // Use the interpolating erase so a fast drag doesn't skip thin
      // strokes between successive pointermove samples.
      eraseDragTo(pt.x, pt.y);
      return;
    }
    if (isErasingRef.current === 'pixel') {
      const pt = getCanvasCoords(e);
      currentStrokeRef.current.push(pt);
      renderStrokes();
      return;
    }
    if (!isDrawingRef.current) return;
    const pt = getCanvasCoords(e);
    currentStrokeRef.current.push(pt);
    renderStrokes();
  };

  const endDraw = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (e) {
      try { (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch {}
    }
    // Capture the iframe scroll position at COMMIT time. The points
    // themselves are normalized to the canvas viewport — the scrollX/Y
    // baseline ties them to a specific position in the document so they
    // travel with the content on subsequent scrolls.
    const { x: scrollX, y: scrollY } = getIframeScroll();
    if (isShapingRef.current) {
      const kind: ShapeKind = isShapingRef.current;
      isShapingRef.current = false;
      const pts = currentStrokeRef.current;
      // Reject zero-length shapes (a stray click).
      if (pts.length >= 2 && socket) {
        const a = pts[0];
        const b = pts[pts.length - 1];
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        if (dx > 0.005 || dy > 0.005) {
          const id = newStrokeId();
          const stroke: StrokeData = { id, points: [a, b], color: penColor, width: penWidth, time: Date.now(), kind, scrollX, scrollY };
          strokesRef.current.push(stroke);
          myUndoRef.current.push(stroke);
          myRedoRef.current = [];
          socket.emit('draw_stroke', { roomId, id, points: [a, b], color: penColor, width: penWidth, kind, scrollX, scrollY, surface });
        }
      }
      currentStrokeRef.current = [];
      renderStrokes();
      return;
    }
    if (isErasingRef.current === 'pixel') {
      // Commit pixel-eraser stroke (and broadcast it)
      const points = currentStrokeRef.current;
      if (points.length > 1 && socket) {
        const id = newStrokeId();
        const stroke: StrokeData = { id, points, color: '#000', width: eraserWidth, time: Date.now(), kind: 'eraser-pixel', scrollX, scrollY };
        strokesRef.current.push(stroke);
        myUndoRef.current.push(stroke);
        myRedoRef.current = [];
        socket.emit('draw_stroke', { roomId, id, points, color: '#000', width: eraserWidth, kind: 'eraser-pixel', scrollX, scrollY, surface });
      }
      currentStrokeRef.current = [];
      isErasingRef.current = false;
      erasedDuringDragRef.current = new Set();
      return;
    }
    if (isErasingRef.current === 'stroke') {
      isErasingRef.current = false;
      erasedDuringDragRef.current = new Set();
      lastErasePointRef.current = null;
      return;
    }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    const points = currentStrokeRef.current;
    if (points.length > 1 && socket) {
      const id = newStrokeId();
      const stroke: StrokeData = { id, points, color: penColor, width: penWidth, time: Date.now(), transient: isTransientRef.current, kind: 'pen', scrollX, scrollY };
      strokesRef.current.push(stroke);
      // Transient (fading) ink auto-disappears, so it isn't undoable.
      if (!isTransientRef.current) {
        myUndoRef.current.push(stroke);
        myRedoRef.current = [];
      }
      socket.emit('draw_stroke', { roomId, id, points, color: penColor, width: penWidth, transient: isTransientRef.current, kind: 'pen', scrollX, scrollY, surface });
    }
    currentStrokeRef.current = [];
  };

  // ── Undo / redo for over-HTML ink ──
  const undoAnnotation = useCallback(() => {
    const stroke = myUndoRef.current.pop();
    if (!stroke || !stroke.id) return;
    strokesRef.current = strokesRef.current.filter(s => s.id !== stroke.id);
    if (socket) socket.emit('draw_delete_stroke', { roomId, strokeId: stroke.id });
    myRedoRef.current.push(stroke);
    renderStrokes();
  }, [socket, roomId, renderStrokes]);

  const redoAnnotation = useCallback(() => {
    const stroke = myRedoRef.current.pop();
    if (!stroke) return;
    strokesRef.current.push(stroke);
    if (socket) socket.emit('draw_stroke', {
      roomId, id: stroke.id, points: stroke.points, color: stroke.color, width: stroke.width,
      kind: stroke.kind, scrollX: stroke.scrollX, scrollY: stroke.scrollY, surface,
    });
    myUndoRef.current.push(stroke);
    renderStrokes();
  }, [socket, roomId, renderStrokes]);

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl+Y to redo — only while this
  // user is actively drawing over the HTML, so we never hijack Ctrl+Z in
  // other contexts (the whiteboard has its own separate undo).
  useEffect(() => {
    if (!interactive || !drawMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undoAnnotation(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoAnnotation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [interactive, drawMode, undoAnnotation, redoAnnotation]);

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    moveDraw(e);
    if (!interactive || (!laserMode && !drawMode)) return;
    if (eraserActive) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    localLaserRef.current = { x, y };
    // Move the local laser dot imperatively. Its position lived only in a ref,
    // so nothing re-rendered on pointer-move and the teacher's own dot stayed
    // frozen (remote viewers were fine — their dot is prop-driven). Updating
    // the DOM directly tracks the cursor without a per-move React re-render.
    if (laserDotRef.current) {
      laserDotRef.current.style.left = `${x * 100}%`;
      laserDotRef.current.style.top = `${y * 100}%`;
    }
    if (laserMode && socket) {
      socket.emit('laser_pointer', { roomId, x, y, active: true });
    }
  };

  const handlePointerLeave = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current && !isErasingRef.current && interactive && socket) {
      socket.emit('laser_pointer', { roomId, x: 0, y: 0, active: false });
    }
  };

  const showLaser = interactive ? (laserMode && !eraserActive) : (laserPointer?.active ?? false);
  const laserPos = interactive ? localLaserRef.current : (laserPointer ?? { x: 0, y: 0 });

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{
          cursor: interactive
            ? (shapeActive ? 'crosshair' : eraserActive ? ERASER_CURSOR : drawMode ? 'crosshair' : laserMode ? 'none' : 'default')
            : 'default',
          pointerEvents: interactive && (drawMode || laserMode || eraserActive || shapeActive) ? 'auto' : 'none',
          // Only swallow touch gestures while a drawing tool is actually active.
          // When the canvas isn't capturing (pointerEvents:none), keep
          // touchAction 'auto' so finger-scroll passes through to the iframe —
          // otherwise an unconditional 'none' silently blocks scrolling on
          // touch devices even in interactive mode.
          touchAction: interactive && (drawMode || laserMode || eraserActive || shapeActive) ? 'none' : 'auto',
          // AUTONOMOUS: [iPad fix] - Disable Safari's text-selection /
          // callout / touch-highlight on touch — they interfere with
          // freehand drawing on iPad.
          WebkitUserSelect: 'none',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
          userSelect: 'none',
          zIndex: 10,
        }}
        onPointerDown={startDraw}
        onPointerMove={handlePointerMove}
        onPointerUp={endDraw}
        onPointerCancel={endDraw}
        onPointerLeave={handlePointerLeave}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.scrollBy(e.deltaX, e.deltaY);
          }
        }}
      />

      {/* Laser Pointer Dot */}
      {showLaser && (
        <div className="absolute inset-0 pointer-events-none z-20">
          <div ref={laserDotRef} className="absolute w-4 h-4 rounded-full"
            style={{
              left: `${laserPos.x * 100}%`,
              top: `${laserPos.y * 100}%`,
              transform: 'translate(-50%, -50%)',
              background: 'rgba(239,68,68,0.9)',
              boxShadow: '0 0 12px 6px rgba(239,68,68,0.6)',
              animation: 'laser-pulse 1s infinite',
            }} />
        </div>
      )}
    </>
  );
}
