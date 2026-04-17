import React, { useRef, useEffect, useCallback } from 'react';
import { Socket } from 'socket.io-client';

interface AnnotationLayerProps {
  socket: Socket | null;
  roomId: string;
  // Mode control
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
}

interface StrokeData {
  points: Array<{ x: number; y: number }>;
  color: string;
  width: number;
  time: number;
  transient?: boolean;
}

export default function AnnotationLayer({
  socket, roomId, drawMode, laserMode, penType, penColor, penWidth,
  iframeRef, interactive, laserPointer,
}: AnnotationLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const currentStrokeRef = useRef<Array<{ x: number; y: number }>>([]);
  const strokesRef = useRef<StrokeData[]>([]);
  const isTransientRef = useRef(false);
  const isDrawingRef = useRef(false);
  const animFrameRef = useRef<number>();
  const localLaserRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

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
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (stroke.transient) {
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
      ctx.shadowBlur = 0;
    });

    // Current active stroke
    if (currentStrokeRef.current.length > 1) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = penColor;
      ctx.lineWidth = penWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = penColor;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      currentStrokeRef.current.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * w, p.y * h);
        else ctx.lineTo(p.x * w, p.y * h);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }, [penColor, penWidth]);

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
    const handleStroke = (data: { points: Array<{ x: number; y: number }>; color: string; width: number; transient?: boolean }) => {
      strokesRef.current.push({ ...data, time: Date.now() });
      renderStrokes();
    };
    const handleClear = () => {
      strokesRef.current = [];
      renderStrokes();
    };
    socket.on('draw_stroke', handleStroke);
    socket.on('draw_clear', handleClear);
    return () => {
      socket.off('draw_stroke', handleStroke);
      socket.off('draw_clear', handleClear);
    };
  }, [socket, renderStrokes]);

  // ── Drawing handlers (Pointer Events — supports mouse, pen tablet, and touch) ──
  const startDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    // Right-click = transient highlight (mouse only; pen tablets use barrel button which also maps to button 2)
    const isRightClick = e.button === 2;
    if (!drawMode && !laserMode) return;
    if (!drawMode && !isRightClick) return;
    // Capture the pointer so we keep receiving events even if the pen moves
    // outside the canvas bounds mid-stroke (crucial for pen tablets with
    // mapped regions that don't match 1:1)
    try { (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId); } catch {}
    isDrawingRef.current = true;
    const pt = getCanvasCoords(e);
    currentStrokeRef.current = [pt];
    isTransientRef.current = isRightClick ? true : (drawMode && penType === 'transient');
  };

  const moveDraw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const pt = getCanvasCoords(e);
    currentStrokeRef.current.push(pt);
    renderStrokes();
  };

  const endDraw = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (e) {
      try { (e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch {}
    }
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    const points = currentStrokeRef.current;
    if (points.length > 1 && socket) {
      const stroke: StrokeData = { points, color: penColor, width: penWidth, time: Date.now(), transient: isTransientRef.current };
      strokesRef.current.push(stroke);
      socket.emit('draw_stroke', { roomId, points, color: penColor, width: penWidth, transient: isTransientRef.current });
    }
    currentStrokeRef.current = [];
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    moveDraw(e);
    if (!interactive || (!laserMode && !drawMode)) return;
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
    // Don't end stroke here — pointer capture keeps the stroke alive.
    // Only clear the laser pointer broadcast (not while drawing).
    if (!isDrawingRef.current && interactive && socket) {
      socket.emit('laser_pointer', { roomId, x: 0, y: 0, active: false });
    }
  };

  // Expose clearDrawing via imperative method or just use strokesRef
  // The parent will call socket.emit('draw_clear') directly
  const clearStrokes = () => {
    strokesRef.current = [];
    renderStrokes();
  };

  // Listen for parent clear instruction via a custom approach
  // Actually we already handle draw_clear from socket above

  const showLaser = interactive ? laserMode : (laserPointer?.active ?? false);
  const laserPos = interactive ? localLaserRef.current : (laserPointer ?? { x: 0, y: 0 });

  return (
    <>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{
          cursor: interactive ? (drawMode ? 'crosshair' : laserMode ? 'none' : 'default') : 'default',
          pointerEvents: interactive && (drawMode || laserMode) ? 'auto' : 'none',
          // Prevent the browser from handling the pointer for scroll/pinch/pan —
          // required so pen tablets and touch screens deliver events to our handlers
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
