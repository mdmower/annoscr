import GLib from 'gi://GLib?version=2.0';

import {
  ColorRGBA,
  CORNER_RADIUS_MAX,
  CORNER_RADIUS_MIN,
  DashStyle,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  STAMP_RADIUS_MAX,
  STAMP_RADIUS_MIN,
  StampVariant,
  TOOL_IDS,
  WIDTH_MAX,
  WIDTH_MIN,
} from './actions.js';
import {ImageFormat} from './exporter.js';
import {
  asBool,
  asClampedNumber,
  asColor,
  asDash,
  asNonEmptyString,
  asStampVariant,
  asString,
  isRecord,
} from './validators.js';

const TOOL_ID_SET = new Set<string>(TOOL_IDS);

export type ColorScheme = 'system' | 'light' | 'dark';

// Pixel-memory budget preset for canvas undo history (the surfaces rotate /
// canvas-resize snapshots pin; see CanvasView's surface cap).
export type UndoMemory = 'low' | 'normal' | 'high' | 'unlimited';

// The byte budget a preset stands for; null = no budget. The mapping lives
// here so Preferences (labels) and the window (applying it to the canvas)
// can't drift apart.
export function undoMemoryBytes(m: UndoMemory): number | null {
  switch (m) {
    case 'low':
      return 128 * 1024 * 1024;
    case 'high':
      return 1024 * 1024 * 1024;
    case 'unlimited':
      return null;
    case 'normal':
    default:
      return 256 * 1024 * 1024;
  }
}

// One tool's persisted style. Each field is optional: only properties the user
// actually changed (present in CanvasView's per-tool maps) are written, so a
// future change to a tool's static default still wins for untouched tools.
export interface ToolStyleEntry {
  color?: ColorRGBA;
  // Text-foreground color (the getTextColor channel). Only the text tool writes
  // it today.
  textColor?: ColorRGBA;
  width?: number;
  fill?: ColorRGBA;
  dash?: DashStyle;
  // Filled (solid-triangle) arrowhead. Only the arrow tool writes it.
  filledHead?: boolean;
  // Rectangle corner radius (image-space px). Only the rect tool writes it.
  cornerRadius?: number;
  fontDesc?: string;
  fontSize?: number;
  // Number-stamp radius (image-space px). Only the number tool writes it.
  stampRadius?: number;
}

export interface ToolStylesSnapshot {
  tools: Record<string, ToolStyleEntry>;
  stampVariant?: StampVariant;
}

export interface AnnoscrSettings {
  colorScheme: ColorScheme;
  rememberToolStyles: boolean;
  // Empty string = fall back to the XDG Pictures directory (default behavior).
  defaultSaveFolder: string;
  defaultSaveFormat: ImageFormat;
  // Save images straight to the default folder with an auto-generated name,
  // skipping the file dialog. "Save image as…" still opens the dialog.
  saveWithoutDialog: boolean;
  confirmDiscard: boolean;
  // After placing an annotation, switch to the select tool with the new item
  // selected (so it's immediately editable/resizable/rotatable). Off keeps the
  // current tool for rapid repeated placement.
  selectAfterPlacement: boolean;
  // Close the window after exporting an image (PNG/JPEG). Does not apply to
  // saving an annotation (.annoscr) file.
  closeAfterImageSave: boolean;
  // Close the window after copying the image to the clipboard. Because a copy
  // doesn't mark the canvas saved, auto-closing skips the discard prompt.
  closeAfterImageCopy: boolean;
  undoMemory: UndoMemory;
  // Last window geometry, restored on launch. Position is intentionally absent:
  // GTK4 exposes no toplevel-positioning API (the compositor owns placement on
  // Wayland), so only size + maximized state are ours to persist. While
  // maximized, width/height hold the last unmaximized size, so unmaximizing
  // after a restore returns to the right footprint.
  windowWidth: number;
  windowHeight: number;
  windowMaximized: boolean;
  // Family names shown in the text font dropdown, in order; the first is the
  // text tool's default. Empty/absent = the automatic selection built from
  // font_catalogue's candidate lists. Families that aren't installed are dropped
  // when the catalogue is built.
  fontFamilies?: string[];
  // Only populated when rememberToolStyles is on.
  toolStyles?: ToolStylesSnapshot;
}

const DEFAULTS: AnnoscrSettings = {
  colorScheme: 'system',
  rememberToolStyles: true,
  defaultSaveFolder: '',
  defaultSaveFormat: 'png',
  saveWithoutDialog: false,
  confirmDiscard: true,
  selectAfterPlacement: true,
  closeAfterImageSave: false,
  closeAfterImageCopy: false,
  undoMemory: 'normal',
  windowWidth: 960,
  windowHeight: 640,
  windowMaximized: false,
};

// Bounds for the persisted window size — just enough to reject absurd or stale
// hand-edited values; GTK enforces the real natural minimum at display time.
const WINDOW_SIZE_MIN = 360;
const WINDOW_SIZE_MAX = 16384;

function settingsPath(): string {
  return GLib.build_filenamev([GLib.get_user_config_dir(), 'annoscr', 'settings.json']);
}

// --- Validators ---------------------------------------------------------------
// settings.json is a plain file users may hand-edit, so every field is
// validated against its expected type/domain on load. A bad or unrecognized
// value falls back to its default rather than propagating into the UI (where a
// wrong type could, e.g., crash the save dialog on FORMATS[badFormat]).

