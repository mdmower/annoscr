import cairo from 'gi://cairo?version=1.0';
import Pango from 'gi://Pango?version=1.0';
import PangoCairo from 'gi://PangoCairo?version=1.0';

export interface Style {
  color: [number, number, number, number];
  width: number;
}

export interface Action {
  draw(cr: any, scale: number): void;
}

export interface LiveStroke {
  // `constrain` is the modifier hint — currently only Shift, used by the shape
  // tools to snap rect/oval to a square/circle.
  extendTo(x: number, y: number, constrain: boolean): void;
  finish(): Action | null;
  draw(cr: any, scale: number): void;
}

export type ToolId = 'pen' | 'highlighter' | 'line' | 'arrow' | 'rect' | 'oval' | 'text' | 'number';

export interface TextStyle {
  color: [number, number, number, number];
  size: number;       // image-space pixels (font height)
  fontDesc: string;   // Pango font description string
}

export interface NumberStampStyle {
  radius: number;     // image-space pixels
  fillColor: [number, number, number, number];
  borderColor: [number, number, number, number];
  borderWidth: number;
  textColor: [number, number, number, number];
  fontDesc: string;
  fontSize: number;   // image-space pixels
}

const RED: Style['color'] = [0.85, 0.18, 0.18, 1.0];

export const PEN_STYLE: Style = { color: RED, width: 4 };
export const HIGHLIGHTER_STYLE: Style = { color: [1.0, 0.92, 0.10, 0.35], width: 18 };
export const LINE_STYLE: Style = { color: RED, width: 3 };
export const ARROW_STYLE: Style = { color: RED, width: 3 };
export const SHAPE_STYLE: Style = { color: RED, width: 3 };
export const TEXT_STYLE: TextStyle = { color: RED, size: 24, fontDesc: 'Sans Bold' };
export const NUMBER_STAMP_STYLE: NumberStampStyle = {
  radius: 16,
  fillColor: RED,
  borderColor: [1, 1, 1, 1],
  borderWidth: 2,
  textColor: [1, 1, 1, 1],
  fontDesc: 'Sans Bold',
  fontSize: 16,
};

const SHAPE_MIN_EXTENT = 2;

export function createLiveStroke(toolId: ToolId, x: number, y: number): LiveStroke {
  switch (toolId) {
    case 'pen':         return new StrokeLiveStroke(x, y, PEN_STYLE);
    case 'highlighter': return new StrokeLiveStroke(x, y, HIGHLIGHTER_STYLE);
    case 'line':        return new LineLiveStroke(x, y, LINE_STYLE);
    case 'arrow':       return new ArrowLiveStroke(x, y, ARROW_STYLE);
    case 'rect':        return new RectLiveStroke(x, y, SHAPE_STYLE);
    case 'oval':        return new OvalLiveStroke(x, y, SHAPE_STYLE);
    case 'text':
    case 'number':
      // Click-driven tools don't fit the drag/LiveStroke model. The canvas
      // guards against this call; the throw is a safety net.
      throw new Error(`${toolId} tool is handled outside createLiveStroke`);
  }
}

// ---------- Text ----------

class TextAction implements Action {
  constructor(
    private readonly x: number,
    private readonly y: number,
    private readonly markup: string,
    private readonly style: TextStyle,
  ) {}

  draw(cr: any, _scale: number): void {
    if (!this.markup) return;
    const layout = PangoCairo.create_layout(cr);
    const desc = Pango.FontDescription.from_string(this.style.fontDesc);
    desc.set_absolute_size(this.style.size * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_markup(this.markup, -1);

    const [r, g, b, a] = this.style.color;
    cr.setSourceRGBA(r, g, b, a);
    cr.moveTo(this.x, this.y);
    PangoCairo.show_layout(cr, layout);
  }
}

export function makeTextAction(x: number, y: number, markup: string, style: TextStyle = TEXT_STYLE): Action {
  return new TextAction(x, y, markup, style);
}

// ---------- Number stamp ----------

class NumberStampAction implements Action {
  constructor(
    private readonly x: number,
    private readonly y: number,
    private readonly n: number,
    private readonly style: NumberStampStyle,
  ) {}

