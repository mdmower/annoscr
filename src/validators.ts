import {ColorRGBA, DashStyle, StampVariant} from './actions.js';

// Validation and coercion helpers shared by the JSON files the app reads back
// (settings.json, .annoscr documents). Only helpers used by more than one
// reader live here; checks specific to a single file stay in that file.
//
// Naming convention: isXyz = type guard; asXyz = coercion that returns
// undefined for malformed input, so the caller chains its own fallback with
// `??` (or skips the field entirely for optional settings).

// ---------- Guards ----------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------- Numeric ----------

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ---------- Coercions ----------

export function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// For fields where an empty string is as useless as a missing one (font
// descriptions, names).
export function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// A finite number clamped into [lo, hi].
export function asClampedNumber(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return clamp(v, lo, hi);
}

// A [r, g, b, a] float color; out-of-range channels are clamped to 0..1.
export function asColor(v: unknown): ColorRGBA | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const a = v as unknown[];
  if (!a.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const n = a as number[];
  return [clamp(n[0], 0, 1), clamp(n[1], 0, 1), clamp(n[2], 0, 1), clamp(n[3], 0, 1)];
}

export function asDash(v: unknown): DashStyle | undefined {
  return v === 'solid' || v === 'dashed' || v === 'dotted' ? v : undefined;
}

export function asStampVariant(v: unknown): StampVariant | undefined {
  return v === 'number' || v === 'letter' ? v : undefined;
}
