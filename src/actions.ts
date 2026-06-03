import Cairo from 'cairo';
import Pango from 'gi://Pango?version=1.0';
import PangoCairo from 'gi://PangoCairo?version=1.0';

import {getDefaultTextFont} from './font_catalogue.js';

export type ColorRGBA = [number, number, number, number];

// Stroke dash style for the discrete-path tools (line / arrow / rect / oval).
// 'dotted' is a short dash of length == line width (not a round dot); see
// dashPattern + applyStrokeStyle for the rendering details.
export type DashStyle = 'solid' | 'dashed' | 'dotted';
export const DEFAULT_DASH: DashStyle = 'solid';

interface Style {
  color: ColorRGBA;
  width: number;
  dash: DashStyle;
}

export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type RotateDirection = 'cw' | 'ccw';

// Handle ids for per-action resize (select tool). Box handles — corners (tl/tr/
// bl/br) and edge midpoints (t/b/l/r) — cover rect/oval/number-stamp; endpoint
// handles (p1/p2) cover line/arrow. Free-rotate uses its own gizmo on the same
// grab/preview scaffolding rather than extending this set.
export type HandleId = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r' | 'p1' | 'p2';

// A single resize handle in image space, ready for the canvas to draw and
// hit-test.
export interface ResizeHandle {
  id: HandleId;
  x: number;
  y: number;
}

// The selection box of a rotatable action: a rectangle centered at (cx, cy)
// with half-extents (halfW, halfH), rotated by `angle` radians. Text returns a
// tilted box; the number stamp returns an upright square (angle 0) around its
// circle. Drives the oriented selection box and the rotate gizmo's anchor.
export interface OrientedBounds {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  angle: number;
}

