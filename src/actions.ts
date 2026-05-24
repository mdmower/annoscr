import cairo from 'cairo';
import Pango from 'gi://Pango?version=1.0';
import PangoCairo from 'gi://PangoCairo?version=1.0';
import type Cairo from 'cairo';

import {getDefaultTextFont} from './font_catalogue.js';

export type ColorRGBA = [number, number, number, number];

export interface Style {
  color: ColorRGBA;
  width: number;
}

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type RotateDirection = 'cw' | 'ccw';

export interface Action {
  draw(cr: Cairo.Context, scale: number): void;
  getBounds(): Bounds | null;
  translate(dx: number, dy: number): Action;
  // Transform this action so it rotates with the source image. `oldW`/`oldH`
  // are the source image dimensions BEFORE the rotation; the action's stored
  // coords are interpreted in the old image's coordinate space.
  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action;
  // The action's editable foreground color (stroke / outline / text / number
  // stamp border+digit), or null for actions where there is no editable
  // foreground.
  getColor(): ColorRGBA | null;
  withColor(color: ColorRGBA): Action;
  // The action's editable stroke / outline width in image-space pixels, or
  // null for actions where the width isn't a single user-editable scalar
  // (text uses font size, number stamp uses radius + borderWidth).
  getWidth(): number | null;
  withWidth(width: number): Action;
  // The action's editable fill color (interior of rect / oval / number stamp
  // circle), or null for actions that don't carry a fill. For rect / oval,
  // alpha === 0 means "no fill" (outline-only).
  getFill(): ColorRGBA | null;
  withFill(color: ColorRGBA): Action;
  // The action's editable font family (Pango font description string), or
  // null for actions that don't carry one. Only TextAction does today.
  getFontDesc(): string | null;
  withFontDesc(fontDesc: string): Action;
}

// 90° image rotation in image-space coords. Derived by composing Cairo's
// rotate + post-translate-to-positive-quadrant transformation.
function rotatePoint(
  x: number,
  y: number,
  direction: RotateDirection,
  oldW: number,
  oldH: number
): [number, number] {
  return direction === 'cw' ? [oldH - y, x] : [y, oldW - x];
}

// 90° AABB of a rotated text run anchored at (x, y) with original layout
// dimensions w × h and `rotation` quarter-turns CW (0..3).
function textBounds(x: number, y: number, w: number, h: number, rotation: number): Bounds {
  switch (((rotation % 4) + 4) % 4) {
    case 0:
      return {x1: x, y1: y, x2: x + w, y2: y + h};
    case 1:
      return {x1: x - h, y1: y, x2: x, y2: y + w};
    case 2:
      return {x1: x - w, y1: y - h, x2: x, y2: y};
    case 3:
      return {x1: x, y1: y - w, x2: x + h, y2: y};
    default:
      return {x1: x, y1: y, x2: x, y2: y};
  }
}

export interface LiveStroke {
  // `constrain` is the modifier hint — currently only Shift, used by the shape
  // tools to snap rect/oval to a square/circle.
  extendTo(x: number, y: number, constrain: boolean): void;
  finish(): Action | null;
  draw(cr: Cairo.Context, scale: number): void;
}

export type ToolId =
  | 'select'
  | 'pen'
  | 'highlighter'
  | 'line'
  | 'arrow'
  | 'rect'
  | 'oval'
  | 'text'
  | 'number'
  | 'resize';

export interface TextStyle {
  color: [number, number, number, number];
  size: number; // image-space pixels (font height)
  fontDesc: string; // Pango font description string
}

export interface NumberStampStyle {
  radius: number; // image-space pixels
  // Interior of the circle (the dominant visual color).
  fillColor: ColorRGBA;
  // Shared color for the circle border and the digit.
  foregroundColor: ColorRGBA;
  borderWidth: number;
  fontDesc: string;
  fontSize: number; // image-space pixels
}

