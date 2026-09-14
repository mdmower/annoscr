import Cairo from 'cairo';

import type {RotateDirection} from './actions.js';

// Rotates a Cairo.ImageSurface by 90° in the given direction and returns a
// fresh surface with swapped dimensions. Pixel-exact (no resampling): the
// 90° transform aligns the source grid with the destination grid.
export function rotateSurface(
  src: Cairo.ImageSurface,
  direction: RotateDirection
): Cairo.ImageSurface {
  const w = src.getWidth();
  const h = src.getHeight();
  const dst = new Cairo.ImageSurface(Cairo.Format.ARGB32, h, w);
  const cr = new Cairo.Context(dst);
  if (direction === 'cw') {
    cr.translate(h, 0);
    cr.rotate(Math.PI / 2);
  } else {
    cr.translate(0, w);
    cr.rotate(-Math.PI / 2);
  }
  cr.setSourceSurface(src, 0, 0);
  (cr.getSource() as Cairo.SurfacePattern).setFilter(Cairo.Filter.NEAREST);
  cr.paint();
  return dst;
}

// Returns a fresh surface of size (w × h), with the source blitted in at
// offset (-x, -y) in destination coords. Equivalent to "what does the source
// look like when the canvas origin moves to (x, y) and the canvas size is
// (w, h)". The region may extend outside the source bounds; Cairo clips the
// blit automatically. The new ARGB32 surface starts zeroed (fully transparent).
// If `fill` is provided and has non-zero alpha, the newly-added margin — the
// destination area outside the source's placement rect — is painted with it.
// The source region keeps its own pixels, so an alpha image's interior
// transparency is preserved: the fill is a border, not a background behind the
// whole canvas.
export function resizeSurface(
  src: Cairo.ImageSurface,
  x: number,
  y: number,
  w: number,
  h: number,
  fill?: [number, number, number, number]
): Cairo.ImageSurface {
  const dst = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const cr = new Cairo.Context(dst);
  cr.setSourceSurface(src, -x, -y);
  (cr.getSource() as Cairo.SurfacePattern).setFilter(Cairo.Filter.NEAREST);
  cr.paint();
  if (fill && fill[3] > 0) {
    // Fill only the complement of the source's placement rect (whole surface
    // XOR that rect, via even-odd), so transparency inside the source is left
    // untouched. Both rects are integer-aligned, so the shared edge has no
    // antialiased seam.
    cr.setFillRule(Cairo.FillRule.EVEN_ODD);
    cr.rectangle(0, 0, w, h);
    cr.rectangle(-x, -y, src.getWidth(), src.getHeight());
    cr.setSourceRGBA(fill[0], fill[1], fill[2], fill[3]);
    cr.fill();
  }
  return dst;
}

// Where a source image sits on a canvas of a different size: the fraction of
// the size difference placed before the image on each axis (0 = start, 0.5 =
// centered, 1 = end).
export type AnchorFraction = 0 | 0.5 | 1;
export interface Anchor {
  x: AnchorFraction;
  y: AnchorFraction;
}

// Returns a (w × h) surface holding `src` placed by `anchor`, so a larger
// source is cropped and a smaller one padded with `fill`, decided per axis. An
// odd centering difference floors the placement offset toward the origin.
export function anchorSurface(
  src: Cairo.ImageSurface,
  w: number,
  h: number,
  anchor: Anchor,
  fill?: [number, number, number, number]
): Cairo.ImageSurface {
  const x = -Math.trunc((w - src.getWidth()) * anchor.x);
  const y = -Math.trunc((h - src.getHeight()) * anchor.y);
  return resizeSurface(src, x, y, w, h, fill);
}

export function createBlankSurface(
  w: number,
  h: number,
  fill?: [number, number, number, number]
): Cairo.ImageSurface {
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  if (fill && fill[3] > 0) {
    const cr = new Cairo.Context(surface);
    cr.setSourceRGBA(fill[0], fill[1], fill[2], fill[3]);
    cr.paint();
  }
  return surface;
}

// One scaled blit of `src` onto a fresh (w × h) surface.
function scaleBlit(src: Cairo.ImageSurface, w: number, h: number): Cairo.ImageSurface {
  const dst = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const cr = new Cairo.Context(dst);
  cr.scale(w / src.getWidth(), h / src.getHeight());
  cr.setSourceSurface(src, 0, 0);
  // GOOD, not the NEAREST the other transforms use: those are pixel-exact
  // (90° rotation, integer-aligned crop), while resampling to a new pixel grid
  // needs interpolation or it aliases badly.
  (cr.getSource() as Cairo.SurfacePattern).setFilter(Cairo.Filter.GOOD);
  cr.paint();
  return dst;
}

// Resamples a Cairo.ImageSurface to (w × h) and returns a fresh surface. Lossy
// and not invertible: scaling down discards pixels, so scaling back up cannot
// recover them.
export function scaleSurface(src: Cairo.ImageSurface, w: number, h: number): Cairo.ImageSurface {
  // Halve repeatedly until the remaining reduction is at most 2:1. A large
  // reduction in a single blit does not average every source pixel into the
  // result, so a regular pattern (a screenshot's 1px rules, dense text) aliases
  // into moire instead of resolving to its average tone: measured on a 1px
  // grid at 20:1, one blit leaves substantially more residual variance than
  // halving does. Halving keeps every step within the neighbourhood the filter
  // actually samples, whatever a given cairo version's is.
  let cur = src;
  while (cur.getWidth() > w * 2 || cur.getHeight() > h * 2) {
    cur = scaleBlit(
      cur,
      Math.max(w, Math.round(cur.getWidth() / 2)),
      Math.max(h, Math.round(cur.getHeight() / 2))
    );
  }
  return scaleBlit(cur, w, h);
}
