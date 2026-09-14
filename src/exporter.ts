import GLib from 'gi://GLib?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Cairo from 'cairo';

import type {Action, ColorRGBA} from './actions.js';
import {scaleSurface} from './image_transforms.js';

export type ImageFormat = 'png' | 'jpeg';

export interface FormatInfo {
  ext: string; // canonical extension including the dot
  mime: string;
  patterns: string[];
}

export const FORMATS: Record<ImageFormat, FormatInfo> = {
  png: {
    ext: '.png',
    mime: 'image/png',
    patterns: ['*.png'],
  },
  jpeg: {
    ext: '.jpeg',
    mime: 'image/jpeg',
    patterns: ['*.jpg', '*.jpeg'],
  },
};

// Maps a known image extension to its format. Anything that isn't .jpg/.jpeg
// falls back to PNG, so callers must only pass paths whose extension they've
// already confirmed is png/jpg/jpeg (the save dialog appends the default
// format's extension to any other name before calling this). Don't rely on the
// fallback to classify an arbitrary path.
export function formatFromPath(path: string): ImageFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'jpeg';
  return 'png';
}

// Composite source image + every action onto a fresh ARGB32 surface at the
// source image's native resolution. This is what gets saved or copied. Image
// items are cut off at the canvas edge, and a shrunk one is resampled with
// scaleSurface.
export function renderToSurface(
  srcSurface: Cairo.ImageSurface,
  actions: ReadonlyArray<Action>
): Cairo.ImageSurface {
  const w = srcSurface.getWidth();
  const h = srcSurface.getHeight();
  const out = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const cr = new Cairo.Context(out);
  cr.setSourceSurface(srcSurface, 0, 0);
  cr.paint();
  for (const action of actions) {
    action.draw(cr, 1, scaleSurface);
  }
  out.flush();
  return out;
}

// Read a single pixel of a surface as a ColorRGBA. Same GJS constraint as the
// encoders below: cairo's own pixel accessors aren't exposed, so the read goes
// through the deprecated pixbuf conversion (which un-premultiplies the color).
// Returns null when the read fails or the coordinate is outside the surface.
export function sampleSurfacePixel(
  surface: Cairo.ImageSurface,
  x: number,
  y: number
): ColorRGBA | null {
  if (x < 0 || y < 0 || x >= surface.getWidth() || y >= surface.getHeight()) return null;
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const pixbuf = Gdk.pixbuf_get_from_surface(surface, x, y, 1, 1);
  if (!pixbuf) return null;
  const p = pixbuf.get_pixels();
  const alpha = pixbuf.get_has_alpha() ? p[3] / 255 : 1;
  return [p[0] / 255, p[1] / 255, p[2] / 255, alpha];
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

// The surface's pixels as an unpremultiplied pixbuf. Gdk.pixbuf_get_from_surface
// is deprecated since 4.12; its replacement (Gdk.MemoryTexture from cairo
// pixels) requires cairo_image_surface_get_data, which GJS deliberately omits.
// Throws on a failed read so callers don't mistake a no-op for success.
function surfacePixbuf(surface: Cairo.ImageSurface): GdkPixbuf.Pixbuf {
  const w = surface.getWidth();
  const h = surface.getHeight();
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const pixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, w, h);
  if (!pixbuf) throw new Error('Failed to read surface pixels for encoding');
  return pixbuf;
}

// Encodes on a GTask worker thread, so a full-resolution image doesn't block
// the main loop. The pixbuf is a private copy of the pixels, which nothing on
// the main thread writes to.
function encodePixbuf(
  pixbuf: GdkPixbuf.Pixbuf,
  type: string,
  keys: string[],
  values: string[]
): Promise<GLib.Bytes> {
  const out = Gio.MemoryOutputStream.new_resizable();
  return new Promise((resolve, reject) => {
    pixbuf.save_to_streamv_async(out, type, keys, values, null, (_src, res) => {
      try {
        const ok = GdkPixbuf.Pixbuf.save_to_stream_finish(res);
        if (!ok) throw new Error(`${type} encoding failed`);
        out.close(null);
        resolve(out.steal_as_bytes());
      } catch (e) {
        reject(toError(e));
      }
    });
  });
}

export function writeFileBytes(file: Gio.File, bytes: GLib.Bytes | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    file.replace_contents_bytes_async(
      bytes,
      null,
      false,
      Gio.FileCreateFlags.NONE,
      null,
      (_src, res) => {
        try {
          file.replace_contents_finish(res);
          resolve();
        } catch (e) {
          reject(toError(e));
        }
      }
    );
  });
}

