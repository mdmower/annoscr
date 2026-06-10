import GLib from 'gi://GLib?version=2.0';
import Cairo from 'cairo';

import {
  Action,
  ColorRGBA,
  CORNER_RADIUS_MAX,
  CORNER_RADIUS_MIN,
  DashStyle,
  DEFAULT_DASH,
  DEFAULT_STAMP_RADIUS,
  DEFAULT_STAMP_VARIANT,
  EditorSize,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SHAPE_TEXT_STYLE,
  STAMP_RADIUS_MAX,
  STAMP_RADIUS_MIN,
  SerializedAction,
  SerializedShapeText,
  StampVariant,
  TEXT_STYLE,
  TRANSPARENT_FILL,
  TextAlign,
  WIDTH_MAX,
  WIDTH_MIN,
  defaultColorForTool,
  defaultFillForTool,
  defaultWidthForTool,
  deserializeActions,
  numberStampStyle,
  serializeActions,
} from './actions.js';
import {fileTimestamp, surfaceToPngBytes} from './exporter.js';
import {asClampedNumber, asColor, isRecord} from './validators.js';
import {loadFromBytes} from './image_loader.js';
import {APP_VERSION} from './version.js';

// The Annoscr annotation document: a self-contained JSON envelope holding the
// source image (base64-encoded PNG) plus the editable action stack, so a saved
// annotation can be reopened and edited rather than only flattened to PNG/JPEG.
// The embedded image is whatever the canvas currently holds — already cropped/
// rotated by any transform — so only the visible portion is stored.

// Canonical extension + dialog glob for annotation files.
export const DOC_EXTENSION = '.annoscr';
export const DOC_PATTERN = '*.annoscr';

const DOC_FORMAT = 'annoscr-document';
// Bump when the envelope or a serialized action shape changes incompatibly; a
// reader rejects versions it doesn't recognize (see parseDocument).
const DOC_VERSION = 1;

// Thrown by parseDocument for any malformed or unsupported file. The caller
// shows a generic user-facing toast and logs this message (diagnostic English,
// not surfaced verbatim), so it isn't translated.
export class DocumentError extends Error {}

interface DocumentEnvelope {
  format: string;
  version: number;
  appVersion?: string;
  image: {encoding: string; data: string};
  // Untrusted until sanitizeSerializedActions validates each entry.
  actions?: unknown;
}

// Default name for a newly saved annotation file, e.g.
// Annoscr-2026-05-22-143015.annoscr.
export function defaultDocFilename(): string {
  return `Annoscr-${fileTimestamp()}${DOC_EXTENSION}`;
}

export function serializeDocument(
  surface: Cairo.ImageSurface,
  actions: ReadonlyArray<Action>
): string {
  const envelope: DocumentEnvelope = {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    appVersion: APP_VERSION,
    image: {
      encoding: 'png-base64',
      data: GLib.base64_encode(surfaceToPngBytes(surface).get_data()),
    },
    actions: serializeActions(actions),
  };
  return JSON.stringify(envelope, null, 2);
}

// ---------- Per-field validation of loaded actions ----------
// A .annoscr file is plain JSON the user can hand-edit, so every action field
// is validated on load, the same way settings.ts treats settings.json. A
// malformed STYLE field — color, width, dash, fill, font, rotation, … — falls
// back to that action type's default rather than rejecting the document.
// STRUCTURAL fields with no sensible default — the type tag, geometry, a
// text's content — throw DocumentError and reject the file.

function asDash(v: unknown): DashStyle {
  return v === 'solid' || v === 'dashed' || v === 'dotted' ? v : DEFAULT_DASH;
}

function asAlign(v: unknown, fallback: TextAlign): TextAlign {
  return v === 'left' || v === 'center' || v === 'right' ? v : fallback;
}

// Free-rotation angle in radians; deserializeAction normalizes the range, so
// only finiteness matters here.
function asAngle(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asNonEmptyString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

// A required coordinate: geometry has no fallback, so a malformed value
// rejects the document.
function requireFinite(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new DocumentError(`Annotation has a malformed ${what}`);
  }
  return v;
}