export interface Action {
  draw(cr: Cairo.Context, scale: number): void;
  getBounds(): Bounds | null;
  translate(dx: number, dy: number): Action;
  // Transform this action so it rotates with the source image. `oldW`/`oldH`
  // are the source image dimensions BEFORE the rotation; the action's stored
  // coords are interpreted in the old image's coordinate space.
  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action;
  // The action's editable stroke / outline / foreground color (pen ink, line /
  // arrow / shape outline, number stamp border+digit), or null where there's no
  // such color. Text foreground is NOT here — it's getTextColor, so a shape can
  // expose its outline (getColor) and embedded-text color (getTextColor)
  // independently.
  getColor(): ColorRGBA | null;
  withColor(color: ColorRGBA): Action;
  // The foreground color of text the action carries: a standalone text's glyphs,
  // or the text embedded in a shape. Null for actions with no text. Kept
  // separate from getColor so a shape's outline and its text color don't collide.
  getTextColor(): ColorRGBA | null;
  withTextColor(color: ColorRGBA): Action;
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
  // The action's editable stroke dash style (solid / dashed / dotted), or
  // null for actions whose stroke doesn't carry one (pen, highlighter, text,
  // number stamp). Only line / arrow / rect / oval carry it.
  getDash(): DashStyle | null;
  withDash(dash: DashStyle): Action;
  // Whether the arrowhead is drawn as a filled solid triangle (true) rather
  // than two open strokes (false), or null for actions that have no arrowhead.
  // Only ArrowAction carries it.
  getFilledHead(): boolean | null;
  withFilledHead(filled: boolean): Action;
  // The action's editable font family (Pango font description string), or
  // null for actions that don't carry one. Only TextAction does today.
  getFontDesc(): string | null;
  withFontDesc(fontDesc: string): Action;
  // The action's editable font size in image-space pixels, or null for
  // actions that don't carry one. Only TextAction does today.
  getFontSize(): number | null;
  withFontSize(size: number): Action;
  // The action's text alignment (left / center / right), or null for actions
  // with no alignable text. Only a shape that contains text returns one
  // (standalone TextAction stays left-only — its editor can't preview alignment).
  getAlign(): TextAlign | null;
  withAlign(align: TextAlign): Action;
  // Per-action resize handles, in image space, for the select tool to draw and
  // hit-test — or null for actions that aren't directly resizable (pen,
  // highlighter, text). Box shapes return 8 handles, line/arrow 2 endpoints,
  // the number stamp 4 corners.
  getResizeHandles(): ResizeHandle[] | null;
  // A new action with `handle` dragged to (ix, iy). `constrain` squares a
  // corner drag for rect/oval; endpoints (line/arrow) ignore it and the number
  // stamp is always square. A handle this action doesn't expose returns it
  // unchanged.
  resizeByHandle(handle: HandleId, ix: number, iy: number, constrain: boolean): Action;
  // The free-rotation angle (radians, CW, pivot = center), or null for actions
  // that don't rotate freely (only text + number stamp do). Drives the rotate
  // gizmo's direction.
  getRotation(): number | null;
  withRotation(rotation: number): Action;
  // The oriented selection box (rotated rectangle), or null for actions that
  // use the plain axis-aligned `getBounds()` box. Only the freely-rotatable
  // types return one.
  getOrientedBounds(): OrientedBounds | null;
  // Whether (ix, iy) is inside the action for hit-testing. Defaults to the AABB
  // (`getBounds()`); rotated text overrides it with a precise rotated-rect test
  // so its loose bounding box doesn't grab clicks far from the tilted text.
  containsPoint(ix: number, iy: number): boolean;
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

// Normalize a free-rotation angle (radians) to [0, 2π) so stored angles stay
// bounded under repeated rotation and compare equal for no-op detection.
function normalizeAngle(a: number): number {
  const twoPi = 2 * Math.PI;
  return ((a % twoPi) + twoPi) % twoPi;
}

// AABB of a text run whose unrotated layout rect is [x, y, x+w, y+h], rotated
// by `rotation` radians about its center. Rotate the four corners and take the
// min/max — works for any angle (rotation 0 returns the plain rect).
function textBounds(x: number, y: number, w: number, h: number, rotation: number): Bounds {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [px, py] of [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]) {
    const dx = px - cx;
    const dy = py - cy;
    const rx = cx + dx * cos - dy * sin;
    const ry = cy + dx * sin + dy * cos;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  return {x1: minX, y1: minY, x2: maxX, y2: maxY};
}

export interface LiveStroke {
  // `constrain` is the modifier hint — currently only Shift, used by the shape
  // tools to snap rect/oval to a square/circle.
  extendTo(x: number, y: number, constrain: boolean): void;
  finish(): Action | null;
  draw(cr: Cairo.Context, scale: number): void;
}

export const TOOL_IDS = [
  'select',
  'pen',
  'highlighter',
  'line',
  'arrow',
  'rect',
  'oval',
  'text',
  'number',
  'resize',
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

// Horizontal alignment of multi-line text within its layout. Stored as a string
// (not Pango.Alignment) so it serializes cleanly; mapped at render via
// pangoAlignment. Only exposed as an editable property on shape text (a shape's
// box gives a fixed width to align within); standalone TextAction stays left.
export type TextAlign = 'left' | 'center' | 'right';

export interface TextStyle {
  color: ColorRGBA;
  size: number; // image-space pixels (font height)
  fontDesc: string; // Pango font description string
  // Background plate drawn behind the glyphs for legibility over busy images.
  // Alpha 0 = no plate. Defaults to transparent white so the opacity slider
  // reveals a translucent white background.
  bg: ColorRGBA;
  // Horizontal alignment of the lines within the text block.
  align: TextAlign;
}

// Editor frame dimensions in widget-space pixels — stored on TextAction so
// re-edits restore the size the user dragged the editor to at commit time.
// Doesn't affect the rendered output; purely a UX preference per action.
export interface EditorSize {
  width: number;
  height: number;
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

const DEFAULT_COLOR: ColorRGBA = [0.85, 0.18, 0.18, 1.0];
const DEFAULT_HIGHLIGHTER_COLOR: ColorRGBA = [1.0, 0.92, 0.1, 0.35];

const PEN_STYLE: Style = {color: DEFAULT_COLOR, width: 4, dash: DEFAULT_DASH};
const HIGHLIGHTER_STYLE: Style = {
  color: DEFAULT_HIGHLIGHTER_COLOR,
  width: 18,
  dash: DEFAULT_DASH,
};
const LINE_STYLE: Style = {color: DEFAULT_COLOR, width: 3, dash: DEFAULT_DASH};
const ARROW_STYLE: Style = {color: DEFAULT_COLOR, width: 3, dash: DEFAULT_DASH};
const SHAPE_STYLE: Style = {color: DEFAULT_COLOR, width: 3, dash: DEFAULT_DASH};
// Transparent white: no visible plate until the user raises the opacity.
const TEXT_BG_DEFAULT: ColorRGBA = [1, 1, 1, 0];
export const TEXT_STYLE: TextStyle = {
  color: DEFAULT_COLOR,
  size: 24,
  fontDesc: 'Sans',
  bg: TEXT_BG_DEFAULT,
  align: 'left',
};

// Default text style for a shape's embedded text: centered, on a slightly
// smaller font than standalone text, no background plate (the shape fill is the
// backdrop). Color/font are the standalone defaults.
export const SHAPE_TEXT_STYLE: TextStyle = {
  color: DEFAULT_COLOR,
  size: 20,
  fontDesc: 'Sans',
  bg: [0, 0, 0, 0],
  align: 'center',
};

// Optional centered text carried by a box shape (rect / oval). Empty markup =
// no text (no controls, nothing drawn). The style is the text's own
// color/font/size/align — independent of the box's stroke Style and fill; the
// bg field is unused (the shape fill is the backdrop).
export interface ShapeText {
  markup: string;
  style: TextStyle;
}

const EMPTY_SHAPE_TEXT: ShapeText = {markup: '', style: SHAPE_TEXT_STYLE};

// Inner padding for shape text as a fraction of the font size, so text doesn't
// touch the box edge. Wrapping + alignment happen within (box width − 2·pad).
const SHAPE_TEXT_PAD_RATIO = 0.25;

// Image-space padding inside a shape's box for the given text size. Exported so
// the editor overlay computes the same inner text rect the renderer draws into.
export function shapeTextPadding(size: number): number {
  return Math.round(size * SHAPE_TEXT_PAD_RATIO);
}

// Map a stored TextAlign onto Pango's alignment enum at render time.
function pangoAlignment(align: TextAlign): Pango.Alignment {
  if (align === 'center') return Pango.Alignment.CENTER;
  if (align === 'right') return Pango.Alignment.RIGHT;
  return Pango.Alignment.LEFT;
}

// Text background plate geometry (image-space px). Corner radius is a small
// constant ("slightly rounded"); padding scales with the font so the plate
// stays proportional. Starting values — tune in testing.
const TEXT_BG_RADIUS = 6;
const TEXT_BG_PAD_RATIO = 0.25;

const DEFAULT_NUMBER_STAMP_FG: ColorRGBA = [1, 1, 1, 1];

const NUMBER_STAMP_STYLE: NumberStampStyle = {
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

// Default per-tool text-foreground color (the getTextColor channel). Only the
// text tool carries one today; other tools return null and the "Text color"
// control hides accordingly. (Shapes gain an embedded-text color later.)
export function defaultTextColorForTool(toolId: ToolId): ColorRGBA | null {
  return toolId === 'text' ? TEXT_STYLE.color : null;
}

// Build a NumberStampStyle with a user-chosen foreground, fill, and radius,
// falling back to the static defaults. The border width and digit size scale
// with the radius by the same factor resizeByHandle uses, so a remembered
// larger/smaller stamp stays visually proportional (not a thin border and tiny
// digit on a big disc).
export function numberStampStyle(
  foregroundColor: ColorRGBA,
  fillColor: ColorRGBA,
  radius: number = NUMBER_STAMP_STYLE.radius
): NumberStampStyle {
  const k = radius / NUMBER_STAMP_STYLE.radius;
  return {
    ...NUMBER_STAMP_STYLE,
    foregroundColor,
    fillColor,
    radius,
    borderWidth: NUMBER_STAMP_STYLE.borderWidth * k,
    fontSize: NUMBER_STAMP_STYLE.fontSize * k,
  };
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

// Default per-tool font size (image-space pixels). Only the text tool has
// an editable font size today; everything else returns null and the font
// size picker hides accordingly.
export function defaultFontSizeForTool(toolId: ToolId): number | null {
  if (toolId === 'text') return TEXT_STYLE.size;
  return null;
}

// Slider range for the width control. Generous enough that the highlighter's
// default (18 px) sits comfortably below the top.
export const WIDTH_MIN = 1;
export const WIDTH_MAX = 40;

// SpinButton range for the font size control (image-space pixels).
export const FONT_SIZE_MIN = 6;
export const FONT_SIZE_MAX = 200;

// Canvas dimension limits for the blank-canvas dialog and CLI flags.
export const CANVAS_SIZE_MIN = 1;
export const CANVAS_SIZE_MAX = 8192;

const SHAPE_MIN_EXTENT = 2;

// Number-stamp radius bounds (image-space px). MIN is the resize floor (a corner
// drag can't collapse the stamp to a dot) and the persistence clamp floor; MAX
// only bounds a remembered value loaded from settings.json against junk.
export const STAMP_RADIUS_MIN = 4;
export const STAMP_RADIUS_MAX = 512;
// The static placement radius before any remembered size.
export const DEFAULT_STAMP_RADIUS = NUMBER_STAMP_STYLE.radius;

abstract class BaseAction implements Action {
  abstract draw(cr: Cairo.Context, scale: number): void;
  abstract getBounds(): Bounds | null;
  abstract translate(dx: number, dy: number): Action;
  abstract rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action;

  getColor(): ColorRGBA | null {
    return null;
  }
  withColor(_color: ColorRGBA): Action {
    return this;
  }
  getTextColor(): ColorRGBA | null {
    return null;
  }
  withTextColor(_color: ColorRGBA): Action {
    return this;
  }
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
  getDash(): DashStyle | null {
    return null;
  }
  withDash(_dash: DashStyle): Action {
    return this;
  }
  getFilledHead(): boolean | null {
    return null;
  }
  withFilledHead(_filled: boolean): Action {
    return this;
  }
  getFontDesc(): string | null {
    return null;
  }
  withFontDesc(_fontDesc: string): Action {
    return this;
  }
  getFontSize(): number | null {
    return null;
  }
  withFontSize(_size: number): Action {
    return this;
  }
  getAlign(): TextAlign | null {
    return null;
  }
  withAlign(_align: TextAlign): Action {
    return this;
  }
  getResizeHandles(): ResizeHandle[] | null {
    return null;
  }
  resizeByHandle(_handle: HandleId, _ix: number, _iy: number, _constrain: boolean): Action {
    return this;
  }
  getRotation(): number | null {
    return null;
  }
  withRotation(_rotation: number): Action {
    return this;
  }
  getOrientedBounds(): OrientedBounds | null {
    return null;
  }
  containsPoint(ix: number, iy: number): boolean {
    const b = this.getBounds();
    return b !== null && ix >= b.x1 && ix <= b.x2 && iy >= b.y1 && iy <= b.y2;
  }
}

// ---------- Text ----------

// Shared 1×1 context for measuring Pango layouts at TextAction construction.
// Pango metrics for an absolute-size font don't depend on the target surface,
// so one tiny context is enough and matches what draw()/export render at any
// scale. Created lazily on first use, after GTK is initialized.
let measureContext: Cairo.Context | null = null;
function getMeasureContext(): Cairo.Context {
  if (!measureContext) {
    measureContext = new Cairo.Context(new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1));
  }
  return measureContext;
}

// Append a rounded-rectangle subpath to the current path: a rect at (x, y) of
// size w×h with corner radius `radius`, clamped to half the smaller side so it
// degenerates to a clean rectangle rather than overshooting. Caller fills or
// strokes. Shared by the text background plate, shapes, and the rounded-corner
// rectangle tool.
export function roundedRectPath(
  cr: Cairo.Context,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0) {
    cr.rectangle(x, y, w, h);
    return;
  }
  cr.newSubPath();
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0); // top-right
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2); // bottom-right
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI); // bottom-left
  cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2); // top-left
  cr.closePath();
}

// Create a Pango layout for `markup` at the given font (absolute pixel size).
// Shared by standalone text and shape-embedded text; callers add width /
// alignment / wrap afterward as needed.
function createMarkupLayout(
  cr: Cairo.Context,
  fontDesc: string,
  sizePx: number,
  markup: string
): Pango.Layout {
  const layout = PangoCairo.create_layout(cr);
  const desc = Pango.FontDescription.from_string(fontDesc);
  desc.set_absolute_size(sizePx * Pango.SCALE);
  layout.set_font_description(desc);
  layout.set_markup(markup, -1);
  return layout;
}

