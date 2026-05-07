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
    texts?: BoardText[];
    view?: BoardView | null;
    gridMode?: GridMode;
    instruments?: BoardInstrument[];
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
  // Compass tool draws circles with a tiny center dot so the construction
  // point is visible (real compass behaviour). Plain circle tool leaves it
  // unset / false.
  centerMark?: boolean;
  // AUTONOMOUS: layering — wall-clock ms at creation. Used to sort all
  // content (images, strokes, shapes, texts) chronologically so a newer
  // shape paints on top of older strokes/images, like a stack of paper.
  // Missing on old persisted data — falls back to 0 (bottom layer) and
  // still renders correctly.
  createdAt?: number;
}

// Background grid style. 'blank' = no grid (plain white). 'grid' = light
// minor grid lines (notebook-paper style — the original behaviour). 'graph'
// = minor + major lines + numbered axes through (0,0), like graph paper.
type GridMode = 'blank' | 'grid' | 'graph';

// Geometry instruments — ruler / protractor. Persistent draggable widgets
// that live in board-space (rotate/zoom with the canvas). Stored separately
// from shapes/strokes because they're interactive overlays, not committed
// drawings.
type InstrumentKind = 'ruler' | 'protractor';
interface BoardInstrument {
  id: string;
  kind: InstrumentKind;
  // Board-space anchor.
  //   ruler:      x,y = the LEFT tip of the ruler body.
  //   protractor: x,y = the CENTER of the semicircle.
  x: number;
  y: number;
  rotation: number; // degrees, clockwise
  // ruler only: length in board units (the right tip controls this)
  length?: number;
  // protractor only: radius in board units
  radius?: number;
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

// Text labels on the whiteboard. Click-to-place; Enter/blur commits.
// Stored separately from shapes because they have a fundamentally different
// data shape (typed content, not endpoint coords) and are rendered with
// fillText, not stroke geometry.
//   x, y       = top-left of the first line in board space
//   text       = full content (may contain \n for multi-line)
//   fontSize   = board units; the canvas font is set to this and scales
//                with the view's boardScale (so text "lives in the board"
//                like all other content)
//   color      = current pen color at time of creation
//   updatedAt  = used to break sync ties if two users edit the same text
interface BoardText {
  id: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
  updatedAt?: number;
  // Wall-clock ms at creation. Stable across edits — only the original
  // create time controls z-order. updatedAt may change on edit; createdAt
  // does not. So editing an old label doesn't suddenly bring it to the
  // front of everything painted on top of it.
  createdAt?: number;
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

type BoardTool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'pan' | 'line' | 'rect' | 'circle' | 'arrow' | 'compass' | 'ruler' | 'protractor' | 'text';

// Default font size for new text in board units. ~24px at 100% zoom.
const TEXT_DEFAULT_FONT_SIZE = 24;
const TEXT_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TEXT_LINE_HEIGHT_RATIO = 1.25;

// Compass produces a regular circle shape but the gesture is "click + drag
// from the centre" (which the existing circle tool already does — compass
// just additionally tags the resulting shape with centerMark so the centre
// point is visible). Ruler / protractor are spawn-toggle instruments and
// don't go through the shape-create dispatch.
const SHAPE_TOOLS: BoardTool[] = ['line', 'rect', 'circle', 'arrow', 'compass'];
const isShapeTool = (t: BoardTool): boolean => SHAPE_TOOLS.includes(t);
const shapeKindForTool = (t: BoardTool): ShapeKind | null => {
  if (t === 'compass') return 'circle';
  if (t === 'line' || t === 'rect' || t === 'circle' || t === 'arrow') return t;
  return null;
};

// Default sizes for spawned instruments (board units).
const RULER_DEFAULT_LENGTH = 600;
const RULER_BODY_THICKNESS = 56; // height of the ruler body
const PROTRACTOR_DEFAULT_RADIUS = 240;

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

// Eraser-shaped cursor (tilted rounded block, classic pencil-eraser silhouette).
// The browser-default 'cell' cursor was reading as a "+" / crosshair on most
// platforms and didn't match the tool. Hot-spot at the tip of the eraser so
// "where the eraser actually erases" sits exactly under the cursor.
const ERASER_CURSOR = (() => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="m7 21-4-4 11-11 4 4L7 21z" fill="#ffffff" stroke="#0F172A" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><path d="M14 6l4 4" stroke="#0F172A" stroke-width="1.6" stroke-linecap="round"/><path d="M3 21h18" stroke="#0F172A" stroke-width="1.6" stroke-linecap="round"/></svg>';
  return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}') 4 20, cell`;
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
// AUTONOMOUS: snap-to-grid for graph mode. Rounds a board-space point to
// the nearest minor grid intersection so shape endpoints land cleanly
// on graph-paper crossings (90° angles, equal lengths) — what a math
// teacher expects from a coordinate plane.
const snapToGrid = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: Math.round(p.x / GRID_STEP) * GRID_STEP,
  y: Math.round(p.y / GRID_STEP) * GRID_STEP,
});

