import GObject from 'gi://GObject?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Cairo from 'cairo';

import type {EditorSize} from './actions.js';

import {
  Action,
  Bounds,
  ColorRGBA,
  DashStyle,
  DEFAULT_DASH,
  DEFAULT_STAMP_VARIANT,
  LiveStroke,
  StampVariant,
  ToolId,
  TRANSPARENT_FILL,
  createLiveStroke,
  defaultColorForTool,
  defaultDashForTool,
  defaultFillForTool,
  defaultFontDescForTool,
  defaultFontSizeForTool,
  defaultWidthForTool,
  isNumberStampAction,
  isTextAction,
  getTextEditState,
  makeNumberStampAction,
  numberStampStyle,
  renumberStamps,
  setStampVariantOnAll,
} from './actions.js';
import {resizeSurface, rotateSurface} from './image_transforms.js';
import {renderToSurface} from './exporter.js';
import type {RotateDirection} from './actions.js';
import type {ToolStyleEntry, ToolStylesSnapshot} from './settings.js';

export interface ResizeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Zoom range for the fixed-zoom slider/keys. Fit mode computes its own scale
// outside this range and enlarges a small image past 1:1.
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface TextEditRequestOptions {
  markup?: string;
  replaceIndex?: number;
  rotation?: number;
  editorSize?: EditorSize;
}

export type TextEditRequest = (
  imageX: number,
  imageY: number,
  widgetX: number,
  widgetY: number,
  options?: TextEditRequestOptions
) => void;

function isShift(gesture: Gtk.GestureDrag): boolean {
  return (gesture.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK) !== 0;
}

function isDragTool(id: ToolId): boolean {
  return id !== 'select' && id !== 'text' && id !== 'number' && id !== 'resize';
}

function cursorForTool(id: ToolId): string {
  if (id === 'text') return 'text';
  if (id === 'select') return 'default';
  return 'crosshair';
}

function normalizeRegion(r: {x1: number; y1: number; x2: number; y2: number}): ResizeRect | null {
  const minX = Math.min(r.x1, r.x2);
  const maxX = Math.max(r.x1, r.x2);
  const minY = Math.min(r.y1, r.y2);
  const maxY = Math.max(r.y1, r.y2);
  if (maxX - minX < 1 || maxY - minY < 1) return null;
  return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
}

function pointInBounds(x: number, y: number, b: Bounds): boolean {
  return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
}

// Structural equality for style values (color arrays or scalar primitives).
// Used to skip no-op edits that would otherwise push an invisible undo step.
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

interface CanvasState {
  surface: Cairo.ImageSurface | null;
  actions: ReadonlyArray<Action>;
}

const HISTORY_CAP = 100;

// Widget-space hit tolerance for resize edge/corner grabs.
const HANDLE_HIT_PX = 8;

// Accumulated scroll delta required to dig one step deeper in the hit-stack.
// A plain mouse wheel reports ~1.0 per notch (so one notch = one step); the
// accumulator also smooths a touchpad's many small fractions into whole steps.
// The [ and ] keys are the precise, one-step-per-press alternative.
const SCROLL_DIG_STEP = 1;

// Image-space cell size for the transparency checkerboard. Cells appear
// 8 widget pixels wide at 1:1 zoom, larger when zoomed in, smaller when
// zoomed out — same convention as Photoshop / GIMP.
const CHECKER_CELL = 8;

let CHECKER_PATTERN: Cairo.SurfacePattern | null = null;
function getCheckerPattern(): Cairo.SurfacePattern {
  if (CHECKER_PATTERN) return CHECKER_PATTERN;
  const size = CHECKER_CELL * 2;
  const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, size, size);
  const cr = new Cairo.Context(surf);
  cr.setSourceRGB(0.95, 0.95, 0.95);
  cr.paint();
  cr.setSourceRGB(0.85, 0.85, 0.85);
  cr.rectangle(0, 0, CHECKER_CELL, CHECKER_CELL);
  cr.rectangle(CHECKER_CELL, CHECKER_CELL, CHECKER_CELL, CHECKER_CELL);
  cr.fill();
  const p = new Cairo.SurfacePattern(surf);
  p.setExtend(Cairo.Extend.REPEAT);
  p.setFilter(Cairo.Filter.NEAREST);
  CHECKER_PATTERN = p;
  return p;
}

type ResizeGrab = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r' | 'inside' | 'outside';

function cursorForResizeGrab(grab: ResizeGrab): string {
  switch (grab) {
    case 'tl':
    case 'br':
      return 'nwse-resize';
    case 'tr':
    case 'bl':
      return 'nesw-resize';
    case 't':
    case 'b':
      return 'ns-resize';
    case 'l':
    case 'r':
      return 'ew-resize';
    // Inside the bounded region (but not on a handle) and outside it both
    // start a fresh region — same gesture, same cursor.
    case 'inside':
    case 'outside':
      return 'crosshair';
    default:
      throw new Error('Unrecognized resize grab');
  }
}

