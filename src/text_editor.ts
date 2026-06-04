import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango?version=1.0';
import PangoCairo from 'gi://PangoCairo?version=1.0';
import Cairo from 'cairo';
import type {ColorRGBA, EditorSize, TextAlign} from './actions.js';
import {setAccessibleLabel} from './a11y.js';
import {_} from './i18n.js';

// Shared 1×1 context for measuring the box-mode text height (to center it
// vertically). Created lazily after GTK is up.
let measureCtx: Cairo.Context | null = null;
function getMeasureCtx(): Cairo.Context {
  if (!measureCtx) {
    measureCtx = new Cairo.Context(new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1));
  }
  return measureCtx;
}

// Styling for the floating text editor, applied once at the display level (the
// classes are editor-specific, so leaking onto other widgets is a non-issue).
// The editor is a clean floating card built from libadwaita named colors, so it
// looks native in light and dark and stays legible over any image: a slightly
// translucent window-bg fill, a hairline border, rounded corners, and a soft
// drop shadow. The B/I/U row is a flat toolbar separated by a hairline (theme
// flat toggle buttons — no hardcoded palette). The TextView is transparent over
// the card; its font + caret color are set per-edit (editorViewProvider /
// setEditorViewStyle), the caret matching the text color.
const EDITOR_CSS = `
  .annoscr-editor-frame {
    background-color: alpha(@window_bg_color, 0.93);
    border: 1px solid @borders;
    border-radius: 4px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  }
  .annoscr-format-btn-row {
    padding: 4px;
    border-bottom: 1px solid @borders;
  }
  .annoscr-format-btn {
    min-width: 24px;
    min-height: 24px;
  }
  .annoscr-editor-view, .annoscr-editor-view text {
    background-color: transparent;
  }
  .annoscr-editor-view {
    padding: 6px 9px;
  }
`;

function addDisplayProvider(provider: Gtk.CssProvider): void {
  const display = Gdk.Display.get_default();
  if (!display) return;
  // Gtk.StyleContext is wholly deprecated in 4.10+ but display-level CSS
  // providers have no replacement; the deprecation note itself says
  // "otherwise, there is no replacement." Same situation as the cairo
  // pixel-data accessors in exporter.ts / image_loader.ts.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  Gtk.StyleContext.add_provider_for_display(
    display,
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
  );
}

let editorCssInstalled = false;
// Dynamic provider carrying view properties that vary per edit: the font and the
// caret color. The font matters because GtkTextView sizes the caret to the line
// height at the cursor, which for an empty buffer is the view's default (theme)
// font — so without this the caret opens small and only jumps to size once a
// character (carrying the baseTag font) is typed. The caret color tracks the
// text color so the cursor stays visible against any image (a fixed gray caret
// vanished over dark areas of the transparent editor).
let editorViewProvider: Gtk.CssProvider | null = null;

function installEditorCss(): void {
  if (editorCssInstalled) return;
  const staticProvider = new Gtk.CssProvider();
  staticProvider.load_from_string(EDITOR_CSS);
  addDisplayProvider(staticProvider);
  editorViewProvider = new Gtk.CssProvider();
  addDisplayProvider(editorViewProvider);
  editorCssInstalled = true;
}

// Solid (opaque) CSS color from a ColorRGBA — alpha is dropped so a translucent
// text color still yields a visible caret.
function cssRgb(color: ColorRGBA): string {
  const [r, g, b] = color;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

// Map text alignment onto the TextView's justification for the box-mode preview.
function pangoJustification(align: TextAlign): Gtk.Justification {
  if (align === 'center') return Gtk.Justification.CENTER;
  if (align === 'right') return Gtk.Justification.RIGHT;
  return Gtk.Justification.LEFT;
}

// Relative luminance of a color (0 = black, 1 = white).
function luminance(color: ColorRGBA): number {
  return 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2];
}

// Drive the per-edit, text-color-dependent styling so the editor is legible for
// ANY text color over ANY image (the subtitle pattern): a translucent backdrop
// that contrasts the text — dark behind light text, light behind dark text — and
// matching toolbar-icon ink. Also sets the view font/size (so the empty caret is
// the right height) and the caret color. `displaySizePx` is the on-screen size
// (image size × zoom in box mode, else the image size). Family is quoted for
// names with spaces; the baseTag still drives the typed text's font + color.
function setEditorViewStyle(fontDesc: string, displaySizePx: number, color: ColorRGBA): void {
  if (!editorViewProvider) return;
  const family = Pango.FontDescription.from_string(fontDesc).get_family() ?? 'Sans';
  const lightText = luminance(color) > 0.5;
  const scrim = lightText ? 'rgba(28, 28, 30, 0.62)' : 'rgba(250, 250, 252, 0.74)';
  const ink = lightText ? '#f2f2f2' : '#1e1e1e';
  editorViewProvider.load_from_string(
    `.annoscr-editor-frame { background-color: ${scrim}; }` +
      `.annoscr-format-btn { color: ${ink}; }` +
      `.annoscr-editor-view {` +
      ` font-family: "${family}";` +
      ` font-size: ${Math.round(displaySizePx)}px;` +
      ` caret-color: ${cssRgb(color)};` +
      ` }`
  );
}