// A stroke's geometry is its point list; anything short of two finite pairs
// can't be drawn (and would produce infinite bounds), so it's structural.
function requirePoints(v: unknown): Array<[number, number]> {
  if (!Array.isArray(v)) throw new DocumentError('Stroke annotation has no point list');
  const pts: Array<[number, number]> = [];
  for (const p of v) {
    if (
      !Array.isArray(p) ||
      typeof p[0] !== 'number' ||
      !Number.isFinite(p[0]) ||
      typeof p[1] !== 'number' ||
      !Number.isFinite(p[1])
    ) {
      throw new DocumentError('Stroke annotation has a malformed point');
    }
    pts.push([p[0], p[1]]);
  }
  if (pts.length < 2) throw new DocumentError('Stroke annotation has fewer than two points');
  return pts;
}

// The endpoint + stroke fields shared by line/arrow/rect/oval.
interface SanitizedEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: ColorRGBA;
  width: number;
  dash: DashStyle;
}

function sanitizeEndpoints(
  raw: Record<string, unknown>,
  tool: 'line' | 'arrow' | 'rect' | 'oval'
): SanitizedEndpoints {
  return {
    x1: requireFinite(raw.x1, 'coordinate'),
    y1: requireFinite(raw.y1, 'coordinate'),
    x2: requireFinite(raw.x2, 'coordinate'),
    y2: requireFinite(raw.y2, 'coordinate'),
    color: asColor(raw.color) ?? defaultColorForTool(tool),
    width:
      asClampedNumber(raw.width, WIDTH_MIN, WIDTH_MAX) ?? defaultWidthForTool(tool) ?? WIDTH_MIN,
    dash: asDash(raw.dash),
  };
}

// A box shape's embedded text is decoration on the shape: malformed text (or a
// malformed markup field) drops to "no text" rather than rejecting the shape.
function sanitizeShapeText(v: unknown): SerializedShapeText | undefined {
  if (!isRecord(v) || typeof v.markup !== 'string' || v.markup.length === 0) return undefined;
  const style = isRecord(v.style) ? v.style : {};
  return {
    markup: v.markup,
    style: {
      color: asColor(style.color) ?? SHAPE_TEXT_STYLE.color,
      size: asClampedNumber(style.size, FONT_SIZE_MIN, FONT_SIZE_MAX) ?? SHAPE_TEXT_STYLE.size,
      fontDesc: asNonEmptyString(style.fontDesc, SHAPE_TEXT_STYLE.fontDesc),
      bg: asColor(style.bg) ?? SHAPE_TEXT_STYLE.bg,
      align: asAlign(style.align, SHAPE_TEXT_STYLE.align),
    },
  };
}

// Pure-UX re-edit frame size; anything malformed just drops the field.
function sanitizeEditorSize(v: unknown): EditorSize | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.width !== 'number' || !Number.isFinite(v.width)) return undefined;
  if (typeof v.height !== 'number' || !Number.isFinite(v.height)) return undefined;
  return {width: v.width, height: v.height};
}

function sanitizeText(raw: Record<string, unknown>): SerializedAction {
  // The markup IS the annotation's content — nothing to fall back to.
  if (typeof raw.markup !== 'string') {
    throw new DocumentError('Text annotation has no content');
  }
  const editorSize = sanitizeEditorSize(raw.editorSize);
  return {
    type: 'text',
    x: requireFinite(raw.x, 'position'),
    y: requireFinite(raw.y, 'position'),
    markup: raw.markup,
    rotation: asAngle(raw.rotation),
    color: asColor(raw.color) ?? TEXT_STYLE.color,
    size: asClampedNumber(raw.size, FONT_SIZE_MIN, FONT_SIZE_MAX) ?? TEXT_STYLE.size,
    fontDesc: asNonEmptyString(raw.fontDesc, TEXT_STYLE.fontDesc),
    bg: asColor(raw.bg) ?? TEXT_STYLE.bg,
    align: asAlign(raw.align, TEXT_STYLE.align),
    ...(editorSize ? {editorSize} : {}),
  };
}

