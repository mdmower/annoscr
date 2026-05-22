import GObject from 'gi://GObject?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import cairo from 'gi://cairo?version=1.0';

import { Action, LiveStroke, ToolId, createLiveStroke } from './actions.js';

type ImageSurface = any;
type DisplayMode = 'fit' | 'actual';

interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export type TextEditRequest = (imageX: number, imageY: number, widgetX: number, widgetY: number) => void;

function isShift(gesture: any): boolean {
  return (gesture.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK) !== 0;
}

function cursorForTool(id: ToolId): string {
  return id === 'text' ? 'text' : 'crosshair';
}

export const CanvasView = GObject.registerClass(
  class CanvasView extends Gtk.DrawingArea {
    private surface: ImageSurface | null = null;
    private mode: DisplayMode = 'fit';

    private actions: Action[] = [];
    private cursor: number = 0;
    private liveStroke: LiveStroke | null = null;
    private currentToolId: ToolId = 'pen';

    private dragStartX: number = 0;
    private dragStartY: number = 0;

    private onTextEditRequest: TextEditRequest | null = null;

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

    setTool(toolId: ToolId): void {
      if (this.currentToolId === toolId) return;
      this.currentToolId = toolId;
      // Cancel any in-progress stroke so the tool change takes effect immediately.
      this.liveStroke = null;
      (this as any).set_cursor_from_name(cursorForTool(toolId));
      this.queue_draw();
    }

    getTool(): ToolId {
      return this.currentToolId;
    }

    setTextEditRequestHandler(handler: TextEditRequest | null): void {
      this.onTextEditRequest = handler;
    }

    addAction(action: Action): void {
      this.actions.length = this.cursor;
      this.actions.push(action);
      this.cursor++;
      this.queue_draw();
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

    private installPointer(): void {
      const drag = new Gtk.GestureDrag();
      drag.set_button(Gdk.BUTTON_PRIMARY);

      drag.connect('drag-begin', (_g: any, x: number, y: number) => {
        this.dragStartX = x;
        this.dragStartY = y;
        this.onPenDown(x, y);
      });
      drag.connect('drag-update', (g: any, dx: number, dy: number) => {
        this.onPenMove(this.dragStartX + dx, this.dragStartY + dy, isShift(g));
      });
      drag.connect('drag-end', (g: any, dx: number, dy: number) => {
        this.onPenUp(this.dragStartX + dx, this.dragStartY + dy, isShift(g));
      });
      (this as any).add_controller(drag);

      const click = new Gtk.GestureClick();
      click.set_button(Gdk.BUTTON_PRIMARY);
      click.connect('pressed', (_g: any, _n: number, x: number, y: number) => {
        this.onCanvasPress(x, y);
      });
      (this as any).add_controller(click);

      (this as any).set_cursor_from_name(cursorForTool(this.currentToolId));
    }

    private onPenDown(wx: number, wy: number): void {
      if (!this.surface) return;
      if (this.currentToolId === 'text') return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke = createLiveStroke(this.currentToolId, ix, iy);
      this.queue_draw();
    }

    private onCanvasPress(wx: number, wy: number): void {
      if (!this.surface) return;
      if (this.currentToolId !== 'text') return;
      if (!this.onTextEditRequest) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.onTextEditRequest(ix, iy, wx, wy);
    }

    private onPenMove(wx: number, wy: number, constrain: boolean): void {
      if (!this.liveStroke) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke.extendTo(ix, iy, constrain);
      this.queue_draw();
    }

    private onPenUp(wx: number, wy: number, constrain: boolean): void {
      if (!this.liveStroke) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke.extendTo(ix, iy, constrain);
      const committed = this.liveStroke.finish();
      if (committed) this.addAction(committed);
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
