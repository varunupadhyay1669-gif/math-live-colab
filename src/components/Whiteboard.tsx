import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Socket } from 'socket.io-client';
import katex from 'katex';
import rough from 'roughjs';
import { templates as templatesStore } from '../lib/prefs';

// AUTONOMOUS: KaTeX render helper. Safe-fails on invalid LaTeX (returns
// the source verbatim wrapped in a soft-error span) so a typo doesn't
// crash the whiteboard. throwOnError: false keeps KaTeX permissive.
function renderLatexToHtml(latex: string): string {
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      output: 'html',
      strict: 'ignore',
      // Display mode for big block math when wrapped in $$ ... $$
      displayMode: latex.startsWith('$$') && latex.endsWith('$$'),
    });
  } catch (err) {
    return `<span style="color:#DC2626;font-family:monospace;">[invalid: ${
      String(err).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c))
    }]</span>`;
  }
}

// Strip $...$ / $$...$$ delimiters before rendering. KaTeX expects raw
// LaTeX, not LaTeX-with-delimiters. We let the user type either form.
function stripMathDelimiters(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
    return trimmed.slice(2, -2);
  }
  if (trimmed.startsWith('$') && trimmed.endsWith('$') && trimmed.length > 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// AUTONOMOUS: KaTeX DOM-overlay component. Absolutely positioned at the
// label's current screen-space anchor; scales font-size with the board's
// current zoom so the math grows / shrinks naturally.
// `pointer-events: none` so canvas pointer handlers still fire underneath
// (drag/select/draw lands on the canvas, not the math overlay).
// onMeasure reports rendered pixel size back to the parent so hit-testing
// can use real bbox dimensions instead of guessing.
// AUTONOMOUS: types loose because this codebase has no @types/react;
// React's reserved `key` prop is rejected by strict component-prop types.
// Same workaround as ErrorBoundary.tsx / ShortcutsOverlay.tsx.
function MathLabel(props: any) {
  const latex: string = props.latex;
  const x: number = props.x;
  const y: number = props.y;
  const cssFontSize: number = props.cssFontSize;
  const color: string = props.color;
  const onMeasure: ((w: number, h: number) => void) | undefined = props.onMeasure;
  const ref = useRef<HTMLDivElement>(null);
  const html = renderLatexToHtml(latex);
  useEffect(() => {
    if (!ref.current || !onMeasure) return;
    // Defer to next frame so KaTeX has painted before we measure.
    const handle = requestAnimationFrame(() => {
      if (!ref.current) return;
      onMeasure(ref.current.offsetWidth, ref.current.offsetHeight);
    });
    return () => cancelAnimationFrame(handle);
  }, [html, cssFontSize, onMeasure]);
  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        color,
        fontSize: `${cssFontSize}px`,
        pointerEvents: 'none',
        userSelect: 'none',
        // Match KaTeX's default line-height so the bbox lines up with
        // what the user expects. KaTeX itself sets line-height inside.
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

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

// ShapeKind now lives in lib/shapeGeometry alongside the corner maths, so the
// renderer and the hit test cannot drift apart on what a shape actually is.
import { shapePolygon, isPolygonal, ellipseBox, nearEllipseEdge, SHAPE_CATALOG, type ShapeKind } from '../lib/shapeGeometry';
export type { ShapeKind };
type ShapeFillStyle = 'solid' | 'hachure' | 'cross-hatch';
type ShapeStrokeStyle = 'solid' | 'dashed' | 'dotted';

// Stable rough.js seed from a shape id so the hand-drawn rendering doesn't
// re-randomise (wiggle) on every animation-frame redraw.
function shapeSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1_000_000) || 1;
}

interface BoardShape {
  id: string;
  kind: ShapeKind;
  // Excalidraw-style styling (all optional; absent = crisp-but-sketchy
  // outline, no fill, solid stroke — backward compatible with old shapes).
  fillColor?: string;            // shape fill; absent/'' = transparent
  fillStyle?: ShapeFillStyle;    // how the fill is drawn (default hachure)
  strokeStyle?: ShapeStrokeStyle; // solid (default) | dashed | dotted
  groupId?: string;              // shapes/text/images sharing this move + select together
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

// Preserve a stroke's tool across the wire and on hydration. Older persisted
// strokes (created before `tool` existed) and malformed payloads fall back to
// 'pen'; 'eraser-pixel' and 'highlighter' MUST survive or peers render erases
// as opaque ink and highlighters as permanent chunky pen strokes.
function coerceStrokeTool(tool: unknown): DrawStroke['tool'] {
  return tool === 'eraser-pixel' || tool === 'highlighter' ? tool : 'pen';
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
  groupId?: string;
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
  // AUTONOMOUS: Math mode. When true, `text` is treated as LaTeX source
  // and rendered via KaTeX as a DOM overlay positioned in board space.
  // When false (default), it's plain text rendered on canvas as before.
  // Stored explicitly (not auto-detected) so a teacher writing "$2" in
  // plain text doesn't suddenly render as math.
  latex?: boolean;
  groupId?: string;
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
  /** Ink as VECTORS, so the exporter can tell what is new since a snapshot. */
  getStrokes: () => Array<{ id?: string; points: Array<{ x: number; y: number }>; width: number; tool: string }>;
  /** The transform the board is drawn with, to place a stroke box on screen. */
  getView: () => { boardScale: number; boardOffsetX: number; boardOffsetY: number };
}

type BoardTool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'pan' | 'compass' | 'ruler' | 'protractor' | 'text' | ShapeKind;

// Default font size for new text in board units. ~24px at 100% zoom.
const TEXT_DEFAULT_FONT_SIZE = 24;
const TEXT_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TEXT_LINE_HEIGHT_RATIO = 1.25;

// Compass produces a regular circle shape but the gesture is "click + drag
// from the centre" (which the existing circle tool already does — compass
// just additionally tags the resulting shape with centerMark so the centre
// point is visible). Ruler / protractor are spawn-toggle instruments and
// don't go through the shape-create dispatch.
const SHAPE_KINDS = new Set<string>(SHAPE_CATALOG.map(s => s.id));
const SHAPE_TOOLS: BoardTool[] = [...SHAPE_CATALOG.map(s => s.id), 'compass'];
const isShapeTool = (t: BoardTool): boolean => SHAPE_TOOLS.includes(t);
const shapeKindForTool = (t: BoardTool): ShapeKind | null => {
  if (t === 'compass') return 'circle';
  return SHAPE_KINDS.has(t) ? (t as ShapeKind) : null;
};


// One small SVG per shape, drawn inside a 24x24 box. Used by the rail button
// (which shows the currently-chosen shape) and by the palette grid.
const SHAPE_ICONS: Record<string, React.ReactNode> = {
  line: <path d="M5 19L19 5" />,
  arrow: <><path d="M5 19L19 5" /><path d="M12 5h7v7" /></>,
  rect: <rect x="4" y="6" width="16" height="12" />,
  parallelogram: <path d="M8 6h12l-4 12H4z" />,
  trapezoid: <path d="M8 6h8l4 12H4z" />,
  diamond: <path d="M12 3l9 9-9 9-9-9z" />,
  triangle: <path d="M12 4l9 16H3z" />,
  rightTriangle: <path d="M5 4v16h15z" />,
  circle: <circle cx="12" cy="12" r="8" />,
  ellipse: <ellipse cx="12" cy="12" rx="9" ry="6" />,
  pentagon: <path d="M12 3l9 6.5-3.4 10.5H6.4L3 9.5z" />,
  hexagon: <path d="M8 4h8l4 8-4 8H8l-4-8z" />,
  star: <path d="M12 3l2.7 6.2 6.3.5-4.8 4.1 1.5 6.2L12 16.7 6.3 20l1.5-6.2L3 9.7l6.3-.5z" />,
};

// Default sizes for spawned instruments (board units).
const RULER_DEFAULT_LENGTH = 600;
const RULER_BODY_THICKNESS = 56; // height of the ruler body
const PROTRACTOR_DEFAULT_RADIUS = 240;

const COLORS = ['#111827', '#EF4444', '#10B981', '#2563EB', '#F59E0B', '#7C3AED', '#FFFFFF'];
// Soft fills for shapes (Excalidraw-style backgrounds) + a dark one.
const FILL_COLORS = ['#FDE68A', '#FCA5A5', '#A7F3D0', '#BFDBFE', '#DDD6FE', '#111827'];
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
      mode: 'draw' | 'erase' | 'pan' | 'object' | 'object-resize' | 'object-rotate' | 'shape-create' | 'shape-move' | 'group-move' | 'marquee' | 'instrument-translate' | 'instrument-handle' | 'text-move' | null;
      // Snapshot of every group member's start position, so a group drag moves
      // them all by the same delta. Additive — existing single-move modes are
      // untouched.
      groupSnapshot?: {
        shapes: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>;
        texts: Array<{ id: string; x: number; y: number }>;
        objects: Array<{ id: string; x: number; y: number }>;
      };
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
      latex: boolean;        // toggle: plain text vs KaTeX-rendered math
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
    // Which shape the rail button offers. Remembered because a tutor drawing
    // triangles draws several in a row — reopening the palette each time is the
    // friction that sends people back to freehand.
    const [lastShape, setLastShape] = useState<ShapeKind>('rect');
    const [showShapePalette, setShowShapePalette] = useState(false);
    // When tool is 'eraser', this picks between two eraser flavours:
    //   stroke = click on a stroke to delete the entire stroke (existing).
    //   pixel  = drag to "paint" an erase path that removes whatever it
    //            crosses (image / shape / pen ink), pixel-eraser style.
    const [eraserMode, setEraserMode] = useState<'stroke' | 'pixel'>('stroke');
    const [color, setColor] = useState('#111827');
    const [width, setWidth] = useState(4);
    // Shape styling (Excalidraw-style). Defaults for new shapes; also edits the
    // selected shape live via applyShapeStyle.
    const [fillColor, setFillColor] = useState('');                       // '' = no fill
    const [fillStyle, setFillStyle] = useState<ShapeFillStyle>('hachure');
    const [strokeStyle, setStrokeStyle] = useState<ShapeStrokeStyle>('solid');
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

    // AUTONOMOUS: Save-as-template modal state.
    // Inline so the Whiteboard component is self-contained — it has all
    // the state needed to serialize the snapshot in one place.
    const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
    const [saveTemplateName, setSaveTemplateName] = useState('');
    const [saveTemplateToast, setSaveTemplateToast] = useState<string | null>(null);

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

    // Set styling for NEW shapes, and (if a shape is selected) apply it live to
    // that shape too — synced + undoable like any other shape edit.
    const applyShapeStyle = useCallback((patch: { fillColor?: string; fillStyle?: ShapeFillStyle; strokeStyle?: ShapeStrokeStyle }) => {
      if (patch.fillColor !== undefined) setFillColor(patch.fillColor);
      if (patch.fillStyle !== undefined) setFillStyle(patch.fillStyle);
      if (patch.strokeStyle !== undefined) setStrokeStyle(patch.strokeStyle);
      const sel = selectedShapeId ? shapes.find(s => s.id === selectedShapeId) : null;
      if (!sel) return;
      const before: BoardShape = { ...sel };
      const after: BoardShape = { ...sel, ...patch };
      setShapes(prev => prev.map(s => (s.id === sel.id ? after : s)));
      if (socket && isTeacher) socket.emit('whiteboard_update_shape', { roomId, shape: after });
      recordAction({
        undo: () => { setShapes(prev => prev.map(s => (s.id === before.id ? before : s))); if (socket && isTeacher) socket.emit('whiteboard_update_shape', { roomId, shape: before }); },
        redo: () => { setShapes(prev => prev.map(s => (s.id === after.id ? after : s))); if (socket && isTeacher) socket.emit('whiteboard_update_shape', { roomId, shape: after }); },
      });
    }, [selectedShapeId, shapes, socket, isTeacher, roomId, recordAction]);

    // Currently-selected ids across single + multi selection (shapes/text/images).
    const getSelectedSets = useCallback(() => ({
      shapeIds: new Set<string>([...(selectedShapeId ? [selectedShapeId] : []), ...multiShapeIds]),
      textIds: new Set<string>([...(selectedTextId ? [selectedTextId] : []), ...multiTextIds]),
      objIds: new Set<string>([...(selectedObjectId ? [selectedObjectId] : []), ...multiObjectIds]),
    }), [selectedShapeId, selectedTextId, selectedObjectId, multiShapeIds, multiTextIds, multiObjectIds]);

