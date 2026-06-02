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
  HandleId,
  OrientedBounds,
  DEFAULT_DASH,
  DEFAULT_STAMP_RADIUS,
  DEFAULT_STAMP_VARIANT,
  LiveStroke,
  StampVariant,
  ToolId,
  TRANSPARENT_FILL,
  actionToolId,
  createLiveStroke,
  defaultColorForTool,
  defaultDashForTool,
  defaultFillForTool,
  defaultFilledHeadForTool,
  defaultFontDescForTool,
  defaultFontSizeForTool,
  defaultWidthForTool,
  isNumberStampAction,
  isTextAction,
  getTextEditState,
  makeNumberStampAction,
  numberStampGroup,
  numberStampRadius,
  numberStampStyle,
  numberStampVariant,
  reassignStamp,
  renumberStamps,
  setStampVariantInGroup,
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

// Rotate gizmo: the handle sits this many widget px past the selection box edge
// (along the action's "up" direction), on a short connector stick. Shift snaps
// the angle to multiples of ROTATE_SNAP.
const ROTATE_ARM_PX = 22;
const ROTATE_SNAP = Math.PI / 12; // 15°

// Accumulated scroll delta required to dig one step deeper in the hit-stack.
// A plain mouse wheel reports ~1.0 per notch (so one notch = one step); the
// accumulator also smooths a touchpad's many small fractions into whole steps.
// The [ and ] keys are the precise, one-step-per-press alternative.
const SCROLL_DIG_STEP = 1;

// Image-space cell size for the transparency checkerboard. Cells appear
// 8 widget pixels wide at 1:1 zoom, larger when zoomed in, smaller when
// zoomed out — same convention as Photoshop / GIMP.
const CHECKER_CELL = 8;

// Diagonal nudge applied to cloned actions, in widget pixels — converted to
// image space through the current scale so the offset looks the same at any
// zoom. South-of-east (down-right), enough to read as a distinct copy.
const CLONE_OFFSET_PX = 16;

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

// The outward direction (radians, CW, y-down) of a box handle on an unrotated
// box: east = 0, increasing clockwise.
function handleBaseAngle(id: HandleId): number {
  switch (id) {
    case 'r':
      return 0;
    case 'br':
      return Math.PI / 4;
    case 'b':
      return Math.PI / 2;
    case 'bl':
      return (3 * Math.PI) / 4;
    case 'l':
      return Math.PI;
    case 'tl':
      return (-3 * Math.PI) / 4;
    case 't':
      return -Math.PI / 2;
    case 'tr':
      return -Math.PI / 4;
    default:
      return 0; // p1/p2 — handled by the caller before this is reached
  }
}