class TextAction extends BaseAction {
  // Immutable action ⇒ immutable bounds: measured once at construction (no
  // mutable cache, no pre-paint fallback). A withX()/translate() clone is a
  // new instance, so its bounds are recomputed there. The unrotated layout
  // size (w, h) is kept too — draw, bounds, the oriented box, and the precise
  // hit-test all need it, and it's free here since we measure for bounds anyway.
  private readonly bounds: Bounds;
  private readonly w: number;
  private readonly h: number;

  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly markup: string,
    public readonly rotation: number, // free angle in radians, CW, pivot = center
    private readonly style: TextStyle,
    public readonly editorSize?: EditorSize
  ) {
    super();
    const [w, h] = this.buildLayout(getMeasureContext()).get_pixel_size();
    this.w = w;
    this.h = h;
    this.bounds = textBounds(this.x, this.y, w, h, this.rotation);
  }

  private buildLayout(cr: Cairo.Context): Pango.Layout {
    return createMarkupLayout(cr, this.style.fontDesc, this.style.size, this.markup);
  }

  draw(cr: Cairo.Context, _scale: number): void {
    if (!this.markup) return;
    const layout = this.buildLayout(cr);
    cr.save();
    // Rotate about the layout's center so the text spins in place, then draw
    // from the (unrotated) top-left in that rotated frame.
    cr.translate(this.x + this.w / 2, this.y + this.h / 2);
    if (this.rotation !== 0) cr.rotate(this.rotation);
    cr.translate(-this.w / 2, -this.h / 2);
    // Background plate behind the glyphs (padded, slightly rounded), in the
    // same rotated frame so it tilts with the text. Skipped when transparent.
    const bg = this.style.bg;
    if (bg[3] > 0) {
      const pad = Math.round(this.style.size * TEXT_BG_PAD_RATIO);
      roundedRectPath(cr, -pad, -pad, this.w + 2 * pad, this.h + 2 * pad, TEXT_BG_RADIUS);
      cr.setSourceRGBA(bg[0], bg[1], bg[2], bg[3]);
      cr.fill();
    }
    const [r, g, b, a] = this.style.color;
    cr.setSourceRGBA(r, g, b, a);
    cr.moveTo(0, 0);
    PangoCairo.show_layout(cr, layout);
    cr.restore();
  }

  getBounds(): Bounds {
    return this.bounds;
  }

  translate(dx: number, dy: number): Action {
    return new TextAction(
      this.x + dx,
      this.y + dy,
      this.markup,
      this.rotation,
      this.style,
      this.editorSize
    );
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    // Map the layout center through the 90° image rotation, then re-anchor the
    // (unchanged-size) layout around the new center and add ±90° of spin.
    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2;
    const [ncx, ncy] = rotatePoint(cx, cy, direction, oldW, oldH);
    const dr = direction === 'cw' ? Math.PI / 2 : -Math.PI / 2;
    return new TextAction(
      ncx - this.w / 2,
      ncy - this.h / 2,
      this.markup,
      normalizeAngle(this.rotation + dr),
      this.style,
      this.editorSize
    );
  }

  getRotation(): number {
    return this.rotation;
  }

  withRotation(rotation: number): Action {
    return new TextAction(
      this.x,
      this.y,
      this.markup,
      normalizeAngle(rotation),
      this.style,
      this.editorSize
    );
  }

  getOrientedBounds(): OrientedBounds {
    return {
      cx: this.x + this.w / 2,
      cy: this.y + this.h / 2,
      halfW: this.w / 2,
      halfH: this.h / 2,
      angle: this.rotation,
    };
  }

  // Precise hit-test against the actual rotated rectangle (not the loose AABB):
  // map the point into the layout's local, unrotated frame and test the rect.
  containsPoint(ix: number, iy: number): boolean {
    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2;
    const dx = ix - cx;
    const dy = iy - cy;
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    // Inverse rotation (−angle): rotate the offset back to the upright frame.
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return Math.abs(lx) <= this.w / 2 && Math.abs(ly) <= this.h / 2;
  }

  // Text has no stroke/outline (getColor stays null, inherited); its glyph
  // color lives in the text-color channel so it shares one control with the
  // text embedded in shapes.
  getTextColor(): ColorRGBA {
    return this.style.color;
  }

  withTextColor(color: ColorRGBA): Action {
    return new TextAction(
      this.x,
      this.y,
      this.markup,
      this.rotation,
      {
        ...this.style,
        color,
      },
      this.editorSize
    );
  }

  getFontDesc(): string {
    return this.style.fontDesc;
  }

  withFontDesc(fontDesc: string): Action {
    return new TextAction(
      this.x,
      this.y,
      this.markup,
      this.rotation,
      {
        ...this.style,
        fontDesc,
      },
      this.editorSize
    );
  }

  getFontSize(): number {
    return this.style.size;
  }

  withFontSize(size: number): Action {
    return new TextAction(
      this.x,
      this.y,
      this.markup,
      this.rotation,
      {
        ...this.style,
        size,
      },
      this.editorSize
    );
  }

  // The Fill control carries the text background plate (transparent = none).
  getFill(): ColorRGBA {
    return this.style.bg;
  }

  withFill(bg: ColorRGBA): Action {
    return new TextAction(
      this.x,
      this.y,
      this.markup,
      this.rotation,
      {
        ...this.style,
        bg,
      },
      this.editorSize
    );
  }
}

export function makeTextAction(
  x: number,
  y: number,
  markup: string,
  rotation: number = 0,
  color: ColorRGBA = DEFAULT_COLOR,
  fontDesc: string = TEXT_STYLE.fontDesc,
  fontSize: number = TEXT_STYLE.size,
  bg: ColorRGBA = TEXT_STYLE.bg,
  editorSize?: EditorSize
): Action {
  return new TextAction(
    x,
    y,
    markup,
    normalizeAngle(rotation),
    {
      ...TEXT_STYLE,
      color,
      fontDesc,
      size: fontSize,
      bg,
    },
    editorSize
  );
}

export function isTextAction(action: Action): boolean {
  return action instanceof TextAction;
}

export function getTextEditState(
  action: Action
): {x: number; y: number; markup: string; rotation: number; editorSize?: EditorSize} | null {
  if (!(action instanceof TextAction)) return null;
  return {
    x: action.x,
    y: action.y,
    markup: action.markup,
    rotation: action.rotation,
    editorSize: action.editorSize,
  };
}

// ---------- Number stamp ----------