// An ordered list of non-empty, de-duplicated strings, or undefined when none
// survive (so an empty list reads the same as an absent one). Family existence
// isn't checked here — that happens against the installed fonts when the
// catalogue is built.
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0 && !out.includes(item)) {
      out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

function asColorScheme(v: unknown): ColorScheme {
  return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULTS.colorScheme;
}

function asUndoMemory(v: unknown): UndoMemory {
  return v === 'low' || v === 'normal' || v === 'high' || v === 'unlimited'
    ? v
    : DEFAULTS.undoMemory;
}

function asFormat(v: unknown): ImageFormat {
  return v === 'png' || v === 'jpeg' ? v : DEFAULTS.defaultSaveFormat;
}

// Parse one tool's persisted style, dropping malformed / out-of-range fields.
// Returns null when nothing valid survives so the caller can skip the entry.
function asToolStyleEntry(raw: unknown): ToolStyleEntry | null {
  if (!isRecord(raw)) return null;
  const entry: ToolStyleEntry = {};
  const color = asColor(raw.color);
  if (color) entry.color = color;
  const textColor = asColor(raw.textColor);
  if (textColor) entry.textColor = textColor;
  const width = asClampedNumber(raw.width, WIDTH_MIN, WIDTH_MAX);
  if (width !== undefined) entry.width = width;
  const fill = asColor(raw.fill);
  if (fill) entry.fill = fill;
  const dash = asDash(raw.dash);
  if (dash) entry.dash = dash;
  const filledHead = asBool(raw.filledHead);
  if (filledHead !== undefined) entry.filledHead = filledHead;
  const cornerRadius = asClampedNumber(raw.cornerRadius, CORNER_RADIUS_MIN, CORNER_RADIUS_MAX);
  if (cornerRadius !== undefined) entry.cornerRadius = cornerRadius;
  const fontDesc = asNonEmptyString(raw.fontDesc);
  if (fontDesc) entry.fontDesc = fontDesc;
  const fontSize = asClampedNumber(raw.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
  if (fontSize !== undefined) entry.fontSize = fontSize;
  const stampRadius = asClampedNumber(raw.stampRadius, STAMP_RADIUS_MIN, STAMP_RADIUS_MAX);
  if (stampRadius !== undefined) entry.stampRadius = stampRadius;
  return Object.keys(entry).length > 0 ? entry : null;
}

function asToolStyles(v: unknown): ToolStylesSnapshot | undefined {
  if (!isRecord(v)) return undefined;
  const tools: Record<string, ToolStyleEntry> = {};
  if (isRecord(v.tools)) {
    for (const [id, raw] of Object.entries(v.tools)) {
      // Drop unknown tool ids (typos, junk, or a stale id from an old build)
      // rather than round-tripping them back into settings.json.
      if (!TOOL_ID_SET.has(id)) continue;
      const entry = asToolStyleEntry(raw);
      if (entry) tools[id] = entry;
    }
  }
  const snap: ToolStylesSnapshot = {tools};
  const stampVariant = asStampVariant(v.stampVariant);
  if (stampVariant) snap.stampVariant = stampVariant;
  return snap;
}

function sanitize(raw: unknown): AnnoscrSettings {
  if (!isRecord(raw)) return {...DEFAULTS};
  const out: AnnoscrSettings = {
    colorScheme: asColorScheme(raw.colorScheme),
    rememberToolStyles: asBool(raw.rememberToolStyles) ?? DEFAULTS.rememberToolStyles,
    defaultSaveFolder: asString(raw.defaultSaveFolder) ?? DEFAULTS.defaultSaveFolder,
    defaultSaveFormat: asFormat(raw.defaultSaveFormat),
    saveWithoutDialog: asBool(raw.saveWithoutDialog) ?? DEFAULTS.saveWithoutDialog,
    confirmDiscard: asBool(raw.confirmDiscard) ?? DEFAULTS.confirmDiscard,
    selectAfterPlacement: asBool(raw.selectAfterPlacement) ?? DEFAULTS.selectAfterPlacement,
    closeAfterImageSave: asBool(raw.closeAfterImageSave) ?? DEFAULTS.closeAfterImageSave,
    closeAfterImageCopy: asBool(raw.closeAfterImageCopy) ?? DEFAULTS.closeAfterImageCopy,
    undoMemory: asUndoMemory(raw.undoMemory),
    windowWidth:
      asClampedNumber(raw.windowWidth, WINDOW_SIZE_MIN, WINDOW_SIZE_MAX) ?? DEFAULTS.windowWidth,
    windowHeight:
      asClampedNumber(raw.windowHeight, WINDOW_SIZE_MIN, WINDOW_SIZE_MAX) ?? DEFAULTS.windowHeight,
    windowMaximized: asBool(raw.windowMaximized) ?? DEFAULTS.windowMaximized,
  };
  const fontFamilies = asStringArray(raw.fontFamilies);
  if (fontFamilies) out.fontFamilies = fontFamilies;
  const toolStyles = asToolStyles(raw.toolStyles);
  if (toolStyles) out.toolStyles = toolStyles;
  return out;
}

function loadSettings(): AnnoscrSettings {
  try {
    const [ok, bytes] = GLib.file_get_contents(settingsPath());
    if (!ok) return {...DEFAULTS};
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return sanitize(raw);
  } catch {
    // Missing file (first run) or malformed JSON — start from defaults.
    return {...DEFAULTS};
  }
}

function saveSettings(s: AnnoscrSettings): void {
  try {
    const path = settingsPath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, new TextEncoder().encode(JSON.stringify(s, null, 2)));
  } catch (e) {
    // A bad write must never crash the app — preferences are best-effort.
    console.error('saveSettings failed', e);
  }
}

let cached: AnnoscrSettings | null = null;

export function getSettings(): AnnoscrSettings {
  if (!cached) cached = loadSettings();
  return cached;
}

export function updateSettings(partial: Partial<AnnoscrSettings>): void {
  cached = {...getSettings(), ...partial};
  saveSettings(cached);
}
