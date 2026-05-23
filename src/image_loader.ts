import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio?version=2.0'
import cairo from 'cairo';
import type Cairo from 'cairo';

export function loadFromPixbuf(pixbuf: GdkPixbuf.Pixbuf): Cairo.ImageSurface {
  const w = pixbuf.get_width();
  const h = pixbuf.get_height();
  const surface = new cairo.ImageSurface(cairo.Format.ARGB32, w, h);
  const cr = new cairo.Context(surface);
  // TODO: @deprecated — since 4.20: Use cairo_set_source_surface() and gdk_texture_download()
  Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
  cr.paint();
  return surface;
}

export function loadFromStream(stream: Gio.FileInputStream): Cairo.ImageSurface {
  try {
    return loadFromPixbuf(GdkPixbuf.Pixbuf.new_from_stream(stream, null));
  } finally {
    stream.close(null);
  }
}

export function loadFromFile(file: Gio.File): Cairo.ImageSurface {
  return loadFromStream(file.read(null));
}
