import GObject from 'gi://GObject?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import cairo from 'gi://cairo?version=1.0';

import {
  Action,
  Bounds,
  LiveStroke,
  ToolId,
  createLiveStroke,
  isNumberStampAction,
  isTextAction,
  getTextEditState,
  makeNumberStampAction,
} from './actions.js';

type ImageSurface = any;
type DisplayMode = 'fit' | 'actual';

interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface TextEditRequestOptions {
  markup?: string;
  replaceIndex?: number;
}

export type TextEditRequest = (
  imageX: number,
  imageY: number,
  widgetX: number,
  widgetY: number,
  options?: TextEditRequestOptions,
) => void;

function isShift(gesture: any): boolean {
  return (gesture.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK) !== 0;
}

function isDragTool(id: ToolId): boolean {
  return id !== 'select' && id !== 'text' && id !== 'number';
}

function cursorForTool(id: ToolId): string {
  if (id === 'text') return 'text';
  if (id === 'select') return 'default';
  return 'crosshair';
}

function pointInBounds(x: number, y: number, b: Bounds): boolean {
  return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
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

    // Selection state (select tool only).
    private selectedIndex: number = -1;
    private moveDx: number = 0;
    private moveDy: number = 0;
    private moving: boolean = false;
    // Index of an action currently being re-edited; hidden from render
    // (the live editor widget shows in its place).
    private editingActionIndex: number = -1;

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
      this.selectedIndex = -1;
      this.editingActionIndex = -1;
      this.queue_draw();
    }

    clearImage(): void {
      this.surface = null;
      this.actions = [];
      this.cursor = 0;
      this.liveStroke = null;
      this.selectedIndex = -1;
      this.editingActionIndex = -1;
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
      this.liveStroke = null;
      this.selectedIndex = -1;
      this.moving = false;
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

    replaceAction(index: number, action: Action): void {
      if (index < 0 || index >= this.cursor) return;
      this.actions[index] = action;
      if (this.editingActionIndex === index) this.editingActionIndex = -1;
      this.queue_draw();
    }

    clearEditing(): void {
      this.editingActionIndex = -1;
      this.queue_draw();
    }

    deleteSelected(): boolean {
      if (this.selectedIndex < 0 || this.selectedIndex >= this.cursor) return false;
      this.actions.splice(this.selectedIndex, 1);
      this.cursor--;
      this.selectedIndex = -1;
      this.queue_draw();
      return true;
    }

    undo(): void {
      if (this.cursor === 0) return;
      this.cursor--;
      // If the selected action was the one being hidden by undo, drop selection.
      if (this.selectedIndex >= this.cursor) this.selectedIndex = -1;
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
        this.onDragBegin(x, y);
      });
      drag.connect('drag-update', (g: any, dx: number, dy: number) => {
        this.onDragUpdate(this.dragStartX + dx, this.dragStartY + dy, isShift(g));
      });
      drag.connect('drag-end', (g: any, dx: number, dy: number) => {
        this.onDragEnd(this.dragStartX + dx, this.dragStartY + dy, isShift(g));
      });
      (this as any).add_controller(drag);

      const click = new Gtk.GestureClick();
      click.set_button(Gdk.BUTTON_PRIMARY);
      click.connect('pressed', (_g: any, n_press: number, x: number, y: number) => {
        if (n_press === 2 && this.currentToolId === 'select') {
          this.onSelectDoubleClick(x, y);
          return;
        }
        this.onCanvasPress(x, y);
      });
      (this as any).add_controller(click);

      (this as any).set_cursor_from_name(cursorForTool(this.currentToolId));
    }

    private onDragBegin(wx: number, wy: number): void {
      if (!this.surface) return;
      if (this.currentToolId === 'select') {
        const [ix, iy] = this.widgetToImage(wx, wy);
        this.selectedIndex = this.hitTest(ix, iy);
        this.moving = false;
        this.moveDx = 0;
        this.moveDy = 0;
        this.queue_draw();
        return;
      }
      if (!isDragTool(this.currentToolId)) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke = createLiveStroke(this.currentToolId, ix, iy);
      this.queue_draw();
    }

    private onDragUpdate(wx: number, wy: number, constrain: boolean): void {
      if (this.currentToolId === 'select') {
        if (this.selectedIndex < 0) return;
        const t = this.currentTransform();
        this.moveDx = (wx - this.dragStartX) / t.scale;
        this.moveDy = (wy - this.dragStartY) / t.scale;
        if (!this.moving && Math.hypot(wx - this.dragStartX, wy - this.dragStartY) > 3) {
          this.moving = true;
        }
        if (this.moving) this.queue_draw();
        return;
      }
      if (!this.liveStroke) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke.extendTo(ix, iy, constrain);
      this.queue_draw();
    }

    private onDragEnd(wx: number, wy: number, constrain: boolean): void {
      if (this.currentToolId === 'select') {
        if (this.moving && this.selectedIndex >= 0) {
          const moved = this.actions[this.selectedIndex].translate(this.moveDx, this.moveDy);
          this.actions[this.selectedIndex] = moved;
        }
        this.moving = false;
        this.moveDx = 0;
        this.moveDy = 0;
        this.queue_draw();
        return;
      }
      if (!this.liveStroke) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke.extendTo(ix, iy, constrain);
      const committed = this.liveStroke.finish();
      if (committed) this.addAction(committed);
      this.liveStroke = null;
      this.queue_draw();
    }

    private onCanvasPress(wx: number, wy: number): void {
      if (!this.surface) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      if (this.currentToolId === 'text') {
        if (this.onTextEditRequest) this.onTextEditRequest(ix, iy, wx, wy);
      } else if (this.currentToolId === 'number') {
        this.addAction(makeNumberStampAction(ix, iy, this.nextStampNumber()));
      }
    }

    private onSelectDoubleClick(wx: number, wy: number): void {
      if (!this.surface) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      const idx = this.hitTest(ix, iy);
      if (idx < 0) return;
      const action = this.actions[idx];
      if (!isTextAction(action)) return;
      const state = getTextEditState(action);
      if (!state) return;
      this.editingActionIndex = idx;
      this.selectedIndex = -1;
      this.queue_draw();
      if (this.onTextEditRequest) {
        // Re-place the editor at the action's anchor in widget coordinates so
        // the editor visually replaces the hidden action.
        const t = this.currentTransform();
        const wxAnchor = t.offsetX + state.x * t.scale;
        const wyAnchor = t.offsetY + state.y * t.scale;
        this.onTextEditRequest(state.x, state.y, wxAnchor, wyAnchor, {
          markup: state.markup,
          replaceIndex: idx,
        });
      }
    }

    private hitTest(ix: number, iy: number): number {
      for (let i = this.cursor - 1; i >= 0; i--) {
        if (i === this.editingActionIndex) continue;
        const bounds = this.actions[i].getBounds();
        if (bounds && pointInBounds(ix, iy, bounds)) return i;
      }
      return -1;
    }

    private nextStampNumber(): number {
      let count = 0;
      for (let i = 0; i < this.cursor; i++) {
        if (isNumberStampAction(this.actions[i])) count++;
      }
      return count + 1;
    }

    private widgetToImage(x: number, y: number): [number, number] {
      const t = this.currentTransform();
      return [(x - t.offsetX) / t.scale, (y - t.offsetY) / t.scale];
    }

    private currentTransform(): Transform {
      return this.computeTransform((this as any).get_width(), (this as any).get_height());
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
        if (i === this.editingActionIndex) continue;
        if (this.moving && i === this.selectedIndex) {
          cr.save();
          cr.translate(this.moveDx, this.moveDy);
          this.actions[i].draw(cr, t.scale);
          cr.restore();
        } else {
          this.actions[i].draw(cr, t.scale);
        }
      }
      if (this.liveStroke) this.liveStroke.draw(cr, t.scale);

      if (this.selectedIndex >= 0 && this.selectedIndex < this.cursor) {
        const action = this.actions[this.selectedIndex];
        const bounds = action.getBounds();
        if (bounds) {
          const offsetX = this.moving ? this.moveDx : 0;
          const offsetY = this.moving ? this.moveDy : 0;
          drawSelectionBox(cr, bounds, t.scale, offsetX, offsetY);
        }
      }

      cr.restore();
    }
  },
);

function drawSelectionBox(cr: any, bounds: Bounds, scale: number, ox: number, oy: number): void {
  const pad = 4 / scale;
  const lineWidth = 1.5 / scale;
  const dashOn = 6 / scale;
  const dashOff = 4 / scale;

  cr.save();
  cr.setSourceRGBA(0.0, 0.6, 1.0, 0.95);
  cr.setLineWidth(lineWidth);
  cr.setDash([dashOn, dashOff], 0);
  cr.setLineCap(cairo.LineCap.BUTT);
  cr.setLineJoin(cairo.LineJoin.MITER);
  cr.rectangle(
    bounds.x1 + ox - pad,
    bounds.y1 + oy - pad,
    bounds.x2 - bounds.x1 + 2 * pad,
    bounds.y2 - bounds.y1 + 2 * pad,
  );
  cr.stroke();
  cr.restore();
}