// 'number' renders the n-th stamp as String(n); 'letter' renders as A..Z,
// restarting at A after Z. Variant lives on each action so undo/redo of a
// global variant change is just a normal history entry.
export type StampVariant = 'number' | 'letter';
export const DEFAULT_STAMP_VARIANT: StampVariant = 'number';

function stampLabel(n: number, variant: StampVariant): string {
  if (variant === 'letter') {
    return String.fromCharCode(65 + ((n - 1) % 26));
  }
  return String(n);
}

export const DEFAULT_COLOR: ColorRGBA = [0.85, 0.18, 0.18, 1.0];
export const DEFAULT_HIGHLIGHTER_COLOR: ColorRGBA = [1.0, 0.92, 0.1, 0.35];

export const PEN_STYLE: Style = {color: DEFAULT_COLOR, width: 4};
export const HIGHLIGHTER_STYLE: Style = {
  color: DEFAULT_HIGHLIGHTER_COLOR,
  width: 18,
};
export const LINE_STYLE: Style = {color: DEFAULT_COLOR, width: 3};
export const ARROW_STYLE: Style = {color: DEFAULT_COLOR, width: 3};
export const SHAPE_STYLE: Style = {color: DEFAULT_COLOR, width: 3};
export const TEXT_STYLE: TextStyle = {
  color: DEFAULT_COLOR,
  size: 24,
  fontDesc: 'Sans',
};

export const DEFAULT_NUMBER_STAMP_FG: ColorRGBA = [1, 1, 1, 1];

export const NUMBER_STAMP_STYLE: NumberStampStyle = {
  radius: 16,
  fillColor: DEFAULT_COLOR,
  foregroundColor: DEFAULT_NUMBER_STAMP_FG,
  borderWidth: 2,
  fontDesc: 'Sans Bold',
  fontSize: 16,
};

// Default per-tool colors used both at startup and as the fallback for the
// color picker when a tool has no explicit override yet. For the number
// stamp, "color" means the foreground (border + digit), not the dominant
// interior — interior lives in the fill slot.
export function defaultColorForTool(toolId: ToolId): ColorRGBA {
  if (toolId === 'highlighter') return DEFAULT_HIGHLIGHTER_COLOR;
  if (toolId === 'number') return DEFAULT_NUMBER_STAMP_FG;
  return DEFAULT_COLOR;
}

// Build a NumberStampStyle with a user-chosen foreground and fill, falling
// back to the static defaults.
export function numberStampStyle(
  foregroundColor: ColorRGBA,
  fillColor: ColorRGBA
): NumberStampStyle {
  return {...NUMBER_STAMP_STYLE, foregroundColor, fillColor};
}

// Default per-tool stroke/outline widths. Tools without an editable width
// (text, number, select, resize) return null.
export function defaultWidthForTool(toolId: ToolId): number | null {
  switch (toolId) {
    case 'pen':
      return PEN_STYLE.width;
    case 'highlighter':
      return HIGHLIGHTER_STYLE.width;
    case 'line':
      return LINE_STYLE.width;
    case 'arrow':
      return ARROW_STYLE.width;
    case 'rect':
    case 'oval':
      return SHAPE_STYLE.width;
    case 'text':
    case 'number':
    case 'select':
    case 'resize':
    default:
      return null;
  }
}

// Default per-tool font description. Only the text tool has one; everything
// else returns null and the font picker hides accordingly. The text default
// resolves to the first available sans family in the font catalogue (lazy,
// cached for the process lifetime).
export function defaultFontDescForTool(toolId: ToolId): string | null {
  if (toolId === 'text') return getDefaultTextFont();
  return null;
}

// Slider range for the width control. Generous enough that the highlighter's
// default (18 px) sits comfortably below the top.
export const WIDTH_MIN = 1;
export const WIDTH_MAX = 40;

const SHAPE_MIN_EXTENT = 2;

