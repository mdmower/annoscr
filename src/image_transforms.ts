import cairo from 'gi://cairo?version=1.0';

export type RotateDirection = 'cw' | 'ccw';

// Rotates a Cairo.ImageSurface by 90° in the given direction and returns a
// fresh surface with swapped dimensions. Pixel-exact (no resampling): the
// 90° transform aligns the source grid with the destination grid.
export function rotateSurface(src: any, direction: RotateDirection): any {
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
  cr.getSource().setFilter(cairo.Filter.NEAREST);
  cr.paint();
  return dst;
}