export interface TextEditorStyle {
  color: ColorRGBA;
  fontDesc: string;
  size: number; // image-space pixels (font height)
  // Background plate color committed onto the TextAction (alpha 0 = none).
  // Carried through the edit so the Fill picker round-trips; v1 doesn't render
  // it inside the editor frame.
  bg: ColorRGBA;
  // Horizontal alignment. Only meaningful for shape (box-mode) text — previewed
  // via the TextView's justification and committed onto the shape; standalone
  // text passes 'left' and the align control stays hidden.
  align: TextAlign;
}

// What an in-progress edit will be committed to. Absent = a standalone
// TextAction (the default path). A shape target routes the commit to the box
// shape at `index` (its text), not a new TextAction.
export type EditTarget = {kind: 'shape'; index: number};

// Box-mode display geometry (widget px): the editor card covers the shape's box
// (boxW × boxH) — the toolbar floats above it and the text view area covers the
// box, vertically centered. The font shows at `scale` (the zoom) so the wrap +
// alignment preview the committed render.
export interface BoxMode {
  boxW: number;
  boxH: number;
  scale: number;
}

const TAG_NAMES = ['bold', 'italic', 'underline'] as const;
type TagName = (typeof TAG_NAMES)[number];

const MARKUP_TAG: Record<TagName, string> = {
  bold: 'b',
  italic: 'i',
  underline: 'u',
};

const MARKUP_TAG_REVERSE: Record<string, TagName> = {
  b: 'bold',
  i: 'italic',
  u: 'underline',
};

// Default and minimum editor dimensions (widget pixels). Default is roughly
// 2× the original 80 px hard minimum so new edits have comfortable room.
const EDITOR_DEFAULT_WIDTH = 160;
const EDITOR_MIN_WIDTH = 80;
const EDITOR_MIN_HEIGHT = 40;

// In box mode the editor card covers the shape's box plus this overlap on each
// side, so the shape's outline tucks just under the card edge.
const BOX_OVERLAP = 2;

// The view's total horizontal CSS padding (`padding: 6px 9px` → 9·2), subtracted
// from the box width to estimate the text wrap width when measuring its height.
const VIEW_PAD_X = 18;

// Vertical chrome between the frame's top and the text view area (frame border +
// toolbar border-bottom), used to place the toolbar ABOVE the box so the view
// area covers it. The extra +1 (FRAME_CHROME_V) is the bottom frame border.
const FRAME_CHROME_TOP = 2;
const FRAME_CHROME_V = FRAME_CHROME_TOP + 1;

// Starting (minimum) view height for a fresh edit: one line at the given font
// size plus the view's vertical padding, so the frame opens proportional to the
// font instead of at the theme's default line height. set_size_request sets a
// MINIMUM, so the view still grows past this as more lines are typed.
function oneLineHeight(fontSize?: number): number {
  if (!fontSize) return EDITOR_MIN_HEIGHT;
  return Math.max(EDITOR_MIN_HEIGHT, Math.round(fontSize * 1.4) + 8);
}

interface TextEditorCallbacks {
  onCommit: (
    markup: string,
    x: number,
    y: number,
    rotation: number,
    style: TextEditorStyle,
    editorSize: EditorSize,
    replaceIndex?: number,
    // True when an explicit Enter commit should leave the result selected (so a
    // re-edit stays in hand for move/resize/re-edit). False for incidental
    // commits — click-away, tool switch, save/copy — which leave it unselected.
    selectAfter?: boolean,
    // Present when committing text into a shape: the window routes to the shape
    // (its text) instead of creating/replacing a TextAction. Empty markup here
    // clears the shape's text rather than deleting the shape.
    editTarget?: EditTarget
  ) => void;
  onCancel: (replaceIndex?: number) => void;
  // Empty/whitespace-only text committed over an existing action (re-edit) →
  // the user cleared the box and confirmed, so remove the action. Distinct
  // from onCancel (Escape / abort), which keeps the original text.
  onDelete: (replaceIndex: number) => void;
}

export interface TextEditorBeginOptions {
  markup?: string;
  replaceIndex?: number;
  rotation?: number; // free angle in radians, CW (carried through commit unchanged)
  // Restore the editor frame to the dimensions it had when this action was
  // last committed. Undefined → use EDITOR_DEFAULT_WIDTH × natural height.
  editorSize?: EditorSize;
  // Visual style for the editor preview. Should match what the editor will
  // commit (font + color from the same source the canvas will render with),
  // so the live TextView visually previews placement and sizing.
  style?: TextEditorStyle;
  // Commit target. Absent → standalone TextAction. Set (with boxMode) → edit a
  // shape's text.
  editTarget?: EditTarget;
  // Box-overlay geometry for shape text. When set, the editor sizes to the box,
  // word-wraps, justifies by align, scales the font by zoom, and hides the grip.
  boxMode?: BoxMode;
}

