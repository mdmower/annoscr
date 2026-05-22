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
import { cropSurface, rotateSurface } from './image_transforms.js';
import type { RotateDirection } from './actions.js';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  rotation?: number;
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
  return id !== 'select' && id !== 'text' && id !== 'number' && id !== 'crop';
}

function cursorForTool(id: ToolId): string {
  if (id === 'text') return 'text';
  if (id === 'select') return 'default';
  return 'crosshair';
}

function clipCropRegion(r: { x1: number; y1: number; x2: number; y2: number }, imgW: number, imgH: number): CropRect | null {
  const minX = Math.max(0, Math.min(r.x1, r.x2));
  const maxX = Math.min(imgW, Math.max(r.x1, r.x2));
  const minY = Math.max(0, Math.min(r.y1, r.y2));
  const maxY = Math.min(imgH, Math.max(r.y1, r.y2));
  if (maxX <= minX || maxY <= minY) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function pointInBounds(x: number, y: number, b: Bounds): boolean {
  return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
}

interface CanvasState {
  surface: ImageSurface | null;
  actions: ReadonlyArray<Action>;
}

const HISTORY_CAP = 50;

export const CanvasView = GObject.registerClass(
  class CanvasView extends Gtk.DrawingArea {
    // Immutable snapshot history. Each state is {surface, actions}; modifying
    // operations produce a new state and push it. Untouched actions and the
    // surface are shared by reference across states. Capped at HISTORY_CAP to
    // bound memory when rotate/crop allocate new surfaces.
    private history: CanvasState[] = [{ surface: null, actions: [] }];
    private historyCursor: number = 0;

    private mode: DisplayMode = 'fit';

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

    // Raw crop region while in crop mode (image-space coords; not clipped
    // to image bounds until apply).
    private cropRegion: { x1: number; y1: number; x2: number; y2: number } | null = null;

    private onTextEditRequest: TextEditRequest | null = null;

    constructor() {
      super({ hexpand: true, vexpand: true });
      this.set_draw_func(this.onDraw.bind(this));
      this.installPointer();
    }

    private get state(): CanvasState {
      return this.history[this.historyCursor];
    }

    private pushState(next: CanvasState): void {
      // Truncate any redo entries past the cursor before pushing.
      if (this.historyCursor < this.history.length - 1) {
        this.history.length = this.historyCursor + 1;
      }
      this.history.push(next);
      this.historyCursor++;
      if (this.history.length > HISTORY_CAP) {
        const excess = this.history.length - HISTORY_CAP;
        this.history.splice(0, excess);
        this.historyCursor -= excess;
      }
    }

    private resetTransientState(): void {
      this.liveStroke = null;
      this.selectedIndex = -1;
      this.editingActionIndex = -1;
      this.moving = false;
      this.moveDx = 0;
      this.moveDy = 0;
      this.cropRegion = null;
    }

    setImage(surface: ImageSurface): void {
      this.history = [{ surface, actions: [] }];
      this.historyCursor = 0;
      this.resetTransientState();
      this.queue_draw();
    }

    clearImage(): void {
      this.history = [{ surface: null, actions: [] }];
      this.historyCursor = 0;
      this.resetTransientState();
      this.queue_draw();
    }

    setMode(mode: DisplayMode): void {
      if (this.mode === mode) return;
      this.mode = mode;
      this.queue_draw();
    }

    hasImage(): boolean {
      return this.state.surface !== null;
    }

    setTool(toolId: ToolId): void {
      if (this.currentToolId === toolId) return;
      this.currentToolId = toolId;
      this.liveStroke = null;
      this.selectedIndex = -1;
      this.moving = false;
      if (toolId !== 'crop') this.cropRegion = null;
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
      this.pushState({
        surface: this.state.surface,
        actions: [...this.state.actions, action],
      });
      this.queue_draw();
    }

    replaceAction(index: number, action: Action): void {
      const cur = this.state.actions;
      if (index < 0 || index >= cur.length) return;
      this.pushState({
        surface: this.state.surface,
        actions: cur.map((a, i) => (i === index ? action : a)),
      });
      if (this.editingActionIndex === index) this.editingActionIndex = -1;
      this.queue_draw();
    }

    clearEditing(): void {
      this.editingActionIndex = -1;
      this.queue_draw();
    }

    deleteSelected(): boolean {
      const cur = this.state.actions;
      if (this.selectedIndex < 0 || this.selectedIndex >= cur.length) return false;
      const removeAt = this.selectedIndex;
      this.pushState({
        surface: this.state.surface,
        actions: cur.filter((_, i) => i !== removeAt),
      });
      this.selectedIndex = -1;
      this.queue_draw();
      return true;
    }

    // Returns the clipped crop region if one is defined and non-degenerate.
    getCropRect(): CropRect | null {
      const s = this.state.surface;
      if (!this.cropRegion || !s) return null;
      return clipCropRegion(this.cropRegion, s.getWidth(), s.getHeight());
    }

    // Apply the current crop region: replace surface with the cropped piece
    // and translate every action by (-cropX, -cropY). Returns true if a crop
    // was applied; false if there was nothing to crop.
    applyCrop(): boolean {
      const rect = this.getCropRect();
      const s = this.state.surface;
      if (!rect || !s) return false;
      this.pushState({
        surface: cropSurface(s, rect.x, rect.y, rect.w, rect.h),
        actions: this.state.actions.map(a => a.translate(-rect.x, -rect.y)),
      });
      this.cropRegion = null;
      this.liveStroke = null;
      this.selectedIndex = -1;
      this.editingActionIndex = -1;
      this.queue_draw();
      return true;
    }

    cancelCrop(): void {
      this.cropRegion = null;
      this.queue_draw();
    }

    // Rotate the source surface and every action together (positions follow
    // the image; text and number-stamp content rotates too).
    rotate(direction: RotateDirection): void {
      const s = this.state.surface;
      if (!s) return;
      const oldW = s.getWidth();
      const oldH = s.getHeight();
      this.pushState({
        surface: rotateSurface(s, direction),
        actions: this.state.actions.map(a => a.rotateOnImage(direction, oldW, oldH)),
      });
      this.liveStroke = null;
      this.selectedIndex = -1;
      this.editingActionIndex = -1;
      this.queue_draw();
    }

    undo(): void {
      if (this.historyCursor === 0) return;
      this.historyCursor--;
      this.resetTransientState();
      this.queue_draw();
    }

    redo(): void {
      if (this.historyCursor >= this.history.length - 1) return;
      this.historyCursor++;
      this.resetTransientState();
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
      if (!this.state.surface) return;
      if (this.currentToolId === 'select') {
        const [ix, iy] = this.widgetToImage(wx, wy);
        this.selectedIndex = this.hitTest(ix, iy);
        this.moving = false;
        this.moveDx = 0;
        this.moveDy = 0;
        this.queue_draw();
        return;
      }
      if (this.currentToolId === 'crop') {
        const [ix, iy] = this.widgetToImage(wx, wy);
        this.cropRegion = { x1: ix, y1: iy, x2: ix, y2: iy };
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
      if (this.currentToolId === 'crop') {
        if (!this.cropRegion) return;
        const [ix, iy] = this.widgetToImage(wx, wy);
        this.cropRegion.x2 = ix;
        this.cropRegion.y2 = iy;
        this.queue_draw();
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
          const cur = this.state.actions;
          const i = this.selectedIndex;
          const dx = this.moveDx;
          const dy = this.moveDy;
          const moved = cur[i].translate(dx, dy);
          this.pushState({
            surface: this.state.surface,
            actions: cur.map((a, j) => (j === i ? moved : a)),
          });
        }
        this.moving = false;
        this.moveDx = 0;
        this.moveDy = 0;
        this.queue_draw();
        return;
      }
      if (this.currentToolId === 'crop') {
        if (!this.cropRegion) return;
        const [ix, iy] = this.widgetToImage(wx, wy);
        this.cropRegion.x2 = ix;
        this.cropRegion.y2 = iy;
        // Drop the region if it collapsed to nothing (clicked without dragging).
        if (this.getCropRect() === null) this.cropRegion = null;
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
      if (!this.state.surface) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      if (this.currentToolId === 'text') {
        if (this.onTextEditRequest) this.onTextEditRequest(ix, iy, wx, wy);
      } else if (this.currentToolId === 'number') {
        this.addAction(makeNumberStampAction(ix, iy, this.nextStampNumber()));
      }
    }

    private onSelectDoubleClick(wx: number, wy: number): void {
      if (!this.state.surface) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      const idx = this.hitTest(ix, iy);
      if (idx < 0) return;
      const action = this.state.actions[idx];
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
          rotation: state.rotation,
        });
      }
    }

    private hitTest(ix: number, iy: number): number {
      const acts = this.state.actions;
      for (let i = acts.length - 1; i >= 0; i--) {
        if (i === this.editingActionIndex) continue;
        const bounds = acts[i].getBounds();
        if (bounds && pointInBounds(ix, iy, bounds)) return i;
      }
      return -1;
    }

    private nextStampNumber(): number {
      const acts = this.state.actions;
      let count = 0;
      for (let i = 0; i < acts.length; i++) {
        if (isNumberStampAction(acts[i])) count++;
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
      const s = this.state.surface;
      if (!s) return { scale: 1, offsetX: 0, offsetY: 0 };
      const imgW = s.getWidth();
      const imgH = s.getHeight();
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

      const s = this.state.surface;
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

      const acts = this.state.actions;
      for (let i = 0; i < acts.length; i++) {
        if (i === this.editingActionIndex) continue;
        if (this.moving && i === this.selectedIndex) {
          cr.save();
          cr.translate(this.moveDx, this.moveDy);
          acts[i].draw(cr, t.scale);
          cr.restore();
        } else {
          acts[i].draw(cr, t.scale);
        }
      }
      if (this.liveStroke) this.liveStroke.draw(cr, t.scale);

      if (this.selectedIndex >= 0 && this.selectedIndex < acts.length) {
        const bounds = acts[this.selectedIndex].getBounds();
        if (bounds) {
          const offsetX = this.moving ? this.moveDx : 0;
          const offsetY = this.moving ? this.moveDy : 0;
          drawSelectionBox(cr, bounds, t.scale, offsetX, offsetY);
        }
      }

      if (this.currentToolId === 'crop') {
        const clipped = this.getCropRect();
        drawCropOverlay(cr, imgW, imgH, clipped, t.scale);
      }

      cr.restore();
    }
  },
);

function drawCropOverlay(cr: any, imgW: number, imgH: number, rect: CropRect | null, scale: number): void {
  cr.save();

  // Dim everything in image bounds, "punching out" the crop region via
  // EVEN_ODD fill so the kept area shows through clearly.
  cr.setSourceRGBA(0, 0, 0, 0.5);
  cr.rectangle(0, 0, imgW, imgH);
  if (rect) cr.rectangle(rect.x, rect.y, rect.w, rect.h);
  cr.setFillRule(cairo.FillRule.EVEN_ODD);
  cr.fill();

  // Dashed border around the kept region.
  if (rect) {
    cr.setSourceRGBA(1, 1, 1, 0.95);
    cr.setLineWidth(1.5 / scale);
    cr.setDash([6 / scale, 4 / scale], 0);
    cr.setLineCap(cairo.LineCap.BUTT);
    cr.setLineJoin(cairo.LineJoin.MITER);
    cr.rectangle(rect.x, rect.y, rect.w, rect.h);
    cr.stroke();
  }

  cr.restore();
}

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
