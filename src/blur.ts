import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';

import {blurShape, type Action} from './actions.js';

// A box shape's blur is three box-blur passes per axis, which approximate a
// Gaussian with σ² = r(r + 1). The passes run on a copy of the region beneath
// the shape scaled down until σ is PASS_SIGMA working pixels, so the cost
// doesn't grow with the strength; the result is smooth enough at that scale
// that a bilinear upscale shows no grid.
const PASS_RADIUS = 3;
const PASS_SIGMA = Math.sqrt(PASS_RADIUS * (PASS_RADIUS + 1));

// A blurred copy of the image-space rectangle (x, y, w, h), at sx × sy working
// pixels per image pixel.
export interface BlurredRegion {
  surface: Cairo.ImageSurface;
  x: number;
  y: number;
  w: number;
  h: number;
  sx: number;
  sy: number;
}

// Blurred backdrops by blurred action, reused while the base image and every
// action drawn beneath are the same objects. Actions are immutable, so object
// identity is enough to tell that nothing beneath has changed.
export class BlurCache {
  private entries = new Map<
    Action,
    {source: Cairo.ImageSurface; below: Action[]; region: BlurredRegion | null}
  >();
  private used = new Set<Action>();

  // The blurred backdrop of drawn[index]: the base image plus drawn[0..index).
  lookup(
    source: Cairo.ImageSurface,
    drawn: ReadonlyArray<Action>,
    index: number
  ): BlurredRegion | null {
    const action = drawn[index];
    this.used.add(action);
    const hit = this.entries.get(action);
    if (hit?.source === source && sameActions(hit.below, drawn, index)) return hit.region;
    const region = blurBackdrop(source, drawn, index, this);
    this.entries.set(action, {source, below: drawn.slice(0, index), region});
    return region;
  }

  // Release the entries no lookup asked for since the last sweep.
  sweep(): void {
    for (const action of this.entries.keys()) {
      if (!this.used.has(action)) this.entries.delete(action);
    }
    this.used.clear();
  }
}

function sameActions(below: Action[], drawn: ReadonlyArray<Action>, count: number): boolean {
  if (below.length !== count) return false;
  for (let i = 0; i < count; i++) if (below[i] !== drawn[i]) return false;
  return true;
}

// Paint drawn[index]'s blurred backdrop inside its outline, replacing what's
// there: composited over it, the sharp content would show through wherever
// the backdrop is translucent. The region is cleared first, or covered with
// `underlay` when the target needs an opaque background (the canvas's
// checkerboard). Clearing and painting share one clip, so the outline's
// antialiased edge gets complementary shares. No-op without a blur.
export function paintBlur(
  cr: Cairo.Context,
  source: Cairo.ImageSurface,
  drawn: ReadonlyArray<Action>,
  index: number,
  cache: BlurCache,
  underlay: Cairo.Pattern | null
): void {
  const shape = blurShape(drawn[index]);
  if (!shape) return;
  const region = cache.lookup(source, drawn, index);
  if (!region) return;
  cr.save();
  cr.rectangle(region.x, region.y, region.w, region.h);
  cr.clip();
  shape.appendOutline(cr);
  cr.clip();
  if (underlay) {
    cr.setSource(underlay);
    cr.paint();
  } else {
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.ADD);
  }
  cr.translate(region.x, region.y);
  cr.scale(1 / region.sx, 1 / region.sy);
  cr.setSourceSurface(region.surface, 0, 0);
  const pattern = cr.getSource() as Cairo.SurfacePattern;
  pattern.setFilter(Cairo.Filter.BILINEAR);
  // PAD so the upscale doesn't fade the region's edge pixels into transparency.
  pattern.setExtend(Cairo.Extend.PAD);
  cr.paint();
  cr.restore();
}

// Render the base image and drawn[0..index) beneath drawn[index]'s bounds,
// padded by the blur's reach and cut to the image, then blur it. The image's
// edge is extended rather than faded, as the output is cut there anyway.
// Null when the shape lies outside the image.
function blurBackdrop(
  source: Cairo.ImageSurface,
  drawn: ReadonlyArray<Action>,
  index: number,
  cache: BlurCache
): BlurredRegion | null {
  const shape = blurShape(drawn[index]);
  if (!shape) return null;
  const scale = Math.min(1, PASS_SIGMA / shape.sigma);
  const sigma = shape.sigma * scale;
  const r = Math.max(1, Math.round((Math.sqrt(1 + 4 * sigma * sigma) - 1) / 2));
  // Three passes of radius r reach 3r working pixels.
  const pad = (3 * r) / scale + 1;
  const {bounds} = shape;
  const x = Math.max(0, Math.floor(bounds.x1 - pad));
  const y = Math.max(0, Math.floor(bounds.y1 - pad));
  const x2 = Math.min(source.getWidth(), Math.ceil(bounds.x2 + pad));
  const y2 = Math.min(source.getHeight(), Math.ceil(bounds.y2 + pad));
  const w = x2 - x;
  const h = y2 - y;
  if (w <= 0 || h <= 0) return null;
  // Whole working pixels spanning the region exactly, so none hangs past the
  // image's edge and pulls transparency into the blur.
  const ww = Math.max(1, Math.ceil(w * scale));
  const wh = Math.max(1, Math.ceil(h * scale));
  const sx = ww / w;
  const sy = wh / h;

  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, ww, wh);
  const cr = new Cairo.Context(surface);
  cr.scale(sx, sy);
  cr.translate(-x, -y);
  cr.setSourceSurface(source, 0, 0);
  cr.paint();
  for (let i = 0; i < index; i++) {
    paintBlur(cr, source, drawn, i, cache, null);
    drawn[i].draw(cr, Math.min(sx, sy));
  }
  surface.flush();
  return {surface: boxBlurSurface(surface, r), x, y, w, h, sx, sy};
}