class NumberStampAction extends BaseAction {
  constructor(
    public readonly x: number,
    public readonly y: number,
    public readonly n: number,
    // Stable id of the stamp's group. Numbering runs independently per group;
    // the dropdown shows a gap-free ordinal label derived from the set of
    // present ids, but this id itself is never reused so placement state stays
    // pinned to the same group across relabels.
    public readonly groupId: number,
    public readonly variant: StampVariant,
    public readonly rotation: number, // free angle in radians, CW (affects the digit only)
    public readonly style: NumberStampStyle
  ) {
    super();
  }

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
    cr.setLineCap(Cairo.LineCap.BUTT);
    cr.setLineJoin(Cairo.LineJoin.MITER);
    // The border is always solid; clear any dash a prior action left set.
    cr.setDash([], 0);
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
    if (this.rotation !== 0) cr.rotate(this.rotation);
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
      this.groupId,
      this.variant,
      this.rotation,
      this.style
    );
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx, ny] = rotatePoint(this.x, this.y, direction, oldW, oldH);
    const dr = direction === 'cw' ? Math.PI / 2 : -Math.PI / 2;
    return new NumberStampAction(
      nx,
      ny,
      this.n,
      this.groupId,
      this.variant,
      normalizeAngle(this.rotation + dr),
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
    return new NumberStampAction(
      this.x,
      this.y,
      this.n,
      this.groupId,
      this.variant,
      this.rotation,
      {
        ...this.style,
        foregroundColor: color,
      }
    );
  }

  getFill(): ColorRGBA {
    return this.style.fillColor;
  }

  withFill(color: ColorRGBA): Action {
    return new NumberStampAction(
      this.x,
      this.y,
      this.n,
      this.groupId,
      this.variant,
      this.rotation,
      {
        ...this.style,
        fillColor: color,
      }
    );
  }

  withNumber(n: number): Action {
    return new NumberStampAction(
      this.x,
      this.y,
      n,
      this.groupId,
      this.variant,
      this.rotation,
      this.style
    );
  }

  withVariant(variant: StampVariant): Action {
    return new NumberStampAction(
      this.x,
      this.y,
      this.n,
      this.groupId,
      variant,
      this.rotation,
      this.style
    );
  }

  getRotation(): number {
    return this.rotation;
  }

  withRotation(rotation: number): Action {
    return new NumberStampAction(
      this.x,
      this.y,
      this.n,
      this.groupId,
      this.variant,
      normalizeAngle(rotation),
      this.style
    );
  }

  // Upright square (angle 0) around the circle — the box itself doesn't tilt
  // (a circle is rotation-invariant), but the gizmo reads the digit's angle
  // from getRotation() so it still tracks the rotation.
  getOrientedBounds(): OrientedBounds {
    const half = this.style.radius + this.style.borderWidth / 2;
    return {cx: this.x, cy: this.y, halfW: half, halfH: half, angle: 0};
  }

  // Four corner handles at the circle's bounding square (radius from center).
  // The stamp is always square, so there are no edge handles to resize one
  // axis.
  getResizeHandles(): ResizeHandle[] {
    const r = this.style.radius;
    return [
      {id: 'tl', x: this.x - r, y: this.y - r},
      {id: 'tr', x: this.x + r, y: this.y - r},
      {id: 'bl', x: this.x - r, y: this.y + r},
      {id: 'br', x: this.x + r, y: this.y + r},
    ];
  }

  // Resize from a corner with the opposite corner anchored, staying square: the
  // dragged corner is squared against the anchor, the new radius is half that
  // side (clamped), and the center shifts to the midpoint so the anchor stays
  // put. The border width and digit size scale with the radius so the stamp
  // stays visually proportional at any size. `constrain` is ignored — the stamp
  // is square either way.
  resizeByHandle(handle: HandleId, ix: number, iy: number, _constrain: boolean): Action {
    const r = this.style.radius;
    let ax: number, ay: number;
    switch (handle) {
      case 'br':
        ax = this.x - r;
        ay = this.y - r;
        break;
      case 'tl':
        ax = this.x + r;
        ay = this.y + r;
        break;
      case 'tr':
        ax = this.x - r;
        ay = this.y + r;
        break;
      case 'bl':
        ax = this.x + r;
        ay = this.y - r;
        break;
      default:
        return this; // edge / endpoint handles don't apply to a stamp
    }
    const [sx, sy] = constrainSquare(ax, ay, ix, iy);
    const half = Math.max(STAMP_RADIUS_MIN, Math.abs(sx - ax) / 2);
    const sgnX = Math.sign(sx - ax) || 1;
    const sgnY = Math.sign(sy - ay) || 1;
    // Scale border + digit by the same factor as the radius so a bigger circle
    // gets a proportionally thicker border and larger number (not a thin border
    // and tiny digit on a huge disc).
    const k = half / r;
    return new NumberStampAction(
      ax + sgnX * half,
      ay + sgnY * half,
      this.n,
      this.groupId,
      this.variant,
      this.rotation,
      {
        ...this.style,
        radius: half,
        borderWidth: this.style.borderWidth * k,
        fontSize: this.style.fontSize * k,
      }
    );
  }
}

export function makeNumberStampAction(
  x: number,
  y: number,
  n: number,
  groupId: number,
  variant: StampVariant = DEFAULT_STAMP_VARIANT,
  rotation: number = 0,
  style: NumberStampStyle = NUMBER_STAMP_STYLE
): Action {
  return new NumberStampAction(x, y, n, groupId, variant, normalizeAngle(rotation), style);
}

export function isNumberStampAction(action: Action): boolean {
  return action instanceof NumberStampAction;
}

// The stamp's group id, or null for non-stamp actions. Lets callers filter a
// mixed action list by group without reaching into the class.
export function numberStampGroup(action: Action): number | null {
  return action instanceof NumberStampAction ? action.groupId : null;
}

// The stamp's variant, or null for non-stamp actions.
export function numberStampVariant(action: Action): StampVariant | null {
  return action instanceof NumberStampAction ? action.variant : null;
}

// The stamp's radius (image-space px), or null for non-stamp actions. Lets the
// canvas remember a resized stamp's size as the next placement's default.
export function numberStampRadius(action: Action): number | null {
  return action instanceof NumberStampAction ? action.style.radius : null;
}

// Move a stamp into a different group, adopting that group's variant so a
// group stays uniformly Number or Letter. Non-stamp actions pass through.
export function reassignStamp(action: Action, groupId: number, variant: StampVariant): Action {
  if (!(action instanceof NumberStampAction)) return action;
  return new NumberStampAction(
    action.x,
    action.y,
    action.n,
    groupId,
    variant,
    action.rotation,
    action.style
  );
}

// Walk an action list and reassign `n` to surviving NumberStampActions, with a
// counter kept independently per group. So deleting "2" from group A's
// "1, 2, 3" leaves "1, 2", and each group numbers from 1 regardless of the
// others' interleaving in document order. Unchanged stamps keep their identity
// (same reference) so clean-state detection isn't tripped by a no-op renumber.
export function renumberStamps(actions: ReadonlyArray<Action>): Action[] {
  const counts = new Map<number, number>();
  return actions.map((a) => {
    if (a instanceof NumberStampAction) {
      const next = (counts.get(a.groupId) ?? 0) + 1;
      counts.set(a.groupId, next);
      return a.n === next ? a : a.withNumber(next);
    }
    return a;
  });
}

// Rewrite the variant of every stamp in one group. Non-matching actions pass
// through unchanged (same reference), so a no-op flip doesn't dirty the state.
export function setStampVariantInGroup(
  actions: ReadonlyArray<Action>,
  groupId: number,
  variant: StampVariant
): Action[] {
  return actions.map((a) =>
    a instanceof NumberStampAction && a.groupId === groupId && a.variant !== variant
      ? a.withVariant(variant)
      : a
  );
}

// ---------- Pen / Highlighter (multi-point stroke) ----------

// Pen and highlighter both produce a StrokeAction; the tag records which tool
// drew it so a select-mode style edit can write back to the right tool default.
// It's the only thing distinguishing the two once committed.
type StrokeTool = 'pen' | 'highlighter';

class StrokeAction extends BaseAction {
  constructor(
    private readonly points: ReadonlyArray<[number, number]>,
    private readonly style: Style,
    private readonly tool: StrokeTool
  ) {
    super();
  }

  toolId(): StrokeTool {
    return this.tool;
  }

  draw(cr: Cairo.Context, _scale: number): void {
    if (this.points.length < 2) return;
    applyStrokeStyle(cr, this.style, Cairo.LineCap.ROUND, Cairo.LineJoin.ROUND);
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
    return new StrokeAction(moved, this.style, this.tool);
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const moved: Array<[number, number]> = this.points.map(([x, y]) =>
      rotatePoint(x, y, direction, oldW, oldH)
    );
    return new StrokeAction(moved, this.style, this.tool);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return new StrokeAction(this.points, {...this.style, color}, this.tool);
  }

  getWidth(): number {
    return this.style.width;
  }

  withWidth(width: number): Action {
    return new StrokeAction(this.points, {...this.style, width}, this.tool);
  }
}

class StrokeLiveStroke implements LiveStroke {
  private points: Array<[number, number]>;

  constructor(
    x: number,
    y: number,
    private readonly style: Style,
    private readonly tool: StrokeTool
  ) {
    this.points = [[x, y]];
  }

  extendTo(x: number, y: number, _constrain: boolean): void {
    this.points.push([x, y]);
  }

  finish(): Action | null {
    if (this.points.length < 2) return null;
    return new StrokeAction(this.points, this.style, this.tool);
  }

  draw(cr: Cairo.Context, scale: number): void {
    if (this.points.length < 2) return;
    new StrokeAction(this.points, this.style, this.tool).draw(cr, scale);
  }
}

// ---------- Two-endpoint shapes (line / arrow / rect / oval) ----------