// ---------- Text ----------

class TextAction implements Action {
  // Bounds depend on Pango layout measurements which need a Cairo context.
  // We cache the bounds the first time draw() runs; getBounds before any
  // paint returns a small fallback around the anchor point.
  private cachedBounds: Bounds | null = null;

  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly markup: string,
    public readonly rotation: number, // 0..3 quarter-turns CW
    private readonly style: TextStyle
  ) {}

  draw(cr: Cairo.Context, _scale: number): void {
    if (!this.markup) return;
    const layout = PangoCairo.create_layout(cr);
    const desc = Pango.FontDescription.from_string(this.style.fontDesc);
    desc.set_absolute_size(this.style.size * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_markup(this.markup, -1);

    const [w, h] = layout.get_pixel_size();
    this.cachedBounds = textBounds(this.x, this.y, w, h, this.rotation);

    const [r, g, b, a] = this.style.color;
    cr.setSourceRGBA(r, g, b, a);
    cr.save();
    cr.translate(this.x, this.y);
    if (this.rotation !== 0) cr.rotate((this.rotation * Math.PI) / 2);
    cr.moveTo(0, 0);
    PangoCairo.show_layout(cr, layout);
    cr.restore();
  }

  getBounds(): Bounds | null {
    if (this.cachedBounds) return this.cachedBounds;
    // Fallback for the rare "added but never drawn" case — a tiny clickable
    // area around the anchor so the action isn't entirely un-hittable.
    const r = this.style.size;
    return {x1: this.x, y1: this.y, x2: this.x + r, y2: this.y + r};
  }

  translate(dx: number, dy: number): Action {
    return new TextAction(this.x + dx, this.y + dy, this.markup, this.rotation, this.style);
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx, ny] = rotatePoint(this.x, this.y, direction, oldW, oldH);
    const dr = direction === 'cw' ? 1 : 3;
    return new TextAction(nx, ny, this.markup, (this.rotation + dr) % 4, this.style);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return new TextAction(this.x, this.y, this.markup, this.rotation, {
      ...this.style,
      color,
    });
  }

  // Text uses a font size, not a stroke width. Width-tool UI greys out
  // when a TextAction is selected.
  getWidth(): number | null {
    return null;
  }

  withWidth(_width: number): Action {
    return this;
  }

  getFill(): ColorRGBA | null {
    return null;
  }

  withFill(_color: ColorRGBA): Action {
    return this;
  }

  getFontDesc(): string {
    return this.style.fontDesc;
  }

  withFontDesc(fontDesc: string): Action {
    return new TextAction(this.x, this.y, this.markup, this.rotation, {
      ...this.style,
      fontDesc,
    });
  }
}

export function makeTextAction(
  x: number,
  y: number,
  markup: string,
  rotation: number = 0,
  color: ColorRGBA = DEFAULT_COLOR,
  fontDesc: string = TEXT_STYLE.fontDesc
): Action {
  return new TextAction(x, y, markup, ((rotation % 4) + 4) % 4, {
    ...TEXT_STYLE,
    color,
    fontDesc,
  });
}

export function isTextAction(action: Action): boolean {
  return action instanceof TextAction;
}

export function getTextEditState(
  action: Action
): {x: number; y: number; markup: string; rotation: number} | null {
  if (!(action instanceof TextAction)) return null;
  return {
    x: action.x,
    y: action.y,
    markup: action.markup,
    rotation: action.rotation,
  };
}

// ---------- Number stamp ----------

