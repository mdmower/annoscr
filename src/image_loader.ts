import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import Cairo from 'cairo';

import type {ImageAsset} from './actions.js';

export function loadFromPixbuf(pixbuf: GdkPixbuf.Pixbuf): Cairo.ImageSurface {
  // Apply any EXIF orientation (new_from_stream doesn't); returns the same
  // pixbuf when there's nothing to rotate, null on failure.
  const oriented = pixbuf.apply_embedded_orientation() ?? pixbuf;
  const w = oriented.get_width();
  const h = oriented.get_height();
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const cr = new Cairo.Context(surface);
  // Gdk.cairo_set_source_pixbuf is deprecated since 4.20. The replacement
  // recipe (Gdk.Texture.download into a cairo surface's pixel buffer)
  // requires cairo_image_surface_get_data, which GJS deliberately omits
  // (only getStride is exposed), so this path stays on the deprecated helper
  // until GJS exposes the pixel accessors.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  Gdk.cairo_set_source_pixbuf(cr, oriented, 0, 0);
  cr.paint();
  return surface;
}

export function loadFromStream(stream: Gio.InputStream): Cairo.ImageSurface {
  try {
    return loadFromPixbuf(GdkPixbuf.Pixbuf.new_from_stream(stream, null));
  } finally {
    stream.close(null);
  }
}

export function loadFromFile(file: Gio.File): Cairo.ImageSurface {
  return loadFromStream(file.read(null));
}

// Decode an in-memory image (e.g. the PNG embedded in an annotation file).
export function loadFromBytes(bytes: Uint8Array): Cairo.ImageSurface {
  return loadFromStream(Gio.MemoryInputStream.new_from_bytes(bytes));
}

// An image item's asset from a decoded image. The PNG is encoded from the
// pixbuf once, here, so neither saving nor comparing history states has to
// read the pixels back from the surface.
export function assetFromPixbuf(pixbuf: GdkPixbuf.Pixbuf): ImageAsset {
  const oriented = pixbuf.apply_embedded_orientation() ?? pixbuf;
  const encoded = Gdk.Texture.new_for_pixbuf(oriented).save_to_png_bytes();
  const png = encoded.get_data();
  const id = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, encoded);
  if (!png || !id) throw new Error('PNG encoding produced no bytes');
  return {id, surface: loadFromPixbuf(oriented), png};
}

export function assetFromFile(file: Gio.File): ImageAsset {
  const stream = file.read(null);
  try {
    return assetFromPixbuf(GdkPixbuf.Pixbuf.new_from_stream(stream, null));
  } finally {
    stream.close(null);
  }
}

// An asset read back from a document: its stored id and PNG bytes are kept
// as they are, so re-saving writes the same chunk.
export function assetFromPng(id: string, png: Uint8Array): ImageAsset {
  return {id, surface: loadFromBytes(png), png};
}
