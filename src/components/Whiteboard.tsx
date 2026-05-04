import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
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
    shapes?: BoardShape[];
    view?: BoardView | null;
  } | null;
  // Whiteboard mutual sync (Miro/Canva "shared book" model). When true on
  // both sides, every pan/zoom is mirrored to the other side in real time.
  // When false locally, this user neither broadcasts nor receives view
  // changes — they get an independent canvas. Default true.
  whiteboardSyncEnabled?: boolean;
}

type ShapeKind = 'line' | 'rect' | 'circle' | 'arrow';

interface BoardShape {
  id: string;
  kind: ShapeKind;
  // For line/arrow: x1,y1=start, x2,y2=end.
  // For rect: x1,y1 and x2,y2 are opposite corners (board-space).
  // For circle: x1,y1=center, x2,y2=an edge point (radius = distance).
  x1: number; y1: number;
  x2: number; y2: number;
  color: string;
  width: number;
}

interface DrawPoint {
  x: number;
  y: number;
}

interface DrawStroke {
  id?: string;
  points: DrawPoint[];
  color: string;
  width: number;
  // 'pen' = a normal coloured stroke. 'eraser-pixel' = an erase stroke,
  // rendered with destination-out compositing so it visually removes whatever
  // pen strokes / shapes / images sit beneath it (within the rendered frame).
  // 'highlighter' = ephemeral translucent stroke that holds at full opacity
  // briefly, then fades out and is auto-removed locally after HIGHLIGHTER_FADE_MS.
  // Stored as a stroke so it persists, syncs, and is undoable like any other —
  // except highlighter strokes are time-bound and disappear from each
  // client's local state on the fade timer.
  tool: 'pen' | 'eraser-pixel' | 'highlighter';
  createdAt?: number; // wall-clock ms; used by highlighter for fade-out
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

type BoardTool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'pan' | 'line' | 'rect' | 'circle' | 'arrow';

const SHAPE_TOOLS: BoardTool[] = ['line', 'rect', 'circle', 'arrow'];
const isShapeTool = (t: BoardTool): t is ShapeKind => SHAPE_TOOLS.includes(t);

const COLORS = ['#111827', '#EF4444', '#10B981', '#2563EB', '#F59E0B', '#7C3AED', '#FFFFFF'];
const WIDTHS = [2, 4, 6, 10, 16, 24];

// Pen-shaped cursor (hot-spot at the nib, bottom-left of a 24x24 SVG so the tip
// of the pen sits on the actual draw point). Crosshair is the fallback if the
// browser refuses the data-URL cursor.
const PEN_CURSOR = (() => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5L17 3z" fill="white" stroke="black" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M14 6l4 4" stroke="black" stroke-width="1.4" stroke-linecap="round"/></svg>';
  return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}') 3 21, crosshair`;
})();

