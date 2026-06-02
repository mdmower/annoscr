import GLib from 'gi://GLib?version=2.0';

import {
  ColorRGBA,
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

const TOOL_ID_SET = new Set<string>(TOOL_IDS);

export type ColorScheme = 'system' | 'light' | 'dark';

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
  confirmDiscard: boolean;
  // After placing an annotation, switch to the select tool with the new item
  // selected (so it's immediately editable/resizable/rotatable). Off keeps the
  // current tool for rapid repeated placement.
  selectAfterPlacement: boolean;
  // Only populated when rememberToolStyles is on.
  toolStyles?: ToolStylesSnapshot;
}

const DEFAULTS: AnnoscrSettings = {
  colorScheme: 'system',
  rememberToolStyles: true,
  defaultSaveFolder: '',
  defaultSaveFormat: 'png',
  confirmDiscard: true,
  selectAfterPlacement: true,
};

function settingsPath(): string {
  return GLib.build_filenamev([GLib.get_user_config_dir(), 'annoscr', 'settings.json']);
}

// --- Validators ---------------------------------------------------------------
// settings.json is a plain file users may hand-edit, so every field is
// validated against its expected type/domain on load. A bad or unrecognized
// value falls back to its default rather than propagating into the UI (where a
// wrong type could, e.g., crash the save dialog on FORMATS[badFormat]).

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function asColorScheme(v: unknown): ColorScheme {
  return v === 'light' || v === 'dark' || v === 'system' ? v : DEFAULTS.colorScheme;
}

function asFormat(v: unknown): ImageFormat {
  return v === 'png' || v === 'jpeg' ? v : DEFAULTS.defaultSaveFormat;
}

function asColor(v: unknown): ColorRGBA | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const a = v as unknown[];
  if (!a.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const n = a as number[];
  return [clamp(n[0], 0, 1), clamp(n[1], 0, 1), clamp(n[2], 0, 1), clamp(n[3], 0, 1)];
}

function asClampedNumber(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return clamp(v, lo, hi);
}

function asToolStyles(v: unknown): ToolStylesSnapshot | undefined {
  if (!isRecord(v)) return undefined;
  const tools: Record<string, ToolStyleEntry> = {};
  if (isRecord(v.tools)) {
    for (const [id, raw] of Object.entries(v.tools)) {
      // Drop unknown tool ids (typos, junk, or a stale id from an old build)
      // rather than round-tripping them back into settings.json.
      if (!TOOL_ID_SET.has(id)) continue;
      if (!isRecord(raw)) continue;
      const entry: ToolStyleEntry = {};
      const color = asColor(raw.color);
      if (color) entry.color = color;
      const textColor = asColor(raw.textColor);
      if (textColor) entry.textColor = textColor;
      const width = asClampedNumber(raw.width, WIDTH_MIN, WIDTH_MAX);
      if (width !== undefined) entry.width = width;
      const fill = asColor(raw.fill);
      if (fill) entry.fill = fill;
      if (raw.dash === 'solid' || raw.dash === 'dashed' || raw.dash === 'dotted') {
        entry.dash = raw.dash;
      }
      if (typeof raw.filledHead === 'boolean') entry.filledHead = raw.filledHead;
      if (typeof raw.fontDesc === 'string') entry.fontDesc = raw.fontDesc;
      const fontSize = asClampedNumber(raw.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
      if (fontSize !== undefined) entry.fontSize = fontSize;
      const stampRadius = asClampedNumber(raw.stampRadius, STAMP_RADIUS_MIN, STAMP_RADIUS_MAX);
      if (stampRadius !== undefined) entry.stampRadius = stampRadius;
      if (Object.keys(entry).length > 0) tools[id] = entry;
    }
  }
  const snap: ToolStylesSnapshot = {tools};
  if (v.stampVariant === 'number' || v.stampVariant === 'letter') {
    snap.stampVariant = v.stampVariant;
  }
  return snap;
}

function sanitize(raw: unknown): AnnoscrSettings {
  if (!isRecord(raw)) return {...DEFAULTS};
  const out: AnnoscrSettings = {
    colorScheme: asColorScheme(raw.colorScheme),
    rememberToolStyles: asBool(raw.rememberToolStyles, DEFAULTS.rememberToolStyles),
    defaultSaveFolder: asString(raw.defaultSaveFolder, DEFAULTS.defaultSaveFolder),
    defaultSaveFormat: asFormat(raw.defaultSaveFormat),
    confirmDiscard: asBool(raw.confirmDiscard, DEFAULTS.confirmDiscard),
    selectAfterPlacement: asBool(raw.selectAfterPlacement, DEFAULTS.selectAfterPlacement),
  };
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