// Shared base for the four shapes defined by two endpoint/corner coordinates
// plus a stroke Style. Subclasses supply draw() (the shape itself) and
// rebuild() (a clone with new coords/style, threading any subclass-specific
// state such as rect/oval fill); the AABB, translate, rotate, and the
// color/width/dash getters+withers all live here.
abstract class TwoEndpointAction extends BaseAction {
  constructor(
    protected readonly x1: number,
    protected readonly y1: number,
    protected readonly x2: number,
    protected readonly y2: number,
    protected readonly style: Style
  ) {
    super();
  }

  abstract draw(cr: Cairo.Context, scale: number): void;

  // Clone with new endpoints/style. Subclasses re-thread their own state
  // (e.g. fill) so the with*/translate/rotate paths below stay state-agnostic.
  protected abstract rebuild(x1: number, y1: number, x2: number, y2: number, style: Style): Action;

  // Padding around the endpoint AABB. Defaults to half the stroke width;
  // arrow widens it to keep the arrowhead hittable.
  protected boundsPad(): number {
    return this.style.width / 2;
  }

  getBounds(): Bounds {
    return endpointBounds(this.x1, this.y1, this.x2, this.y2, this.boundsPad());
  }

  translate(dx: number, dy: number): Action {
    return this.rebuild(this.x1 + dx, this.y1 + dy, this.x2 + dx, this.y2 + dy, this.style);
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [nx1, ny1] = rotatePoint(this.x1, this.y1, direction, oldW, oldH);
    const [nx2, ny2] = rotatePoint(this.x2, this.y2, direction, oldW, oldH);
    return this.rebuild(nx1, ny1, nx2, ny2, this.style);
  }

  getColor(): ColorRGBA {
    return this.style.color;
  }

  withColor(color: ColorRGBA): Action {
    return this.rebuild(this.x1, this.y1, this.x2, this.y2, {...this.style, color});
  }

  getWidth(): number {
    return this.style.width;
  }

  withWidth(width: number): Action {
    return this.rebuild(this.x1, this.y1, this.x2, this.y2, {...this.style, width});
  }

  getDash(): DashStyle {
    return this.style.dash;
  }

  withDash(dash: DashStyle): Action {
    return this.rebuild(this.x1, this.y1, this.x2, this.y2, {...this.style, dash});
  }

  // Default per-action resize for the two-endpoint shapes: a handle at each
  // endpoint, dragged freely (constrain is ignored — lines/arrows don't snap).
  // Rect/Oval override both with box handles.
  getResizeHandles(): ResizeHandle[] {
    return [
      {id: 'p1', x: this.x1, y: this.y1},
      {id: 'p2', x: this.x2, y: this.y2},
    ];
  }

  resizeByHandle(handle: HandleId, ix: number, iy: number, _constrain: boolean): Action {
    if (handle === 'p1') return this.rebuild(ix, iy, this.x2, this.y2, this.style);
    if (handle === 'p2') return this.rebuild(this.x1, this.y1, ix, iy, this.style);
    return this;
  }
}

// ---------- Line ----------

class LineAction extends TwoEndpointAction {
  draw(cr: Cairo.Context, _scale: number): void {
    applyStrokeStyle(cr, this.style, Cairo.LineCap.ROUND, Cairo.LineJoin.ROUND);
    cr.moveTo(this.x1, this.y1);
    cr.lineTo(this.x2, this.y2);
    cr.stroke();
  }

  protected rebuild(x1: number, y1: number, x2: number, y2: number, style: Style): Action {
    return new LineAction(x1, y1, x2, y2, style);
  }
}

// Shared base for the single-drag live strokes of the two-endpoint shapes.
// build() turns the current endpoints into the finished Action; the degenerate
// guard and the optional Shift-to-square (gated on `constrainable`) live here.
abstract class EndpointLiveStroke implements LiveStroke {
  protected endX: number;
  protected endY: number;

  constructor(
    protected readonly x1: number,
    protected readonly y1: number,
    protected readonly style: Style
  ) {
    this.endX = x1;
    this.endY = y1;
  }

  // Whether Shift snaps the drag to a square/circle. Rect/oval opt in.
  protected get constrainable(): boolean {
    return false;
  }

  protected abstract build(): Action;

  extendTo(x: number, y: number, constrain: boolean): void {
    [this.endX, this.endY] =
      constrain && this.constrainable ? constrainSquare(this.x1, this.y1, x, y) : [x, y];
  }

  finish(): Action | null {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return null;
    return this.build();
  }

  draw(cr: Cairo.Context, scale: number): void {
    if (isDegenerate(this.x1, this.y1, this.endX, this.endY)) return;
    this.build().draw(cr, scale);
  }
}

class LineLiveStroke extends EndpointLiveStroke {
  protected build(): Action {
    return new LineAction(this.x1, this.y1, this.endX, this.endY, this.style);
  }
}

// ---------- Arrow ----------

class ArrowAction extends TwoEndpointAction {
  constructor(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    style: Style,
    private readonly filledHead: boolean = false
  ) {
    super(x1, y1, x2, y2, style);
  }

  getFilledHead(): boolean {
    return this.filledHead;
  }

  withFilledHead(filled: boolean): Action {
    return new ArrowAction(this.x1, this.y1, this.x2, this.y2, this.style, filled);
  }

  // The two arrowhead arm tips. Both draw() and getBounds() need them, so the
  // geometry lives in one place. The arms run back from the tip (x2, y2) at
  // ±headAngle off the shaft direction.
  private arrowheadArms(): [[number, number], [number, number]] {
    const angle = Math.atan2(this.y2 - this.y1, this.x2 - this.x1);
    const headLen = this.style.width * 5;
    const headAngle = Math.PI / 6;
    return [
      [
        this.x2 - headLen * Math.cos(angle - headAngle),
        this.y2 - headLen * Math.sin(angle - headAngle),
      ],
      [
        this.x2 - headLen * Math.cos(angle + headAngle),
        this.y2 - headLen * Math.sin(angle + headAngle),
      ],
    ];
  }

  draw(cr: Cairo.Context, _scale: number): void {
    // Shaft honours the dash style; stroke it on its own.
    applyStrokeStyle(cr, this.style, Cairo.LineCap.ROUND, Cairo.LineJoin.ROUND);
    cr.moveTo(this.x1, this.y1);
    cr.lineTo(this.x2, this.y2);
    cr.stroke();

    // Arrowhead is always solid — a dashed head reads as broken. Clear any
    // dash the shaft set. Round cap + join give the open head its rounded tip
    // (the join where the arms meet) and rounded wing ends (the caps).
    cr.setDash([], 0);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    const [[ax1, ay1], [ax2, ay2]] = this.arrowheadArms();
    cr.moveTo(ax1, ay1);
    cr.lineTo(this.x2, this.y2);
    cr.lineTo(ax2, ay2);
    if (this.filledHead) {
      // Filled winged head: close the two arms into a triangle and fill it,
      // then stroke the outline so the round joins/caps round the tip and wing
      // ends to width/2 — matching the open head and the round-capped shaft.
      // The rounded apex coincides with the shaft's round cap at the tip, so no
      // nub shows past the point.
      cr.closePath();
      cr.fillPreserve();
      cr.stroke();
    } else {
      // Open winged head: two strokes meeting at the tip.
      cr.stroke();
    }
  }

  // Tight box around the actual ink: both endpoints plus the two arrowhead arm
  // tips, padded by half the stroke width for the round caps. Unlike a uniform
  // pad this leaves no dead space on the tail end or past the tip.
  getBounds(): Bounds {
    const [arm1, arm2] = this.arrowheadArms();
    const xs = [this.x1, this.x2, arm1[0], arm2[0]];
    const ys = [this.y1, this.y2, arm1[1], arm2[1]];
    const pad = this.style.width / 2;
    return {
      x1: Math.min(...xs) - pad,
      y1: Math.min(...ys) - pad,
      x2: Math.max(...xs) + pad,
      y2: Math.max(...ys) + pad,
    };
  }

  protected rebuild(x1: number, y1: number, x2: number, y2: number, style: Style): Action {
    return new ArrowAction(x1, y1, x2, y2, style, this.filledHead);
  }
}

class ArrowLiveStroke extends EndpointLiveStroke {
  constructor(
    x1: number,
    y1: number,
    style: Style,
    private readonly filledHead: boolean
  ) {
    super(x1, y1, style);
  }

  protected build(): Action {
    return new ArrowAction(this.x1, this.y1, this.endX, this.endY, this.style, this.filledHead);
  }
}

// ---------- Rectangle ----------