class NumberStampAction implements Action {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly n: number,
    public readonly variant: StampVariant,
    public readonly rotation: number, // 0..3 quarter-turns CW (affects the digit only)
    public readonly style: NumberStampStyle
  ) {}

  draw(cr: Cairo.Context, _scale: number): void {
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
    const [fgr, fgg, fgb, fga] = s.foregroundColor;
    cr.setSourceRGBA(fgr, fgg, fgb, fga);
    cr.stroke();

    const layout = PangoCairo.create_layout(cr);
    const desc = Pango.FontDescription.from_string(s.fontDesc);
    desc.set_absolute_size(s.fontSize * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_text(stampLabel(this.n, this.variant), -1);
    const [textW, textH] = layout.get_pixel_size();

    // Same foreground as the border — single user-editable color.
    cr.setSourceRGBA(fgr, fgg, fgb, fga);
    cr.save();
    cr.translate(this.x, this.y);
    if (this.rotation !== 0) cr.rotate((this.rotation * Math.PI) / 2);
    cr.moveTo(-textW / 2, -textH / 2);
    PangoCairo.show_layout(cr, layout);
    cr.restore();
  }

  getBounds(): Bounds {
    // Circle bounds — rotation of the digit doesn't change the AABB.
    const half = this.style.radius + this.style.borderWidth / 2;
    return {
      x1: this.x - half,
      y1: this.y - half,
      x2: this.x + half,
      y2: this.y + half,
    };
  }

  translate(dx: number, dy: number): Action {
    return new NumberStampAction(
      this.x + dx,
      this.y + dy,
      this.n,
      this.variant,
      this.rotation,
      this.style
    );
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx, ny] = rotatePoint(this.x, this.y, direction, oldW, oldH);
    const dr = direction === 'cw' ? 1 : 3;
    return new NumberStampAction(
      nx,
      ny,
      this.n,
      this.variant,
      (this.rotation + dr) % 4,
      this.style
    );
  }

  // For the number stamp, "Color" controls the foreground (border + digit,
  // which share a color by design); "Fill" controls the interior of the
  // circle (the dominant red by default).
  getColor(): ColorRGBA {
    return this.style.foregroundColor;
  }

  withColor(color: ColorRGBA): Action {
    return new NumberStampAction(this.x, this.y, this.n, this.variant, this.rotation, {
      ...this.style,
      foregroundColor: color,
    });
  }

  // Number stamp has radius + borderWidth, not a single user-editable
  // width. Width-tool UI greys out when a stamp is selected.
  getWidth(): number | null {
    return null;
  }

  withWidth(_width: number): Action {
    return this;
  }

  getFill(): ColorRGBA {
    return this.style.fillColor;
  }

  withFill(color: ColorRGBA): Action {
    return new NumberStampAction(this.x, this.y, this.n, this.variant, this.rotation, {
      ...this.style,
      fillColor: color,
    });
  }

  withNumber(n: number): Action {
    return new NumberStampAction(this.x, this.y, n, this.variant, this.rotation, this.style);
  }

  withVariant(variant: StampVariant): Action {
    return new NumberStampAction(this.x, this.y, this.n, variant, this.rotation, this.style);
  }

  getFontDesc(): string | null {
    return null;
  }

  withFontDesc(_fontDesc: string): Action {
    return this;
  }
}

export function makeNumberStampAction(
  x: number,
  y: number,
  n: number,
  variant: StampVariant = DEFAULT_STAMP_VARIANT,
  rotation: number = 0,
  style: NumberStampStyle = NUMBER_STAMP_STYLE
): Action {
  return new NumberStampAction(x, y, n, variant, ((rotation % 4) + 4) % 4, style);
}

export function isNumberStampAction(action: Action): boolean {
  return action instanceof NumberStampAction;
}

// Walk an action list and reassign `n` to surviving NumberStampActions in
// the order they appear, starting from 1. Used by deleteSelected so that
// "1, 2, 3" with "2" removed becomes "1, 2" rather than "1, 3".
export function renumberStamps(actions: ReadonlyArray<Action>): Action[] {
  let count = 0;
  return actions.map((a) => {
    if (a instanceof NumberStampAction) {
      count++;
      return a.withNumber(count);
    }
    return a;
  });
}

