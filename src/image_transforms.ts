import cairo from 'cairo';
import type Cairo from 'cairo';
import type { CairoPatternExt } from './globals.js';

export type RotateDirection = 'cw' | 'ccw';

// Rotates a Cairo.ImageSurface by 90° in the given direction and returns a
// fresh surface with swapped dimensions. Pixel-exact (no resampling): the
// 90° transform aligns the source grid with the destination grid.
export function rotateSurface(src: Cairo.ImageSurface, direction: RotateDirection): Cairo.ImageSurface {
  const w = src.getWidth();
  const h = src.getHeight();
  const dst = new cairo.ImageSurface(cairo.Format.ARGB32, h, w);
  const cr = new cairo.Context(dst);
  if (direction === 'cw') {
    cr.translate(h, 0);
    cr.rotate(Math.PI / 2);
  } else {
    cr.translate(0, w);
    cr.rotate(-Math.PI / 2);
  }
  cr.setSourceSurface(src, 0, 0);
  (cr.getSource() as unknown as CairoPatternExt).setFilter(cairo.Filter.NEAREST);
  cr.paint();
  return dst;
}

// Returns a fresh surface of size (w × h), with the source blitted in at
// offset (-x, -y) in destination coords. Equivalent to "what does the source
// look like when the canvas origin moves to (x, y) and the canvas size is
// (w, h)". The region may extend outside the source bounds in any direction;
// Cairo clips the blit automatically, and the new ARGB32 surface is zeroed
// (fully transparent) — that's the fill for areas beyond the source.
export function resizeSurface(src: Cairo.ImageSurface, x: number, y: number, w: number, h: number): Cairo.ImageSurface {
  const dst = new cairo.ImageSurface(cairo.Format.ARGB32, w, h);
  const cr = new cairo.Context(dst);
  cr.setSourceSurface(src, -x, -y);
  (cr.getSource() as unknown as CairoPatternExt).setFilter(cairo.Filter.NEAREST);
  cr.paint();
  return dst;
}
