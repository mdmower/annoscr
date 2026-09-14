import GLib from 'gi://GLib?version=2.0';
import Cairo from 'cairo';

import {
  Action,
  ColorRGBA,
  DashStyle,
  DEFAULT_DASH,
  DEFAULT_STAMP_RADIUS,
  DEFAULT_STAMP_VARIANT,
  EditorSize,
  ImageAsset,
  SHAPE_TEXT_STYLE,
  SerializedAction,
  SerializedShapeText,
  CurveOffset,
  TailOffset,
  TEXT_STYLE,
  TRANSPARENT_FILL,
  TextAlign,
  STORED_SIZE_MAX,
  STORED_SIZE_MIN,
  WIDTH_MIN,
  actionAssets,
  defaultColorForTool,
  defaultFillForTool,
  defaultWidthForTool,
  deserializeActions,
  numberStampStyle,
  serializeActions,
} from './actions.js';
import {Chunk, buildContainer, findChunk, readContainer} from './document_container.js';
import {
  fileTimestamp,
  renderToSurface,
  surfaceFitPngBytes,
  surfaceToPngBytesAsync,
} from './exporter.js';
import {
  asClampedNumber,
  asColor,
  asDash,
  asNonEmptyString,
  asStampVariant,
  isRecord,
} from './validators.js';
import {assetFromPng, loadFromBytes} from './image_loader.js';
import {APP_VERSION} from './version.js';

// The Annoscr annotation document: the source image plus the editable action
// stack, so a saved annotation can be reopened and edited rather than only
// flattened to PNG/JPEG. The embedded image is whatever the canvas currently
// holds — already cropped/rotated by any transform — so only the visible
// portion is stored.
//
// The file is a chunk container (document_container.ts): metadata, the
// composited preview, the source image, the action stack, and each image
// item's pixels, each its own length-prefixed payload — so a reader that needs one payload reads only that
// one, and images are stored as PNG bytes rather than base64 a third larger.

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
// rejects versions newer than it knows. Adding a chunk or an optional field is
// additive (readers skip what they don't know) and bumps nothing. How the
// chunks are FRAMED is versioned separately, inside the container.
// 2: image items, which version 1 readers can't skip (an unknown action type
// rejects the file). Version 1 documents are read unchanged.
const DOC_SCHEMA_VERSION = 2;

// Chunk tags. META and ACTS hold JSON text; THMB and IMGE hold PNG bytes. IMGA
// (repeated, one per distinct image) holds an image item's asset: its id as
// ASSET_ID_LENGTH ASCII hex characters, then the PNG bytes, so the id can be
// read without decoding the image.
const TAG_META = 'META';
export const TAG_THUMBNAIL = 'THMB';
export const TAG_IMAGE = 'IMGE';
const TAG_ACTIONS = 'ACTS';
const TAG_ASSET = 'IMGA';

// A SHA-256 in lowercase hex.
const ASSET_ID_LENGTH = 64;
const ASSET_ID_PATTERN = /^[0-9a-f]{64}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Thrown by parseDocument for any malformed or unsupported file. The caller
// shows a generic user-facing toast and logs this message (diagnostic English,
// not shown to the user verbatim), so it isn't translated.
export class DocumentError extends Error {}

// Longest edges of the stored preview: four times the recent-files strip's
// display size, leaving extra pixels for a HiDPI display or a taller strip.
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

export async function serializeDocument(
  surface: Cairo.ImageSurface,
  actions: ReadonlyArray<Action>
): Promise<Uint8Array> {
  const image = await surfaceToPngBytesAsync(surface);
  return buildContainer([
    jsonChunk(TAG_META, {
      format: DOC_FORMAT,
      version: DOC_SCHEMA_VERSION,
      appVersion: APP_VERSION,
    }),
    // Composited, not the bare source: a document built on a blank fill would
    // otherwise preview as a featureless rectangle. Kept ahead of the
    // full-resolution image so a sequential reader still reaches it early.
    pngChunk(
      TAG_THUMBNAIL,
      surfaceFitPngBytes(renderToSurface(surface, actions), THUMB_MAX_W, THUMB_MAX_H)
    ),
    pngChunk(TAG_IMAGE, image),
    jsonChunk(TAG_ACTIONS, serializeActions(actions)),
    // After the actions, so a reader of any earlier chunk skips the item
    // images.
    ...actionAssets(actions).map(assetChunk),
  ]);
}

