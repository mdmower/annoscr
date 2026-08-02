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
  CurveOffset,
  TailOffset,
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
import {
  Chunk,
  buildContainer,
  findChunk,
  isContainer,
  readContainer,
} from './document_container.js';
import {fileTimestamp, renderToSurface, surfaceFitPngBytes, surfaceToPngBytes} from './exporter.js';
import {
  asClampedNumber,
  asColor,
  asDash,
  asNonEmptyString,
  asStampVariant,
  isRecord,
} from './validators.js';
import {loadFromBytes} from './image_loader.js';
import {APP_VERSION} from './version.js';

// The Annoscr annotation document: the source image plus the editable action
// stack, so a saved annotation can be reopened and edited rather than only
// flattened to PNG/JPEG. The embedded image is whatever the canvas currently
// holds — already cropped/rotated by any transform — so only the visible
// portion is stored.
//
// The file is a chunk container (document_container.ts): metadata, the
// composited preview, the source image, and the action stack, each its own
// length-prefixed payload — so a reader after one payload reads only that one,
// and images are stored as PNG bytes rather than base64 a third larger. Older
// documents are JSON envelopes; they still open (parseLegacyDocument) but are
// never written again.

// Canonical extension + dialog glob for annotation files.
export const DOC_EXTENSION = '.annoscr';
export const DOC_PATTERN = '*.annoscr';

// Whether a file is an annotation document, by extension - the same
// classification the file manager and CLI rely on. Takes a bare name or a whole
// path, and reads neither, so it costs no I/O and works on a file that isn't
// there.
export function isDocumentName(name: string): boolean {
  return name.toLowerCase().endsWith(DOC_EXTENSION);
}

const DOC_FORMAT = 'annoscr-document';

// What the chunks MEAN. Bump when an existing field changes meaning; a reader
// rejects versions it doesn't recognize. Adding a chunk or an optional field is
// additive (readers skip what they don't know) and bumps nothing. How the chunks
// are FRAMED is versioned separately, inside the container.
const DOC_SCHEMA_VERSION = 1;

// Chunk tags. META and ACTS hold JSON text; THMB and IMGE hold PNG bytes.
const TAG_META = 'META';
export const TAG_THUMBNAIL = 'THMB';
export const TAG_IMAGE = 'IMGE';
const TAG_ACTIONS = 'ACTS';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Thrown by parseDocument for any malformed or unsupported file. The caller
// shows a generic user-facing toast and logs this message (diagnostic English,
// not surfaced verbatim), so it isn't translated.
export class DocumentError extends Error {}

// Longest edges of the stored preview: four times the recent-files strip's
// display size, leaving pixels to spare on a HiDPI display or in a taller strip.
// Costs a couple of percent on a document embedding a full-resolution image.
const THUMB_MAX_W = 768;
const THUMB_MAX_H = 432;

// Default name for a newly saved annotation file, e.g.
// Annoscr-2026-05-22-143015.annoscr.
export function defaultDocFilename(): string {
  return `Annoscr-${fileTimestamp()}${DOC_EXTENSION}`;
}

function pngChunk(tag: string, encoded: GLib.Bytes): Chunk {
  const data = encoded.get_data();
  if (!data) throw new DocumentError(`Image encoding produced no bytes for chunk ${tag}`);
  return {tag, data};
}

function jsonChunk(tag: string, value: unknown): Chunk {
  return {tag, data: encoder.encode(JSON.stringify(value))};
}

export function serializeDocument(
  surface: Cairo.ImageSurface,
  actions: ReadonlyArray<Action>
): Uint8Array {
  return buildContainer([
    jsonChunk(TAG_META, {
      format: DOC_FORMAT,
      version: DOC_SCHEMA_VERSION,
      appVersion: APP_VERSION,
    }),
    // Composited, not the bare source: a document built on a blank fill would
    // otherwise preview as a featureless rectangle. Kept ahead of the
    // full-resolution image so a start-to-end reader still reaches it early.
    pngChunk(
      TAG_THUMBNAIL,
      surfaceFitPngBytes(renderToSurface(surface, actions), THUMB_MAX_W, THUMB_MAX_H)
    ),
    pngChunk(TAG_IMAGE, surfaceToPngBytes(surface)),
    jsonChunk(TAG_ACTIONS, serializeActions(actions)),
  ]);
}