export class TextEditor {
  private readonly frame: Gtk.Frame;
  private readonly view: Gtk.TextView;
  private readonly buffer: Gtk.TextBuffer;
  private readonly callbacks: TextEditorCallbacks;
  private readonly buttons: Record<TagName, Gtk.ToggleButton>;
  // Held as a field so beginAt can measure its height when computing the
  // vertical offset between the frame's top and the TextView's first line.
  private toolbar!: Gtk.Box;
  // Buffer-wide style tag (font + foreground color). Properties are updated
  // on each beginAt to reflect the active style; applied to the full buffer
  // after set_text/setBufferFromMarkup and to each insert range so newly
  // typed text inherits the same baseline. B/I/U tags layer on top.
  private baseTag!: Gtk.TextTag;
  // Current style of the active edit (seeded from beginAt, updated by
  // refreshStyle when the picker fires while the editor is open). The
  // editor is the source of truth for style during an edit so picker
  // changes flow into both the live preview and the committed action.
  private currentStyle: TextEditorStyle | null = null;
  // Grip drag baseline — captured on drag-begin so drag-update can apply
  // relative deltas.
  private dragStartW: number = 0;
  private dragStartH: number = 0;

  // Resize grip (visible only in standalone mode — box mode is sized by the
  // shape, so manual resize is disabled there).
  private grip!: Gtk.DrawingArea;
  // Holds the TextView (+ grip). Fills the card in box mode (so the text wraps)
  // and fills normally in standalone.
  private viewOverlay!: Gtk.Overlay;
  // Box-mode vertical centering: the text view area height and wrap width (widget
  // px). The text is centered by setting the view's top margin to half the slack;
  // 0 height = not box mode (no centering).
  private boxViewAreaH: number = 0;
  private boxWrapWidth: number = 0;
  // On-screen font multiplier for the active edit: the zoom in box mode (so the
  // preview matches the canvas), 1 otherwise. The committed style.size stays
  // image-space.
  private displayScale: number = 1;
  // Set while editing a shape's text; routed to onCommit so the window targets
  // the shape. Undefined for standalone TextAction edits.
  private editTarget: EditTarget | undefined = undefined;

  private active: boolean = false;
  private imageX: number = 0;
  private imageY: number = 0;
  private rotation: number = 0;
  private replaceIndex: number | undefined = undefined;
  // Tags that will be applied to the next characters the user types.
  private pendingTags: Set<TagName> = new Set();
  // Guard so the programmatic set_active() in syncButtonStates doesn't
  // re-enter through the buttons' 'toggled' signal.
  private updatingButtons: boolean = false;
  // True for the duration of a buffer insert. The 'mark-set' watcher resyncs
  // pendingTags from the cursor context, but during typing the cursor moves
  // before the insert-applier has set the new run's tags — resyncing then
  // would read the not-yet-tagged char and clobber the pending set. The guard
  // suppresses resync mid-insert; explicit cursor moves (click/arrow) still
  // resync because they don't set this flag.
  private inserting: boolean = false;