    // Add freshly-built clone items (shapes/text/images): apply to state, sync,
    // select the copies, and make it undoable. Shared by duplicate + paste.
    const commitNewItems = useCallback((shapeClones: BoardShape[], textClones: BoardText[], objClones: BoardImageObject[]) => {
      if (!shapeClones.length && !textClones.length && !objClones.length) return;
      const addAll = () => {
        if (shapeClones.length) setShapes(prev => [...prev, ...shapeClones]);
        if (textClones.length) setTexts(prev => [...prev, ...textClones]);
        if (objClones.length) setObjects(prev => [...prev, ...objClones]);
        if (socket) {
          if (isTeacher) { shapeClones.forEach(s => socket.emit('whiteboard_add_shape', { roomId, shape: s })); textClones.forEach(t => socket.emit('whiteboard_add_text', { roomId, text: t })); }
          if (canMutateImages) objClones.forEach(o => socket.emit('whiteboard_add_image', { roomId, object: o }));
        }
      };
      const removeAll = () => {
        const sId = new Set(shapeClones.map(s => s.id)), tId = new Set(textClones.map(t => t.id)), oId = new Set(objClones.map(o => o.id));
        if (shapeClones.length) setShapes(prev => prev.filter(s => !sId.has(s.id)));
        if (textClones.length) setTexts(prev => prev.filter(t => !tId.has(t.id)));
        if (objClones.length) setObjects(prev => prev.filter(o => !oId.has(o.id)));
        if (socket) {
          if (isTeacher) { shapeClones.forEach(s => socket.emit('whiteboard_remove_shape', { roomId, shapeId: s.id })); textClones.forEach(t => socket.emit('whiteboard_remove_text', { roomId, textId: t.id })); }
          if (canMutateImages) objClones.forEach(o => socket.emit('whiteboard_remove_object', { roomId, objectId: o.id }));
        }
      };
      addAll();
      setSelectedShapeId(null); setSelectedObjectId(null); setSelectedTextId(null); setSelectedStrokeIndex(null);
      clearMultiSelection();
      setMultiShapeIds(shapeClones.map(s => s.id));
      setMultiTextIds(textClones.map(t => t.id));
      setMultiObjectIds(objClones.map(o => o.id));
      recordAction({ undo: removeAll, redo: addAll });
    }, [socket, isTeacher, canMutateImages, roomId, recordAction, clearMultiSelection]);

    // ── Duplicate selection (Ctrl+D) — shapes / text / images ──
    const duplicateSelection = useCallback(() => {
      const OFF = 24, now = Date.now();
      const { shapeIds, textIds, objIds } = getSelectedSets();
      const shapeClones: BoardShape[] = shapes.filter(s => shapeIds.has(s.id)).map(s => ({ ...s, id: newId('shape'), x1: s.x1 + OFF, y1: s.y1 + OFF, x2: s.x2 + OFF, y2: s.y2 + OFF, createdAt: now }));
      const textClones: BoardText[] = texts.filter(t => textIds.has(t.id)).map(t => ({ ...t, id: newId('text'), x: t.x + OFF, y: t.y + OFF, createdAt: now, updatedAt: now }));
      const objClones: BoardImageObject[] = objects.filter(o => objIds.has(o.id)).map(o => ({ ...o, id: newId('img'), x: o.x + OFF, y: o.y + OFF, zIndex: now }));
      commitNewItems(shapeClones, textClones, objClones);
    }, [shapes, texts, objects, getSelectedSets, commitNewItems]);

    // ── Copy / paste (Ctrl+C / Ctrl+V) — works across rooms + tabs via
    // localStorage, so a teacher can copy a diagram from one student's board
    // and paste it into another's. ──
    const WB_CLIPBOARD_KEY = 'mathlive:wb-clipboard';
    const copySelection = useCallback(() => {
      const { shapeIds, textIds, objIds } = getSelectedSets();
      const payload = {
        shapes: shapes.filter(s => shapeIds.has(s.id)),
        texts: texts.filter(t => textIds.has(t.id)),
        objects: objects.filter(o => objIds.has(o.id)),
      };
      if (!payload.shapes.length && !payload.texts.length && !payload.objects.length) return;
      try { localStorage.setItem(WB_CLIPBOARD_KEY, JSON.stringify(payload)); } catch { /* quota / disabled — ignore */ }
    }, [shapes, texts, objects, getSelectedSets]);