// Rewrite every NumberStampAction in the list with the given variant.
// Non-stamp actions pass through. Used by the global variant toggle.
export function setStampVariantOnAll(
  actions: ReadonlyArray<Action>,
  variant: StampVariant
): Action[] {
  return actions.map((a) => (a instanceof NumberStampAction ? a.withVariant(variant) : a));
}

// ---------- Pen / Highlighter (multi-point stroke) ----------

class StrokeAction implements Action {
  constructor(
    private readonly points: ReadonlyArray<[number, number]>,
    private readonly style: Style
  ) {}

  draw(cr: Cairo.Context, _scale: number): void {
    if (this.points.length < 2) return;
    applyStrokeStyle(cr, this.style, cairo.LineCap.ROUND, cairo.LineJoin.ROUND);
    buildSmoothPath(cr, this.points);
    cr.stroke();
  }

  getBounds(): Bounds {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const [x, y] of this.points) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const pad = this.style.width / 2;
    return {x1: minX - pad, y1: minY - pad, x2: maxX + pad, y2: maxY + pad};
  }

  translate(dx: number, dy: number): Action {
    const moved: Array<[number, number]> = this.points.map(([x, y]) => [x + dx, y + dy]);
    return new StrokeAction(moved, this.style);
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const moved: Array<[number, number]> = this.points.map(([x, y]) =>
      rotatePoint(x, y, direction, oldW, oldH)
    );
    return new StrokeAction(moved, this.style);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return new StrokeAction(this.points, {...this.style, color});
  }

  getWidth(): number {
    return this.style.width;
  }

  withWidth(width: number): Action {
    return new StrokeAction(this.points, {...this.style, width});
  }

  getFill(): ColorRGBA | null {
    return null;
  }

  withFill(_color: ColorRGBA): Action {
    return this;
  }

  getFontDesc(): string | null {
    return null;
  }

  withFontDesc(_fontDesc: string): Action {
    return this;
  }
}

class StrokeLiveStroke implements LiveStroke {
  private points: Array<[number, number]>;

  constructor(
    x: number,
    y: number,
    private readonly style: Style
  ) {
    this.points = [[x, y]];
  }

  extendTo(x: number, y: number, _constrain: boolean): void {
    this.points.push([x, y]);
  }

  finish(): Action | null {
    if (this.points.length < 2) return null;
    return new StrokeAction(this.points, this.style);
  }

  draw(cr: Cairo.Context, scale: number): void {
    if (this.points.length < 2) return;
    new StrokeAction(this.points, this.style).draw(cr, scale);
  }
}

// ---------- Line ----------

class LineAction implements Action {
  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly x2: number,
    private readonly y2: number,
    private readonly style: Style
  ) {}

  draw(cr: Cairo.Context, _scale: number): void {
    applyStrokeStyle(cr, this.style, cairo.LineCap.ROUND, cairo.LineJoin.ROUND);
    cr.moveTo(this.x1, this.y1);
    cr.lineTo(this.x2, this.y2);
    cr.stroke();
  }

  getBounds(): Bounds {
    return endpointBounds(this.x1, this.y1, this.x2, this.y2, this.style.width / 2);
  }

  translate(dx: number, dy: number): Action {
    return new LineAction(this.x1 + dx, this.y1 + dy, this.x2 + dx, this.y2 + dy, this.style);
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx1, ny1] = rotatePoint(this.x1, this.y1, direction, oldW, oldH);
    const [nx2, ny2] = rotatePoint(this.x2, this.y2, direction, oldW, oldH);
    return new LineAction(nx1, ny1, nx2, ny2, this.style);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return new LineAction(this.x1, this.y1, this.x2, this.y2, {
      ...this.style,
      color,
    });
  }

  getWidth(): number {
    return this.style.width;
  }

  withWidth(width: number): Action {
    return new LineAction(this.x1, this.y1, this.x2, this.y2, {
      ...this.style,
      width,
    });
  }

  getFill(): ColorRGBA | null {
    return null;
  }

  withFill(_color: ColorRGBA): Action {
    return this;
  }

  getFontDesc(): string | null {
    return null;
  }

  withFontDesc(_fontDesc: string): Action {
    return this;
  }
}

class LineLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly style: Style
  ) {
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

  draw(cr: Cairo.Context, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new LineAction(this.x1, this.y1, this.endX, this.endY, this.style).draw(cr, scale);
  }
}

// ---------- Arrow ----------

class ArrowAction implements Action {
  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly x2: number,
    private readonly y2: number,
    private readonly style: Style
  ) {}

  draw(cr: Cairo.Context, _scale: number): void {
    applyStrokeStyle(cr, this.style, cairo.LineCap.ROUND, cairo.LineJoin.ROUND);
    cr.moveTo(this.x1, this.y1);
    cr.lineTo(this.x2, this.y2);

    const angle = Math.atan2(this.y2 - this.y1, this.x2 - this.x1);
    const headLen = this.style.width * 5;
    const headAngle = Math.PI / 6;
    cr.moveTo(
      this.x2 - headLen * Math.cos(angle - headAngle),
      this.y2 - headLen * Math.sin(angle - headAngle)
    );
    cr.lineTo(this.x2, this.y2);
    cr.lineTo(
      this.x2 - headLen * Math.cos(angle + headAngle),
      this.y2 - headLen * Math.sin(angle + headAngle)
    );
    cr.stroke();
  }

  getBounds(): Bounds {
    // Pad by the arrowhead length so the head is hittable on either end.
    return endpointBounds(this.x1, this.y1, this.x2, this.y2, this.style.width * 5);
  }

  translate(dx: number, dy: number): Action {
    return new ArrowAction(this.x1 + dx, this.y1 + dy, this.x2 + dx, this.y2 + dy, this.style);
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx1, ny1] = rotatePoint(this.x1, this.y1, direction, oldW, oldH);
    const [nx2, ny2] = rotatePoint(this.x2, this.y2, direction, oldW, oldH);
    return new ArrowAction(nx1, ny1, nx2, ny2, this.style);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return new ArrowAction(this.x1, this.y1, this.x2, this.y2, {
      ...this.style,
      color,
    });
  }

  getWidth(): number {
    return this.style.width;
  }

  withWidth(width: number): Action {
    return new ArrowAction(this.x1, this.y1, this.x2, this.y2, {
      ...this.style,
      width,
    });
  }

  getFill(): ColorRGBA | null {
    return null;
  }

  withFill(_color: ColorRGBA): Action {
    return this;
  }

  getFontDesc(): string | null {
    return null;
  }

  withFontDesc(_fontDesc: string): Action {
    return this;
  }
}

class ArrowLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly style: Style
  ) {
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

  draw(cr: Cairo.Context, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new ArrowAction(this.x1, this.y1, this.endX, this.endY, this.style).draw(cr, scale);
  }
}

// ---------- Rectangle ----------