// ---------- Per-field validation of loaded actions ----------
// The action stack is JSON, so it can arrive hand-edited or corrupted: every
// field is validated on load, the same way settings.ts treats settings.json. A
// malformed STYLE field — color, width, dash, fill, font, rotation, … — falls
// back to that action type's default rather than rejecting the document.
// STRUCTURAL fields with no sensible default — the type tag, geometry, a
// text's content — throw DocumentError and reject the file.

function asAlign(v: unknown): TextAlign | undefined {
  return v === 'left' || v === 'center' || v === 'right' ? v : undefined;
}

// Free-rotation angle in radians; deserializeAction normalizes the range, so
// only finiteness matters here.
function asAngle(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
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
    dash: asDash(raw.dash) ?? DEFAULT_DASH,
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
      fontDesc: asNonEmptyString(style.fontDesc) ?? SHAPE_TEXT_STYLE.fontDesc,
      bg: asColor(style.bg) ?? SHAPE_TEXT_STYLE.bg,
      align: asAlign(style.align) ?? SHAPE_TEXT_STYLE.align,
    },
  };
}

// A box shape's callout tail is decoration on the shape, like its text:
// malformed input drops to "no tail" rather than rejecting the shape.
function sanitizeTail(v: unknown): TailOffset | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.dx !== 'number' || !Number.isFinite(v.dx)) return undefined;
  if (typeof v.dy !== 'number' || !Number.isFinite(v.dy)) return undefined;
  return {dx: v.dx, dy: v.dy};
}

// A segment's bend is shape decoration like the callout tail: malformed input
// drops to a straight line rather than rejecting the annotation.
function sanitizeCurve(v: unknown): CurveOffset | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.along !== 'number' || !Number.isFinite(v.along)) return undefined;
  if (typeof v.perp !== 'number' || !Number.isFinite(v.perp)) return undefined;
  return {along: v.along, perp: v.perp};
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
    fontDesc: asNonEmptyString(raw.fontDesc) ?? TEXT_STYLE.fontDesc,
    bg: asColor(raw.bg) ?? TEXT_STYLE.bg,
    align: asAlign(raw.align) ?? TEXT_STYLE.align,
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
  const variant = asStampVariant(raw.variant) ?? DEFAULT_STAMP_VARIANT;
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
    fontDesc: asNonEmptyString(raw.fontDesc) ?? defaults.fontDesc,
    fontSize: asClampedNumber(raw.fontSize, 1, 4 * radius) ?? defaults.fontSize,
  };
}