// Hand-shaped cursor for the Hand (pan) tool. The browser default 'grab' is
// often a thin white outline that disappears against a white whiteboard
// background. This explicit white-fill / dark-outline hand stays readable on
// both light and dark surfaces. Fallback to 'grab' if the data URL is refused.
const HAND_CURSOR = (() => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v8M10 12V6a2 2 0 0 0-4 0v7M6 13c-2 0-3 1-3 3 0 4 4 6 8 6h3c4 0 7-3 7-7v-4a2 2 0 0 0-4 0" fill="#ffffff" stroke="#0F172A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}') 13 13, grab`;
})();
const HIGHLIGHTER_FADE_MS = 4500; // total visible time for a highlighter stroke
const HIGHLIGHTER_HOLD_MS = 1800; // hold at full opacity, then fade for the rest
// The whiteboard is an infinite plane — no fixed page boundary. The grid is
// rendered for whatever rectangle is currently visible, and pan can go in any
// direction without limit. These constants are kept only as the initial-view
// "page" reference (centred on screen at first load) and as the area used by
// the "fit" button when there's no content yet.
const BOARD_WIDTH = 3200;
const BOARD_HEIGHT = 2200;
const GRID_STEP = 80;
const MIN_SCALE = 0.05;
const MAX_SCALE = 6;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function distanceToSegment(point: DrawPoint, a: DrawPoint, b: DrawPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

// Rotate a point by `degrees` around an origin. Used to map an image's
// axis-aligned local coordinates into world space when the image has rotation.
function rotatePoint(point: DrawPoint, origin: DrawPoint, degrees: number): DrawPoint {
  if (!degrees) return point;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

interface AABB { x: number; y: number; w: number; h: number; }
function rectsOverlap(a: AABB, b: AABB): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const Whiteboard = forwardRef<WhiteboardRef, WhiteboardProps>(
  ({ socket, roomId, isTeacher, interactive, isActive, initialState, whiteboardSyncEnabled = true }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const uploadInputRef = useRef<HTMLInputElement>(null);
    const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const currentStrokeRef = useRef<DrawPoint[]>([]);
    const strokesRef = useRef<DrawStroke[]>([]);
    const erasedDuringDragRef = useRef<Set<number>>(new Set());
    const shapesRef = useRef<BoardShape[]>([]);
    const draftShapeRef = useRef<BoardShape | null>(null);
    const marqueeRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
    type ObjectHandle = 'tl' | 'tr' | 'bl' | 'br' | 'rotate';
    const dragRef = useRef<{
      mode: 'draw' | 'erase' | 'pan' | 'object' | 'object-resize' | 'object-rotate' | 'shape-create' | 'shape-move' | 'marquee' | null;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startOffsetX: number;
      startOffsetY: number;
      objectId?: string;
      objectStartX?: number;
      objectStartY?: number;
      objectStart?: BoardImageObject; // full snapshot used by resize / rotate
      handle?: ObjectHandle;
      shapeId?: string;
      shapeStart?: { x1: number; y1: number; x2: number; y2: number };
    } | null>(null);

    const [objects, setObjects] = useState<BoardImageObject[]>([]);
    const [strokes, setStrokes] = useState<DrawStroke[]>([]);
    const [shapes, setShapes] = useState<BoardShape[]>([]);
    const [draftShape, setDraftShape] = useState<BoardShape | null>(null);
    const [currentStroke, setCurrentStroke] = useState<DrawPoint[]>([]);
    const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
    const [selectedStrokeIndex, setSelectedStrokeIndex] = useState<number | null>(null);
    const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
    // Marquee multi-select: drag from empty space in the Select tool to lasso
    // multiple items, then Delete removes them all together.
    const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
    const [multiObjectIds, setMultiObjectIds] = useState<string[]>([]);
    const [multiShapeIds, setMultiShapeIds] = useState<string[]>([]);
    const [multiStrokeIndices, setMultiStrokeIndices] = useState<number[]>([]);
    const [tool, setTool] = useState<BoardTool>('select');
    // When tool is 'eraser', this picks between two eraser flavours:
    //   stroke = click on a stroke to delete the entire stroke (existing).
    //   pixel  = drag to "paint" an erase path that removes whatever it
    //            crosses (image / shape / pen ink), pixel-eraser style.
    const [eraserMode, setEraserMode] = useState<'stroke' | 'pixel'>('stroke');
    const [color, setColor] = useState('#111827');
    const [width, setWidth] = useState(4);
    const [view, setView] = useState<BoardView>({ boardScale: 1, boardOffsetX: 0, boardOffsetY: 0 });
    const [spacePan, setSpacePan] = useState(false);

    const selectedObject = selectedObjectId ? objects.find(obj => obj.id === selectedObjectId) : null;
    const canEdit = interactive;

    useEffect(() => {
      strokesRef.current = strokes;
    }, [strokes]);

    useEffect(() => {
      shapesRef.current = shapes;
    }, [shapes]);

    useEffect(() => {
      draftShapeRef.current = draftShape;
    }, [draftShape]);

    useEffect(() => {
      marqueeRef.current = marquee;
    }, [marquee]);

    // Highlighter fade tick: while any highlighter stroke exists, drive a
    // ~12fps timer that re-renders (so opacity recomputes) and prunes any
    // stroke that has fully faded. The tick stops automatically when no
    // highlighter strokes remain — costs nothing in steady state.
    useEffect(() => {
      const hasHighlighter = strokes.some(s => s.tool === 'highlighter');
      if (!hasHighlighter) return;
      const handle = setInterval(() => {
        const now = Date.now();
        setStrokes(prev => {
          let changed = false;
          const next = prev.filter(s => {
            if (s.tool !== 'highlighter') return true;
            const expired = (now - (s.createdAt ?? 0)) >= HIGHLIGHTER_FADE_MS;
            if (expired) changed = true;
            return !expired;
          });
          // Even when nothing is removed yet, forcing a new array every tick
          // re-runs redrawCanvas and gives the fade visual continuity.
          return changed ? next : [...prev];
        });
      }, 80);
      return () => clearInterval(handle);
    }, [strokes]);

    // ── Undo / Redo ──
    // Each user action records a pair { undo, redo }. Both run the same kind of
    // local-state update and emit the matching socket event so the change is
    // reflected for peers too. This is per-user history (the stack lives in
    // the local component), so undoing on the teacher does NOT pop strokes
    // the student drew (and vice versa).
    type UndoEntry = { undo: () => void; redo: () => void };
    const undoStackRef = useRef<UndoEntry[]>([]);
    const redoStackRef = useRef<UndoEntry[]>([]);
    const [undoTick, setUndoTick] = useState(0); // re-render so toolbar buttons reflect enabled state
    const HISTORY_CAP = 100;

    const recordAction = useCallback((entry: UndoEntry) => {
      undoStackRef.current.push(entry);
      if (undoStackRef.current.length > HISTORY_CAP) undoStackRef.current.shift();
      // Any new action invalidates the redo stack (standard convention).
      redoStackRef.current = [];
      setUndoTick(t => t + 1);
    }, []);

    const undo = useCallback(() => {
      const entry = undoStackRef.current.pop();
      if (!entry) return;
      entry.undo();
      redoStackRef.current.push(entry);
      setUndoTick(t => t + 1);
    }, []);

    const redo = useCallback(() => {
      const entry = redoStackRef.current.pop();
      if (!entry) return;
      entry.redo();
      undoStackRef.current.push(entry);
      setUndoTick(t => t + 1);
    }, []);

    const canUndo = undoStackRef.current.length > 0;
    const canRedo = redoStackRef.current.length > 0;
    void undoTick; // ref-driven; this keeps the lint quiet about the unused state

    const clearMultiSelection = useCallback(() => {
      setMultiObjectIds([]);
      setMultiShapeIds([]);
      setMultiStrokeIndices([]);
    }, []);

    // Bulk-delete every item in the marquee multi-selection.
    // Captures snapshots of every removed item so a single undo restores them all.
    const removeMultiSelection = useCallback(() => {
      // Snapshot everything first so the undo entry sees the original state
      const removedObjects: BoardImageObject[] = [];
      const removedShapes: BoardShape[] = [];
      const removedStrokes: DrawStroke[] = [];

      if (multiObjectIds.length > 0) {
        const ids = new Set(multiObjectIds);
        objects.forEach(o => { if (ids.has(o.id)) removedObjects.push({ ...o }); });
        setObjects(prev => prev.filter(o => !ids.has(o.id)));
        multiObjectIds.forEach(id => {
          imageCacheRef.current.delete(id);
          if (socket && isTeacher) socket.emit('whiteboard_remove_object', { roomId, objectId: id });
        });
      }
      if (multiShapeIds.length > 0) {
        const ids = new Set(multiShapeIds);
        shapes.forEach(s => { if (ids.has(s.id)) removedShapes.push({ ...s }); });
        setShapes(prev => prev.filter(s => !ids.has(s.id)));
        multiShapeIds.forEach(id => {
          if (socket && isTeacher) socket.emit('whiteboard_remove_shape', { roomId, shapeId: id });
        });
      }
      if (multiStrokeIndices.length > 0) {
        const indices = [...multiStrokeIndices];
        const unique = Array.from(new Set(indices))
          .filter(i => i >= 0 && i < strokesRef.current.length)
          .sort((a, b) => b - a);
        if (unique.length > 0) {
          unique.forEach(i => { const s = strokesRef.current[i]; if (s) removedStrokes.push(s); });
          setStrokes(prev => prev.filter((_, idx) => !unique.includes(idx)));
          if (socket) socket.emit('whiteboard_delete_strokes', { roomId, strokeIndices: unique });
        }
      }
      clearMultiSelection();

      if (removedObjects.length === 0 && removedShapes.length === 0 && removedStrokes.length === 0) return;
      recordAction({
        undo: () => {
          if (removedObjects.length > 0) {
            setObjects(prev => {
              const existing = new Set(prev.map(o => o.id));
              const additions = removedObjects.filter(o => !existing.has(o.id));
              return [...prev, ...additions];
            });
            // No explicit loadImage — the existing `objects` useEffect re-runs
            // when the array changes and calls loadImage for any new entry.
            removedObjects.forEach(o => {
              if (socket && isTeacher) socket.emit('whiteboard_add_image', { roomId, object: o });
            });
          }
          if (removedShapes.length > 0) {
            setShapes(prev => {
              const existing = new Set(prev.map(s => s.id));
              const additions = removedShapes.filter(s => !existing.has(s.id));
              return [...prev, ...additions];
            });
            removedShapes.forEach(s => {
              if (socket && isTeacher) socket.emit('whiteboard_add_shape', { roomId, shape: s });
            });
          }
          if (removedStrokes.length > 0) {
            setStrokes(prev => {
              const existing = new Set(prev.map(s => s.id));
              const additions = removedStrokes.filter(s => !existing.has(s.id ?? ''));
              return [...prev, ...additions];
            });
            removedStrokes.forEach(stroke => {
              if (socket) socket.emit('whiteboard_draw', { roomId, stroke });
            });
          }
        },
        redo: () => {
          if (removedObjects.length > 0) {
            const ids = new Set(removedObjects.map(o => o.id));
            setObjects(prev => prev.filter(o => !ids.has(o.id)));
            removedObjects.forEach(o => {
              imageCacheRef.current.delete(o.id);
              if (socket && isTeacher) socket.emit('whiteboard_remove_object', { roomId, objectId: o.id });
            });
          }
          if (removedShapes.length > 0) {
            const ids = new Set(removedShapes.map(s => s.id));
            setShapes(prev => prev.filter(s => !ids.has(s.id)));
            removedShapes.forEach(s => {
              if (socket && isTeacher) socket.emit('whiteboard_remove_shape', { roomId, shapeId: s.id });
            });
          }
          if (removedStrokes.length > 0) {
            // Re-find indices in current state and delete.
            const idsToRemove = new Set(removedStrokes.map(s => s.id ?? ''));
            const currentIndices: number[] = [];
            strokesRef.current.forEach((s, idx) => { if (idsToRemove.has(s.id ?? '')) currentIndices.push(idx); });
            const sorted = currentIndices.sort((a, b) => b - a);
            if (sorted.length > 0) {
              setStrokes(prev => prev.filter((_, idx) => !sorted.includes(idx)));
              if (socket) socket.emit('whiteboard_delete_strokes', { roomId, strokeIndices: sorted });
            }
          }
        },
      });
    }, [multiObjectIds, multiShapeIds, multiStrokeIndices, objects, shapes, socket, isTeacher, roomId, clearMultiSelection, recordAction]);

    const selectedShape = selectedShapeId ? shapes.find(s => s.id === selectedShapeId) : null;

    // ── Shape geometry helpers ──
    const shapeBounds = useCallback((shape: BoardShape) => {
      const pad = shape.width / 2 + 8 / view.boardScale;
      if (shape.kind === 'circle') {
        const r = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
        return { x: shape.x1 - r - pad, y: shape.y1 - r - pad, w: 2 * (r + pad), h: 2 * (r + pad) };
      }
      const minX = Math.min(shape.x1, shape.x2);
      const minY = Math.min(shape.y1, shape.y2);
      const maxX = Math.max(shape.x1, shape.x2);
      const maxY = Math.max(shape.y1, shape.y2);
      return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
    }, [view.boardScale]);

    const shapeHit = useCallback((point: DrawPoint, shape: BoardShape) => {
      const tol = shape.width / 2 + 10 / view.boardScale;
      if (shape.kind === 'line' || shape.kind === 'arrow') {
        return distanceToSegment(point, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= tol;
      }
      if (shape.kind === 'rect') {
        const minX = Math.min(shape.x1, shape.x2);
        const minY = Math.min(shape.y1, shape.y2);
        const maxX = Math.max(shape.x1, shape.x2);
        const maxY = Math.max(shape.y1, shape.y2);
        // Hollow rect: hit only on the border (within tol).
        const onLeft   = Math.abs(point.x - minX) <= tol && point.y >= minY - tol && point.y <= maxY + tol;
        const onRight  = Math.abs(point.x - maxX) <= tol && point.y >= minY - tol && point.y <= maxY + tol;
        const onTop    = Math.abs(point.y - minY) <= tol && point.x >= minX - tol && point.x <= maxX + tol;
        const onBottom = Math.abs(point.y - maxY) <= tol && point.x >= minX - tol && point.x <= maxX + tol;
        return onLeft || onRight || onTop || onBottom;
      }
      if (shape.kind === 'circle') {
        const r = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
        const d = Math.hypot(point.x - shape.x1, point.y - shape.y1);
        return Math.abs(d - r) <= tol;
      }
      return false;
    }, [view.boardScale]);

    const findShapeAt = useCallback((point: DrawPoint): BoardShape | null => {
      for (let i = shapes.length - 1; i >= 0; i--) {
        if (shapeHit(point, shapes[i])) return shapes[i];
      }
      return null;
    }, [shapes, shapeHit]);

    const removeSelectedShape = useCallback(() => {
      if (!selectedShapeId) return;
      const id = selectedShapeId;
      const snapshot = shapes.find(s => s.id === id);
      if (!snapshot) return;
      const shapeSnapshot: BoardShape = { ...snapshot };
      setShapes(prev => prev.filter(s => s.id !== id));
      setSelectedShapeId(null);
      if (socket && isTeacher) socket.emit('whiteboard_remove_shape', { roomId, shapeId: id });
      recordAction({
        undo: () => {
          setShapes(prev => prev.some(s => s.id === shapeSnapshot.id) ? prev : [...prev, shapeSnapshot]);
          if (socket && isTeacher) socket.emit('whiteboard_add_shape', { roomId, shape: shapeSnapshot });
        },
        redo: () => {
          setShapes(prev => prev.filter(s => s.id !== shapeSnapshot.id));
          if (socket && isTeacher) socket.emit('whiteboard_remove_shape', { roomId, shapeId: shapeSnapshot.id });
        },
      });
    }, [selectedShapeId, shapes, socket, isTeacher, roomId, recordAction]);

    const setLiveStroke = useCallback((points: DrawPoint[]) => {
      currentStrokeRef.current = points;
      setCurrentStroke(points);
    }, []);

    const emitView = useCallback((nextView: BoardView) => {
      if (!socket) return;
      // Mutual-sync model. The server only relays this if the LOCAL user has
      // sync enabled; we still gate here so we don't spam the wire when the
      // user has explicitly opted out. Either side (teacher or student) can
      // emit when their sync is on, and the relay reaches every other
      // sync-on user in the room.
      if (!whiteboardSyncEnabled) return;
      socket.emit('whiteboard_set_view', { roomId, view: nextView });
    }, [socket, roomId, whiteboardSyncEnabled]);

    const screenToBoard = useCallback((clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - view.boardOffsetX) / view.boardScale,
        y: (clientY - rect.top - view.boardOffsetY) / view.boardScale,
      };
    }, [view]);

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

    const fitBoard = useCallback(() => setSyncedView(getInitialView()), [getInitialView, setSyncedView]);

    const loadImage = useCallback((object: BoardImageObject) => {
      if (imageCacheRef.current.has(object.id)) return;
      const img = new Image();
      img.onload = () => redrawCanvas();
      img.src = object.src;
      imageCacheRef.current.set(object.id, img);
    }, []);

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
      const fitScale = Math.min((vw * 0.68) / imgW, (vh * 0.68) / imgH, 1);
      const rect = container?.getBoundingClientRect();
      const center = screenToBoard((rect?.left || 0) + vw / 2, (rect?.top || 0) + vh / 2);
      const object: BoardImageObject = {
        id: newId('img'),
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
      setSelectedStrokeIndex(null);
      setTool('select');
      loadImage(object);
      if (socket && isTeacher) socket.emit('whiteboard_add_image', { roomId, object });
      recordAction({
        undo: () => {
          setObjects(prev => prev.filter(o => o.id !== object.id));
          imageCacheRef.current.delete(object.id);
          if (socket && isTeacher) socket.emit('whiteboard_remove_object', { roomId, objectId: object.id });
        },
        redo: () => {
          setObjects(prev => prev.some(o => o.id === object.id) ? prev : [...prev, object]);
          loadImage(object);
          if (socket && isTeacher) socket.emit('whiteboard_add_image', { roomId, object });
        },
      });
    }, [screenToBoard, loadImage, socket, isTeacher, roomId, recordAction]);

    const updateObject = useCallback((object: BoardImageObject, broadcast = true) => {
      setObjects(prev => prev.map(obj => obj.id === object.id ? object : obj));
      if (broadcast && socket && isTeacher) socket.emit('whiteboard_update_object', { roomId, object });
    }, [socket, isTeacher, roomId]);

    const removeSelectedObject = useCallback(() => {
      if (!selectedObjectId) return;
      const target = objects.find(o => o.id === selectedObjectId);
      if (!target) return;
      const snapshot: BoardImageObject = { ...target };
      setObjects(prev => prev.filter(obj => obj.id !== selectedObjectId));
      imageCacheRef.current.delete(selectedObjectId);
      if (socket && isTeacher) socket.emit('whiteboard_remove_object', { roomId, objectId: selectedObjectId });
      setSelectedObjectId(null);
      recordAction({
        undo: () => {
          setObjects(prev => prev.some(o => o.id === snapshot.id) ? prev : [...prev, snapshot]);
          loadImage(snapshot);
          if (socket && isTeacher) socket.emit('whiteboard_add_image', { roomId, object: snapshot });
        },
        redo: () => {
          setObjects(prev => prev.filter(o => o.id !== snapshot.id));
          imageCacheRef.current.delete(snapshot.id);
          if (socket && isTeacher) socket.emit('whiteboard_remove_object', { roomId, objectId: snapshot.id });
        },
      });
    }, [selectedObjectId, objects, socket, isTeacher, roomId, recordAction, loadImage]);

    // Where the resize / rotate handles sit in WORLD space — i.e. with the
    // image's rotation already applied around its centre. Hit-tests and the
    // canvas drawing both use these.
    const getObjectHandlePositions = useCallback((object: BoardImageObject) => {
      const w = object.width * object.scale;
      const h = object.height * object.scale;
      const cx = object.x + w / 2;
      const cy = object.y + h / 2;
      const center = { x: cx, y: cy };
      const ROT_OFFSET = 32 / view.boardScale;
      const localHandles = {
        tl:     { x: object.x,         y: object.y         },
        tr:     { x: object.x + w,     y: object.y         },
        bl:     { x: object.x,         y: object.y + h     },
        br:     { x: object.x + w,     y: object.y + h     },
        rotate: { x: object.x + w / 2, y: object.y - ROT_OFFSET },
      };
      return {
        tl:     rotatePoint(localHandles.tl,     center, object.rotation),
        tr:     rotatePoint(localHandles.tr,     center, object.rotation),
        bl:     rotatePoint(localHandles.bl,     center, object.rotation),
        br:     rotatePoint(localHandles.br,     center, object.rotation),
        rotate: rotatePoint(localHandles.rotate, center, object.rotation),
        center,
      };
    }, [view.boardScale]);

    const findObjectHandle = useCallback((point: DrawPoint, object: BoardImageObject): ObjectHandle | null => {
      const HIT = 14 / view.boardScale; // generous touch target
      const handles = getObjectHandlePositions(object);
      const order: ObjectHandle[] = ['rotate', 'tl', 'tr', 'bl', 'br'];
      for (const id of order) {
        const h = handles[id];
        if (Math.abs(point.x - h.x) <= HIT && Math.abs(point.y - h.y) <= HIT) return id;
      }
      return null;
    }, [view.boardScale, getObjectHandlePositions]);

    // Compute the new object after a resize drag from one of the corner handles.
    // Aspect ratio is preserved by scaling on the diagonal distance from the
    // opposite (anchor) corner to the current pointer. Works correctly when
    // the image is rotated: the anchor corner is computed in world space
    // (rotated), and the new (x, y) is back-solved so that the anchor stays
    // exactly in place after the resize.
    const applyObjectResize = useCallback((start: BoardImageObject, handle: ObjectHandle, point: DrawPoint): BoardImageObject => {
      if (handle === 'rotate') return start;
      const w = start.width * start.scale;
      const h = start.height * start.scale;
      const cx = start.x + w / 2;
      const cy = start.y + h / 2;
      const center = { x: cx, y: cy };
      // Anchor in image-local axis-aligned coords, then rotate into world space.
      const localAnchor =
        handle === 'tl' ? { x: start.x + w, y: start.y + h } :
        handle === 'tr' ? { x: start.x,     y: start.y + h } :
        handle === 'bl' ? { x: start.x + w, y: start.y     } :
        /* br */          { x: start.x,     y: start.y     };
      const anchorWorld = rotatePoint(localAnchor, center, start.rotation);

      // newScale from diagonal length (rotation preserves distances, so the
      // ratio is unchanged whether you compute in local or world space).
      const baseDiag = Math.hypot(start.width, start.height);
      const newDiag  = Math.hypot(point.x - anchorWorld.x, point.y - anchorWorld.y);
      const newScale = Math.max(newDiag / baseDiag, 0.05); // min 5%
      const newW = start.width * newScale;
      const newH = start.height * newScale;

      // After resize, the new image's local-anchor offset (relative to the new
      // centre) is at the same fractional corner. Rotate that offset into world
      // space, subtract from anchorWorld → that's the new world centre. Then
      // image-local top-left = newCentre - (newW/2, newH/2).
      const newLocalAnchorOffset =
        handle === 'tl' ? { x:  newW / 2, y:  newH / 2 } :
        handle === 'tr' ? { x: -newW / 2, y:  newH / 2 } :
        handle === 'bl' ? { x:  newW / 2, y: -newH / 2 } :
        /* br */          { x: -newW / 2, y: -newH / 2 };
      const rotatedOffset = rotatePoint(newLocalAnchorOffset, { x: 0, y: 0 }, start.rotation);
      const newCentre = { x: anchorWorld.x - rotatedOffset.x, y: anchorWorld.y - rotatedOffset.y };

      return {
        ...start,
        x: newCentre.x - newW / 2,
        y: newCentre.y - newH / 2,
        scale: newScale,
      };
    }, []);

    // Compute the new rotation in degrees from a rotation-handle drag.
    const applyObjectRotate = useCallback((start: BoardImageObject, point: DrawPoint): BoardImageObject => {
      const w = start.width * start.scale;
      const h = start.height * start.scale;
      const cx = start.x + w / 2;
      const cy = start.y + h / 2;
      // The handle starts directly above the centre, which by convention means
      // rotation = 0. atan2 of (handle - centre) when handle is "up" is -PI/2,
      // so add PI/2 to get a 0-aligned rotation.
      const angle = Math.atan2(point.y - cy, point.x - cx) + Math.PI / 2;
      return { ...start, rotation: (angle * 180) / Math.PI };
    }, []);

    const deleteStrokeIndices = useCallback((indices: number[]) => {
      const unique = Array.from(new Set(indices)).filter(index => index >= 0 && index < strokesRef.current.length).sort((a, b) => b - a);
      if (unique.length === 0) return;
      // Capture full stroke data so undo can re-add (server stores by index, but
      // we restore by appending the saved strokes back).
      const removedStrokes = unique.map(i => strokesRef.current[i]).filter(Boolean) as DrawStroke[];
      setStrokes(prev => prev.filter((_, index) => !unique.includes(index)));
      setSelectedStrokeIndex(prev => (prev !== null && unique.includes(prev)) ? null : prev);
      if (socket) socket.emit('whiteboard_delete_strokes', { roomId, strokeIndices: unique });
      recordAction({
        undo: () => {
          // Re-append all deleted strokes; emit them as new draws so peers also restore.
          setStrokes(prev => {
            const existingIds = new Set(prev.map(s => s.id));
            const additions = removedStrokes.filter(s => !existingIds.has(s.id));
            return [...prev, ...additions];
          });
          if (socket) {
            removedStrokes.forEach(stroke => socket.emit('whiteboard_draw', { roomId, stroke }));
          }
        },
        redo: () => {
          // Re-find current indices for these strokes (positions may have shifted)
          const idsToRemove = new Set(removedStrokes.map(s => s.id));
          const currentIndices: number[] = [];
          strokesRef.current.forEach((s, idx) => { if (idsToRemove.has(s.id ?? '')) currentIndices.push(idx); });
          if (currentIndices.length === 0) return;
          const sorted = currentIndices.sort((a, b) => b - a);
          setStrokes(prev => prev.filter((_, idx) => !sorted.includes(idx)));
          if (socket) socket.emit('whiteboard_delete_strokes', { roomId, strokeIndices: sorted });
        },
      });
    }, [socket, roomId, recordAction]);

    const eraseAtPoint = useCallback((point: DrawPoint) => {
      const radius = Math.max(width * 2.4, 18 / view.boardScale);
      const hits: number[] = [];
      strokesRef.current.forEach((stroke, index) => {
        if (erasedDuringDragRef.current.has(index)) return;
        for (let i = 0; i < stroke.points.length - 1; i++) {
          if (distanceToSegment(point, stroke.points[i], stroke.points[i + 1]) <= radius + stroke.width / 2) {
            hits.push(index);
            erasedDuringDragRef.current.add(index);
            break;
          }
        }
      });
      if (hits.length > 0) deleteStrokeIndices(hits);
    }, [deleteStrokeIndices, view.boardScale, width]);

    const findStrokeAtPoint = useCallback((point: DrawPoint): number => {
      for (let i = strokes.length - 1; i >= 0; i--) {
        const stroke = strokes[i];
        const hitDistance = stroke.width / 2 + 10 / view.boardScale;
        for (let j = 0; j < stroke.points.length - 1; j++) {
          if (distanceToSegment(point, stroke.points[j], stroke.points[j + 1]) <= hitDistance) return i;
        }
      }
      return -1;
    }, [strokes, view.boardScale]);

    const findObjectAt = useCallback((point: DrawPoint) => {
      for (const object of [...objects].sort((a, b) => b.zIndex - a.zIndex)) {
        const w = object.width * object.scale;
        const h = object.height * object.scale;
        if (point.x >= object.x && point.x <= object.x + w && point.y >= object.y && point.y <= object.y + h) return object;
      }
      return null;
    }, [objects]);

    const strokeBounds = useCallback((stroke: DrawStroke) => {
      if (stroke.points.length === 0) return null;
      const xs = stroke.points.map(point => point.x);
      const ys = stroke.points.map(point => point.y);
      const pad = stroke.width + 8 / view.boardScale;
      return {
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        w: Math.max(...xs) - Math.min(...xs) + pad * 2,
        h: Math.max(...ys) - Math.min(...ys) + pad * 2,
      };
    }, [view.boardScale]);

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
      // Infinite canvas: fill the entire visible area with white (no fixed
      // page background), then draw grid lines for whatever board-space
      // rectangle is currently visible. Pan and zoom are unbounded.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, widthPx, heightPx);
      ctx.save();
      ctx.translate(view.boardOffsetX, view.boardOffsetY);
      ctx.scale(view.boardScale, view.boardScale);

      const visMinX = -view.boardOffsetX / view.boardScale;
      const visMaxX = (widthPx - view.boardOffsetX) / view.boardScale;
      const visMinY = -view.boardOffsetY / view.boardScale;
      const visMaxY = (heightPx - view.boardOffsetY) / view.boardScale;
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1 / view.boardScale;
      const gridStartX = Math.floor(visMinX / GRID_STEP) * GRID_STEP;
      const gridEndX   = Math.ceil(visMaxX  / GRID_STEP) * GRID_STEP;
      const gridStartY = Math.floor(visMinY / GRID_STEP) * GRID_STEP;
      const gridEndY   = Math.ceil(visMaxY  / GRID_STEP) * GRID_STEP;
      for (let x = gridStartX; x <= gridEndX; x += GRID_STEP) {
        ctx.beginPath();
        ctx.moveTo(x, gridStartY);
        ctx.lineTo(x, gridEndY);
        ctx.stroke();
      }
      for (let y = gridStartY; y <= gridEndY; y += GRID_STEP) {
        ctx.beginPath();
        ctx.moveTo(gridStartX, y);
        ctx.lineTo(gridEndX, y);
        ctx.stroke();
      }

      [...objects].sort((a, b) => a.zIndex - b.zIndex).forEach(object => {
        const img = imageCacheRef.current.get(object.id);
        if (img?.complete) {
          ctx.save();
          ctx.translate(object.x + (object.width * object.scale) / 2, object.y + (object.height * object.scale) / 2);
          ctx.rotate((object.rotation * Math.PI) / 180);
          ctx.drawImage(img, -(object.width * object.scale) / 2, -(object.height * object.scale) / 2, object.width * object.scale, object.height * object.scale);
          ctx.restore();
        }
        if (object.id === selectedObjectId) {
          const w = object.width * object.scale;
          const h = object.height * object.scale;
          const cx = object.x + w / 2;
          const cy = object.y + h / 2;
          // Dashed selection rectangle — rotated with the image.
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate((object.rotation * Math.PI) / 180);
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2 / view.boardScale;
          ctx.setLineDash([10 / view.boardScale, 7 / view.boardScale]);
          ctx.strokeRect(-w / 2, -h / 2, w, h);
          ctx.restore();

          // Resize + rotate handles. Positions are already rotated into world
          // space by getObjectHandlePositions; the corner squares themselves
          // are also drawn rotated so they look square against the image.
          ctx.save();
          ctx.setLineDash([]);
          const handles = getObjectHandlePositions(object);
          const HANDLE = 11 / view.boardScale;
          const HALF = HANDLE / 2;
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 1.5 / view.boardScale;
          // Connector line from the (rotated) top-edge midpoint to the rotation handle
          const topMidLocal = { x: object.x + w / 2, y: object.y };
          const topMid = rotatePoint(topMidLocal, { x: cx, y: cy }, object.rotation);
          ctx.beginPath();
          ctx.moveTo(topMid.x, topMid.y);
          ctx.lineTo(handles.rotate.x, handles.rotate.y);
          ctx.stroke();
          // Corner squares — rotated with the image so they don't look skewed
          (['tl', 'tr', 'bl', 'br'] as const).forEach(id => {
            const p = handles[id];
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((object.rotation * Math.PI) / 180);
            ctx.fillRect(-HALF, -HALF, HANDLE, HANDLE);
            ctx.strokeRect(-HALF, -HALF, HANDLE, HANDLE);
            ctx.restore();
          });
          // Rotation handle (circle — rotation-invariant, no extra transform)
          ctx.beginPath();
          ctx.arc(handles.rotate.x, handles.rotate.y, HALF, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      });

      // ── Shapes (between images and ink) ──
      const drawShape = (shape: BoardShape) => {
        ctx.save();
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (shape.kind === 'rect') {
          const x = Math.min(shape.x1, shape.x2);
          const y = Math.min(shape.y1, shape.y2);
          const w = Math.abs(shape.x2 - shape.x1);
          const h = Math.abs(shape.y2 - shape.y1);
          ctx.strokeRect(x, y, w, h);
        } else if (shape.kind === 'circle') {
          const r = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
          ctx.beginPath();
          ctx.arc(shape.x1, shape.y1, r, 0, Math.PI * 2);
          ctx.stroke();
        } else if (shape.kind === 'line' || shape.kind === 'arrow') {
          ctx.beginPath();
          ctx.moveTo(shape.x1, shape.y1);
          ctx.lineTo(shape.x2, shape.y2);
          ctx.stroke();
          if (shape.kind === 'arrow') {
            // Arrowhead at (x2,y2). Length scales with line width.
            const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
            const headLen = Math.max(shape.width * 4, 14);
            const headAngle = Math.PI / 7;
            ctx.beginPath();
            ctx.moveTo(shape.x2, shape.y2);
            ctx.lineTo(shape.x2 - headLen * Math.cos(angle - headAngle), shape.y2 - headLen * Math.sin(angle - headAngle));
            ctx.moveTo(shape.x2, shape.y2);
            ctx.lineTo(shape.x2 - headLen * Math.cos(angle + headAngle), shape.y2 - headLen * Math.sin(angle + headAngle));
            ctx.stroke();
          }
        }
        ctx.restore();
      };
      shapes.forEach(drawShape);
      if (draftShape) drawShape(draftShape);
      if (selectedShape) {
        const b = shapeBounds(selectedShape);
        ctx.save();
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2 / view.boardScale;
        ctx.setLineDash([8 / view.boardScale, 6 / view.boardScale]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      }

      const drawStroke = (stroke: DrawStroke) => {
        if (stroke.points.length === 0) return;
        ctx.save();
        if (stroke.tool === 'eraser-pixel') {
          // Pixel eraser: cut a hole in everything currently on the canvas
          // along this stroke path.
          ctx.globalCompositeOperation = 'destination-out';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = stroke.width;
        } else if (stroke.tool === 'highlighter') {
          // Highlighter: chunky translucent stroke that holds full opacity for
          // HIGHLIGHTER_HOLD_MS, then linearly fades over the rest of
          // HIGHLIGHTER_FADE_MS, then is removed entirely by the cleanup tick.
          const age = Date.now() - (stroke.createdAt ?? Date.now());
          let alpha = 0.55;
          if (age > HIGHLIGHTER_HOLD_MS) {
            const fadeAge = age - HIGHLIGHTER_HOLD_MS;
            const fadeDur = HIGHLIGHTER_FADE_MS - HIGHLIGHTER_HOLD_MS;
            alpha = 0.55 * Math.max(0, 1 - fadeAge / fadeDur);
          }
          if (alpha <= 0) { ctx.restore(); return; }
          ctx.globalAlpha = alpha;
          ctx.globalCompositeOperation = 'multiply';
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.width;
        } else {
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.width;
        }
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        stroke.points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
        ctx.stroke();
        ctx.restore();
      };
      strokes.forEach(drawStroke);
      // Live preview while drawing (pen / pixel-eraser / highlighter)
      if (currentStroke.length > 0) {
        if (tool === 'pen') {
          drawStroke({ id: 'current', points: currentStroke, color, width, tool: 'pen' });
        } else if (tool === 'eraser' && eraserMode === 'pixel') {
          drawStroke({ id: 'current', points: currentStroke, color, width, tool: 'eraser-pixel' });
        } else if (tool === 'highlighter') {
          drawStroke({
            id: 'current',
            points: currentStroke,
            color: '#FACC15',
            width: Math.max(width * 3, 14),
            tool: 'highlighter',
            createdAt: Date.now(),
          });
        }
      }
      if (selectedStrokeIndex !== null && strokes[selectedStrokeIndex]) {
        const bounds = strokeBounds(strokes[selectedStrokeIndex]);
        if (bounds) {
          ctx.save();
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2 / view.boardScale;
          ctx.setLineDash([8 / view.boardScale, 6 / view.boardScale]);
          ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
          ctx.restore();
        }
      }

      // ── Multi-select highlights (no individual handles, just dashed rects) ──
      if (multiObjectIds.length > 0 || multiShapeIds.length > 0 || multiStrokeIndices.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.6 / view.boardScale;
        ctx.setLineDash([8 / view.boardScale, 5 / view.boardScale]);
        const objectIdSet = new Set(multiObjectIds);
        objects.forEach(o => {
          if (!objectIdSet.has(o.id)) return;
          ctx.strokeRect(o.x, o.y, o.width * o.scale, o.height * o.scale);
        });
        const shapeIdSet = new Set(multiShapeIds);
        shapes.forEach(s => {
          if (!shapeIdSet.has(s.id)) return;
          const b = shapeBounds(s);
          ctx.strokeRect(b.x, b.y, b.w, b.h);
        });
        const strokeIdxSet = new Set(multiStrokeIndices);
        strokes.forEach((s, idx) => {
          if (!strokeIdxSet.has(idx)) return;
          const b = strokeBounds(s);
          if (b) ctx.strokeRect(b.x, b.y, b.w, b.h);
        });
        ctx.restore();
      }

      // ── Marquee rectangle (live during drag) ──
      if (marquee) {
        const minX = Math.min(marquee.x1, marquee.x2);
        const minY = Math.min(marquee.y1, marquee.y2);
        const maxX = Math.max(marquee.x1, marquee.x2);
        const maxY = Math.max(marquee.y1, marquee.y2);
        ctx.save();
        ctx.fillStyle = 'rgba(37, 99, 235, 0.08)';
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.4 / view.boardScale;
        ctx.setLineDash([6 / view.boardScale, 4 / view.boardScale]);
        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
        ctx.restore();
      }

      ctx.restore();
    }, [objects, selectedObjectId, selectedStrokeIndex, strokeBounds, strokes, currentStroke, color, width, tool, view, shapes, draftShape, selectedShape, shapeBounds, getObjectHandlePositions, marquee, multiObjectIds, multiShapeIds, multiStrokeIndices, eraserMode]);

    const downloadBoard = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const link = document.createElement('a');
      link.download = `whiteboard-${Date.now()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    }, []);

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
        setSelectedStrokeIndex(null);
        imageCacheRef.current.clear();
        if (socket && isTeacher) socket.emit('whiteboard_clear', { roomId });
      },
      clearDrawings: () => {
        setStrokes([]);
        setSelectedStrokeIndex(null);
        if (socket && isTeacher) socket.emit('whiteboard_reset', { roomId });
      },
      download: () => downloadBoard(),
      getCanvas: () => canvasRef.current,
    }), [addImageObject, downloadBoard, socket, isTeacher, roomId]);

    useEffect(() => {
      if (!initialState) return;
      const normalized = (initialState.strokes || []).map(stroke => ({ ...stroke, id: stroke.id || newId('stroke'), tool: 'pen' as const }));
      setObjects(initialState.objects || []);
      setStrokes(normalized);
      setShapes(initialState.shapes || []);
      if (initialState.view) setView(initialState.view);
      (initialState.objects || []).forEach(loadImage);
    }, [initialState, loadImage]);

    useEffect(() => {
      objects.forEach(loadImage);
      redrawCanvas();
    }, [objects, loadImage, redrawCanvas]);

    useEffect(() => {
      redrawCanvas();
    }, [redrawCanvas]);

    useEffect(() => {
      if (!isActive) return;
      const resize = () => {
        if (objects.length === 0 && strokes.length === 0 && shapes.length === 0) setView(getInitialView());
        redrawCanvas();
      };
      resize();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, [isActive, getInitialView, redrawCanvas, objects.length, strokes.length, shapes.length]);

    useEffect(() => {
      if (!isActive) return;
      const down = (e: KeyboardEvent) => {
        if (e.code === 'Space') {
          setSpacePan(true);
          e.preventDefault();
        }
        if ((e.key === 'Backspace' || e.key === 'Delete') && canEdit) {
          if (selectedObjectId) removeSelectedObject();
          if (selectedStrokeIndex !== null) deleteStrokeIndices([selectedStrokeIndex]);
          if (selectedShapeId) removeSelectedShape();
          if (multiObjectIds.length > 0 || multiShapeIds.length > 0 || multiStrokeIndices.length > 0) {
            removeMultiSelection();
          }
        }
        if (e.key === 'Escape') {
          setSelectedObjectId(null);
          setSelectedShapeId(null);
          setSelectedStrokeIndex(null);
          clearMultiSelection();
        }
        // Undo / Redo (ignore when typing into an input/textarea — none in
        // this component today, but keeps it future-proof).
        if (canEdit && (e.ctrlKey || e.metaKey)) {
          const target = e.target as HTMLElement | null;
          const isEditing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
          if (!isEditing) {
            // Ctrl+Z = undo. Ctrl+Shift+Z OR Ctrl+Y = redo.
            const key = e.key.toLowerCase();
            if (key === 'z' && !e.shiftKey) {
              e.preventDefault();
              undo();
            } else if ((key === 'z' && e.shiftKey) || key === 'y') {
              e.preventDefault();
              redo();
            }
          }
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
    }, [isActive, canEdit, selectedObjectId, selectedStrokeIndex, selectedShapeId, removeSelectedObject, deleteStrokeIndices, removeSelectedShape, multiObjectIds.length, multiShapeIds.length, multiStrokeIndices.length, removeMultiSelection, clearMultiSelection, undo, redo]);

    useEffect(() => {
      if (!socket) return;
      const handleImage = (data: { imageUrl: string }) => {
        if (!data.imageUrl) return;
        const img = new Image();
        img.onload = () => addImageObject(data.imageUrl, img.naturalWidth, img.naturalHeight);
        img.src = data.imageUrl;
      };
      const handleAddImage = (data: { object: BoardImageObject }) => {
        setObjects(prev => prev.some(obj => obj.id === data.object.id) ? prev : [...prev, data.object]);
        loadImage(data.object);
      };
      const handleUpdateObject = (data: { object: BoardImageObject }) => {
        setObjects(prev => prev.map(obj => obj.id === data.object.id ? data.object : obj));
        loadImage(data.object);
      };
      const handleRemoveObject = (data: { objectId: string }) => {
        setObjects(prev => prev.filter(obj => obj.id !== data.objectId));
        imageCacheRef.current.delete(data.objectId);
        setSelectedObjectId(prev => prev === data.objectId ? null : prev);
      };
      const handleSetView = (data: { view: BoardView }) => setView(data.view);
      const handleStroke = (data: { stroke: DrawStroke }) => {
        const stroke = { ...data.stroke, id: data.stroke.id || newId('stroke'), tool: 'pen' as const };
        setStrokes(prev => prev.some(existing => existing.id === stroke.id) ? prev : [...prev, stroke]);
      };
      const handleAddShape = (data: { shape: BoardShape }) => {
        setShapes(prev => prev.some(s => s.id === data.shape.id) ? prev : [...prev, data.shape]);
      };
      const handleUpdateShape = (data: { shape: BoardShape }) => {
        setShapes(prev => prev.map(s => s.id === data.shape.id ? data.shape : s));
      };
      const handleRemoveShape = (data: { shapeId: string }) => {
        setShapes(prev => prev.filter(s => s.id !== data.shapeId));
        setSelectedShapeId(prev => prev === data.shapeId ? null : prev);
      };
      const handleClear = () => {
        setStrokes([]);
        setObjects([]);
        setShapes([]);
        setSelectedObjectId(null);
        setSelectedStrokeIndex(null);
        setSelectedShapeId(null);
        imageCacheRef.current.clear();
      };
      const handleReset = () => {
        setStrokes([]);
        setSelectedStrokeIndex(null);
      };
      const handleDeleteStroke = (data: { strokeIndex: number }) => {
        setStrokes(prev => prev.filter((_, index) => index !== data.strokeIndex));
      };
      const handleDeleteStrokes = (data: { strokeIndices: number[] }) => {
        const toDelete = new Set(data.strokeIndices || []);
        setStrokes(prev => prev.filter((_, index) => !toDelete.has(index)));
      };
      socket.on('whiteboard_image', handleImage);
      socket.on('whiteboard_add_image', handleAddImage);
      socket.on('whiteboard_update_object', handleUpdateObject);
      socket.on('whiteboard_remove_object', handleRemoveObject);
      socket.on('whiteboard_add_shape', handleAddShape);
      socket.on('whiteboard_update_shape', handleUpdateShape);
      socket.on('whiteboard_remove_shape', handleRemoveShape);
      socket.on('whiteboard_set_view', handleSetView);
      socket.on('whiteboard_stroke', handleStroke);
      socket.on('whiteboard_clear', handleClear);
      socket.on('whiteboard_reset', handleReset);
      socket.on('whiteboard_delete_stroke', handleDeleteStroke);
      socket.on('whiteboard_delete_strokes', handleDeleteStrokes);
      return () => {
        socket.off('whiteboard_image', handleImage);
        socket.off('whiteboard_add_image', handleAddImage);
        socket.off('whiteboard_update_object', handleUpdateObject);
        socket.off('whiteboard_remove_object', handleRemoveObject);
        socket.off('whiteboard_add_shape', handleAddShape);
        socket.off('whiteboard_update_shape', handleUpdateShape);
        socket.off('whiteboard_remove_shape', handleRemoveShape);
        socket.off('whiteboard_set_view', handleSetView);
        socket.off('whiteboard_stroke', handleStroke);
        socket.off('whiteboard_clear', handleClear);
        socket.off('whiteboard_reset', handleReset);
        socket.off('whiteboard_delete_stroke', handleDeleteStroke);
        socket.off('whiteboard_delete_strokes', handleDeleteStrokes);
      };
    }, [socket, addImageObject, loadImage]);

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!canEdit) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const point = screenToBoard(e.clientX, e.clientY);
      const shouldPan = tool === 'pan' || spacePan || e.button === 1;
      if (shouldPan) {
        dragRef.current = { mode: 'pan', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
        return;
      }
      if (tool === 'eraser') {
        if (eraserMode === 'stroke') {
          erasedDuringDragRef.current = new Set();
          dragRef.current = { mode: 'erase', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
          eraseAtPoint(point);
          return;
        }
        // Pixel-eraser: behave exactly like pen, but the resulting stroke is
        // tagged 'eraser-pixel' so render-time uses destination-out compositing.
        setSelectedObjectId(null);
        setSelectedStrokeIndex(null);
        setSelectedShapeId(null);
        dragRef.current = { mode: 'draw', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
        setLiveStroke([point]);
        return;
      }
      if (tool === 'select') {
        // Handle hit-test first — if an image is already selected, the user
        // may be grabbing a corner/rotate handle rather than the body.
        if (selectedObjectId) {
          const sel = objects.find(o => o.id === selectedObjectId);
          if (sel) {
            const handle = findObjectHandle(point, sel);
            if (handle) {
              dragRef.current = {
                mode: handle === 'rotate' ? 'object-rotate' : 'object-resize',
                pointerId: e.pointerId,
                startClientX: e.clientX, startClientY: e.clientY,
                startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY,
                objectId: sel.id,
                objectStart: { ...sel },
                handle,
              };
              return;
            }
          }
        }
        const hitObject = findObjectAt(point);
        if (hitObject) {
          setSelectedObjectId(hitObject.id);
          setSelectedStrokeIndex(null);
          setSelectedShapeId(null);
          dragRef.current = { mode: 'object', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY, objectId: hitObject.id, objectStartX: hitObject.x, objectStartY: hitObject.y };
          return;
        }
        const hitShape = findShapeAt(point);
        if (hitShape) {
          setSelectedShapeId(hitShape.id);
          setSelectedObjectId(null);
          setSelectedStrokeIndex(null);
          dragRef.current = {
            mode: 'shape-move',
            pointerId: e.pointerId,
            startClientX: e.clientX, startClientY: e.clientY,
            startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY,
            shapeId: hitShape.id,
            shapeStart: { x1: hitShape.x1, y1: hitShape.y1, x2: hitShape.x2, y2: hitShape.y2 },
          };
          return;
        }
        const strokeIndex = findStrokeAtPoint(point);
        if (strokeIndex !== -1) {
          setSelectedObjectId(null);
          setSelectedShapeId(null);
          setSelectedStrokeIndex(strokeIndex);
          clearMultiSelection();
          return;
        }
        // Nothing under the cursor — start a marquee multi-select drag.
        setSelectedObjectId(null);
        setSelectedShapeId(null);
        setSelectedStrokeIndex(null);
        clearMultiSelection();
        setMarquee({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        dragRef.current = { mode: 'marquee', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
        return;
      }
      if (isShapeTool(tool)) {
        setSelectedObjectId(null);
        setSelectedStrokeIndex(null);
        setSelectedShapeId(null);
        const draft: BoardShape = { id: newId('shape'), kind: tool as ShapeKind, x1: point.x, y1: point.y, x2: point.x, y2: point.y, color, width };
        setDraftShape(draft);
        dragRef.current = { mode: 'shape-create', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY, shapeId: draft.id };
        return;
      }
      setSelectedObjectId(null);
      setSelectedStrokeIndex(null);
      setSelectedShapeId(null);
      dragRef.current = { mode: 'draw', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
      setLiveStroke([point]);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (drag.mode === 'pan') {
        setView({ ...view, boardOffsetX: drag.startOffsetX + e.clientX - drag.startClientX, boardOffsetY: drag.startOffsetY + e.clientY - drag.startClientY });
        return;
      }
      if (drag.mode === 'erase') {
        eraseAtPoint(screenToBoard(e.clientX, e.clientY));
        return;
      }
      if (drag.mode === 'object' && drag.objectId) {
        const object = objects.find(obj => obj.id === drag.objectId);
        if (!object) return;
        const dx = (e.clientX - drag.startClientX) / view.boardScale;
        const dy = (e.clientY - drag.startClientY) / view.boardScale;
        setObjects(prev => prev.map(obj => obj.id === drag.objectId ? { ...obj, x: (drag.objectStartX || 0) + dx, y: (drag.objectStartY || 0) + dy } : obj));
        return;
      }
      if (drag.mode === 'object-resize' && drag.objectStart && drag.handle) {
        const point = screenToBoard(e.clientX, e.clientY);
        const next = applyObjectResize(drag.objectStart, drag.handle, point);
        setObjects(prev => prev.map(obj => obj.id === drag.objectId ? next : obj));
        return;
      }
      if (drag.mode === 'object-rotate' && drag.objectStart) {
        const point = screenToBoard(e.clientX, e.clientY);
        const next = applyObjectRotate(drag.objectStart, point);
        setObjects(prev => prev.map(obj => obj.id === drag.objectId ? next : obj));
        return;
      }
      if (drag.mode === 'shape-create' && draftShapeRef.current) {
        const point = screenToBoard(e.clientX, e.clientY);
        const next = { ...draftShapeRef.current, x2: point.x, y2: point.y };
        setDraftShape(next);
        return;
      }
      if (drag.mode === 'marquee') {
        const point = screenToBoard(e.clientX, e.clientY);
        setMarquee(m => m ? { ...m, x2: point.x, y2: point.y } : null);
        return;
      }
      if (drag.mode === 'shape-move' && drag.shapeId && drag.shapeStart) {
        const dx = (e.clientX - drag.startClientX) / view.boardScale;
        const dy = (e.clientY - drag.startClientY) / view.boardScale;
        const start = drag.shapeStart;
        setShapes(prev => prev.map(s => s.id === drag.shapeId ? {
          ...s,
          x1: start.x1 + dx, y1: start.y1 + dy,
          x2: start.x2 + dx, y2: start.y2 + dy,
        } : s));
        return;
      }
      if (drag.mode === 'draw') setLiveStroke([...currentStrokeRef.current, screenToBoard(e.clientX, e.clientY)]);
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
      if (drag.mode === 'draw' && currentStrokeRef.current.length > 1) {
        const strokeTool: DrawStroke['tool'] =
          (tool === 'eraser' && eraserMode === 'pixel') ? 'eraser-pixel' :
          tool === 'highlighter' ? 'highlighter' :
          'pen';
        const stroke: DrawStroke = {
          id: newId('stroke'),
          points: currentStrokeRef.current,
          color: strokeTool === 'highlighter' ? '#FACC15' /* warm yellow highlighter */ : color,
          width: strokeTool === 'highlighter' ? Math.max(width * 3, 14) /* chunky highlighter */ : width,
          tool: strokeTool,
          ...(strokeTool === 'highlighter' ? { createdAt: Date.now() } : {}),
        };
        setStrokes(prev => [...prev, stroke]);
        if (socket) socket.emit('whiteboard_draw', { roomId, stroke });
        // Highlighter strokes are ephemeral by design — don't put them on the
        // undo stack (they auto-disappear), so undoing wouldn't make sense.
        if (strokeTool !== 'highlighter') {
          recordAction({
            undo: () => {
              const idx = strokesRef.current.findIndex(s => s.id === stroke.id);
              if (idx < 0) return;
              setStrokes(prev => prev.filter(s => s.id !== stroke.id));
              if (socket) socket.emit('whiteboard_delete_strokes', { roomId, strokeIndices: [idx] });
            },
            redo: () => {
              setStrokes(prev => prev.some(s => s.id === stroke.id) ? prev : [...prev, stroke]);
              if (socket) socket.emit('whiteboard_draw', { roomId, stroke });
            },
          });
        }
      }
      if (drag.mode === 'object' && drag.objectId) {
        const object = objects.find(obj => obj.id === drag.objectId);
        if (object) {
          updateObject(object);
          // Record move for undo (image position only)
          const before: BoardImageObject = { ...object, x: drag.objectStartX || 0, y: drag.objectStartY || 0 };
          const after: BoardImageObject = { ...object };
          recordAction({
            undo: () => {
              setObjects(prev => prev.map(o => o.id === before.id ? before : o));
              if (socket && isTeacher) socket.emit('whiteboard_update_object', { roomId, object: before });
            },
            redo: () => {
              setObjects(prev => prev.map(o => o.id === after.id ? after : o));
              if (socket && isTeacher) socket.emit('whiteboard_update_object', { roomId, object: after });
            },
          });
        }
      }
      if ((drag.mode === 'object-resize' || drag.mode === 'object-rotate') && drag.objectId && drag.objectStart) {
        const object = objects.find(obj => obj.id === drag.objectId);
        if (object) {
          updateObject(object);
          const before: BoardImageObject = { ...drag.objectStart };
          const after: BoardImageObject = { ...object };
          recordAction({
            undo: () => {
              setObjects(prev => prev.map(o => o.id === before.id ? before : o));
              if (socket && isTeacher) socket.emit('whiteboard_update_object', { roomId, object: before });
            },
            redo: () => {
              setObjects(prev => prev.map(o => o.id === after.id ? after : o));
              if (socket && isTeacher) socket.emit('whiteboard_update_object', { roomId, object: after });
            },
          });
        }
      }
      if (drag.mode === 'shape-create' && draftShapeRef.current) {
        const finished = draftShapeRef.current;
        // Reject zero-length shapes (a stray click).
        const minDelta = 4 / view.boardScale;
        const dx = Math.abs(finished.x2 - finished.x1);
        const dy = Math.abs(finished.y2 - finished.y1);
        if (dx > minDelta || dy > minDelta) {
          setShapes(prev => [...prev, finished]);
          if (socket && isTeacher) socket.emit('whiteboard_add_shape', { roomId, shape: finished });
          setSelectedShapeId(finished.id);
          setTool('select');
          recordAction({
            undo: () => {
              setShapes(prev => prev.filter(s => s.id !== finished.id));
              if (socket && isTeacher) socket.emit('whiteboard_remove_shape', { roomId, shapeId: finished.id });
            },
            redo: () => {
              setShapes(prev => prev.some(s => s.id === finished.id) ? prev : [...prev, finished]);
              if (socket && isTeacher) socket.emit('whiteboard_add_shape', { roomId, shape: finished });
            },
          });
        }
        setDraftShape(null);
      }
      if (drag.mode === 'shape-move' && drag.shapeId && drag.shapeStart) {
        const moved = shapes.find(s => s.id === drag.shapeId);
        if (moved && socket && isTeacher) {
          socket.emit('whiteboard_update_shape', { roomId, shape: moved });
          const before: BoardShape = { ...moved, ...drag.shapeStart };
          const after: BoardShape = { ...moved };
          recordAction({
            undo: () => {
              setShapes(prev => prev.map(s => s.id === before.id ? before : s));
              if (socket && isTeacher) socket.emit('whiteboard_update_shape', { roomId, shape: before });
            },
            redo: () => {
              setShapes(prev => prev.map(s => s.id === after.id ? after : s));
              if (socket && isTeacher) socket.emit('whiteboard_update_shape', { roomId, shape: after });
            },
          });
        }
      }
      if (drag.mode === 'marquee') {
        const m = marqueeRef.current;
        if (m) {
          const minX = Math.min(m.x1, m.x2);
          const minY = Math.min(m.y1, m.y2);
          const maxX = Math.max(m.x1, m.x2);
          const maxY = Math.max(m.y1, m.y2);
          // Treat anything below ~4px as a stray click; clear selection only.
          const minDelta = 4 / view.boardScale;
          if ((maxX - minX) > minDelta || (maxY - minY) > minDelta) {
            const marqueeRect: AABB = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
            const hitObjects = objects
              .filter(o => rectsOverlap(marqueeRect, { x: o.x, y: o.y, w: o.width * o.scale, h: o.height * o.scale }))
              .map(o => o.id);
            const hitShapes = shapes
              .filter(s => rectsOverlap(marqueeRect, shapeBounds(s)))
              .map(s => s.id);
            const hitStrokes: number[] = [];
            strokes.forEach((s, i) => {
              const b = strokeBounds(s);
              if (b && rectsOverlap(marqueeRect, b)) hitStrokes.push(i);
            });
            setMultiObjectIds(hitObjects);
            setMultiShapeIds(hitShapes);
            setMultiStrokeIndices(hitStrokes);
          }
        }
        setMarquee(null);
      }
      if (drag.mode === 'pan') emitView(view);
      setLiveStroke([]);
      erasedDuringDragRef.current = new Set();
      dragRef.current = null;
    };

    const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      } else {
        setSyncedView({ ...view, boardOffsetX: view.boardOffsetX - e.deltaX, boardOffsetY: view.boardOffsetY - e.deltaY });
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

    const clearInk = () => {
      setStrokes([]);
      setSelectedStrokeIndex(null);
      if (socket && isTeacher) socket.emit('whiteboard_reset', { roomId });
    };

    const clearBoard = () => {
      setObjects([]);
      setStrokes([]);
      setShapes([]);
      setSelectedObjectId(null);
      setSelectedStrokeIndex(null);
      setSelectedShapeId(null);
      imageCacheRef.current.clear();
      if (socket && isTeacher) socket.emit('whiteboard_clear', { roomId });
    };

    const centerSelection = () => {
      const container = containerRef.current;
      const target = selectedObject || objects[objects.length - 1];
      if (!container || !target) return fitBoard();
      const scale = clamp(Math.min(container.clientWidth / (target.width * target.scale), container.clientHeight / (target.height * target.scale)) * 0.82, MIN_SCALE, MAX_SCALE);
      setSyncedView({
        boardScale: scale,
        boardOffsetX: container.clientWidth / 2 - (target.x + (target.width * target.scale) / 2) * scale,
        boardOffsetY: container.clientHeight / 2 - (target.y + (target.height * target.scale) / 2) * scale,
      });
    };

    // Legacy "undo just the most recent stroke" helper, kept only for any
    // external caller. The toolbar now uses the proper undo/redo system.
    const undoLastStroke = () => deleteStrokeIndices([strokes.length - 1]);
    void undoLastStroke;

    if (!isActive) return null;

    const tools: Array<{ id: BoardTool; label: string; icon: React.ReactNode }> = [
      { id: 'select', label: 'Select', icon: <path d="M4 4l7 16 2-7 7-2L4 4z" /> },
      { id: 'pen', label: 'Pen', icon: <path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5L17 3z" /> },
      // Highlighter — fades after a few seconds. Chunky marker icon.
      { id: 'highlighter', label: 'Highlighter', icon: <><path d="M9 11l-4 4v3h3l4-4" /><path d="M11 9l5-5 4 4-5 5z" /><path d="M14 6l4 4" /></> },
      { id: 'line', label: 'Line', icon: <path d="M5 19L19 5" /> },
      { id: 'rect', label: 'Rectangle', icon: <rect x="4" y="6" width="16" height="12" /> },
      { id: 'circle', label: 'Circle', icon: <circle cx="12" cy="12" r="8" /> },
      { id: 'arrow', label: 'Arrow', icon: <><path d="M5 19L19 5" /><path d="M12 5h7v7" /></> },
      { id: 'eraser', label: 'Eraser', icon: <><path d="m7 21-4-4 11-11 4 4L7 21z" /><path d="M14 6l4-4 4 4-4 4" /><path d="M3 21h18" /></> },
      { id: 'pan', label: 'Hand', icon: <><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v8" /><path d="M10 12V6a2 2 0 0 0-4 0v7" /><path d="M6 13c-2 0-3 1-3 3 0 4 4 6 8 6h3c4 0 7-3 7-7v-4a2 2 0 0 0-4 0" /></> },
    ];

    const toolChip =
      tool === 'eraser' ? (eraserMode === 'pixel' ? 'Erase pixels — drag across content' : 'Erase whole stroke — click on a stroke') :
      tool === 'pan' ? 'Move board' :
      tool === 'select' ? 'Select and arrange' :
      tool === 'line' ? 'Draw line — click and drag' :
      tool === 'rect' ? 'Draw rectangle — click and drag' :
      tool === 'circle' ? 'Draw circle — click and drag from centre' :
      tool === 'arrow' ? 'Draw arrow — click and drag from start to head' :
      tool === 'highlighter' ? 'Highlighter — fades away after a few seconds' :
      'Draw ink';

    const showColorAndWidth = tool === 'pen' || isShapeTool(tool);

    return (
      <div className="whiteboard-shell">
        <input ref={uploadInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />

        {canEdit && (
          <aside className="whiteboard-rail" aria-label="Whiteboard tools">
            {tools.map(item => (
              <button
                key={item.id}
                onClick={() => setTool(item.id)}
                className={`whiteboard-tool ${tool === item.id ? 'active' : ''}`}
                title={item.label}
                aria-label={item.label}
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  {item.icon}
                </svg>
                <span>{item.label}</span>
              </button>
            ))}
            <div className="whiteboard-rail-divider" />
            <button onClick={() => uploadInputRef.current?.click()} className="whiteboard-tool" title="Upload image">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              </svg>
              <span>Image</span>
            </button>
          </aside>
        )}

        <div className="whiteboard-topbar">
          <div className="whiteboard-chip">{toolChip}</div>
          {tool === 'eraser' && (
            <div className="whiteboard-control-group" role="group" aria-label="Eraser mode">
              <button
                onClick={() => setEraserMode('stroke')}
                className={`whiteboard-action ${eraserMode === 'stroke' ? 'active' : ''}`}
                title="Click on a stroke to delete the whole stroke"
              >Stroke</button>
              <button
                onClick={() => setEraserMode('pixel')}
                className={`whiteboard-action ${eraserMode === 'pixel' ? 'active' : ''}`}
                title="Drag across content to erase pixels (precise eraser)"
              >Pixel</button>
            </div>
          )}
          {showColorAndWidth && (
            <div className="whiteboard-control-group">
              {COLORS.map(c => (
                <button key={c} onClick={() => setColor(c)} className={`whiteboard-swatch ${color === c ? 'active' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} />
              ))}
            </div>
          )}
          {(showColorAndWidth || tool === 'eraser') && (
            <div className="whiteboard-control-group">
              {WIDTHS.map(w => (
                <button key={w} onClick={() => setWidth(w)} className={`whiteboard-size ${width === w ? 'active' : ''}`}>
                  <span style={{ width: w, height: w }} />
                </button>
              ))}
            </div>
          )}
          <div className="whiteboard-spacer" />
          {canEdit && selectedObject && <button onClick={removeSelectedObject} className="whiteboard-action danger">Delete image</button>}
          {canEdit && selectedShape && <button onClick={removeSelectedShape} className="whiteboard-action danger">Delete shape</button>}
          {canEdit && selectedStrokeIndex !== null && <button onClick={() => deleteStrokeIndices([selectedStrokeIndex])} className="whiteboard-action danger">Delete stroke</button>}
          {canEdit && (multiObjectIds.length + multiShapeIds.length + multiStrokeIndices.length) > 0 && (
            <button onClick={removeMultiSelection} className="whiteboard-action danger">
              Delete {multiObjectIds.length + multiShapeIds.length + multiStrokeIndices.length} items
            </button>
          )}
          {canEdit && (
            <>
              <button onClick={undo} disabled={!canUndo} className="whiteboard-action" title="Undo (Ctrl+Z)">↶ Undo</button>
              <button onClick={redo} disabled={!canRedo} className="whiteboard-action" title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
            </>
          )}
          <button onClick={() => zoomAt(1 / 1.2)} className="whiteboard-action">-</button>
          <button onClick={fitBoard} className="whiteboard-action">{Math.round(view.boardScale * 100)}%</button>
          <button onClick={() => zoomAt(1.2)} className="whiteboard-action">+</button>
          <button onClick={centerSelection} className="whiteboard-action">Center</button>
          <button onClick={downloadBoard} className="whiteboard-action">Export</button>
          {canEdit && <button onClick={clearInk} className="whiteboard-action danger">Clear ink</button>}
          {canEdit && <button onClick={clearBoard} className="whiteboard-action danger">Clear board</button>}
        </div>

        <div ref={containerRef} className="whiteboard-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            style={{
              touchAction: 'none',
              cursor:
                tool === 'pan' || spacePan ? HAND_CURSOR :
                tool === 'select' ? 'default' :
                tool === 'eraser' ? 'cell' :
                tool === 'pen' ? PEN_CURSOR :
                tool === 'highlighter' ? PEN_CURSOR :
                'crosshair',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
          />
          {objects.length === 0 && strokes.length === 0 && shapes.length === 0 && (
            <div className="whiteboard-empty">
              <h3>Whiteboard</h3>
              <p>{canEdit ? 'Use the tools on the left to draw, add shapes, erase, upload images, and arrange the board.' : 'Waiting for the teacher to use the whiteboard.'}</p>
            </div>
          )}
          <div className="whiteboard-hint">
            Space + drag pans. Wheel zooms. Select image or stroke, then press Delete.
          </div>
        </div>
      </div>
    );
  }
);

export default Whiteboard;