class RectAction implements Action {
  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly x2: number,
    private readonly y2: number,
    private readonly style: Style,
    private readonly fill: ColorRGBA
  ) {}

  draw(cr: Cairo.Context, _scale: number): void {
    const x = Math.min(this.x1, this.x2);
    const y = Math.min(this.y1, this.y2);
    const w = Math.abs(this.x2 - this.x1);
    const h = Math.abs(this.y2 - this.y1);
    cr.rectangle(x, y, w, h);
    if (this.fill[3] > 0) {
      const [fr, fg, fb, fa] = this.fill;
      cr.setSourceRGBA(fr, fg, fb, fa);
      cr.fillPreserve();
    }
    applyStrokeStyle(cr, this.style, cairo.LineCap.BUTT, cairo.LineJoin.MITER);
    cr.stroke();
  }

  getBounds(): Bounds {
    return endpointBounds(this.x1, this.y1, this.x2, this.y2, this.style.width / 2);
  }

  translate(dx: number, dy: number): Action {
    return new RectAction(
      this.x1 + dx,
      this.y1 + dy,
      this.x2 + dx,
      this.y2 + dy,
      this.style,
      this.fill
    );
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx1, ny1] = rotatePoint(this.x1, this.y1, direction, oldW, oldH);
    const [nx2, ny2] = rotatePoint(this.x2, this.y2, direction, oldW, oldH);
    return new RectAction(nx1, ny1, nx2, ny2, this.style, this.fill);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return new RectAction(this.x1, this.y1, this.x2, this.y2, {...this.style, color}, this.fill);
  }

  getWidth(): number {
    return this.style.width;
  }

  withWidth(width: number): Action {
    return new RectAction(this.x1, this.y1, this.x2, this.y2, {...this.style, width}, this.fill);
  }

  getFill(): ColorRGBA {
    return this.fill;
  }

  withFill(fill: ColorRGBA): Action {
    return new RectAction(this.x1, this.y1, this.x2, this.y2, this.style, fill);
  }

  getFontDesc(): string | null {
    return null;
  }

  withFontDesc(_fontDesc: string): Action {
    return this;
  }
}

class RectLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly style: Style,
    private readonly fill: ColorRGBA
  ) {
    this.endX = x1;
    this.endY = y1;
  }

  extendTo(x: number, y: number, constrain: boolean): void {
    [this.endX, this.endY] = constrain ? constrainSquare(this.x1, this.y1, x, y) : [x, y];
  }

  finish(): Action | null {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return null;
    return new RectAction(this.x1, this.y1, this.endX, this.endY, this.style, this.fill);
  }

  draw(cr: Cairo.Context, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new RectAction(this.x1, this.y1, this.endX, this.endY, this.style, this.fill).draw(cr, scale);
  }
}

// ---------- Oval ----------

class OvalAction implements Action {
  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly x2: number,
    private readonly y2: number,
    private readonly style: Style,
    private readonly fill: ColorRGBA
  ) {}

  draw(cr: Cairo.Context, _scale: number): void {
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

    if (this.fill[3] > 0) {
      const [fr, fg, fb, fa] = this.fill;
      cr.setSourceRGBA(fr, fg, fb, fa);
      cr.fillPreserve();
    }
    applyStrokeStyle(cr, this.style, cairo.LineCap.BUTT, cairo.LineJoin.MITER);
    cr.stroke();
  }

  getBounds(): Bounds {
    return endpointBounds(this.x1, this.y1, this.x2, this.y2, this.style.width / 2);
  }

  translate(dx: number, dy: number): Action {
    return new OvalAction(
      this.x1 + dx,
      this.y1 + dy,
      this.x2 + dx,
      this.y2 + dy,
      this.style,
      this.fill
    );
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx1, ny1] = rotatePoint(this.x1, this.y1, direction, oldW, oldH);
    const [nx2, ny2] = rotatePoint(this.x2, this.y2, direction, oldW, oldH);
    return new OvalAction(nx1, ny1, nx2, ny2, this.style, this.fill);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return new OvalAction(this.x1, this.y1, this.x2, this.y2, {...this.style, color}, this.fill);
  }

  getWidth(): number {
    return this.style.width;
  }

  withWidth(width: number): Action {
    return new OvalAction(this.x1, this.y1, this.x2, this.y2, {...this.style, width}, this.fill);
  }

  getFill(): ColorRGBA {
    return this.fill;
  }

  withFill(fill: ColorRGBA): Action {
    return new OvalAction(this.x1, this.y1, this.x2, this.y2, this.style, fill);
  }

  getFontDesc(): string | null {
    return null;
  }

  withFontDesc(_fontDesc: string): Action {
    return this;
  }
}

class OvalLiveStroke implements LiveStroke {
  private endX: number;
  private endY: number;