    const pasteClipboard = useCallback(() => {
      let payload: { shapes?: BoardShape[]; texts?: BoardText[]; objects?: BoardImageObject[] } | null = null;
      try { const raw = localStorage.getItem(WB_CLIPBOARD_KEY); payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
      if (!payload) return;
      const OFF = 24, now = Date.now();
      const shapeClones: BoardShape[] = (payload.shapes || []).map(s => ({ ...s, id: newId('shape'), x1: s.x1 + OFF, y1: s.y1 + OFF, x2: s.x2 + OFF, y2: s.y2 + OFF, createdAt: now }));
      const textClones: BoardText[] = (payload.texts || []).map(t => ({ ...t, id: newId('text'), x: t.x + OFF, y: t.y + OFF, createdAt: now, updatedAt: now }));
      const objClones: BoardImageObject[] = (payload.objects || []).map(o => ({ ...o, id: newId('img'), x: o.x + OFF, y: o.y + OFF, zIndex: now }));
      commitNewItems(shapeClones, textClones, objClones);
    }, [commitNewItems]);

    // ── Z-order: bring to front / send to back — shapes / text / images ──
    const zOrderSelection = useCallback((toFront: boolean) => {
      const z = toFront ? Date.now() : 1;
      const { shapeIds, textIds, objIds } = getSelectedSets();
      if (!shapeIds.size && !textIds.size && !objIds.size) return;
      const beforeShapes = shapes.filter(s => shapeIds.has(s.id)).map(s => ({ ...s }));
      const afterShapes = beforeShapes.map(s => ({ ...s, createdAt: z }));
      const beforeTexts = texts.filter(t => textIds.has(t.id)).map(t => ({ ...t }));
      const afterTexts = beforeTexts.map(t => ({ ...t, createdAt: z }));
      const beforeObjs = objects.filter(o => objIds.has(o.id)).map(o => ({ ...o }));
      const afterObjs = beforeObjs.map(o => ({ ...o, zIndex: z }));
      const apply = (sh: BoardShape[], tx: BoardText[], ob: BoardImageObject[]) => {
        if (sh.length) setShapes(prev => prev.map(s => sh.find(x => x.id === s.id) || s));
        if (tx.length) setTexts(prev => prev.map(t => tx.find(x => x.id === t.id) || t));
        if (ob.length) setObjects(prev => prev.map(o => ob.find(x => x.id === o.id) || o));
        if (socket) {
          if (isTeacher) { sh.forEach(s => socket.emit('whiteboard_update_shape', { roomId, shape: s })); tx.forEach(t => socket.emit('whiteboard_update_text', { roomId, text: t })); }
          if (canMutateImages) ob.forEach(o => socket.emit('whiteboard_update_object', { roomId, object: o }));
        }
      };
      apply(afterShapes, afterTexts, afterObjs);
      recordAction({ undo: () => apply(beforeShapes, beforeTexts, beforeObjs), redo: () => apply(afterShapes, afterTexts, afterObjs) });
    }, [shapes, texts, objects, getSelectedSets, socket, isTeacher, canMutateImages, roomId, recordAction]);

    // ── Group / ungroup (Ctrl+G / Ctrl+Shift+G) ──
    // Stamps a shared `groupId` onto the selected shapes/text/images. Clicking
    // any one member afterwards selects + drags the whole group as a unit.
    // Same before/after + emit + undo shape as zOrderSelection.
    const setGroupId = useCallback((shapeIds: Set<string>, textIds: Set<string>, objIds: Set<string>, gid: string | undefined) => {
      const beforeShapes = shapes.filter(s => shapeIds.has(s.id)).map(s => ({ ...s }));
      const afterShapes = beforeShapes.map(s => ({ ...s, groupId: gid }));
      const beforeTexts = texts.filter(t => textIds.has(t.id)).map(t => ({ ...t }));
      const afterTexts = beforeTexts.map(t => ({ ...t, groupId: gid }));
      const beforeObjs = objects.filter(o => objIds.has(o.id)).map(o => ({ ...o }));
      const afterObjs = beforeObjs.map(o => ({ ...o, groupId: gid }));
      if (!beforeShapes.length && !beforeTexts.length && !beforeObjs.length) return;
      const apply = (sh: BoardShape[], tx: BoardText[], ob: BoardImageObject[]) => {
        if (sh.length) setShapes(prev => prev.map(s => sh.find(x => x.id === s.id) || s));
        if (tx.length) setTexts(prev => prev.map(t => tx.find(x => x.id === t.id) || t));
        if (ob.length) setObjects(prev => prev.map(o => ob.find(x => x.id === o.id) || o));
        if (socket) {
          if (isTeacher) { sh.forEach(s => socket.emit('whiteboard_update_shape', { roomId, shape: s })); tx.forEach(t => socket.emit('whiteboard_update_text', { roomId, text: t })); }
          if (canMutateImages) ob.forEach(o => socket.emit('whiteboard_update_object', { roomId, object: o }));
        }
      };
      apply(afterShapes, afterTexts, afterObjs);
      recordAction({ undo: () => apply(beforeShapes, beforeTexts, beforeObjs), redo: () => apply(afterShapes, afterTexts, afterObjs) });
    }, [shapes, texts, objects, socket, isTeacher, canMutateImages, roomId, recordAction]);

    const groupSelection = useCallback(() => {
      const { shapeIds, textIds, objIds } = getSelectedSets();
      // Need at least two members for a group to mean anything.
      if (shapeIds.size + textIds.size + objIds.size < 2) return;
      setGroupId(shapeIds, textIds, objIds, newId('grp'));
    }, [getSelectedSets, setGroupId]);

    const ungroupSelection = useCallback(() => {
      // Expand the selection to every member of every group represented in it,
      // then clear their groupId — so ungrouping one member ungroups the whole.
      const { shapeIds, textIds, objIds } = getSelectedSets();
      const gids = new Set<string>();
      shapes.forEach(s => { if (s.groupId && shapeIds.has(s.id)) gids.add(s.groupId); });
      texts.forEach(t => { if (t.groupId && textIds.has(t.id)) gids.add(t.groupId); });
      objects.forEach(o => { if (o.groupId && objIds.has(o.id)) gids.add(o.groupId); });
      if (!gids.size) return;
      const sIds = new Set(shapes.filter(s => s.groupId && gids.has(s.groupId)).map(s => s.id));
      const tIds = new Set(texts.filter(t => t.groupId && gids.has(t.groupId)).map(t => t.id));
      const oIds = new Set(objects.filter(o => o.groupId && gids.has(o.groupId)).map(o => o.id));
      setGroupId(sIds, tIds, oIds, undefined);
    }, [getSelectedSets, setGroupId, shapes, texts, objects]);

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
      if (shape.kind === 'ellipse') {
        return nearEllipseEdge(point.x, point.y, shape.x1, shape.y1, shape.x2, shape.y2, tol);
      }
      // Every other closed outline: the SAME corners the renderer drew, so a
      // shape can never be visible-but-unselectable.
      const poly = shapePolygon(shape.kind, shape.x1, shape.y1, shape.x2, shape.y2);
      if (poly) {
        for (let i = 0; i < poly.length; i++) {
          const a = { x: poly[i][0], y: poly[i][1] };
          const b = { x: poly[(i + 1) % poly.length][0], y: poly[(i + 1) % poly.length][1] };
          if (distanceToSegment(point, a, b) <= tol) return true;
        }
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
    // AUTONOMOUS: Per-id cache of rendered math bbox. The DOM-overlay
    // math text component reports its rendered size back via this map
    // after KaTeX paints; hit-testing reads from here. board-space units.
    const mathBboxesRef = useRef<Map<string, { w: number; h: number }>>(new Map());

    const measureText = useCallback((text: BoardText): { x: number; y: number; w: number; h: number; lines: string[] } => {
      // For LaTeX text, use the cached bbox reported by the KaTeX DOM
      // overlay. If we don't have one yet (e.g. brand-new text not yet
      // mounted), use a rough estimate so the marquee/selection chrome
      // doesn't collapse to zero.
      if (text.latex) {
        const cached = mathBboxesRef.current.get(text.id);
        const w = cached?.w ?? Math.max(120, text.text.length * text.fontSize * 0.45);
        const h = cached?.h ?? text.fontSize * 1.4;
        return { x: text.x, y: text.y, w, h, lines: [text.text] };
      }
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
        latex: existing?.latex ?? false,
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
          latex: ed.latex,
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
          latex: ed.latex,
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

    // A shared-view update that arrived while this user was drawing, parked
    // until their pen lifts (see handleSetView).
    const pendingViewRef = useRef<BoardView | null>(null);
    // The board transform this stroke started under. Every point of a stroke is
    // mapped through the SAME transform, so nothing that changes the view
    // mid-stroke — a remote sync, a pinch, an auto-scroll — can bend the line
    // that is already being drawn.
    const strokeViewRef = useRef<BoardView | null>(null);

    /** screenToBoard against an explicit transform rather than the live one. */
    const screenToBoardWith = useCallback((v: BoardView | null, clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || !v) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left - v.boardOffsetX) / v.boardScale,
        y: (clientY - rect.top - v.boardOffsetY) / v.boardScale,
      };
    }, []);

    /** Pen lifted: release any view update we held back while drawing. */
    const flushPendingView = useCallback(() => {
      strokeViewRef.current = null;
      const pending = pendingViewRef.current;
      if (pending) { pendingViewRef.current = null; setView(pending); }
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

    // Always points at the latest redrawCanvas. loadImage's async img.onload
    // fires long after creation; without this ref it would capture the first
    // render's redrawCanvas (empty board + default view) and blank the canvas
    // on every image decode.
    const redrawCanvasRef = useRef<() => void>(() => {});
    const loadImage = useCallback((object: BoardImageObject) => {
      if (imageCacheRef.current.has(object.id)) return;
      const img = new Image();
      img.onload = () => redrawCanvasRef.current();
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

    // Latest zoomAt, reachable from long-lived native touch listeners without
    // putting zoomAt (whose identity changes on every view change) in their
    // effect deps. See the pinch-zoom effect: re-attaching listeners mid-pinch
    // reset pinchActive and killed the gesture after one step.
    const zoomAtRef = useRef(zoomAt);
    zoomAtRef.current = zoomAt;

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

    // ── PDF worksheet import ──
    // Renders each page to an image and lays them out down the board as normal
    // image objects. That's the whole trick: once a page is an image object it
    // inherits everything the whiteboard already does — pan/zoom to scroll
    // through the worksheet, the pen to write answers straight into the blank
    // spaces, z-order so ink sits ON TOP of the page, live sync to every
    // student, and undo. No new sync path, no new drawing surface.
    const [pdfBusy, setPdfBusy] = useState<string | null>(null);
    const pdfWorkerRef = useRef<Worker | null>(null);
    // Never let a stuck PDF stage sit there silently — surface it instead.
    const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timed out: ' + what)), ms))]);
    const addPdfPages = useCallback(async (file: File) => {
      const MAX_PAGES = 20;          // a worksheet, not a textbook
      const TARGET_PX = 1500;        // render width — crisp when zoomed in
      const PAGE_W = 820;            // board-units wide, so pages line up
      const GAP = 28;
      try {
        setPdfBusy('Opening PDF…');
        const pdfjs: any = await import('pdfjs-dist');
        // Hand pdf.js an explicitly-constructed module Worker rather than a
        // workerSrc URL. Setting workerSrc leaves pdf.js to resolve its own
        // worker internally, and under Vite that resolves to a SECOND,
        // differently-hashed copy whose request never completes — the import
        // then hangs forever with no error. `new Worker(new URL(...),
        // {type:'module'})` is the form Vite statically analyses and bundles
        // correctly, and workerPort makes pdf.js use exactly that instance.
        if (!pdfWorkerRef.current) {
          pdfWorkerRef.current = new Worker(
            new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
            { type: 'module' },
          );
        }
        pdfjs.GlobalWorkerOptions.workerPort = pdfWorkerRef.current;

        const data = await file.arrayBuffer();
        const pdf: any = await withTimeout<any>(pdfjs.getDocument({ data }).promise, 20000, 'opening the PDF');
        const pageCount = Math.min(pdf.numPages, MAX_PAGES);

        // Start near the top of what the teacher is currently looking at,
        // horizontally centred, then stack downwards.
        const container = containerRef.current;
        const rect = container?.getBoundingClientRect();
        const vw = container?.clientWidth || 1000;
        const anchor = screenToBoard((rect?.left || 0) + vw / 2, (rect?.top || 0) + 60);

        const created: BoardImageObject[] = [];
        let cursorY = anchor.y;
        for (let p = 1; p <= pageCount; p++) {
          setPdfBusy(`Adding page ${p} of ${pageCount}…`);
          const page = await pdf.getPage(p);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2.5, TARGET_PX / base.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          // White backing: PDF pages are transparent, and ink on a transparent
          // page would sit on the board's own background instead of paper.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          // Two non-obvious requirements here:
          //  • pdf.js v6 takes the CANVAS ELEMENT (`canvas`). `canvasContext` is
          //    a back-compat path that additionally requires `canvas: null`.
          //  • intent:'print' matters for correctness, not print output. With
          //    the default 'display' intent pdf.js drives rendering from
          //    requestAnimationFrame, which browsers FREEZE in a backgrounded
          //    or throttled tab — so the render promise simply never settles and
          //    the import hangs forever. Print intent renders synchronously off
          //    the rAF clock, so importing works even if the teacher switches
          //    tabs while picking the file. It also renders the printable
          //    appearance of form fields, which is what you want on a worksheet.
          await withTimeout(
            page.render({ canvas, viewport, background: '#ffffff', intent: 'print' } as any).promise,
            20000, `rendering page ${p}`,
          );
          const src = canvas.toDataURL('image/jpeg', 0.82);

          const drawScale = PAGE_W / canvas.width;
          const object: BoardImageObject = {
            id: newId('img'),
            type: 'image',
            src,
            x: anchor.x - PAGE_W / 2,
            y: cursorY,
            width: canvas.width,
            height: canvas.height,
            scale: drawScale,
            rotation: 0,
            // Keep pages BEHIND anything drawn later: page z-order is stamped
            // from a base time so student ink (stamped 'now') always paints on top.
            zIndex: Date.now() - (MAX_PAGES - p) - 100000,
          };
          cursorY += canvas.height * drawScale + GAP;
          created.push(object);
          setObjects(prev => [...prev, object]);
          loadImage(object);
          if (socket && canMutateImages) socket.emit('whiteboard_add_image', { roomId, object });
          // Yield so the board stays responsive while a long PDF imports.
          await new Promise(r => setTimeout(r, 0));
        }

        if (created.length) {
          // One undo for the whole worksheet, not one per page.
          recordAction({
            undo: () => {
              setObjects(prev => prev.filter(o => !created.some(c => c.id === o.id)));
              created.forEach(c => {
                imageCacheRef.current.delete(c.id);
                if (socket && canMutateImages) socket.emit('whiteboard_remove_object', { roomId, objectId: c.id });
              });
            },
            redo: () => {
              setObjects(prev => [...prev, ...created.filter(c => !prev.some(o => o.id === c.id))]);
              created.forEach(c => {
                loadImage(c);
                if (socket && canMutateImages) socket.emit('whiteboard_add_image', { roomId, object: c });
              });
            },
          });
          // Land on the pen so the teacher (or student) can write immediately.
          setSelectedObjectId(null);
          setTool('pen');
        }
        setPdfBusy(pdf.numPages > MAX_PAGES ? `Added the first ${MAX_PAGES} of ${pdf.numPages} pages` : null);
        if (pdf.numPages > MAX_PAGES) setTimeout(() => setPdfBusy(null), 4000);
      } catch (err) {
        console.error('PDF import failed', err);
        setPdfBusy(`Could not read that PDF — ${(err as Error)?.message || 'unknown error'}`);
        setTimeout(() => setPdfBusy(null), 5000);
      }
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

      // Excalidraw-style hand-drawn rendering via rough.js. A stable per-shape
      // seed keeps the sketch from re-randomising each frame. Optional fill
      // (solid/hachure/cross-hatch) and stroke style (dashed/dotted). Falls
      // back to crisp canvas rendering if rough ever throws.
      const rc = rough.canvas(canvas as HTMLCanvasElement);
      const drawShape = (shape: BoardShape) => {
        ctx.save();
        const sw = shape.width;
        const seed = shapeSeed(shape.id || 'shape');
        const dash =
          shape.strokeStyle === 'dashed' ? [sw * 3, sw * 2.5] :
          shape.strokeStyle === 'dotted' ? [0.1, sw * 2.2] : undefined;
        const opts: Record<string, unknown> = { stroke: shape.color, strokeWidth: sw, roughness: 1.1, bowing: 1, seed };
        if (dash) opts.strokeLineDash = dash;
        if (shape.fillColor) {
          opts.fill = shape.fillColor;
          opts.fillStyle = shape.fillStyle || 'hachure';
          opts.fillWeight = Math.max(sw * 0.5, 0.6);
          opts.hachureGap = Math.max(sw * 4, 6);
        }
        try {
          if (shape.kind === 'rect') {
            const x = Math.min(shape.x1, shape.x2), y = Math.min(shape.y1, shape.y2);
            rc.rectangle(x, y, Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1), opts);
          } else if (shape.kind === 'circle') {
            const r = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
            rc.ellipse(shape.x1, shape.y1, r * 2, r * 2, opts);
            if (shape.centerMark) {
              ctx.fillStyle = shape.color;
              ctx.beginPath();
              ctx.arc(shape.x1, shape.y1, Math.max(sw * 0.9, 3 / view.boardScale), 0, Math.PI * 2);
              ctx.fill();
            }
          } else if (shape.kind === 'ellipse') {
            const e = ellipseBox(shape.x1, shape.y1, shape.x2, shape.y2);
            rc.ellipse(e.cx, e.cy, e.rx * 2, e.ry * 2, opts);
          } else if (isPolygonal(shape.kind)) {
            // Rectangle is handled above (rough.js draws a nicer one), so this
            // is every other closed outline: rhombus, triangles, trapezium,
            // pentagon, hexagon, star — one branch, one source of corners.
            const poly = shapePolygon(shape.kind, shape.x1, shape.y1, shape.x2, shape.y2);
            if (poly) rc.polygon(poly, opts);
          } else if (shape.kind === 'line' || shape.kind === 'arrow') {
            rc.line(shape.x1, shape.y1, shape.x2, shape.y2, opts);
            if (shape.kind === 'arrow') {
              const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
              const headLen = Math.max(sw * 4, 14), ha = Math.PI / 7;
              rc.line(shape.x2, shape.y2, shape.x2 - headLen * Math.cos(angle - ha), shape.y2 - headLen * Math.sin(angle - ha), opts);
              rc.line(shape.x2, shape.y2, shape.x2 - headLen * Math.cos(angle + ha), shape.y2 - headLen * Math.sin(angle + ha), opts);
            }
          }
        } catch {
          ctx.strokeStyle = shape.color; ctx.lineWidth = sw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          if (dash) ctx.setLineDash(dash as number[]);
          if (shape.kind === 'rect') {
            const x = Math.min(shape.x1, shape.x2), y = Math.min(shape.y1, shape.y2);
            ctx.strokeRect(x, y, Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1));
          } else if (shape.kind === 'circle') {
            const r = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
            ctx.beginPath(); ctx.arc(shape.x1, shape.y1, r, 0, Math.PI * 2); ctx.stroke();
          } else if (shape.kind === 'diamond') {
            const cx = (shape.x1 + shape.x2) / 2, cy = (shape.y1 + shape.y2) / 2;
            const left = Math.min(shape.x1, shape.x2), right = Math.max(shape.x1, shape.x2);
            const top = Math.min(shape.y1, shape.y2), bottom = Math.max(shape.y1, shape.y2);
            ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(right, cy); ctx.lineTo(cx, bottom); ctx.lineTo(left, cy); ctx.closePath(); ctx.stroke();
          } else {
            ctx.beginPath(); ctx.moveTo(shape.x1, shape.y1); ctx.lineTo(shape.x2, shape.y2); ctx.stroke();
          }
        }
        ctx.restore();
      };
      // (drawShape executed below in the unified content pass.)

      // ── Text labels ──
      // The currently-being-edited text (if any) is rendered transparently
      // so it doesn't overlap the textarea overlay.
      // AUTONOMOUS: LaTeX (math) labels are rendered as DOM overlays (see
      // the JSX below); the canvas pass skips them so we don't double-render.
      const drawText = (t: BoardText) => {
        if (textEditor && textEditor.id === t.id) return; // hidden during edit
        if (t.latex) return; // rendered as a DOM overlay, not on canvas
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
        // Premium ink: smooth the path with quadratic curves through the
        // midpoints of consecutive samples (the classic signature-smoothing
        // technique) instead of hard polyline segments. This removes the
        // jagged "cheap" look while keeping the {x,y} wire format unchanged.
        const pts = stroke.points;
        if (pts.length === 1) {
          // A single tap → a clean filled dot (a polyline can't render one).
          ctx.beginPath();
          ctx.fillStyle = ctx.strokeStyle as string;
          ctx.arc(pts[0].x, pts[0].y, Math.max(0.6, ctx.lineWidth / 2), 0, Math.PI * 2);
          ctx.fill();
        } else if (pts.length === 2) {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          ctx.lineTo(pts[1].x, pts[1].y);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2;
            const my = (pts[i].y + pts[i + 1].y) / 2;
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
          }
          // Final segment to the true last point.
          ctx.quadraticCurveTo(
            pts[pts.length - 2].x, pts[pts.length - 2].y,
            pts[pts.length - 1].x, pts[pts.length - 1].y,
          );
          ctx.stroke();
        }
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

    // Keep the latest redrawCanvas reachable from async callbacks (image
    // decode) that were created with stale closures. See loadImage.
    redrawCanvasRef.current = redrawCanvas;

    // ── HD board export ──
    // Replaces the old viewport-grab (canvas.toDataURL of whatever happened to
    // be on screen). This renders the ENTIRE board — every stroke/shape/text/
    // image regardless of pan/zoom — onto an offscreen canvas at high
    // resolution (~3.4k long edge) over a white background, so one PNG
    // captures the whole session's writing. Built for handing to an LLM as
    // context: LaTeX math labels are drawn as their LaTeX SOURCE text (the
    // KaTeX render is a DOM overlay the canvas can't rasterise — and raw
    // LaTeX is the most faithful text form a model can read anyway).
    // This is the EXPORT TWIN of the draw routines inside redrawCanvas —
    // intentionally separate from the hot live path: it skips live-only
    // concerns (selection chrome, in-flight gesture, in-edit hiding,
    // instruments — teaching tools, not written content).
    const exportBoardHD = useCallback(() => {
      // 1) Content bounds in board space.
      const scratch = document.createElement('canvas').getContext('2d');
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const grow = (x: number, y: number, m = 0) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x - m < minX) minX = x - m;
        if (y - m < minY) minY = y - m;
        if (x + m > maxX) maxX = x + m;
        if (y + m > maxY) maxY = y + m;
      };
      for (const s of strokes) {
        const m = (s.width || 2) / 2 + 2;
        for (const p of s.points) grow(p.x, p.y, m);
      }
      for (const sh of shapes) {
        const m = (sh.width || 2) * 2 + 8; // rough.js sketchiness + arrowheads margin
        if (sh.kind === 'circle') {
          const r = Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1);
          grow(sh.x1 - r, sh.y1 - r, m); grow(sh.x1 + r, sh.y1 + r, m);
        } else {
          grow(sh.x1, sh.y1, m); grow(sh.x2, sh.y2, m);
        }
      }
      for (const t of texts) {
        const lines = t.text.split('\n');
        let w = 0;
        if (scratch) {
          scratch.font = `${t.fontSize}px ${t.latex ? 'ui-monospace, monospace' : TEXT_FONT_FAMILY}`;
          for (const ln of lines) w = Math.max(w, scratch.measureText(ln).width);
        } else {
          w = Math.max(...lines.map(l => l.length)) * t.fontSize * 0.6;
        }
        grow(t.x, t.y);
        grow(t.x + w, t.y + lines.length * t.fontSize * TEXT_LINE_HEIGHT_RATIO);
      }
      for (const o of objects) {
        // Axis-aligned bounds of the (possibly rotated) image rect.
        const w = o.width * o.scale, h = o.height * o.scale;
        const cx = o.x + w / 2, cy = o.y + h / 2;
        const a = (o.rotation * Math.PI) / 180;
        const hw = Math.abs(w / 2 * Math.cos(a)) + Math.abs(h / 2 * Math.sin(a));
        const hh = Math.abs(w / 2 * Math.sin(a)) + Math.abs(h / 2 * Math.cos(a));
        grow(cx - hw, cy - hh); grow(cx + hw, cy + hh);
      }
      if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1600; maxY = 1000; } // empty board → blank page
      const PAD = 60;
      minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
      const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);

      // 2) HD scale: target ~3.4k on the long edge, hard-capped for canvas limits.
      const longEdge = Math.max(bw, bh);
      let scale = Math.min(4, Math.max(1, 3400 / longEdge));
      if (longEdge * scale > 8000) scale = 8000 / longEdge;

      const out = document.createElement('canvas');
      out.width = Math.round(bw * scale);
      out.height = Math.round(bh * scale);
      const ctx = out.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);

      // 3) Grid (matches what the class saw; axes give the LLM coordinates).
      if (gridMode !== 'blank') {
        const minorStep = GRID_STEP, majorStep = GRID_STEP * 5;
        const gx0 = Math.floor(minX / minorStep) * minorStep, gx1 = Math.ceil(maxX / minorStep) * minorStep;
        const gy0 = Math.floor(minY / minorStep) * minorStep, gy1 = Math.ceil(maxY / minorStep) * minorStep;
        ctx.strokeStyle = gridMode === 'graph' ? '#eef2f7' : '#e5e7eb';
        ctx.lineWidth = 1 / scale;
        for (let x = gx0; x <= gx1; x += minorStep) { ctx.beginPath(); ctx.moveTo(x, gy0); ctx.lineTo(x, gy1); ctx.stroke(); }
        for (let y = gy0; y <= gy1; y += minorStep) { ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke(); }
        if (gridMode === 'graph') {
          ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1.2 / scale;
          const mx0 = Math.floor(minX / majorStep) * majorStep, mx1 = Math.ceil(maxX / majorStep) * majorStep;
          const my0 = Math.floor(minY / majorStep) * majorStep, my1 = Math.ceil(maxY / majorStep) * majorStep;
          for (let x = mx0; x <= mx1; x += majorStep) { ctx.beginPath(); ctx.moveTo(x, gy0); ctx.lineTo(x, gy1); ctx.stroke(); }
          for (let y = my0; y <= my1; y += majorStep) { ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx1, y); ctx.stroke(); }
          ctx.strokeStyle = '#475569'; ctx.lineWidth = 1.6 / scale;
          if (minX <= 0 && maxX >= 0) { ctx.beginPath(); ctx.moveTo(0, gy0); ctx.lineTo(0, gy1); ctx.stroke(); }
          if (minY <= 0 && maxY >= 0) { ctx.beginPath(); ctx.moveTo(gx0, 0); ctx.lineTo(gx1, 0); ctx.stroke(); }
          // Axis unit labels — fixed board-unit size so they stay legible.
          ctx.fillStyle = '#475569';
          ctx.font = `13px ui-sans-serif, system-ui, sans-serif`;
          if (minY <= 0 && maxY >= 0) {
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            for (let x = mx0; x <= mx1; x += majorStep) { if (x !== 0) ctx.fillText(String(Math.round(x / majorStep)), x, 5); }
          }
          if (minX <= 0 && maxX >= 0) {
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            for (let y = my0; y <= my1; y += majorStep) { if (y !== 0) ctx.fillText(String(Math.round(-y / majorStep)), -5, y); }
          }
        }
      }

