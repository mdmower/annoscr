import '@girs/glib-2.0';
import '@girs/gobject-2.0';
import '@girs/gio-2.0';
import '@girs/gdk-4.0';
import '@girs/gtk-4.0';
import '@girs/adw-1';
import '@girs/gdkpixbuf-2.0';
import '@girs/pango-1.0';
import '@girs/pangocairo-1.0';

import type Cairo from 'cairo';

// @girs/gjs declares `class Pattern extends Cairo.Pattern {}` inside a
// non-exported `declare namespace giCairo`, so external module augmentation
// can't merge methods into the class. Pattern methods that GJS exposes at
// runtime but @girs omits from the class shell live here; callers cast with
// `as unknown as CairoPatternExt` at the use site.
export interface CairoPatternExt {
  setExtend(extend: Cairo.Extend): void;
  getExtend(): Cairo.Extend;
  setFilter(filter: Cairo.Filter): void;
  getFilter(): Cairo.Filter;
  setMatrix(matrix: object): void;
  getMatrix(): object;
}