export async function saveSurface(
  surface: Cairo.ImageSurface,
  path: string,
  format: ImageFormat
): Promise<void> {
  let bytes: GLib.Bytes;
  if (format === 'png') {
    bytes = await surfaceToPngBytesAsync(surface);
  } else {
    // JPEG has no alpha channel — composite onto white before encoding so
    // transparent regions don't go black on encoders that ignore the alpha byte.
    const opaque = new Cairo.ImageSurface(
      Cairo.Format.ARGB32,
      surface.getWidth(),
      surface.getHeight()
    );
    const cr = new Cairo.Context(opaque);
    cr.setSourceRGB(1, 1, 1);
    cr.paint();
    cr.setSourceSurface(surface, 0, 0);
    cr.paint();
    opaque.flush();
    bytes = await encodePixbuf(surfacePixbuf(opaque), 'jpeg', ['quality'], ['90']);
  }
  await writeFileBytes(Gio.File.new_for_path(path), bytes);
}

// Encode a surface to PNG bytes in memory (no file), on the main thread. For
// small images; surfaceToPngBytesAsync encodes a full-resolution one.
export function surfaceToPngBytes(surface: Cairo.ImageSurface): GLib.Bytes {
  return Gdk.Texture.new_for_pixbuf(surfacePixbuf(surface)).save_to_png_bytes();
}

export function surfaceToPngBytesAsync(surface: Cairo.ImageSurface): Promise<GLib.Bytes> {
  return encodePixbuf(surfacePixbuf(surface), 'png', [], []);
}

// A SQUARE PNG thumbnail (side ≤ maxDim) with the image scaled to fit and
// centered on transparency. Square on purpose: GNOME renders a notification
// icon in a square slot and stretches a non-square image to fill it, so a
// landscape capture comes out distorted. A square image can't be stretched, so
// the letterboxed result keeps the true aspect (transparent bars on the short
// sides). Encoded as bytes — small, so the D-Bus payload stays small.
export function surfaceThumbnailPngBytes(surface: Cairo.ImageSurface, maxDim = 256): GLib.Bytes {
  const w = surface.getWidth();
  const h = surface.getHeight();
  const longest = Math.max(w, h);
  const side = Math.min(maxDim, longest); // never upscale a small image
  const scale = side / longest;
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const thumb = new Cairo.ImageSurface(Cairo.Format.ARGB32, side, side);
  const cr = new Cairo.Context(thumb);
  cr.translate((side - sw) / 2, (side - sh) / 2);
  cr.scale(scale, scale);
  cr.setSourceSurface(surface, 0, 0);
  cr.paint();
  thumb.flush();
  return surfaceToPngBytes(thumb);
}

// Scale a surface to fit within maxW x maxH, never upscaling, keeping the
// source aspect ratio, and encode as PNG. Separate from
// surfaceThumbnailPngBytes, whose square letterboxing exists only for GNOME's
// notification icon slot.
export function surfaceFitPngBytes(
  surface: Cairo.ImageSurface,
  maxW: number,
  maxH: number
): GLib.Bytes {
  const w = surface.getWidth();
  const h = surface.getHeight();
  const scale = Math.min(1, maxW / w, maxH / h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const thumb = new Cairo.ImageSurface(Cairo.Format.ARGB32, tw, th);
  const cr = new Cairo.Context(thumb);
  cr.scale(scale, scale);
  cr.setSourceSurface(surface, 0, 0);
  cr.paint();
  thumb.flush();
  return surfaceToPngBytes(thumb);
}

// Put pre-encoded PNG bytes on the clipboard as image/png. Pre-encoding (vs.
// providing a Gdk.Texture and letting GTK serialize on demand) avoids a
// deadlock when this same process pastes the clipboard back: the synchronous
// PNG serializer and the synchronous stream reader both run on the main loop
// and stall each other.
export async function copySurfaceToClipboard(
  clipboard: Gdk.Clipboard,
  surface: Cairo.ImageSurface
): Promise<void> {
  const bytes = await surfaceToPngBytesAsync(surface);
  clipboard.set_content(Gdk.ContentProvider.new_for_bytes('image/png', bytes));
}

// Timestamp slug for default filenames, e.g. 2026-05-22-143015 (no extension).
// Shared by the image export and the annotation-file default names.
export function fileTimestamp(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Annoscr-2026-05-22-143015.png
export function defaultSaveFilename(format: ImageFormat = 'png'): string {
  return `Annoscr-${fileTimestamp()}${FORMATS[format].ext}`;
}

// User's Pictures directory if set; else home directory.
export function defaultSaveFolderPath(): string {
  const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
  return pictures || GLib.get_home_dir();
}
