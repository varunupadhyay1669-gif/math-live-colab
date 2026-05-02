import React, { useRef, useEffect, useCallback, useState, useImperativeHandle, forwardRef } from 'react';
import { Socket } from 'socket.io-client';

interface WhiteboardProps {
  socket: Socket | null;
  roomId: string;
  isTeacher: boolean;
  interactive: boolean;
  zoomLevel: number;
  scrollX: number;
  scrollY: number;
  isActive: boolean;
  initialState?: {
    objects?: BoardImageObject[];
    strokes?: DrawStroke[];
    view?: BoardView | null;
  } | null;
}

interface DrawPoint {
  x: number;
  y: number;
}

interface DrawStroke {
  points: DrawPoint[];
  color: string;
  width: number;
  tool: 'pen' | 'eraser';
}

interface BoardImageObject {
  id: string;
  type: 'image';
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  rotation: number;
  zIndex: number;
}

interface BoardView {
  boardScale: number;
  boardOffsetX: number;
  boardOffsetY: number;
}

export interface WhiteboardRef {
  setImage: (dataUrl: string) => void;
  clearImage: () => void;
  clearDrawings: () => void;
  download: () => void;
  getCanvas: () => HTMLCanvasElement | null;
}

const COLORS = ['#000000', '#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6', '#FFFFFF'];
const WIDTHS = [2, 4, 6, 8, 12];
const BOARD_WIDTH = 3000;
const BOARD_HEIGHT = 2000;
const MIN_SCALE = 0.15;
const MAX_SCALE = 5;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const Whiteboard = forwardRef<WhiteboardRef, WhiteboardProps>(
  ({ socket, roomId, isTeacher, interactive, isActive, initialState }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const objectImageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const dragRef = useRef<{
      mode: 'draw' | 'pan' | 'object' | null;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startOffsetX: number;
      startOffsetY: number;
      objectId?: string;
      objectStartX?: number;
      objectStartY?: number;
    } | null>(null);
    const [objects, setObjects] = useState<BoardImageObject[]>([]);
    const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
    const [strokes, setStrokes] = useState<DrawStroke[]>([]);
    const [currentStroke, setCurrentStroke] = useState<DrawPoint[]>([]);
    const currentStrokeRef = useRef<DrawPoint[]>([]);
    const [tool, setTool] = useState<'pen' | 'eraser' | 'stroke-eraser' | 'select' | 'pan'>('pen');
    const [color, setColor] = useState('#000000');
    const [width, setWidth] = useState(4);
    const [view, setView] = useState<BoardView>({ boardScale: 1, boardOffsetX: 0, boardOffsetY: 0 });
    const [spacePan, setSpacePan] = useState(false);

    const selectedObject = selectedObjectId ? objects.find(obj => obj.id === selectedObjectId) : null;

    const setLiveStroke = useCallback((points: DrawPoint[]) => {
      currentStrokeRef.current = points;
      setCurrentStroke(points);
    }, []);

    const emitView = useCallback((nextView: BoardView) => {
      if (socket && isTeacher) socket.emit('whiteboard_set_view', { roomId, view: nextView });
    }, [socket, roomId, isTeacher]);

    const screenToBoard = useCallback((clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - view.boardOffsetX) / view.boardScale,
        y: (clientY - rect.top - view.boardOffsetY) / view.boardScale,
      };
    }, [view]);

    const loadImageIntoCache = useCallback((object: BoardImageObject) => {
      if (objectImageCacheRef.current.has(object.id)) return;
      const img = new Image();
      img.onload = () => redrawCanvas();
      img.src = object.src;
      objectImageCacheRef.current.set(object.id, img);
    }, []);

    const getInitialView = useCallback((): BoardView => {
      const container = containerRef.current;
      if (!container) return { boardScale: 1, boardOffsetX: 0, boardOffsetY: 0 };
      const scale = Math.min(container.clientWidth / BOARD_WIDTH, container.clientHeight / BOARD_HEIGHT, 1);
      return {
        boardScale: scale,
        boardOffsetX: (container.clientWidth - BOARD_WIDTH * scale) / 2,
        boardOffsetY: (container.clientHeight - BOARD_HEIGHT * scale) / 2,
      };
    }, []);

    const setSyncedView = useCallback((nextView: BoardView) => {
      setView(nextView);
      emitView(nextView);
    }, [emitView]);

    const fitBoard = useCallback(() => {
      setSyncedView(getInitialView());
    }, [getInitialView, setSyncedView]);

    const centerImage = useCallback((objectId?: string) => {
      const container = containerRef.current;
      if (!container) return;
      const target = objectId ? objects.find(obj => obj.id === objectId) : selectedObject || objects[objects.length - 1];
      if (!target) return fitBoard();
      const scale = clamp(Math.min(container.clientWidth / (target.width * target.scale), container.clientHeight / (target.height * target.scale)) * 0.82, MIN_SCALE, MAX_SCALE);
      const nextView = {
        boardScale: scale,
        boardOffsetX: container.clientWidth / 2 - (target.x + (target.width * target.scale) / 2) * scale,
        boardOffsetY: container.clientHeight / 2 - (target.y + (target.height * target.scale) / 2) * scale,
      };
      setSyncedView(nextView);
    }, [objects, selectedObject, fitBoard, setSyncedView]);

    const resetBoardView = useCallback(() => {
      setSyncedView(getInitialView());
    }, [getInitialView, setSyncedView]);

    const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number, sync = true) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const cx = clientX ?? rect.left + container.clientWidth / 2;
      const cy = clientY ?? rect.top + container.clientHeight / 2;
      const before = screenToBoard(cx, cy);
      const nextScale = clamp(view.boardScale * factor, MIN_SCALE, MAX_SCALE);
      const nextView = {
        boardScale: nextScale,
        boardOffsetX: cx - rect.left - before.x * nextScale,
        boardOffsetY: cy - rect.top - before.y * nextScale,
      };
      setView(nextView);
      if (sync) emitView(nextView);
    }, [view, screenToBoard, emitView]);

    const addImageObject = useCallback((src: string, naturalWidth?: number, naturalHeight?: number) => {
      const container = containerRef.current;
      const vw = container?.clientWidth || 1000;
      const vh = container?.clientHeight || 700;
      const imgW = naturalWidth || 1000;
      const imgH = naturalHeight || 700;
      const fitScale = Math.min((vw * 0.72) / imgW, (vh * 0.72) / imgH, 1);
      const center = screenToBoard((container?.getBoundingClientRect().left || 0) + vw / 2, (container?.getBoundingClientRect().top || 0) + vh / 2);
      const object: BoardImageObject = {
        id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'image',
        src,
        x: center.x - (imgW * fitScale) / 2,
        y: center.y - (imgH * fitScale) / 2,
        width: imgW,
        height: imgH,
        scale: fitScale,
        rotation: 0,
        zIndex: Date.now(),
      };
      setObjects(prev => [...prev, object]);
      setSelectedObjectId(object.id);
      loadImageIntoCache(object);
      if (socket && isTeacher) socket.emit('whiteboard_add_image', { roomId, object });
      setTimeout(() => centerImage(object.id), 50);
    }, [screenToBoard, loadImageIntoCache, socket, isTeacher, roomId, centerImage]);

    const updateObject = useCallback((object: BoardImageObject, broadcast = true) => {
      setObjects(prev => prev.map(obj => obj.id === object.id ? object : obj));
      if (broadcast && socket && isTeacher) socket.emit('whiteboard_update_object', { roomId, object });
    }, [socket, isTeacher, roomId]);

    const removeSelectedObject = useCallback(() => {
      if (!selectedObjectId) return;
      setObjects(prev => prev.filter(obj => obj.id !== selectedObjectId));
      objectImageCacheRef.current.delete(selectedObjectId);
      if (socket && isTeacher) socket.emit('whiteboard_remove_object', { roomId, objectId: selectedObjectId });
      setSelectedObjectId(null);
    }, [selectedObjectId, socket, isTeacher, roomId]);

    const redrawCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const dpr = window.devicePixelRatio || 1;
      const widthPx = Math.max(1, container.clientWidth);
      const heightPx = Math.max(1, container.clientHeight);
      if (canvas.width !== Math.floor(widthPx * dpr) || canvas.height !== Math.floor(heightPx * dpr)) {
        canvas.width = Math.floor(widthPx * dpr);
        canvas.height = Math.floor(heightPx * dpr);
      }
      canvas.style.width = `${widthPx}px`;
      canvas.style.height = `${heightPx}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, widthPx, heightPx);
      ctx.fillStyle = '#f3f4f6';
      ctx.fillRect(0, 0, widthPx, heightPx);
      ctx.save();
      ctx.translate(view.boardOffsetX, view.boardOffsetY);
      ctx.scale(view.boardScale, view.boardScale);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1 / view.boardScale;
      for (let x = 0; x <= BOARD_WIDTH; x += 100) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, BOARD_HEIGHT);
        ctx.stroke();
      }
      for (let y = 0; y <= BOARD_HEIGHT; y += 100) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(BOARD_WIDTH, y);
        ctx.stroke();
      }
      [...objects].sort((a, b) => a.zIndex - b.zIndex).forEach(object => {
        const img = objectImageCacheRef.current.get(object.id);
        if (img?.complete) {
          ctx.save();
          ctx.translate(object.x + (object.width * object.scale) / 2, object.y + (object.height * object.scale) / 2);
          ctx.rotate((object.rotation * Math.PI) / 180);
          ctx.drawImage(img, -(object.width * object.scale) / 2, -(object.height * object.scale) / 2, object.width * object.scale, object.height * object.scale);
          ctx.restore();
        }
        if (object.id === selectedObjectId) {
          ctx.save();
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2 / view.boardScale;
          ctx.setLineDash([8 / view.boardScale, 6 / view.boardScale]);
          ctx.strokeRect(object.x, object.y, object.width * object.scale, object.height * object.scale);
          ctx.restore();
        }
      });
      const drawStroke = (stroke: DrawStroke) => {
        if (stroke.points.length === 0) return;
        ctx.beginPath();
        ctx.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
        ctx.lineWidth = stroke.width / view.boardScale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        stroke.points.forEach((point, index) => {
          if (index === 0) ctx.moveTo(point.x, point.y);
          else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();
      };
      strokes.forEach(drawStroke);
      if (currentStroke.length > 0) drawStroke({ points: currentStroke, color, width, tool: tool === 'eraser' ? 'eraser' : 'pen' });
      ctx.restore();
    }, [objects, selectedObjectId, strokes, currentStroke, color, width, tool, view]);

    useImperativeHandle(ref, () => ({
      setImage: (dataUrl: string) => {
        const img = new Image();
        img.onload = () => addImageObject(dataUrl, img.naturalWidth, img.naturalHeight);
        img.src = dataUrl;
      },
      clearImage: () => {
        setObjects([]);
        setStrokes([]);
        setSelectedObjectId(null);
        objectImageCacheRef.current.clear();
        if (socket && isTeacher) socket.emit('whiteboard_clear', { roomId });
      },
      clearDrawings: () => {
        setStrokes([]);
        if (socket && isTeacher) socket.emit('whiteboard_reset', { roomId });
      },
      download: () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const link = document.createElement('a');
        link.download = `whiteboard-${Date.now()}.png`;
        link.href = canvas.toDataURL();
        link.click();
      },
      getCanvas: () => canvasRef.current,
    }), [addImageObject, socket, isTeacher, roomId]);

    useEffect(() => {
      objects.forEach(loadImageIntoCache);
      redrawCanvas();
    }, [objects, loadImageIntoCache, redrawCanvas]);

    useEffect(() => {
      if (!initialState) return;
      setObjects(initialState.objects || []);
      setStrokes(initialState.strokes || []);
      if (initialState.view) setView(initialState.view);
      (initialState.objects || []).forEach(loadImageIntoCache);
    }, [initialState, loadImageIntoCache]);

    useEffect(() => {
      redrawCanvas();
    }, [redrawCanvas]);

    useEffect(() => {
      if (!isActive) return;
      const resize = () => {
        if (objects.length === 0 && strokes.length === 0) setView(getInitialView());
        redrawCanvas();
      };
      resize();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, [isActive, getInitialView, redrawCanvas, objects.length, strokes.length]);

    useEffect(() => {
      if (!isActive) return;
      const down = (e: KeyboardEvent) => {
        if (e.code === 'Space') {
          setSpacePan(true);
          e.preventDefault();
        }
      };
      const up = (e: KeyboardEvent) => {
        if (e.code === 'Space') setSpacePan(false);
      };
      window.addEventListener('keydown', down);
      window.addEventListener('keyup', up);
      return () => {
        window.removeEventListener('keydown', down);
        window.removeEventListener('keyup', up);
      };
    }, [isActive]);

    useEffect(() => {
      if (!socket) return;
      const handleWhiteboardImage = (data: { imageUrl: string }) => {
        if (!data.imageUrl) return;
        const img = new Image();
        img.onload = () => addImageObject(data.imageUrl, img.naturalWidth, img.naturalHeight);
        img.src = data.imageUrl;
      };
      const handleAddImage = (data: { object: BoardImageObject }) => {
        setObjects(prev => prev.some(obj => obj.id === data.object.id) ? prev : [...prev, data.object]);
        loadImageIntoCache(data.object);
      };
      const handleUpdateObject = (data: { object: BoardImageObject }) => {
        setObjects(prev => prev.map(obj => obj.id === data.object.id ? data.object : obj));
        loadImageIntoCache(data.object);
      };
      const handleRemoveObject = (data: { objectId: string }) => {
        setObjects(prev => prev.filter(obj => obj.id !== data.objectId));
        objectImageCacheRef.current.delete(data.objectId);
        setSelectedObjectId(prev => prev === data.objectId ? null : prev);
      };
      const handleSetView = (data: { view: BoardView }) => setView(data.view);
      const handleWhiteboardStroke = (data: { stroke: DrawStroke }) => setStrokes(prev => [...prev, data.stroke]);
      const handleWhiteboardClear = () => {
        setStrokes([]);
        setObjects([]);
        setSelectedObjectId(null);
        objectImageCacheRef.current.clear();
      };
      const handleWhiteboardReset = () => setStrokes([]);
      const handleDeleteStroke = (data: { strokeIndex: number }) => {
        setStrokes(prev => {
          if (data.strokeIndex < 0 || data.strokeIndex >= prev.length) return prev;
          const next = [...prev];
          next.splice(data.strokeIndex, 1);
          return next;
        });
      };
      socket.on('whiteboard_image', handleWhiteboardImage);
      socket.on('whiteboard_add_image', handleAddImage);
      socket.on('whiteboard_update_object', handleUpdateObject);
      socket.on('whiteboard_remove_object', handleRemoveObject);
      socket.on('whiteboard_set_view', handleSetView);
      socket.on('whiteboard_stroke', handleWhiteboardStroke);
      socket.on('whiteboard_clear', handleWhiteboardClear);
      socket.on('whiteboard_reset', handleWhiteboardReset);
      socket.on('whiteboard_delete_stroke', handleDeleteStroke);
      return () => {
        socket.off('whiteboard_image', handleWhiteboardImage);
        socket.off('whiteboard_add_image', handleAddImage);
        socket.off('whiteboard_update_object', handleUpdateObject);
        socket.off('whiteboard_remove_object', handleRemoveObject);
        socket.off('whiteboard_set_view', handleSetView);
        socket.off('whiteboard_stroke', handleWhiteboardStroke);
        socket.off('whiteboard_clear', handleWhiteboardClear);
        socket.off('whiteboard_reset', handleWhiteboardReset);
        socket.off('whiteboard_delete_stroke', handleDeleteStroke);
      };
    }, [socket, addImageObject, loadImageIntoCache]);

    const findObjectAt = useCallback((point: DrawPoint) => {
      for (const object of [...objects].sort((a, b) => b.zIndex - a.zIndex)) {
        const w = object.width * object.scale;
        const h = object.height * object.scale;
        if (point.x >= object.x && point.x <= object.x + w && point.y >= object.y && point.y <= object.y + h) return object;
      }
      return null;
    }, [objects]);

    const findStrokeAtPoint = useCallback((point: DrawPoint): number => {
      for (let i = strokes.length - 1; i >= 0; i--) {
        const stroke = strokes[i];
        const hitDistance = stroke.width + 10 / view.boardScale;
        for (let j = 0; j < stroke.points.length - 1; j++) {
          const p1 = stroke.points[j];
          const p2 = stroke.points[j + 1];
          const A = point.x - p1.x;
          const B = point.y - p1.y;
          const C = p2.x - p1.x;
          const D = p2.y - p1.y;
          const dot = A * C + B * D;
          const lenSq = C * C + D * D;
          const param = lenSq === 0 ? -1 : clamp(dot / lenSq, 0, 1);
          const xx = p1.x + param * C;
          const yy = p1.y + param * D;
          const dist = Math.hypot(point.x - xx, point.y - yy);
          if (dist <= hitDistance) return i;
        }
      }
      return -1;
    }, [strokes, view.boardScale]);

    const deleteStroke = useCallback((strokeIndex: number) => {
      if (strokeIndex < 0 || strokeIndex >= strokes.length) return;
      setStrokes(prev => {
        const next = [...prev];
        next.splice(strokeIndex, 1);
        return next;
      });
      if (socket && isTeacher) socket.emit('whiteboard_delete_stroke', { roomId, strokeIndex });
    }, [strokes.length, socket, isTeacher, roomId]);

    const undoLastStroke = useCallback(() => {
      if (strokes.length === 0) return;
      deleteStroke(strokes.length - 1);
    }, [strokes.length, deleteStroke]);

    const downloadBoard = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const link = document.createElement('a');
      link.download = `whiteboard-${Date.now()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    }, []);

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!interactive) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const point = screenToBoard(e.clientX, e.clientY);
      const shouldPan = tool === 'pan' || spacePan || e.button === 1;
      if (shouldPan) {
        dragRef.current = { mode: 'pan', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
        return;
      }
      const hitObject = findObjectAt(point);
      if ((tool === 'select' || hitObject) && hitObject) {
        setSelectedObjectId(hitObject.id);
        setTool('select');
        dragRef.current = { mode: 'object', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY, objectId: hitObject.id, objectStartX: hitObject.x, objectStartY: hitObject.y };
        return;
      }
      setSelectedObjectId(null);
      if (tool === 'stroke-eraser') {
        const strokeIndex = findStrokeAtPoint(point);
        if (strokeIndex !== -1) deleteStroke(strokeIndex);
        return;
      }
      dragRef.current = { mode: 'draw', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
      setLiveStroke([point]);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.mode === 'pan') {
        const nextView = { ...view, boardOffsetX: drag.startOffsetX + e.clientX - drag.startClientX, boardOffsetY: drag.startOffsetY + e.clientY - drag.startClientY };
        setView(nextView);
        return;
      }
      if (drag.mode === 'object' && drag.objectId) {
        const object = objects.find(obj => obj.id === drag.objectId);
        if (!object) return;
        const dx = (e.clientX - drag.startClientX) / view.boardScale;
        const dy = (e.clientY - drag.startClientY) / view.boardScale;
        const nextObject = { ...object, x: (drag.objectStartX || 0) + dx, y: (drag.objectStartY || 0) + dy };
        setObjects(prev => prev.map(obj => obj.id === nextObject.id ? nextObject : obj));
        return;
      }
      if (drag.mode === 'draw') {
        const nextStroke = [...currentStrokeRef.current, screenToBoard(e.clientX, e.clientY)];
        setLiveStroke(nextStroke);
      }
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
      const finishedStroke = currentStrokeRef.current;
      if (drag.mode === 'draw' && finishedStroke.length > 1) {
        const stroke: DrawStroke = { points: finishedStroke, color, width, tool: tool === 'eraser' ? 'eraser' : 'pen' };
        setStrokes(prev => [...prev, stroke]);
        if (socket) socket.emit('whiteboard_draw', { roomId, stroke });
      }
      if (drag.mode === 'object' && drag.objectId) {
        const object = objects.find(obj => obj.id === drag.objectId);
        if (object) updateObject(object);
      }
      if (drag.mode === 'pan') emitView(view);
      setLiveStroke([]);
      dragRef.current = null;
    };

    const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const isZoom = e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX);
      if (isZoom) {
        const factor = Math.exp(-e.deltaY * 0.0015);
        zoomAt(factor, e.clientX, e.clientY);
      } else {
        const nextView = { ...view, boardOffsetX: view.boardOffsetX - e.deltaX, boardOffsetY: view.boardOffsetY - e.deltaY };
        setSyncedView(nextView);
      }
    };

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = event => {
        const dataUrl = event.target?.result as string;
        if (!dataUrl) return;
        const img = new Image();
        img.onload = () => addImageObject(dataUrl, img.naturalWidth, img.naturalHeight);
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    };

    useEffect(() => {
      if (!isActive || !isTeacher) return;
      const handlePaste = (e: ClipboardEvent) => {
        const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
        const blob = item?.getAsFile();
        if (!blob) return;
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = event => {
          const dataUrl = event.target?.result as string;
          if (!dataUrl) return;
          const img = new Image();
          img.onload = () => addImageObject(dataUrl, img.naturalWidth, img.naturalHeight);
          img.src = dataUrl;
        };
        reader.readAsDataURL(blob);
      };
      window.addEventListener('paste', handlePaste);
      return () => window.removeEventListener('paste', handlePaste);
    }, [isActive, isTeacher, addImageObject]);

    if (!isActive) return null;

    return (
      <div className="w-full h-full flex flex-col">
        <div className="flex items-center gap-3 px-4 py-2 border-b flex-wrap" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
          <div className="flex items-center gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-primary)' }}>
            {(['select', 'pan', 'pen', 'eraser', 'stroke-eraser'] as const).map(nextTool => (
              <button
                key={nextTool}
                onClick={() => setTool(nextTool)}
                className={`px-2 py-1 rounded-md text-xs font-semibold transition-all ${tool === nextTool ? 'active' : ''}`}
                style={tool === nextTool ? { background: nextTool === 'stroke-eraser' ? 'var(--accent-rose)' : 'var(--accent-indigo)', color: '#fff' } : { color: 'var(--text-secondary)' }}
              >
                {nextTool === 'select' ? 'Move' : nextTool === 'pan' ? 'Pan' : nextTool === 'stroke-eraser' ? 'Erase Stroke' : nextTool[0].toUpperCase() + nextTool.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)} className="w-6 h-6 rounded-full border-2" style={{ background: c, borderColor: color === c ? 'var(--accent-indigo)' : 'transparent', boxShadow: c === '#FFFFFF' ? 'inset 0 0 0 1px rgba(0,0,0,0.2)' : undefined }} />
            ))}
          </div>
          <div className="flex items-center gap-1">
            {WIDTHS.map(w => (
              <button key={w} onClick={() => setWidth(w)} className="text-xs px-2 py-1 rounded" style={{ background: width === w ? 'var(--accent-indigo-light)' : 'transparent', color: width === w ? 'var(--accent-indigo)' : 'var(--text-secondary)' }}>{w}</button>
            ))}
          </div>
          <div className="flex-1" />
          {isTeacher && (
            <>
              <input ref={uploadInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
              <button onClick={() => uploadInputRef.current?.click()} className="btn text-xs px-3 py-1.5" style={{ background: 'var(--accent-indigo)', color: '#fff' }}>Upload Image</button>
              <button onClick={undoLastStroke} disabled={strokes.length === 0} className="btn text-xs px-3 py-1.5 disabled:opacity-40">Undo Ink</button>
              <button onClick={() => zoomAt(1.2)} className="btn text-xs px-3 py-1.5">Zoom +</button>
              <button onClick={() => zoomAt(1 / 1.2)} className="btn text-xs px-3 py-1.5">Zoom -</button>
              <button onClick={fitBoard} className="btn text-xs px-3 py-1.5">Fit Board</button>
              <button onClick={() => centerImage()} className="btn text-xs px-3 py-1.5">Center Image</button>
              <button onClick={resetBoardView} className="btn text-xs px-3 py-1.5">Reset View</button>
              {selectedObject && <button onClick={removeSelectedObject} className="btn text-xs px-3 py-1.5" style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}>Remove Selected</button>}
              <button onClick={() => { setStrokes([]); if (socket) socket.emit('whiteboard_reset', { roomId }); }} className="btn text-xs px-3 py-1.5" style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}>Clear Ink</button>
              <button onClick={() => { setObjects([]); setStrokes([]); setSelectedObjectId(null); objectImageCacheRef.current.clear(); if (socket) socket.emit('whiteboard_clear', { roomId }); }} className="btn text-xs px-3 py-1.5" style={{ background: 'var(--bg-locked)', color: 'var(--text-secondary)' }}>Clear Board</button>
              <button onClick={downloadBoard} className="btn text-xs px-3 py-1.5">Download</button>
            </>
          )}
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{Math.round(view.boardScale * 100)}% ? {objects.length} images ? {strokes.length} strokes</span>
        </div>
        <div ref={containerRef} className="flex-1 relative overflow-hidden" style={{ background: '#e5e7eb' }}>
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            style={{ touchAction: 'none', cursor: tool === 'pan' || spacePan ? 'grab' : tool === 'select' ? 'move' : 'crosshair' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
          />
          {objects.length === 0 && strokes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center bg-white/80 rounded-xl px-6 py-5 shadow-sm">
                <h3 className="font-display font-bold" style={{ color: 'var(--text-primary)' }}>Whiteboard Workspace</h3>
                <p style={{ color: 'var(--text-muted)', marginTop: 8 }}>{isTeacher ? 'Upload, paste, drag, pan, and zoom images inside the app.' : 'Waiting for teacher to start...'}</p>
              </div>
            </div>
          )}
          <div className="absolute bottom-3 left-3 rounded-lg px-3 py-2 text-xs shadow" style={{ background: 'rgba(255,255,255,0.92)', color: '#374151' }}>
            Wheel/trackpad: zoom ? Space+drag/Pan: move board ? Move: drag images
          </div>
        </div>
      </div>
    );
  }
);

export default Whiteboard;