  draw(cr: any, _scale: number): void {
    const s = this.style;

    // newSubPath so the arc isn't connected by a line segment to whatever
    // current point a previous action left behind (e.g. PangoCairo.show_layout
    // leaves the current point at the end of rendered text).
    cr.newSubPath();
    cr.arc(this.x, this.y, s.radius, 0, 2 * Math.PI);
    const [fr, fg, fb, fa] = s.fillColor;
    cr.setSourceRGBA(fr, fg, fb, fa);
    cr.fillPreserve();

    cr.setLineWidth(s.borderWidth);
    cr.setLineCap(cairo.LineCap.BUTT);
    cr.setLineJoin(cairo.LineJoin.MITER);
    const [br, bg, bb, ba] = s.borderColor;
    cr.setSourceRGBA(br, bg, bb, ba);
    cr.stroke();

    const layout = PangoCairo.create_layout(cr);
    const desc = Pango.FontDescription.from_string(s.fontDesc);
    desc.set_absolute_size(s.fontSize * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_text(String(this.n), -1);
    const [textW, textH] = layout.get_pixel_size();

    const [tr, tg, tb, ta] = s.textColor;
    cr.setSourceRGBA(tr, tg, tb, ta);
    cr.moveTo(this.x - textW / 2, this.y - textH / 2);
    PangoCairo.show_layout(cr, layout);
  }
}

export function makeNumberStampAction(x: number, y: number, n: number, style: NumberStampStyle = NUMBER_STAMP_STYLE): Action {
  return new NumberStampAction(x, y, n, style);
}

export function isNumberStampAction(action: Action): boolean {
  return action instanceof NumberStampAction;
}

// ---------- Pen / Highlighter (multi-point stroke) ----------

class StrokeAction implements Action {
  constructor(private readonly points: ReadonlyArray<[number, number]>, private readonly style: Style) {}

  draw(cr: any, _scale: number): void {
    if (this.points.length < 2) return;
    applyStrokeStyle(cr, this.style, cairo.LineCap.ROUND, cairo.LineJoin.ROUND);
    buildSmoothPath(cr, this.points);
    cr.stroke();
  }
}

class StrokeLiveStroke implements LiveStroke {
  private points: Array<[number, number]>;

  constructor(x: number, y: number, private readonly style: Style) {
    this.points = [[x, y]];
  }

  extendTo(x: number, y: number, _constrain: boolean): void {
    this.points.push([x, y]);
  }

  finish(): Action | null {
    if (this.points.length < 2) return null;
    return new StrokeAction(this.points, this.style);
  }

  draw(cr: any, scale: number): void {
    if (this.points.length < 2) return;
    new StrokeAction(this.points, this.style).draw(cr, scale);
  }
}

// ---------- Line ----------

class LineAction implements Action {
  constructor(
    private readonly x1: number, private readonly y1: number,
    private readonly x2: number, private readonly y2: number,
    private readonly style: Style,
  ) {}

  draw(cr: any, _scale: number): void {
    applyStrokeStyle(cr, this.style, cairo.LineCap.ROUND, cairo.LineJoin.ROUND);
    cr.moveTo(this.x1, this.y1);
    cr.lineTo(this.x2, this.y2);
    cr.stroke();
  }
}

class LineLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(private readonly x1: number, private readonly y1: number, private readonly style: Style) {
    this.endX = x1;
    this.endY = y1;
  }

  extendTo(x: number, y: number, _constrain: boolean): void {
    this.endX = x;
    this.endY = y;
  }

  finish(): Action | null {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return null;
    return new LineAction(this.x1, this.y1, this.endX, this.endY, this.style);
  }

  draw(cr: any, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new LineAction(this.x1, this.y1, this.endX, this.endY, this.style).draw(cr, scale);
  }
}

// ---------- Arrow ----------

class ArrowAction implements Action {
  constructor(
    private readonly x1: number, private readonly y1: number,
    private readonly x2: number, private readonly y2: number,
    private readonly style: Style,
  ) {}

  draw(cr: any, _scale: number): void {
    applyStrokeStyle(cr, this.style, cairo.LineCap.ROUND, cairo.LineJoin.ROUND);
    cr.moveTo(this.x1, this.y1);
    cr.lineTo(this.x2, this.y2);

    const angle = Math.atan2(this.y2 - this.y1, this.x2 - this.x1);
    const headLen = this.style.width * 5;
    const headAngle = Math.PI / 6;
    cr.moveTo(this.x2 - headLen * Math.cos(angle - headAngle), this.y2 - headLen * Math.sin(angle - headAngle));
    cr.lineTo(this.x2, this.y2);
    cr.lineTo(this.x2 - headLen * Math.cos(angle + headAngle), this.y2 - headLen * Math.sin(angle + headAngle));
    cr.stroke();
  }
}

class ArrowLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(private readonly x1: number, private readonly y1: number, private readonly style: Style) {
    this.endX = x1;
    this.endY = y1;
  }

  extendTo(x: number, y: number, _constrain: boolean): void {
    this.endX = x;
    this.endY = y;
  }

  finish(): Action | null {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return null;
    return new ArrowAction(this.x1, this.y1, this.endX, this.endY, this.style);
  }

