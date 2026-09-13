import GLib from 'gi://GLib?version=2.0';
import Cairo from 'cairo';

import {scaleSurface} from './image_transforms.js';

// How long a shrunk image item's on-screen size must stay unchanged before its
// resampled copy is built. A resize drag or zoom changes the size every frame,
// and a build takes tens of milliseconds for a large image.
const SETTLE_MS = 200;

// The live canvas's resampled copies of shrunk image items. scaleSurface is too
// slow to run on every paint, so a paint draws from a copy built for that exact
// size, or, when there is none yet, lets the item filter its source directly
// and requests the copy. Requests are built once the sizes requested stop
// changing for SETTLE_MS, then the canvas repaints.
//
// Usage per paint: beginPaint(), pass `lookup` to every Action.draw, endPaint().
// Copies a paint didn't use are released at its end.
export class ResampleCache {
  private copies = new Map<Cairo.ImageSurface, Map<string, Cairo.ImageSurface>>();
  private used = new Map<Cairo.ImageSurface, Set<string>>();
  private misses = new Map<Cairo.ImageSurface, Map<string, [number, number]>>();
  // The misses the pending build covers, so an unchanged request doesn't
  // restart the delay (repaints from pointer motion would postpone it forever).
  private pendingSignature = '';
  private timerId = 0;
  private surfaceIds = new WeakMap<Cairo.ImageSurface, number>();
  private nextSurfaceId = 1;

  constructor(private readonly onBuilt: () => void) {}

  beginPaint(): void {
    this.used = new Map();
    this.misses = new Map();
  }

  lookup = (src: Cairo.ImageSurface, w: number, h: number): Cairo.ImageSurface | null => {
    const key = `${String(w)}x${String(h)}`;
    const copy = this.copies.get(src)?.get(key);
    if (copy) {
      let keys = this.used.get(src);
      if (!keys) this.used.set(src, (keys = new Set()));
      keys.add(key);
      return copy;
    }
    let sizes = this.misses.get(src);
    if (!sizes) this.misses.set(src, (sizes = new Map<string, [number, number]>()));
    sizes.set(key, [w, h]);
    return null;
  };

  endPaint(): void {
    for (const [src, byKey] of this.copies) {
      const keys = this.used.get(src);
      for (const key of byKey.keys()) if (!keys?.has(key)) byKey.delete(key);
      if (byKey.size === 0) this.copies.delete(src);
    }
    const signature = this.missSignature();
    if (signature === this.pendingSignature) return;
    this.cancelTimer();
    this.pendingSignature = signature;
    if (!signature) return;
    const misses = this.misses;
    this.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
      this.timerId = 0;
      this.pendingSignature = '';
      this.build(misses);
      this.onBuilt();
      return GLib.SOURCE_REMOVE;
    });
  }

  // Release every copy and drop a pending build (the widget is going away).
  clear(): void {
    this.cancelTimer();
    this.pendingSignature = '';
    this.copies.clear();
    this.used.clear();
    this.misses.clear();
  }

  private build(misses: Map<Cairo.ImageSurface, Map<string, [number, number]>>): void {
    for (const [src, sizes] of misses) {
      let byKey = this.copies.get(src);
      if (!byKey) this.copies.set(src, (byKey = new Map<string, Cairo.ImageSurface>()));
      for (const [key, [w, h]] of sizes) byKey.set(key, scaleSurface(src, w, h));
    }
  }

  private missSignature(): string {
    const parts: string[] = [];
    for (const [src, sizes] of this.misses) {
      let id = this.surfaceIds.get(src);
      if (id === undefined) this.surfaceIds.set(src, (id = this.nextSurfaceId++));
      for (const key of sizes.keys()) parts.push(`${String(id)}:${key}`);
    }
    return parts.sort().join(',');
  }

  private cancelTimer(): void {
    if (!this.timerId) return;
    GLib.source_remove(this.timerId);
    this.timerId = 0;
  }
}