  constructor(callbacks: TextEditorCallbacks) {
    this.callbacks = callbacks;

    installEditorCss();

    this.view = new Gtk.TextView({
      wrap_mode: Gtk.WrapMode.NONE,
      accepts_tab: false,
      hexpand: false,
      vexpand: false,
    });
    this.view.add_css_class('annoscr-editor-view');
    this.view.set_size_request(EDITOR_DEFAULT_WIDTH, -1);

    this.buffer = this.view.get_buffer();
    this.installTags();
    this.installPendingTagsApplier();

    this.toolbar = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 2,
      margin_top: 2,
      margin_bottom: 2,
      margin_start: 2,
      margin_end: 2,
      css_classes: ['annoscr-format-btn-row'],
    });
    this.buttons = {
      bold: this.makeFormatButton('format-text-bold-symbolic', _('Bold (Ctrl+B)'), 'bold'),
      italic: this.makeFormatButton('format-text-italic-symbolic', _('Italic (Ctrl+I)'), 'italic'),
      underline: this.makeFormatButton(
        'format-text-underline-symbolic',
        _('Underline (Ctrl+U)'),
        'underline'
      ),
    };
    this.toolbar.append(this.buttons.bold);
    this.toolbar.append(this.buttons.italic);
    this.toolbar.append(this.buttons.underline);

    // Corner resize grip — visual indicator only (the drag gesture lives on
    // the frame so its coordinate origin doesn't move during a resize).
    const GRIP_SIZE = 14;
    this.grip = new Gtk.DrawingArea({
      width_request: GRIP_SIZE,
      height_request: GRIP_SIZE,
      halign: Gtk.Align.END,
      valign: Gtk.Align.END,
      can_focus: false,
    });
    this.grip.set_cursor_from_name('se-resize');
    this.grip.set_draw_func((_w, cr, w, h) => {
      cr.setSourceRGBA(0.3, 0.3, 0.3, 0.5);
      cr.setLineWidth(1);
      for (const off of [3, 7, 11]) {
        cr.moveTo(w, h - off);
        cr.lineTo(w - off, h);
        cr.stroke();
      }
    });

    this.viewOverlay = new Gtk.Overlay();
    this.viewOverlay.set_child(this.view);
    this.viewOverlay.add_overlay(this.grip);

    const container = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    container.append(this.toolbar);
    container.append(this.viewOverlay);

    // Drag gesture on the frame (not the grip) because the grip moves as
    // the view resizes — which shifts the gesture's coordinate origin and
    // produces a feedback loop (slower-than-mouse + oscillation). The
    // frame's position is fixed by margins in the parent overlay, so its
    // coordinate space is stable. CAPTURE phase + DENIED state for
    // non-grip-zone drags lets text selection propagate normally.
    const dragGesture = new Gtk.GestureDrag();
    dragGesture.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    dragGesture.connect('drag-begin', (_g: Gtk.GestureDrag, startX: number, startY: number) => {
      const fw = this.frame.get_width();
      const fh = this.frame.get_height();
      // Box mode is sized by the shape — no manual resize. Otherwise only the
      // bottom-right grip zone resizes; elsewhere let text selection propagate.
      if (this.editTarget || startX < fw - GRIP_SIZE || startY < fh - GRIP_SIZE) {
        dragGesture.set_state(Gtk.EventSequenceState.DENIED);
        return;
      }
      this.dragStartW = this.view.get_width();
      this.dragStartH = this.view.get_height();
    });
    dragGesture.connect('drag-update', (_g: Gtk.GestureDrag, dx: number, dy: number) => {
      const newW = Math.max(EDITOR_MIN_WIDTH, Math.round(this.dragStartW + dx));
      const newH = Math.max(EDITOR_MIN_HEIGHT, Math.round(this.dragStartH + dy));
      this.view.set_size_request(newW, newH);
    });

    this.frame = new Gtk.Frame({
      child: container,
      halign: Gtk.Align.START,
      valign: Gtk.Align.START,
      visible: false,
    });
    this.frame.add_css_class('annoscr-editor-frame');
    this.frame.add_controller(dragGesture);

    this.installKeyHandler();
    this.installSelectionWatcher();
    // Keep box-mode text vertically centered as it grows/shrinks while typing.
    this.buffer.connect('changed', () => this.recenterBoxText());
  }

  private makeFormatButton(iconName: string, tooltip: string, tag: TagName): Gtk.ToggleButton {
    // can_focus: false so clicking the button doesn't steal keyboard focus
    // from the TextView — the user keeps typing into the buffer immediately.
    const btn = new Gtk.ToggleButton({
      icon_name: iconName,
      tooltip_text: tooltip,
      has_frame: false,
      can_focus: false,
    });
    btn.add_css_class('annoscr-format-btn');
    setAccessibleLabel(btn, tooltip);
    btn.connect('toggled', () => {
      if (this.updatingButtons) return;
      this.toggleTag(tag);
    });
    return btn;
  }

  getWidget(): Gtk.Frame {
    return this.frame;
  }

  isActive(): boolean {
    return this.active;
  }

  // Current style of the in-progress edit, or null when inactive. Used by
  // the style-bar pickers so they reflect what the editor will commit.
  getCurrentStyle(): TextEditorStyle | null {
    return this.currentStyle;
  }

  // Re-apply a new style to the in-progress edit so picker changes update the
  // visible TextView live (not just at commit). Safe to call when inactive;
  // it no-ops to keep callers simple. Returns keyboard focus to the TextView
  // since the user almost always wants to keep typing after a picker change.
  refreshStyle(style: TextEditorStyle): void {
    if (!this.active) return;
    this.currentStyle = style;
    this.applyViewStyle(style);
    this.applyBaseTagToBuffer();
    this.recenterBoxText();
    this.view.grab_focus();
  }

  // True while editing a shape's text (box mode), so the style bar can show the
  // alignment control only where it applies.
  isBoxEdit(): boolean {
    return this.active && this.editTarget !== undefined;
  }

  beginAt(
    imageX: number,
    imageY: number,
    widgetX: number,
    widgetY: number,
    options?: TextEditorBeginOptions
  ): void {
    this.imageX = imageX;
    this.imageY = imageY;
    this.rotation = options?.rotation ?? 0;
    this.replaceIndex = options?.replaceIndex;
    this.editTarget = options?.editTarget;
    const box = options?.boxMode;
    this.displayScale = box ? box.scale : 1;
    this.pendingTags.clear();
    // Box mode word-wraps to the box width; standalone keeps each line natural.
    this.view.set_wrap_mode(box ? Gtk.WrapMode.WORD : Gtk.WrapMode.NONE);
    this.grip.set_visible(!box);
    if (options?.style) {
      this.currentStyle = options.style;
      this.applyViewStyle(options.style);
    } else {
      this.currentStyle = null;
    }
    const [, toolbarH] = this.toolbar.measure(Gtk.Orientation.VERTICAL, -1);
    if (box) {
      // Box mode: the card covers the rectangle. The VIEW AREA (below the
      // toolbar) is sized to the box and the toolbar floats ABOVE the box (so the
      // card's bottom aligns with the box bottom, not its top with the top). The
      // view FILLS that area so the text word-wraps to the box width and isn't
      // clipped; vertical centering is done via the view's top margin
      // (recenterBoxText) — `valign:CENTER` would collapse the view to one line.
      const viewAreaH = Math.round(box.boxH) + 2 * BOX_OVERLAP;
      this.frame.set_size_request(
        Math.round(box.boxW) + 2 * BOX_OVERLAP,
        toolbarH + viewAreaH + FRAME_CHROME_V
      );
      this.view.set_size_request(-1, -1);
      this.viewOverlay.set_vexpand(true);
      this.viewOverlay.set_valign(Gtk.Align.FILL);
      this.viewOverlay.set_halign(Gtk.Align.FILL);
      this.boxViewAreaH = viewAreaH;
      this.boxWrapWidth = Math.round(box.boxW) - VIEW_PAD_X;
    } else {
      this.frame.set_size_request(-1, -1);
      this.viewOverlay.set_vexpand(false);
      this.viewOverlay.set_valign(Gtk.Align.FILL);
      this.viewOverlay.set_halign(Gtk.Align.FILL);
      this.boxViewAreaH = 0;
      this.view.set_top_margin(0);
      if (options?.editorSize) {
        // Re-edit: restore the dimensions the action was committed at.
        this.view.set_size_request(options.editorSize.width, options.editorSize.height);
      } else {
        // Fresh placement: one line tall at the active font size (grows with
        // content — see oneLineHeight).
        this.view.set_size_request(EDITOR_DEFAULT_WIDTH, oneLineHeight(options?.style?.size));
      }
    }
    if (options?.markup) {
      this.setBufferFromMarkup(options.markup);
    } else {
      this.buffer.set_text('', -1);
    }
    this.applyBaseTagToBuffer();
    this.recenterBoxText();
    this.active = true;
    if (box) {
      // widgetX/Y is the box top-left. Shift the frame up by the toolbar (+ chrome)
      // so the toolbar sits above the box and the view area covers it; minus the
      // overlap so the card's edges tuck just outside the shape outline.
      this.frame.set_margin_start(Math.max(0, Math.floor(widgetX) - BOX_OVERLAP));
      this.frame.set_margin_top(
        Math.max(0, Math.floor(widgetY) - BOX_OVERLAP - toolbarH - FRAME_CHROME_TOP)
      );
    } else {
      // Standalone: align the editor so the TextView's first line lands on the
      // click point. The toolbar's natural height + the view's top inset matches
      // the frame's intrinsic top inset; left_margin alone matches the left.
      const offsetTop = toolbarH + 1 + 4;
      const offsetLeft = 8;
      this.frame.set_margin_start(Math.max(0, Math.floor(widgetX) - offsetLeft));
      this.frame.set_margin_top(Math.max(0, Math.floor(widgetY) - offsetTop));
    }
    this.frame.set_visible(true);
    this.view.grab_focus();
    this.syncButtonStates();
  }

  commitIfActive(selectAfter = false): void {
    if (!this.active) return;
    const start = this.buffer.get_start_iter();
    const end = this.buffer.get_end_iter();
    const plainText = this.buffer.get_text(start, end, true);
    const replaceIndex = this.replaceIndex;
    const rotation = this.rotation;
    const style = this.currentStyle;
    const editTarget = this.editTarget;
    // Snapshot the actual allocated size (not the size_request) so re-edits
    // restore the visual frame rather than a -1 "natural" placeholder. Guard
    // against a never-allocated view reporting 0: fall back to the default
    // width / natural height so a re-edit can't restore a collapsed frame.
    const allocW = this.view.get_width();
    const allocH = this.view.get_height();
    const editorSize: EditorSize = {
      width: allocW > 0 ? allocW : EDITOR_DEFAULT_WIDTH,
      height: allocH > 0 ? allocH : -1,
    };
    this.reset();
    if (!style) {
      this.callbacks.onCancel(replaceIndex);
      return;
    }
    const markup = this.bufferToMarkup();
    // Shape text: always commit (empty markup clears the shape's text); never
    // delete the shape.
    if (editTarget) {
      this.callbacks.onCommit(
        markup,
        this.imageX,
        this.imageY,
        rotation,
        style,
        editorSize,
        replaceIndex,
        selectAfter,
        editTarget
      );
      return;
    }
    if (plainText.trim().length === 0) {
      // Standalone: cleared an existing action and confirmed → delete it; cleared
      // a fresh placement → nothing was added, so just cancel.
      if (replaceIndex !== undefined) this.callbacks.onDelete(replaceIndex);
      else this.callbacks.onCancel(replaceIndex);
      return;
    }
    this.callbacks.onCommit(
      markup,
      this.imageX,
      this.imageY,
      rotation,
      style,
      editorSize,
      replaceIndex,
      selectAfter
    );
  }

  cancel(): void {
    if (!this.active) return;
    const replaceIndex = this.replaceIndex;
    this.reset();
    this.callbacks.onCancel(replaceIndex);
  }

  // Tear down the active edit's transient state (shared by commit + cancel).
  private reset(): void {
    this.active = false;
    this.frame.set_visible(false);
    this.replaceIndex = undefined;
    this.rotation = 0;
    this.currentStyle = null;
    this.editTarget = undefined;
    this.displayScale = 1;
    this.boxViewAreaH = 0;
    this.view.set_top_margin(0);
  }

  private installTags(): void {
    const table = this.buffer.get_tag_table();
    // Base tag added first so its priority is below B/I/U; later-added tags
    // win on conflicting properties (e.g. italic overrides base style).
    this.baseTag = new Gtk.TextTag({name: 'base'});
    table.add(this.baseTag);
    table.add(new Gtk.TextTag({name: 'bold', weight: Pango.Weight.BOLD}));
    table.add(new Gtk.TextTag({name: 'italic', style: Pango.Style.ITALIC}));
    table.add(new Gtk.TextTag({name: 'underline', underline: Pango.Underline.SINGLE}));
  }

  private updateBaseTag(style: TextEditorStyle): void {
    const desc = Pango.FontDescription.from_string(style.fontDesc);
    // Display size = image size × zoom (box mode) so the preview matches the
    // canvas; displayScale is 1 for standalone.
    desc.set_absolute_size(style.size * this.displayScale * Pango.SCALE);
    this.baseTag.set_property('font-desc', desc);

    const rgba = new Gdk.RGBA();
    rgba.red = style.color[0];
    rgba.green = style.color[1];
    rgba.blue = style.color[2];
    rgba.alpha = style.color[3];
    this.baseTag.set_property('foreground-rgba', rgba);
  }

  // Push the full style into the live view: base tag (font+color), the view CSS
  // font/caret (scaled for box mode), and the justification (box mode only).
  private applyViewStyle(style: TextEditorStyle): void {
    this.updateBaseTag(style);
    setEditorViewStyle(style.fontDesc, style.size * this.displayScale, style.color);
    if (this.editTarget) {
      this.view.set_justification(pangoJustification(style.align));
    }
  }

  private applyBaseTagToBuffer(): void {
    const start = this.buffer.get_start_iter();
    const end = this.buffer.get_end_iter();
    this.buffer.apply_tag(this.baseTag, start, end);
  }

  // Box mode only: vertically center the wrapped text in the box by setting the
  // view's top margin to half the leftover height. The view fills the area (so
  // text wraps + doesn't clip); the margin floats it to the middle, and tall
  // text (margin clamped to 0) fills from the top and spills, matching commit.
  private recenterBoxText(): void {
    if (this.boxViewAreaH <= 0 || !this.currentStyle) return;
    const textH = this.measureBoxTextHeight();
    this.view.set_top_margin(Math.max(0, Math.round((this.boxViewAreaH - textH) / 2)));
  }

  // Wrapped pixel height of the current text at the box wrap width + display font.
  private measureBoxTextHeight(): number {
    if (!this.currentStyle) return 0;
    const layout = PangoCairo.create_layout(getMeasureCtx());
    const desc = Pango.FontDescription.from_string(this.currentStyle.fontDesc);
    desc.set_absolute_size(this.currentStyle.size * this.displayScale * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_width(Math.max(1, this.boxWrapWidth) * Pango.SCALE);
    layout.set_markup(this.bufferToMarkup(), -1);
    const [, h] = layout.get_pixel_size();
    return h;
  }

  private installPendingTagsApplier(): void {
    // Mark the insert in progress before the default handler runs (and emits
    // the cursor 'mark-set' the watcher listens for); cleared in the _after
    // handler below once the new run is tagged.
    this.buffer.connect('insert-text', () => {
      this.inserting = true;
    });
    // `insert-text` default handler does the insert and revalidates the iter
    // to point AFTER the inserted text. Connecting via _after gives us that
    // post-insert iter so we can set the just-inserted range's tags.
    this.buffer.connect_after('insert-text', (buf, locationIter, text, _len) => {
      const endOffset = locationIter.get_offset();
      const startOffset = endOffset - [...text].length;
      const start = buf.get_iter_at_offset(startOffset);
      const end = buf.get_iter_at_offset(endOffset);
      // Base tag always wraps newly-typed text so it inherits the editor's
      // font + color (TextBuffer's left-side tag-inheritance isn't reliable
      // at offset 0 or after explicit removals).
      buf.apply_tag(this.baseTag, start, end);
      // Make pendingTags authoritative for the run: apply the ones that are
      // set and strip the others, so typed formatting always matches the B/I/U
      // buttons regardless of the tags GTK inherits across the insertion gap.
      for (const tag of TAG_NAMES) {
        if (this.pendingTags.has(tag)) buf.apply_tag_by_name(tag, start, end);
        else buf.remove_tag_by_name(tag, start, end);
      }
      this.inserting = false;
    });
  }

  private installKeyHandler(): void {
    const key = new Gtk.EventControllerKey();
    // CAPTURE phase so we see Enter/Escape/Ctrl-shortcuts before the TextView's
    // default key handler (which would otherwise insert newline on Enter).
    key.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    key.connect('key-pressed', (_k, keyval, _keycode, state) => {
      return this.onKeyPressed(keyval, state);
    });
    this.view.add_controller(key);
  }

  private onKeyPressed(keyval: number, state: number): boolean {
    const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
    const shift = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
    const alt = (state & Gdk.ModifierType.ALT_MASK) !== 0;

    if (keyval === Gdk.KEY_Escape) {
      this.cancel();
      return true;
    }
    if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
      if (shift) return false; // let TextView insert a newline
      // Explicit commit: keep the result selected so a re-edit stays in hand.
      this.commitIfActive(true);
      return true;
    }
    if (ctrl && !alt) {
      const tag = keyToTag(keyval);
      if (tag) {
        this.toggleTag(tag);
        return true;
      }
    }
    return false;
  }

  private toggleTag(tag: TagName): void {
    const [hasSel, start, end] = this.buffer.get_selection_bounds();
    if (hasSel) {
      // If every character in the selection has the tag, remove it; otherwise apply.
      if (allCharsHaveTag(start, end, tag)) {
        this.buffer.remove_tag_by_name(tag, start, end);
        this.pendingTags.delete(tag);
      } else {
        this.buffer.apply_tag_by_name(tag, start, end);
        this.pendingTags.add(tag);
      }
    } else {
      // No selection — toggle pending state for next-typed chars.
      if (this.pendingTags.has(tag)) this.pendingTags.delete(tag);
      else this.pendingTags.add(tag);
    }
    this.syncButtonStates();
  }

  // Watch buffer marks so the B/I/U buttons reflect "what would I see if I
  // toggled now" after the cursor or selection moves. Only the named insert
  // and selection_bound marks signal real cursor/selection changes;
  // anonymous marks fire too and we ignore them.
  private installSelectionWatcher(): void {
    this.buffer.connect('mark-set', (_buf, _iter, mark) => {
      const name = mark.get_name();
      if (name !== 'insert' && name !== 'selection_bound') return;
      // Don't resync mid-insert (see the `inserting` guard) — the applier owns
      // the typed run's tags. Cursor navigation (click/arrow) does resync so
      // the next-typed formatting follows the insertion point.
      if (!this.inserting) this.syncPendingToCursor();
      this.syncButtonStates();
    });
  }

  // With no selection, align pendingTags to the formatting the user would be
  // extending: the run to the left of the cursor (empty at the very start).
  // Leaves pendingTags untouched while a selection exists — there the buttons
  // reflect the selection via isTagActiveForButton, not pending.
  private syncPendingToCursor(): void {
    const [hasSel] = this.buffer.get_selection_bounds();
    if (hasSel) return;
    const insert = this.buffer.get_iter_at_mark(this.buffer.get_insert());
    if (insert.get_offset() === 0) {
      this.pendingTags = new Set();
      return;
    }
    const prev = insert.copy();
    prev.backward_char();
    this.pendingTags = activeTagSet(prev);
  }

  private syncButtonStates(): void {
    this.updatingButtons = true;
    for (const tag of TAG_NAMES) {
      this.buttons[tag].set_active(this.isTagActiveForButton(tag));
    }
    this.updatingButtons = false;
  }

  // What the button should show:
  //   - with selection: pressed iff every selected char has the tag (matches
  //     toggleTag's "all-or-nothing" branch — pressing removes, otherwise applies)
  //   - no selection: pressed iff the tag is pending (will apply to next type)
  private isTagActiveForButton(tag: TagName): boolean {
    const [hasSel, start, end] = this.buffer.get_selection_bounds();
    if (hasSel) return allCharsHaveTag(start, end, tag);
    return this.pendingTags.has(tag);
  }

  // Walk the buffer character-by-character. When the active tag set changes,
  // close all currently-open markup tags and re-open the new set in a canonical
  // order. Always produces valid (well-nested) Pango markup.
  private bufferToMarkup(): string {
    const start = this.buffer.get_start_iter();
    const end = this.buffer.get_end_iter();
    const openStack: TagName[] = [];

    let result = '';
    let prev: Set<TagName> = new Set();

    const iter = start.copy();
    while (!iter.equal(end)) {
      const tags = activeTagSet(iter);

      if (!setsEqual(tags, prev)) {
        while (openStack.length > 0) {
          result += `</${MARKUP_TAG[openStack.pop()!]}>`;
        }
        for (const t of TAG_NAMES) {
          if (tags.has(t)) {
            result += `<${MARKUP_TAG[t]}>`;
            openStack.push(t);
          }
        }
        prev = tags;
      }

      // GJS binds gtk_text_iter_get_char to a string, not a codepoint number.
      result += escapeMarkup(iter.get_char());

      if (!iter.forward_char()) break;
    }

    while (openStack.length > 0) {
      result += `</${MARKUP_TAG[openStack.pop()!]}>`;
    }
    return result;
  }

  // Inverse of bufferToMarkup. We only emit <b>/<i>/<u> and entity escapes,
  // so a small custom parser is enough. GJS's Pango.AttrIterator.get(type) is
  // unreliable, so we don't use Pango.parse_markup here.
  private setBufferFromMarkup(markup: string): void {
    const {plainText, runs} = parseSimpleMarkup(markup);
    this.buffer.set_text(plainText, -1);
    for (const run of runs) {
      if (run.tags.size === 0) continue;
      const start = this.buffer.get_iter_at_offset(run.start);
      const end = this.buffer.get_iter_at_offset(run.end);
      for (const tag of run.tags) {
        this.buffer.apply_tag_by_name(tag, start, end);
      }
    }
  }
}

