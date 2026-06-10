import {ColorRGBA} from './actions.js';

// Field validators shared by the JSON files the app reads back (settings.json,
// .annoscr documents). Each `asX` returns undefined for malformed input so the
// caller chains its own fallback with `??`.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// A [r, g, b, a] float color; out-of-range channels are clamped to 0..1.
export function asColor(v: unknown): ColorRGBA | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const a = v as unknown[];
  if (!a.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  const n = a as number[];
  return [clamp(n[0], 0, 1), clamp(n[1], 0, 1), clamp(n[2], 0, 1), clamp(n[3], 0, 1)];
}

// A finite number clamped into [lo, hi].
export function asClampedNumber(v: unknown, lo: number, hi: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return clamp(v, lo, hi);
}
