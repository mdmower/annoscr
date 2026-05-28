import GLib from 'gi://GLib?version=2.0';

import {
  ColorRGBA,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  StampVariant,
  WIDTH_MAX,
  WIDTH_MIN,
} from './actions.js';
import {ImageFormat} from './exporter.js';

export type ColorScheme = 'system' | 'light' | 'dark';

// One tool's persisted style. Each field is optional: only properties the user
// actually changed (present in CanvasView's per-tool maps) are written, so a
// future change to a tool's static default still wins for untouched tools.
export interface ToolStyleEntry {
  color?: ColorRGBA;
  width?: number;
  fill?: ColorRGBA;
  fontDesc?: string;
  fontSize?: number;
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
  // Only populated when rememberToolStyles is on.
  toolStyles?: ToolStylesSnapshot;
}

const DEFAULTS: AnnoscrSettings = {
  colorScheme: 'system',
  rememberToolStyles: true,
  defaultSaveFolder: '',
  defaultSaveFormat: 'png',
  confirmDiscard: true,
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
      if (!isRecord(raw)) continue;
      const entry: ToolStyleEntry = {};
      const color = asColor(raw.color);
      if (color) entry.color = color;
      const width = asClampedNumber(raw.width, WIDTH_MIN, WIDTH_MAX);
      if (width !== undefined) entry.width = width;
      const fill = asColor(raw.fill);
      if (fill) entry.fill = fill;
      if (typeof raw.fontDesc === 'string') entry.fontDesc = raw.fontDesc;
      const fontSize = asClampedNumber(raw.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);
      if (fontSize !== undefined) entry.fontSize = fontSize;
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