// Line and arrow share the endpoint fields and the optional bend; only the
// arrowhead flag sets them apart.
function sanitizeSegment(raw: Record<string, unknown>, type: 'line' | 'arrow'): SerializedAction {
  const curve = sanitizeCurve(raw.curve);
  const base = {...sanitizeEndpoints(raw, type), ...(curve ? {curve} : {})};
  return type === 'arrow' ? {type, ...base, filledHead: raw.filledHead === true} : {type, ...base};
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
    case 'arrow':
      return sanitizeSegment(raw, type);
    case 'rect': {
      const text = sanitizeShapeText(raw.text);
      const tail = sanitizeTail(raw.tail);
      return {
        type,
        ...sanitizeEndpoints(raw, type),
        fill: asColor(raw.fill) ?? TRANSPARENT_FILL,
        rotation: asAngle(raw.rotation),
        cornerRadius: asClampedNumber(raw.cornerRadius, CORNER_RADIUS_MIN, CORNER_RADIUS_MAX) ?? 0,
        ...(text ? {text} : {}),
        ...(tail ? {tail} : {}),
      };
    }
    case 'oval': {
      const text = sanitizeShapeText(raw.text);
      const tail = sanitizeTail(raw.tail);
      return {
        type,
        ...sanitizeEndpoints(raw, type),
        fill: asColor(raw.fill) ?? TRANSPARENT_FILL,
        rotation: asAngle(raw.rotation),
        ...(text ? {text} : {}),
        ...(tail ? {tail} : {}),
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

function decodeImage(bytes: Uint8Array): Cairo.ImageSurface {
  try {
    return loadFromBytes(bytes);
  } catch (e) {
    throw new DocumentError(`Could not decode the annotation file image: ${String(e)}`);
  }
}

function buildActions(raw: unknown): Action[] {
  try {
    return deserializeActions(sanitizeSerializedActions(raw));
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    // e.g. Pango rejecting a text's markup at layout time.
    throw new DocumentError(`Could not read the annotations: ${String(e)}`);
  }
}

export function parseDocument(bytes: Uint8Array): ParsedDocument {
  return isContainer(bytes) ? parseContainerDocument(bytes) : parseLegacyDocument(bytes);
}

function checkMeta(data: Uint8Array | null): void {
  if (!data) throw new DocumentError('Annotation file has no metadata');
  let meta: unknown;
  try {
    meta = JSON.parse(decoder.decode(data));
  } catch {
    throw new DocumentError('Annotation file has malformed metadata');
  }
  if (!isRecord(meta) || meta.format !== DOC_FORMAT) {
    throw new DocumentError('Not an Annoscr annotation file');
  }
  if (meta.version !== DOC_SCHEMA_VERSION) {
    throw new DocumentError(`Unsupported annotation file version: ${JSON.stringify(meta.version)}`);
  }
}

function parseContainerDocument(bytes: Uint8Array): ParsedDocument {
  let chunks: Chunk[];
  try {
    chunks = readContainer(bytes);
  } catch (e) {
    throw new DocumentError(`Annotation file is not readable: ${String(e)}`);
  }
  checkMeta(findChunk(chunks, TAG_META));

  const image = findChunk(chunks, TAG_IMAGE);
  if (!image) throw new DocumentError('Annotation file is missing its embedded image');

  // A document with no annotations carries no action chunk.
  const actionsChunk = findChunk(chunks, TAG_ACTIONS);
  let raw: unknown = [];
  if (actionsChunk) {
    try {
      raw = JSON.parse(decoder.decode(actionsChunk));
    } catch {
      throw new DocumentError('Annotation list is malformed');
    }
  }
  return {surface: decodeImage(image), actions: buildActions(raw)};
}

// ---------- Documents written before the container ----------
// A JSON envelope holding the image as base64. Frozen: nothing writes this
// shape any more and the reader goes away in 2.0, so its version constant is
// separate from DOC_SCHEMA_VERSION and never moves.

const LEGACY_JSON_VERSION = 1;

interface DocumentEnvelope {
  format: string;
  version: number;
  appVersion?: string;
  image: {encoding: string; data: string};
  // Untrusted until sanitizeSerializedActions validates each entry.
  actions?: unknown;
}

function parseLegacyDocument(bytes: Uint8Array): ParsedDocument {
  let env: DocumentEnvelope;
  try {
    env = JSON.parse(decoder.decode(bytes)) as DocumentEnvelope;
  } catch {
    throw new DocumentError('Not a valid annotation file (invalid JSON)');
  }
  if (!env || typeof env !== 'object' || env.format !== DOC_FORMAT) {
    throw new DocumentError('Not an Annoscr annotation file');
  }
  if (env.version !== LEGACY_JSON_VERSION) {
    throw new DocumentError(`Unsupported annotation file version: ${String(env.version)}`);
  }
  if (!env.image || env.image.encoding !== 'png-base64' || typeof env.image.data !== 'string') {
    throw new DocumentError('Annotation file is missing its embedded image');
  }
  return {
    surface: decodeImage(GLib.base64_decode(env.image.data)),
    actions: buildActions(env.actions),
  };
}