  draw(cr: any, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new ArrowAction(this.x1, this.y1, this.endX, this.endY, this.style).draw(cr, scale);
  }
}

// ---------- Rectangle ----------

class RectAction implements Action {
  constructor(
    private readonly x1: number, private readonly y1: number,
    private readonly x2: number, private readonly y2: number,
    private readonly style: Style,
  ) {}

  draw(cr: any, _scale: number): void {
    applyStrokeStyle(cr, this.style, cairo.LineCap.BUTT, cairo.LineJoin.MITER);
    const x = Math.min(this.x1, this.x2);
    const y = Math.min(this.y1, this.y2);
    const w = Math.abs(this.x2 - this.x1);
    const h = Math.abs(this.y2 - this.y1);
    cr.rectangle(x, y, w, h);
    cr.stroke();
  }
}

class RectLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(private readonly x1: number, private readonly y1: number, private readonly style: Style) {
    this.endX = x1;
    this.endY = y1;
  }

  extendTo(x: number, y: number, constrain: boolean): void {
    [this.endX, this.endY] = constrain ? constrainSquare(this.x1, this.y1, x, y) : [x, y];
  }

  finish(): Action | null {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return null;
    return new RectAction(this.x1, this.y1, this.endX, this.endY, this.style);
  }

  draw(cr: any, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new RectAction(this.x1, this.y1, this.endX, this.endY, this.style).draw(cr, scale);
  }
}

// ---------- Oval ----------

class OvalAction implements Action {
  constructor(
    private readonly x1: number, private readonly y1: number,
    private readonly x2: number, private readonly y2: number,
    private readonly style: Style,
  ) {}

  draw(cr: any, _scale: number): void {
    applyStrokeStyle(cr, this.style, cairo.LineCap.BUTT, cairo.LineJoin.MITER);
    const cx = (this.x1 + this.x2) / 2;
    const cy = (this.y1 + this.y2) / 2;
    const rx = Math.abs(this.x2 - this.x1) / 2;
    const ry = Math.abs(this.y2 - this.y1) / 2;
    if (rx <= 0 || ry <= 0) return;

    // Scale-and-arc trick: build the path under a scaled CTM, then restore
    // BEFORE stroking so the line width isn't scaled with the ellipse axes.
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.stroke();
  }
}

class OvalLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(private readonly x1: number, private readonly y1: number, private readonly style: Style) {
    this.endX = x1;
    this.endY = y1;
  }

  extendTo(x: number, y: number, constrain: boolean): void {
    [this.endX, this.endY] = constrain ? constrainSquare(this.x1, this.y1, x, y) : [x, y];
  }

  finish(): Action | null {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return null;
    return new OvalAction(this.x1, this.y1, this.endX, this.endY, this.style);
  }

  draw(cr: any, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new OvalAction(this.x1, this.y1, this.endX, this.endY, this.style).draw(cr, scale);
  }
}

// ---------- helpers ----------

function applyStrokeStyle(cr: any, style: Style, cap: number, join: number): void {
  const [r, g, b, a] = style.color;
  cr.setSourceRGBA(r, g, b, a);
  cr.setLineWidth(style.width);
  cr.setLineCap(cap);
  cr.setLineJoin(join);
}

function isDegenerate(x1: number, y1: number, x2: number, y2: number): boolean {
  return Math.abs(x2 - x1) < SHAPE_MIN_EXTENT && Math.abs(y2 - y1) < SHAPE_MIN_EXTENT;
}

// Snap (x2, y2) so the bounding box from (x1, y1) is a square. The side is
// the longer of |dx|, |dy| — keeps the dragged-out shape covering the cursor
// rather than retreating from it. Zero-component fallback extends positively
// so a purely horizontal/vertical drag still produces a square.
function constrainSquare(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = Math.sign(dx) || 1;
  const sy = Math.sign(dy) || 1;
  return [x1 + sx * size, y1 + sy * size];
}

// Connects each adjacent pair of points with a quadratic that passes through
// their midpoint, using the raw sample as the control. Smooths sparse pointer
// samples into a continuous curve without losing fidelity.
function buildSmoothPath(cr: any, pts: ReadonlyArray<[number, number]>): void {
  if (pts.length === 2) {
    cr.moveTo(pts[0][0], pts[0][1]);
    cr.lineTo(pts[1][0], pts[1][1]);
    return;
  }

  cr.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const mx = (x1 + x2) * 0.5;
    const my = (y1 + y2) * 0.5;
    cr.curveTo(x1, y1, x1, y1, mx, my);
  }
  const last = pts[pts.length - 1];
  cr.lineTo(last[0], last[1]);
}
