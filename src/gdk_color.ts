import Gdk from 'gi://Gdk?version=4.0';

import {ColorRGBA} from './actions.js';

export function colorToRgba(c: ColorRGBA): Gdk.RGBA {
  const rgba = new Gdk.RGBA();
  rgba.red = c[0];
  rgba.green = c[1];
  rgba.blue = c[2];
  rgba.alpha = c[3];
  return rgba;
}

export function rgbaToColor(rgba: Gdk.RGBA): ColorRGBA {
  return [rgba.red, rgba.green, rgba.blue, rgba.alpha];
}

// Parse a hex color string into a ColorRGBA, or null if it isn't a valid hex
// color. Accepts the CSS forms `#RGB`, `#RGBA`, `#RRGGBB`, and `#RRGGBBAA` (the
// leading `#` is optional, case-insensitive); the 3-/4-digit shorthands expand
// by doubling each digit. A value without an alpha channel reports full
// opacity; callers that want to keep the current alpha for such input check
// `hadAlpha`.
export function parseHexColor(input: string): {color: ColorRGBA; hadAlpha: boolean} | null {
  let s = input.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(s)) return null;
  // Expand CSS shorthand: #RGB → #RRGGBB, #RGBA → #RRGGBBAA.
  if (s.length === 3 || s.length === 4) s = Array.from(s, (ch) => ch + ch).join('');
  if (s.length !== 6 && s.length !== 8) return null;
  const byte = (i: number): number => parseInt(s.slice(i, i + 2), 16) / 255;
  const hadAlpha = s.length === 8;
  return {color: [byte(0), byte(2), byte(4), hadAlpha ? byte(6) : 1], hadAlpha};
}

// Format the RGB channels as `#RRGGBB` (opacity is shown separately, so alpha
// is intentionally omitted).
export function colorToHex(c: ColorRGBA): string {
  const h = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
