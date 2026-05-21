import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import cairo from 'gi://cairo?version=1.0';

export type ImageSurface = any;

export function loadFromPixbuf(pixbuf: any): ImageSurface {
  const w = pixbuf.get_width();
  const h = pixbuf.get_height();
  const surface = new cairo.ImageSurface(cairo.Format.ARGB32, w, h);
  const cr = new cairo.Context(surface);
  Gdk.cairo_set_source_pixbuf(cr, pixbuf, 0, 0);
  cr.paint();
  return surface;
}

export function loadFromStream(stream: any): ImageSurface {
  try {
    return loadFromPixbuf(GdkPixbuf.Pixbuf.new_from_stream(stream, null));
  } finally {
    stream.close(null);
  }
}

export function loadFromFile(file: any): ImageSurface {
  return loadFromStream(file.read(null));
}
