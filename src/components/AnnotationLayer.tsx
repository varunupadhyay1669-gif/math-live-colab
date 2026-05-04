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
}

interface StrokeData {
  id?: string;
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
  time: number;
  transient?: boolean;
  // 'pen' (default) is a normal coloured stroke. 'eraser-pixel' is rendered
  // with globalCompositeOperation = 'destination-out' so it visually cuts
  // a hole in everything beneath it.
  kind?: 'pen' | 'eraser-pixel';
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

    // Filter expired transient strokes
    strokesRef.current = strokesRef.current.filter(s => {
      if (!s.transient) return true;
      return (now - s.time) < 1000;
    });

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
      ctx.save();
      ctx.globalAlpha = alpha;
      if (stroke.kind === 'eraser-pixel') {
        // Cut a hole in the overlay along this path. The hole reveals the
        // iframe content underneath; on each redraw it is re-cut so it
        // reads as permanent.
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
      ctx.beginPath();
      stroke.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      ctx.stroke();
      ctx.restore();
    });

    // Current active stroke
    if (currentStrokeRef.current.length > 1) {
      ctx.save();
      ctx.globalAlpha = 1;
      const liveErasePixel = isErasingRef.current === 'pixel';
      if (liveErasePixel) {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = eraserWidth;
      } else {
        ctx.strokeStyle = penColor;
        ctx.lineWidth = penWidth;
        ctx.shadowColor = penColor;
        ctx.shadowBlur = 14;
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      currentStrokeRef.current.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      ctx.stroke();
      ctx.restore();
    }
  }, [penColor, penWidth, eraserWidth]);

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

  // Receive remote strokes
  useEffect(() => {
    if (!socket) return;
    const handleStroke = (data: { id?: string; points: Array<{ x: number; y: number }>; color: string; width: number; transient?: boolean; kind?: 'pen' | 'eraser-pixel' }) => {
      strokesRef.current.push({
        id: data.id ?? newStrokeId(),
        points: data.points,
        color: data.color,
        width: data.width,
        transient: data.transient,
        kind: data.kind,
        time: Date.now(),
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
    if (isErasingRef.current === 'pixel') {
      // Commit pixel-eraser stroke (and broadcast it)
      const points = currentStrokeRef.current;
      if (points.length > 1 && socket) {
        const id = newStrokeId();
        const stroke: StrokeData = { id, points, color: '#000', width: eraserWidth, time: Date.now(), kind: 'eraser-pixel' };
        strokesRef.current.push(stroke);
        socket.emit('draw_stroke', { roomId, id, points, color: '#000', width: eraserWidth, kind: 'eraser-pixel' });
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
      const stroke: StrokeData = { id, points, color: penColor, width: penWidth, time: Date.now(), transient: isTransientRef.current, kind: 'pen' };
      strokesRef.current.push(stroke);
      socket.emit('draw_stroke', { roomId, id, points, color: penColor, width: penWidth, transient: isTransientRef.current, kind: 'pen' });
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
            ? (eraserActive ? 'cell' : drawMode ? 'crosshair' : laserMode ? 'none' : 'default')
            : 'default',
          pointerEvents: interactive && (drawMode || laserMode || eraserActive) ? 'auto' : 'none',
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
