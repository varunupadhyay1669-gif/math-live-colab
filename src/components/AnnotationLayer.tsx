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

  const eraserActive = interactive && eraserMode !== 'off';
  const shapeActive = interactive && shapeTool !== 'off';
  const isShapingRef = useRef<false | ShapeKind>(false);

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
        ctx.beginPath();
        stroke.points.forEach((p, i) => {
          // Scroll offset: subtract the delta between current scroll and
          // capture-time scroll so the stroke moves with the content.
          const px = p.x * w - offsetX;
          const py = p.y * h - offsetY;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
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
        ctx.beginPath();
        currentStrokeRef.current.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x * w, p.y * h);
          else ctx.lineTo(p.x * w, p.y * h);
        });
        ctx.stroke();
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
  useEffect(() => {
    if (!socket) return;
    const handleStroke = (data: { id?: string; points: Array<{ x: number; y: number }>; color: string; width: number; transient?: boolean; kind?: StrokeKind; scrollX?: number; scrollY?: number }) => {
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
  }, [socket, renderStrokes]);

  // Per-stroke eraser hit-test. Returns the id of the stroke under the
  // cursor (within tolerance), or null. Operates in canvas-pixel space so
  // the tolerance feels consistent regardless of the canvas' rendered
  // dimensions.
  const hitStrokeAt = useCallback((nx: number, ny: number): string | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = nx * rect.width;
    const py = ny * rect.height;
    const tol = Math.max(8, eraserWidth / 2);
    // Check newest first so overlapping strokes prefer the top one.
    for (let i = strokesRef.current.length - 1; i >= 0; i--) {
      const stroke = strokesRef.current[i];
      if (stroke.kind === 'eraser-pixel') continue; // can't erase the eraser
      const half = stroke.width / 2 + tol;
      for (let j = 0; j < stroke.points.length - 1; j++) {
        const a = stroke.points[j];
        const b = stroke.points[j + 1];
        if (distanceToSegment(px, py, a.x * rect.width, a.y * rect.height, b.x * rect.width, b.y * rect.height) <= half) {
          return stroke.id ?? null;
        }
      }
    }
    return null;
  }, [eraserWidth]);

  const eraseStrokeAt = useCallback((nx: number, ny: number) => {
    const id = hitStrokeAt(nx, ny);
    if (!id || erasedDuringDragRef.current.has(id)) return;
    erasedDuringDragRef.current.add(id);
    strokesRef.current = strokesRef.current.filter(s => s.id !== id);
    if (socket) socket.emit('draw_delete_stroke', { roomId, strokeId: id });
    renderStrokes();
  }, [hitStrokeAt, socket, roomId, renderStrokes]);

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
        eraseStrokeAt(pt.x, pt.y);
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
      eraseStrokeAt(pt.x, pt.y);
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
          socket.emit('draw_stroke', { roomId, id, points: [a, b], color: penColor, width: penWidth, kind, scrollX, scrollY });
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
        socket.emit('draw_stroke', { roomId, id, points, color: '#000', width: eraserWidth, kind: 'eraser-pixel', scrollX, scrollY });
      }
      currentStrokeRef.current = [];
      isErasingRef.current = false;
      erasedDuringDragRef.current = new Set();
      return;
    }
    if (isErasingRef.current === 'stroke') {
      isErasingRef.current = false;
      erasedDuringDragRef.current = new Set();
      return;
    }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    const points = currentStrokeRef.current;
    if (points.length > 1 && socket) {
      const id = newStrokeId();
      const stroke: StrokeData = { id, points, color: penColor, width: penWidth, time: Date.now(), transient: isTransientRef.current, kind: 'pen', scrollX, scrollY };
      strokesRef.current.push(stroke);
      socket.emit('draw_stroke', { roomId, id, points, color: penColor, width: penWidth, transient: isTransientRef.current, kind: 'pen', scrollX, scrollY });
    }
    currentStrokeRef.current = [];
  };

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
            ? (shapeActive ? 'crosshair' : eraserActive ? 'cell' : drawMode ? 'crosshair' : laserMode ? 'none' : 'default')
            : 'default',
          pointerEvents: interactive && (drawMode || laserMode || eraserActive || shapeActive) ? 'auto' : 'none',
          touchAction: 'none',
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
          <div className="absolute w-4 h-4 rounded-full"
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
