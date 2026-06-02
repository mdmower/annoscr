import GLib from 'gi://GLib?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Cairo from 'cairo';

import type {Action} from './actions.js';

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
// source image's native resolution. This is what gets saved or copied.
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
    action.draw(cr, 1);
  }
  out.flush();
  return out;
}

export function saveSurface(surface: Cairo.ImageSurface, path: string, format: ImageFormat): void {
  if (format === 'png') {
    surface.writeToPNG(path);
    return;
  }
  // JPEG has no alpha channel — composite onto white before encoding so
  // transparent regions don't go black on encoders that ignore the alpha byte.
  const w = surface.getWidth();
  const h = surface.getHeight();
  const opaque = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const cr = new Cairo.Context(opaque);
  cr.setSourceRGB(1, 1, 1);
  cr.paint();
  cr.setSourceSurface(surface, 0, 0);
  cr.paint();
  opaque.flush();
  // Gdk.pixbuf_get_from_surface is deprecated since 4.12. The replacement
  // (Gdk.MemoryTexture from cairo pixels) requires
  // cairo_image_surface_get_data, which GJS deliberately omits, so until GJS
  // exposes it this path stays on the deprecated helper.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const pixbuf = Gdk.pixbuf_get_from_surface(opaque, 0, 0, w, h);
  // A null pixbuf means the read failed; throw so the caller doesn't mistake a
  // no-op for a successful save (and wrongly mark the canvas clean).
  if (!pixbuf) throw new Error('Failed to read surface pixels for JPEG encoding');
  pixbuf.savev(path, 'jpeg', ['quality'], ['90']);
}

// Put pre-encoded PNG bytes on the clipboard as image/png. Pre-encoding (vs.
// providing a Gdk.Texture and letting GTK serialize on demand) avoids a
// deadlock when this same process pastes the clipboard back: the synchronous
// PNG serializer and the synchronous stream reader both run on the main loop
// and stall each other.
export function copySurfaceToClipboard(
  clipboard: Gdk.Clipboard,
  surface: Cairo.ImageSurface
): void {
  const w = surface.getWidth();
  const h = surface.getHeight();
  // Same GJS constraint as the JPEG path: no JS-accessible way to get cairo
  // pixel data, so the modern MemoryTexture route is closed. Stay on the
  // deprecated helper until GJS exposes cairo_image_surface_get_data.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const pixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, w, h);
  // Throw rather than silently no-op so the caller doesn't mark the canvas
  // clean as if the copy had succeeded.
  if (!pixbuf) throw new Error('Failed to read surface pixels for clipboard copy');
  const texture = Gdk.Texture.new_for_pixbuf(pixbuf);
  const bytes = texture.save_to_png_bytes();
  const provider = Gdk.ContentProvider.new_for_bytes('image/png', bytes);
  clipboard.set_content(provider);
}

// Annoscr-2026-05-22-143015.png
export function defaultSaveFilename(format: ImageFormat = 'png'): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `Annoscr-${ts}${FORMATS[format].ext}`;
}

// User's Pictures directory if set; else home directory.
export function defaultSaveFolderPath(): string {
  const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
  return pictures || GLib.get_home_dir();
}