function assetChunk(asset: ImageAsset): Chunk {
  const data = new Uint8Array(ASSET_ID_LENGTH + asset.png.length);
  data.set(encoder.encode(asset.id), 0);
  data.set(asset.png, ASSET_ID_LENGTH);
  return {tag: TAG_ASSET, data};
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
      asClampedNumber(raw.width, STORED_SIZE_MIN, STORED_SIZE_MAX) ??
      defaultWidthForTool(tool) ??
      WIDTH_MIN,
    dash: asDash(raw.dash) ?? DEFAULT_DASH,
  };
}

// A box shape's embedded text is optional content on the shape: malformed text
// (or a malformed markup field) drops to "no text" rather than rejecting the
// shape.
function sanitizeShapeText(v: unknown): SerializedShapeText | undefined {
  if (!isRecord(v) || typeof v.markup !== 'string' || v.markup.length === 0) return undefined;
  const style = isRecord(v.style) ? v.style : {};
  return {
    markup: v.markup,
    style: {
      color: asColor(style.color) ?? SHAPE_TEXT_STYLE.color,
      size: asClampedNumber(style.size, STORED_SIZE_MIN, STORED_SIZE_MAX) ?? SHAPE_TEXT_STYLE.size,
      fontDesc: asNonEmptyString(style.fontDesc) ?? SHAPE_TEXT_STYLE.fontDesc,
      bg: asColor(style.bg) ?? SHAPE_TEXT_STYLE.bg,
      align: asAlign(style.align) ?? SHAPE_TEXT_STYLE.align,
    },
  };
}

// A box shape's callout tail is optional content on the shape, like its text:
// malformed input drops to "no tail" rather than rejecting the shape.
function sanitizeTail(v: unknown): TailOffset | undefined {
  if (!isRecord(v)) return undefined;
  if (typeof v.dx !== 'number' || !Number.isFinite(v.dx)) return undefined;
  if (typeof v.dy !== 'number' || !Number.isFinite(v.dy)) return undefined;
  return {dx: v.dx, dy: v.dy};
}

// A segment's bend is optional content like the callout tail: malformed input
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
    size: asClampedNumber(raw.size, STORED_SIZE_MIN, STORED_SIZE_MAX) ?? TEXT_STYLE.size,
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
    asClampedNumber(raw.radius, STORED_SIZE_MIN, STORED_SIZE_MAX) ?? DEFAULT_STAMP_RADIUS;
  // Defaults for the radius-scaled fields (border width, digit size), built
  // proportional to the validated radius.
  const defaults = numberStampStyle(foregroundColor, fillColor, radius);
  const variant = asStampVariant(raw.variant) ?? DEFAULT_STAMP_VARIANT;
  // A bad group id is replaced by group 1; renumbering keeps the numbers
  // gap-free.
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
    // Bounds are validity caps, not style limits: a border thicker than the
    // radius or a digit taller than the disc is malformed input.
    borderWidth: asClampedNumber(raw.borderWidth, 0, radius) ?? defaults.borderWidth,
    fontDesc: asNonEmptyString(raw.fontDesc) ?? defaults.fontDesc,
    fontSize: asClampedNumber(raw.fontSize, 1, 4 * radius) ?? defaults.fontSize,
  };
}

// Line and arrow share the endpoint fields and the optional bend; only the
// arrowhead flag differs.
function sanitizeSegment(raw: Record<string, unknown>, type: 'line' | 'arrow'): SerializedAction {
  const curve = sanitizeCurve(raw.curve);
  const base = {...sanitizeEndpoints(raw, type), ...(curve ? {curve} : {})};
  return type === 'arrow' ? {type, ...base, filledHead: raw.filledHead === true} : {type, ...base};
}

// Rect and oval share the box fields; only the rect has a corner radius.
function sanitizeBox(raw: Record<string, unknown>, type: 'rect' | 'oval'): SerializedAction {
  const text = sanitizeShapeText(raw.text);
  const tail = sanitizeTail(raw.tail);
  const box = {
    ...sanitizeEndpoints(raw, type),
    fill: asColor(raw.fill) ?? TRANSPARENT_FILL,
    rotation: asAngle(raw.rotation),
    ...(text ? {text} : {}),
    ...(tail ? {tail} : {}),
  };
  if (type === 'oval') return {type, ...box};
  return {type, ...box, cornerRadius: asClampedNumber(raw.cornerRadius, 0, STORED_SIZE_MAX) ?? 0};
}