interface MarkupRun {
  start: number;
  end: number;
  tags: Set<TagName>;
}

function parseSimpleMarkup(markup: string): {
  plainText: string;
  runs: MarkupRun[];
} {
  let plainText = '';
  const runs: MarkupRun[] = [];
  const stack: TagName[] = [];
  let runStart = 0;

  function flushRun(end: number): void {
    if (end > runStart) {
      runs.push({start: runStart, end, tags: new Set(stack)});
    }
    runStart = end;
  }

  let i = 0;
  while (i < markup.length) {
    const ch = markup[i];
    if (ch === '<') {
      flushRun(plainText.length);
      const gt = markup.indexOf('>', i);
      if (gt < 0) break;
      const inner = markup.slice(i + 1, gt);
      const closing = inner.startsWith('/');
      const name = closing ? inner.slice(1) : inner;
      const tagName = MARKUP_TAG_REVERSE[name];
      if (tagName) {
        if (closing) {
          const idx = stack.lastIndexOf(tagName);
          if (idx >= 0) stack.splice(idx, 1);
        } else {
          stack.push(tagName);
        }
      }
      i = gt + 1;
    } else if (ch === '&') {
      const semi = markup.indexOf(';', i);
      if (semi < 0) {
        plainText += ch;
        i++;
      } else {
        const entity = markup.slice(i + 1, semi);
        plainText += decodeEntity(entity);
        i = semi + 1;
      }
    } else {
      plainText += ch;
      i++;
    }
  }
  flushRun(plainText.length);

  return {plainText, runs};
}

