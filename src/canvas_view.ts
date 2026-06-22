import GObject from 'gi://GObject?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Cairo from 'cairo';

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
  SHAPE_TEXT_STYLE,
  StampVariant,
  ToolId,
  TRANSPARENT_FILL,
  actionToolId,
  createLiveStroke,
  defaultColorForTool,
  defaultTextColorForTool,
  defaultCornerRadiusForTool,
  defaultDashForTool,
  defaultFillForTool,
  defaultFilledHeadForTool,
  defaultFontDescForTool,
  defaultFontSizeForTool,
  defaultWidthForTool,
  isNumberStampAction,
  isShapeAction,
  isTextAction,
  getShapeTextEditState,
  getTextEditState,
  makeNumberStampAction,
  numberStampGroup,
  numberStampRadius,
  numberStampStyle,
  numberStampVariant,
  reassignStamp,
  renumberStamps,
  roundedRectPath,
  setStampVariantInGroup,
  shapeWithoutText,
  styleValuesEqual,
} from './actions.js';
import {resizeSurface, rotateSurface} from './image_transforms.js';
import {renderToSurface} from './exporter.js';
import type {EditorSize, RotateDirection, TextAlign, TextStyle} from './actions.js';
import type {ToolStyleEntry, ToolStylesSnapshot} from './settings.js';
import {announce, setAccessibleDescription, setAccessibleLabel} from './a11y.js';
import {TOOLS} from './window_constants.js';
import {_, formatN} from './i18n.js';

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
  // Canvas display scale at request time, so the standalone editor previews
  // text at its rendered on-screen size (box mode carries its own scale).
  scale?: number;
  // Shape-text edit: the box shape's index, its current text style, and the
  // box's inner text rect in widget px (+ zoom). The window turns these into the
  // editor's box mode + commit target. Absent → a standalone TextAction edit.
  shapeIndex?: number;
  textStyle?: TextStyle;
  boxMode?: {boxW: number; boxH: number; scale: number};
}

export type TextEditRequest = (
  imageX: number,
  imageY: number,
  widgetX: number,
  widgetY: number,
  options?: TextEditRequestOptions
) => void;

// Asks the host to commit any in-progress text edit. The canvas holds no
// editor reference of its own (it reaches the editor only through callbacks),
// so a canvas press that should finish a re-edit routes the commit back out
// through this. The window wires it to TextEditor.commitIfActive.
export type CommitRequest = () => void;

function isShift(gesture: Gtk.GestureDrag): boolean {
  return (gesture.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK) !== 0;
}