function sanitizeNumber(raw: Record<string, unknown>): SerializedAction {
  const foregroundColor = asColor(raw.foregroundColor) ?? defaultColorForTool('number');
  const fillColor = asColor(raw.fillColor) ?? defaultFillForTool('number') ?? foregroundColor;
  const radius =
    asClampedNumber(raw.radius, STAMP_RADIUS_MIN, STAMP_RADIUS_MAX) ?? DEFAULT_STAMP_RADIUS;
  // Defaults for the radius-scaled fields (border width, digit size), built
  // proportional to the validated radius.
  const defaults = numberStampStyle(foregroundColor, fillColor, radius);
  const variant: StampVariant =
    raw.variant === 'number' || raw.variant === 'letter' ? raw.variant : DEFAULT_STAMP_VARIANT;
  // A bad group id folds into group 1; renumbering keeps the numbers gap-free.
  const groupId =
    typeof raw.groupId === 'number' && Number.isInteger(raw.groupId) && raw.groupId >= 1
      ? raw.groupId
      : 1;
  return {
    type: 'number',
    x: requireFinite(raw.x, 'position'),
    y: requireFinite(raw.y, 'position'),
    groupId,
    variant,
    rotation: asAngle(raw.rotation),
    radius,
    fillColor,
    foregroundColor,
    // Bounds are sanity caps, not style limits: a border thicker than the
    // radius or a digit taller than the disc is junk input.
    borderWidth: asClampedNumber(raw.borderWidth, 0, radius) ?? defaults.borderWidth,
    fontDesc: asNonEmptyString(raw.fontDesc, defaults.fontDesc),
    fontSize: asClampedNumber(raw.fontSize, 1, 4 * radius) ?? defaults.fontSize,
  };
}

function sanitizeAction(raw: unknown): SerializedAction {
  if (!isRecord(raw)) throw new DocumentError('Annotation entry is not an object');
  const type = raw.type;
  switch (type) {
    case 'pen':
    case 'highlighter':
      return {
        type,
        points: requirePoints(raw.points),
        color: asColor(raw.color) ?? defaultColorForTool(type),
        width:
          asClampedNumber(raw.width, WIDTH_MIN, WIDTH_MAX) ??
          defaultWidthForTool(type) ??
          WIDTH_MIN,
      };
    case 'line':
      return {type, ...sanitizeEndpoints(raw, type)};
    case 'arrow':
      return {type, ...sanitizeEndpoints(raw, type), filledHead: raw.filledHead === true};
    case 'rect': {
      const text = sanitizeShapeText(raw.text);
      return {
        type,
        ...sanitizeEndpoints(raw, type),
        fill: asColor(raw.fill) ?? TRANSPARENT_FILL,
        rotation: asAngle(raw.rotation),
        cornerRadius: asClampedNumber(raw.cornerRadius, CORNER_RADIUS_MIN, CORNER_RADIUS_MAX) ?? 0,
        ...(text ? {text} : {}),
      };
    }
    case 'oval': {
      const text = sanitizeShapeText(raw.text);
      return {
        type,
        ...sanitizeEndpoints(raw, type),
        fill: asColor(raw.fill) ?? TRANSPARENT_FILL,
        rotation: asAngle(raw.rotation),
        ...(text ? {text} : {}),
      };
    }
    case 'text':
      return sanitizeText(raw);
    case 'number':
      return sanitizeNumber(raw);
    default:
      throw new DocumentError(`Unknown annotation type: ${JSON.stringify(type)}`);
  }
}

function sanitizeSerializedActions(raw: unknown): SerializedAction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new DocumentError('Annotation list is malformed');
  return raw.map(sanitizeAction);
}

export interface ParsedDocument {
  surface: Cairo.ImageSurface;
  actions: Action[];
}

export function parseDocument(text: string): ParsedDocument {
  let env: DocumentEnvelope;
  try {
    env = JSON.parse(text) as DocumentEnvelope;
  } catch {
    throw new DocumentError('Not a valid annotation file (invalid JSON)');
  }
  if (!env || typeof env !== 'object' || env.format !== DOC_FORMAT) {
    throw new DocumentError('Not an Annoscr annotation file');
  }
  if (env.version !== DOC_VERSION) {
    throw new DocumentError(`Unsupported annotation file version: ${String(env.version)}`);
  }
  if (!env.image || env.image.encoding !== 'png-base64' || typeof env.image.data !== 'string') {
    throw new DocumentError('Annotation file is missing its embedded image');
  }
  let surface: Cairo.ImageSurface;
  try {
    surface = loadFromBytes(GLib.base64_decode(env.image.data));
  } catch (e) {
    throw new DocumentError(`Could not decode the annotation file image: ${String(e)}`);
  }
  let actions: Action[];
  try {
    actions = deserializeActions(sanitizeSerializedActions(env.actions));
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    // e.g. Pango rejecting a text's markup at layout time.
    throw new DocumentError(`Could not read the annotations: ${String(e)}`);
  }
  return {surface, actions};
}