// Three box-blur passes of radius r per axis over the surface's pixels, with
// the edge pixels extended. The passes run on premultiplied values, so
// transparent pixels don't darken their neighbors.
function boxBlurSurface(surface: Cairo.ImageSurface, r: number): Cairo.ImageSurface {
  const w = surface.getWidth();
  const h = surface.getHeight();
  // Cairo's pixel accessors aren't exposed in GJS; see surfacePixbuf in
  // exporter.ts.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const pixbuf = Gdk.pixbuf_get_from_surface(surface, 0, 0, w, h);
  if (!pixbuf) return surface;
  const src = pixbuf.get_pixels();
  const stride = pixbuf.get_rowstride();
  const channels = pixbuf.get_n_channels();
  let a = new Float32Array(w * h * 4);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const s = py * stride + px * channels;
      const d = (py * w + px) * 4;
      const alpha = channels === 4 ? src[s + 3] : 255;
      a[d] = (src[s] * alpha) / 255;
      a[d + 1] = (src[s + 1] * alpha) / 255;
      a[d + 2] = (src[s + 2] * alpha) / 255;
      a[d + 3] = alpha;
    }
  }
  let b = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurLines(a, b, h, w, 4, w * 4, r);
    [a, b] = [b, a];
  }
  for (let pass = 0; pass < 3; pass++) {
    boxBlurLines(a, b, w, h, w * 4, 4, r);
    [a, b] = [b, a];
  }
  const out = new Uint8Array(w * h * 4);
  for (let d = 0; d < out.length; d += 4) {
    const alpha = a[d + 3];
    if (alpha <= 0) continue;
    const k = 255 / alpha;
    out[d] = Math.min(255, Math.round(a[d] * k));
    out[d + 1] = Math.min(255, Math.round(a[d + 1] * k));
    out[d + 2] = Math.min(255, Math.round(a[d + 2] * k));
    out[d + 3] = Math.min(255, Math.round(alpha));
  }
  const blurred = GdkPixbuf.Pixbuf.new_from_bytes(
    out,
    GdkPixbuf.Colorspace.RGB,
    true,
    8,
    w,
    h,
    w * 4
  );
  const result = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
  const cr = new Cairo.Context(result);
  // Deprecated for the same reason; see loadFromPixbuf in image_loader.ts.
  Gdk.cairo_set_source_pixbuf(cr, blurred, 0, 0);
  cr.paint();
  result.flush();
  return result;
}

// One box-blur pass along `lines` lines of `len` RGBA pixels each, from `src`
// into `dst`. A pixel steps `step` floats along a line and a line `lineStep`
// floats to the next, so the same loop runs rows (4, w·4) and columns (w·4, 4).
function boxBlurLines(
  src: Float32Array,
  dst: Float32Array,
  lines: number,
  len: number,
  step: number,
  lineStep: number,
  r: number
): void {
  const norm = 1 / (2 * r + 1);
  const last = len - 1;
  for (let line = 0; line < lines; line++) {
    const base = line * lineStep;
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0;
    for (let k = -r; k <= r; k++) {
      const o = base + Math.min(Math.max(k, 0), last) * step;
      s0 += src[o];
      s1 += src[o + 1];
      s2 += src[o + 2];
      s3 += src[o + 3];
    }
    for (let i = 0; i < len; i++) {
      const o = base + i * step;
      dst[o] = s0 * norm;
      dst[o + 1] = s1 * norm;
      dst[o + 2] = s2 * norm;
      dst[o + 3] = s3 * norm;
      const add = base + Math.min(i + r + 1, last) * step;
      const sub = base + Math.max(i - r, 0) * step;
      s0 += src[add] - src[sub];
      s1 += src[add + 1] - src[sub + 1];
      s2 += src[add + 2] - src[sub + 2];
      s3 += src[add + 3] - src[sub + 3];
    }
  }
}