// Shared base for the two filled, freely-rotatable box shapes (rect / oval).
// Stored (x1,y1,x2,y2) is the UNROTATED box; it's drawn rotated by `rotation`
// radians about its center. All the rotation, fill, oriented-bounds, hit-test,
// and oriented-resize logic lives here; subclasses supply only their outline
// path (buildPath) and a constructor (make). Resize handles + the rotate gizmo
// coexist: handles ride the rotated box, resize works in the box's local frame.
abstract class RotatableBoxAction extends TwoEndpointAction {
  constructor(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    style: Style,
    protected readonly fill: ColorRGBA,
    protected readonly rotation: number,
    // Optional centered text inside the box. Defaults to none so existing
    // call sites (live strokes, plain placement) are unaffected.
    protected readonly text: ShapeText = EMPTY_SHAPE_TEXT
  ) {
    super(x1, y1, x2, y2, style);
  }

  // Build the outline path centered at the origin in the local frame, spanning
  // ±halfW × ±halfH. The base sets up the translate/rotate and the fill/stroke.
  protected abstract buildPath(cr: Cairo.Context, halfW: number, halfH: number): void;

  // Construct a new instance of the concrete type with all state.
  protected abstract make(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    style: Style,
    fill: ColorRGBA,
    rotation: number,
    text: ShapeText
  ): Action;

  private center(): [number, number] {
    return [(this.x1 + this.x2) / 2, (this.y1 + this.y2) / 2];
  }

  private halfExtents(): [number, number] {
    return [Math.abs(this.x2 - this.x1) / 2, Math.abs(this.y2 - this.y1) / 2];
  }

  draw(cr: Cairo.Context, _scale: number): void {
    const [cx, cy] = this.center();
    const [hW, hH] = this.halfExtents();
    if (hW <= 0 || hH <= 0) return;
    cr.save();
    cr.translate(cx, cy);
    if (this.rotation !== 0) cr.rotate(this.rotation);
    this.buildPath(cr, hW, hH);
    cr.restore();
    if (this.fill[3] > 0) {
      const [fr, fg, fb, fa] = this.fill;
      cr.setSourceRGBA(fr, fg, fb, fa);
      cr.fillPreserve();
    }
    applyStrokeStyle(cr, this.style, Cairo.LineCap.BUTT, Cairo.LineJoin.MITER);
    cr.stroke();
    this.drawText(cr, cx, cy, hW);
  }

  // Centered text inside the box (in the box's rotated frame): word-wrapped and
  // L/C/R-aligned within the inner width, vertically centered, no clip — so
  // overflow spills past the box (and ellipse corners) rather than resizing it.
  private drawText(cr: Cairo.Context, cx: number, cy: number, hW: number): void {
    const {markup, style} = this.text;
    if (!markup) return;
    const pad = shapeTextPadding(style.size);
    const innerW = Math.max(1, 2 * hW - 2 * pad);
    const layout = createMarkupLayout(cr, style.fontDesc, style.size, markup);
    layout.set_width(innerW * Pango.SCALE);
    layout.set_alignment(pangoAlignment(style.align));
    const [, textH] = layout.get_pixel_size();
    cr.save();
    cr.translate(cx, cy);
    if (this.rotation !== 0) cr.rotate(this.rotation);
    cr.translate(-innerW / 2, -textH / 2);
    const [r, g, b, a] = style.color;
    cr.setSourceRGBA(r, g, b, a);
    cr.moveTo(0, 0);
    PangoCairo.show_layout(cr, layout);
    cr.restore();
  }

  protected rebuild(x1: number, y1: number, x2: number, y2: number, style: Style): Action {
    return this.make(x1, y1, x2, y2, style, this.fill, this.rotation, this.text);
  }

  getBounds(): Bounds {
    const pad = this.boundsPad();
    if (this.rotation === 0) return endpointBounds(this.x1, this.y1, this.x2, this.y2, pad);
    const [cx, cy] = this.center();
    const minX = Math.min(this.x1, this.x2);
    const maxX = Math.max(this.x1, this.x2);
    const minY = Math.min(this.y1, this.y2);
    const maxY = Math.max(this.y1, this.y2);
    let bx1 = Infinity,
      by1 = Infinity,
      bx2 = -Infinity,
      by2 = -Infinity;
    for (const [px, py] of [
      [minX, minY],
      [maxX, minY],
      [maxX, maxY],
      [minX, maxY],
    ]) {
      const [rx, ry] = rotateAboutPoint(px, py, cx, cy, this.rotation);
      if (rx < bx1) bx1 = rx;
      if (rx > bx2) bx2 = rx;
      if (ry < by1) by1 = ry;
      if (ry > by2) by2 = ry;
    }
    return {x1: bx1 - pad, y1: by1 - pad, x2: bx2 + pad, y2: by2 + pad};
  }

  rotateOnImage(direction: RotateDirection, oldW: number, oldH: number): Action {
    const [cx, cy] = this.center();
    const [hW, hH] = this.halfExtents();
    const [ncx, ncy] = rotatePoint(cx, cy, direction, oldW, oldH);
    const dr = direction === 'cw' ? Math.PI / 2 : -Math.PI / 2;
    return this.make(
      ncx - hW,
      ncy - hH,
      ncx + hW,
      ncy + hH,
      this.style,
      this.fill,
      normalizeAngle(this.rotation + dr),
      this.text
    );
  }

  getFill(): ColorRGBA {
    return this.fill;
  }

  withFill(fill: ColorRGBA): Action {
    return this.make(
      this.x1,
      this.y1,
      this.x2,
      this.y2,
      this.style,
      fill,
      this.rotation,
      this.text
    );
  }

  getRotation(): number {
    return this.rotation;
  }

  withRotation(rotation: number): Action {
    return this.make(
      this.x1,
      this.y1,
      this.x2,
      this.y2,
      this.style,
      this.fill,
      normalizeAngle(rotation),
      this.text
    );
  }

  // ---- Embedded text ----

  // The current text markup ('' = none) and its style, for the editor + commit.
  getMarkup(): string {
    return this.text.markup;
  }

  getTextStyle(): TextStyle {
    return this.text.style;
  }

  // Set (or clear, with empty markup) the box's text. Used by the commit path.
  withText(markup: string, style: TextStyle): Action {
    return this.make(this.x1, this.y1, this.x2, this.y2, this.style, this.fill, this.rotation, {
      markup,
      style,
    });
  }

  // The text-style channels are exposed (non-null) ONLY when the box has text,
  // so the style bar shows Text color / Font / Size / Align for a shape-with-text
  // and hides them for an empty shape. getColor stays the outline color.
  getTextColor(): ColorRGBA | null {
    return this.text.markup ? this.text.style.color : null;
  }

  withTextColor(color: ColorRGBA): Action {
    return this.withText(this.text.markup, {...this.text.style, color});
  }

  getFontDesc(): string | null {
    return this.text.markup ? this.text.style.fontDesc : null;
  }

  withFontDesc(fontDesc: string): Action {
    return this.withText(this.text.markup, {...this.text.style, fontDesc});
  }

  getFontSize(): number | null {
    return this.text.markup ? this.text.style.size : null;
  }

  withFontSize(size: number): Action {
    return this.withText(this.text.markup, {...this.text.style, size});
  }

  getAlign(): TextAlign | null {
    return this.text.markup ? this.text.style.align : null;
  }

  withAlign(align: TextAlign): Action {
    return this.withText(this.text.markup, {...this.text.style, align});
  }

  getOrientedBounds(): OrientedBounds {
    const [cx, cy] = this.center();
    const [hW, hH] = this.halfExtents();
    return {cx, cy, halfW: hW, halfH: hH, angle: this.rotation};
  }

  // Hit-test against the (rotated) bounding rectangle: inverse-rotate the point
  // into the local frame and test the padded box. For rotation 0 this is exactly
  // the AABB test, so unrotated selection is unchanged; rotated, it's the tilted
  // box (not the loose AABB). The oval uses the same box as the rect — the
  // "precision" here is the orientation, not an exact ellipse boundary.
  containsPoint(ix: number, iy: number): boolean {
    const [cx, cy] = this.center();
    const [hW, hH] = this.halfExtents();
    const pad = this.boundsPad();
    const [lx, ly] = rotateAboutPoint(ix, iy, cx, cy, -this.rotation);
    return Math.abs(lx - cx) <= hW + pad && Math.abs(ly - cy) <= hH + pad;
  }