function decodeEntity(name: string): string {
  switch (name) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      // Numeric character references (&#NN; / &#xHH;) are rare in our output
      // but worth a try; unknown entities collapse to empty.
      if (name.startsWith('#x') || name.startsWith('#X')) {
        return fromCodePointSafe(parseInt(name.slice(2), 16));
      }
      if (name.startsWith('#')) {
        return fromCodePointSafe(parseInt(name.slice(1), 10));
      }
      return '';
  }
}

// String.fromCodePoint throws RangeError outside 0…0x10FFFF (and parseInt can
// hand us NaN), so range-check before converting; unrepresentable refs collapse
// to empty. Our own markup never emits numeric refs, but re-edit shouldn't be
// able to throw on hand-crafted input either.
function fromCodePointSafe(code: number): string {
  if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
    return String.fromCodePoint(code);
  }
  return '';
}

function keyToTag(keyval: number): TagName | null {
  if (keyval === Gdk.KEY_b || keyval === Gdk.KEY_B) return 'bold';
  if (keyval === Gdk.KEY_i || keyval === Gdk.KEY_I) return 'italic';
  if (keyval === Gdk.KEY_u || keyval === Gdk.KEY_U) return 'underline';
  return null;
}

function activeTagSet(iter: Gtk.TextIter): Set<TagName> {
  const set = new Set<TagName>();
  for (const tag of iter.get_tags()) {
    const name = tag.name as TagName;
    if (TAG_NAMES.includes(name)) set.add(name);
  }
  return set;
}

function allCharsHaveTag(start: Gtk.TextIter, end: Gtk.TextIter, tagName: TagName): boolean {
  const iter = start.copy();
  while (!iter.equal(end)) {
    if (!activeTagSet(iter).has(tagName)) return false;
    if (!iter.forward_char()) break;
  }
  return true;
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