  constructor(
    private readonly x1: number,
    private readonly y1: number,
    private readonly style: Style,
    private readonly fill: ColorRGBA
  ) {
    this.endX = x1;
    this.endY = y1;
  }

  extendTo(x: number, y: number, constrain: boolean): void {
    [this.endX, this.endY] = constrain ? constrainSquare(this.x1, this.y1, x, y) : [x, y];
  }

  finish(): Action | null {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return null;
    return new OvalAction(this.x1, this.y1, this.endX, this.endY, this.style, this.fill);
  }

  draw(cr: Cairo.Context, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    new OvalAction(this.x1, this.y1, this.endX, this.endY, this.style, this.fill).draw(cr, scale);
  }
}

// Transparent default fill for rect/oval — outline-only on creation,
// matching the M14 / M15 behaviour. The user can paint a real fill via
// the picker afterwards (or before, with the tool active).
export const TRANSPARENT_FILL: ColorRGBA = [0, 0, 0, 0];

export function createLiveStroke(
  toolId: ToolId,
  x: number,
  y: number,
  color: ColorRGBA,
  width: number,
  fill: ColorRGBA
): LiveStroke {
  switch (toolId) {
    case 'pen':
      return new StrokeLiveStroke(x, y, {...PEN_STYLE, color, width});
    case 'highlighter':
      return new StrokeLiveStroke(x, y, {...HIGHLIGHTER_STYLE, color, width});
    case 'line':
      return new LineLiveStroke(x, y, {...LINE_STYLE, color, width});
    case 'arrow':
      return new ArrowLiveStroke(x, y, {...ARROW_STYLE, color, width});
    case 'rect':
      return new RectLiveStroke(x, y, {...SHAPE_STYLE, color, width}, fill);
    case 'oval':
      return new OvalLiveStroke(x, y, {...SHAPE_STYLE, color, width}, fill);
    case 'select':
    case 'text':
    case 'number':
    case 'resize':
    default:
      // Non-drag-stroke tools handled elsewhere; the canvas guards against
      // this call, the throw is a safety net.
      throw new Error(`${toolId} tool is handled outside createLiveStroke`);
  }
}

// Default per-tool fill. rect/oval start transparent (outline-only);
// number stamp's fill is the dominant red; resize fills with transparent
// (matches the M11.5 behaviour). Tools without a fill return null.
export function defaultFillForTool(toolId: ToolId): ColorRGBA | null {
  switch (toolId) {
    case 'rect':
    case 'oval':
      return TRANSPARENT_FILL;
    case 'number':
      return NUMBER_STAMP_STYLE.fillColor;
    case 'resize':
      return TRANSPARENT_FILL;
    case 'pen':
    case 'highlighter':
    case 'line':
    case 'arrow':
    case 'text':
    case 'select':
    default:
      return null;
  }
}

// ---------- helpers ----------

function applyStrokeStyle(cr: Cairo.Context, style: Style, cap: number, join: number): void {
  const [r, g, b, a] = style.color;
  cr.setSourceRGBA(r, g, b, a);
  cr.setLineWidth(style.width);
  cr.setLineCap(cap);
  cr.setLineJoin(join);
}

function isDegenerate(x1: number, y1: number, x2: number, y2: number): boolean {
  return Math.abs(x2 - x1) < SHAPE_MIN_EXTENT && Math.abs(y2 - y1) < SHAPE_MIN_EXTENT;
}

function endpointBounds(x1: number, y1: number, x2: number, y2: number, pad: number): Bounds {
  return {
    x1: Math.min(x1, x2) - pad,
    y1: Math.min(y1, y2) - pad,
    x2: Math.max(x1, x2) + pad,
    y2: Math.max(y1, y2) + pad,
  };
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
function buildSmoothPath(cr: Cairo.Context, pts: ReadonlyArray<[number, number]>): void {
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