  getResizeHandles(): ResizeHandle[] {
    const local = boxResizeHandles(this.x1, this.y1, this.x2, this.y2);
    if (this.rotation === 0) return local;
    const [cx, cy] = this.center();
    return local.map((h) => {
      const [rx, ry] = rotateAboutPoint(h.x, h.y, cx, cy, this.rotation);
      return {id: h.id, x: rx, y: ry};
    });
  }

  resizeByHandle(handle: HandleId, ix: number, iy: number, constrain: boolean): Action {
    const [x1, y1, x2, y2] = resizeOrientedBox(
      this.x1,
      this.y1,
      this.x2,
      this.y2,
      this.rotation,
      handle,
      ix,
      iy,
      constrain
    );
    return this.make(x1, y1, x2, y2, this.style, this.fill, this.rotation, this.text);
  }
}

class RectAction extends RotatableBoxAction {
  constructor(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    style: Style,
    fill: ColorRGBA,
    rotation: number = 0,
    text: ShapeText = EMPTY_SHAPE_TEXT
  ) {
    super(x1, y1, x2, y2, style, fill, rotation, text);
  }

  protected buildPath(cr: Cairo.Context, halfW: number, halfH: number): void {
    cr.rectangle(-halfW, -halfH, 2 * halfW, 2 * halfH);
  }

  protected make(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    style: Style,
    fill: ColorRGBA,
    rotation: number,
    text: ShapeText
  ): Action {
    return new RectAction(x1, y1, x2, y2, style, fill, rotation, text);
  }
}

class RectLiveStroke extends EndpointLiveStroke {
  constructor(
    x1: number,
    y1: number,
    style: Style,
    private readonly fill: ColorRGBA
  ) {
    super(x1, y1, style);
  }

  protected get constrainable(): boolean {
    return true;
  }

  protected build(): Action {
    return new RectAction(this.x1, this.y1, this.endX, this.endY, this.style, this.fill);
  }
}

// ---------- Oval ----------

class OvalAction extends RotatableBoxAction {
  constructor(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    style: Style,
    fill: ColorRGBA,
    rotation: number = 0,
    text: ShapeText = EMPTY_SHAPE_TEXT
  ) {
    super(x1, y1, x2, y2, style, fill, rotation, text);
  }

  protected buildPath(cr: Cairo.Context, halfW: number, halfH: number): void {
    // Scale-and-arc trick: build the path under a scaled CTM, then restore so
    // the line width isn't scaled with the ellipse axes (stroking happens in the
    // base after the outer restore, in unscaled space).
    cr.save();
    cr.scale(halfW, halfH);
    cr.newSubPath();
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
  }

  protected make(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    style: Style,
    fill: ColorRGBA,
    rotation: number,
    text: ShapeText
  ): Action {
    return new OvalAction(x1, y1, x2, y2, style, fill, rotation, text);
  }
}

class OvalLiveStroke extends EndpointLiveStroke {
  constructor(
    x1: number,
    y1: number,
    style: Style,
    private readonly fill: ColorRGBA
  ) {
    super(x1, y1, style);
  }

  protected get constrainable(): boolean {
    return true;
  }

  protected build(): Action {
    return new OvalAction(this.x1, this.y1, this.endX, this.endY, this.style, this.fill);
  }
}

// Whether the action is a box shape (rect / oval) that can carry centered text.
export function isShapeAction(action: Action): boolean {
  return action instanceof RotatableBoxAction;
}

export interface ShapeTextEditState {
  markup: string; // '' when the shape has no text yet
  style: TextStyle; // the shape's current (or default) text style
  bounds: OrientedBounds; // box center/extents/angle, for positioning the editor
}

// Edit state for a box shape's text, or null for non-shapes. Used to open the
// box editor and seed its style.
export function getShapeTextEditState(action: Action): ShapeTextEditState | null {
  if (!(action instanceof RotatableBoxAction)) return null;
  return {
    markup: action.getMarkup(),
    style: action.getTextStyle(),
    bounds: action.getOrientedBounds(),
  };
}

// Apply (or clear, with empty markup) a box shape's text on commit; non-shapes
// pass through unchanged.
export function withShapeText(action: Action, markup: string, style: TextStyle): Action {
  if (!(action instanceof RotatableBoxAction)) return action;
  return action.withText(markup, style);
}

// A box shape with its text stripped (or the shape unchanged if it has none), or
// null for non-shapes. Lets the canvas keep the box drawn while its text is being
// edited — only the text is suppressed, not the whole shape.
export function shapeWithoutText(action: Action): Action | null {
  if (!(action instanceof RotatableBoxAction)) return null;
  return action.getMarkup() ? action.withText('', action.getTextStyle()) : action;
}

// Transparent default fill for rect/oval — outline-only on creation. The user
// can paint a real fill via the picker afterwards (or before, with the tool
// active).
export const TRANSPARENT_FILL: ColorRGBA = [0, 0, 0, 0];