// Migration helper: existing rooms persisted before unified z-ordering
// have strokes/shapes/texts WITHOUT a `createdAt` field. Our IDs embed
// the original creation Date.now() in the format `${prefix}-${ts}-${rand}`
// so we can recover a sensible chronological order from the id alone.
// Returns 0 if the id doesn't match the expected pattern (rare but
// possible — items rendered at the very bottom in that case).
function deriveTimestampFromId(id: string | undefined): number {
  if (!id) return 0;
  const match = id.match(/^[a-zA-Z]+-(\d+)-/);
  return match ? parseInt(match[1], 10) || 0 : 0;
}

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
      mode: 'draw' | 'erase' | 'pan' | 'object' | 'object-resize' | 'object-rotate' | 'shape-create' | 'shape-move' | 'marquee' | 'instrument-translate' | 'instrument-handle' | 'text-move' | null;
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
      instrumentId?: string;
      instrumentStart?: BoardInstrument;
      textId?: string;
      textStartX?: number;
      textStartY?: number;
    } | null>(null);

    const [objects, setObjects] = useState<BoardImageObject[]>([]);
    const [strokes, setStrokes] = useState<DrawStroke[]>([]);
    const [shapes, setShapes] = useState<BoardShape[]>([]);
    const [draftShape, setDraftShape] = useState<BoardShape | null>(null);
    // Text labels (typed labels on the canvas — separate from shapes
    // because they have a different data shape and are rendered with
    // fillText, not stroke geometry).
    const [texts, setTexts] = useState<BoardText[]>([]);
    const textsRef = useRef<BoardText[]>([]);
    const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
    // When the text editor overlay is open, this holds (a) the id of the
    // text being edited (or null for a new one), (b) the screen pixel
    // position to anchor the textarea, (c) the initial value to populate.
    // Closing the overlay either commits or discards based on emptiness.
    const [textEditor, setTextEditor] = useState<{
      id: string | null;     // null = creating a new label, string = re-editing
      boardX: number;        // board-space anchor (top-left of first line)
      boardY: number;
      value: string;
      fontSize: number;
      color: string;
    } | null>(null);
    const textEditorRef = useRef<HTMLTextAreaElement>(null);
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
    // AUTONOMOUS: [ORDER-3 FRICTION] - texts were the one selectable item the
    // marquee couldn't lasso. The whole point of marquee is "select a region
    // of mixed content and operate on it together"; excluding texts made the
    // feature feel half-finished.
    const [multiTextIds, setMultiTextIds] = useState<string[]>([]);
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
    // Background grid style — synced across the room (it's a board-level
    // setting, like view). Default 'grid' to match the previous behaviour.
    const [gridMode, setGridMode] = useState<GridMode>('grid');
    // Geometry instruments (ruler / protractor) — synced across the room.
    const [instruments, setInstruments] = useState<BoardInstrument[]>([]);
    const instrumentsRef = useRef<BoardInstrument[]>([]);
    // AUTONOMOUS: [ORDER-3 FRICTION] - Font size for new text labels.
    // Persisted only locally (per-user preference, not synced) — each text
    // bakes in its size at creation time, so changing this slider doesn't
    // retroactively resize previous labels. Default = TEXT_DEFAULT_FONT_SIZE.
    const [textFontSize, setTextFontSize] = useState<number>(TEXT_DEFAULT_FONT_SIZE);

    const selectedObject = selectedObjectId ? objects.find(obj => obj.id === selectedObjectId) : null;
    const canEdit = interactive;
    // AUTONOMOUS: [ORDER-2 ESSENTIAL] - Students can upload + manipulate
    // images on the shared whiteboard when interactive mode is on. The
    // teacher-controlled `studentInteractionAllowed` toggle (which is what
    // gates `interactive` for student clients) is the explicit opt-in.
    // Image content has a hard server-side size cap (6MB) added in the
    // autonomous improvement pass, so a misbehaving student can't spam
    // multi-MB blobs into canonical state.
    const canMutateImages = isTeacher || interactive;

    useEffect(() => {
      strokesRef.current = strokes;
    }, [strokes]);

    useEffect(() => {
      shapesRef.current = shapes;
    }, [shapes]);

    useEffect(() => {
      textsRef.current = texts;
    }, [texts]);

    useEffect(() => {
      draftShapeRef.current = draftShape;
    }, [draftShape]);

    useEffect(() => {
      marqueeRef.current = marquee;
    }, [marquee]);

    useEffect(() => {
      instrumentsRef.current = instruments;
    }, [instruments]);

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
      setMultiTextIds([]);
    }, []);

    // Bulk-delete every item in the marquee multi-selection.
    // Captures snapshots of every removed item so a single undo restores them all.
    const removeMultiSelection = useCallback(() => {
      // Snapshot everything first so the undo entry sees the original state
      const removedObjects: BoardImageObject[] = [];
      const removedShapes: BoardShape[] = [];
      const removedStrokes: DrawStroke[] = [];
      const removedTexts: BoardText[] = [];

      if (multiObjectIds.length > 0) {
        const ids = new Set(multiObjectIds);
        objects.forEach(o => { if (ids.has(o.id)) removedObjects.push({ ...o }); });
        setObjects(prev => prev.filter(o => !ids.has(o.id)));
        multiObjectIds.forEach(id => {
          imageCacheRef.current.delete(id);
          if (socket && canMutateImages) socket.emit('whiteboard_remove_object', { roomId, objectId: id });
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
          // Emit by stroke id (race-free) instead of index — concurrent
          // deletes from the teacher and student would otherwise corrupt the
          // server array via splice index drift.
          const ids = removedStrokes.map(s => s.id).filter((id): id is string => !!id);
          if (socket && ids.length > 0) socket.emit('whiteboard_delete_strokes', { roomId, strokeIds: ids });
        }
      }
      if (multiTextIds.length > 0) {
        const ids = new Set(multiTextIds);
        textsRef.current.forEach(t => { if (ids.has(t.id)) removedTexts.push({ ...t }); });
        setTexts(prev => prev.filter(t => !ids.has(t.id)));
        multiTextIds.forEach(id => {
          if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: id });
        });
      }
      clearMultiSelection();

      if (removedObjects.length === 0 && removedShapes.length === 0 && removedStrokes.length === 0 && removedTexts.length === 0) return;
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
              if (socket && canMutateImages) socket.emit('whiteboard_add_image', { roomId, object: o });
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
          if (removedTexts.length > 0) {
            setTexts(prev => {
              const existing = new Set(prev.map(t => t.id));
              const additions = removedTexts.filter(t => !existing.has(t.id));
              return [...prev, ...additions];
            });
            removedTexts.forEach(t => {
              if (socket && isTeacher) socket.emit('whiteboard_add_text', { roomId, text: t });
            });
          }
        },
        redo: () => {
          if (removedObjects.length > 0) {
            const ids = new Set(removedObjects.map(o => o.id));
            setObjects(prev => prev.filter(o => !ids.has(o.id)));
            removedObjects.forEach(o => {
              imageCacheRef.current.delete(o.id);
              if (socket && canMutateImages) socket.emit('whiteboard_remove_object', { roomId, objectId: o.id });
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
            // Race-free: delete by id everywhere.
            const idsToRemove = new Set(removedStrokes.map(s => s.id ?? ''));
            setStrokes(prev => prev.filter(s => !idsToRemove.has(s.id ?? '')));
            const ids = Array.from(idsToRemove).filter(id => !!id);
            if (socket && ids.length > 0) socket.emit('whiteboard_delete_strokes', { roomId, strokeIds: ids });
          }
          if (removedTexts.length > 0) {
            const ids = new Set(removedTexts.map(t => t.id));
            setTexts(prev => prev.filter(t => !ids.has(t.id)));
            removedTexts.forEach(t => {
              if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: t.id });
            });
          }
        },
      });
    }, [multiObjectIds, multiShapeIds, multiStrokeIndices, multiTextIds, objects, shapes, socket, isTeacher, canMutateImages, roomId, clearMultiSelection, recordAction]);

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

    // ── Text geometry + hit testing ──
    // Measures the bounding box of a multi-line text in board space. Uses an
    // offscreen 2D context to measure each line's width, then takes the
    // maximum. Height is fontSize * lineHeightRatio per line. The bbox
    // origin is the text's top-left (text.x, text.y).
    const measureTextRef = useRef<HTMLCanvasElement | null>(null);
    const measureText = useCallback((text: BoardText): { x: number; y: number; w: number; h: number; lines: string[] } => {
      if (!measureTextRef.current) {
        measureTextRef.current = document.createElement('canvas');
      }
      const ctx = measureTextRef.current.getContext('2d');
      const lines = text.text.split('\n');
      let maxW = 0;
      if (ctx) {
        ctx.font = `${text.fontSize}px ${TEXT_FONT_FAMILY}`;
        for (const line of lines) {
          const m = ctx.measureText(line);
          if (m.width > maxW) maxW = m.width;
        }
      } else {
        // Fallback heuristic if ever the offscreen canvas fails.
        maxW = lines.reduce((m, l) => Math.max(m, l.length), 0) * text.fontSize * 0.55;
      }
      const lineH = text.fontSize * TEXT_LINE_HEIGHT_RATIO;
      const h = Math.max(lines.length, 1) * lineH;
      return { x: text.x, y: text.y, w: maxW, h, lines };
    }, []);

    const textHit = useCallback((point: DrawPoint, text: BoardText): boolean => {
      const b = measureText(text);
      const pad = 6 / view.boardScale;
      return point.x >= b.x - pad && point.x <= b.x + b.w + pad &&
             point.y >= b.y - pad && point.y <= b.y + b.h + pad;
    }, [measureText, view.boardScale]);

    const findTextAt = useCallback((point: DrawPoint): BoardText | null => {
      // Iterate newest-first (rendered last → on top).
      for (let i = textsRef.current.length - 1; i >= 0; i--) {
        if (textHit(point, textsRef.current[i])) return textsRef.current[i];
      }
      return null;
    }, [textHit]);

    // ── Text mutators ──
    const addText = useCallback((t: BoardText) => {
      setTexts(prev => [...prev, t]);
      if (socket && isTeacher) socket.emit('whiteboard_add_text', { roomId, text: t });
    }, [socket, isTeacher, roomId]);

    const updateText = useCallback((t: BoardText, broadcast = true) => {
      setTexts(prev => prev.map(x => x.id === t.id ? t : x));
      if (broadcast && socket && isTeacher) socket.emit('whiteboard_update_text', { roomId, text: t });
    }, [socket, isTeacher, roomId]);

    const removeSelectedText = useCallback(() => {
      if (!selectedTextId) return;
      const id = selectedTextId;
      const snapshot = textsRef.current.find(t => t.id === id);
      if (!snapshot) return;
      const textSnapshot: BoardText = { ...snapshot };
      setTexts(prev => prev.filter(t => t.id !== id));
      setSelectedTextId(null);
      if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: id });
      recordAction({
        undo: () => {
          setTexts(prev => prev.some(t => t.id === textSnapshot.id) ? prev : [...prev, textSnapshot]);
          if (socket && isTeacher) socket.emit('whiteboard_add_text', { roomId, text: textSnapshot });
        },
        redo: () => {
          setTexts(prev => prev.filter(t => t.id !== textSnapshot.id));
          if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: textSnapshot.id });
        },
      });
    }, [selectedTextId, socket, isTeacher, roomId, recordAction]);

    // Open the inline editor at the given board-space point. If editing an
    // existing text, pre-fills with its content; if creating new, starts blank
    // and uses the currently-selected font size from the toolbar.
    const openTextEditor = useCallback((boardX: number, boardY: number, existing?: BoardText) => {
      setTextEditor({
        id: existing?.id ?? null,
        boardX,
        boardY,
        value: existing?.text ?? '',
        fontSize: existing?.fontSize ?? textFontSize,
        color: existing?.color ?? color,
      });
    }, [color, textFontSize]);

    // Commit the editor's current value as a text. Empty input → discard.
    const commitTextEditor = useCallback(() => {
      const ed = textEditor;
      if (!ed) return;
      const trimmed = ed.value;
      // Empty (only whitespace) commit on a NEW text → discard.
      // Empty commit on an EXISTING text → treat as delete.
      if (!trimmed.trim()) {
        if (ed.id) {
          // Empty existing → delete
          const existing = textsRef.current.find(t => t.id === ed.id);
          if (existing) {
            setTexts(prev => prev.filter(t => t.id !== ed.id));
            if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: ed.id });
            const snap = { ...existing };
            recordAction({
              undo: () => {
                setTexts(prev => prev.some(t => t.id === snap.id) ? prev : [...prev, snap]);
                if (socket && isTeacher) socket.emit('whiteboard_add_text', { roomId, text: snap });
              },
              redo: () => {
                setTexts(prev => prev.filter(t => t.id !== snap.id));
                if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: snap.id });
              },
            });
          }
        }
        setTextEditor(null);
        return;
      }
      if (ed.id) {
        // Editing existing — update. Preserve the original createdAt so the
        // label's z-order doesn't jump to the top just because the user
        // edited the contents.
        const existing = textsRef.current.find(t => t.id === ed.id);
        const before = existing ? { ...existing } : null;
        const after: BoardText = {
          id: ed.id,
          x: ed.boardX,
          y: ed.boardY,
          text: trimmed,
          fontSize: ed.fontSize,
          color: ed.color,
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        };
        updateText(after);
        if (before) {
          recordAction({
            undo: () => updateText(before),
            redo: () => updateText(after),
          });
        }
      } else {
        const now = Date.now();
        const t: BoardText = {
          id: newId('text'),
          x: ed.boardX,
          y: ed.boardY,
          text: trimmed,
          fontSize: ed.fontSize,
          color: ed.color,
          createdAt: now,
          updatedAt: now,
        };
        addText(t);
        recordAction({
          undo: () => {
            setTexts(prev => prev.filter(x => x.id !== t.id));
            if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: t.id });
          },
          redo: () => {
            setTexts(prev => prev.some(x => x.id === t.id) ? prev : [...prev, t]);
            if (socket && isTeacher) socket.emit('whiteboard_add_text', { roomId, text: t });
          },
        });
      }
      setTextEditor(null);
      setTool('select');
    }, [textEditor, addText, updateText, socket, isTeacher, roomId, recordAction]);

    // Cancel discard the editor without committing (Esc).
    const cancelTextEditor = useCallback(() => {
      setTextEditor(null);
      // Don't auto-revert tool here — user might want to click again to
      // place another text. Tool reverts only on actual commit.
    }, []);

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

    // ── Grid mode + instrument mutators (teacher-only sync) ──
    const setGridModeSynced = useCallback((next: GridMode) => {
      setGridMode(next);
      if (socket && isTeacher) socket.emit('whiteboard_set_grid_mode', { roomId, gridMode: next });
    }, [socket, isTeacher, roomId]);

    const addInstrument = useCallback((inst: BoardInstrument) => {
      setInstruments(prev => [...prev, inst]);
      if (socket && isTeacher) socket.emit('whiteboard_add_instrument', { roomId, instrument: inst });
    }, [socket, isTeacher, roomId]);

    const updateInstrument = useCallback((inst: BoardInstrument, broadcast = true) => {
      setInstruments(prev => prev.map(i => i.id === inst.id ? inst : i));
      if (broadcast && socket && isTeacher) socket.emit('whiteboard_update_instrument', { roomId, instrument: inst });
    }, [socket, isTeacher, roomId]);

    const removeInstrument = useCallback((id: string) => {
      setInstruments(prev => prev.filter(i => i.id !== id));
      if (socket && isTeacher) socket.emit('whiteboard_remove_instrument', { roomId, instrumentId: id });
    }, [socket, isTeacher, roomId]);

    // Toggle helper for the toolbar buttons. Click "Ruler" → if no ruler is
    // on the board, spawn one near the centre of the visible viewport. Click
    // again → remove the existing ruler. Same pattern for protractor.
    const toggleInstrument = useCallback((kind: InstrumentKind) => {
      const existing = instrumentsRef.current.find(i => i.kind === kind);
      if (existing) {
        removeInstrument(existing.id);
        return;
      }
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // Compute board-space centre of the current viewport.
      const cx = (rect.width / 2 - view.boardOffsetX) / view.boardScale;
      const cy = (rect.height / 2 - view.boardOffsetY) / view.boardScale;
      const inst: BoardInstrument = kind === 'ruler'
        ? {
            id: newId('ruler'),
            kind: 'ruler',
            x: cx - RULER_DEFAULT_LENGTH / 2,
            y: cy,
            rotation: 0,
            length: RULER_DEFAULT_LENGTH,
          }
        : {
            id: newId('prot'),
            kind: 'protractor',
            x: cx,
            y: cy + PROTRACTOR_DEFAULT_RADIUS / 2,
            rotation: 0,
            radius: PROTRACTOR_DEFAULT_RADIUS,
          };
      addInstrument(inst);
    }, [view, addInstrument, removeInstrument]);

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
      if (socket && canMutateImages) socket.emit('whiteboard_add_image', { roomId, object });
      recordAction({
        undo: () => {
          setObjects(prev => prev.filter(o => o.id !== object.id));
          imageCacheRef.current.delete(object.id);
          if (socket && canMutateImages) socket.emit('whiteboard_remove_object', { roomId, objectId: object.id });
        },
        redo: () => {
          setObjects(prev => prev.some(o => o.id === object.id) ? prev : [...prev, object]);
          loadImage(object);
          if (socket && canMutateImages) socket.emit('whiteboard_add_image', { roomId, object });
        },
      });
    }, [screenToBoard, loadImage, socket, canMutateImages, roomId, recordAction]);

    const updateObject = useCallback((object: BoardImageObject, broadcast = true) => {
      setObjects(prev => prev.map(obj => obj.id === object.id ? object : obj));
      if (broadcast && socket && canMutateImages) socket.emit('whiteboard_update_object', { roomId, object });
    }, [socket, canMutateImages, roomId]);

    const removeSelectedObject = useCallback(() => {
      if (!selectedObjectId) return;
      const target = objects.find(o => o.id === selectedObjectId);
      if (!target) return;
      const snapshot: BoardImageObject = { ...target };
      setObjects(prev => prev.filter(obj => obj.id !== selectedObjectId));
      imageCacheRef.current.delete(selectedObjectId);
      if (socket && canMutateImages) socket.emit('whiteboard_remove_object', { roomId, objectId: selectedObjectId });
      setSelectedObjectId(null);
      recordAction({
        undo: () => {
          setObjects(prev => prev.some(o => o.id === snapshot.id) ? prev : [...prev, snapshot]);
          loadImage(snapshot);
          if (socket && canMutateImages) socket.emit('whiteboard_add_image', { roomId, object: snapshot });
        },
        redo: () => {
          setObjects(prev => prev.filter(o => o.id !== snapshot.id));
          imageCacheRef.current.delete(snapshot.id);
          if (socket && canMutateImages) socket.emit('whiteboard_remove_object', { roomId, objectId: snapshot.id });
        },
      });
    }, [selectedObjectId, objects, socket, canMutateImages, roomId, recordAction, loadImage]);

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
      // Capture full stroke data so undo can re-add. We resolve indices to
      // ids HERE (atomically against the current array) and only carry ids
      // forward — the server now deletes by id (race-free under concurrent
      // deletes). Index-based emission is gone.
      const removedStrokes = unique.map(i => strokesRef.current[i]).filter(Boolean) as DrawStroke[];
      const removedIds = removedStrokes.map(s => s.id).filter((id): id is string => !!id);
      setStrokes(prev => prev.filter((_, index) => !unique.includes(index)));
      setSelectedStrokeIndex(prev => (prev !== null && unique.includes(prev)) ? null : prev);
      if (socket && removedIds.length > 0) socket.emit('whiteboard_delete_strokes', { roomId, strokeIds: removedIds });
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
          // Race-free redo: delete by id, no index lookup needed.
          const idsToRemove = new Set(removedStrokes.map(s => s.id).filter((id): id is string => !!id));
          if (idsToRemove.size === 0) return;
          setStrokes(prev => prev.filter(s => !(s.id && idsToRemove.has(s.id))));
          if (socket) socket.emit('whiteboard_delete_strokes', { roomId, strokeIds: Array.from(idsToRemove) });
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

    // ── Instrument geometry helpers ──
    // For ruler/protractor: where their interaction handles sit in board-space,
    // already accounting for rotation. Used for hit-testing AND for drawing
    // the handles inside redrawCanvas.
    const getInstrumentPose = useCallback((inst: BoardInstrument) => {
      const cosA = Math.cos((inst.rotation * Math.PI) / 180);
      const sinA = Math.sin((inst.rotation * Math.PI) / 180);
      if (inst.kind === 'ruler') {
        const len = inst.length ?? RULER_DEFAULT_LENGTH;
        // Left tip is the anchor (x,y). Body extends from local (0..len) along
        // the rotation direction, with thickness centred on the rotation axis.
        const rightTip = { x: inst.x + cosA * len, y: inst.y + sinA * len };
        return {
          length: len,
          thickness: RULER_BODY_THICKNESS,
          left: { x: inst.x, y: inst.y },
          right: rightTip,
        };
      }
      const r = inst.radius ?? PROTRACTOR_DEFAULT_RADIUS;
      // Protractor: x,y is the centre. The flat bottom edge of the semicircle
      // lies along the rotation axis, with 0° at the right end of the diameter.
      // The rotate handle sits on the 0° tip.
      const handle = { x: inst.x + cosA * r, y: inst.y + sinA * r };
      return { radius: r, center: { x: inst.x, y: inst.y }, handle };
    }, []);

    // Hit test: returns 'body' if the pointer is over the instrument's grab
    // area, 'handle' if over the rotation/length handle, or null.
    const instrumentHit = useCallback((point: DrawPoint, inst: BoardInstrument): 'body' | 'handle' | null => {
      const pose = getInstrumentPose(inst);
      const handleR = 16 / view.boardScale;
      if (inst.kind === 'ruler' && 'right' in pose) {
        const distToHandle = Math.hypot(point.x - pose.right.x, point.y - pose.right.y);
        if (distToHandle <= handleR) return 'handle';
        // Body hit: rotate the test point into the ruler's local frame and
        // check if it sits within the body rectangle.
        const cosA = Math.cos((-inst.rotation * Math.PI) / 180);
        const sinA = Math.sin((-inst.rotation * Math.PI) / 180);
        const dx = point.x - inst.x;
        const dy = point.y - inst.y;
        const localX = dx * cosA - dy * sinA;
        const localY = dx * sinA + dy * cosA;
        if (localX >= 0 && localX <= pose.length && Math.abs(localY) <= pose.thickness / 2) return 'body';
        return null;
      }
      if (inst.kind === 'protractor' && 'handle' in pose) {
        const distToHandle = Math.hypot(point.x - pose.handle.x, point.y - pose.handle.y);
        if (distToHandle <= handleR) return 'handle';
        // Body hit: inside the semicircle (within radius, on the upper half
        // relative to the rotation axis — local y <= 0).
        const cosA = Math.cos((-inst.rotation * Math.PI) / 180);
        const sinA = Math.sin((-inst.rotation * Math.PI) / 180);
        const dx = point.x - inst.x;
        const dy = point.y - inst.y;
        const localX = dx * cosA - dy * sinA;
        const localY = dx * sinA + dy * cosA;
        const dist = Math.hypot(localX, localY);
        if (dist <= pose.radius && localY <= 0.0001) return 'body';
        return null;
      }
      return null;
    }, [getInstrumentPose, view.boardScale]);

    const findInstrumentAt = useCallback((point: DrawPoint): { inst: BoardInstrument; hit: 'body' | 'handle' } | null => {
      // Iterate newest-last (back-to-front), prefer handle hits over body hits.
      for (let i = instrumentsRef.current.length - 1; i >= 0; i--) {
        const inst = instrumentsRef.current[i];
        const hit = instrumentHit(point, inst);
        if (hit) return { inst, hit };
      }
      return null;
    }, [instrumentHit]);

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

      // Background grid — three modes:
      //   blank → no grid, just the white fill above.
      //   grid  → a single layer of light minor lines (the original look).
      //   graph → minor lines + heavier major lines every 5 steps + bold axes
      //           through (0,0) with numeric labels — graph paper for math.
      if (gridMode !== 'blank') {
        const minorStep = GRID_STEP;
        const majorEvery = 5; // every 5 minor lines = a major line
        const majorStep = minorStep * majorEvery;
        const gridStartX = Math.floor(visMinX / minorStep) * minorStep;
        const gridEndX   = Math.ceil(visMaxX  / minorStep) * minorStep;
        const gridStartY = Math.floor(visMinY / minorStep) * minorStep;
        const gridEndY   = Math.ceil(visMaxY  / minorStep) * minorStep;

        // Minor lines (both modes use these, lighter colour for graph)
        ctx.strokeStyle = gridMode === 'graph' ? '#eef2f7' : '#e5e7eb';
        ctx.lineWidth = 1 / view.boardScale;
        for (let x = gridStartX; x <= gridEndX; x += minorStep) {
          ctx.beginPath();
          ctx.moveTo(x, gridStartY);
          ctx.lineTo(x, gridEndY);
          ctx.stroke();
        }
        for (let y = gridStartY; y <= gridEndY; y += minorStep) {
          ctx.beginPath();
          ctx.moveTo(gridStartX, y);
          ctx.lineTo(gridEndX, y);
          ctx.stroke();
        }

        if (gridMode === 'graph') {
          // Major lines every `majorEvery` steps — slightly darker.
          ctx.strokeStyle = '#cbd5e1';
          ctx.lineWidth = 1.2 / view.boardScale;
          const majorStartX = Math.floor(visMinX / majorStep) * majorStep;
          const majorEndX   = Math.ceil(visMaxX  / majorStep) * majorStep;
          const majorStartY = Math.floor(visMinY / majorStep) * majorStep;
          const majorEndY   = Math.ceil(visMaxY  / majorStep) * majorStep;
          for (let x = majorStartX; x <= majorEndX; x += majorStep) {
            ctx.beginPath();
            ctx.moveTo(x, gridStartY);
            ctx.lineTo(x, gridEndY);
            ctx.stroke();
          }
          for (let y = majorStartY; y <= majorEndY; y += majorStep) {
            ctx.beginPath();
            ctx.moveTo(gridStartX, y);
            ctx.lineTo(gridEndX, y);
            ctx.stroke();
          }
          // Axes through the origin — bold so they read as the x/y axes.
          ctx.strokeStyle = '#475569';
          ctx.lineWidth = 1.6 / view.boardScale;
          if (visMinX <= 0 && visMaxX >= 0) {
            ctx.beginPath();
            ctx.moveTo(0, gridStartY);
            ctx.lineTo(0, gridEndY);
            ctx.stroke();
          }
          if (visMinY <= 0 && visMaxY >= 0) {
            ctx.beginPath();
            ctx.moveTo(gridStartX, 0);
            ctx.lineTo(gridEndX, 0);
            ctx.stroke();
          }
          // Numeric labels on major lines along the axes. Each major step is
          // displayed as the unit count (1, 2, 3…) — keeps numbers small and
          // readable. Labels render in screen-space-stable size.
          ctx.fillStyle = '#475569';
          const labelPx = 11;
          ctx.font = `${labelPx / view.boardScale}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textBaseline = 'top';
          // X-axis labels (along y=0)
          if (visMinY <= 0 && visMaxY >= 0) {
            ctx.textAlign = 'center';
            const labelStartX = Math.floor(visMinX / majorStep) * majorStep;
            const labelEndX = Math.ceil(visMaxX / majorStep) * majorStep;
            for (let x = labelStartX; x <= labelEndX; x += majorStep) {
              if (x === 0) continue;
              const unit = Math.round(x / majorStep);
              ctx.fillText(String(unit), x, 4 / view.boardScale);
            }
          }
          // Y-axis labels (along x=0). Math convention: positive y is UP, so
          // negate the board y for display.
          if (visMinX <= 0 && visMaxX >= 0) {
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const labelStartY = Math.floor(visMinY / majorStep) * majorStep;
            const labelEndY = Math.ceil(visMaxY / majorStep) * majorStep;
            for (let y = labelStartY; y <= labelEndY; y += majorStep) {
              if (y === 0) continue;
              const unit = Math.round(-y / majorStep);
              ctx.fillText(String(unit), -4 / view.boardScale, y);
            }
            // The "0" at the origin
            if (visMinY <= 0 && visMaxY >= 0) {
              ctx.textAlign = 'right';
              ctx.textBaseline = 'top';
              ctx.fillText('0', -4 / view.boardScale, 4 / view.boardScale);
            }
          }
        }
      }

      // ── Per-kind draw functions (defined first, executed in unified
      //    chronological order below). This is the key fix for the layering
      //    bug: previously images/shapes/texts/strokes were rendered in
      //    fixed kind-order (always strokes ON TOP of images), so a question
      //    image pasted AFTER student strokes left the strokes visible
      //    bleeding through. Now everything sorts by createdAt/zIndex and
      //    paints chronologically — a new image truly covers older content
      //    underneath, like stacking sheets of paper.
      const drawImageObject = (object: BoardImageObject) => {
        const img = imageCacheRef.current.get(object.id);
        if (!img?.complete) return;
        ctx.save();
        ctx.translate(object.x + (object.width * object.scale) / 2, object.y + (object.height * object.scale) / 2);
        ctx.rotate((object.rotation * Math.PI) / 180);
        ctx.drawImage(img, -(object.width * object.scale) / 2, -(object.height * object.scale) / 2, object.width * object.scale, object.height * object.scale);
        ctx.restore();
      };

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
          // Compass-drawn circles get a small filled dot at the centre point
          // — matches what a real compass leaves on paper.
          if (shape.centerMark) {
            ctx.save();
            ctx.fillStyle = shape.color;
            ctx.beginPath();
            ctx.arc(shape.x1, shape.y1, Math.max(shape.width * 0.9, 3 / view.boardScale), 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
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
      // (drawShape executed below in the unified content pass.)

      // ── Text labels ──
      // The currently-being-edited text (if any) is rendered transparently
      // so it doesn't overlap the textarea overlay.
      const drawText = (t: BoardText) => {
        if (textEditor && textEditor.id === t.id) return; // hidden during edit
        ctx.save();
        ctx.fillStyle = t.color;
        ctx.font = `${t.fontSize}px ${TEXT_FONT_FAMILY}`;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        const lineH = t.fontSize * TEXT_LINE_HEIGHT_RATIO;
        const lines = t.text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], t.x, t.y + i * lineH);
        }
        ctx.restore();
      };
      // (drawText executed below in the unified content pass.)

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
      // ── UNIFIED CONTENT RENDER (chronological z-order) ──
      // Build a sorted list of every content item by its creation timestamp.
      // Older items render first (underneath); newer items render on top.
      // This is what makes "stacking sheets of paper" work — a question
      // image pasted after student strokes COVERS those strokes; new pen
      // ink on top of an image stays visible above it.
      //
      // Migration: items missing createdAt sort to z=0 — they render at the
      // very bottom, preserving the relative order they had before this
      // refactor (which was: images first, then everything else).
      type RenderItem =
        | { kind: 'image'; value: BoardImageObject; z: number }
        | { kind: 'stroke'; value: DrawStroke; z: number }
        | { kind: 'shape'; value: BoardShape; z: number }
        | { kind: 'text'; value: BoardText; z: number };
      const items: RenderItem[] = [];
      for (const o of objects) {
        // Image z: prefer zIndex, fall back to id-embedded timestamp.
        items.push({ kind: 'image', value: o, z: o.zIndex || deriveTimestampFromId(o.id) });
      }
      for (const s of strokes) {
        // Stroke z: createdAt OR id-embedded timestamp. Old persisted
        // strokes lack createdAt; deriveTimestampFromId recovers their
        // original creation order so they don't all land at the bottom.
        items.push({ kind: 'stroke', value: s, z: s.createdAt || deriveTimestampFromId(s.id) });
      }
      for (const s of shapes) {
        items.push({ kind: 'shape', value: s, z: s.createdAt || deriveTimestampFromId(s.id) });
      }
      for (const t of texts) {
        items.push({ kind: 'text', value: t, z: t.createdAt || deriveTimestampFromId(t.id) });
      }
      // Stable-ish sort: ties (same z) keep input order. Important because
      // a freshly-uploaded image and a stroke drawn in the same ms tick
      // shouldn't randomly reorder on every redraw.
      items.sort((a, b) => a.z - b.z);
      for (const item of items) {
        if (item.kind === 'image') drawImageObject(item.value);
        else if (item.kind === 'stroke') drawStroke(item.value);
        else if (item.kind === 'shape') drawShape(item.value);
        else if (item.kind === 'text') drawText(item.value);
      }

      // ── In-flight overlays (always above all content, below selection) ──
      // The draft shape (during click-and-drag shape creation) and the live
      // pen/highlighter/eraser stroke are UI overlays of the current
      // gesture. They sit visually on top of every committed item.
      if (draftShape) drawShape(draftShape);
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

      // ── Selection chrome (always above content + draft) ──
      // Image selection: dashed rect + corner/rotation handles. Drawn AFTER
      // all content so the handles never get hidden underneath a newer
      // image that happens to overlap the selected one.
      if (selectedObjectId) {
        const object = objects.find(o => o.id === selectedObjectId);
        if (object) {
          const w = object.width * object.scale;
          const h = object.height * object.scale;
          const cx = object.x + w / 2;
          const cy = object.y + h / 2;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate((object.rotation * Math.PI) / 180);
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2 / view.boardScale;
          ctx.setLineDash([10 / view.boardScale, 7 / view.boardScale]);
          ctx.strokeRect(-w / 2, -h / 2, w, h);
          ctx.restore();

          ctx.save();
          ctx.setLineDash([]);
          const handles = getObjectHandlePositions(object);
          const HANDLE = 11 / view.boardScale;
          const HALF = HANDLE / 2;
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 1.5 / view.boardScale;
          const topMidLocal = { x: object.x + w / 2, y: object.y };
          const topMid = rotatePoint(topMidLocal, { x: cx, y: cy }, object.rotation);
          ctx.beginPath();
          ctx.moveTo(topMid.x, topMid.y);
          ctx.lineTo(handles.rotate.x, handles.rotate.y);
          ctx.stroke();
          (['tl', 'tr', 'bl', 'br'] as const).forEach(id => {
            const p = handles[id];
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((object.rotation * Math.PI) / 180);
            ctx.fillRect(-HALF, -HALF, HANDLE, HANDLE);
            ctx.strokeRect(-HALF, -HALF, HANDLE, HANDLE);
            ctx.restore();
          });
          ctx.beginPath();
          ctx.arc(handles.rotate.x, handles.rotate.y, HALF, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }
      if (selectedShape) {
        const b = shapeBounds(selectedShape);
        ctx.save();
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 2 / view.boardScale;
        ctx.setLineDash([8 / view.boardScale, 6 / view.boardScale]);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      }
      if (selectedTextId) {
        const sel = texts.find(t => t.id === selectedTextId);
        if (sel) {
          const b = measureText(sel);
          const pad = 4 / view.boardScale;
          ctx.save();
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2 / view.boardScale;
          ctx.setLineDash([8 / view.boardScale, 6 / view.boardScale]);
          ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
          ctx.restore();
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
      if (multiObjectIds.length > 0 || multiShapeIds.length > 0 || multiStrokeIndices.length > 0 || multiTextIds.length > 0) {
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
        const textIdSet = new Set(multiTextIds);
        texts.forEach(t => {
          if (!textIdSet.has(t.id)) return;
          const b = measureText(t);
          const pad = 4 / view.boardScale;
          ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
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

      // ── Geometry instruments (ruler / protractor) ──
      // Drawn last so they overlay everything. Both are translucent so the
      // user can see what's underneath while measuring.
      instruments.forEach(inst => {
        if (inst.kind === 'ruler') {
          const len = inst.length ?? RULER_DEFAULT_LENGTH;
          ctx.save();
          ctx.translate(inst.x, inst.y);
          ctx.rotate((inst.rotation * Math.PI) / 180);
          // Body — soft warm wood-coloured rectangle with a darker border.
          const t = RULER_BODY_THICKNESS;
          ctx.fillStyle = 'rgba(254, 243, 199, 0.85)'; // amber-50 / 85%
          ctx.strokeStyle = '#92400E';                 // amber-800
          ctx.lineWidth = 1.4 / view.boardScale;
          ctx.fillRect(0, -t / 2, len, t);
          ctx.strokeRect(0, -t / 2, len, t);
          // Tick marks along the top edge — every 10 board units, taller
          // every 50 board units, even taller every 100.
          ctx.strokeStyle = '#78350F';
          ctx.lineWidth = 1 / view.boardScale;
          ctx.fillStyle = '#78350F';
          const labelPx = 10 / view.boardScale;
          ctx.font = `${labelPx}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          for (let unit = 0; unit <= len; unit += 10) {
            const tickH = unit % 100 === 0 ? 12 : unit % 50 === 0 ? 8 : 4;
            const tickPx = tickH / view.boardScale;
            ctx.beginPath();
            ctx.moveTo(unit, -t / 2);
            ctx.lineTo(unit, -t / 2 + tickPx);
            ctx.stroke();
            if (unit % 100 === 0 && unit !== 0 && unit !== len) {
              // Numeric label below the tick
              ctx.fillText(String(unit / 10), unit, -t / 2 + tickPx + 1 / view.boardScale);
            }
          }
          // Length readout near the right tip.
          ctx.fillStyle = '#0F172A';
          ctx.font = `bold ${12 / view.boardScale}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'bottom';
          ctx.fillText(`${Math.round(len)} u`, len - 4 / view.boardScale, -t / 2 - 4 / view.boardScale);
          ctx.restore();
          // Right-tip handle (in board space, post-rotation) — used to
          // simultaneously rotate and resize. Drawn outside the rotated
          // transform so the circle stays circular regardless of rotation.
          const pose = getInstrumentPose(inst);
          if ('right' in pose) {
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#92400E';
            ctx.lineWidth = 1.6 / view.boardScale;
            ctx.beginPath();
            ctx.arc(pose.right.x, pose.right.y, 9 / view.boardScale, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        } else if (inst.kind === 'protractor') {
          const r = inst.radius ?? PROTRACTOR_DEFAULT_RADIUS;
          ctx.save();
          ctx.translate(inst.x, inst.y);
          ctx.rotate((inst.rotation * Math.PI) / 180);
          // Translucent semicircle body. The local frame: 0° is along +x,
          // 180° is along -x, 90° is along -y (the curved side, "up").
          // Canvas y grows downward, so the visible half is y <= 0.
          ctx.fillStyle = 'rgba(219, 234, 254, 0.55)'; // blue-100 / 55%
          ctx.strokeStyle = '#1D4ED8';                 // blue-700
          ctx.lineWidth = 1.6 / view.boardScale;
          ctx.beginPath();
          ctx.arc(0, 0, r, Math.PI, 0, false);
          ctx.lineTo(-r, 0);
          ctx.fill();
          ctx.stroke();
          // Inner radius line (flat baseline, redundant with arc closure but
          // makes the diameter visually distinct).
          ctx.strokeStyle = '#1D4ED8';
          ctx.lineWidth = 1.2 / view.boardScale;
          ctx.beginPath();
          ctx.moveTo(-r, 0);
          ctx.lineTo(r, 0);
          ctx.stroke();
          // Degree ticks every 1°, longer every 5°, longest + numeric every 10°.
          ctx.strokeStyle = '#1E3A8A';
          ctx.fillStyle = '#1E3A8A';
          const protLabelPx = 10 / view.boardScale;
          ctx.font = `${protLabelPx}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (let deg = 0; deg <= 180; deg++) {
            const isMajor = deg % 10 === 0;
            const isMid = deg % 5 === 0;
            const tickLen = isMajor ? 14 : isMid ? 9 : 5;
            const tickLenBoard = tickLen / view.boardScale;
            // 0° at right (+x), 180° at left (-x). Tick angle from +x going up.
            const a = -deg * Math.PI / 180; // negative because canvas y is down
            const innerR = r - tickLenBoard;
            ctx.lineWidth = (isMajor ? 1.4 : 1) / view.boardScale;
            ctx.beginPath();
            ctx.moveTo(innerR * Math.cos(a), innerR * Math.sin(a));
            ctx.lineTo(r * Math.cos(a), r * Math.sin(a));
            ctx.stroke();
            if (isMajor) {
              const labelR = r - tickLenBoard - 12 / view.boardScale;
              ctx.fillText(String(deg), labelR * Math.cos(a), labelR * Math.sin(a));
            }
          }
          // Crosshair at the centre — small + showing the rotation point.
          ctx.strokeStyle = '#1E3A8A';
          ctx.lineWidth = 1 / view.boardScale;
          const cross = 6 / view.boardScale;
          ctx.beginPath();
          ctx.moveTo(-cross, 0); ctx.lineTo(cross, 0);
          ctx.moveTo(0, -cross); ctx.lineTo(0, cross);
          ctx.stroke();
          ctx.restore();
          // Rotate handle on the 0° tip (drawn unrotated so it stays circular).
          const pose = getInstrumentPose(inst);
          if ('handle' in pose) {
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#1D4ED8';
            ctx.lineWidth = 1.6 / view.boardScale;
            ctx.beginPath();
            ctx.arc(pose.handle.x, pose.handle.y, 9 / view.boardScale, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        }
      });

      ctx.restore();
    }, [objects, selectedObjectId, selectedStrokeIndex, strokeBounds, strokes, currentStroke, color, width, tool, view, shapes, draftShape, selectedShape, shapeBounds, getObjectHandlePositions, marquee, multiObjectIds, multiShapeIds, multiStrokeIndices, multiTextIds, eraserMode, gridMode, instruments, getInstrumentPose, texts, selectedTextId, textEditor, measureText]);

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
      // AUTONOMOUS: Don't clobber local state while the user is mid-edit.
      // initialState changes whenever a force_sync_state / session_state
      // arrives — those can fire during normal use (run_preview, late
      // student joins). If the teacher is typing in a text label, the
      // hydration would replace `texts` with the server snapshot (which
      // might not include the in-progress text), drop the textarea, and
      // also reset `view` — yanking the textarea position out from
      // under their cursor. Same logic for an in-flight drag/draw.
      // The data isn't lost — it'll arrive via incremental whiteboard_*
      // events. We just defer the bulk-replace until interaction is idle.
      if (textEditor || dragRef.current) return;
      const normalized = (initialState.strokes || []).map(stroke => ({ ...stroke, id: stroke.id || newId('stroke'), tool: 'pen' as const }));
      setObjects(initialState.objects || []);
      setStrokes(normalized);
      setShapes(initialState.shapes || []);
      if (initialState.view) setView(initialState.view);
      if (initialState.gridMode) setGridMode(initialState.gridMode);
      if (initialState.instruments) setInstruments(initialState.instruments);
      if (initialState.texts) setTexts(initialState.texts);
      (initialState.objects || []).forEach(loadImage);
    }, [initialState, loadImage]); // eslint-disable-line react-hooks/exhaustive-deps

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
          // Don't delete shapes etc. while the user is typing in the text
          // editor — Backspace inside a textarea must work normally.
          if (textEditor) return;
          if (selectedObjectId) removeSelectedObject();
          if (selectedStrokeIndex !== null) deleteStrokeIndices([selectedStrokeIndex]);
          if (selectedShapeId) removeSelectedShape();
          if (selectedTextId) removeSelectedText();
          if (multiObjectIds.length > 0 || multiShapeIds.length > 0 || multiStrokeIndices.length > 0 || multiTextIds.length > 0) {
            removeMultiSelection();
          }
        }
        if (e.key === 'Escape') {
          setSelectedObjectId(null);
          setSelectedShapeId(null);
          setSelectedStrokeIndex(null);
          setSelectedTextId(null);
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
    }, [isActive, canEdit, selectedObjectId, selectedStrokeIndex, selectedShapeId, selectedTextId, removeSelectedObject, deleteStrokeIndices, removeSelectedShape, removeSelectedText, multiObjectIds.length, multiShapeIds.length, multiStrokeIndices.length, multiTextIds.length, removeMultiSelection, clearMultiSelection, undo, redo, textEditor]);

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
        setInstruments([]);
        setTexts([]);
        setSelectedObjectId(null);
        setSelectedStrokeIndex(null);
        setSelectedShapeId(null);
        setSelectedTextId(null);
        imageCacheRef.current.clear();
      };
      const handleReset = () => {
        setStrokes([]);
        setSelectedStrokeIndex(null);
      };
      const handleDeleteStroke = (data: { strokeIndex: number }) => {
        setStrokes(prev => prev.filter((_, index) => index !== data.strokeIndex));
      };
      const handleDeleteStrokes = (data: { strokeIds?: string[]; strokeIndices?: number[] }) => {
        // Prefer id-based delete (race-free). Fall back to legacy index-based
        // for backwards compatibility with any in-flight messages from older
        // server builds. Mixing both (a server in transition) is also handled.
        if (Array.isArray(data.strokeIds) && data.strokeIds.length > 0) {
          const ids = new Set(data.strokeIds);
          setStrokes(prev => prev.filter(s => !(s.id && ids.has(s.id))));
          return;
        }
        if (Array.isArray(data.strokeIndices)) {
          const toDelete = new Set(data.strokeIndices);
          setStrokes(prev => prev.filter((_, index) => !toDelete.has(index)));
        }
      };
      const handleSetGridMode = (data: { gridMode: GridMode }) => {
        if (data.gridMode === 'blank' || data.gridMode === 'grid' || data.gridMode === 'graph') {
          setGridMode(data.gridMode);
        }
      };
      const handleAddInstrument = (data: { instrument: BoardInstrument }) => {
        if (!data.instrument || !data.instrument.id) return;
        setInstruments(prev => prev.some(i => i.id === data.instrument.id) ? prev : [...prev, data.instrument]);
      };
      const handleUpdateInstrument = (data: { instrument: BoardInstrument }) => {
        if (!data.instrument || !data.instrument.id) return;
        setInstruments(prev => prev.map(i => i.id === data.instrument.id ? data.instrument : i));
      };
      const handleRemoveInstrument = (data: { instrumentId: string }) => {
        setInstruments(prev => prev.filter(i => i.id !== data.instrumentId));
      };
      const handleAddText = (data: { text: BoardText }) => {
        if (!data.text || !data.text.id) return;
        setTexts(prev => prev.some(t => t.id === data.text.id) ? prev : [...prev, data.text]);
      };
      const handleUpdateText = (data: { text: BoardText }) => {
        if (!data.text || !data.text.id) return;
        // updatedAt-based last-write-wins to break ties when teacher and an
        // edit-permitted student race on the same text.
        setTexts(prev => prev.map(t => {
          if (t.id !== data.text.id) return t;
          const incomingTs = data.text.updatedAt ?? 0;
          const currentTs = t.updatedAt ?? 0;
          return incomingTs >= currentTs ? data.text : t;
        }));
      };
      const handleRemoveText = (data: { textId: string }) => {
        setTexts(prev => prev.filter(t => t.id !== data.textId));
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
      socket.on('whiteboard_set_grid_mode', handleSetGridMode);
      socket.on('whiteboard_add_instrument', handleAddInstrument);
      socket.on('whiteboard_update_instrument', handleUpdateInstrument);
      socket.on('whiteboard_remove_instrument', handleRemoveInstrument);
      socket.on('whiteboard_add_text', handleAddText);
      socket.on('whiteboard_update_text', handleUpdateText);
      socket.on('whiteboard_remove_text', handleRemoveText);
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
        socket.off('whiteboard_set_grid_mode', handleSetGridMode);
        socket.off('whiteboard_add_instrument', handleAddInstrument);
        socket.off('whiteboard_update_instrument', handleUpdateInstrument);
        socket.off('whiteboard_remove_instrument', handleRemoveInstrument);
        socket.off('whiteboard_add_text', handleAddText);
        socket.off('whiteboard_update_text', handleUpdateText);
        socket.off('whiteboard_remove_text', handleRemoveText);
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

      // Ruler / protractor tool click — toggle spawn/remove. The instrument
      // itself is then interactive regardless of the active tool.
      if (tool === 'ruler' || tool === 'protractor') {
        toggleInstrument(tool);
        setTool('select');
        dragRef.current = null;
        return;
      }

      // Text tool click — open the inline editor at the click point. If
      // there's already a text under the cursor, edit that one instead of
      // creating a new label on top.
      if (tool === 'text') {
        const hitText = findTextAt(point);
        if (hitText) {
          setSelectedTextId(hitText.id);
          openTextEditor(hitText.x, hitText.y, hitText);
        } else {
          openTextEditor(point.x, point.y);
        }
        dragRef.current = null;
        return;
      }

      // Instrument hit-test runs BEFORE the regular tool dispatch, so
      // grabbing the ruler/protractor takes priority over "drawing on top
      // of it" with whatever tool happens to be active. Handle hits enter
      // rotate-and-resize mode; body hits enter translate mode.
      const instHit = findInstrumentAt(point);
      if (instHit) {
        dragRef.current = {
          mode: instHit.hit === 'handle' ? 'instrument-handle' : 'instrument-translate',
          pointerId: e.pointerId,
          startClientX: e.clientX, startClientY: e.clientY,
          startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY,
          instrumentId: instHit.inst.id,
          instrumentStart: { ...instHit.inst },
        };
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
        // Text hit — select and start a translate drag. Selection is
        // separate state from selectedShapeId so they don't shadow each
        // other; only one is set at a time per the resets below.
        const hitText = findTextAt(point);
        if (hitText) {
          setSelectedTextId(hitText.id);
          setSelectedShapeId(null);
          setSelectedObjectId(null);
          setSelectedStrokeIndex(null);
          dragRef.current = {
            mode: 'text-move',
            pointerId: e.pointerId,
            startClientX: e.clientX, startClientY: e.clientY,
            startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY,
            textId: hitText.id,
            textStartX: hitText.x,
            textStartY: hitText.y,
          };
          return;
        }
        const strokeIndex = findStrokeAtPoint(point);
        if (strokeIndex !== -1) {
          setSelectedObjectId(null);
          setSelectedShapeId(null);
          setSelectedTextId(null);
          setSelectedStrokeIndex(strokeIndex);
          clearMultiSelection();
          return;
        }
        // Nothing under the cursor — start a marquee multi-select drag.
        setSelectedObjectId(null);
        setSelectedShapeId(null);
        setSelectedStrokeIndex(null);
        setSelectedTextId(null);
        clearMultiSelection();
        setMarquee({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        dragRef.current = { mode: 'marquee', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY };
        return;
      }
      if (isShapeTool(tool)) {
        setSelectedObjectId(null);
        setSelectedStrokeIndex(null);
        setSelectedShapeId(null);
        const kind = shapeKindForTool(tool);
        if (!kind) return;
        // AUTONOMOUS: snap-to-grid when the teacher has graph paper on.
        // The default minor grid step is GRID_STEP (80 board units); if
        // they're using graph mode for math, drawing shapes onto the grid
        // intersections is exactly what they expect. Only applies in
        // 'graph' mode — plain 'grid' / 'blank' modes don't snap because
        // those are free-form notebook surfaces, not coordinate systems.
        const start = gridMode === 'graph' ? snapToGrid(point) : point;
        const draft: BoardShape = {
          id: newId('shape'),
          kind,
          x1: start.x, y1: start.y, x2: start.x, y2: start.y,
          color, width,
          createdAt: Date.now(),
          // Compass marks the construction-point centre on the resulting circle.
          ...(tool === 'compass' ? { centerMark: true } : {}),
        };
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
        const raw = screenToBoard(e.clientX, e.clientY);
        // Same snap behaviour as the start point: only in graph mode.
        const point = gridMode === 'graph' ? snapToGrid(raw) : raw;
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
      if (drag.mode === 'instrument-translate' && drag.instrumentId && drag.instrumentStart) {
        const dx = (e.clientX - drag.startClientX) / view.boardScale;
        const dy = (e.clientY - drag.startClientY) / view.boardScale;
        const start = drag.instrumentStart;
        const next: BoardInstrument = { ...start, x: start.x + dx, y: start.y + dy };
        // Don't broadcast every frame for translate — we'd flood the wire.
        // Local only here; emit on pointer-up.
        setInstruments(prev => prev.map(i => i.id === next.id ? next : i));
        return;
      }
      if (drag.mode === 'instrument-handle' && drag.instrumentId && drag.instrumentStart) {
        const start = drag.instrumentStart;
        const point = screenToBoard(e.clientX, e.clientY);
        if (start.kind === 'ruler') {
          // The handle simultaneously controls rotation AND length: place the
          // right tip exactly at the cursor, leaving the left tip pinned.
          const dx = point.x - start.x;
          const dy = point.y - start.y;
          const newLen = Math.max(40, Math.hypot(dx, dy));
          const newRot = (Math.atan2(dy, dx) * 180) / Math.PI;
          const next: BoardInstrument = { ...start, length: newLen, rotation: newRot };
          setInstruments(prev => prev.map(i => i.id === next.id ? next : i));
        } else {
          // Protractor: handle rotation only (radius is fixed).
          const dx = point.x - start.x;
          const dy = point.y - start.y;
          const newRot = (Math.atan2(dy, dx) * 180) / Math.PI;
          const next: BoardInstrument = { ...start, rotation: newRot };
          setInstruments(prev => prev.map(i => i.id === next.id ? next : i));
        }
        return;
      }
      if (drag.mode === 'text-move' && drag.textId && drag.textStartX !== undefined && drag.textStartY !== undefined) {
        const dx = (e.clientX - drag.startClientX) / view.boardScale;
        const dy = (e.clientY - drag.startClientY) / view.boardScale;
        const startX = drag.textStartX;
        const startY = drag.textStartY;
        // Local-only update during drag — emit on pointer up to avoid
        // flooding the wire with intermediate positions.
        setTexts(prev => prev.map(t => t.id === drag.textId ? { ...t, x: startX + dx, y: startY + dy } : t));
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
        // createdAt is set on EVERY stroke now (not just highlighter).
        // It's the z-order key — without it, two strokes drawn before and
        // after an image both render after the image in the unified pass.
        const stroke: DrawStroke = {
          id: newId('stroke'),
          points: currentStrokeRef.current,
          color: strokeTool === 'highlighter' ? '#FACC15' /* warm yellow highlighter */ : color,
          width: strokeTool === 'highlighter' ? Math.max(width * 3, 14) /* chunky highlighter */ : width,
          tool: strokeTool,
          createdAt: Date.now(),
        };
        setStrokes(prev => [...prev, stroke]);
        if (socket) socket.emit('whiteboard_draw', { roomId, stroke });
        // Highlighter strokes are ephemeral by design — don't put them on the
        // undo stack (they auto-disappear), so undoing wouldn't make sense.
        if (strokeTool !== 'highlighter') {
          recordAction({
            undo: () => {
              if (!stroke.id) return;
              setStrokes(prev => prev.filter(s => s.id !== stroke.id));
              if (socket) socket.emit('whiteboard_delete_strokes', { roomId, strokeIds: [stroke.id] });
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
              if (socket && canMutateImages) socket.emit('whiteboard_update_object', { roomId, object: before });
            },
            redo: () => {
              setObjects(prev => prev.map(o => o.id === after.id ? after : o));
              if (socket && canMutateImages) socket.emit('whiteboard_update_object', { roomId, object: after });
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
              if (socket && canMutateImages) socket.emit('whiteboard_update_object', { roomId, object: before });
            },
            redo: () => {
              setObjects(prev => prev.map(o => o.id === after.id ? after : o));
              if (socket && canMutateImages) socket.emit('whiteboard_update_object', { roomId, object: after });
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
            // Texts: measure each text's bbox and check overlap. Same
            // pattern as shapes/strokes — the union forms one logical
            // multi-selection across all four content kinds.
            const hitTexts = texts
              .filter(t => {
                const b = measureText(t);
                return rectsOverlap(marqueeRect, b);
              })
              .map(t => t.id);
            setMultiObjectIds(hitObjects);
            setMultiShapeIds(hitShapes);
            setMultiStrokeIndices(hitStrokes);
            setMultiTextIds(hitTexts);
          }
        }
        setMarquee(null);
      }
      if (drag.mode === 'pan') emitView(view);
      if ((drag.mode === 'instrument-translate' || drag.mode === 'instrument-handle') && drag.instrumentId) {
        // Broadcast the final pose to peers.
        const moved = instrumentsRef.current.find(i => i.id === drag.instrumentId);
        if (moved && socket && isTeacher) {
          socket.emit('whiteboard_update_instrument', { roomId, instrument: moved });
        }
      }
      if (drag.mode === 'text-move' && drag.textId) {
        // Broadcast the final position. Capture before/after for undo.
        const moved = textsRef.current.find(t => t.id === drag.textId);
        if (moved && socket && isTeacher) {
          socket.emit('whiteboard_update_text', { roomId, text: moved });
        }
        if (moved && drag.textStartX !== undefined && drag.textStartY !== undefined) {
          const before: BoardText = { ...moved, x: drag.textStartX, y: drag.textStartY };
          const after: BoardText = { ...moved };
          recordAction({
            undo: () => updateText(before),
            redo: () => updateText(after),
          });
        }
      }
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

    // AUTONOMOUS: [ORDER-1 CRITICAL] - Native non-passive wheel listener so
    // preventDefault() ACTUALLY works.
    //
    // React's synthetic onWheel is bound as a passive listener by default,
    // which means our preventDefault() above is silently ignored. Result on
    // a Mac trackpad: pinch-zoom (which fires wheel with ctrlKey:true) was
    // zooming the whole BROWSER PAGE instead of the whiteboard — toolbar
    // and all. Same for Ctrl+wheel on any platform.
    //
    // The fix is to attach a non-passive `wheel` listener directly to the
    // canvas via addEventListener with `{ passive: false }`. We also block
    // ALL ctrl+wheel anywhere in the canvas-wrap so a pinch landing on the
    // wrap padding (just outside the canvas pixel area) doesn't slip
    // through to the browser.
    useEffect(() => {
      if (!isActive) return;
      const canvas = canvasRef.current;
      const wrap = containerRef.current;
      if (!canvas || !wrap) return;
      // Block any native wheel that would otherwise reach the browser zoom
      // handler. We always preventDefault here — React's synthetic onWheel
      // (above) does the actual zoom/pan logic.
      const blockNativeZoom = (e: WheelEvent) => {
        // Always prevent: even non-ctrl wheel on the canvas wrap should not
        // scroll the surrounding page (the page is fixed-height in the
        // room). React's onWheel handles the desired pan/zoom semantics.
        e.preventDefault();
      };
      canvas.addEventListener('wheel', blockNativeZoom, { passive: false });
      wrap.addEventListener('wheel', blockNativeZoom, { passive: false });
      return () => {
        canvas.removeEventListener('wheel', blockNativeZoom);
        wrap.removeEventListener('wheel', blockNativeZoom);
      };
    }, [isActive]);

    // AUTONOMOUS: [ORDER-1 CRITICAL] - Page-wide guard against browser zoom
    // while the whiteboard is mounted.
    //
    // Two failure modes this catches:
    //   1. Pinch zoom on a Mac trackpad anywhere OUTSIDE the canvas area
    //      (the toolbar rail, the topbar, the page chrome). The native
    //      gesture fires wheel with ctrlKey:true and the browser zooms.
    //   2. Cmd/Ctrl+= / Cmd/Ctrl+- / Cmd/Ctrl+0 keyboard shortcuts.
    // Result was the entire UI scaling — buttons too, exactly the bug the
    // user reported. We block these only while a teaching surface is
    // active so the home page is unaffected.
    useEffect(() => {
      if (!isActive) return;
      const onWheel = (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
        }
      };
      const onKey = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
          e.preventDefault();
        }
      };
      window.addEventListener('wheel', onWheel, { passive: false });
      window.addEventListener('keydown', onKey);
      return () => {
        window.removeEventListener('wheel', onWheel);
        window.removeEventListener('keydown', onKey);
      };
    }, [isActive]);

    // AUTONOMOUS: [ORDER-1 CRITICAL] - Safari-specific: pinch-zoom fires
    // gesturestart/gesturechange/gestureend events (different from wheel).
    // Block them so Safari doesn't fall back to its own zoom semantics.
    useEffect(() => {
      if (!isActive) return;
      const block = (e: Event) => e.preventDefault();
      window.addEventListener('gesturestart', block as any);
      window.addEventListener('gesturechange', block as any);
      window.addEventListener('gestureend', block as any);
      return () => {
        window.removeEventListener('gesturestart', block as any);
        window.removeEventListener('gesturechange', block as any);
        window.removeEventListener('gestureend', block as any);
      };
    }, [isActive]);

    // AUTONOMOUS: [ORDER-1 CRITICAL] - Cap image size before it enters the
    // board state. Without this, dropping a 50MB phone photo would:
    //   (a) bloat room.whiteboard.objects, which gets JSON.stringified on
    //       every save tick — multi-MB writes to disk every 5 minutes,
    //   (b) get base64'd and broadcast over the socket to every peer,
    //       blowing past Socket.IO's 5MB default frame size and silently
    //       dropping the message (image never appears for students),
    //   (c) accumulate in localStorage if we ever add client persistence.
    // 4MB is generous for a math teaching context; bigger images get
    // downscaled to fit a 2048px max edge before insertion.
    const IMAGE_BYTE_CAP = 4 * 1024 * 1024;
    const IMAGE_MAX_EDGE = 2048;

    const ingestImageBlob = useCallback(async (blob: Blob): Promise<void> => {
      // Decode → measure → optionally downscale → addImageObject
      // Reject anything that's not actually an image type.
      if (!blob.type.startsWith('image/')) return;

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      }).catch(() => '');
      if (!dataUrl) return;

      const img = await new Promise<HTMLImageElement | null>(resolve => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => resolve(null);
        i.src = dataUrl;
      });
      if (!img) return;

      // Fast path: small image, no rescaling needed.
      const tooLarge = blob.size > IMAGE_BYTE_CAP || img.naturalWidth > IMAGE_MAX_EDGE || img.naturalHeight > IMAGE_MAX_EDGE;
      if (!tooLarge) {
        addImageObject(dataUrl, img.naturalWidth, img.naturalHeight);
        return;
      }

      // Downscale via offscreen canvas. Preserves aspect ratio; clamps
      // longest edge to IMAGE_MAX_EDGE. Re-encodes as JPEG quality 0.85
      // for big photos (PNG would still be huge for photographic content).
      const ratio = Math.min(IMAGE_MAX_EDGE / img.naturalWidth, IMAGE_MAX_EDGE / img.naturalHeight, 1);
      const w = Math.round(img.naturalWidth * ratio);
      const h = Math.round(img.naturalHeight * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      // PNGs without transparency become huge; force JPEG for photographic
      // content over the threshold. Keep PNG for transparent images.
      const hasAlpha = blob.type === 'image/png' || blob.type === 'image/webp';
      const outputUrl = canvas.toDataURL(hasAlpha ? 'image/png' : 'image/jpeg', 0.85);
      addImageObject(outputUrl, w, h);
    }, [addImageObject]);

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      void ingestImageBlob(file);
    };

    useEffect(() => {
      if (!isActive || !isTeacher) return;
      const handlePaste = (e: ClipboardEvent) => {
        const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
        const blob = item?.getAsFile();
        if (!blob) return;
        e.preventDefault();
        void ingestImageBlob(blob);
      };
      window.addEventListener('paste', handlePaste);
      return () => window.removeEventListener('paste', handlePaste);
    }, [isActive, isTeacher, ingestImageBlob]);

    const clearInk = () => {
      setStrokes([]);
      setSelectedStrokeIndex(null);
      if (socket && isTeacher) socket.emit('whiteboard_reset', { roomId });
    };

    const clearBoard = () => {
      setObjects([]);
      setStrokes([]);
      setShapes([]);
      setInstruments([]);
      setTexts([]);
      setSelectedObjectId(null);
      setSelectedStrokeIndex(null);
      setSelectedShapeId(null);
      setSelectedTextId(null);
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

    // AUTONOMOUS: Commit any in-flight gesture when isActive flips false.
    // Without this, if the teacher pen-down → drag → mode-toggles to HTML
    // mid-stroke, isActive flips false → component returns null → canvas
    // unmounts → pointerUp never fires → currentStrokeRef points are
    // discarded and no `whiteboard_draw` ever emits. Student sees nothing,
    // teacher sees half a stroke disappear. Same bug for shape-create.
    // Fix: when isActive transitions to false, finalize the in-flight
    // gesture before the canvas unmounts.
    useEffect(() => {
      if (isActive) return;
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === 'draw' && currentStrokeRef.current.length > 1) {
        const strokeTool: DrawStroke['tool'] =
          (tool === 'eraser' && eraserMode === 'pixel') ? 'eraser-pixel' :
          tool === 'highlighter' ? 'highlighter' :
          'pen';
        const stroke: DrawStroke = {
          id: newId('stroke'),
          points: currentStrokeRef.current,
          color: strokeTool === 'highlighter' ? '#FACC15' : color,
          width: strokeTool === 'highlighter' ? Math.max(width * 3, 14) : width,
          tool: strokeTool,
          createdAt: Date.now(),
        };
        setStrokes(prev => [...prev, stroke]);
        if (socket) socket.emit('whiteboard_draw', { roomId, stroke });
      } else if (drag.mode === 'shape-create' && draftShapeRef.current) {
        const finished = draftShapeRef.current;
        const minDelta = 4 / view.boardScale;
        const dx = Math.abs(finished.x2 - finished.x1);
        const dy = Math.abs(finished.y2 - finished.y1);
        if (dx > minDelta || dy > minDelta) {
          setShapes(prev => [...prev, finished]);
          if (socket && isTeacher) socket.emit('whiteboard_add_shape', { roomId, shape: finished });
        }
        setDraftShape(null);
      }
      // Always clear in-flight state regardless of which mode.
      dragRef.current = null;
      setLiveStroke([]);
    }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!isActive) return null;

    const rulerActive = instruments.some(i => i.kind === 'ruler');
    const protractorActive = instruments.some(i => i.kind === 'protractor');

    const tools: Array<{ id: BoardTool; label: string; icon: React.ReactNode; pressed?: boolean }> = [
      // AUTONOMOUS: [ORDER-3 FRICTION] - Eraser used to live at the bottom
      // of a 12-tool rail. On a 13" MacBook the rail overflowed and Eraser
      // was below the viewport with no way to scroll. Reordered:
      //   - core editing (Select, Pen, Eraser, Highlighter) at the top —
      //     the most-reached tools
      //   - shapes (Line / Rect / Circle / Arrow) next
      //   - text + math instruments (Compass / Ruler / Protractor)
      //   - utility (Hand / image upload) at the end
      // Combined with the new scrollable rail (CSS) the user reaches every
      // tool on every screen size.
      { id: 'select', label: 'Select', icon: <path d="M4 4l7 16 2-7 7-2L4 4z" /> },
      { id: 'pen', label: 'Pen', icon: <path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5L17 3z" /> },
      { id: 'eraser', label: 'Eraser', icon: <><path d="m7 21-4-4 11-11 4 4L7 21z" /><path d="M14 6l4-4 4 4-4 4" /><path d="M3 21h18" /></> },
      // Highlighter — fades after a few seconds. Chunky marker icon.
      { id: 'highlighter', label: 'Highlighter', icon: <><path d="M9 11l-4 4v3h3l4-4" /><path d="M11 9l5-5 4 4-5 5z" /><path d="M14 6l4 4" /></> },
      // Text — typed labels for math (eg "x = 45°", "let n be even"). Click
      // anywhere on the board, type, press Enter to commit.
      { id: 'text', label: 'Text', icon: <><path d="M4 7V5h16v2" /><path d="M9 19h6" /><path d="M12 5v14" /></> },
      { id: 'line', label: 'Line', icon: <path d="M5 19L19 5" /> },
      { id: 'rect', label: 'Rectangle', icon: <rect x="4" y="6" width="16" height="12" /> },
      { id: 'circle', label: 'Circle', icon: <circle cx="12" cy="12" r="8" /> },
      { id: 'arrow', label: 'Arrow', icon: <><path d="M5 19L19 5" /><path d="M12 5h7v7" /></> },
      // Compass — circle drawn from the centre, leaves a small dot at the centre point.
      { id: 'compass', label: 'Compass', icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><path d="M12 4v3" /></> },
      // Ruler — toggle: spawn / remove the ruler instrument on the board.
      { id: 'ruler', label: 'Ruler', icon: <><path d="M3 14l11-11 7 7-11 11z" /><path d="M7 10l1 1M10 7l1 1M13 4l1 1M5 16l1 1" /></>, pressed: rulerActive },
      // Protractor — toggle: spawn / remove the protractor instrument.
      { id: 'protractor', label: 'Protractor', icon: <><path d="M3 14a9 9 0 0 1 18 0" /><path d="M3 14h18" /><path d="M12 14v-3" /></>, pressed: protractorActive },
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
      tool === 'compass' ? 'Compass — click and drag from centre to draw a circle with a centre mark' :
      tool === 'ruler' ? 'Click to drop a ruler on the board' :
      tool === 'protractor' ? 'Click to drop a protractor on the board' :
      tool === 'highlighter' ? 'Highlighter — fades away after a few seconds' :
      tool === 'text' ? 'Text — click on the board, type, Enter to commit' :
      'Draw ink';

    // Text uses the color picker (so the teacher can pick a colour for the
    // label), but not the width slider (font size is fixed at default).
    const showColorAndWidth = tool === 'pen' || tool === 'text' || (isShapeTool(tool) && tool !== 'ruler' && tool !== 'protractor');

    return (
      <div className="whiteboard-shell">
        <input ref={uploadInputRef} type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />

        {canEdit && (
          <aside className="whiteboard-rail" aria-label="Whiteboard tools">
            {tools.map(item => (
              <button
                key={item.id}
                onClick={() => setTool(item.id)}
                className={`whiteboard-tool ${tool === item.id ? 'active' : ''} ${item.pressed ? 'pressed' : ''}`}
                title={item.pressed ? `${item.label} on the board (click to remove)` : item.label}
                aria-label={item.label}
                aria-pressed={!!item.pressed}
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
          {canEdit && isTeacher && (
            <div className="whiteboard-control-group" role="group" aria-label="Grid style">
              <button
                onClick={() => setGridModeSynced('blank')}
                className={`whiteboard-action ${gridMode === 'blank' ? 'active' : ''}`}
                title="No grid — plain blank background"
              >Blank</button>
              <button
                onClick={() => setGridModeSynced('grid')}
                className={`whiteboard-action ${gridMode === 'grid' ? 'active' : ''}`}
                title="Notebook-paper grid"
              >Grid</button>
              <button
                onClick={() => setGridModeSynced('graph')}
                className={`whiteboard-action ${gridMode === 'graph' ? 'active' : ''}`}
                title="Graph paper with numbered axes through (0,0)"
              >Graph</button>
            </div>
          )}
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
          {/* AUTONOMOUS: [ORDER-3 FRICTION] - Font-size picker. Visible only
              while the Text tool is active so it doesn't crowd the toolbar
              for other tools. Sizes are board units; "Aa" labels visually
              differentiate them at a glance. Each new label bakes in the
              selected size at creation time. */}
          {tool === 'text' && (
            <div className="whiteboard-control-group" role="group" aria-label="Text size">
              {[16, 24, 36, 56].map((size, i) => (
                <button
                  key={size}
                  onClick={() => setTextFontSize(size)}
                  className={`whiteboard-action ${textFontSize === size ? 'active' : ''}`}
                  title={`${['Small', 'Normal', 'Large', 'Huge'][i]} text (${size}px)`}
                  style={{ fontSize: `${10 + i * 2}px`, fontWeight: 700, padding: '4px 10px' }}
                >Aa</button>
              ))}
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
          {canEdit && selectedTextId && <button onClick={removeSelectedText} className="whiteboard-action danger">Delete text</button>}
          {canEdit && (multiObjectIds.length + multiShapeIds.length + multiStrokeIndices.length + multiTextIds.length) > 0 && (
            <button onClick={removeMultiSelection} className="whiteboard-action danger">
              Delete {multiObjectIds.length + multiShapeIds.length + multiStrokeIndices.length + multiTextIds.length} items
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
                tool === 'eraser' ? ERASER_CURSOR :
                tool === 'pen' ? PEN_CURSOR :
                tool === 'highlighter' ? PEN_CURSOR :
                tool === 'text' ? 'text' :
                'crosshair',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onWheel={handleWheel}
            onDoubleClick={(e) => {
              // Double-click in the select tool re-opens the editor for the
              // text under the cursor — Excalidraw / FigJam UX.
              if (!canEdit || tool !== 'select') return;
              const rect = canvasRef.current?.getBoundingClientRect();
              if (!rect) return;
              const point = screenToBoard(e.clientX, e.clientY);
              const hit = findTextAt(point);
              if (hit) {
                setSelectedTextId(hit.id);
                openTextEditor(hit.x, hit.y, hit);
              }
            }}
          />
          {objects.length === 0 && strokes.length === 0 && shapes.length === 0 && texts.length === 0 && (
            <div className="whiteboard-empty">
              <h3>Whiteboard</h3>
              <p>{canEdit ? 'Use the tools on the left to draw, add shapes, erase, upload images, and arrange the board.' : 'Waiting for the teacher to use the whiteboard.'}</p>
            </div>
          )}

          {/* Inline text editor overlay. A real textarea positioned at the
              text's board-space anchor, scaled to match the current zoom.
              Commits on Enter (without Shift) or blur; cancels on Escape. */}
          {textEditor && containerRef.current && (() => {
            const rect = containerRef.current.getBoundingClientRect();
            // Convert board-space anchor to wrapper-local CSS pixels.
            // (The canvas is absolute-inset, so wrapper-local === canvas-local.)
            const screenX = textEditor.boardX * view.boardScale + view.boardOffsetX;
            const screenY = textEditor.boardY * view.boardScale + view.boardOffsetY;
            const cssFontSize = Math.max(8, textEditor.fontSize * view.boardScale);
            return (
              <textarea
                ref={textEditorRef}
                autoFocus
                value={textEditor.value}
                onChange={(e) => setTextEditor(ed => ed ? { ...ed, value: e.target.value } : ed)}
                onBlur={commitTextEditor}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelTextEditor();
                  } else if (e.key === 'Enter' && !e.shiftKey) {
                    // Enter commits; Shift+Enter inserts a newline.
                    e.preventDefault();
                    commitTextEditor();
                  }
                  // Stop the global key handler from also acting on these keys
                  // while the editor is open (Backspace would delete selected
                  // shapes otherwise).
                  e.stopPropagation();
                }}
                style={{
                  position: 'absolute',
                  left: `${screenX}px`,
                  top: `${screenY}px`,
                  // Important: padding/border 0 so what the user types lines
                  // up exactly with where the committed text will render.
                  margin: 0,
                  padding: 0,
                  border: 'none',
                  outline: '2px solid #2563eb',
                  outlineOffset: '2px',
                  background: 'rgba(255,255,255,0.95)',
                  color: textEditor.color,
                  fontFamily: TEXT_FONT_FAMILY,
                  fontSize: `${cssFontSize}px`,
                  lineHeight: TEXT_LINE_HEIGHT_RATIO,
                  // Width grows with content; height auto-fits via rows
                  minWidth: `${Math.max(80, cssFontSize * 6)}px`,
                  width: 'auto',
                  resize: 'none',
                  overflow: 'hidden',
                  whiteSpace: 'pre',
                  zIndex: 40,
                  caretColor: textEditor.color,
                  boxShadow: '0 4px 14px rgba(15,23,42,0.18)',
                  borderRadius: 4,
                }}
                rows={Math.max(1, textEditor.value.split('\n').length)}
                // Auto-grow horizontally too (best effort — relies on
                // the textarea's intrinsic width with whiteSpace: 'pre').
                cols={Math.max(8, ...textEditor.value.split('\n').map(l => l.length + 1))}
              />
            );
          })()}

          <div className="whiteboard-hint">
            Space + drag pans. Wheel zooms. Select image or stroke, then press Delete.
          </div>
        </div>
      </div>
    );
  }
);

export default Whiteboard;