      // 4) Content — identical chronological z-order to the live board.
      const rc = rough.canvas(out);
      const now = Date.now();
      type ExpItem =
        | { kind: 'image'; value: BoardImageObject; z: number }
        | { kind: 'stroke'; value: DrawStroke; z: number }
        | { kind: 'shape'; value: BoardShape; z: number }
        | { kind: 'text'; value: BoardText; z: number };
      const items: ExpItem[] = [];
      for (const o of objects) items.push({ kind: 'image', value: o, z: o.zIndex || deriveTimestampFromId(o.id) });
      for (const s of strokes) items.push({ kind: 'stroke', value: s, z: s.createdAt || deriveTimestampFromId(s.id) });
      for (const s of shapes) items.push({ kind: 'shape', value: s, z: s.createdAt || deriveTimestampFromId(s.id) });
      for (const t of texts) items.push({ kind: 'text', value: t, z: t.createdAt || deriveTimestampFromId(t.id) });
      items.sort((a, b) => a.z - b.z);

      for (const item of items) {
        if (item.kind === 'image') {
          const o = item.value;
          const img = imageCacheRef.current.get(o.id);
          if (!img?.complete) continue;
          ctx.save();
          ctx.translate(o.x + (o.width * o.scale) / 2, o.y + (o.height * o.scale) / 2);
          ctx.rotate((o.rotation * Math.PI) / 180);
          ctx.drawImage(img, -(o.width * o.scale) / 2, -(o.height * o.scale) / 2, o.width * o.scale, o.height * o.scale);
          ctx.restore();
        } else if (item.kind === 'stroke') {
          const s = item.value;
          if (s.points.length === 0) continue;
          ctx.save();
          if (s.tool === 'eraser-pixel') {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = '#000'; ctx.lineWidth = s.width;
          } else if (s.tool === 'highlighter') {
            const age = now - (s.createdAt ?? now);
            let alpha = 0.55;
            if (age > HIGHLIGHTER_HOLD_MS) alpha = 0.55 * Math.max(0, 1 - (age - HIGHLIGHTER_HOLD_MS) / (HIGHLIGHTER_FADE_MS - HIGHLIGHTER_HOLD_MS));
            if (alpha <= 0) { ctx.restore(); continue; }
            ctx.globalAlpha = alpha; ctx.globalCompositeOperation = 'multiply';
            ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
          } else {
            ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
          }
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          const pts = s.points;
          if (pts.length === 1) {
            ctx.beginPath(); ctx.fillStyle = ctx.strokeStyle as string;
            ctx.arc(pts[0].x, pts[0].y, Math.max(0.6, ctx.lineWidth / 2), 0, Math.PI * 2); ctx.fill();
          } else if (pts.length === 2) {
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); ctx.stroke();
          } else {
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length - 1; i++) {
              ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
            }
            ctx.quadraticCurveTo(pts[pts.length - 2].x, pts[pts.length - 2].y, pts[pts.length - 1].x, pts[pts.length - 1].y);
            ctx.stroke();
          }
          ctx.restore();
        } else if (item.kind === 'shape') {
          const shape = item.value;
          ctx.save();
          const sw = shape.width;
          const seed = shapeSeed(shape.id || 'shape');
          const dash =
            shape.strokeStyle === 'dashed' ? [sw * 3, sw * 2.5] :
            shape.strokeStyle === 'dotted' ? [0.1, sw * 2.2] : undefined;
          const opts: Record<string, unknown> = { stroke: shape.color, strokeWidth: sw, roughness: 1.1, bowing: 1, seed };
          if (dash) opts.strokeLineDash = dash;
          if (shape.fillColor) {
            opts.fill = shape.fillColor;
            opts.fillStyle = shape.fillStyle || 'hachure';
            opts.fillWeight = Math.max(sw * 0.5, 0.6);
            opts.hachureGap = Math.max(sw * 4, 6);
          }
          try {
            if (shape.kind === 'rect') {
              rc.rectangle(Math.min(shape.x1, shape.x2), Math.min(shape.y1, shape.y2), Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1), opts);
            } else if (shape.kind === 'circle') {
              const r = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
              rc.ellipse(shape.x1, shape.y1, r * 2, r * 2, opts);
              if (shape.centerMark) {
                ctx.fillStyle = shape.color;
                ctx.beginPath(); ctx.arc(shape.x1, shape.y1, Math.max(sw * 0.9, 3 / scale), 0, Math.PI * 2); ctx.fill();
              }
            } else if (shape.kind === 'ellipse') {
              const e = ellipseBox(shape.x1, shape.y1, shape.x2, shape.y2);
              rc.ellipse(e.cx, e.cy, e.rx * 2, e.ry * 2, opts);
            } else if (isPolygonal(shape.kind)) {
              const poly = shapePolygon(shape.kind, shape.x1, shape.y1, shape.x2, shape.y2);
              if (poly) rc.polygon(poly, opts);
            } else if (shape.kind === 'line' || shape.kind === 'arrow') {
              rc.line(shape.x1, shape.y1, shape.x2, shape.y2, opts);
              if (shape.kind === 'arrow') {
                const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
                const headLen = Math.max(sw * 4, 14), ha = Math.PI / 7;
                rc.line(shape.x2, shape.y2, shape.x2 - headLen * Math.cos(angle - ha), shape.y2 - headLen * Math.sin(angle - ha), opts);
                rc.line(shape.x2, shape.y2, shape.x2 - headLen * Math.cos(angle + ha), shape.y2 - headLen * Math.sin(angle + ha), opts);
              }
            }
          } catch {
            ctx.strokeStyle = shape.color; ctx.lineWidth = sw;
            if (shape.kind === 'rect') ctx.strokeRect(Math.min(shape.x1, shape.x2), Math.min(shape.y1, shape.y2), Math.abs(shape.x2 - shape.x1), Math.abs(shape.y2 - shape.y1));
            else { ctx.beginPath(); ctx.moveTo(shape.x1, shape.y1); ctx.lineTo(shape.x2, shape.y2); ctx.stroke(); }
          }
          ctx.restore();
        } else {
          const t = item.value;
          ctx.save();
          ctx.fillStyle = t.color;
          // LaTeX labels: raw source in monospace (see header comment).
          ctx.font = `${t.fontSize}px ${t.latex ? 'ui-monospace, Menlo, Consolas, monospace' : TEXT_FONT_FAMILY}`;
          ctx.textBaseline = 'top'; ctx.textAlign = 'left';
          const lineH = t.fontSize * TEXT_LINE_HEIGHT_RATIO;
          const lines = t.text.split('\n');
          for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], t.x, t.y + i * lineH);
          ctx.restore();
        }
      }

      // 5) White page UNDER everything (after content, destination-over, so
      // pixel-eraser holes end up white — not transparent — in the PNG).
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.globalCompositeOperation = 'source-over';

      // 6) Download.
      out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
        link.download = `mathslive-board-${roomId || 'session'}-${stamp}.png`;
        link.href = url;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }, 'image/png');
    }, [strokes, shapes, texts, objects, gridMode, roomId]);

    useImperativeHandle(ref, () => ({
      getStrokes: () => strokes.map(st => ({ id: st.id, points: st.points, width: st.width, tool: st.tool })),
      getView: () => ({ boardScale: view.boardScale, boardOffsetX: view.boardOffsetX, boardOffsetY: view.boardOffsetY }),
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
      download: () => exportBoardHD(),
      getCanvas: () => canvasRef.current,
    }), [addImageObject, exportBoardHD, socket, isTeacher, roomId, strokes, view]);

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
      const normalized = (initialState.strokes || []).map(stroke => ({ ...stroke, id: stroke.id || newId('stroke'), tool: coerceStrokeTool(stroke.tool) }));
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
        redrawCanvasRef.current();
      };
      resize();
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
      // Must NOT depend on redrawCanvas: it changes identity whenever `view`
      // changes, and setView(getInitialView()) above changes `view` to a fresh
      // object every run — so depending on redrawCanvas created an infinite
      // setView → new redrawCanvas → re-run → setView loop ("Maximum update
      // depth exceeded") whenever the whiteboard opened on an empty board.
      // Repaint still happens via the dedicated [redrawCanvas] effect below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive, getInitialView, objects.length, strokes.length, shapes.length]);

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
            } else if (key === 'd') {
              e.preventDefault();
              duplicateSelection();
            } else if (key === 'c') {
              e.preventDefault();
              copySelection();
            // NOTE: no 'v' branch — Ctrl/Cmd+V must reach the browser so the
            // native `paste` event fires; the window paste listener routes it
            // (OS image → board image, OS text → label, else internal
            // clipboard). Intercepting at keydown suppressed that event and
            // broke OS-clipboard pasting.
            } else if (key === ']') {
              e.preventDefault();
              zOrderSelection(true);
            } else if (key === '[') {
              e.preventDefault();
              zOrderSelection(false);
            } else if (key === 'g' && !e.shiftKey) {
              e.preventDefault();
              groupSelection();
            } else if (key === 'g' && e.shiftKey) {
              e.preventDefault();
              ungroupSelection();
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
    }, [isActive, canEdit, selectedObjectId, selectedStrokeIndex, selectedShapeId, selectedTextId, removeSelectedObject, deleteStrokeIndices, removeSelectedShape, removeSelectedText, multiObjectIds.length, multiShapeIds.length, multiStrokeIndices.length, multiTextIds.length, removeMultiSelection, clearMultiSelection, undo, redo, duplicateSelection, zOrderSelection, copySelection, pasteClipboard, groupSelection, ungroupSelection, textEditor]);

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
      // NEVER move the board out from under someone who is mid-stroke.
      //
      // Points are captured in BOARD coordinates via screenToBoard, which
      // divides through the CURRENT view. A shared-view update landing between
      // two pointermoves therefore re-maps the same finger position to a
      // different board point, and the stroke jumps. With the teacher panning
      // while a student writes, it jumps on every frame — which draws a dense
      // zig-zag band instead of a line, and puts the ink somewhere neither of
      // them expects. Hold the update and apply it the moment the pen lifts.
      const handleSetView = (data: { view: BoardView }) => {
        if (dragRef.current?.mode === 'draw') { pendingViewRef.current = data.view; return; }
        setView(data.view);
      };
      const handleStroke = (data: { stroke: DrawStroke }) => {
        const stroke = { ...data.stroke, id: data.stroke.id || newId('stroke'), tool: coerceStrokeTool(data.stroke.tool) };
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
      // Guarded like the matching releasePointerCapture in handlePointerUp —
      // capture can throw (pointer already lifted / not active) and an
      // unhandled throw here aborted the whole draw before the drag started.
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* non-fatal */ }
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
        strokeViewRef.current = view;   // freeze the transform for this stroke
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
        // ── Group drag: if the cursor is over any grouped item, select the
        // whole group and move it as a unit. Additive — the single-move paths
        // below are left completely untouched. ──
        const startGroupMove = (gid: string): boolean => {
          const sMembers = shapes.filter(s => s.groupId === gid);
          const tMembers = texts.filter(t => t.groupId === gid);
          const oMembers = objects.filter(o => o.groupId === gid);
          if (sMembers.length + tMembers.length + oMembers.length === 0) return false;
          setSelectedShapeId(null); setSelectedObjectId(null); setSelectedTextId(null); setSelectedStrokeIndex(null);
          setMultiShapeIds(sMembers.map(s => s.id));
          setMultiTextIds(tMembers.map(t => t.id));
          setMultiObjectIds(oMembers.map(o => o.id));
          setMultiStrokeIndices([]);
          dragRef.current = {
            mode: 'group-move',
            pointerId: e.pointerId,
            startClientX: e.clientX, startClientY: e.clientY,
            startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY,
            groupSnapshot: {
              shapes: sMembers.map(s => ({ id: s.id, x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
              texts: tMembers.map(t => ({ id: t.id, x: t.x, y: t.y })),
              objects: oMembers.map(o => ({ id: o.id, x: o.x, y: o.y })),
            },
          };
          return true;
        };
        const hitObject = findObjectAt(point);
        if (hitObject) {
          if (hitObject.groupId && startGroupMove(hitObject.groupId)) return;
          setSelectedObjectId(hitObject.id);
          setSelectedStrokeIndex(null);
          setSelectedShapeId(null);
          dragRef.current = { mode: 'object', pointerId: e.pointerId, startClientX: e.clientX, startClientY: e.clientY, startOffsetX: view.boardOffsetX, startOffsetY: view.boardOffsetY, objectId: hitObject.id, objectStartX: hitObject.x, objectStartY: hitObject.y };
          return;
        }
        const hitShape = findShapeAt(point);
        if (hitShape) {
          if (hitShape.groupId && startGroupMove(hitShape.groupId)) return;
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
          if (hitText.groupId && startGroupMove(hitText.groupId)) return;
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
          strokeStyle,
          ...(fillColor ? { fillColor, fillStyle } : {}),
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
      strokeViewRef.current = view;   // freeze the transform for this stroke
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
      if (drag.mode === 'group-move' && drag.groupSnapshot) {
        const dx = (e.clientX - drag.startClientX) / view.boardScale;
        const dy = (e.clientY - drag.startClientY) / view.boardScale;
        const gs = drag.groupSnapshot;
        // Local-only every frame (no wire flood); the final positions are
        // emitted once on pointer-up. Offset every member by the same delta.
        if (gs.shapes.length) {
          setShapes(prev => prev.map(s => { const o = gs.shapes.find(x => x.id === s.id); return o ? { ...s, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy } : s; }));
        }
        if (gs.texts.length) {
          setTexts(prev => prev.map(t => { const o = gs.texts.find(x => x.id === t.id); return o ? { ...t, x: o.x + dx, y: o.y + dy } : t; }));
        }
        if (gs.objects.length) {
          setObjects(prev => prev.map(ob => { const o = gs.objects.find(x => x.id === ob.id); return o ? { ...ob, x: o.x + dx, y: o.y + dy } : ob; }));
        }
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
      // Mapped through the transform this stroke STARTED with, so a view
      // change mid-stroke cannot bend the line already being drawn.
      if (drag.mode === 'draw') setLiveStroke([...currentStrokeRef.current, screenToBoardWith(strokeViewRef.current || view, e.clientX, e.clientY)]);
    };

    const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
      // Pen up: let through any shared-view update we held back mid-stroke.
      if (drag.mode === 'draw') flushPendingView();
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
      if (drag.mode === 'group-move' && drag.groupSnapshot) {
        const dx = (e.clientX - drag.startClientX) / view.boardScale;
        const dy = (e.clientY - drag.startClientY) / view.boardScale;
        const gs = drag.groupSnapshot;
        // before = snapshot positions; after = snapshot + final delta. Captured
        // as plain {id,coords} so undo/redo replays exact positions regardless
        // of later edits, and emits the full element (server replaces on update).
        const sBefore = gs.shapes.map(o => ({ ...o }));
        const sAfter = gs.shapes.map(o => ({ id: o.id, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy }));
        const tBefore = gs.texts.map(o => ({ ...o }));
        const tAfter = gs.texts.map(o => ({ id: o.id, x: o.x + dx, y: o.y + dy }));
        const oBefore = gs.objects.map(o => ({ ...o }));
        const oAfter = gs.objects.map(o => ({ id: o.id, x: o.x + dx, y: o.y + dy }));
        const applyPos = (
          sp: Array<{ id: string; x1: number; y1: number; x2: number; y2: number }>,
          tp: Array<{ id: string; x: number; y: number }>,
          op: Array<{ id: string; x: number; y: number }>,
        ) => {
          if (sp.length) {
            setShapes(prev => prev.map(s => { const o = sp.find(x => x.id === s.id); return o ? { ...s, x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 } : s; }));
          }
          if (tp.length) {
            setTexts(prev => prev.map(t => { const o = tp.find(x => x.id === t.id); return o ? { ...t, x: o.x, y: o.y } : t; }));
          }
          if (op.length) {
            setObjects(prev => prev.map(ob => { const o = op.find(x => x.id === ob.id); return o ? { ...ob, x: o.x, y: o.y } : ob; }));
          }
          if (socket) {
            if (isTeacher) {
              sp.forEach(o => { const full = shapesRef.current.find(s => s.id === o.id); if (full) socket.emit('whiteboard_update_shape', { roomId, shape: { ...full, x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 } }); });
              tp.forEach(o => { const full = textsRef.current.find(t => t.id === o.id); if (full) socket.emit('whiteboard_update_text', { roomId, text: { ...full, x: o.x, y: o.y } }); });
            }
            if (canMutateImages) op.forEach(o => { const full = objects.find(ob => ob.id === o.id); if (full) socket.emit('whiteboard_update_object', { roomId, object: { ...full, x: o.x, y: o.y } }); });
          }
        };
        applyPos(sAfter, tAfter, oAfter);
        recordAction({ undo: () => applyPos(sBefore, tBefore, oBefore), redo: () => applyPos(sAfter, tAfter, oAfter) });
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
      flushPendingView();
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

    // AUTONOMOUS: [iPad fix] - Native non-passive touch listeners that
    // also implement two-finger pinch-zoom.
    //
    // History:
    //   1. Students on iPad couldn't DRAW because iOS treated single-
    //      finger touch as scroll. Fixed earlier by attaching native
    //      non-passive `touchstart`/`touchmove` listeners that always
    //      preventDefault.
    //   2. That fix was too aggressive: it also blocked two-finger
    //      pinch, but nothing replaced it — so students on iPad
    //      reported they couldn't ZOOM either. (The reported symptom.)
    //
    // This handler does both jobs:
    //   - 1 finger touch → preventDefault to stop iOS hijacking as
    //     scroll; React's onPointer* handlers drive the draw.
    //   - 2 finger touch → preventDefault to stop browser-level pinch-
    //     zoom, AND drive the whiteboard's own pinch-zoom (anchored to
    //     the midpoint between the fingers, exactly like wheel-zoom is
    //     anchored to the cursor). Also pans by the midpoint delta so
    //     the user can reposition while pinching.
    //
    // When a second finger lands during a stroke, we abandon the
    // in-progress draw (null dragRef, clear currentStrokeRef, clear
    // the live-stroke preview) so the user doesn't accidentally
    // commit a stray scribble on pinch start.
    useEffect(() => {
      if (!isActive) return;
      const canvas = canvasRef.current;
      const wrap = containerRef.current;
      if (!canvas || !wrap) return;

      // ── Pinch state ────────────────────────────────────────────
      let pinchActive = false;
      let lastDist = 0;
      let lastMidX = 0;
      let lastMidY = 0;

      const midpoint = (t: TouchList) => ({
        x: (t[0].clientX + t[1].clientX) / 2,
        y: (t[0].clientY + t[1].clientY) / 2,
      });
      const distance = (t: TouchList) => {
        const dx = t[0].clientX - t[1].clientX;
        const dy = t[0].clientY - t[1].clientY;
        return Math.hypot(dx, dy);
      };

      const onTouchStart = (e: TouchEvent) => {
        // Always preventDefault: stops iOS from interpreting touches
        // as scroll / native pinch-zoom before we get a chance.
        e.preventDefault();
        if (e.touches.length >= 2) {
          // Begin (or update) a pinch. Abandon any single-finger draw
          // already in progress so it doesn't commit on pinch end.
          dragRef.current = null;
          currentStrokeRef.current = [];
          setLiveStroke([]);
          flushPendingView();
          pinchActive = true;
          lastDist = distance(e.touches);
          const m = midpoint(e.touches);
          lastMidX = m.x;
          lastMidY = m.y;
        }
      };

      const onTouchMove = (e: TouchEvent) => {
        e.preventDefault();
        if (pinchActive && e.touches.length >= 2) {
          const newDist = distance(e.touches);
          const m = midpoint(e.touches);
          // Avoid div-by-zero on the very first move if fingers
          // landed at the same point.
          if (lastDist > 1) {
            const factor = newDist / lastDist;
            // zoomAt does the math: keeps the pinch midpoint anchored
            // in BOARD space across the zoom (same trick as wheel-zoom
            // anchoring to the cursor).
            if (Math.abs(factor - 1) > 0.001) {
              zoomAtRef.current(factor, m.x, m.y);
            }
          }
          // Two-finger PAN: shift the board by however far the
          // midpoint moved. Composes naturally with the zoom — the
          // user can drag and pinch in one fluid gesture.
          const dx = m.x - lastMidX;
          const dy = m.y - lastMidY;
          if (dx !== 0 || dy !== 0) {
            // Read view through the ref-style setter to avoid stale
            // closure on the captured `view`.
            setView(prev => ({
              boardScale: prev.boardScale,
              boardOffsetX: prev.boardOffsetX + dx,
              boardOffsetY: prev.boardOffsetY + dy,
            }));
          }
          lastDist = newDist;
          lastMidX = m.x;
          lastMidY = m.y;
        }
      };

      const onTouchEnd = (e: TouchEvent) => {
        // When fingers drop below 2, the pinch is over. We don't
        // preventDefault here — touchend doesn't need to suppress
        // anything and preventing it can swallow follow-up taps.
        if (e.touches.length < 2) {
          pinchActive = false;
          lastDist = 0;
        }
      };

      // iOS Safari ALSO fires legacy gesture* events alongside touch*
      // for multi-finger gestures. Default action is to zoom the
      // PAGE — we already handle pinch ourselves, so block these
      // outright. Non-standard but still respected by Safari.
      const blockGesture = (e: Event) => e.preventDefault();

      // Listeners on BOTH canvas (where draws land) and wrap (so a
      // pinch beginning on the padding/border doesn't slip through to
      // the browser's gesture handler). All non-passive so
      // preventDefault actually works.
      canvas.addEventListener('touchstart', onTouchStart, { passive: false });
      canvas.addEventListener('touchmove', onTouchMove, { passive: false });
      canvas.addEventListener('touchend', onTouchEnd);
      canvas.addEventListener('touchcancel', onTouchEnd);
      canvas.addEventListener('gesturestart', blockGesture as EventListener);
      canvas.addEventListener('gesturechange', blockGesture as EventListener);
      canvas.addEventListener('gestureend', blockGesture as EventListener);
      wrap.addEventListener('touchstart', onTouchStart, { passive: false });
      wrap.addEventListener('touchmove', onTouchMove, { passive: false });
      wrap.addEventListener('touchend', onTouchEnd);
      wrap.addEventListener('touchcancel', onTouchEnd);
      wrap.addEventListener('gesturestart', blockGesture as EventListener);
      wrap.addEventListener('gesturechange', blockGesture as EventListener);
      wrap.addEventListener('gestureend', blockGesture as EventListener);
      return () => {
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove', onTouchMove);
        canvas.removeEventListener('touchend', onTouchEnd);
        canvas.removeEventListener('touchcancel', onTouchEnd);
        canvas.removeEventListener('gesturestart', blockGesture as EventListener);
        canvas.removeEventListener('gesturechange', blockGesture as EventListener);
        canvas.removeEventListener('gestureend', blockGesture as EventListener);
        wrap.removeEventListener('touchstart', onTouchStart);
        wrap.removeEventListener('touchmove', onTouchMove);
        wrap.removeEventListener('touchend', onTouchEnd);
        wrap.removeEventListener('touchcancel', onTouchEnd);
        wrap.removeEventListener('gesturestart', blockGesture as EventListener);
        wrap.removeEventListener('gesturechange', blockGesture as EventListener);
        wrap.removeEventListener('gestureend', blockGesture as EventListener);
      };
    // Deliberately NOT keyed on zoomAt — it changes identity on every view
    // change, and re-attaching these listeners mid-pinch reset pinchActive and
    // killed two-finger zoom/pan after the first step. zoomAt is read live via
    // zoomAtRef instead. setLiveStroke is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      // A worksheet PDF becomes a stack of page images you can write on;
      // anything else is a normal single image.
      if (isPdf(file)) { void addPdfPages(file); return; }
      void ingestImageBlob(file);
    };

    // AUTONOMOUS: Anyone who can mutate images can paste them. Previously
    // gated to isTeacher, which excluded students in interactive mode —
    // but the upload BUTTON in the rail was open to them. The asymmetry
    // meant a student could upload a homework photo from disk but not
    // paste the same photo from clipboard. The mutation gate is the
    // canonical permission (canMutateImages); use it here too.
    // Single router for Ctrl/Cmd+V — everything goes through the NATIVE paste
    // event (never intercepted at keydown, so the OS clipboard is always
    // readable). Priority:
    //   1. OS image (screenshot / copied picture)  → image object on the board
    //   2. OS text (teacher only — text sync is teacher-authoritative) → label
    //   3. Internal whiteboard clipboard (copied shapes/labels/images)
    // The old keydown Ctrl+V interception preventDefault()ed the paste event,
    // which silently killed OS-image pasting whenever the internal clipboard
    // had ever been used.
    useEffect(() => {
      if (!isActive || !canMutateImages) return;
      const handlePaste = (e: ClipboardEvent) => {
        const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'));
        const blob = item?.getAsFile();
        if (blob) {
          e.preventDefault();
          void ingestImageBlob(blob);
          return;
        }
        // Never hijack paste while typing (text editor textarea, inputs).
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        const pasted = e.clipboardData?.getData('text/plain')?.trim();
        if (pasted && isTeacher) {
          e.preventDefault();
          const rect = containerRef.current?.getBoundingClientRect();
          const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
          const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
          const p = screenToBoard(cx, cy);
          const now = Date.now();
          const t: BoardText = { id: newId('text'), x: p.x, y: p.y, text: pasted.slice(0, 4000), fontSize: textFontSize, color, createdAt: now, updatedAt: now };
          addText(t);
          recordAction({
            undo: () => { setTexts(prev => prev.filter(x => x.id !== t.id)); if (socket && isTeacher) socket.emit('whiteboard_remove_text', { roomId, textId: t.id }); },
            redo: () => { setTexts(prev => prev.some(x => x.id === t.id) ? prev : [...prev, t]); if (socket && isTeacher) socket.emit('whiteboard_add_text', { roomId, text: t }); },
          });
          return;
        }
        e.preventDefault();
        pasteClipboard();
      };
      window.addEventListener('paste', handlePaste);
      return () => window.removeEventListener('paste', handlePaste);
    }, [isActive, canMutateImages, ingestImageBlob, isTeacher, screenToBoard, textFontSize, color, addText, recordAction, pasteClipboard, socket, roomId]);

    // AUTONOMOUS: Drag-and-drop image support on the whiteboard.
    //
    // Workflow this unlocks: teacher drags a screenshot/diagram from
    // Finder/Explorer (or a downloaded image from a download tray)
    // straight onto the canvas. Previously the only way to attach an
    // image was: open file picker → navigate to file → confirm. Three
    // friction steps vs. one drag.
    //
    // We accept ALL image files in the drop. Multiple files are
    // ingested sequentially; ingestImageBlob handles each one
    // individually (downscale, broadcast, place on board).
    //
    // Visual cue: while a drag with files is active over the canvas,
    // we show a soft overlay "Drop image to add" so the user knows the
    // drop is captured here and not by the browser (which would
    // otherwise navigate to the file URL).
    const [dragOverActive, setDragOverActive] = useState(false);
    useEffect(() => {
      if (!isActive || !canMutateImages) return;
      const wrap = containerRef.current;
      if (!wrap) return;
      // hasImageFiles: only show the overlay (and call preventDefault)
      // when the drag actually carries image data. Pure text/link drags
      // are passed through to the browser as-is.
      const hasImageFiles = (e: DragEvent): boolean => {
        const types = e.dataTransfer?.types;
        if (!types) return false;
        for (let i = 0; i < types.length; i++) {
          if (types[i] === 'Files') return true;
        }
        return false;
      };
      const onDragEnter = (e: DragEvent) => {
        if (!hasImageFiles(e)) return;
        e.preventDefault();
        setDragOverActive(true);
      };
      const onDragOver = (e: DragEvent) => {
        if (!hasImageFiles(e)) return;
        // Required so the drop event actually fires — without this the
        // browser interprets the drop as "navigate to file URL".
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      };
      const onDragLeave = (e: DragEvent) => {
        // Only clear on leave of the wrap itself, not a child. relatedTarget
        // is the element we're entering; if it's still inside the wrap, ignore.
        if (e.relatedTarget && wrap.contains(e.relatedTarget as Node)) return;
        setDragOverActive(false);
      };
      const onDrop = (e: DragEvent) => {
        if (!hasImageFiles(e)) return;
        e.preventDefault();
        setDragOverActive(false);
        // Accept dropped PDFs (a worksheet) as well as images.
        const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/') || isPdf(f));
        // Ingest serially — each call eventually calls socket.emit which is
        // cheap, but the canvas positioning logic assumes single-image at
        // a time. Serial keeps placement predictable.
        (async () => {
          for (const file of files) {
            try {
              if (isPdf(file)) await addPdfPages(file);
              else await ingestImageBlob(file);
            } catch (err) {
              console.warn('[whiteboard] file drop failed', err);
            }
          }
        })();
      };
      wrap.addEventListener('dragenter', onDragEnter);
      wrap.addEventListener('dragover', onDragOver);
      wrap.addEventListener('dragleave', onDragLeave);
      wrap.addEventListener('drop', onDrop);
      return () => {
        wrap.removeEventListener('dragenter', onDragEnter);
        wrap.removeEventListener('dragover', onDragOver);
        wrap.removeEventListener('dragleave', onDragLeave);
        wrap.removeEventListener('drop', onDrop);
      };
    }, [isActive, canMutateImages, ingestImageBlob]);

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
      flushPendingView();
    }, [isActive]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!isActive) return null;

    const rulerActive = instruments.some(i => i.kind === 'ruler');
    const protractorActive = instruments.some(i => i.kind === 'protractor');

    const shapeLabel = SHAPE_CATALOG.find(c => c.id === lastShape)?.label || 'Shapes';
    const tools: Array<{ id: BoardTool; label: string; icon: React.ReactNode; pressed?: boolean; isShapePalette?: boolean }> = [
      // AUTONOMOUS: [ORDER-3 FRICTION] - Eraser used to live at the bottom
      // of a 12-tool rail. On a 13" MacBook the rail overflowed and Eraser
      // was below the viewport with no way to scroll. Reordered:
      //   - core editing (Select, Pen, Eraser, Hand, Highlighter) at the
      //     top — the most-reached tools
      //   - shapes (Line / Rect / Circle / Arrow) next
      //   - text + math instruments (Compass / Ruler / Protractor)
      //   - image upload at the end
      // Combined with the new scrollable rail (CSS) the user reaches every
      // tool on every screen size.
      //
      // AUTONOMOUS: Hand (pan) sits directly under Eraser. When a teacher
      // erases something, the next thing they usually want to do is
      // reposition the canvas to keep working — having pan one click away
      // (instead of buried at the bottom of the rail) shaves real friction.
      { id: 'select', label: 'Select', icon: <path d="M4 4l7 16 2-7 7-2L4 4z" /> },
      { id: 'pen', label: 'Pen', icon: <path d="M17 3a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5L17 3z" /> },
      { id: 'eraser', label: 'Eraser', icon: <><path d="m7 21-4-4 11-11 4 4L7 21z" /><path d="M14 6l4-4 4 4-4 4" /><path d="M3 21h18" /></> },
      { id: 'pan', label: 'Hand', icon: <><path d="M18 11V6a2 2 0 0 0-4 0v5" /><path d="M14 10V4a2 2 0 0 0-4 0v8" /><path d="M10 12V6a2 2 0 0 0-4 0v7" /><path d="M6 13c-2 0-3 1-3 3 0 4 4 6 8 6h3c4 0 7-3 7-7v-4a2 2 0 0 0-4 0" /></> },
      // Highlighter — fades after a few seconds. Chunky marker icon.
      { id: 'highlighter', label: 'Highlighter', icon: <><path d="M9 11l-4 4v3h3l4-4" /><path d="M11 9l5-5 4 4-5 5z" /><path d="M14 6l4 4" /></> },
      // Text — typed labels for math (eg "x = 45°", "let n be even"). Click
      // anywhere on the board, type, press Enter to commit.
      { id: 'text', label: 'Text', icon: <><path d="M4 7V5h16v2" /><path d="M9 19h6" /><path d="M12 5v14" /></> },
      // Shapes live behind ONE rail entry. The rail already overflowed a 13"
      // screen at fifteen tools; adding eight more as siblings would have put
      // the eraser below the fold again. The button shows whichever shape is
      // currently chosen, so the common case is still a single click.
      { id: lastShape, label: shapeLabel, icon: SHAPE_ICONS[lastShape], isShapePalette: true },
      // Compass — circle drawn from the centre, leaves a small dot at the centre point.
      { id: 'compass', label: 'Compass', icon: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><path d="M12 4v3" /></> },
      // Ruler — toggle: spawn / remove the ruler instrument on the board.
      { id: 'ruler', label: 'Ruler', icon: <><path d="M3 14l11-11 7 7-11 11z" /><path d="M7 10l1 1M10 7l1 1M13 4l1 1M5 16l1 1" /></>, pressed: rulerActive },
      // Protractor — toggle: spawn / remove the protractor instrument.
      { id: 'protractor', label: 'Protractor', icon: <><path d="M3 14a9 9 0 0 1 18 0" /><path d="M3 14h18" /><path d="M12 14v-3" /></>, pressed: protractorActive },
    ];

    // Shapes, text and geometry instruments are teacher-authored: the server
    // gates their events on requireTeacher, so a student picking these tools
    // would draw something that appears locally, syncs to nobody, and is wiped
    // by the next hydration. Hide them from non-teachers — interactive students
    // keep the tools that actually sync (pen, eraser, highlighter, pan, select,
    // image), matching the server permission model.
    const TEACHER_ONLY_TOOLS = new Set<BoardTool>(['text', 'compass', 'ruler', 'protractor', ...SHAPE_CATALOG.map(c => c.id)]);
    const visibleTools = isTeacher ? tools : tools.filter(t => !TEACHER_ONLY_TOOLS.has(t.id));

    const toolChip =
      tool === 'eraser' ? (eraserMode === 'pixel' ? 'Erase pixels — drag across content' : 'Erase whole stroke — click on a stroke') :
      tool === 'pan' ? 'Move board' :
      tool === 'select' ? 'Select and arrange' :
      tool === 'line' ? 'Draw line — click and drag' :
      tool === 'rect' ? 'Draw rectangle — click and drag' :
      tool === 'circle' ? 'Draw circle — click and drag from centre' :
      tool === 'arrow' ? 'Draw arrow — click and drag from start to head' :
      tool === 'diamond' ? 'Draw rhombus — click and drag' :
      isShapeTool(tool) && tool !== 'compass'
        ? `Draw ${(SHAPE_CATALOG.find(c => c.id === tool)?.label || 'shape').toLowerCase()} — click and drag` :
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
        <input ref={uploadInputRef} type="file" accept="image/*,application/pdf,.pdf" onChange={handleImageUpload} className="hidden" />

        {/* PDF import progress — importing a multi-page worksheet takes a
            moment and silently doing nothing looks broken. */}
        {pdfBusy && (
          <div
            role="status"
            style={{
              position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
              zIndex: 60, padding: '8px 16px', borderRadius: 999,
              background: 'rgba(17,19,32,0.92)', color: '#fff', fontSize: 13, fontWeight: 600,
              boxShadow: '0 6px 20px rgba(0,0,0,0.25)', pointerEvents: 'none', whiteSpace: 'nowrap',
            }}
          >
            {pdfBusy}
          </div>
        )}

        {canEdit && (
          <aside className="whiteboard-rail" aria-label="Whiteboard tools">
            {visibleTools.map(item => (
              item.isShapePalette ? (
                <div key="shapes" className="whiteboard-shape-slot">
                  <button
                    onClick={() => { setTool(lastShape); setShowShapePalette(v => !v); }}
                    className={`whiteboard-tool ${isShapeTool(tool) && tool !== 'compass' ? 'active' : ''}`}
                    title={`${item.label} — click for all shapes`}
                    aria-label={`Shapes, currently ${item.label}`}
                    aria-expanded={showShapePalette}
                  >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      {item.icon}
                    </svg>
                    <span>{item.label}</span>
                    <span className="whiteboard-shape-caret" aria-hidden="true">▸</span>
                  </button>
                  {showShapePalette && (
                    <>
                      <div className="fixed inset-0" style={{ zIndex: 39 }} onClick={() => setShowShapePalette(false)} />
                      <div className="whiteboard-shape-palette" role="menu" aria-label="Shapes">
                        {SHAPE_CATALOG.map(c => (
                          <button
                            key={c.id}
                            role="menuitem"
                            className={`whiteboard-shape-option ${tool === c.id ? 'active' : ''}`}
                            onClick={() => { setLastShape(c.id); setTool(c.id); setShowShapePalette(false); }}
                            title={c.label}
                            aria-label={c.label}
                          >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              {SHAPE_ICONS[c.id]}
                            </svg>
                            <span>{c.label}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ) : (
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
              )
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
          {/* ── Shape styling (Excalidraw-style): fill, fill style, stroke style ──
              Shown when a shape tool is active or a shape is selected. Edits the
              selected shape live, and sets the default for new shapes. */}
          {(isShapeTool(tool) || !!selectedShape) && (() => {
            const curFill = selectedShape ? (selectedShape.fillColor || '') : fillColor;
            const curStroke = selectedShape ? (selectedShape.strokeStyle || 'solid') : strokeStyle;
            const curFillStyle = selectedShape ? (selectedShape.fillStyle || 'hachure') : fillStyle;
            return (
              <>
                <div className="whiteboard-control-group" title="Fill">
                  <button
                    onClick={() => applyShapeStyle({ fillColor: '' })}
                    className={`whiteboard-swatch ${!curFill ? 'active' : ''}`}
                    style={{ background: '#fff', backgroundImage: 'linear-gradient(45deg,#e5e7eb 25%,transparent 25%,transparent 75%,#e5e7eb 75%)', backgroundSize: '8px 8px' }}
                    aria-label="No fill" title="No fill"
                  />
                  {FILL_COLORS.map(c => (
                    <button key={c} onClick={() => applyShapeStyle({ fillColor: c })} className={`whiteboard-swatch ${curFill === c ? 'active' : ''}`} style={{ background: c }} aria-label={`Fill ${c}`} />
                  ))}
                </div>
                {curFill && (
                  <div className="whiteboard-control-group" title="Fill style">
                    {(['hachure', 'solid', 'cross-hatch'] as const).map(fs => (
                      <button key={fs} onClick={() => applyShapeStyle({ fillStyle: fs })} className="whiteboard-action"
                        style={{ fontSize: 11, padding: '4px 8px', fontWeight: curFillStyle === fs ? 800 : 500, opacity: curFillStyle === fs ? 1 : 0.55 }}>
                        {fs === 'cross-hatch' ? 'cross' : fs}
                      </button>
                    ))}
                  </div>
                )}
                <div className="whiteboard-control-group" title="Stroke style">
                  {(['solid', 'dashed', 'dotted'] as const).map(ss => (
                    <button key={ss} onClick={() => applyShapeStyle({ strokeStyle: ss })} className="whiteboard-action"
                      style={{ fontSize: 11, padding: '4px 8px', fontWeight: curStroke === ss ? 800 : 500, opacity: curStroke === ss ? 1 : 0.55 }}>
                      {ss}
                    </button>
                  ))}
                </div>
              </>
            );
          })()}
          <div className="whiteboard-spacer" />
          {canEdit && (selectedShape || selectedObject || selectedTextId || multiShapeIds.length > 0 || multiObjectIds.length > 0 || multiTextIds.length > 0) && (
            <div className="whiteboard-control-group">
              <button onClick={duplicateSelection} className="whiteboard-action" title="Duplicate (Ctrl+D)">Duplicate</button>
              <button onClick={copySelection} className="whiteboard-action" title="Copy (Ctrl+C) — paste in any room">Copy</button>
              <button onClick={pasteClipboard} className="whiteboard-action" title="Paste (Ctrl+V)">Paste</button>
              <button onClick={() => zOrderSelection(true)} className="whiteboard-action" title="Bring to front (Ctrl+])">Front</button>
              <button onClick={() => zOrderSelection(false)} className="whiteboard-action" title="Send to back (Ctrl+[)">Back</button>
              {(multiShapeIds.length + multiObjectIds.length + multiTextIds.length) >= 2 && (
                <button onClick={groupSelection} className="whiteboard-action" title="Group — move together (Ctrl+G)">Group</button>
              )}
              {(() => {
                const { shapeIds, textIds, objIds } = getSelectedSets();
                const grouped =
                  shapes.some(s => s.groupId && shapeIds.has(s.id)) ||
                  texts.some(t => t.groupId && textIds.has(t.id)) ||
                  objects.some(o => o.groupId && objIds.has(o.id));
                return grouped ? (
                  <button onClick={ungroupSelection} className="whiteboard-action" title="Ungroup (Ctrl+Shift+G)">Ungroup</button>
                ) : null;
              })()}
            </div>
          )}
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
          <button onClick={exportBoardHD} className="whiteboard-action" title="Download a high-definition PNG of the WHOLE board — everything written this session, not just the visible area. Great as context for AI/LLMs.">📸 HD Export</button>
          {/* AUTONOMOUS: Save current whiteboard state as a reusable
              template. Opens a small inline modal for naming; on save
              the snapshot lands in localStorage and shows up on the
              Home page's "My templates" panel for one-click reuse in
              a fresh room. Teacher-only because students don't own
              the board content; saving from a student view would
              snapshot whatever they happen to be viewing. */}
          {canEdit && isTeacher && (
            <button
              onClick={() => {
                setSaveTemplateName('');
                setShowSaveTemplateModal(true);
              }}
              className="whiteboard-action"
              title="Save the current board as a reusable lesson template"
            >
              💾 Save lesson
            </button>
          )}
          {canEdit && <button onClick={clearInk} className="whiteboard-action danger">Clear ink</button>}
          {canEdit && <button onClick={clearBoard} className="whiteboard-action danger">Clear board</button>}
        </div>

        <div ref={containerRef} className="whiteboard-canvas-wrap">
          <canvas
            ref={canvasRef}
            className="absolute inset-0"
            style={{
              // AUTONOMOUS: [iPad fix] - Belt-and-braces CSS for iOS.
              // touch-action:none should stop browser-side gestures, but
              // we also explicitly disable Safari's text-selection /
              // callout / touch-highlight behaviours that can interfere
              // with drawing on iPad.
              touchAction: 'none',
              WebkitUserSelect: 'none',
              WebkitTouchCallout: 'none',
              WebkitTapHighlightColor: 'transparent',
              userSelect: 'none',
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
              <div
                style={{
                  position: 'absolute',
                  left: `${screenX}px`,
                  top: `${screenY}px`,
                  zIndex: 40,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                {/* AUTONOMOUS: Math-mode toggle anchored just above the
                    textarea. Click "ƒx" → text is rendered as KaTeX on
                    commit. While in math mode the textarea shows a live
                    rendered preview below it so the teacher can see the
                    result as they type. */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 4,
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                  // Don't steal focus from the textarea on click of the
                  // toggle — onMouseDown preventDefault keeps the cursor
                  // inside the textarea so blur-commit doesn't fire.
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      setTextEditor(ed => ed ? { ...ed, latex: !ed.latex } : ed);
                      // Re-focus the textarea so typing continues.
                      requestAnimationFrame(() => textEditorRef.current?.focus());
                    }}
                    style={{
                      padding: '3px 10px',
                      borderRadius: 6,
                      border: textEditor.latex ? '1px solid #4F46E5' : '1px solid #D4D4D8',
                      background: textEditor.latex ? '#4F46E5' : '#fff',
                      color: textEditor.latex ? '#fff' : '#4F46E5',
                      cursor: 'pointer',
                      fontFamily: 'ui-serif, Georgia, serif',
                      fontStyle: 'italic',
                      fontWeight: 700,
                      fontSize: 13,
                      boxShadow: '0 2px 5px rgba(15,23,42,0.10)',
                    }}
                    title={textEditor.latex ? 'Math mode ON — type LaTeX (eg. x^2, \\frac{a}{b})' : 'Switch to math mode — render typed LaTeX as proper equations'}
                  >
                    ƒx
                  </button>
                  {textEditor.latex && (
                    <span style={{ color: '#6B7280', fontSize: 10.5 }}>
                      LaTeX · Enter to commit
                    </span>
                  )}
                </div>
                {/* AUTONOMOUS: Math symbol palette. Quick-tap row for
                    symbols that are hard to type. In plain-text mode
                    we insert the literal unicode character; in LaTeX
                    mode we insert the matching command (e.g. \pi) so
                    KaTeX renders it on commit.

                    onMouseDown preventDefault keeps the textarea
                    focused — without it the blur-commit fires and
                    the editor closes the moment you click a symbol. */}
                {(() => {
                  const SYMBOLS: Array<{ label: string; plain: string; latex: string; title: string }> = [
                    { label: '×', plain: '×', latex: '\\times ', title: 'Multiply' },
                    { label: '÷', plain: '÷', latex: '\\div ', title: 'Divide' },
                    { label: '±', plain: '±', latex: '\\pm ', title: 'Plus-minus' },
                    { label: '°', plain: '°', latex: '^{\\circ}', title: 'Degree' },
                    { label: 'π', plain: 'π', latex: '\\pi ', title: 'Pi' },
                    { label: '√', plain: '√', latex: '\\sqrt{}', title: 'Square root' },
                    { label: 'x²', plain: '²', latex: '^{2}', title: 'Squared' },
                    { label: 'x³', plain: '³', latex: '^{3}', title: 'Cubed' },
                    { label: '≤', plain: '≤', latex: '\\leq ', title: 'Less than or equal' },
                    { label: '≥', plain: '≥', latex: '\\geq ', title: 'Greater than or equal' },
                    { label: '≠', plain: '≠', latex: '\\neq ', title: 'Not equal' },
                    { label: '≈', plain: '≈', latex: '\\approx ', title: 'Approximately' },
                    { label: '∞', plain: '∞', latex: '\\infty ', title: 'Infinity' },
                    { label: '∫', plain: '∫', latex: '\\int ', title: 'Integral' },
                    { label: 'Σ', plain: 'Σ', latex: '\\sum ', title: 'Summation' },
                    { label: '∠', plain: '∠', latex: '\\angle ', title: 'Angle' },
                    { label: 'θ', plain: 'θ', latex: '\\theta ', title: 'Theta' },
                    { label: '⅓', plain: '⅓', latex: '\\tfrac{1}{3}', title: 'One third' },
                  ];
                  const insertAtCursor = (s: string) => {
                    const ta = textEditorRef.current;
                    if (!ta) return;
                    const start = ta.selectionStart ?? ta.value.length;
                    const end = ta.selectionEnd ?? ta.value.length;
                    const next = ta.value.slice(0, start) + s + ta.value.slice(end);
                    setTextEditor(ed => ed ? { ...ed, value: next } : ed);
                    // Move caret to just after the inserted text. We
                    // need rAF because React hasn't applied the new
                    // value to the DOM yet at this tick.
                    requestAnimationFrame(() => {
                      const t = textEditorRef.current;
                      if (!t) return;
                      const pos = start + s.length;
                      t.focus();
                      t.setSelectionRange(pos, pos);
                    });
                  };
                  return (
                    <div
                      onMouseDown={(e) => e.preventDefault()}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 3,
                        marginBottom: 6,
                        maxWidth: 360,
                        padding: 4,
                        background: 'rgba(255,255,255,0.96)',
                        border: '1px solid #E5E7EB',
                        borderRadius: 8,
                        boxShadow: '0 2px 8px rgba(15,23,42,0.10)',
                      }}
                      aria-label="Math symbols"
                    >
                      {SYMBOLS.map(s => (
                        <button
                          key={s.label}
                          onClick={(e) => {
                            e.preventDefault();
                            insertAtCursor(textEditor.latex ? s.latex : s.plain);
                          }}
                          title={`${s.title} — inserts ${textEditor.latex ? s.latex.trim() : s.plain}`}
                          style={{
                            width: 32,
                            height: 30,
                            padding: 0,
                            border: '1px solid transparent',
                            borderRadius: 5,
                            background: 'transparent',
                            color: '#0F172A',
                            fontFamily: 'ui-serif, Georgia, serif',
                            fontSize: 15,
                            cursor: 'pointer',
                            transition: 'background 0.12s ease, border-color 0.12s ease',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(99,102,241,0.10)';
                            e.currentTarget.style.borderColor = 'rgba(99,102,241,0.30)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.borderColor = 'transparent';
                          }}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  );
                })()}
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
                    // Important: padding/border 0 so what the user types lines
                    // up exactly with where the committed text will render.
                    margin: 0,
                    padding: 0,
                    border: 'none',
                    outline: '2px solid #2563eb',
                    outlineOffset: '2px',
                    background: 'rgba(255,255,255,0.95)',
                    color: textEditor.color,
                    fontFamily: textEditor.latex ? 'ui-monospace, SFMono-Regular, monospace' : TEXT_FONT_FAMILY,
                    fontSize: `${cssFontSize}px`,
                    lineHeight: TEXT_LINE_HEIGHT_RATIO,
                    // Width grows with content; height auto-fits via rows
                    minWidth: `${Math.max(80, cssFontSize * 6)}px`,
                    width: 'auto',
                    resize: 'none',
                    overflow: 'hidden',
                    whiteSpace: 'pre',
                    caretColor: textEditor.color,
                    boxShadow: '0 4px 14px rgba(15,23,42,0.18)',
                    borderRadius: 4,
                  }}
                  rows={Math.max(1, textEditor.value.split('\n').length)}
                  cols={Math.max(8, ...textEditor.value.split('\n').map(l => l.length + 1))}
                />
                {/* AUTONOMOUS: Live KaTeX preview while editing in math
                    mode. Shows below the source textarea so the teacher
                    can see the rendered equation as they type. */}
                {textEditor.latex && textEditor.value.trim() && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: '6px 10px',
                      background: '#FAFAF9',
                      border: '1px solid #E5E7EB',
                      borderRadius: 6,
                      color: textEditor.color,
                      fontSize: `${cssFontSize}px`,
                      lineHeight: 1.2,
                      maxWidth: 600,
                    }}
                    dangerouslySetInnerHTML={{ __html: renderLatexToHtml(stripMathDelimiters(textEditor.value)) }}
                  />
                )}
              </div>
            );
          })()}

          {/* AUTONOMOUS: KaTeX-rendered math labels as DOM overlays.
              Plain text labels render on canvas (via redrawCanvas);
              latex labels render here so KaTeX HTML is honoured.
              Each math label is absolutely positioned in board space:
              left/top mapped through current view, font-size scaled with
              boardScale so the math grows/shrinks with the canvas. */}
          {texts.map(t => {
            if (!t.latex) return null;
            if (textEditor && textEditor.id === t.id) return null; // hidden during edit
            const screenX = t.x * view.boardScale + view.boardOffsetX;
            const screenY = t.y * view.boardScale + view.boardOffsetY;
            const cssFontSize = Math.max(8, t.fontSize * view.boardScale);
            return (
              <MathLabel
                key={t.id}
                latex={stripMathDelimiters(t.text)}
                x={screenX}
                y={screenY}
                cssFontSize={cssFontSize}
                color={t.color}
                onMeasure={(w, h) => {
                  // Convert measured pixel size to board-space and cache.
                  mathBboxesRef.current.set(t.id, {
                    w: w / view.boardScale,
                    h: h / view.boardScale,
                  });
                }}
              />
            );
          })}

          <div className="whiteboard-hint">
            Space + drag pans. Wheel zooms. Drag an image onto the board. Select image or stroke, then press Delete.
          </div>

          {/* AUTONOMOUS: Drop-zone overlay shown while a file drag is
              hovering. Pointer-events:none so it doesn't swallow the
              drag itself — the overlay is purely visual feedback.
              Centred message + dashed border so the user knows the
              drop will land here, not be navigated to. */}
          {dragOverActive && (
            <div
              style={{
                position: 'absolute',
                inset: 8,
                border: '3px dashed #4F46E5',
                borderRadius: 14,
                background: 'rgba(99,102,241,0.10)',
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 80,
                color: '#312E81',
                fontWeight: 700,
                fontSize: 18,
                letterSpacing: '0.01em',
                backdropFilter: 'blur(2px)',
              }}
            >
              <span>📎 Drop image to add to the board</span>
            </div>
          )}

          {/* AUTONOMOUS: Save-as-template modal. Centered, glass-card
              style matching the existing room modals. Captures current
              whiteboard state as a snapshot and pushes it to
              localStorage. */}
          {showSaveTemplateModal && (
            <div
              onClick={() => setShowSaveTemplateModal(false)}
              style={{
                position: 'absolute',
                inset: 0,
                background: 'rgba(15,23,42,0.45)',
                backdropFilter: 'blur(4px)',
                zIndex: 100,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 20,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: '#fff',
                  borderRadius: 14,
                  padding: '20px 22px',
                  width: '100%',
                  maxWidth: 440,
                  boxShadow: '0 20px 60px rgba(15,23,42,0.30)',
                  fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
                }}
              >
                <h3 style={{ fontSize: 17, fontWeight: 700, margin: '0 0 6px', color: '#0F172A' }}>
                  💾 Save this board as a template
                </h3>
                <p style={{ fontSize: 13, color: '#64748B', margin: '0 0 14px', lineHeight: 1.5 }}>
                  Save the current shapes, text, and rulers. You'll be able to start a fresh class from this layout in one click — it'll show up on the home page under "My templates".
                </p>
                <input
                  autoFocus
                  value={saveTemplateName}
                  onChange={(e) => setSaveTemplateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setShowSaveTemplateModal(false);
                    if (e.key === 'Enter') {
                      // Trigger the save action — handled by the button onClick below.
                      (document.getElementById('wb-save-template-submit') as HTMLButtonElement | null)?.click();
                    }
                    e.stopPropagation();
                  }}
                  placeholder="Template name (e.g. Pythagorean starter)"
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    fontSize: 14,
                    border: '1px solid #D4D4D8',
                    borderRadius: 8,
                    marginBottom: 14,
                    outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button
                    onClick={() => setShowSaveTemplateModal(false)}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 8,
                      border: '1px solid #D4D4D8',
                      background: '#fff',
                      color: '#0F172A',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    id="wb-save-template-submit"
                    onClick={() => {
                      // Snapshot the CURRENT whiteboard state. Images are
                      // included but if the total exceeds the localStorage
                      // quota the templates.save() will throw — caught
                      // below with a friendly toast.
                      try {
                        const snapshot = {
                          objects,
                          strokes,
                          shapes,
                          texts,
                          instruments,
                          gridMode,
                          view, // saved so reopened templates use the same zoom/pan baseline
                        };
                        const tpl = templatesStore.save(saveTemplateName, snapshot);
                        setShowSaveTemplateModal(false);
                        setSaveTemplateToast(`✓ Saved: ${tpl.name}`);
                        setTimeout(() => setSaveTemplateToast(null), 3000);
                      } catch (err) {
                        setSaveTemplateToast(`⚠️ ${String(err)}`);
                        setTimeout(() => setSaveTemplateToast(null), 5000);
                      }
                    }}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 8,
                      border: 'none',
                      background: '#4F46E5',
                      color: '#fff',
                      fontWeight: 700,
                      cursor: 'pointer',
                      boxShadow: '0 2px 6px rgba(79,70,229,0.30)',
                    }}
                  >
                    Save template
                  </button>
                </div>
              </div>
            </div>
          )}
          {saveTemplateToast && (
            <div
              style={{
                position: 'absolute',
                top: 14,
                left: '50%',
                transform: 'translateX(-50%)',
                background: '#0F172A',
                color: '#fff',
                padding: '8px 16px',
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                boxShadow: '0 8px 24px rgba(15,23,42,0.25)',
                zIndex: 90,
              }}
            >
              {saveTemplateToast}
            </div>
          )}
        </div>
      </div>
    );
  }
);

export default Whiteboard;
