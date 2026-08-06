// Where a shape's corners are, given the box the tutor dragged.
//
// The board had five shapes: line, rectangle, circle, arrow, diamond. A maths
// tutor draws triangles constantly — and right-angled triangles, and the
// quadrilaterals a whole topic is named after. Drawing a trapezium out of four
// separate lines every time, and having it not move as one object afterwards,
// is the kind of friction that quietly stops you using the board.
//
// Every new shape here is a polygon inscribed in the drag box, so one function
// serves BOTH the renderer and the hit test. They used to be written out
// separately per kind, which is how a shape ends up drawn in one place and
// unselectable in the other.

export type ShapeKind =
  | 'line' | 'rect' | 'circle' | 'arrow' | 'diamond'
  | 'triangle' | 'rightTriangle' | 'ellipse'
  | 'parallelogram' | 'trapezoid' | 'pentagon' | 'hexagon' | 'star';

export type Point = [number, number];

/** Kinds whose outline is a closed polygon in the drag box. */
const POLYGONAL = new Set<ShapeKind>([
  'rect', 'diamond', 'triangle', 'rightTriangle',
  'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'star',
]);

export function isPolygonal(kind: ShapeKind): boolean {
  return POLYGONAL.has(kind);
}

/** A regular n-gon inscribed in the box, flat-bottomed and point-up. */
function regular(cx: number, cy: number, rx: number, ry: number, n: number): Point[] {
  const pts: Point[] = [];
  // -90° puts a vertex at the top, which is how a pentagon or hexagon is drawn
  // in every textbook. Starting at 0° lands one on the right and looks tilted.
  for (let i = 0; i < n; i++) {
    const a = (-Math.PI / 2) + (i * 2 * Math.PI) / n;
    pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/**
 * The outline, or null for the kinds that are not polygons (line, arrow,
 * circle, ellipse) and must be drawn their own way.
 *
 * The box is normalised first: a tutor dragging up-and-left is drawing the same
 * triangle as one dragging down-and-right, and every kind here would otherwise
 * come out mirrored or inside out.
 */
export function shapePolygon(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number): Point[] | null {
  if (!isPolygonal(kind)) return null;
  const left = Math.min(x1, x2), right = Math.max(x1, x2);
  const top = Math.min(y1, y2), bottom = Math.max(y1, y2);
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const w = right - left, h = bottom - top;

  switch (kind) {
    case 'rect':
      return [[left, top], [right, top], [right, bottom], [left, bottom]];
    case 'diamond':
      return [[cx, top], [right, cy], [cx, bottom], [left, cy]];
    case 'triangle':
      // Isosceles, apex centred — the default "triangle" everyone means.
      return [[cx, top], [right, bottom], [left, bottom]];
    case 'rightTriangle':
      // Right angle at the bottom-left, so the two legs sit on the axes. This
      // is the one that gets labelled with opposite/adjacent/hypotenuse.
      return [[left, top], [right, bottom], [left, bottom]];
    case 'parallelogram': {
      const slant = w * 0.25;
      return [[left + slant, top], [right, top], [right - slant, bottom], [left, bottom]];
    }
    case 'trapezoid': {
      const inset = w * 0.22;
      return [[left + inset, top], [right - inset, top], [right, bottom], [left, bottom]];
    }
    case 'pentagon':
      return regular(cx, cy, w / 2, h / 2, 5);
    case 'hexagon':
      return regular(cx, cy, w / 2, h / 2, 6);
    case 'star': {
      const pts: Point[] = [];
      const rx = w / 2, ry = h / 2;
      // 0.382 is the ratio that makes a five-pointed star's inner pentagon
      // regular; anything else gives fat or spidery points.
      for (let i = 0; i < 10; i++) {
        const a = (-Math.PI / 2) + (i * Math.PI) / 5;
        const f = i % 2 === 0 ? 1 : 0.382;
        pts.push([cx + rx * f * Math.cos(a), cy + ry * f * Math.sin(a)]);
      }
      return pts;
    }
    default:
      return null;
  }
}

/** Half-width, half-height and centre of the drag box — for the ellipse. */
export function ellipseBox(x1: number, y1: number, x2: number, y2: number) {
  return {
    cx: (x1 + x2) / 2,
    cy: (y1 + y2) / 2,
    rx: Math.abs(x2 - x1) / 2,
    ry: Math.abs(y2 - y1) / 2,
  };
}

/** Is the point near the ellipse's OUTLINE (these shapes are hollow)? */
export function nearEllipseEdge(px: number, py: number, x1: number, y1: number, x2: number, y2: number, tol: number): boolean {
  const { cx, cy, rx, ry } = ellipseBox(x1, y1, x2, y2);
  if (rx < 1e-6 || ry < 1e-6) return false;
  const dx = (px - cx) / rx, dy = (py - cy) / ry;
  const d = Math.hypot(dx, dy);
  if (d === 0) return false;
  // Convert the normalised distance back into board units along the radius the
  // point lies on, so the tolerance stays a real distance rather than being
  // stretched by the ellipse's own aspect ratio.
  const scale = Math.hypot(dx * rx, dy * ry) / d;
  return Math.abs(d - 1) * scale <= tol;
}

export interface ShapeChoice {
  id: ShapeKind;
  label: string;
  /** Grouping in the palette. */
  group: 'lines' | 'quads' | 'triangles' | 'curves' | 'polygons';
}

/** What the palette offers, in the order a tutor scans it. */
export const SHAPE_CATALOG: ShapeChoice[] = [
  { id: 'line', label: 'Line', group: 'lines' },
  { id: 'arrow', label: 'Arrow', group: 'lines' },
  { id: 'rect', label: 'Rectangle', group: 'quads' },
  { id: 'parallelogram', label: 'Parallelogram', group: 'quads' },
  { id: 'trapezoid', label: 'Trapezium', group: 'quads' },
  { id: 'diamond', label: 'Rhombus', group: 'quads' },
  { id: 'triangle', label: 'Triangle', group: 'triangles' },
  { id: 'rightTriangle', label: 'Right triangle', group: 'triangles' },
  { id: 'circle', label: 'Circle', group: 'curves' },
  { id: 'ellipse', label: 'Ellipse', group: 'curves' },
  { id: 'pentagon', label: 'Pentagon', group: 'polygons' },
  { id: 'hexagon', label: 'Hexagon', group: 'polygons' },
  { id: 'star', label: 'Star', group: 'polygons' },
];
