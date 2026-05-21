import GObject from 'gi://GObject?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import cairo from 'gi://cairo?version=1.0';

import { Action, PenAction, DEFAULT_PEN_STYLE } from './actions.js';

type ImageSurface = any;
type DisplayMode = 'fit' | 'actual';

interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export const CanvasView = GObject.registerClass(
  class CanvasView extends Gtk.DrawingArea {
    private surface: ImageSurface | null = null;
    private mode: DisplayMode = 'fit';

    private actions: Action[] = [];
    private cursor: number = 0;
    private liveStroke: PenAction | null = null;

    private dragStartX: number = 0;
    private dragStartY: number = 0;

    constructor() {
      super({ hexpand: true, vexpand: true });
      this.set_draw_func(this.onDraw.bind(this));
      this.installPointer();
    }

    setImage(surface: ImageSurface): void {
      this.surface = surface;
      this.actions = [];
      this.cursor = 0;
      this.liveStroke = null;
      this.queue_draw();
    }

    clearImage(): void {
      this.surface = null;
      this.actions = [];
      this.cursor = 0;
      this.liveStroke = null;
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

    undo(): void {
      if (this.cursor === 0) return;
      this.cursor--;
      this.queue_draw();
    }

    redo(): void {
      if (this.cursor === this.actions.length) return;
      this.cursor++;
      this.queue_draw();
    }

    private addAction(action: Action): void {
      this.actions.length = this.cursor;
      this.actions.push(action);
      this.cursor++;
    }

    private installPointer(): void {
      const drag = new Gtk.GestureDrag();
      drag.set_button(Gdk.BUTTON_PRIMARY);

      drag.connect('drag-begin', (_g: any, x: number, y: number) => {
        this.dragStartX = x;
        this.dragStartY = y;
        this.onPenDown(x, y);
      });
      drag.connect('drag-update', (_g: any, dx: number, dy: number) => {
        this.onPenMove(this.dragStartX + dx, this.dragStartY + dy);
      });
      drag.connect('drag-end', (_g: any, dx: number, dy: number) => {
        this.onPenUp(this.dragStartX + dx, this.dragStartY + dy);
      });

      (this as any).add_controller(drag);
      (this as any).set_cursor_from_name('crosshair');
    }

    private onPenDown(wx: number, wy: number): void {
      if (!this.surface) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke = new PenAction(DEFAULT_PEN_STYLE);
      this.liveStroke.addPoint(ix, iy);
      this.queue_draw();
    }

    private onPenMove(wx: number, wy: number): void {
      if (!this.liveStroke) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke.addPoint(ix, iy);
      this.queue_draw();
    }

    private onPenUp(wx: number, wy: number): void {
      if (!this.liveStroke) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke.addPoint(ix, iy);
      if (this.liveStroke.pointCount() >= 2) {
        this.addAction(this.liveStroke);
      }
      this.liveStroke = null;
      this.queue_draw();
    }

    private widgetToImage(x: number, y: number): [number, number] {
      const t = this.computeTransform((this as any).get_width(), (this as any).get_height());
      return [(x - t.offsetX) / t.scale, (y - t.offsetY) / t.scale];
    }

    private computeTransform(widgetW: number, widgetH: number): Transform {
      if (!this.surface) return { scale: 1, offsetX: 0, offsetY: 0 };
      const imgW = this.surface.getWidth();
      const imgH = this.surface.getHeight();
      const scale = this.mode === 'actual'
        ? 1
        : Math.min(widgetW / imgW, widgetH / imgH, 1);
      const drawW = imgW * scale;
      const drawH = imgH * scale;
      return {
        scale,
        offsetX: Math.floor((widgetW - drawW) / 2),
        offsetY: Math.floor((widgetH - drawH) / 2),
      };
    }

    private onDraw(_widget: any, cr: any, widgetW: number, widgetH: number): void {
      cr.setSourceRGB(0.12, 0.12, 0.12);
      cr.paint();

      const s = this.surface;
      if (!s) return;

      const imgW = s.getWidth();
      const imgH = s.getHeight();
      if (imgW <= 0 || imgH <= 0) return;

      const t = this.computeTransform(widgetW, widgetH);

      cr.save();
      cr.translate(t.offsetX, t.offsetY);
      if (t.scale !== 1) cr.scale(t.scale, t.scale);

      cr.setSourceSurface(s, 0, 0);
      cr.getSource().setFilter(t.scale === 1 ? cairo.Filter.NEAREST : cairo.Filter.BILINEAR);
      cr.paint();

      for (let i = 0; i < this.cursor; i++) {
        this.actions[i].draw(cr, t.scale);
      }
      if (this.liveStroke) this.liveStroke.draw(cr, t.scale);

      cr.restore();
    }
  },
);