export function createLiveStroke(
  toolId: ToolId,
  x: number,
  y: number,
  color: ColorRGBA,
  width: number,
  fill: ColorRGBA,
  dash: DashStyle,
  filledHead: boolean
): LiveStroke {
  switch (toolId) {
    case 'pen':
      return new StrokeLiveStroke(x, y, {...PEN_STYLE, color, width}, 'pen');
    case 'highlighter':
      return new StrokeLiveStroke(x, y, {...HIGHLIGHTER_STYLE, color, width}, 'highlighter');
    case 'line':
      return new LineLiveStroke(x, y, {...LINE_STYLE, color, width, dash});
    case 'arrow':
      return new ArrowLiveStroke(x, y, {...ARROW_STYLE, color, width, dash}, filledHead);
    case 'rect':
      return new RectLiveStroke(x, y, {...SHAPE_STYLE, color, width, dash}, fill);
    case 'oval':
      return new OvalLiveStroke(x, y, {...SHAPE_STYLE, color, width, dash}, fill);
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
// number stamp's fill is the dominant red; resize fills with transparent.
// Tools without a fill return null.
export function defaultFillForTool(toolId: ToolId): ColorRGBA | null {
  switch (toolId) {
    case 'rect':
    case 'oval':
      return TRANSPARENT_FILL;
    case 'number':
      return NUMBER_STAMP_STYLE.fillColor;
    case 'resize':
      return TRANSPARENT_FILL;
    case 'text':
      // The text "Fill" is the background plate; default transparent white.
      return TEXT_STYLE.bg;
    case 'pen':
    case 'highlighter':
    case 'line':
    case 'arrow':
    case 'select':
    default:
      return null;
  }
}

// Default per-tool dash style. Only the discrete-path stroke tools carry one;
// pen/highlighter (smooth multi-point strokes), text, number, select and
// resize return null and the dash dropdown hides accordingly.
export function defaultDashForTool(toolId: ToolId): DashStyle | null {
  switch (toolId) {
    case 'line':
    case 'arrow':
    case 'rect':
    case 'oval':
      return DEFAULT_DASH;
    case 'pen':
    case 'highlighter':
    case 'text':
    case 'number':
    case 'select':
    case 'resize':
    default:
      return null;
  }
}

// Default filled-arrowhead state. Only the arrow tool carries it; everything
// else returns null and the toggle hides accordingly. Arrows default to the
// open (stroked) arrowhead.
export function defaultFilledHeadForTool(toolId: ToolId): boolean | null {
  return toolId === 'arrow' ? false : null;
}

// The tool that produces an action of this type, so a select-mode style edit can
// be written back to the matching tool's default. StrokeAction carries its
// own pen/highlighter tag; the rest map by concrete class. Null for any action
// with no single originating tool (none today).
export function actionToolId(action: Action): ToolId | null {
  if (action instanceof StrokeAction) return action.toolId();
  if (action instanceof LineAction) return 'line';
  if (action instanceof ArrowAction) return 'arrow';
  if (action instanceof RectAction) return 'rect';
  if (action instanceof OvalAction) return 'oval';
  if (action instanceof TextAction) return 'text';
  if (action instanceof NumberStampAction) return 'number';
  return null;
}

// ---------- helpers ----------

// On/off dash lengths in image-space pixels, scaled to the line width so the
// pattern stays proportional at any stroke size. 'dotted' is a short square
// dash of length == width (rendered with butt caps, so it reads as a square
// dot rather than a round one); 'dashed' is a longer dash with a smaller gap.
// 'solid' returns an empty array (no dashing).
function dashPattern(dash: DashStyle, width: number): number[] {
  switch (dash) {
    case 'dotted':
      return [width, width];
    case 'dashed':
      return [width * 3, width * 2];
    case 'solid':
    default:
      return [];
  }
}

function applyStrokeStyle(cr: Cairo.Context, style: Style, cap: number, join: number): void {
  const [r, g, b, a] = style.color;
  cr.setSourceRGBA(r, g, b, a);
  cr.setLineWidth(style.width);
  cr.setLineJoin(join);
  // Dashed/dotted strokes force butt caps: a round cap extends each dash by
  // width/2 per end, which closes a width-length gap and turns dots into
  // pills. Solid strokes keep the caller's chosen cap. Always (re)set the dash
  // array so a dashed action earlier in the stack can't leak onto this one.
  const pattern = dashPattern(style.dash, style.width);
  if (pattern.length > 0) {
    cr.setLineCap(Cairo.LineCap.BUTT);
    cr.setDash(pattern, 0);
  } else {
    cr.setLineCap(cap);
    cr.setDash([], 0);
  }
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

// The 8 box handles (4 corners + 4 edge midpoints) of the normalized rectangle
// spanning (x1,y1)-(x2,y2), in image space. Corners lead so a corner wins over
// an overlapping edge band when the canvas hit-tests in order.
function boxResizeHandles(x1: number, y1: number, x2: number, y2: number): ResizeHandle[] {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  return [
    {id: 'tl', x: minX, y: minY},
    {id: 'tr', x: maxX, y: minY},
    {id: 'bl', x: minX, y: maxY},
    {id: 'br', x: maxX, y: maxY},
    {id: 't', x: mx, y: minY},
    {id: 'b', x: mx, y: maxY},
    {id: 'l', x: minX, y: my},
    {id: 'r', x: maxX, y: my},
  ];
}

// Resize the normalized box (x1,y1)-(x2,y2) by dragging `handle` to (ix, iy),
// returning the new normalized box. The opposite edge/corner stays anchored;
// every moved edge is clamped to SHAPE_MIN_EXTENT from its anchor so the box
// can't collapse or invert. With `constrain` (Shift) the result is squared: a
// corner squares against its anchor, while a side matches the perpendicular
// dimension to the dragged one, centered on the box's midpoint. Mirrors the
// canvas Resize tool's applyResizeGrab edge logic.
// eslint-disable-next-line complexity
function resizeBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  handle: HandleId,
  ix: number,
  iy: number,
  constrain: boolean
): [number, number, number, number] {
  let minX = Math.min(x1, x2);
  let maxX = Math.max(x1, x2);
  let minY = Math.min(y1, y2);
  let maxY = Math.max(y1, y2);

  const movedLeft = handle === 'l' || handle === 'tl' || handle === 'bl';
  const movedRight = handle === 'r' || handle === 'tr' || handle === 'br';
  const movedTop = handle === 't' || handle === 'tl' || handle === 'tr';
  const movedBottom = handle === 'b' || handle === 'bl' || handle === 'br';
  const movedX = movedLeft || movedRight;
  const movedY = movedTop || movedBottom;

  if (constrain && movedX && movedY) {
    // Corner + Shift → square against the anchored (opposite) corner, assigning
    // the squared corner to whichever two edges this handle drives.
    const ax = movedLeft ? maxX : minX;
    const ay = movedTop ? maxY : minY;
    const [sx, sy] = constrainSquare(ax, ay, ix, iy);
    if (movedLeft) minX = sx;
    else maxX = sx;
    if (movedTop) minY = sy;
    else maxY = sy;
  } else {
    if (movedLeft) minX = ix;
    if (movedRight) maxX = ix;
    if (movedTop) minY = iy;
    if (movedBottom) maxY = iy;
  }

  // Clamp each moved edge against its fixed opposite so the box keeps at least
  // SHAPE_MIN_EXTENT and never inverts. A handle never moves both x edges (or
  // both y edges), so these are independent.
  if (movedLeft) minX = Math.min(minX, maxX - SHAPE_MIN_EXTENT);
  if (movedRight) maxX = Math.max(maxX, minX + SHAPE_MIN_EXTENT);
  if (movedTop) minY = Math.min(minY, maxY - SHAPE_MIN_EXTENT);
  if (movedBottom) maxY = Math.max(maxY, minY + SHAPE_MIN_EXTENT);

  // Side + Shift → match the perpendicular dimension to the (clamped) dragged
  // one, centered on the box's current midpoint, so a single-axis drag still
  // yields a square/circle. `movedX !== movedY` is true only for a side (a
  // corner moves both axes and is handled above).
  if (constrain && movedX !== movedY) {
    if (movedX) {
      const w = maxX - minX;
      const cy = (minY + maxY) / 2;
      minY = cy - w / 2;
      maxY = cy + w / 2;
    } else {
      const h = maxY - minY;
      const cx = (minX + maxX) / 2;
      minX = cx - h / 2;
      maxX = cx + h / 2;
    }
  }

  return [minX, minY, maxX, maxY];
}

// Rotate (px, py) by `angle` radians (CW, screen y-down) about (cx, cy).
function rotateAboutPoint(
  px: number,
  py: number,
  cx: number,
  cy: number,
  angle: number
): [number, number] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = px - cx;
  const dy = py - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

// Resize a rotated box. The stored (x1,y1,x2,y2) is the box's UNROTATED extent;
// it's drawn rotated by `rotation` about its center. Dragging a handle resizes
// along the box's own (local) axes while the opposite edge/corner stays pinned
// in image space: inverse-rotate the cursor into the local frame, run the plain
// axis-aligned resizeBox there, then place the result so the invariant anchor
// point keeps its world position (the center shifts, the angle is unchanged).
// Returns the new unrotated box. rotation 0 is just resizeBox.
function resizeOrientedBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rotation: number,
  handle: HandleId,
  ix: number,
  iy: number,
  constrain: boolean
): [number, number, number, number] {
  if (rotation === 0) return resizeBox(x1, y1, x2, y2, handle, ix, iy, constrain);

  const oldMinX = Math.min(x1, x2);
  const oldMaxX = Math.max(x1, x2);
  const oldMinY = Math.min(y1, y2);
  const oldMaxY = Math.max(y1, y2);
  const ocx = (oldMinX + oldMaxX) / 2;
  const ocy = (oldMinY + oldMaxY) / 2;

  // Cursor into the local (unrotated) frame about the old center.
  const [lx, ly] = rotateAboutPoint(ix, iy, ocx, ocy, -rotation);
  const [nx1, ny1, nx2, ny2] = resizeBox(
    oldMinX,
    oldMinY,
    oldMaxX,
    oldMaxY,
    handle,
    lx,
    ly,
    constrain
  );
  const hW = (nx2 - nx1) / 2;
  const hH = (ny2 - ny1) / 2;
  const nLocalCx = (nx1 + nx2) / 2;
  const nLocalCy = (ny1 + ny2) / 2;

  // The point that resizeBox leaves invariant in local coords: the fixed x edge
  // (and y edge) for a corner, or the fixed edge + perpendicular center for a
  // side. Its world position must not move.
  const movedLeft = handle === 'l' || handle === 'tl' || handle === 'bl';
  const movedRight = handle === 'r' || handle === 'tr' || handle === 'br';
  const movedTop = handle === 't' || handle === 'tl' || handle === 'tr';
  const movedBottom = handle === 'b' || handle === 'bl' || handle === 'br';
  const ax = movedLeft || movedRight ? (movedLeft ? oldMaxX : oldMinX) : ocx;
  const ay = movedTop || movedBottom ? (movedTop ? oldMaxY : oldMinY) : ocy;

  // World position of that anchor (old center + rotation) stays fixed; solve for
  // the new center that re-rotating the resized box about it keeps the anchor there.
  const [wax, way] = rotateAboutPoint(ax, ay, ocx, ocy, rotation);
  const offx = ax - nLocalCx;
  const offy = ay - nLocalCy;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const ncx = wax - (offx * cos - offy * sin);
  const ncy = way - (offx * sin + offy * cos);

  return [ncx - hW, ncy - hH, ncx + hW, ncy + hH];
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