// Unit [dx, dy] for an arrow keyval (including the keypad arrows), or null for
// any other key. Drives both the keyboard nudge and candidate browse.
function arrowDirection(keyval: number): [number, number] | null {
  switch (keyval) {
    case Gdk.KEY_Up:
    case Gdk.KEY_KP_Up:
      return [0, -1];
    case Gdk.KEY_Down:
    case Gdk.KEY_KP_Down:
      return [0, 1];
    case Gdk.KEY_Left:
    case Gdk.KEY_KP_Left:
      return [-1, 0];
    case Gdk.KEY_Right:
    case Gdk.KEY_KP_Right:
      return [1, 0];
    default:
      return null;
  }
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
  // Snap the edges to whole pixels: drag coordinates are fractional (widget px
  // ÷ zoom), but a Cairo surface has integral dimensions — GJS truncates
  // fractional ones — so without snapping the applied canvas comes out a pixel
  // smaller than the (rounded) status readout, the crop lands off the dashed
  // preview, and actions translate by a fractional origin that leaves them
  // sub-pixel offset from the pixels they were drawn over. Rounding here keeps
  // every consumer (overlay, readout, apply) on one integral rectangle.
  const minX = Math.round(Math.min(r.x1, r.x2));
  const maxX = Math.round(Math.max(r.x1, r.x2));
  const minY = Math.round(Math.min(r.y1, r.y2));
  const maxY = Math.round(Math.max(r.y1, r.y2));
  if (maxX - minX < 1 || maxY - minY < 1) return null;
  return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
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

// Keyboard nudge distances, in widget pixels (converted to image space through
// the current scale, like CLONE_OFFSET_PX, so a press moves the same on-screen
// amount at any zoom). Plain arrow = fine, Shift+arrow = coarse.
const NUDGE_SMALL_PX = 1;
const NUDGE_LARGE_PX = 10;

// Keyboard pan step, in widget pixels (the scroll adjustments are widget-space,
// so a fixed step scrolls the same on-screen amount at any zoom). Used when an
// arrow key isn't nudging a selection or placing. Plain = fine, Shift = coarse.
const KEY_PAN_PX = 50;
const KEY_PAN_LARGE_PX = 250;

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

    // Last known pointer position in widget-local coords, for the hover/dig
    // aim (the stack under the pointer). null when the pointer is outside the
    // widget.
    private lastPointer: [number, number] | null = null;

    private liveStroke: LiveStroke | null = null;
    private currentToolId: ToolId = 'pen';

    private dragStartX: number = 0;
    private dragStartY: number = 0;

    // True while a right-click-drag pan is in progress. The gesture itself lives
    // on the ScrolledWindow (a frame that doesn't move as the content scrolls,
    // so the drag offsets are real pointer movement — see ZoomController); the
    // canvas only needs to know a pan is active so its hover/cursor logic holds.
    private panning: boolean = false;

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

    // Marquee (rubber-band) selection. A select-tool drag begun on empty canvas
    // sweeps a dashed rectangle; on release, every action whose box is fully
    // inside it becomes the selection (replacing any prior one). Both corners
    // are stored in IMAGE space (anchor + live corner) so the band stays pinned
    // to the image if the view scrolls mid-drag. `bandStart` non-null = a band
    // is armed (set on the empty press); `bandCurrent` stays null until the
    // pointer actually moves, so a bare click clears without selecting.
    private bandStart: [number, number] | null = null;
    private bandCurrent: [number, number] | null = null;

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

    // One-press latch: set when a press is consumed by committing an open
    // text editor — a click-away from a re-edit, or a text-tool click-away
    // whose commit switched the tool to select (select-after-placement). The
    // same press's drag-begin/update/end must not also select, move, or
    // toggle: they can run after the commit cleared editingActionIndex (or
    // after the tool switch), so those checks alone can't stop them. Reset in
    // onDragEnd (fires for every primary press) so it never leaks.
    private suppressSelectThisPress: boolean = false;

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
    private onCommitRequest: CommitRequest | null = null;
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

    // Per-tool current text-foreground color (the getTextColor channel). Only
    // the text tool has one today; other tools never get an entry.
    private toolTextColors: Map<ToolId, ColorRGBA> = new Map();

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

    // Per-tool rectangle corner radius (image-space px). Only 'rect' ever has an
    // entry; every other tool has no corner radius (returns null).
    private toolCornerRadii: Map<ToolId, number> = new Map();

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
    // placement inherits the size), read at placement. Not a "width", so
    // it gets its own slot rather than reusing toolWidths.
    private toolStampRadii: Map<ToolId, number> = new Map();

    // Pixel-memory budget (bytes) for the distinct surfaces history retains;
    // null = unbounded. Annotation edits share their surface by reference, but
    // every rotate / canvas-resize pushes a freshly allocated full-resolution
    // surface — a transform-heavy history is where the memory goes, so the
    // bound is on surface bytes (stride × height), not entry count. The value
    // is policy and comes from the window (the user's undo-memory preference);
    // the canvas only enforces it.
    private surfaceBytesCap: number | null = null;

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
      // focusable so the canvas joins the Tab chain and can be driven by the
      // keyboard (select/nudge/place); GROUP role + a name so AT announces it
      // as a meaningful region rather than a bare drawing surface.
      super({
        hexpand: true,
        vexpand: true,
        focusable: true,
        accessible_role: Gtk.AccessibleRole.GROUP,
        css_classes: ['annoscr-canvas'],
      });
      setAccessibleLabel(this, _('Annotation canvas'));
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
      this.installKeyboard();
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
      this.enforceSurfaceCap();
      this.lastCoalesceKey = coalesceKey;
      this.notifyStateChange();
    }

    // Apply the user's undo-memory preference (bytes; null = unlimited) and
    // re-enforce it on the live history immediately, so lowering the budget
    // releases memory without waiting for the next edit. Listeners are
    // notified since the trim may have changed history.
    setUndoMemoryBudget(bytes: number | null): void {
      if (this.surfaceBytesCap === bytes) return;
      this.surfaceBytesCap = bytes;
      this.enforceSurfaceCap();
      this.notifyStateChange();
    }

    // Drop the oldest history entries until the distinct surfaces the
    // survivors reference fit surfaceBytesCap. The trim is a strict prefix: an
    // entry can't outlive its surface (the entry IS {surface, actions}), so
    // evicting a surface takes every entry that references it — and everything
    // older — with it. The newest distinct surface is always retained
    // regardless of size (the current image must exist), so on a source whose
    // single surface busts the budget, only cross-transform undo is lost —
    // annotation entries sharing the current surface cost nothing and survive.
    // The cut is clamped to the cursor for the live budget-lowering case
    // (setUndoMemoryBudget after undos): the state being viewed is never
    // trimmed, even if redo entries alone exceed the budget.
    private enforceSurfaceCap(): void {
      if (this.surfaceBytesCap === null) return;
      const seen = new Set<Cairo.ImageSurface>();
      let bytes = 0;
      for (let i = this.history.length - 1; i >= 0; i--) {
        const s = this.history[i].surface;
        if (!s || seen.has(s)) continue;
        const size = s.getStride() * s.getHeight();
        if (seen.size >= 1 && bytes + size > this.surfaceBytesCap) {
          const cut = Math.min(i + 1, this.historyCursor);
          if (cut > 0) {
            this.history.splice(0, cut);
            this.historyCursor -= cut;
          }
          return;
        }
        seen.add(s);
        bytes += size;
      }
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

    // Load a saved annotation document: the source surface plus its editable
    // actions, as a fresh single-entry history (no undo across the load — opening
    // a file is a clean baseline, not an edit). Mirrors setImage's reset, then
    // restores stamp-group bookkeeping from the loaded stamps and marks clean.
    loadDocument(surface: Cairo.ImageSurface, actions: ReadonlyArray<Action>): void {
      const restored = renumberStamps(actions);
      this.history = [{surface, actions: restored}];
      this.historyCursor = 0;
      this.cleanStateRef = this.history[0];
      this.lastCoalesceKey = null;
      // Mint future group ids above the highest loaded one (never reused) and
      // continue placement in the last group present. Variants are read straight
      // from the stamps by groupVariantFor, so groupVariants stays empty; the
      // remembered defaultStampVariant (a tool preference) survives the load.
      let maxGroup = 0;
      for (const a of restored) {
        const g = numberStampGroup(a);
        if (g !== null && g > maxGroup) maxGroup = g;
      }
      this.placementGroupId = maxGroup >= 1 ? maxGroup : 1;
      this.nextGroupId = Math.max(2, maxGroup + 1);
      this.groupVariants.clear();
      this.mode = 'fit';
      this.zoomFactor = 1;
      this.pendingInitialZoom = true;
      this.resetTransientState();
      this.updateSizeRequest();
      this.queue_draw();
      this.notifyStateChange();
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

    // The widget-space position of image-space (0, 0) — the centering/
    // letterbox margins plus any displayed-area origin shift. Without it a
    // cursor-anchored zoom is wrong whenever the image doesn't fill the
    // viewport. Null mirrors getZoomScale.
    getViewOffset(): [number, number] | null {
      const s = this.state.surface;
      if (!s) return null;
      const w = this.get_width();
      const h = this.get_height();
      if (w <= 0 || h <= 0) return null;
      const t = this.computeTransform(w, h);
      return [t.offsetX, t.offsetY];
    }

    // The post-layout geometry for a fixed zoom: the content size the canvas
    // will occupy (viewport-bounded below) and where image-space (0, 0) will
    // land. Mirrors updateSizeRequest + computeTransform so the zoom
    // controller can scroll for a new zoom BEFORE the relayout — until then
    // the live transform still reflects the old allocation. Null with no
    // image.
    predictLayout(zoom: number): {offX: number; offY: number; w: number; h: number} | null {
      if (!this.state.surface) return null;
      const area = this.displayedArea();
      const vis = this.visibleRect();
      const w = Math.max(Math.ceil(area.w * zoom), Math.round(vis.w));
      const h = Math.max(Math.ceil(area.h * zoom), Math.round(vis.h));
      return {
        offX: Math.floor((w - area.w * zoom) / 2 - area.x * zoom),
        offY: Math.floor((h - area.h * zoom) / 2 - area.y * zoom),
        w,
        h,
      };
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

    // Current source surface plus its editable actions (NOT flattened), for
    // saving an annotation file. Null when there's no image.
    documentSnapshot(): {surface: Cairo.ImageSurface; actions: ReadonlyArray<Action>} | null {
      const s = this.state.surface;
      if (!s) return null;
      return {surface: s, actions: this.state.actions};
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

    setCommitRequestHandler(handler: CommitRequest | null): void {
      this.onCommitRequest = handler;
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
      // 'text' has no stroke/outline — its glyph color is the text-color
      // channel (getToolTextColor), so the generic Color control hides for it.
      if (toolId === 'select' || toolId === 'resize' || toolId === 'text') return null;
      return this.toolColors.get(toolId) ?? defaultColorForTool(toolId);
    }

    setToolColor(toolId: ToolId, color: ColorRGBA): void {
      this.toolColors.set(toolId, color);
    }

    // Current text-foreground color for the given tool, falling back to the
    // static default. Null for tools with no editable text color.
    getToolTextColor(toolId: ToolId): ColorRGBA | null {
      const def = defaultTextColorForTool(toolId);
      if (def === null) return null;
      return this.toolTextColors.get(toolId) ?? def;
    }

    setToolTextColor(toolId: ToolId, color: ColorRGBA): void {
      this.toolTextColors.set(toolId, color);
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

    // Current corner radius for the given tool. Returns null for every tool but
    // 'rect' (the Corners slider hides accordingly).
    getToolCornerRadius(toolId: ToolId): number | null {
      const def = defaultCornerRadiusForTool(toolId);
      if (def === null) return null;
      return this.toolCornerRadii.get(toolId) ?? def;
    }

    setToolCornerRadius(toolId: ToolId, radius: number): void {
      this.toolCornerRadii.set(toolId, radius);
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

    // The text style a fresh (textless) shape edit seeds from: the last style
    // committed for this shape tool, or one set via a select-mode text edit,
    // falling back to the static shape-text default. Color/font/size only —
    // alignment and the (unused) background plate stay the shape-text defaults.
    // Mirrors how a drawing tool seeds a new placement from its remembered style.
    private rememberedShapeTextStyle(toolId: ToolId): TextStyle {
      return {
        ...SHAPE_TEXT_STYLE,
        color: this.toolTextColors.get(toolId) ?? SHAPE_TEXT_STYLE.color,
        fontDesc: this.toolFontDescs.get(toolId) ?? SHAPE_TEXT_STYLE.fontDesc,
        size: this.toolFontSizes.get(toolId) ?? SHAPE_TEXT_STYLE.size,
      };
    }

    // Remember a committed shape's text style so the next text added to a shape
    // of the same tool (rect / oval, kept independently) starts from it. No-op
    // for non-shape actions. Tool state, not document state — not pushed to
    // history. The same per-tool maps a select-mode text edit already writes.
    rememberShapeTextStyle(index: number, style: TextStyle): void {
      const action = this.state.actions[index];
      if (!action) return;
      const tool = actionToolId(action);
      if (tool !== 'rect' && tool !== 'oval') return;
      this.setToolTextColor(tool, style.color);
      this.setToolFontDesc(tool, style.fontDesc);
      this.setToolFontSize(tool, style.size);
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
      const rest = cur.filter((_a, i) => !moveSet.has(i));

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
      // The splice moved actions around; re-derive the cached hover candidate
      // (see reorderSelected).
      this.refreshHoverCandidate();
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
      for (const [id, c] of this.toolTextColors) ensure(id).textColor = c;
      for (const [id, w] of this.toolWidths) ensure(id).width = w;
      for (const [id, f] of this.toolFills) ensure(id).fill = f;
      for (const [id, d] of this.toolDashes) ensure(id).dash = d;
      for (const [id, h] of this.toolFilledHeads) ensure(id).filledHead = h;
      for (const [id, r] of this.toolCornerRadii) ensure(id).cornerRadius = r;
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
        if (e.textColor) this.toolTextColors.set(toolId, e.textColor);
        if (e.width !== undefined) this.toolWidths.set(toolId, e.width);
        if (e.fill) this.toolFills.set(toolId, e.fill);
        if (e.dash) this.toolDashes.set(toolId, e.dash);
        if (e.filledHead !== undefined) this.toolFilledHeads.set(toolId, e.filledHead);
        if (e.cornerRadius !== undefined) this.toolCornerRadii.set(toolId, e.cornerRadius);
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

    // Select every action (Ctrl+A). Consumes the key (returns true) only with
    // the select tool active and at least one action — whether or not the set
    // actually changed — so it doesn't leak to the scroller; returns false
    // otherwise so the accelerator falls through.
    selectAll(): boolean {
      if (this.currentToolId !== 'select' || this.state.actions.length === 0) return false;
      const prevKey = this.selectionKey();
      this.selectedIndices.clear();
      for (let i = 0; i < this.state.actions.length; i++) this.selectedIndices.add(i);
      if (this.selectionKey() !== prevKey) {
        this.lastCoalesceKey = null;
        this.notifyStateChange();
      }
      this.queue_draw();
      return true;
    }

    // Replace the selection with every action whose footprint is fully inside
    // the marquee rectangle (image-space corners). Rotatable actions test their
    // oriented (tilted) box, so a rotated shape counts only when its real
    // footprint fits — not its looser axis-aligned bounds; everything else uses
    // its axis-aligned bounds. Selection isn't undo history, so this only
    // notifies (no pushState).
    private selectBand(x1: number, y1: number, x2: number, y2: number): void {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      const prevKey = this.selectionKey();
      this.selectedIndices.clear();
      this.state.actions.forEach((a, i) => {
        const corners = actionCorners(a);
        if (
          corners &&
          corners.every(([px, py]) => px >= minX && px <= maxX && py >= minY && py <= maxY)
        ) {
          this.selectedIndices.add(i);
        }
      });
      if (this.selectionKey() !== prevKey) {
        this.lastCoalesceKey = null;
        this.notifyStateChange();
      }
    }

    // Cancel an in-progress marquee drag (Escape). Returns true if a band was
    // active so the caller consumes the key; the pending drag-end then finds no
    // band and ends inertly. Leaves the selection untouched — Escape with no
    // band falls through to clearSelection.
    cancelBand(): boolean {
      if (!this.bandStart) return false;
      this.bandStart = null;
      this.bandCurrent = null;
      this.queue_draw();
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
      // each one's default.
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
        // visible. Skip those actions.
        if (styleValuesEqual(current, value)) return a;
        changed = true;
        return apply(a, value);
      });
      // No selected action supports this property — the picker shouldn't have
      // been active; treat as not handled.
      if (!applicable) return false;
      // Remember this select-mode edit as the matching tools' default so the
      // next placement with that tool inherits it. Only the edited types'
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

    replaceSelectedTextColor(color: ColorRGBA): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getTextColor(),
        (a, v) => a.withTextColor(v),
        color,
        'textColor',
        (tid, v) => this.setToolTextColor(tid, v)
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

    replaceSelectedCornerRadius(radius: number): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getCornerRadius(),
        (a, v) => a.withCornerRadius(v),
        radius,
        'cornerRadius',
        (tid, v) => this.setToolCornerRadius(tid, v)
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

    // Alignment only lives on a shape's embedded text (a document property), so
    // there's no tool default to write — the setToolDefault callback is a no-op.
    replaceSelectedAlign(align: TextAlign): boolean {
      return this.replaceSelectedProperty(
        (a) => a.getAlign(),
        (a, v) => a.withAlign(v),
        align,
        'align',
        () => {}
      );
    }

    private notifyStateChange(): void {
      this.updateSizeRequest();
      this.updateAccessibleState();
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

    // Width × height of the currently-defined resize region — whole pixels,
    // exactly what applyResize will produce (normalizeRegion snaps the rect) —
    // or null if no region or not in resize mode.
    getResizeDimensions(): {w: number; h: number} | null {
      if (this.currentToolId !== 'resize') return null;
      const r = this.getResizeRect();
      if (!r) return null;
      return {w: r.w, h: r.h};
    }

    addAction(action: Action): void {
      this.pushState({
        surface: this.state.surface,
        actions: [...this.state.actions, action],
      });
      this.queue_draw();
      announce(this, _('%s added').replace('%s', this.describeAction(action)));
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
      const survivors = renumberStamps(cur.filter((_a, i) => i !== index));
      this.collapseEmptyPlacementGroup(survivors);
      this.pushState({
        surface: this.state.surface,
        actions: survivors,
      });
      if (this.editingActionIndex === index) this.editingActionIndex = -1;
      this.selectedIndices.clear();
      // Removal shifted every index above it; re-derive the cached hover
      // candidate or it would outline (and Space-select) whatever slid into
      // the old slot (see reorderSelected).
      this.refreshHoverCandidate();
      this.queue_draw();
    }

    deleteSelected(): boolean {
      const cur = this.state.actions;
      if (this.selectedIndices.size === 0) return false;
      const sel = this.selectedIndices;
      // Drop every selected action in one history entry. Renumber stamps so
      // deleting "2" from "1,2,3" leaves "1,2" — not "1,3" with a hole that
      // the next placement would duplicate.
      const survivors = renumberStamps(cur.filter((_a, i) => !sel.has(i)));
      this.collapseEmptyPlacementGroup(survivors);
      const removed = cur.length - survivors.length;
      this.pushState({
        surface: this.state.surface,
        actions: survivors,
      });
      this.selectedIndices.clear();
      // Deletion shifted the indices above the removed actions; re-derive the
      // cached hover candidate (see reorderSelected).
      this.refreshHoverCandidate();
      this.queue_draw();
      announce(this, formatN(_('%d deleted'), removed));
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
      const rest = cur.filter((_a, i) => !selSet.has(i));
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

    // Returns the resize region normalized (positive w/h) and snapped to whole
    // pixels (see normalizeRegion) if defined and non-degenerate. May extend
    // outside the current image bounds — that means "the new canvas pads
    // beyond the current image."
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
      // The actions moved with the image, so the cached candidate index now
      // points at a different on-screen spot than the (motionless) pointer.
      // Re-derive it from what's actually under the cursor in the rotated frame.
      this.refreshHoverCandidate();
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
        // Take focus so the keyboard path (select/nudge/place) works after a
        // click without a separate Tab to the canvas.
        if (!this.has_focus) this.grab_focus();
        if (n_press === 2 && this.currentToolId === 'select') {
          this.onSelectDoubleClick(x, y);
          return;
        }
        // Past the first press, a placement tool would just re-place at the same
        // spot — a hidden stacked stamp (number jumps by 2), a doubled pen dot.
        // Ignore it. GTK only reports n_press >= 2 for near-coincident clicks,
        // so rapid placement at distinct spots (n_press resets to 1) is
        // unaffected; this only drops the degenerate stacked placement.
        if (n_press >= 2 && this.currentToolId !== 'select') return;
        // A first press on the canvas (necessarily outside the editor frame,
        // which would have swallowed it) while a text is being re-edited
        // finishes that edit, consistent with the text tool. The press is
        // consumed — it doesn't select or move anything; a second press
        // selects normally. n_press === 1 keeps this off the press that opens
        // the editor (n_press === 2 above) and off that double-click's first
        // press (editingActionIndex is still -1 then).
        if (n_press === 1 && this.currentToolId === 'select' && this.editingActionIndex >= 0) {
          this.suppressSelectThisPress = true;
          if (this.onCommitRequest) this.onCommitRequest();
          return;
        }
        const toolAtPress = this.currentToolId;
        this.onCanvasPress(x, y);
        // A text-tool press that commits an open editor can switch the tool to
        // select mid-press (select-after-placement picks the new text). Latch
        // so the rest of THIS press's gesture doesn't also run the select
        // path: drag-begin would re-resolve at the click point and clear (or
        // steal) that fresh selection, and a moving release would drag it.
        // Same consumed-press rule as the re-edit commit above.
        if (toolAtPress === 'text' && this.currentToolId === 'select') {
          this.suppressSelectThisPress = true;
        }
      });
      this.add_controller(click);

      this.set_cursor_from_name(cursorForTool(this.currentToolId));
    }

    // The keyboard path for placed annotations. The key controller drives
    // select/nudge/place (bubble phase — a true return consumes the event so a
    // nudge doesn't also scroll the enclosing ScrolledWindow, a false return
    // lets it fall through). The focus ring is CSS (:focus-visible), so GTK
    // repaints it on focus changes — no manual redraw needed here.
    private installKeyboard(): void {
      const keys = new Gtk.EventControllerKey();
      keys.connect('key-pressed', (_c, keyval, _code, state) => this.onKeyPressed(keyval, state));
      this.add_controller(keys);
    }

    // Route a key press to the matching keyboard gesture; returns true when it
    // acted (consuming the event).
    private onKeyPressed(keyval: number, state: Gdk.ModifierType): boolean {
      if (!this.state.surface || this.editingActionIndex >= 0) return false;
      const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
      const alt = (state & Gdk.ModifierType.ALT_MASK) !== 0;
      const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;

      const arrow = arrowDirection(keyval);
      const isSpace = keyval === Gdk.KEY_space || keyval === Gdk.KEY_KP_Space;

      // Modifier + arrow transforms the lone selection: Alt+Left/Right rotates
      // 15° (Left = CCW, Right = CW), Ctrl+arrows resize. Other modifier+arrow
      // combos aren't ours.
      if (arrow && (ctrl || alt)) {
        if (alt && !ctrl && arrow[1] === 0) return this.rotateSelectionStep(arrow[0]);
        if (ctrl && !alt) return this.resizeSelectionStep(arrow[0], arrow[1], shift);
        return false;
      }
      // Other Ctrl/Alt chords belong to the window (zoom, z-order, canvas
      // rotate).
      if (ctrl || alt) return false;
      return this.onPlainKey(keyval, arrow, isSpace, shift);
    }

    // Unmodified key routing (split out to keep onKeyPressed's branching modest).
    // Placement tools place on Space; select-tool keys are handled separately;
    // in every tool a bare arrow that isn't nudging a selection pans the canvas.
    private onPlainKey(
      keyval: number,
      arrow: [number, number] | null,
      isSpace: boolean,
      shift: boolean
    ): boolean {
      if (this.currentToolId === 'number' || this.currentToolId === 'text') {
        if (isSpace && !shift) return this.placeAtViewportCenter();
      } else if (this.currentToolId === 'select') {
        return this.onSelectKey(keyval, arrow, isSpace, shift);
      }
      return arrow ? this.panByKey(arrow[0], arrow[1], shift) : false;
    }

    // Select-tool keyboard navigation (split out of onKeyPressed to keep each
    // method's branching modest):
    //   [ / ]   walk the candidate through the whole stack (pointer-free); bare
    //           brackets only — Ctrl+[/] is the window's z-order restack.
    //   Space   select the aimed candidate (Shift+Space toggles — a window
    //           binding, so leave it).
    //   arrows  nudge the selection; pan the canvas when none picked.
    private onSelectKey(
      keyval: number,
      arrow: [number, number] | null,
      isSpace: boolean,
      shift: boolean
    ): boolean {
      if (keyval === Gdk.KEY_bracketright) return this.keyboardBrowseCandidate(1);
      if (keyval === Gdk.KEY_bracketleft) return this.keyboardBrowseCandidate(-1);
      if (isSpace && !shift) return this.selectCandidate();
      if (arrow) {
        if (this.selectedIndices.size === 0) return this.panByKey(arrow[0], arrow[1], shift);
        return this.nudgeSelection(arrow[0], arrow[1], shift);
      }
      return false;
    }

    // Walk the candidate one step through the whole action stack (topmost
    // first), independent of the pointer — the keyboard alternative to the
    // mouse aim/dig. Establishes it at the topmost action on the first press,
    // wraps at the ends, and announces what it landed on; the dashed candidate
    // outline shows where the next Space will select. False when there are no
    // annotations to walk.
    private keyboardBrowseCandidate(dir: number): boolean {
      const acts = this.state.actions;
      const list: number[] = [];
      for (let i = acts.length - 1; i >= 0; i--) {
        if (i !== this.editingActionIndex) list.push(i);
      }
      if (list.length === 0) return false;
      const pos = list.indexOf(this.hoverCandidate);
      const next = pos < 0 ? 0 : (((pos + dir) % list.length) + list.length) % list.length;
      this.hoverCandidate = list[next];
      // Drop the pointer-stack key so a later pointer move re-resolves from
      // scratch instead of treating this keyboard pick as a dig in an old stack.
      this.digStackKey = '';
      this.digDepth = 0;
      this.queue_draw();
      // Speak what the candidate is now, since the dashed outline is the only
      // other cue — this is how a screen-reader user "sees" the walk.
      announce(this, this.describeAction(acts[this.hoverCandidate]));
      return true;
    }

    // Select the current candidate alone — the keyboard twin of a plain click.
    // False when there's no candidate so Space can fall through.
    private selectCandidate(): boolean {
      const i = this.hoverCandidate;
      if (i < 0 || i >= this.state.actions.length || i === this.editingActionIndex) return false;
      this.selectedIndices.clear();
      this.selectedIndices.add(i);
      this.lastCoalesceKey = null;
      this.queue_draw();
      this.notifyStateChange();
      announce(this, this.describeSelection());
      return true;
    }

    // Move the selection one keyboard step in image space (widget-px / scale, so
    // the on-screen step is zoom-independent). Coalesced so a run of presses is
    // one undo entry, like a drag. Always consumes the arrow (so it doesn't also
    // scroll the viewport).
    private nudgeSelection(dx: number, dy: number, large: boolean): boolean {
      const cur = this.state.actions;
      const sel = this.selectedIndices;
      if (sel.size === 0) return false;
      const scale = this.currentTransform().scale;
      const step = (large ? NUDGE_LARGE_PX : NUDGE_SMALL_PX) / scale;
      this.pushState(
        {
          surface: this.state.surface,
          actions: cur.map((a, j) => (sel.has(j) ? a.translate(dx * step, dy * step) : a)),
        },
        `nudge:${this.selectionKey()}`
      );
      this.queue_draw();
      return true;
    }

    // Scroll (pan) the view one keyboard step when an arrow isn't nudging a
    // selection or placing — the keyboard counterpart to right-drag panning.
    // The step is widget pixels (set_value self-clamps to the scrollable range).
    // False with no scrolled ancestor, so the arrow can fall through.
    private panByKey(dx: number, dy: number, large: boolean): boolean {
      const sw = this.scrolledAncestor();
      if (!sw) return false;
      const step = large ? KEY_PAN_LARGE_PX : KEY_PAN_PX;
      if (dx !== 0) {
        const h = sw.get_hadjustment();
        h.set_value(h.get_value() + dx * step);
      }
      if (dy !== 0) {
        const v = sw.get_vadjustment();
        v.set_value(v.get_value() + dy * step);
      }
      return true;
    }

    // Rotate the lone selected action to the next 15° increment (dir > 0 = CW,
    // < 0 = CCW), reusing the gizmo's per-action rotation. Snaps to the next
    // grid line in the travel direction so repeated presses land on clean
    // multiples even from an odd gizmo angle. Coalesced into one undo entry per
    // run; false (so Alt+arrow falls through) unless a rotatable item is solely
    // selected.
    private rotateSelectionStep(dir: number): boolean {
      const i = this.soleSelectedIndex();
      if (i < 0) return false;
      const action = this.state.actions[i];
      const rot = action.getRotation();
      if (rot === null) return false;
      const k = rot / ROTATE_SNAP;
      const eps = 1e-6;
      const stepped = (dir > 0 ? Math.floor(k + eps) + 1 : Math.ceil(k - eps) - 1) * ROTATE_SNAP;
      const twoPi = 2 * Math.PI;
      const next = ((stepped % twoPi) + twoPi) % twoPi; // keep the stored angle bounded
      this.pushState(
        {
          surface: this.state.surface,
          actions: this.state.actions.map((a, j) => (j === i ? a.withRotation(next) : a)),
        },
        `rotate:${i}`
      );
      this.queue_draw();
      announce(this, formatN(_('Rotated to %d°'), Math.round((next * 180) / Math.PI)));
      return true;
    }

    // Resize the lone selected action one keyboard step by driving its primary
    // handle — the bottom-right corner of a box/stamp, or the second endpoint of
    // a line/arrow (the handle a mouse user grabs to grow it). Reuses
    // resizeByHandle, so a rotated box resizes in its own frame and the stamp
    // stays square. Step is widget-px / scale (Shift = larger), coalesced into
    // one undo entry per run; a no-op (clamped at the minimum) is consumed but
    // not pushed. False (so Ctrl+arrow falls through) unless a resizable item is
    // solely selected.
    private resizeSelectionStep(dx: number, dy: number, large: boolean): boolean {
      const i = this.soleSelectedIndex();
      if (i < 0) return false;
      const action = this.state.actions[i];
      const handles = action.getResizeHandles();
      if (!handles) return false;
      const handle = handles.find((h) => h.id === 'br') ?? handles.find((h) => h.id === 'p2');
      if (!handle) return false;
      const step = (large ? NUDGE_LARGE_PX : NUDGE_SMALL_PX) / this.currentTransform().scale;
      const resized = action.resizeByHandle(
        handle.id,
        handle.x + dx * step,
        handle.y + dy * step,
        false
      );
      if (this.actionHandlesEqual(action, resized)) return true; // at the min clamp
      this.pushState(
        {
          surface: this.state.surface,
          actions: this.state.actions.map((a, j) => (j === i ? resized : a)),
        },
        `resize:${i}`
      );
      this.queue_draw();
      const b = resized.getBounds();
      if (b) {
        // Same msgid as the zoom status readout.
        announce(
          this,
          _('%w × %h px')
            .replace('%w', String(Math.round(b.x2 - b.x1)))
            .replace('%h', String(Math.round(b.y2 - b.y1)))
        );
      }
      return true;
    }

    // Keyboard placement: drop a number stamp, or open the text editor, at the
    // center of the visible viewport. The placed item lands selected (via the
    // placement callback) so it's immediately arrow-nudgeable.
    private placeAtViewportCenter(): boolean {
      const [cx, cy] = this.viewportCenterWidget();
      const [ix, iy] = this.widgetToImage(cx, cy);
      if (this.currentToolId === 'number') {
        this.placeNumberStampAt(ix, iy);
        return true;
      }
      if (this.currentToolId === 'text' && this.onTextEditRequest) {
        this.onTextEditRequest(ix, iy, cx, cy, {scale: this.currentTransform().scale});
        return true;
      }
      return false;
    }

    // Build and add a number stamp at (ix, iy) with the current picker styling.
    // Shared by the pointer (onCanvasPress) and keyboard placement paths.
    private placeNumberStampAt(ix: number, iy: number): void {
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

    private scrolledAncestor(): Gtk.ScrolledWindow | null {
      return this.get_ancestor(Gtk.ScrolledWindow.$gtype) as Gtk.ScrolledWindow | null;
    }

    // The visible portion of the canvas in widget coordinates: the whole widget
    // in fit mode, or the scrolled viewport's window into a zoomed-in canvas.
    private visibleRect(): {x: number; y: number; w: number; h: number} {
      const sw = this.scrolledAncestor();
      if (sw) {
        const h = sw.get_hadjustment();
        const v = sw.get_vadjustment();
        return {x: h.get_value(), y: v.get_value(), w: h.get_page_size(), h: v.get_page_size()};
      }
      return {x: 0, y: 0, w: this.get_width(), h: this.get_height()};
    }

    private viewportCenterWidget(): [number, number] {
      const r = this.visibleRect();
      return [r.x + r.w / 2, r.y + r.h / 2];
    }

    // Right-click-drag pan hooks, driven by ZoomController (which owns the
    // ScrolledWindow the gesture rides). The canvas shows the grabbing hand and
    // suspends its hover/cursor tracking for the duration; the actual scrolling
    // is the ScrolledWindow's job.
    beginPan(): void {
      this.panning = true;
      this.set_cursor_from_name('grabbing');
    }

    endPan(): void {
      this.panning = false;
      // Restore the tool's cursor; the next pointer motion refines it (resize
      // handles, hover candidate) where the tool tracks hover.
      this.set_cursor_from_name(cursorForTool(this.currentToolId));
    }

    isPanning(): boolean {
      return this.panning;
    }

    // Refresh the canvas's accessible description from the live tool/selection
    // state, so AT users hear what placing or arrowing will affect. Called on
    // every state change (tool switch, add/delete/move, selection change).
    private updateAccessibleState(): void {
      const tool = TOOLS.find((t) => t.id === this.currentToolId);
      const toolName = tool ? _(tool.label) : this.currentToolId;
      const parts = [
        _('%s tool').replace('%s', toolName),
        formatN(_('%d annotations'), this.state.actions.length),
      ];
      if (this.selectedIndices.size > 0) {
        parts.push(formatN(_('%d selected'), this.selectedIndices.size));
      }
      setAccessibleDescription(this, parts.join(', '));
    }

    // A short spoken summary of the current selection, for announce().
    private describeSelection(): string {
      const n = this.selectedIndices.size;
      if (n === 0) return _('Nothing selected');
      if (n > 1) return formatN(_('%d items selected'), n);
      const i = this.selectedIndices.values().next().value ?? -1;
      const a = i >= 0 && i < this.state.actions.length ? this.state.actions[i] : null;
      return a ? this.describeAction(a) : _('Nothing selected');
    }

    // Name an action by its tool (e.g. "Arrow", "Text"), for announce().
    private describeAction(a: Action): string {
      const tid = actionToolId(a);
      const tool = tid ? TOOLS.find((t) => t.id === tid) : undefined;
      return tool ? _(tool.label) : _('Annotation');
    }

    // Update cursor while hovering in resize mode so edge/corner handles
    // advertise themselves before the user even clicks. Other tools keep
    // their cursor from `cursorForTool` (set in setTool / installPointer).
    private onPointerMotion(wx: number, wy: number): void {
      this.lastPointer = [wx, wy];
      // Mid-pan (right-drag): keep the grabbing hand and don't re-resolve the
      // hover candidate — the gesture is navigation, not aiming.
      if (this.panning) return;
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
      this.bandStart = null;
      this.bandCurrent = null;

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
        // Empty press: arm a marquee. The drag builds it; a bare click (no
        // motion) just leaves the cleared selection.
        else this.bandStart = [ix, iy];
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

    // Dig the hover candidate one step through the stack under the POINTER (the
    // keyboard twin of Alt+scroll; , toward the top, . deeper). Pointer-anchored
    // by design — the pointer-free walk through all annotations is the bracket
    // keys (keyboardBrowseCandidate). Returns true only when a 2+ pile is under
    // the cursor, so the key is consumed only then.
    digHoverCandidate(dir: number): boolean {
      const hits = this.hoverStack();
      if (hits.length <= 1) return false;
      this.advanceDig(hits, dir);
      return true;
    }

    // Toggle the hover candidate's membership in the selection — the keyboard
    // equivalent of Shift+Click on it (bound to Shift+Space). Aims at whatever
    // the pointer is hovering (after any , / . dig). Returns true if it acted,
    // so the key is consumed only when there's a candidate. Gated during a
    // text re-edit, the same as onDragBegin's select branch.
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
        // This press already committed an edit (handled in the GestureClick
        // controller); don't let its drag-begin select/move too.
        if (this.suppressSelectThisPress) return;
        // A text action is mid-re-edit (hidden, live editor in its place).
        // Suspend canvas selection until the edit commits/cancels so a press
        // can't select+delete another action and leave editingActionIndex
        // stale (which would later replace the wrong action).
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
      const cornerRadius = this.getToolCornerRadius(this.currentToolId) ?? 0;
      this.liveStroke = createLiveStroke(
        this.currentToolId,
        ix,
        iy,
        color,
        width,
        fill,
        dash,
        filledHead,
        cornerRadius
      );
      this.queue_draw();
    }

    private onDragUpdate(wx: number, wy: number, constrain: boolean): void {
      if (this.currentToolId === 'select') {
        // A press consumed by an editor commit must not move the selection
        // either — the commit may have left the fresh text selected, and
        // drag-begin may have run before the latch was armed (gesture
        // dispatch order isn't guaranteed), so the begin-guard alone isn't
        // enough.
        if (this.suppressSelectThisPress) return;
        // Marquee in progress: extend the band to the cursor (image space) and
        // repaint. Armed only on an empty press, so no handle/move can be live.
        if (this.bandStart) {
          this.bandCurrent = this.widgetToImage(wx, wy);
          this.queue_draw();
          return;
        }
        // Per-action resize: reshape the lone selected action live from the
        // grabbed handle. Shift squares a corner (rect/oval) or snaps an
        // endpoint's angle (line/arrow). Takes precedence over the move path.
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
      // Capture and clear the commit-press latch: drag-end fires for every
      // primary press (clicks included), so it's reset before the next press
      // whatever order GestureClick and GestureDrag ran in.
      const suppressed = this.suppressSelectThisPress;
      this.suppressSelectThisPress = false;
      if (this.currentToolId === 'select') {
        // A latched press never started a select gesture (begin/update bail
        // on it), so end it inertly — releasing must not push a move of
        // whatever the commit left selected.
        if (suppressed) {
          this.moving = false;
          this.moveDx = 0;
          this.moveDy = 0;
          this.shiftToggleDrag = false;
          this.bandStart = null;
          this.bandCurrent = null;
          return;
        }
        // Marquee release: select every action fully inside the swept rectangle
        // (replacing the prior selection). A band with no motion (bandCurrent
        // null) was a bare click — already cleared on press — so it selects
        // nothing here.
        if (this.bandStart) {
          const start = this.bandStart;
          const current = this.bandCurrent;
          this.bandStart = null;
          this.bandCurrent = null;
          if (current) this.selectBand(start[0], start[1], current[0], current[1]);
          this.queue_draw();
          return;
        }
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
        // still push a new (content-identical) state.
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
        if (this.onTextEditRequest) {
          this.onTextEditRequest(ix, iy, wx, wy, {scale: this.currentTransform().scale});
        }
      } else if (this.currentToolId === 'number') {
        // Stamps inherit the active Color (foreground) + Fill (interior) from
        // the style bar; placeNumberStampAt builds and adds the stamp so the
        // pointer and keyboard placement paths stay identical.
        this.placeNumberStampAt(ix, iy);
      }
    }

    private onSelectDoubleClick(wx: number, wy: number): void {
      if (!this.state.surface) return;
      const [ix, iy] = this.widgetToImage(wx, wy);
      // Prefer a selected action under the cursor, so a buried text action
      // picked via the dig gesture still opens for editing; otherwise fall
      // back to the current aim (hover candidate), not just the topmost.
      const selHit = this.selectedIndexAt(ix, iy);
      this.openTextEditor(selHit >= 0 ? selHit : this.resolveCandidate(ix, iy));
    }

    // Open the floating editor on the text action at `idx`, hiding it from the
    // canvas while the live editor stands in. No-op (returns false) unless the
    // index is a valid text action. Shared by double-click and the Enter
    // shortcut.
    // Open the floating editor on the action at `idx` — a standalone TextAction
    // or a box shape's embedded text. Hides the action from the canvas while the
    // live editor stands in. No-op (false) for any other action type.
    private openTextEditor(idx: number): boolean {
      if (idx < 0 || idx >= this.state.actions.length) return false;
      const action = this.state.actions[idx];
      if (isTextAction(action)) {
        const state = getTextEditState(action);
        if (!state || !this.onTextEditRequest) return false;
        this.beginEditingAt(idx);
        // Re-place the editor at the action's anchor in widget coordinates so the
        // editor visually replaces the hidden action.
        const t = this.currentTransform();
        this.onTextEditRequest(
          state.x,
          state.y,
          t.offsetX + state.x * t.scale,
          t.offsetY + state.y * t.scale,
          {
            markup: state.markup,
            replaceIndex: idx,
            rotation: state.rotation,
            editorSize: state.editorSize,
            scale: t.scale,
          }
        );
        return true;
      }
      if (isShapeAction(action)) {
        const st = getShapeTextEditState(action);
        if (!st || !this.onTextEditRequest) return false;
        this.beginEditingAt(idx);
        // Overlay the editor on the box's inner text rect (in widget coords). For
        // a rotated shape the editor stays upright over the box center; the text
        // commits rotated with the box.
        const t = this.currentTransform();
        const {cx, cy, halfW, halfH} = st.bounds;
        // The editor card covers the whole box (positioned at its top-left); the
        // text wraps to the card width and centers within it.
        const boxLeft = cx - halfW;
        const boxTop = cy - halfH;
        // A textless shape seeds its first edit from the style last used on a
        // shape of this tool (like a drawing tool seeds a fresh placement); a
        // re-edit keeps the shape's own style so its current look is preserved.
        const tool = actionToolId(action);
        const seedStyle =
          st.markup || tool === null ? st.style : this.rememberedShapeTextStyle(tool);
        this.onTextEditRequest(
          boxLeft,
          boxTop,
          t.offsetX + boxLeft * t.scale,
          t.offsetY + boxTop * t.scale,
          {
            markup: st.markup,
            shapeIndex: idx,
            textStyle: seedStyle,
            boxMode: {boxW: 2 * halfW * t.scale, boxH: 2 * halfH * t.scale, scale: t.scale},
          }
        );
        return true;
      }
      return false;
    }

    // Hide the action being edited and drop the selection while the live editor
    // stands in (shared by the text + shape edit paths).
    private beginEditingAt(idx: number): void {
      this.editingActionIndex = idx;
      this.selectedIndices.clear();
      this.queue_draw();
    }

    // Open the editor on the sole selected action when it's a text annotation or
    // a box shape (the Enter shortcut and the style-bar Add/Edit-text button).
    // Returns true only when it opened, so the key falls through otherwise
    // (multi-selection, a non-editable selection, or nothing).
    editSelectedText(): boolean {
      if (this.currentToolId !== 'select' || this.editingActionIndex >= 0) return false;
      return this.openTextEditor(this.soleSelectedIndex());
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
    // reshaping needs one unambiguous target (the rotate gizmo gates the same
    // way). The set's sole member, read without spreading.
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
    // stamp center+radius).
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
    // the original, pushes nothing. Returns true if a reshape was in
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
          // default; persisted with the other tool styles when
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
    // dashed light blue, distinct from the solid blue selection box. Shown only
    // for the select tool, while not moving, and not over the re-edited action.
    // Suppressed when it's the lone selection (the selection box already marks
    // it) to avoid a redundant double outline.
    private drawHoverCandidate(
      cr: Cairo.Context,
      acts: ReadonlyArray<Action>,
      scale: number
    ): void {
      if (
        this.currentToolId !== 'select' ||
        this.moving ||
        this.actionGrab ||
        this.rotateGrab ||
        this.bandStart
      )
        return;
      const i = this.hoverCandidate;
      if (i < 0 || i >= acts.length || i === this.editingActionIndex) return;
      if (this.selectedIndices.size === 1 && this.selectedIndices.has(i)) return;
      // A rotatable action gets a tilted outline matching its selection box (the
      // loose AABB of a steeply rotated shape reads as the wrong target).
      const ob = acts[i].getOrientedBounds();
      if (ob) {
        drawOrientedCandidateBox(cr, ob, scale);
        return;
      }
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
        if (i === this.editingActionIndex) {
          // The edited action is hidden so the live editor stands in. A box
          // shape, though, keeps its outline/fill drawn (only its text is
          // suppressed) so the box being labelled doesn't vanish.
          const box = shapeWithoutText(acts[i]);
          if (box) box.draw(cr, t.scale);
          continue;
        }
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
      if (this.bandStart && this.bandCurrent) {
        drawSelectionBand(cr, this.bandStart, this.bandCurrent, t.scale);
      }

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
function setCandidateStroke(cr: Cairo.Context, scale: number): void {
  cr.setSourceRGBA(0.45, 0.75, 1.0, 0.95); // light blue
  cr.setLineWidth(1.5 / scale);
  cr.setDash([6 / scale, 4 / scale], 0);
  cr.setLineCap(Cairo.LineCap.BUTT);
  cr.setLineJoin(Cairo.LineJoin.MITER);
}

function drawCandidateBox(cr: Cairo.Context, bounds: Bounds, scale: number): void {
  const pad = 2 / scale;
  cr.save();
  setCandidateStroke(cr, scale);
  cr.rectangle(
    bounds.x1 - pad,
    bounds.y1 - pad,
    bounds.x2 - bounds.x1 + 2 * pad,
    bounds.y2 - bounds.y1 + 2 * pad
  );
  cr.stroke();
  cr.restore();
}

// The four corner points (image space) of an action's selection footprint:
// the oriented (tilted) box for rotatable actions, else the axis-aligned
// bounds. Drives the marquee containment test, so a rotated shape is judged by
// its real tilted box rather than its looser AABB. Null when the action has no
// bounds.
function actionCorners(action: Action): Array<[number, number]> | null {
  const ob = action.getOrientedBounds();
  if (ob) {
    const c = Math.cos(ob.angle);
    const s = Math.sin(ob.angle);
    return (
      [
        [-ob.halfW, -ob.halfH],
        [ob.halfW, -ob.halfH],
        [ob.halfW, ob.halfH],
        [-ob.halfW, ob.halfH],
      ] as Array<[number, number]>
    ).map(([lx, ly]) => [ob.cx + lx * c - ly * s, ob.cy + lx * s + ly * c]);
  }
  const b = action.getBounds();
  if (!b) return null;
  return [
    [b.x1, b.y1],
    [b.x2, b.y1],
    [b.x2, b.y2],
    [b.x1, b.y2],
  ];
}

// The marquee (rubber-band) rectangle, drawn in image space with the same
// dashed light-blue stroke as the hover candidate plus a faint wash, so it
// reads as a transient sweep region. Corners are the two stored image-space
// points; the cairo context is already image-transformed.
function drawSelectionBand(
  cr: Cairo.Context,
  start: [number, number],
  current: [number, number],
  scale: number
): void {
  const x = Math.min(start[0], current[0]);
  const y = Math.min(start[1], current[1]);
  const w = Math.abs(current[0] - start[0]);
  const h = Math.abs(current[1] - start[1]);
  cr.save();
  cr.rectangle(x, y, w, h);
  cr.setSourceRGBA(0.45, 0.75, 1.0, 0.12); // faint light-blue wash
  cr.fillPreserve();
  setCandidateStroke(cr, scale);
  cr.stroke();
  cr.restore();
}

// The candidate outline for a rotatable action: the same dashed light-blue
// look, tilted to the action's oriented box like drawOrientedSelectionBox.
function drawOrientedCandidateBox(cr: Cairo.Context, ob: OrientedBounds, scale: number): void {
  const pad = 2 / scale;
  cr.save();
  setCandidateStroke(cr, scale);
  cr.translate(ob.cx, ob.cy);
  cr.rotate(ob.angle);
  cr.rectangle(-ob.halfW - pad, -ob.halfH - pad, 2 * (ob.halfW + pad), 2 * (ob.halfH + pad));
  cr.stroke();
  cr.restore();
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