export const CanvasView = GObject.registerClass(
  {GTypeName: 'CanvasView'},
  class extends Gtk.DrawingArea {
    // Immutable snapshot history. Each state is {surface, actions}; modifying
    // operations produce a new state and push it. Untouched actions and the
    // surface are shared by reference across states. Capped at HISTORY_CAP to
    // bound memory when rotate/resize allocate new surfaces.
    private history: CanvasState[] = [{surface: null, actions: []}];
    private historyCursor: number = 0;

    // 'fit' auto-scales the image to fill the viewport, enlarging a small image
    // past 1:1. 'fixed' renders at exactly zoomFactor, with scrollbars when it
    // exceeds the view.
    private mode: 'fit' | 'fixed' = 'fit';
    private zoomFactor: number = 1;

    // Last known pointer position in widget-local coords, for cursor-anchored
    // zoom. null when the pointer is outside the widget.
    private lastPointer: [number, number] | null = null;

    private liveStroke: LiveStroke | null = null;
    private currentToolId: ToolId = 'pen';

    private dragStartX: number = 0;
    private dragStartY: number = 0;

    // Selection state (select tool only). A set of action indices, in
    // insertion order (first-picked first — the style bar uses that order for
    // its "first selected value" display). Single-selection is just a set of
    // size 1; multi-select adds/removes members via Shift-click.
    private selectedIndices: Set<number> = new Set();
    private moveDx: number = 0;
    private moveDy: number = 0;
    private moving: boolean = false;
    // True while the active drag began as a Shift-click toggle, so it adjusts
    // membership only and never turns into a move (a Shift-click is a toggle
    // gesture, not a grab).
    private shiftToggleDrag: boolean = false;

    // "Aim" state for digging through overlapping actions (select tool). The
    // hover candidate is the action the next click acts on, drawn with a
    // distinct outline. `digDepth` indexes into the hit-stack under the
    // pointer; Alt+scroll changes it, and it resets to the top whenever the
    // pointer moves onto a different stack (tracked by `digStackKey`).
    // `scrollAccum` integrates fractional touchpad scroll into whole steps.
    private hoverCandidate: number = -1;
    private digDepth: number = 0;
    private digStackKey: string = '';
    private scrollAccum: number = 0;
    // Index of an action currently being re-edited; hidden from render
    // (the live editor widget shows in its place).
    private editingActionIndex: number = -1;

    // Raw resize region while in resize mode (image-space coords; may extend
    // outside current image bounds in any direction).
    private resizeRegion: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    } | null = null;

    // Tracks which edges/corners of the resize region the active drag is
    // grabbing. null when not currently dragging in resize mode.
    private resizeGrab: ResizeGrab | null = null;

    private onTextEditRequest: TextEditRequest | null = null;
    private onStateChange: (() => void) | null = null;

    // Per-tool current color. Drawing a new action reads from here; the color
    // picker writes here for the active tool. select and resize have no
    // editable color, so they never get an entry.
    private toolColors: Map<ToolId, ColorRGBA> = new Map();

    // Per-tool current stroke/outline width. Same lifetime story as
    // toolColors; tools without a width (text, number, select, resize)
    // never have an entry here.
    private toolWidths: Map<ToolId, number> = new Map();

    // Per-tool current fill color. Only rect, oval, number, and resize have an
    // editable fill; the other tools never get an entry.
    private toolFills: Map<ToolId, ColorRGBA> = new Map();

    // Per-tool current dash style. Only line, arrow, rect, oval have entries
    // here; everything else has no editable dash (returns null).
    private toolDashes: Map<ToolId, DashStyle> = new Map();

    // Variant applied to newly-placed number stamps. The Variant dropdown
    // both updates this (so subsequent placements inherit) and rewrites
    // every existing stamp via setStampVariant().
    private toolStampVariant: StampVariant = DEFAULT_STAMP_VARIANT;

    // Per-tool current font description. Only 'text' has an entry today;
    // other tools have no editable font and return null from getToolFontDesc.
    private toolFontDescs: Map<ToolId, string> = new Map();

    // Per-tool current font size (image-space pixels). Only 'text' has an
    // entry today; other tools return null from getToolFontSize.
    private toolFontSizes: Map<ToolId, number> = new Map();

    // Reference-equality marker for "clean": the canvas state that matches
    // the most recent save or fresh-image-load. If the current state
    // is the same object, nothing has been modified since. Stays valid
    // across undo/redo because those just move the historyCursor — the
    // underlying state object in `history[i]` doesn't change.
    private cleanStateRef: CanvasState | null = null;

    // Last pushState's coalesce key. Successive pushes with the same key
    // replace the top entry instead of growing history (the slider drag
    // case — one history entry per drag, not per tick). Any push without
    // a key, or with a different key, breaks the chain. Operations that
    // don't push but should still break the chain (undo/redo/setTool/...
    // /selection change) clear it explicitly.
    private lastCoalesceKey: string | null = null;

    // Set on setImage; the initial zoom (1:1 if the image fits the viewport,
    // else fit) is chosen once the widget has a real allocation. Deferred
    // because the viewport size isn't known until the first resize.
    private pendingInitialZoom: boolean = false;

    // Handler id for the StyleManager::notify::dark connection, held so it can
    // be disconnected on unrealize (0 = not connected).
    private darkHandlerId: number = 0;

    constructor() {
      super({hexpand: true, vexpand: true});
      this.set_draw_func(this.onDraw.bind(this));
      this.connect('resize', () => this.maybeApplyInitialZoom());
      // Repaint the backdrop when the effective light/dark state flips (system
      // change or the Preferences color-scheme picker). The StyleManager is a
      // process-global singleton, so connect/disconnect on realize/unrealize to
      // bind the closure to this widget's lifetime instead of the singleton's
      // (otherwise the handler would pin the canvas for the whole app run). The
      // draw path reads get_dark() live, so missing notifications while
      // unrealized is harmless — the next paint picks up the current state.
      this.connect('realize', () => {
        if (this.darkHandlerId) return;
        this.darkHandlerId = Adw.StyleManager.get_default().connect('notify::dark', () =>
          this.queue_draw()
        );
      });
      this.connect('unrealize', () => {
        if (!this.darkHandlerId) return;
        Adw.StyleManager.get_default().disconnect(this.darkHandlerId);
        this.darkHandlerId = 0;
      });
      this.installPointer();
    }

    private get state(): CanvasState {
      return this.history[this.historyCursor];
    }

    private pushState(next: CanvasState, coalesceKey: string | null = null): void {
      // Truncate any redo entries past the cursor before pushing.
      if (this.historyCursor < this.history.length - 1) {
        this.history.length = this.historyCursor + 1;
      }

      const canCoalesce =
        coalesceKey !== null && coalesceKey === this.lastCoalesceKey && this.history.length > 1;

      if (canCoalesce) {
        this.history[this.historyCursor] = next;
      } else {
        this.history.push(next);
        this.historyCursor++;
        if (this.history.length > HISTORY_CAP) {
          const excess = this.history.length - HISTORY_CAP;
          this.history.splice(0, excess);
          this.historyCursor -= excess;
        }
      }
      this.lastCoalesceKey = coalesceKey;
      this.notifyStateChange();
    }

    private resetTransientState(): void {
      this.liveStroke = null;
      this.selectedIndices.clear();
      this.editingActionIndex = -1;
      this.moving = false;
      this.moveDx = 0;
      this.moveDy = 0;
      this.shiftToggleDrag = false;
      this.resetHoverDig();
      this.resizeRegion = null;
      this.resizeGrab = null;
    }

    // Clear the dig/aim state so a stale candidate doesn't linger across tool
    // switches, undo/redo, or image loads.
    private resetHoverDig(): void {
      this.hoverCandidate = -1;
      this.digDepth = 0;
      this.digStackKey = '';
      this.scrollAccum = 0;
    }

    setImage(surface: Cairo.ImageSurface): void {
      this.history = [{surface, actions: []}];
      this.historyCursor = 0;
      this.cleanStateRef = this.history[0];
      this.lastCoalesceKey = null;
      this.mode = 'fit';
      this.zoomFactor = 1;
      this.pendingInitialZoom = true;
      this.resetTransientState();
      this.updateSizeRequest();
      this.queue_draw();
      this.notifyStateChange();
      // Decide now if the widget is already allocated; otherwise the resize
      // signal will do it once the viewport size is known.
      this.maybeApplyInitialZoom();
    }

    // Choose the opening zoom for a freshly-loaded image: 1:1 when it fits the
    // viewport (native, crisp), fit when it's larger. Runs once per load, when
    // a real allocation is available.
    private maybeApplyInitialZoom(): void {
      if (!this.pendingInitialZoom) return;
      const s = this.state.surface;
      if (!s) {
        this.pendingInitialZoom = false;
        return;
      }
      const w = this.get_width();
      const h = this.get_height();
      if (w <= 0 || h <= 0) return; // not allocated yet; wait for resize
      this.pendingInitialZoom = false;
      if (s.getWidth() <= w && s.getHeight() <= h) {
        this.setZoom(1); // fits → native size; otherwise stay in fit mode
      }
    }

    // True when the current state has been modified since the last save
    // or fresh image load. Undo to the clean point restores it to
    // false (same state object). Copying to the clipboard does not clear
    // it — only writing the file to disk counts as preserving the work.
    isDirty(): boolean {
      if (!this.cleanStateRef) return this.state.actions.length > 0;
      return this.state !== this.cleanStateRef;
    }

    // Pin the current state as the new "clean" reference. Call after a
    // successful save to disk.
    markClean(): void {
      this.cleanStateRef = this.state;
      this.notifyStateChange();
    }

    setFitMode(): void {
      if (this.mode === 'fit') return;
      this.mode = 'fit';
      this.updateSizeRequest();
      this.queue_draw();
      this.notifyStateChange();
    }

    setZoom(factor: number): void {
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor));
      if (this.mode === 'fixed' && this.zoomFactor === clamped) return;
      this.mode = 'fixed';
      this.zoomFactor = clamped;
      this.updateSizeRequest();
      this.queue_draw();
      this.notifyStateChange();
    }

    isFitMode(): boolean {
      return this.mode === 'fit';
    }

    // Last pointer position in widget-local coords (= content coords inside the
    // scrolled viewport), or null when the pointer is outside. Used to anchor
    // Ctrl+scroll zoom on the point under the cursor.
    getLastPointer(): [number, number] | null {
      return this.lastPointer;
    }

    // The current display scale (1 = 100%). In fit mode this is computed from
    // the widget size; in fixed mode it equals the zoom factor. Null with no
    // image or before first allocation.
    getZoomScale(): number | null {
      const s = this.state.surface;
      if (!s) return null;
      const w = this.get_width();
      const h = this.get_height();
      if (w <= 0 || h <= 0) return null;
      return this.computeTransform(w, h).scale;
    }

    hasImage(): boolean {
      return this.state.surface !== null;
    }

    // Composite current image + all visible actions to a fresh ARGB32 surface
    // at the source image's native resolution. Returns null if no image.
    exportSnapshot(): Cairo.ImageSurface | null {
      const s = this.state.surface;
      if (!s) return null;
      return renderToSurface(s, this.state.actions);
    }

    setTool(toolId: ToolId): void {
      if (this.currentToolId === toolId) return;
      this.currentToolId = toolId;
      this.liveStroke = null;
      this.selectedIndices.clear();
      this.moving = false;
      this.resetHoverDig();
      this.lastCoalesceKey = null;
      if (toolId === 'resize' && this.state.surface) {
        // Auto-select current canvas bounds so the user can immediately drag
        // a handle to adjust, rather than having to drag a fresh region.
        const s = this.state.surface;
        this.resizeRegion = {x1: 0, y1: 0, x2: s.getWidth(), y2: s.getHeight()};
      } else if (toolId !== 'resize') {
        this.resizeRegion = null;
      }
      this.resizeGrab = null;
      this.set_cursor_from_name(cursorForTool(toolId));
      this.queue_draw();
      this.notifyStateChange();
    }

    getTool(): ToolId {
      return this.currentToolId;
    }

    setTextEditRequestHandler(handler: TextEditRequest | null): void {
      this.onTextEditRequest = handler;
    }

    setStateChangeHandler(handler: (() => void) | null): void {
      this.onStateChange = handler;
    }

    // Current color for the given tool, falling back to the tool's static
    // default if nothing has been set yet. Returns null for select and resize,
    // which have no editable color.
    getToolColor(toolId: ToolId): ColorRGBA | null {
      if (toolId === 'select' || toolId === 'resize') return null;
      return this.toolColors.get(toolId) ?? defaultColorForTool(toolId);
    }

    setToolColor(toolId: ToolId, color: ColorRGBA): void {
      this.toolColors.set(toolId, color);
    }

    // Current width for the given tool, falling back to the tool's static
    // default. Returns null for tools without an editable width (text uses
    // font size, number stamp uses radius, select/resize have no stroke).
    getToolWidth(toolId: ToolId): number | null {
      const def = defaultWidthForTool(toolId);
      if (def === null) return null;
      return this.toolWidths.get(toolId) ?? def;
    }

    setToolWidth(toolId: ToolId, width: number): void {
      this.toolWidths.set(toolId, width);
    }

    // Current fill for the given tool. Returns null for tools without an
    // editable fill (pen, highlighter, line, arrow, text, select).
    getToolFill(toolId: ToolId): ColorRGBA | null {
      const def = defaultFillForTool(toolId);
      if (def === null) return null;
      return this.toolFills.get(toolId) ?? def;
    }

    setToolFill(toolId: ToolId, fill: ColorRGBA): void {
      this.toolFills.set(toolId, fill);
    }

    // Current dash style for the given tool. Returns null for tools without an
    // editable dash (pen, highlighter, text, number, select, resize).
    getToolDash(toolId: ToolId): DashStyle | null {
      const def = defaultDashForTool(toolId);
      if (def === null) return null;
      return this.toolDashes.get(toolId) ?? def;
    }

    setToolDash(toolId: ToolId, dash: DashStyle): void {
      this.toolDashes.set(toolId, dash);
    }

    // Current font description for the given tool. Returns null for tools
    // that don't have an editable font (everything but 'text').
    getToolFontDesc(toolId: ToolId): string | null {
      const def = defaultFontDescForTool(toolId);
      if (def === null) return null;
      return this.toolFontDescs.get(toolId) ?? def;
    }

    setToolFontDesc(toolId: ToolId, fontDesc: string): void {
      this.toolFontDescs.set(toolId, fontDesc);
    }

    getToolFontSize(toolId: ToolId): number | null {
      const def = defaultFontSizeForTool(toolId);
      if (def === null) return null;
      return this.toolFontSizes.get(toolId) ?? def;
    }

    setToolFontSize(toolId: ToolId, size: number): void {
      this.toolFontSizes.set(toolId, size);
    }

    // Variant for the next stamp the user places.
    getStampVariant(): StampVariant {
      return this.toolStampVariant;
    }

    // Set the active variant. Updates the tool default for future placements
    // AND rewrites every existing stamp in the current state so the toggle
    // affects all stamps (one history entry, undoable).
    setStampVariant(variant: StampVariant): void {
      if (this.toolStampVariant === variant) return;
      this.toolStampVariant = variant;
      const cur = this.state.actions;
      const next = setStampVariantOnAll(cur, variant);
      // Only push if at least one stamp changed; otherwise this is just a
      // tool-default flip with no visible effect.
      const changed = next.some((a, i) => a !== cur[i]);
      if (changed) {
        this.pushState({surface: this.state.surface, actions: next});
      }
      this.queue_draw();
      this.notifyStateChange();
    }

    // Snapshot only the styles the user has actually changed (present in the
    // per-tool maps), so persisted prefs don't pin a tool to a value that was
    // merely its static default at save time.
    exportToolStyles(): ToolStylesSnapshot {
      const tools: Record<string, ToolStyleEntry> = {};
      const ensure = (id: ToolId): ToolStyleEntry => (tools[id] ??= {});
      for (const [id, c] of this.toolColors) ensure(id).color = c;
      for (const [id, w] of this.toolWidths) ensure(id).width = w;
      for (const [id, f] of this.toolFills) ensure(id).fill = f;
      for (const [id, d] of this.toolDashes) ensure(id).dash = d;
      for (const [id, f] of this.toolFontDescs) ensure(id).fontDesc = f;
      for (const [id, s] of this.toolFontSizes) ensure(id).fontSize = s;
      const snap: ToolStylesSnapshot = {tools};
      if (this.toolStampVariant !== DEFAULT_STAMP_VARIANT)
        snap.stampVariant = this.toolStampVariant;
      return snap;
    }

    // Restore a snapshot into the per-tool maps. Called once at startup before
    // any image exists, so the stamp variant is set directly (not via
    // setStampVariant, which would rewrite existing stamps and push history).
    importToolStyles(snap: ToolStylesSnapshot): void {
      for (const [id, e] of Object.entries(snap.tools ?? {})) {
        const toolId = id as ToolId;
        if (e.color) this.toolColors.set(toolId, e.color);
        if (e.width !== undefined) this.toolWidths.set(toolId, e.width);
        if (e.fill) this.toolFills.set(toolId, e.fill);
        if (e.dash) this.toolDashes.set(toolId, e.dash);
        if (e.fontDesc) this.toolFontDescs.set(toolId, e.fontDesc);
        if (e.fontSize !== undefined) this.toolFontSizes.set(toolId, e.fontSize);
      }
      if (snap.stampVariant) this.toolStampVariant = snap.stampVariant;
    }

    // Every currently-selected action, in selection (insertion) order. The
    // style bar walks these to decide which controls apply to the whole
    // selection and what value to display.
    getSelectedActions(): Action[] {
      const acts = this.state.actions;
      const out: Action[] = [];
      for (const i of this.selectedIndices) {
        if (i >= 0 && i < acts.length) out.push(acts[i]);
      }
      return out;
    }

    // Canonical (sorted) key for the current selection, used to tag coalescing
    // history entries so a style drag over the same multi-selection collapses
    // to one entry but a different selection starts a new one.
    private selectionKey(): string {
      return [...this.selectedIndices].sort((a, b) => a - b).join(',');
    }

    // Clear the current selection. Returns true if something was actually
    // deselected so callers can decide whether to consume the input.
    clearSelection(): boolean {
      if (this.selectedIndices.size === 0) return false;
      this.selectedIndices.clear();
      this.lastCoalesceKey = null;
      this.queue_draw();
      this.notifyStateChange();
      return true;
    }

    getActionAt(index: number): Action | null {
      const cur = this.state.actions;
      if (index < 0 || index >= cur.length) return null;
      return cur[index];
    }

    private replaceSelectedProperty<T>(
      get: (a: Action) => T | null,
      apply: (a: Action, v: T) => Action,
      value: T,
      key: string
    ): boolean {
      const cur = this.state.actions;
      if (this.selectedIndices.size === 0) return false;
      // Broadcast to every selected action that supports the property (its
      // getter returns non-null). Actions that don't carry it pass through
      // untouched; this is the "shared control" rule the style bar mirrors.
      let applicable = false;
      let changed = false;
      const next = cur.map((a, j) => {
        if (!this.selectedIndices.has(j)) return a;
        const current = get(a);
        if (current === null) return a;
        applicable = true;
        // Re-picking the value an action already has would push a content-
        // identical (new-reference) state — an undo step that does nothing
        // visible. Skip those actions. See P1-03.
        if (valuesEqual(current, value)) return a;
        changed = true;
        return apply(a, value);
      });
      // No selected action supports this property — the picker shouldn't have
      // been active; treat as not handled.
      if (!applicable) return false;
      // Applicable but every selected action already had the value: handled,
      // but nothing to push.
      if (!changed) return true;
      // Coalesce on the property AND the selection, so a slider drag over one
      // selection is a single entry but re-selecting starts a fresh one.
      this.pushState(
        {
          surface: this.state.surface,
          actions: next,
        },
        `${key}:${this.selectionKey()}`
      );
      this.queue_draw();
      return true;
    }

    replaceSelectedColor(color: ColorRGBA): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getColor(),
        (a, v) => a.withColor(v),
        color,
        'color'
      );
    }

    replaceSelectedWidth(width: number): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getWidth(),
        (a, v) => a.withWidth(v),
        width,
        'width'
      );
    }

    replaceSelectedFill(fill: ColorRGBA): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getFill(),
        (a, v) => a.withFill(v),
        fill,
        'fill'
      );
    }

    replaceSelectedDash(dash: DashStyle): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getDash(),
        (a, v) => a.withDash(v),
        dash,
        'dash'
      );
    }

    replaceSelectedFontDesc(fontDesc: string): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getFontDesc(),
        (a, v) => a.withFontDesc(v),
        fontDesc,
        'font'
      );
    }

    replaceSelectedFontSize(size: number): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getFontSize(),
        (a, v) => a.withFontSize(v),
        size,
        'fontSize'
      );
    }

    private notifyStateChange(): void {
      this.updateSizeRequest();
      if (this.onStateChange) this.onStateChange();
    }

    private updateSizeRequest(): void {
      if (this.mode === 'fit') {
        this.set_size_request(-1, -1);
        return;
      }
      const s = this.state.surface;
      if (!s) {
        this.set_size_request(-1, -1);
        return;
      }
      const area = this.displayedArea();
      this.set_size_request(
        Math.ceil(area.w * this.zoomFactor),
        Math.ceil(area.h * this.zoomFactor)
      );
    }

    // Width × height of the current image in source pixels, or null if no
    // image is loaded.
    getImageDimensions(): {w: number; h: number} | null {
      const s = this.state.surface;
      if (!s) return null;
      return {w: s.getWidth(), h: s.getHeight()};
    }

    // Width × height of the currently-defined resize region (rounded to whole
    // pixels), or null if no region or not in resize mode.
    getResizeDimensions(): {w: number; h: number} | null {
      if (this.currentToolId !== 'resize') return null;
      const r = this.getResizeRect();
      if (!r) return null;
      return {w: Math.round(r.w), h: Math.round(r.h)};
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

    // Remove an action by index (used when a re-edited text is cleared to
    // empty and confirmed). Pushes a history entry so the deletion is undoable;
    // renumbers stamps to match deleteSelected (a no-op when the removed action
    // isn't a stamp, but keeps the two delete paths consistent).
    removeAction(index: number): void {
      const cur = this.state.actions;
      if (index < 0 || index >= cur.length) return;
      this.pushState({
        surface: this.state.surface,
        actions: renumberStamps(cur.filter((_, i) => i !== index)),
      });
      if (this.editingActionIndex === index) this.editingActionIndex = -1;
      this.selectedIndices.clear();
      this.queue_draw();
    }

    deleteSelected(): boolean {
      const cur = this.state.actions;
      if (this.selectedIndices.size === 0) return false;
      const sel = this.selectedIndices;
      // Drop every selected action in one history entry. Renumber stamps so
      // deleting "2" from "1,2,3" leaves "1,2" — not "1,3" with a hole that
      // the next placement would duplicate.
      const survivors = renumberStamps(cur.filter((_, i) => !sel.has(i)));
      this.pushState({
        surface: this.state.surface,
        actions: survivors,
      });
      this.selectedIndices.clear();
      this.queue_draw();
      return true;
    }

    // Returns the resize region normalized (positive w/h) if defined and
    // non-degenerate. May extend outside the current image bounds — that
    // means "the new canvas pads beyond the current image."
    getResizeRect(): ResizeRect | null {
      if (!this.resizeRegion || !this.state.surface) return null;
      return normalizeRegion(this.resizeRegion);
    }

    // Apply the current resize region: replace surface with one sized to the
    // new region (transparent fill where the new region extends beyond the
    // current image), and translate every action by (-newX, -newY) so their
    // positions follow the canvas origin. Returns true if a resize was
    // applied; false if there was nothing to apply.
    applyResize(): boolean {
      const rect = this.getResizeRect();
      const s = this.state.surface;
      if (!rect || !s) return false;
      const fill = this.getToolFill('resize') ?? TRANSPARENT_FILL;
      this.pushState({
        surface: resizeSurface(s, rect.x, rect.y, rect.w, rect.h, fill),
        actions: this.state.actions.map((a) => a.translate(-rect.x, -rect.y)),
      });
      this.resizeRegion = null;
      this.liveStroke = null;
      this.selectedIndices.clear();
      this.editingActionIndex = -1;
      this.queue_draw();
      return true;
    }

    cancelResize(): void {
      this.resizeRegion = null;
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
        actions: this.state.actions.map((a) => a.rotateOnImage(direction, oldW, oldH)),
      });
      this.liveStroke = null;
      this.selectedIndices.clear();
      this.editingActionIndex = -1;
      this.queue_draw();
    }

    undo(): void {
      if (this.historyCursor === 0) return;
      this.historyCursor--;
      this.lastCoalesceKey = null;
      this.resetTransientState();
      this.queue_draw();
      this.notifyStateChange();
    }

    redo(): void {
      if (this.historyCursor >= this.history.length - 1) return;
      this.historyCursor++;
      this.lastCoalesceKey = null;
      this.resetTransientState();
      this.queue_draw();
      this.notifyStateChange();
    }

    private installPointer(): void {
      const motion = new Gtk.EventControllerMotion();
      motion.connect('motion', (_c, x, y) => this.onPointerMotion(x, y));
      motion.connect('leave', () => {
        this.lastPointer = null;
        if (this.hoverCandidate !== -1) {
          this.hoverCandidate = -1;
          this.queue_draw();
        }
      });
      this.add_controller(motion);

      // Alt+scroll digs the hover candidate through overlapping actions. Plain
      // and Ctrl scroll are left alone (Ctrl zoom is handled on the scrolled
      // window; plain scroll pans), so we only consume the event when Alt is
      // held over a stack of 2+.
      const scroll = new Gtk.EventControllerScroll();
      scroll.set_flags(Gtk.EventControllerScrollFlags.BOTH_AXES);
      scroll.connect('scroll', (c, _dx, dy) => this.onScrollDig(c, dy));
      this.add_controller(scroll);

      const drag = new Gtk.GestureDrag();
      drag.set_button(Gdk.BUTTON_PRIMARY);

      drag.connect('drag-begin', (g, x, y) => {
        this.dragStartX = x;
        this.dragStartY = y;
        this.onDragBegin(x, y, g);
      });
      drag.connect('drag-update', (g, dx, dy) => {
        this.onDragUpdate(this.dragStartX + dx, this.dragStartY + dy, isShift(g));
      });
      drag.connect('drag-end', (g, dx, dy) => {
        this.onDragEnd(this.dragStartX + dx, this.dragStartY + dy, isShift(g));
      });
      this.add_controller(drag);

      const click = new Gtk.GestureClick();
      click.set_button(Gdk.BUTTON_PRIMARY);
      click.connect('pressed', (_g, n_press, x, y) => {
        if (n_press === 2 && this.currentToolId === 'select') {
          this.onSelectDoubleClick(x, y);
          return;
        }
        this.onCanvasPress(x, y);
      });
      this.add_controller(click);

      this.set_cursor_from_name(cursorForTool(this.currentToolId));
    }

    // Update cursor while hovering in resize mode so edge/corner handles
    // advertise themselves before the user even clicks. Other tools keep
    // their cursor from `cursorForTool` (set in setTool / installPointer).
    private onPointerMotion(wx: number, wy: number): void {
      this.lastPointer = [wx, wy];
      // Select tool: track which action the next click will hit (the hover
      // candidate) so it can be outlined and dug into with Alt+scroll.
      if (this.currentToolId === 'select' && this.state.surface) {
        const [ix, iy] = this.widgetToImage(wx, wy);
        const prev = this.hoverCandidate;
        this.resolveCandidate(ix, iy);
        if (this.hoverCandidate !== prev) this.queue_draw();
        return;
      }
      if (this.currentToolId !== 'resize' || !this.state.surface) return;
      if (this.resizeGrab) return; // mid-drag — keep the grab cursor.
      const [ix, iy] = this.widgetToImage(wx, wy);
      const t = this.currentTransform();
      const tol = HANDLE_HIT_PX / t.scale;
      const grab = this.hitTestResizeRegion(ix, iy, tol);
      this.set_cursor_from_name(cursorForResizeGrab(grab));
    }

    // Update the selection on a select-tool press, acting on the current aim
    // (the hover candidate — the topmost action under the cursor, or a deeper
    // one if the user dug in with Alt+scroll). Shift toggles that candidate's
    // membership without starting a move. A plain press selects the candidate
    // alone, UNLESS the candidate is already selected — then the selection is
    // kept so a drag moves the whole set as a unit. A plain press on empty
    // space clears the selection.
    private onSelectPress(wx: number, wy: number, gesture: Gtk.GestureDrag): void {
      const [ix, iy] = this.widgetToImage(wx, wy);
      const prevKey = this.selectionKey();
      this.moving = false;
      this.moveDx = 0;
      this.moveDy = 0;
      this.shiftToggleDrag = false;

      const candidate = this.resolveCandidate(ix, iy);
      if (isShift(gesture)) {
        // Shift edits membership only (never a move). Toggling the aimed
        // candidate works at any depth, so a buried item can be added or
        // removed without disturbing the ones above it.
        this.shiftToggleDrag = true;
        if (candidate >= 0) {
          if (this.selectedIndices.has(candidate)) this.selectedIndices.delete(candidate);
          else this.selectedIndices.add(candidate);
        }
      } else if (candidate < 0 || !this.selectedIndices.has(candidate)) {
        this.selectedIndices.clear();
        if (candidate >= 0) this.selectedIndices.add(candidate);
      }

      this.queue_draw();
      if (this.selectionKey() !== prevKey) {
        this.lastCoalesceKey = null;
        this.notifyStateChange();
      }
    }

    // Resolve the hover candidate at (ix, iy): the action the next click acts
    // on. It's the entry of the under-cursor hit-stack at the current dig
    // depth. The depth resets to the top (depth 0) whenever the pointer moves
    // onto a different stack of actions. Updates the cached candidate + depth
    // state and returns the index (-1 if nothing is under the cursor).
    private resolveCandidate(ix: number, iy: number): number {
      const hits = this.hitStack(ix, iy);
      const key = hits.join(',');
      if (key !== this.digStackKey) {
        this.digStackKey = key;
        this.digDepth = 0;
        this.scrollAccum = 0;
      }
      this.hoverCandidate = hits.length === 0 ? -1 : hits[this.digDepth % hits.length];
      return this.hoverCandidate;
    }

    // The hit-stack under the current pointer, or [] when there's no pointer /
    // no image / not the select tool. Both the Alt+scroll and [ / ] dig paths
    // aim at whatever the pointer is hovering.
    private hoverStack(): number[] {
      if (this.currentToolId !== 'select' || !this.state.surface || !this.lastPointer) return [];
      const [ix, iy] = this.widgetToImage(this.lastPointer[0], this.lastPointer[1]);
      return this.hitStack(ix, iy);
    }

    // Move the dig depth by `dir` (+1 deeper / -1 shallower, wrapping) within
    // the given stack, update the candidate, and repaint.
    private advanceDig(hits: number[], dir: number): void {
      this.digDepth = (((this.digDepth + dir) % hits.length) + hits.length) % hits.length;
      this.digStackKey = hits.join(',');
      this.hoverCandidate = hits[this.digDepth];
      this.queue_draw();
    }

    // Alt+scroll cycles the hover candidate down/up the stack under the
    // pointer, leaving the pointer where it is. Returns true (consuming the
    // event) only when it actually digs, so plain/Ctrl scroll keep panning and
    // zooming.
    private onScrollDig(controller: Gtk.EventControllerScroll, dy: number): boolean {
      if ((controller.get_current_event_state() & Gdk.ModifierType.ALT_MASK) === 0) return false;
      const hits = this.hoverStack();
      if (hits.length <= 1) return false; // nothing to dig through
      // Integrate fractional (touchpad) deltas so one notch = one step.
      this.scrollAccum += dy;
      let stepped = false;
      while (Math.abs(this.scrollAccum) >= SCROLL_DIG_STEP) {
        const dir = this.scrollAccum > 0 ? 1 : -1;
        this.scrollAccum -= dir * SCROLL_DIG_STEP;
        this.advanceDig(hits, dir);
        stepped = true;
      }
      return stepped;
    }

    // Dig the hover candidate one step via the keyboard ([ shallower toward the
    // top, ] deeper). Aims at the stack under the pointer. Returns true if it
    // dug (a 2+ stack was under the cursor), so the key is consumed only then.
    digHoverCandidate(dir: number): boolean {
      const hits = this.hoverStack();
      if (hits.length <= 1) return false;
      this.advanceDig(hits, dir);
      return true;
    }

    // Toggle the hover candidate's membership in the selection — the keyboard
    // equivalent of Shift+Click on it (bound to Shift+Space). Aims at whatever
    // the pointer is hovering (after any [ / ] dig). Returns true if it acted,
    // so the key is consumed only when there's a candidate. Gated during a
    // text re-edit for the same reason onDragBegin is (see P1-02).
    toggleHoverCandidate(): boolean {
      if (this.currentToolId !== 'select' || this.editingActionIndex >= 0) return false;
      const i = this.hoverCandidate;
      if (i < 0 || i >= this.state.actions.length) return false;
      if (this.selectedIndices.has(i)) this.selectedIndices.delete(i);
      else this.selectedIndices.add(i);
      this.lastCoalesceKey = null;
      this.queue_draw();
      this.notifyStateChange();
      return true;
    }

    private onDragBegin(wx: number, wy: number, gesture: Gtk.GestureDrag): void {
      if (!this.state.surface) return;
      if (this.currentToolId === 'select') {
        // A text action is mid-re-edit (hidden, live editor in its place).
        // Suspend canvas selection until the edit commits/cancels so a press
        // can't select+delete another action and leave editingActionIndex
        // stale (which would later replace the wrong action). See P1-02.
        if (this.editingActionIndex >= 0) return;
        this.onSelectPress(wx, wy, gesture);
        return;
      }
      if (this.currentToolId === 'resize') {
        const [ix, iy] = this.widgetToImage(wx, wy);
        const t = this.currentTransform();
        const tol = HANDLE_HIT_PX / t.scale;
        const grab = this.hitTestResizeRegion(ix, iy, tol);
        // Edge / corner grabs adjust the existing region. Everything else
        // (inside body, outside the region, or no region yet) starts a
        // fresh region from this point with BR-drag semantics.
        if (grab === 'inside' || grab === 'outside' || !this.resizeRegion) {
          this.resizeRegion = {x1: ix, y1: iy, x2: ix, y2: iy};
          this.resizeGrab = 'br';
        } else {
          this.resizeGrab = grab;
        }
        this.queue_draw();
        return;
      }
      if (!isDragTool(this.currentToolId)) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      const color =
        this.getToolColor(this.currentToolId) ?? defaultColorForTool(this.currentToolId);
      const width =
        this.getToolWidth(this.currentToolId) ?? defaultWidthForTool(this.currentToolId) ?? 1;
      const fill = this.getToolFill(this.currentToolId) ?? TRANSPARENT_FILL;
      const dash = this.getToolDash(this.currentToolId) ?? DEFAULT_DASH;
      this.liveStroke = createLiveStroke(this.currentToolId, ix, iy, color, width, fill, dash);
      this.queue_draw();
    }

    private onDragUpdate(wx: number, wy: number, constrain: boolean): void {
      if (this.currentToolId === 'select') {
        // A Shift-click toggle never moves; nothing to drag with no selection.
        if (this.shiftToggleDrag || this.selectedIndices.size === 0) return;
        const t = this.currentTransform();
        this.moveDx = (wx - this.dragStartX) / t.scale;
        this.moveDy = (wy - this.dragStartY) / t.scale;
        if (!this.moving && Math.hypot(wx - this.dragStartX, wy - this.dragStartY) > 3) {
          this.moving = true;
        }
        if (this.moving) this.queue_draw();
        return;
      }
      if (this.currentToolId === 'resize') {
        if (!this.resizeRegion || !this.resizeGrab) return;
        const [ix, iy] = this.widgetToImage(wx, wy);
        this.applyResizeGrab(ix, iy);
        this.queue_draw();
        this.notifyStateChange();
        return;
      }
      if (!this.liveStroke) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      this.liveStroke.extendTo(ix, iy, constrain);
      this.queue_draw();
    }

    // Mutate the active resize region's edges according to the current grab.
    // Only edges/corners adjust the region; drags that began inside or
    // outside the region take the BR-grab path on a freshly-seeded region
    // (see onDragBegin), so 'inside' never reaches here.
    private applyResizeGrab(ix: number, iy: number): void {
      const r = this.resizeRegion;
      if (!r || !this.resizeGrab) return;
      const g = this.resizeGrab;
      if (g === 'tl' || g === 'l' || g === 'bl') r.x1 = ix;
      if (g === 'tr' || g === 'r' || g === 'br') r.x2 = ix;
      if (g === 'tl' || g === 't' || g === 'tr') r.y1 = iy;
      if (g === 'bl' || g === 'b' || g === 'br') r.y2 = iy;
    }

    private onDragEnd(wx: number, wy: number, constrain: boolean): void {
      if (this.currentToolId === 'select') {
        // A Shift-click toggle gesture only adjusts membership — no move push.
        if (this.shiftToggleDrag) {
          this.shiftToggleDrag = false;
          this.moving = false;
          this.moveDx = 0;
          this.moveDy = 0;
          return;
        }
        // Skip a drag that ended back at the origin: translate(0, 0) would
        // still push a new (content-identical) state. See P1-03.
        if (
          this.moving &&
          this.selectedIndices.size > 0 &&
          (this.moveDx !== 0 || this.moveDy !== 0)
        ) {
          const cur = this.state.actions;
          const sel = this.selectedIndices;
          const dx = this.moveDx;
          const dy = this.moveDy;
          // Translate every selected action together in one history entry.
          this.pushState({
            surface: this.state.surface,
            actions: cur.map((a, j) => (sel.has(j) ? a.translate(dx, dy) : a)),
          });
        }
        this.moving = false;
        this.moveDx = 0;
        this.moveDy = 0;
        this.queue_draw();
        return;
      }
      if (this.currentToolId === 'resize') {
        if (!this.resizeRegion || !this.resizeGrab) {
          this.resizeGrab = null;
          return;
        }
        const [ix, iy] = this.widgetToImage(wx, wy);
        this.applyResizeGrab(ix, iy);
        // Drop the region if it collapsed to nothing (click without drag from
        // a fresh-region start).
        if (this.getResizeRect() === null) this.resizeRegion = null;
        this.resizeGrab = null;
        this.queue_draw();
        this.notifyStateChange();
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
        // Apply the active Color (foreground) and Fill (interior) from the
        // style bar so stamps inherit picker state on placement rather than
        // requiring a post-place select-edit round trip.
        const fg = this.getToolColor('number') ?? defaultColorForTool('number');
        const interior = this.getToolFill('number') ?? defaultFillForTool('number') ?? fg;
        const style = numberStampStyle(fg, interior);
        this.addAction(
          makeNumberStampAction(ix, iy, this.nextStampNumber(), this.toolStampVariant, 0, style)
        );
      }
    }

    private onSelectDoubleClick(wx: number, wy: number): void {
      if (!this.state.surface) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      // Prefer a selected action under the cursor, so a buried text action
      // picked via the dig gesture still opens for editing; otherwise fall
      // back to the current aim (hover candidate), not just the topmost.
      const selHit = this.selectedIndexAt(ix, iy);
      const idx = selHit >= 0 ? selHit : this.resolveCandidate(ix, iy);
      if (idx < 0) return;
      const action = this.state.actions[idx];
      if (!isTextAction(action)) return;
      const state = getTextEditState(action);
      if (!state) return;
      this.editingActionIndex = idx;
      this.selectedIndices.clear();
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
          editorSize: state.editorSize,
        });
      }
    }

    // Every action whose bounds contain (ix, iy), topmost-first (highest index
    // = drawn last = on top). The re-edited action is skipped.
    private hitStack(ix: number, iy: number): number[] {
      const acts = this.state.actions;
      const hits: number[] = [];
      for (let i = acts.length - 1; i >= 0; i--) {
        if (i === this.editingActionIndex) continue;
        const bounds = acts[i].getBounds();
        if (bounds && pointInBounds(ix, iy, bounds)) hits.push(i);
      }
      return hits;
    }

    // Topmost selected action whose bounds contain (ix, iy), or -1 if the
    // point is outside every selected action. Topmost = highest index, since
    // later actions render on top.
    private selectedIndexAt(ix: number, iy: number): number {
      const acts = this.state.actions;
      let best = -1;
      for (const i of this.selectedIndices) {
        if (i < 0 || i >= acts.length || i <= best) continue;
        const bounds = acts[i].getBounds();
        if (bounds && pointInBounds(ix, iy, bounds)) best = i;
      }
      return best;
    }

    // Classify (ix, iy) relative to the current resize region. Edges and
    // corners get a tolerance band so the user doesn't have to land exactly
    // on a 1-pixel-wide line. `tol` is in image-space pixels.
    // eslint-disable-next-line complexity
    private hitTestResizeRegion(ix: number, iy: number, tol: number): ResizeGrab {
      const r = this.getResizeRect();
      if (!r) return 'outside';
      const x1 = r.x,
        x2 = r.x + r.w;
      const y1 = r.y,
        y2 = r.y + r.h;
      const nearLeft = Math.abs(ix - x1) <= tol;
      const nearRight = Math.abs(ix - x2) <= tol;
      const nearTop = Math.abs(iy - y1) <= tol;
      const nearBottom = Math.abs(iy - y2) <= tol;
      const withinX = ix >= x1 - tol && ix <= x2 + tol;
      const withinY = iy >= y1 - tol && iy <= y2 + tol;

      if (nearTop && nearLeft && withinX && withinY) return 'tl';
      if (nearTop && nearRight && withinX && withinY) return 'tr';
      if (nearBottom && nearLeft && withinX && withinY) return 'bl';
      if (nearBottom && nearRight && withinX && withinY) return 'br';
      if (nearTop && withinX) return 't';
      if (nearBottom && withinX) return 'b';
      if (nearLeft && withinY) return 'l';
      if (nearRight && withinY) return 'r';
      if (ix >= x1 && ix <= x2 && iy >= y1 && iy <= y2) return 'inside';
      return 'outside';
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
      return this.computeTransform(this.get_width(), this.get_height());
    }

    // The "displayed area" in image-space. In fit mode (non-resize) this is
    // just the image bounds. In actual (1:1) mode it's the union of image and
    // action bounds so orphan annotations are scrollable into view. In resize
    // mode it's the union plus a margin so orphans are visible for rescue.
    private displayedArea(): {x: number; y: number; w: number; h: number} {
      const s = this.state.surface;
      const imgW = s ? s.getWidth() : 0;
      const imgH = s ? s.getHeight() : 0;
      if (this.mode === 'fit' && this.currentToolId !== 'resize') {
        return {x: 0, y: 0, w: imgW, h: imgH};
      }

      let minX = 0,
        minY = 0,
        maxX = imgW,
        maxY = imgH;
      for (const action of this.state.actions) {
        const b = action.getBounds();
        if (!b) continue;
        if (b.x1 < minX) minX = b.x1;
        if (b.y1 < minY) minY = b.y1;
        if (b.x2 > maxX) maxX = b.x2;
        if (b.y2 > maxY) maxY = b.y2;
      }
      if (this.currentToolId === 'resize') {
        const margin = Math.max(20, Math.min(imgW, imgH) * 0.05);
        return {
          x: minX - margin,
          y: minY - margin,
          w: maxX - minX + 2 * margin,
          h: maxY - minY + 2 * margin,
        };
      }
      return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
    }

    private computeTransform(widgetW: number, widgetH: number): Transform {
      const s = this.state.surface;
      if (!s) return {scale: 1, offsetX: 0, offsetY: 0};
      const area = this.displayedArea();
      // Fit scales the displayed area to fill the viewport, enlarging a small
      // image past 1:1 (use the 1:1 button to view at native size instead).
      const scale =
        this.mode === 'fixed' ? this.zoomFactor : Math.min(widgetW / area.w, widgetH / area.h);
      const drawW = area.w * scale;
      const drawH = area.h * scale;
      // Image-space (area.x, area.y) lands at the centered top-left of the
      // displayed area. Image-space (0, 0) lands at offsetX, offsetY.
      return {
        scale,
        offsetX: Math.floor((widgetW - drawW) / 2 - area.x * scale),
        offsetY: Math.floor((widgetH - drawH) / 2 - area.y * scale),
      };
    }

    // One dashed box per selected action, all shifting together while a move
    // is in progress. Skips the action being re-edited (its box would frame
    // the hidden action behind the live editor).
    private drawSelectionBoxes(
      cr: Cairo.Context,
      acts: ReadonlyArray<Action>,
      scale: number
    ): void {
      if (this.selectedIndices.size === 0) return;
      const ox = this.moving ? this.moveDx : 0;
      const oy = this.moving ? this.moveDy : 0;
      for (const i of this.selectedIndices) {
        if (i < 0 || i >= acts.length || i === this.editingActionIndex) continue;
        const bounds = acts[i].getBounds();
        if (bounds) drawSelectionBox(cr, bounds, scale, ox, oy);
      }
    }

    // The hover candidate — the action the next click acts on — outlined in
    // solid amber, distinct from the dashed cyan selection box. Shown only for
    // the select tool, while not moving, and not over the re-edited action.
    // Suppressed when it's the lone selection (the selection box already marks
    // it) to avoid a redundant double outline.
    private drawHoverCandidate(
      cr: Cairo.Context,
      acts: ReadonlyArray<Action>,
      scale: number
    ): void {
      if (this.currentToolId !== 'select' || this.moving) return;
      const i = this.hoverCandidate;
      if (i < 0 || i >= acts.length || i === this.editingActionIndex) return;
      if (this.selectedIndices.size === 1 && this.selectedIndices.has(i)) return;
      const bounds = acts[i].getBounds();
      if (bounds) drawCandidateBox(cr, bounds, scale);
    }

    private onDraw(
      _widget: Gtk.DrawingArea,
      cr: Cairo.Context,
      widgetW: number,
      widgetH: number
    ): void {
      // Backdrop around the image follows the theme: a deep neutral in dark
      // mode, a light gray in light mode. The 1px image-bounds border (drawn
      // below) keeps the image edge visible against either.
      if (Adw.StyleManager.get_default().get_dark()) cr.setSourceRGB(0.12, 0.12, 0.12);
      else cr.setSourceRGB(0.92, 0.92, 0.92);
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

      // Transparency checkerboard, drawn under the image so it shows through
      // any transparent pixels in the surface (and through the enlarged-fill
      // area after a resize).
      cr.setSource(getCheckerPattern());
      cr.rectangle(0, 0, imgW, imgH);
      cr.fill();

      cr.setSourceSurface(s, 0, 0);
      // NEAREST at or above 1:1 keeps zoomed-in pixels crisp (pixel-art
      // friendly); BILINEAR below 1:1 smooths the downscale to avoid moiré.
      (cr.getSource() as Cairo.SurfacePattern).setFilter(
        t.scale >= 1 ? Cairo.Filter.NEAREST : Cairo.Filter.BILINEAR
      );
      cr.paint();

      const acts = this.state.actions;
      for (let i = 0; i < acts.length; i++) {
        if (i === this.editingActionIndex) continue;
        if (this.moving && this.selectedIndices.has(i)) {
          cr.save();
          cr.translate(this.moveDx, this.moveDy);
          acts[i].draw(cr, t.scale);
          cr.restore();
        } else {
          acts[i].draw(cr, t.scale);
        }
      }
      if (this.liveStroke) this.liveStroke.draw(cr, t.scale);

      this.drawSelectionBoxes(cr, acts, t.scale);
      this.drawHoverCandidate(cr, acts, t.scale);

      // Thin border around the current image so the canvas is distinguishable
      // from the app background — important once the surface has transparent
      // areas (resize-enlarged region; loaded PNGs with alpha) where the dark
      // backdrop would otherwise blend with the surrounding dead space.
      cr.setSourceRGBA(0, 0, 0, 0.55);
      cr.setLineWidth(1 / t.scale);
      cr.setDash([], 0);
      cr.rectangle(0, 0, imgW, imgH);
      cr.stroke();

      if (this.currentToolId === 'resize') {
        const region = this.getResizeRect();
        drawResizeOverlay(cr, imgW, imgH, region, t.scale);
      }

      cr.restore();
    }
  }
);