// Cursor for a per-action resize handle on a box rotated by `rotation`. Box
// handles map to one of the four directional resize cursors, snapped to the
// handle's actual (rotated) outward direction so a tilted box gets sensible
// cursors; endpoints aren't directional (free drag) → crosshair.
function cursorForHandle(id: HandleId, rotation: number): string {
  if (id === 'p1' || id === 'p2') return 'crosshair';
  if (rotation === 0) return cursorForResizeGrab(id);
  let a = handleBaseAngle(id) + rotation;
  a = ((a % Math.PI) + Math.PI) % Math.PI; // fold to [0, π); resize cursors are symmetric
  switch (Math.round(a / (Math.PI / 4)) % 4) {
    case 1:
      return 'nwse-resize';
    case 2:
      return 'ns-resize';
    case 3:
      return 'nesw-resize';
    default:
      return 'ew-resize';
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

    // Per-action reshape (select tool, single selection). `actionGrab` is the
    // resize handle being dragged; `rotateGrab` is true while dragging the
    // rotate gizmo; `actionPreview` is the live reshaped/rotated action shown
    // during either drag (committed in one history entry at drag-end). All
    // inert when no per-action reshape is in progress. Distinct from the
    // resize-tool fields above, which reshape the whole canvas.
    private actionGrab: HandleId | null = null;
    private rotateGrab: boolean = false;
    private actionPreview: Action | null = null;

    private onTextEditRequest: TextEditRequest | null = null;
    private onStateChange: (() => void) | null = null;

    // Invoked after an action is placed (addAction), with its index. The window
    // uses it to apply the "select after placement" preference — switch to the
    // select tool and select the new item. The canvas stays policy-free here
    // and just reports the placement.
    private onPlaced: ((index: number) => void) | null = null;

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

    // Per-tool filled-arrowhead state. Only 'arrow' ever has an entry; every
    // other tool has no arrowhead (returns null).
    private toolFilledHeads: Map<ToolId, boolean> = new Map();

    // Stamp groups. Stamps carry a stable groupId; numbering runs per group.
    // `placementGroupId` is the group new stamps land in (number tool); it is
    // tool state, not document state — undo/redo never changes it. `nextGroupId`
    // mints fresh stable ids (monotonic, never reused). `groupVariants` holds a
    // group's chosen Number/Letter even while it has no stamps yet (the freshly
    // created placement group), falling back to `defaultStampVariant` — the
    // remembered, persisted preference that also seeds new groups.
    private placementGroupId: number = 1;
    private nextGroupId: number = 2;
    private groupVariants: Map<number, StampVariant> = new Map();
    private defaultStampVariant: StampVariant = DEFAULT_STAMP_VARIANT;

    // Per-tool current font description. Only 'text' has an entry today;
    // other tools have no editable font and return null from getToolFontDesc.
    private toolFontDescs: Map<ToolId, string> = new Map();

    // Per-tool current font size (image-space pixels). Only 'text' has an
    // entry today; other tools return null from getToolFontSize.
    private toolFontSizes: Map<ToolId, number> = new Map();

    // Per-tool remembered number-stamp radius (image-space pixels). Only
    // 'number' ever has an entry — set when a stamp is resized (so the next
    // placement inherits the size), read at placement (#6). Not a "width", so
    // it gets its own slot rather than reusing toolWidths.
    private toolStampRadii: Map<ToolId, number> = new Map();

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
      this.actionGrab = null;
      this.rotateGrab = false;
      this.actionPreview = null;
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
      // Fresh document → fresh groups. The remembered defaultStampVariant (a
      // tool preference, like the per-tool colors) survives across images.
      this.placementGroupId = 1;
      this.nextGroupId = 2;
      this.groupVariants.clear();
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
      this.actionGrab = null;
      this.rotateGrab = false;
      this.actionPreview = null;
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

    setPlacementHandler(handler: ((index: number) => void) | null): void {
      this.onPlaced = handler;
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

    // Current filled-arrowhead state for the given tool. Returns null for every
    // tool but 'arrow' (the toggle hides accordingly).
    getToolFilledHead(toolId: ToolId): boolean | null {
      const def = defaultFilledHeadForTool(toolId);
      if (def === null) return null;
      return this.toolFilledHeads.get(toolId) ?? def;
    }

    setToolFilledHead(toolId: ToolId, filled: boolean): void {
      this.toolFilledHeads.set(toolId, filled);
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

    // ---------- Stamp groups ----------

    // The groups that actually have stamps, as stable ids sorted ascending
    // (= creation order). The style bar renders these as a gap-free "Group 1..K"
    // by position, so emptying a group relabels the rest. The number tool folds
    // in its (possibly still-empty) placement group on top of this; select mode
    // shows only these populated groups as reassignment targets.
    getStampGroupIds(): number[] {
      const ids = new Set<number>();
      for (const a of this.state.actions) {
        const g = numberStampGroup(a);
        if (g !== null) ids.add(g);
      }
      return [...ids].sort((a, b) => a - b);
    }

    getPlacementGroupId(): number {
      return this.placementGroupId;
    }

    // The variant a group currently uses: read from its stamps if it has any,
    // else its remembered choice, else the persisted default.
    private groupVariantFor(groupId: number): StampVariant {
      for (const a of this.state.actions) {
        if (numberStampGroup(a) === groupId) return numberStampVariant(a)!;
      }
      return this.groupVariants.get(groupId) ?? this.defaultStampVariant;
    }

    getPlacementGroupVariant(): StampVariant {
      return this.groupVariantFor(this.placementGroupId);
    }

    private groupHasStamps(groupId: number): boolean {
      return this.state.actions.some((a) => numberStampGroup(a) === groupId);
    }

    // After a move or delete (pass the resulting action list), if the placement
    // group has been emptied and other groups survive, snap placement to the
    // last surviving group so the emptied group disappears instead of lingering
    // as a phantom empty entry. A freshly created, still-empty placement group
    // (from newPlacementGroup) is the intended exception — that path never
    // empties a group, so it never reaches here.
    private collapseEmptyPlacementGroup(actions: ReadonlyArray<Action>): void {
      let placementPresent = false;
      let last = -1;
      for (const a of actions) {
        const g = numberStampGroup(a);
        if (g === null) continue;
        if (g === this.placementGroupId) placementPresent = true;
        if (g > last) last = g;
      }
      if (!placementPresent && last >= 0) this.placementGroupId = last;
    }

    // Switch the group new stamps land in. Pure tool state — no history push.
    setPlacementGroup(groupId: number): void {
      if (this.placementGroupId === groupId) return;
      this.placementGroupId = groupId;
      this.notifyStateChange();
    }

    // Begin a fresh placement group. Capped at one empty group at a time: if the
    // current group has no stamps yet, this is a no-op (you're already in an
    // empty group). Returns whether a new group was actually started.
    newPlacementGroup(): boolean {
      if (!this.groupHasStamps(this.placementGroupId)) return false;
      this.placementGroupId = this.nextGroupId++;
      this.notifyStateChange();
      return true;
    }

    // Set the active placement group's variant: remember it (so the not-yet-
    // populated case sticks), seed the persisted default, and rewrite that
    // group's existing stamps in one undoable entry.
    setPlacementGroupVariant(variant: StampVariant): void {
      this.groupVariants.set(this.placementGroupId, variant);
      this.defaultStampVariant = variant;
      const cur = this.state.actions;
      const next = setStampVariantInGroup(cur, this.placementGroupId, variant);
      if (next.some((a, i) => a !== cur[i])) {
        this.pushState({surface: this.state.surface, actions: next});
      }
      this.queue_draw();
      this.notifyStateChange();
    }

    // Flip the variant of every group represented in the current selection (a
    // group stays uniformly Number or Letter, so this affects the whole group,
    // not just the selected stamps). One history entry.
    setSelectedGroupsVariant(variant: StampVariant): boolean {
      const cur = this.state.actions;
      const groups = new Set<number>();
      for (const i of this.selectedIndices) {
        const g = numberStampGroup(cur[i]);
        if (g !== null) groups.add(g);
      }
      if (groups.size === 0) return false;
      this.defaultStampVariant = variant;
      let next: Action[] = cur as Action[];
      for (const g of groups) {
        this.groupVariants.set(g, variant);
        next = setStampVariantInGroup(next, g, variant);
      }
      if (next.some((a, i) => a !== cur[i])) {
        this.pushState({surface: this.state.surface, actions: next});
      }
      this.queue_draw();
      this.notifyStateChange();
      return true;
    }

    // Move the selected stamps into a group ('new' mints one), each spliced to
    // just after that group's last existing member so it lands at the end of the
    // group's numbers; moved stamps adopt the target group's variant. Non-stamp
    // members of the selection are left where they are. One history entry; the
    // moved stamps become the new selection.
    reassignSelectedGroup(target: number | 'new'): boolean {
      const cur = this.state.actions;
      const moveIdx = [...this.selectedIndices]
        .filter((i) => i >= 0 && i < cur.length && isNumberStampAction(cur[i]))
        .sort((a, b) => a - b);
      if (moveIdx.length === 0) return false;

      const groupId = target === 'new' ? this.nextGroupId++ : target;
      const variant = this.groupVariantFor(groupId);
      const moveSet = new Set(moveIdx);
      const moved = moveIdx.map((i) => reassignStamp(cur[i], groupId, variant));
      const rest = cur.filter((_, i) => !moveSet.has(i));

      // Insert after the target group's last surviving member; if the target has
      // none (a new or emptied group), append at the end of the document.
      let insertAt = rest.length;
      for (let i = rest.length - 1; i >= 0; i--) {
        if (numberStampGroup(rest[i]) === groupId) {
          insertAt = i + 1;
          break;
        }
      }
      const next = renumberStamps([...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)]);
      this.collapseEmptyPlacementGroup(next);

      this.selectedIndices.clear();
      for (let k = 0; k < moved.length; k++) this.selectedIndices.add(insertAt + k);
      this.pushState({surface: this.state.surface, actions: next});
      this.queue_draw();
      this.notifyStateChange();
      return true;
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
      for (const [id, h] of this.toolFilledHeads) ensure(id).filledHead = h;
      for (const [id, f] of this.toolFontDescs) ensure(id).fontDesc = f;
      for (const [id, s] of this.toolFontSizes) ensure(id).fontSize = s;
      for (const [id, r] of this.toolStampRadii) ensure(id).stampRadius = r;
      const snap: ToolStylesSnapshot = {tools};
      if (this.defaultStampVariant !== DEFAULT_STAMP_VARIANT)
        snap.stampVariant = this.defaultStampVariant;
      return snap;
    }

    // Restore a snapshot into the per-tool maps. Called once at startup before
    // any image exists, so the persisted variant only seeds the default for new
    // groups — there are no stamps to rewrite yet.
    importToolStyles(snap: ToolStylesSnapshot): void {
      for (const [id, e] of Object.entries(snap.tools ?? {})) {
        const toolId = id as ToolId;
        if (e.color) this.toolColors.set(toolId, e.color);
        if (e.width !== undefined) this.toolWidths.set(toolId, e.width);
        if (e.fill) this.toolFills.set(toolId, e.fill);
        if (e.dash) this.toolDashes.set(toolId, e.dash);
        if (e.filledHead !== undefined) this.toolFilledHeads.set(toolId, e.filledHead);
        if (e.fontDesc) this.toolFontDescs.set(toolId, e.fontDesc);
        if (e.fontSize !== undefined) this.toolFontSizes.set(toolId, e.fontSize);
        if (e.stampRadius !== undefined) this.toolStampRadii.set(toolId, e.stampRadius);
      }
      if (snap.stampVariant) this.defaultStampVariant = snap.stampVariant;
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

    // Select exactly one action by index, clearing any prior selection. Used by
    // the select-after-placement flow once the tool has been switched to select.
    // No-op for an out-of-range index.
    selectIndex(index: number): void {
      if (index < 0 || index >= this.state.actions.length) return;
      this.selectedIndices.clear();
      this.selectedIndices.add(index);
      this.lastCoalesceKey = null;
      this.queue_draw();
      this.notifyStateChange();
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
      key: string,
      setToolDefault: (toolId: ToolId, v: T) => void
    ): boolean {
      const cur = this.state.actions;
      if (this.selectedIndices.size === 0) return false;
      // Broadcast to every selected action that supports the property (its
      // getter returns non-null). Actions that don't carry it pass through
      // untouched; this is the "shared control" rule the style bar mirrors.
      let applicable = false;
      let changed = false;
      // The tools of the edited action types, so the edit can be remembered as
      // each one's default (#5).
      const tools = new Set<ToolId>();
      const next = cur.map((a, j) => {
        if (!this.selectedIndices.has(j)) return a;
        const current = get(a);
        if (current === null) return a;
        applicable = true;
        const tid = actionToolId(a);
        if (tid) tools.add(tid);
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
      // Remember this select-mode edit as the matching tools' default so the
      // next placement with that tool inherits it (#5). Only the edited types'
      // tools are touched — recoloring a rect updates rect's default, not pen's.
      // Written even when nothing changed (every selected item already had the
      // value), since the user still explicitly chose it.
      for (const tid of tools) setToolDefault(tid, value);
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
        'color',
        (tid, v) => this.setToolColor(tid, v)
      );
    }

    replaceSelectedWidth(width: number): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getWidth(),
        (a, v) => a.withWidth(v),
        width,
        'width',
        (tid, v) => this.setToolWidth(tid, v)
      );
    }

    replaceSelectedFill(fill: ColorRGBA): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getFill(),
        (a, v) => a.withFill(v),
        fill,
        'fill',
        (tid, v) => this.setToolFill(tid, v)
      );
    }

    replaceSelectedDash(dash: DashStyle): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getDash(),
        (a, v) => a.withDash(v),
        dash,
        'dash',
        (tid, v) => this.setToolDash(tid, v)
      );
    }

    replaceSelectedFilledHead(filled: boolean): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getFilledHead(),
        (a, v) => a.withFilledHead(v),
        filled,
        'filledHead',
        (tid, v) => this.setToolFilledHead(tid, v)
      );
    }

    replaceSelectedFontDesc(fontDesc: string): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getFontDesc(),
        (a, v) => a.withFontDesc(v),
        fontDesc,
        'font',
        (tid, v) => this.setToolFontDesc(tid, v)
      );
    }

    replaceSelectedFontSize(size: number): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getFontSize(),
        (a, v) => a.withFontSize(v),
        size,
        'fontSize',
        (tid, v) => this.setToolFontSize(tid, v)
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
      // Report the placement (last index) so the window can apply the
      // select-after-placement preference. Every placement path — shapes,
      // stamps, new text — funnels through here.
      if (this.onPlaced) this.onPlaced(this.state.actions.length - 1);
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
      const survivors = renumberStamps(cur.filter((_, i) => i !== index));
      this.collapseEmptyPlacementGroup(survivors);
      this.pushState({
        surface: this.state.surface,
        actions: survivors,
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
      this.collapseEmptyPlacementGroup(survivors);
      this.pushState({
        surface: this.state.surface,
        actions: survivors,
      });
      this.selectedIndices.clear();
      this.queue_draw();
      return true;
    }

    // Duplicate every selected action, nudged diagonally down-right, and leave
    // the clones selected — so clone-then-drag works and a repeated clone steps
    // further away. The same offset is applied to each, so a multi-selection
    // keeps its relative layout. Renumbers stamps so a cloned stamp takes the
    // next number (the gap-free 1..N invariant deleteSelected also maintains).
    // One history entry.
    cloneSelected(): boolean {
      const cur = this.state.actions;
      if (this.selectedIndices.size === 0) return false;
      // Document order so appended clones (and any stamp renumbering) follow the
      // visual stacking rather than selection-insertion order.
      const indices = [...this.selectedIndices]
        .sort((a, b) => a - b)
        .filter((i) => i >= 0 && i < cur.length);
      if (indices.length === 0) return false;
      const scale = this.currentTransform().scale;
      const off = Math.max(1, Math.round(CLONE_OFFSET_PX / scale));
      const clones = indices.map((i) => cur[i].translate(off, off));
      // Select the clones (the trailing entries) before pushState so the state-
      // change notification refreshes the style bar against the new selection.
      this.selectedIndices.clear();
      for (let k = 0; k < clones.length; k++) this.selectedIndices.add(cur.length + k);
      this.pushState({
        surface: this.state.surface,
        actions: renumberStamps([...cur, ...clones]),
      });
      this.queue_draw();
      return true;
    }

    // Restack the current selection within the action stack (z-order). Draw
    // order is array order — index 0 is the bottom layer, the last index the
    // top — so reordering = moving the selected actions within state.actions.
    // The selected set moves as a block, preserving its relative order:
    //   'back'  → the block jumps to the bottom (indices 0..k-1)
    //   'front' → the block jumps to the top (the last k indices)
    //   'lower' → the block steps down one slot (anchored on its lowest member)
    //   'raise' → the block steps up one slot (anchored on its highest member)
    // For a non-contiguous selection the unselected items keep their relative
    // order and fill the gaps. Stamps renumber by the new array order (the same
    // gap-free rule delete/clone follow), so a reorder can change a stamp's
    // number within its group. No-ops (already at the requested end) return
    // false without touching history. One history entry; the moved block stays
    // selected, its indices remapped to the new positions.
    reorderSelected(op: 'back' | 'lower' | 'raise' | 'front'): boolean {
      const cur = this.state.actions;
      const sel = [...this.selectedIndices]
        .filter((i) => i >= 0 && i < cur.length)
        .sort((a, b) => a - b);
      if (sel.length === 0) return false;
      const selSet = new Set(sel);
      const block = sel.map((i) => cur[i]);
      const rest = cur.filter((_, i) => !selSet.has(i));
      const clamp = (p: number): number => Math.max(0, Math.min(rest.length, p));
      // Insertion point into `rest` (the block lands after `at` unselected
      // items). lo/hi are the block's lowest/highest current indices; because
      // lo is the minimum no selected item sits below it, so the count of
      // unselected items below lo is just lo, and below hi it is hi-(k-1).
      let at: number;
      switch (op) {
        case 'back':
          at = 0;
          break;
        case 'front':
          at = rest.length;
          break;
        case 'lower':
          at = clamp(sel[0] - 1);
          break;
        case 'raise':
          at = clamp(sel[sel.length - 1] - sel.length + 2);
          break;
      }
      const reordered = [...rest.slice(0, at), ...block, ...rest.slice(at)];
      if (reordered.every((a, i) => a === cur[i])) return false;

      this.selectedIndices.clear();
      for (let k = 0; k < block.length; k++) this.selectedIndices.add(at + k);
      this.pushState({surface: this.state.surface, actions: renumberStamps(reordered)});
      // The hover candidate is a cached index; reordering just moved every
      // action, so recompute it from the pointer or it would outline whatever
      // slid into the old slot (e.g. a button/key z-order with no pointer move).
      this.refreshHoverCandidate();
      this.queue_draw();
      this.notifyStateChange();
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
        if (this.actionGrab || this.rotateGrab) return; // mid-reshape — keep the cursor.
        const [ix, iy] = this.widgetToImage(wx, wy);
        const prev = this.hoverCandidate;
        this.resolveCandidate(ix, iy);
        if (this.hoverCandidate !== prev) this.queue_draw();
        // A resize handle or rotate gizmo of the lone selection advertises
        // itself before the drag; everywhere else falls back to the arrow.
        this.set_cursor_from_name(this.handleCursorAt(ix, iy));
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

    // Recompute the hover candidate from the last pointer position. Used after a
    // structural reorder of the action stack (z-order): the candidate is a
    // cached index, so once actions move it must be re-derived from what's
    // actually under the cursor in the new order — otherwise it outlines
    // whatever slid into the old slot. Clears it when there's no pointer (or
    // we're not in select mode); the next pointer motion would refresh it
    // anyway, but a button/key reorder produces no motion.
    private refreshHoverCandidate(): void {
      if (this.currentToolId !== 'select' || !this.state.surface || !this.lastPointer) {
        this.hoverCandidate = -1;
        return;
      }
      const [ix, iy] = this.widgetToImage(this.lastPointer[0], this.lastPointer[1]);
      this.resolveCandidate(ix, iy);
    }

    // The hit-stack under the current pointer, or [] when there's no pointer /
    // no image / not the select tool. Both the Alt+scroll and , / . dig paths
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
        // A handle of the lone selected action takes priority over move /
        // reselection, so a corner/endpoint drag reshapes, and the rotate
        // gizmo rotates, instead of moving.
        if (this.tryBeginActionResize(wx, wy) || this.tryBeginActionRotate(wx, wy)) {
          this.queue_draw();
          return;
        }
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
      const filledHead = this.getToolFilledHead(this.currentToolId) ?? false;
      this.liveStroke = createLiveStroke(
        this.currentToolId,
        ix,
        iy,
        color,
        width,
        fill,
        dash,
        filledHead
      );
      this.queue_draw();
    }

    private onDragUpdate(wx: number, wy: number, constrain: boolean): void {
      if (this.currentToolId === 'select') {
        // Per-action resize: reshape the lone selected action live from the
        // grabbed handle. Shift squares a corner (rect/oval); endpoints ignore
        // it. Takes precedence over the move path below.
        if (this.actionGrab) {
          const i = this.soleSelectedIndex();
          if (i < 0) return;
          const [ix, iy] = this.widgetToImage(wx, wy);
          this.actionPreview = this.state.actions[i].resizeByHandle(
            this.actionGrab,
            ix,
            iy,
            constrain
          );
          this.queue_draw();
          return;
        }
        // Per-action rotate: spin the lone selected action so its gizmo points
        // at the cursor (up = 0). Shift snaps to ROTATE_SNAP increments.
        if (this.rotateGrab) {
          const i = this.soleSelectedIndex();
          if (i < 0) return;
          const action = this.state.actions[i];
          const ob = action.getOrientedBounds();
          if (!ob) return;
          const [ix, iy] = this.widgetToImage(wx, wy);
          let angle = Math.atan2(ix - ob.cx, -(iy - ob.cy));
          if (constrain) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;
          this.actionPreview = action.withRotation(angle);
          this.queue_draw();
          return;
        }
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
        // Per-action resize/rotate: commit the reshaped/rotated action in one
        // history entry (a click without a drag, or a drag back to the original,
        // pushes nothing).
        if (this.commitActionReshape()) return;
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
        const radius = this.toolStampRadii.get('number') ?? DEFAULT_STAMP_RADIUS;
        const style = numberStampStyle(fg, interior, radius);
        this.addAction(
          makeNumberStampAction(
            ix,
            iy,
            this.nextStampNumber(),
            this.placementGroupId,
            this.getPlacementGroupVariant(),
            0,
            style
          )
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
        if (acts[i].containsPoint(ix, iy)) hits.push(i);
      }
      return hits;
    }

    // The single selected action's index when exactly one is selected (and
    // valid), else -1. Per-action resize handles only show for a lone
    // selection — a multi-selection still moves/restyles as a group, but
    // reshaping needs one unambiguous target (M30's rotate gizmo will gate the
    // same way). The set's sole member, read without spreading.
    private soleSelectedIndex(): number {
      if (this.selectedIndices.size !== 1) return -1;
      const i = this.selectedIndices.values().next().value ?? -1;
      return i >= 0 && i < this.state.actions.length ? i : -1;
    }

    // The id of the resize handle of `action` within `tol` (image-space px) of
    // (ix, iy), or null. Square hit region matching the drawn handles; the
    // handle list leads with corners so a corner wins over an overlapping edge.
    private hitTestActionHandle(
      action: Action,
      ix: number,
      iy: number,
      tol: number
    ): HandleId | null {
      const handles = action.getResizeHandles();
      if (!handles) return null;
      for (const h of handles) {
        if (Math.abs(ix - h.x) <= tol && Math.abs(iy - h.y) <= tol) return h.id;
      }
      return null;
    }

    // Whether two actions have identical resize-handle positions — i.e. the
    // same geometry. Used to skip a resize drag that ended where it started
    // (or a click on a handle without a drag), which would otherwise push a
    // content-identical, do-nothing undo step. Handle positions encode the full
    // geometry of every resizable type (box corners/edges, line endpoints,
    // stamp center+radius). See P1-03.
    private actionHandlesEqual(a: Action, b: Action): boolean {
      const ha = a.getResizeHandles();
      const hb = b.getResizeHandles();
      if (!ha || !hb || ha.length !== hb.length) return false;
      return ha.every((h, k) => h.id === hb[k].id && h.x === hb[k].x && h.y === hb[k].y);
    }

    // Cursor name for hovering (ix, iy) in select mode: a directional/endpoint
    // resize cursor over a resize handle, 'grab' over the rotate gizmo (which
    // sits outside the box, so it's checked first), else 'default'.
    private handleCursorAt(ix: number, iy: number): string {
      const i = this.soleSelectedIndex();
      if (i < 0) return 'default';
      const action = this.state.actions[i];
      const scale = this.currentTransform().scale;
      const tol = HANDLE_HIT_PX / scale;
      const g = this.rotateGizmo(action, scale);
      if (g && Math.abs(ix - g.hx) <= tol && Math.abs(iy - g.hy) <= tol) return 'grab';
      if (action.getResizeHandles()) {
        const handle = this.hitTestActionHandle(action, ix, iy, tol);
        if (handle) return cursorForHandle(handle, action.getOrientedBounds()?.angle ?? 0);
      }
      return 'default';
    }

    // Geometry of the rotate gizmo for `action` in image space, or null for a
    // non-rotatable action: the pivot (center), the connector stick's base on
    // the box edge, and the draggable handle. The direction is the action's
    // content rotation (so the gizmo tracks a rotated stamp/text), the distance
    // its up-extent plus a fixed widget-px arm.
    private rotateGizmo(
      action: Action,
      scale: number
    ): {cx: number; cy: number; ex: number; ey: number; hx: number; hy: number} | null {
      const ob = action.getOrientedBounds();
      const rot = action.getRotation();
      if (!ob || rot === null) return null;
      // Local "up" (0,-1) rotated by rot (Cairo's positive = CW) → (sin, -cos).
      const ux = Math.sin(rot);
      const uy = -Math.cos(rot);
      const edge = ob.halfH + 6 / scale; // just past the box edge
      const arm = edge + ROTATE_ARM_PX / scale; // the draggable handle
      return {
        cx: ob.cx,
        cy: ob.cy,
        ex: ob.cx + ux * edge,
        ey: ob.cy + uy * edge,
        hx: ob.cx + ux * arm,
        hy: ob.cy + uy * arm,
      };
    }

    // Begin a per-action rotation if the press lands on the rotate gizmo of the
    // lone selected (rotatable) action. Checked after tryBeginActionResize, but
    // the gizmo sits outside the box so they never overlap.
    private tryBeginActionRotate(wx: number, wy: number): boolean {
      const i = this.soleSelectedIndex();
      if (i < 0) return false;
      const action = this.state.actions[i];
      const scale = this.currentTransform().scale;
      const g = this.rotateGizmo(action, scale);
      if (!g) return false;
      const [ix, iy] = this.widgetToImage(wx, wy);
      const tol = HANDLE_HIT_PX / scale;
      if (Math.abs(ix - g.hx) > tol || Math.abs(iy - g.hy) > tol) return false;
      this.rotateGrab = true;
      this.actionPreview = null; // set on first drag-update; null = no rotation yet
      this.moving = false;
      this.shiftToggleDrag = false;
      return true;
    }

    // Commit an in-progress per-action resize or rotate at drag-end, pushing one
    // history entry only if the geometry (resize) or angle (rotate) actually
    // changed — so a click on a handle/gizmo without a drag, or a drag back to
    // the original, pushes nothing (P1-03). Returns true if a reshape was in
    // progress, so onDragEnd consumes the gesture.
    private commitActionReshape(): boolean {
      const wasResize = this.actionGrab !== null;
      if (!wasResize && !this.rotateGrab) return false;
      const i = this.soleSelectedIndex();
      const preview = this.actionPreview;
      this.actionGrab = null;
      this.rotateGrab = false;
      this.actionPreview = null;
      if (i >= 0 && preview) {
        const stored = this.state.actions[i];
        const changed = wasResize
          ? !this.actionHandlesEqual(preview, stored)
          : preview.getRotation() !== stored.getRotation();
        if (changed) {
          const cur = this.state.actions;
          this.pushState({
            surface: this.state.surface,
            actions: cur.map((a, j) => (j === i ? preview : a)),
          });
          // Remember a resized stamp's new radius as the next placement's
          // default (#6); persisted with the other tool styles when
          // rememberToolStyles is on. Rotations don't change the radius.
          if (wasResize) {
            const r = numberStampRadius(preview);
            if (r !== null) this.toolStampRadii.set('number', r);
          }
        }
      }
      this.queue_draw();
      return true;
    }

    // Begin a per-action resize if the press lands on a handle of the lone
    // selected action. Returns true when it grabs (the caller then skips the
    // normal select/move path). Handles take priority over move + reselection,
    // so a corner drag reshapes rather than moves. Non-resizable selections
    // (text/pen/highlighter return null handles) never grab.
    private tryBeginActionResize(wx: number, wy: number): boolean {
      const i = this.soleSelectedIndex();
      if (i < 0) return false;
      const action = this.state.actions[i];
      if (!action.getResizeHandles()) return false;
      const [ix, iy] = this.widgetToImage(wx, wy);
      const tol = HANDLE_HIT_PX / this.currentTransform().scale;
      const handle = this.hitTestActionHandle(action, ix, iy, tol);
      if (!handle) return false;
      this.actionGrab = handle;
      this.actionPreview = null; // set on first drag-update; null = no movement yet
      this.moving = false;
      this.shiftToggleDrag = false;
      return true;
    }

    // Topmost selected action whose bounds contain (ix, iy), or -1 if the
    // point is outside every selected action. Topmost = highest index, since
    // later actions render on top.
    private selectedIndexAt(ix: number, iy: number): number {
      const acts = this.state.actions;
      let best = -1;
      for (const i of this.selectedIndices) {
        if (i < 0 || i >= acts.length || i <= best) continue;
        if (acts[i].containsPoint(ix, iy)) best = i;
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

    // The next number for a stamp placed in the active group: stamps are
    // counted per group, so each group runs 1..N independently.
    private nextStampNumber(): number {
      let count = 0;
      for (const a of this.state.actions) {
        if (numberStampGroup(a) === this.placementGroupId) count++;
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
      const sole = this.soleSelectedIndex();
      const grabbing = this.actionGrab !== null || this.rotateGrab;
      for (const i of this.selectedIndices) {
        if (i < 0 || i >= acts.length || i === this.editingActionIndex) continue;
        // Mid-reshape: frame the live preview (no move offset — a reshape and a
        // move can't share a gesture). Otherwise the stored action, shifted by
        // any in-progress move. Rotatable actions draw an oriented box (text
        // tilts; the stamp's stays an upright square); everything else the AABB.
        let action: Action = acts[i];
        let ox = this.moving ? this.moveDx : 0;
        let oy = this.moving ? this.moveDy : 0;
        if (grabbing && this.actionPreview && i === sole) {
          action = this.actionPreview;
          ox = 0;
          oy = 0;
        }
        const ob = action.getOrientedBounds();
        if (ob) {
          drawOrientedSelectionBox(cr, ob, scale, ox, oy);
        } else {
          const bounds = action.getBounds();
          if (bounds) drawSelectionBox(cr, bounds, scale, ox, oy);
        }
      }
    }

    // Resize handles for the lone selected action (when resizable). Drawn at the
    // live preview's positions mid-resize so they track the drag. Hidden during
    // a move or a rotate (clutter) and while a text re-edit is open.
    private drawResizeHandles(cr: Cairo.Context, scale: number): void {
      if (this.moving || this.rotateGrab) return;
      const i = this.soleSelectedIndex();
      if (i < 0 || i === this.editingActionIndex) return;
      const action =
        this.actionGrab && this.actionPreview ? this.actionPreview : this.state.actions[i];
      const handles = action.getResizeHandles();
      if (!handles) return;
      for (const h of handles) drawResizeHandle(cr, h.x, h.y, scale);
    }

    // The rotate gizmo (a connector stick + round handle) for the lone selected
    // rotatable action. Drawn at the preview's angle mid-rotate so it tracks the
    // drag; hidden during a move or a resize, and while a text re-edit is open.
    private drawRotateGizmo(cr: Cairo.Context, scale: number): void {
      if (this.moving || this.actionGrab) return;
      const i = this.soleSelectedIndex();
      if (i < 0 || i === this.editingActionIndex) return;
      const action =
        this.rotateGrab && this.actionPreview ? this.actionPreview : this.state.actions[i];
      const g = this.rotateGizmo(action, scale);
      if (!g) return;
      drawRotateGizmo(cr, g.ex, g.ey, g.hx, g.hy, scale);
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
      if (this.currentToolId !== 'select' || this.moving || this.actionGrab || this.rotateGrab)
        return;
      const i = this.hoverCandidate;
      if (i < 0 || i >= acts.length || i === this.editingActionIndex) return;
      if (this.selectedIndices.size === 1 && this.selectedIndices.has(i)) return;
      const bounds = acts[i].getBounds();
      if (bounds) drawCandidateBox(cr, bounds, scale);
    }

    // A small "G<n>" badge floating at the top-right of every stamp that shares
    // a group with the current selection — so selecting one stamp reveals where
    // the rest of its group is. <n> is the group's gap-free ordinal, the same
    // label the Group dropdown shows. Only drawn when more than one group has
    // stamps; with a single group there's nothing to find. Overlay-only: it
    // decorates the canvas on screen and never enters an export (which replays
    // actions only). Stays upright regardless of stamp rotation.
    private drawGroupBadges(cr: Cairo.Context, acts: ReadonlyArray<Action>, scale: number): void {
      if (this.selectedIndices.size === 0) return;
      const groupIds = this.getStampGroupIds();
      if (groupIds.length < 2) return;
      // The groups represented in the selection; every stamp in any of them gets
      // a badge, selected or not.
      const activeGroups = new Set<number>();
      for (const i of this.selectedIndices) {
        if (i < 0 || i >= acts.length) continue;
        const g = numberStampGroup(acts[i]);
        if (g !== null) activeGroups.add(g);
      }
      if (activeGroups.size === 0) return;
      for (let i = 0; i < acts.length; i++) {
        if (i === this.editingActionIndex) continue;
        const g = numberStampGroup(acts[i]);
        if (g === null || !activeGroups.has(g)) continue;
        const bounds = acts[i].getBounds();
        if (!bounds) continue;
        // Only the selected stamps move during a drag; their unselected
        // group-mates stay put, so apply the move offset per stamp.
        const moved = this.moving && this.selectedIndices.has(i);
        const ox = moved ? this.moveDx : 0;
        const oy = moved ? this.moveDy : 0;
        drawGroupBadge(cr, bounds, scale, ox, oy, `G${groupIds.indexOf(g) + 1}`);
      }
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
      const sole = this.soleSelectedIndex();
      for (let i = 0; i < acts.length; i++) {
        if (i === this.editingActionIndex) continue;
        if ((this.actionGrab || this.rotateGrab) && this.actionPreview && i === sole) {
          // Mid-reshape (resize or rotate): render the preview in the stored
          // action's place.
          this.actionPreview.draw(cr, t.scale);
        } else if (this.moving && this.selectedIndices.has(i)) {
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
      this.drawResizeHandles(cr, t.scale);
      this.drawRotateGizmo(cr, t.scale);
      this.drawHoverCandidate(cr, acts, t.scale);
      this.drawGroupBadges(cr, acts, t.scale);

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

// An oriented (rotated) selection box: same solid-blue look as drawSelectionBox
// but tilted to the action's angle. ox/oy is the in-progress move offset.
function drawOrientedSelectionBox(
  cr: Cairo.Context,
  ob: OrientedBounds,
  scale: number,
  ox: number,
  oy: number
): void {
  const pad = 4 / scale;
  cr.save();
  cr.setSourceRGBA(0.0, 0.5, 1.0, 0.95); // solid blue
  cr.setLineWidth(1.5 / scale);
  cr.setDash([], 0);
  cr.setLineCap(Cairo.LineCap.BUTT);
  cr.setLineJoin(Cairo.LineJoin.MITER);
  cr.translate(ob.cx + ox, ob.cy + oy);
  cr.rotate(ob.angle);
  cr.rectangle(-ob.halfW - pad, -ob.halfH - pad, 2 * (ob.halfW + pad), 2 * (ob.halfH + pad));
  cr.stroke();
  cr.restore();
}

// The rotate gizmo: a connector stick from the box edge (ex, ey) to a round
// white handle at (hx, hy), in the same blue as the selection box.
function drawRotateGizmo(
  cr: Cairo.Context,
  ex: number,
  ey: number,
  hx: number,
  hy: number,
  scale: number
): void {
  cr.save();
  cr.setSourceRGBA(0.0, 0.5, 1.0, 0.95);
  cr.setLineWidth(1.5 / scale);
  cr.setDash([], 0);
  cr.setLineCap(Cairo.LineCap.ROUND);
  cr.moveTo(ex, ey);
  cr.lineTo(hx, hy);
  cr.stroke();
  const r = HANDLE_HIT_PX / 2 / scale;
  cr.newSubPath();
  cr.arc(hx, hy, r, 0, 2 * Math.PI);
  cr.setSourceRGBA(1, 1, 1, 1);
  cr.fillPreserve();
  cr.setSourceRGBA(0.0, 0.5, 1.0, 0.95);
  cr.stroke();
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

// A per-action resize handle: a small white square with a blue border (same
// blue as the selection box), centered on (x, y). Sized in widget pixels via
// 1/scale so it's a constant on-screen size at any zoom, and matched to
// HANDLE_HIT_PX so the visible square is also the hit target.
function drawResizeHandle(cr: Cairo.Context, x: number, y: number, scale: number): void {
  const half = HANDLE_HIT_PX / 2 / scale;
  cr.save();
  cr.setDash([], 0);
  cr.setLineJoin(Cairo.LineJoin.MITER);
  cr.rectangle(x - half, y - half, 2 * half, 2 * half);
  cr.setSourceRGBA(1, 1, 1, 1);
  cr.fillPreserve();
  cr.setSourceRGBA(0.0, 0.5, 1.0, 0.95);
  cr.setLineWidth(1 / scale);
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

function roundedRectPath(
  cr: Cairo.Context,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  cr.newSubPath();
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2);
  cr.closePath();
}

// A translucent dark pill with light text, anchored just off the top-right of
// the stamp's bounds. All dimensions are widget pixels converted to image space
// (/scale) so the badge is a constant on-screen size at any zoom. Drawn with
// Cairo's toy text API — plenty for a two-glyph label, and self-contained
// (no Pango layout to manage in the overlay pass).
function drawGroupBadge(
  cr: Cairo.Context,
  bounds: Bounds,
  scale: number,
  ox: number,
  oy: number,
  text: string
): void {
  const u = 1 / scale; // one widget pixel in image-space units
  const fontPx = 11;
  const padX = 4;
  const padY = 2;

  cr.save();
  cr.translate(ox, oy);
  cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
  cr.setFontSize(fontPx * u);
  // The label is always "G" + digits — all full-height glyphs, no descenders —
  // so the ink extents give a stable pill size across group numbers (GJS's
  // Cairo binding doesn't expose fontExtents).
  const te = cr.textExtents(text);
  const boxW = te.width + 2 * padX * u;
  const boxH = te.height + 2 * padY * u;

  // Lower-left corner of the pill sits at the stamp's top-right, with a few
  // pixels of overlap so it reads as attached rather than floating loose.
  const overlap = 3 * u;
  const x = bounds.x2 - overlap;
  const y = bounds.y1 - boxH + overlap;

  roundedRectPath(cr, x, y, boxW, boxH, 3 * u);
  cr.setSourceRGBA(0, 0, 0, 0.66);
  cr.fill();

  cr.setSourceRGBA(1, 1, 1, 0.97);
  // Offset by the glyph bearings so the text sits padded inside the pill: x by
  // the left side bearing, y by the (negative) top bearing to drop the baseline.
  cr.moveTo(x + padX * u - te.xBearing, y + padY * u - te.yBearing);
  cr.showText(text);
  cr.restore();
}