// An image item's box and asset reference are its content; opacity is style.
function sanitizeImage(raw: Record<string, unknown>): SerializedAction {
  if (typeof raw.asset !== 'string' || !ASSET_ID_PATTERN.test(raw.asset)) {
    throw new DocumentError('Image annotation has a malformed image reference');
  }
  return {
    type: 'image',
    x1: requireFinite(raw.x1, 'coordinate'),
    y1: requireFinite(raw.y1, 'coordinate'),
    x2: requireFinite(raw.x2, 'coordinate'),
    y2: requireFinite(raw.y2, 'coordinate'),
    rotation: asAngle(raw.rotation),
    opacity: asClampedNumber(raw.opacity, 0, 1) ?? 1,
    asset: raw.asset,
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
          asClampedNumber(raw.width, STORED_SIZE_MIN, STORED_SIZE_MAX) ??
          defaultWidthForTool(type) ??
          WIDTH_MIN,
      };
    case 'line':
    case 'arrow':
      return sanitizeSegment(raw, type);
    case 'rect':
    case 'oval':
      return sanitizeBox(raw, type);
    case 'text':
      return sanitizeText(raw);
    case 'number':
      return sanitizeNumber(raw);
    case 'image':
      return sanitizeImage(raw);
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

// `assetChunks` are the IMGA payloads; only the ones an item refers to are
// decoded.
function buildActions(raw: unknown, assetChunks: ReadonlyArray<Uint8Array>): Action[] {
  const serialized = sanitizeSerializedActions(raw);
  const stored = new Map<string, Uint8Array>();
  for (const data of assetChunks) {
    if (data.length <= ASSET_ID_LENGTH) throw new DocumentError('Image chunk is truncated');
    const id = decoder.decode(data.subarray(0, ASSET_ID_LENGTH));
    if (!ASSET_ID_PATTERN.test(id)) throw new DocumentError('Image chunk has a malformed id');
    if (!stored.has(id)) stored.set(id, data.subarray(ASSET_ID_LENGTH));
  }
  const assets = new Map<string, ImageAsset>();
  for (const a of serialized) {
    if (a.type !== 'image' || assets.has(a.asset)) continue;
    const png = stored.get(a.asset);
    if (!png) throw new DocumentError(`Image annotation refers to a missing image: ${a.asset}`);
    try {
      // A copy: the chunk is a view onto the whole file's bytes, which the asset
      // would otherwise keep alive.
      assets.set(a.asset, assetFromPng(a.asset, png.slice()));
    } catch (e) {
      throw new DocumentError(`Could not decode an annotation image: ${String(e)}`);
    }
  }
  try {
    return deserializeActions(serialized, assets);
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    // e.g. Pango rejecting a text's markup at layout time.
    throw new DocumentError(`Could not read the annotations: ${String(e)}`);
  }
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
  if (
    typeof meta.version !== 'number' ||
    !Number.isInteger(meta.version) ||
    meta.version < 1 ||
    meta.version > DOC_SCHEMA_VERSION
  ) {
    throw new DocumentError(`Unsupported annotation file version: ${JSON.stringify(meta.version)}`);
  }
}

export function parseDocument(bytes: Uint8Array): ParsedDocument {
  let chunks: Chunk[];
  try {
    chunks = readContainer(bytes);
  } catch (e) {
    throw new DocumentError(`Annotation file is not readable: ${String(e)}`);
  }
  checkMeta(findChunk(chunks, TAG_META));

  const image = findChunk(chunks, TAG_IMAGE);
  if (!image) throw new DocumentError('Annotation file is missing its embedded image');

  // A document with no annotations has no action chunk.
  const actionsChunk = findChunk(chunks, TAG_ACTIONS);
  let raw: unknown = [];
  if (actionsChunk) {
    try {
      raw = JSON.parse(decoder.decode(actionsChunk));
    } catch {
      throw new DocumentError('Annotation list is malformed');
    }
  }
  const assetChunks = chunks.filter((c) => c.tag === TAG_ASSET).map((c) => c.data);
  return {surface: decodeImage(image), actions: buildActions(raw, assetChunks)};
}