function drawResizeOverlay(
  cr: Cairo.Context,
  imgW: number,
  imgH: number,
  rect: ResizeRect | null,
  scale: number
): void {
  cr.save();

  // Dim the parts of the *current image* that fall outside the new region —
  // visually signals what will be dropped. Areas where the new region extends
  // beyond the current image stay as canvas background (no dim), which is
  // what transparent fill will look like after apply.
  cr.setSourceRGBA(0, 0, 0, 0.5);
  cr.rectangle(0, 0, imgW, imgH);
  if (rect) cr.rectangle(rect.x, rect.y, rect.w, rect.h);
  cr.setFillRule(Cairo.FillRule.EVEN_ODD);
  cr.fill();

  // Dashed border around the new region (may extend outside the image).
  if (rect) {
    cr.setSourceRGBA(1, 1, 1, 0.95);
    cr.setLineWidth(1.5 / scale);
    cr.setDash([6 / scale, 4 / scale], 0);
    cr.setLineCap(Cairo.LineCap.BUTT);
    cr.setLineJoin(Cairo.LineJoin.MITER);
    cr.rectangle(rect.x, rect.y, rect.w, rect.h);
    cr.stroke();
  }

  cr.restore();
}

function drawSelectionBox(
  cr: Cairo.Context,
  bounds: Bounds,
  scale: number,
  ox: number,
  oy: number
): void {
  const pad = 4 / scale;
  const lineWidth = 1.5 / scale;

  cr.save();
  cr.setSourceRGBA(0.0, 0.5, 1.0, 0.95); // solid blue
  cr.setLineWidth(lineWidth);
  cr.setDash([], 0);
  cr.setLineCap(Cairo.LineCap.BUTT);
  cr.setLineJoin(Cairo.LineJoin.MITER);
  cr.rectangle(
    bounds.x1 + ox - pad,
    bounds.y1 + oy - pad,
    bounds.x2 - bounds.x1 + 2 * pad,
    bounds.y2 - bounds.y1 + 2 * pad
  );
  cr.stroke();
  cr.restore();
}

// Outline for the hover candidate: dashed light blue, so it reads as a
// transient "this is what a click will hit" marker, distinct from the solid
// blue selection box. Slightly tighter pad than the selection box so the two
// don't sit exactly on top of each other when both are shown.
function drawCandidateBox(cr: Cairo.Context, bounds: Bounds, scale: number): void {
  const pad = 2 / scale;
  cr.save();
  cr.setSourceRGBA(0.45, 0.75, 1.0, 0.95); // light blue
  cr.setLineWidth(1.5 / scale);
  cr.setDash([6 / scale, 4 / scale], 0);
  cr.setLineCap(Cairo.LineCap.BUTT);
  cr.setLineJoin(Cairo.LineJoin.MITER);
  cr.rectangle(
    bounds.x1 - pad,
    bounds.y1 - pad,
    bounds.x2 - bounds.x1 + 2 * pad,
    bounds.y2 - bounds.y1 + 2 * pad
  );
  cr.stroke();
  cr.restore();
}
