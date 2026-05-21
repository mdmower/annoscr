import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import cairo from 'gi://cairo?version=1.0';

type ImageSurface = any;
type DisplayMode = 'fit' | 'actual';

export const CanvasView = GObject.registerClass(
  class CanvasView extends Gtk.DrawingArea {
    private surface: ImageSurface | null = null;
    private mode: DisplayMode = 'fit';

    constructor() {
      super({ hexpand: true, vexpand: true });
      this.set_draw_func(this.onDraw.bind(this));
    }

    setImage(surface: ImageSurface): void {
      this.surface = surface;
      this.queue_draw();
    }

    clearImage(): void {
      this.surface = null;
      this.queue_draw();
    }

    setMode(mode: DisplayMode): void {
      if (this.mode === mode) return;
      this.mode = mode;
      this.queue_draw();
    }

    hasImage(): boolean {
      return this.surface !== null;
    }

    private onDraw(_widget: any, cr: any, widgetW: number, widgetH: number): void {
      cr.setSourceRGB(0.12, 0.12, 0.12);
      cr.paint();

      const s = this.surface;
      if (!s) return;

      const imgW = s.getWidth();
      const imgH = s.getHeight();
      if (imgW <= 0 || imgH <= 0) return;

      // Fit-to-window scales down only; a smaller-than-window image stays at
      // 1:1 so it's pixel-identical to the source.
      const scale = this.mode === 'actual'
        ? 1
        : Math.min(widgetW / imgW, widgetH / imgH, 1);

      cr.save();

      if (scale === 1) {
        const offsetX = Math.floor((widgetW - imgW) / 2);
        const offsetY = Math.floor((widgetH - imgH) / 2);
        cr.setSourceSurface(s, offsetX, offsetY);
        cr.getSource().setFilter(cairo.Filter.NEAREST);
      } else {
        const drawW = imgW * scale;
        const drawH = imgH * scale;
        const offsetX = (widgetW - drawW) / 2;
        const offsetY = (widgetH - drawH) / 2;
        cr.translate(offsetX, offsetY);
        cr.scale(scale, scale);
        cr.setSourceSurface(s, 0, 0);
        cr.getSource().setFilter(cairo.Filter.BILINEAR);
      }

      cr.paint();
      cr.restore();
    }
  },
);
