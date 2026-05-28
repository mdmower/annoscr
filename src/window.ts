import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Cairo from 'cairo';

import {AnnoscrApplication} from './application.js';
import {CanvasView} from './canvas_view.js';
import {createBlankSurface} from './image_transforms.js';
import {loadFromFile, loadFromPixbuf} from './image_loader.js';
import {
  CANVAS_SIZE_MAX,
  CANVAS_SIZE_MIN,
  ColorRGBA,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  StampVariant,
  TEXT_STYLE,
  ToolId,
  WIDTH_MAX,
  WIDTH_MIN,
  defaultColorForTool,
  defaultFillForTool,
  defaultFontDescForTool,
  defaultFontSizeForTool,
  defaultWidthForTool,
  makeTextAction,
} from './actions.js';
import {getAvailableFonts} from './font_catalogue.js';
import {TextEditor, TextEditorBeginOptions, TextEditorStyle} from './text_editor.js';
import {
  FORMATS,
  ImageFormat,
  copySurfaceToClipboard,
  defaultSaveFilename,
  defaultSaveFolderPath,
  formatFromPath,
  saveSurface,
} from './exporter.js';

const WINDOW_CSS = `
  .annoscr-font-size > text {
    padding-left: 12px;
  }
`;

let windowCssInstalled = false;
function installWindowCss(): void {
  if (windowCssInstalled) return;
  const display = Gdk.Display.get_default();
  if (!display) return;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(WINDOW_CSS);
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  Gtk.StyleContext.add_provider_for_display(
    display,
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
  );
  windowCssInstalled = true;
}

const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
];

interface SizePreset {
  label: string;
  w: number;
  h: number;
}

const SIZE_PRESETS: SizePreset[] = [
  {label: 'Custom', w: 0, h: 0},
  {label: '640 \u00d7 480', w: 640, h: 480},
  {label: '800 \u00d7 600', w: 800, h: 600},
  {label: '1280 \u00d7 720 (HD)', w: 1280, h: 720},
  {label: '1920 \u00d7 1080 (Full HD)', w: 1920, h: 1080},
];

const DEFAULT_PRESET_INDEX = 2;

interface ToolDef {
  id: ToolId;
  label: string;
  accelerator: string;
}

const TOOLS: ToolDef[] = [
  {id: 'select', label: 'Select', accelerator: 's'},
  {id: 'pen', label: 'Pen', accelerator: 'p'},
  {id: 'highlighter', label: 'Highlight', accelerator: 'h'},
  {id: 'text', label: 'Text', accelerator: 't'},
  {id: 'number', label: 'Number', accelerator: 'n'},
  {id: 'line', label: 'Line', accelerator: 'l'},
  {id: 'arrow', label: 'Arrow', accelerator: 'a'},
  {id: 'rect', label: 'Rect', accelerator: 'r'},
  {id: 'oval', label: 'Oval', accelerator: 'o'},
];

export const AnnoscrWindow = GObject.registerClass(
  {GTypeName: 'AnnoscrWindow'},
  class extends Adw.ApplicationWindow {
    private canvas: InstanceType<typeof CanvasView>;
    private stack: Gtk.Stack;
    private editor: InstanceType<typeof TextEditor>;
    private toolButtons: Map<ToolId, Gtk.ToggleButton> = new Map();
    private resizeToolbar: Gtk.Box;
    // Assigned inside buildStatusBar(), which the constructor calls.
    private statusLabel!: Gtk.Label;
    // Set true just before we explicitly call close() after the user has
    // chosen Discard, so the close-request handler doesn't re-prompt.
    private skipCloseConfirm: boolean = false;
    private saveButton: Gtk.Button;
    private copyButton: Gtk.Button;
    // Assigned inside buildStyleBar(), which the constructor calls.
    private styleBar!: Gtk.Box;
    private colorButton!: Gtk.ColorDialogButton;
    private colorGroup!: Gtk.Box;
    private fillButton!: Gtk.ColorDialogButton;
    private fillGroup!: Gtk.Box;
    private widthScale!: Gtk.Scale;
    private widthPreview!: Gtk.DrawingArea;
    private widthGroup!: Gtk.Box;
    private variantGroup!: Gtk.Box;
    private variantDropdown!: Gtk.DropDown;
    private fontGroup!: Gtk.Box;
    private fontDropdown!: Gtk.DropDown;
    private fontSizeSpinner!: Gtk.SpinButton;
    // Ordered (group, separator) pairs for the first-visible-separator logic
    // in refreshStylePicker.
    private styleGroupOrder: Array<{group: Gtk.Box; sep: Gtk.Separator}> = [];
    // Guard against the programmatic set_rgba() / set_value() we do in
    // refreshStylePicker firing change signals and looping back into the
    // user-edit handlers.
    private updatingPicker: boolean = false;
    private toastOverlay!: Adw.ToastOverlay;

    constructor(app: InstanceType<typeof AnnoscrApplication>) {
      super({
        application: app,
        title: 'Annoscr',
        default_width: 960,
        default_height: 640,
      });

      installWindowCss();

      const header = new Adw.HeaderBar();

      const newButton = new Gtk.Button({
        icon_name: 'document-new-symbolic',
        tooltip_text: 'New blank canvas… (Ctrl+N)',
      });
      newButton.connect('clicked', () => this.newBlankCanvas());
      header.pack_start(newButton);

      const openButton = new Gtk.Button({
        icon_name: 'document-open-symbolic',
        tooltip_text: 'Open image… (Ctrl+O)',
      });
      openButton.connect('clicked', () => this.openImageDialog());
      header.pack_start(openButton);

      this.saveButton = new Gtk.Button({
        icon_name: 'document-save-symbolic',
        tooltip_text: 'Save image… (Ctrl+S)',
        sensitive: false,
      });
      this.saveButton.connect('clicked', () => this.saveImageDialog());
      header.pack_start(this.saveButton);

      this.copyButton = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        tooltip_text: 'Copy image to clipboard (Ctrl+C)',
        sensitive: false,
      });
      this.copyButton.connect('clicked', () => this.copyImageToClipboard());
      header.pack_start(this.copyButton);

      // pack_end stacks right-to-left in source order, so to land the buttons
      // as [Rotate Left][Rotate Right][Resize] left-to-right we add Resize first.
      const resizeButton = new Gtk.Button({
        icon_name: 'view-fullscreen-symbolic',
        tooltip_text: 'Resize canvas…',
      });
      resizeButton.connect('clicked', () => this.toggleResizeMode());
      header.pack_end(resizeButton);

      const rotateRightBtn = new Gtk.Button({
        icon_name: 'object-rotate-right-symbolic',
        tooltip_text: 'Rotate right (90°)',
      });
      rotateRightBtn.connect('clicked', () => this.canvas.rotate('cw'));
      header.pack_end(rotateRightBtn);

      const rotateLeftBtn = new Gtk.Button({
        icon_name: 'object-rotate-left-symbolic',
        tooltip_text: 'Rotate left (90°)',
      });
      rotateLeftBtn.connect('clicked', () => this.canvas.rotate('ccw'));
      header.pack_end(rotateLeftBtn);

      this.canvas = new CanvasView();

      this.editor = new TextEditor({
        onCommit: (
          markup: string,
          ix: number,
          iy: number,
          rotation: number,
          style,
          editorSize,
          replaceIndex?: number
        ) => {
          // The editor is the source of truth for style + size during an
          // edit; pickers update style via refreshStyle and the corner grip
          // updates editorSize — both land here at commit.
          const action = makeTextAction(
            ix,
            iy,
            markup,
            rotation,
            style.color,
            style.fontDesc,
            style.size,
            editorSize
          );
          if (replaceIndex !== undefined) {
            this.canvas.replaceAction(replaceIndex, action);
          } else {
            this.canvas.addAction(action);
          }
        },
        onCancel: (replaceIndex?: number) => {
          if (replaceIndex !== undefined) this.canvas.clearEditing();
          // Editor is no longer the style source — refresh so the picker
          // reverts to the tool default / selected action.
          this.refreshStylePicker();
        },
      });
      this.canvas.setTextEditRequestHandler(
        (ix: number, iy: number, wx: number, wy: number, options?: TextEditorBeginOptions) => {
          // Click on canvas with text tool active (or double-click with select tool):
          // commit any prior edit, then begin a new one. Pass-through options
          // carry markup + replaceIndex for re-edit of an existing TextAction.
          this.editor.commitIfActive();
          // Editor preview uses the same color/font the commit will use, so
          // placement and sizing reflect the final TextAction.
          const color = this.textColorFor(options?.replaceIndex);
          const fontDesc = this.textFontDescFor(options?.replaceIndex);
          const fontSize = this.textFontSizeFor(options?.replaceIndex);
          const style = {color, fontDesc, size: fontSize};
          this.editor.beginAt(ix, iy, wx, wy, {...options, style});
          // Picker now reflects the editor's style (color + font of the
          // in-progress edit), so refresh to point dropdown + buttons at it.
          this.refreshStylePicker();
        }
      );

      const overlay = new Gtk.Overlay();
      overlay.set_child(this.canvas);
      overlay.add_overlay(this.editor.getWidget());
      this.resizeToolbar = this.buildResizeToolbar();
      overlay.add_overlay(this.resizeToolbar);

      const toolBar = this.buildToolBar();
      header.set_title_widget(toolBar);

      const empty = new Adw.StatusPage({
        icon_name: 'image-x-generic-symbolic',
        title: 'Annoscr',
        description:
          'Create a blank canvas, open an image, paste from the clipboard, or drop a file here.',
      });

      this.stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
      });
      this.stack.add_named(empty, 'empty');
      this.stack.add_named(overlay, 'canvas');
      this.stack.set_visible_child_name('empty');

      const toolbar = new Adw.ToolbarView();
      toolbar.add_top_bar(header);
      toolbar.add_top_bar(this.buildStyleBar());
      toolbar.set_content(this.stack);
      toolbar.add_bottom_bar(this.buildStatusBar());
      this.toastOverlay = new Adw.ToastOverlay({child: toolbar});
      this.set_content(this.toastOverlay);

      this.canvas.setStateChangeHandler(() => {
        this.refreshStatus();
        this.refreshStylePicker();
      });
      this.refreshStatus();
      this.refreshStylePicker();

      this.installDropTarget();
      this.installShortcuts();
      this.installCloseGuard();
    }

    private installCloseGuard(): void {
      this.connect('close-request', () => {
        if (this.skipCloseConfirm || !this.canvas.isDirty()) return false;
        this.confirmDiscard('Closing the window', () => {
          this.skipCloseConfirm = true;
          this.close();
        });
        return true; // block the default close until the user responds
      });
    }

    // Pick the color for a text commit. Re-edit preserves the existing
    // action's color (so changing the text-tool default doesn't mutate
    // historical actions); fresh text uses the tool's current color.
    private textColorFor(replaceIndex: number | undefined): ColorRGBA {
      if (replaceIndex !== undefined) {
        const existing = this.canvas.getActionAt(replaceIndex);
        const c = existing?.getColor();
        if (c) return c;
      }
      return this.canvas.getToolColor('text') ?? defaultColorForTool('text');
    }

    private textFontDescFor(replaceIndex: number | undefined): string {
      if (replaceIndex !== undefined) {
        const existing = this.canvas.getActionAt(replaceIndex);
        const f = existing?.getFontDesc();
        if (f) return f;
      }
      return this.canvas.getToolFontDesc('text') ?? TEXT_STYLE.fontDesc;
    }

    private textFontSizeFor(replaceIndex: number | undefined): number {
      if (replaceIndex !== undefined) {
        const existing = this.canvas.getActionAt(replaceIndex);
        const s = existing?.getFontSize();
        if (s) return s;
      }
      return this.canvas.getToolFontSize('text') ?? TEXT_STYLE.size;
    }

    // Patch the editor's current style with new field values from a picker
    // change so the live TextView and the eventual commit both reflect the
    // user's latest pick. The editor (not toolColors / the selected action)
    // is the source of truth for style while an edit is in progress.
    private patchEditorStyle(overrides: Partial<TextEditorStyle>): void {
      if (!this.editor.isActive()) return;
      const current = this.editor.getCurrentStyle();
      if (!current) return;
      this.editor.refreshStyle({...current, ...overrides});
    }

    private buildStyleBar(): Gtk.Box {
      this.styleBar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_start: 12,
        margin_end: 12,
        margin_top: 4,
        margin_bottom: 4,
        // Fixed height so the bar always occupies the same space regardless
        // of which groups are visible. Without this, hiding/showing groups
        // resizes the canvas and shifts the image.
        height_request: WIDTH_MAX + 4,
      });

      const makeSep = (): Gtk.Separator =>
        new Gtk.Separator({
          orientation: Gtk.Orientation.VERTICAL,
          margin_start: 8,
          margin_end: 8,
        });

      const makeGroup = (sep: Gtk.Separator, ...children: Gtk.Widget[]): Gtk.Box => {
        const g = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        g.append(sep);
        for (const c of children) g.append(c);
        return g;
      };

      // Color group
      const colorSep = makeSep();
      this.colorButton = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: true}),
      });
      this.colorButton.connect('notify::rgba', () => this.onColorPicked());
      this.colorGroup = makeGroup(
        colorSep,
        new Gtk.Label({label: 'Color', css_classes: ['caption']}),
        this.colorButton
      );
      this.styleBar.append(this.colorGroup);

      // Fill group
      const fillSep = makeSep();
      this.fillButton = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: true}),
      });
      this.fillButton.connect('notify::rgba', () => this.onFillPicked());
      this.fillGroup = makeGroup(
        fillSep,
        new Gtk.Label({label: 'Fill', css_classes: ['caption']}),
        this.fillButton
      );
      this.styleBar.append(this.fillGroup);

      // Width group
      const widthSep = makeSep();
      this.widthScale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({
          lower: WIDTH_MIN,
          upper: WIDTH_MAX,
          step_increment: 1,
          page_increment: 5,
        }),
        digits: 0,
        draw_value: true,
        value_pos: Gtk.PositionType.RIGHT,
        width_request: 160,
      });
      this.widthScale.connect('value-changed', () => this.onWidthPicked());
      this.widthPreview = new Gtk.DrawingArea({
        width_request: 56,
        height_request: WIDTH_MAX + 4,
        valign: Gtk.Align.CENTER,
      });
      this.widthPreview.set_draw_func((_w, cr, w, h) => this.drawWidthPreview(cr, w, h));
      this.widthGroup = makeGroup(
        widthSep,
        new Gtk.Label({label: 'Width', css_classes: ['caption']}),
        this.widthScale,
        this.widthPreview
      );
      this.styleBar.append(this.widthGroup);

      // Variant group
      const variantSep = makeSep();
      this.variantDropdown = Gtk.DropDown.new_from_strings(['Number', 'Letter']);
      this.variantDropdown.connect('notify::selected', () => this.onVariantPicked());
      this.variantGroup = makeGroup(
        variantSep,
        new Gtk.Label({label: 'Variant', css_classes: ['caption']}),
        this.variantDropdown
      );
      this.styleBar.append(this.variantGroup);

      // Font group
      const fontSep = makeSep();
      this.fontDropdown = Gtk.DropDown.new_from_strings(getAvailableFonts().map((f) => f.label));
      this.fontDropdown.connect('notify::selected', () => this.onFontDescPicked());
      this.fontSizeSpinner = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
          lower: FONT_SIZE_MIN,
          upper: FONT_SIZE_MAX,
          step_increment: 1,
          page_increment: 4,
        }),
        digits: 0,
        width_request: 64,
      });
      this.fontSizeSpinner.add_css_class('annoscr-font-size');
      this.fontSizeSpinner.connect('value-changed', () => this.onFontSizePicked());
      this.fontGroup = makeGroup(
        fontSep,
        new Gtk.Label({label: 'Font', css_classes: ['caption']}),
        this.fontDropdown,
        new Gtk.Label({label: 'Size', css_classes: ['caption'], margin_start: 6}),
        this.fontSizeSpinner
      );
      this.styleBar.append(this.fontGroup);

      this.styleGroupOrder = [
        {group: this.colorGroup, sep: colorSep},
        {group: this.fillGroup, sep: fillSep},
        {group: this.widthGroup, sep: widthSep},
        {group: this.variantGroup, sep: variantSep},
        {group: this.fontGroup, sep: fontSep},
      ];

      return this.styleBar;
    }

    private drawWidthPreview(cr: Cairo.Context, w: number, h: number): void {
      const color = this.styleTargetColor();
      const width = this.styleTargetWidth();
      if (color === null || width === null) return;
      // Cap visible thickness to the preview height so the full slider range
      // still fits visually; the slider's numeric readout carries the exact
      // value when the bar saturates.
      const drawWidth = Math.min(width, h - 2);
      cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
      cr.setLineWidth(drawWidth);
      cr.setLineCap(Cairo.LineCap.ROUND);
      cr.moveTo(8, h / 2);
      cr.lineTo(w - 8, h / 2);
      cr.stroke();
    }

    private refreshStylePicker(): void {
      if (!this.colorButton) return;
      this.updatingPicker = true;

      const color = this.styleTargetColor();
      this.colorGroup.set_visible(color !== null);
      if (color !== null) this.colorButton.set_rgba(colorToRgba(color));

      const fill = this.styleTargetFill();
      this.fillGroup.set_visible(fill !== null);
      if (fill !== null) this.fillButton.set_rgba(colorToRgba(fill));

      const width = this.styleTargetWidth();
      this.widthGroup.set_visible(width !== null);
      if (width !== null) this.widthScale.set_value(width);

      const tool = this.canvas.getTool();
      this.variantGroup.set_visible(tool === 'number');
      this.variantDropdown.set_selected(this.canvas.getStampVariant() === 'letter' ? 1 : 0);

      const fontDesc = this.styleTargetFontDesc();
      this.fontGroup.set_visible(fontDesc !== null);
      if (fontDesc !== null) {
        const idx = getAvailableFonts().findIndex((f) => f.family === fontDesc);
        this.fontDropdown.set_selected(idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION);
      }
      const fontSize = this.styleTargetFontSize();
      if (fontSize !== null) {
        this.fontSizeSpinner.set_value(fontSize);
      }

      // Hide the leading separator on the first visible group so there's no
      // orphan divider at the left edge.
      let firstVisible = true;
      for (const {group, sep} of this.styleGroupOrder) {
        if (group.get_visible()) {
          sep.set_visible(!firstVisible);
          firstVisible = false;
        }
      }

      this.updatingPicker = false;
      this.widthPreview.queue_draw();
    }

    private onVariantPicked(): void {
      if (this.updatingPicker || !this.variantDropdown) return;
      const variant: StampVariant = this.variantDropdown.get_selected() === 1 ? 'letter' : 'number';
      this.canvas.setStampVariant(variant);
    }

    private onFontDescPicked(): void {
      if (this.updatingPicker || !this.fontDropdown) return;
      const idx = this.fontDropdown.get_selected();
      if (idx === Gtk.INVALID_LIST_POSITION) return;
      const fonts = getAvailableFonts();
      if (idx >= fonts.length) return;
      const fontDesc = fonts[idx].family;
      const tool = this.canvas.getTool();
      const editorActive = this.editor.isActive();
      // Active edit → flow into the editor (which propagates to commit and
      // updates the live preview + caret focus). Outside an edit, fall back
      // to the standard select-vs-tool routing. Sticky tool default also
      // updates for text-tool placements so the next click inherits.
      if (editorActive) {
        this.patchEditorStyle({fontDesc});
      } else if (tool === 'select') {
        this.canvas.replaceSelectedFontDesc(fontDesc);
      }
      if (defaultFontDescForTool(tool) !== null) {
        this.canvas.setToolFontDesc(tool, fontDesc);
      }
    }

    private onFontSizePicked(): void {
      if (this.updatingPicker || !this.fontSizeSpinner) return;
      const size = Math.round(this.fontSizeSpinner.get_value());
      const tool = this.canvas.getTool();
      const editorActive = this.editor.isActive();
      if (editorActive) {
        this.patchEditorStyle({size});
      } else if (tool === 'select') {
        this.canvas.replaceSelectedFontSize(size);
      }
      if (defaultFontSizeForTool(tool) !== null) {
        this.canvas.setToolFontSize(tool, size);
      }
    }

    private styleTargetFontSize(): number | null {
      if (this.editor.isActive()) {
        return this.editor.getCurrentStyle()?.size ?? null;
      }
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        const sel = this.canvas.getSelectedAction();
        return sel ? sel.getFontSize() : null;
      }
      return this.canvas.getToolFontSize(tool);
    }

    private styleTargetFontDesc(): string | null {
      // During an active edit the editor owns the style; show what it has
      // (and therefore what will be committed), not the selected action or
      // tool default.
      if (this.editor.isActive()) {
        return this.editor.getCurrentStyle()?.fontDesc ?? null;
      }
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        const sel = this.canvas.getSelectedAction();
        return sel ? sel.getFontDesc() : null;
      }
      return this.canvas.getToolFontDesc(tool);
    }

    // The color that the picker should currently display, or null when the
    // picker has no meaningful color to show (and should be disabled).
    private styleTargetColor(): ColorRGBA | null {
      if (this.editor.isActive()) {
        return this.editor.getCurrentStyle()?.color ?? null;
      }
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        const sel = this.canvas.getSelectedAction();
        return sel ? sel.getColor() : null;
      }
      return this.canvas.getToolColor(tool);
    }

    private styleTargetWidth(): number | null {
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        const sel = this.canvas.getSelectedAction();
        return sel ? sel.getWidth() : null;
      }
      return this.canvas.getToolWidth(tool);
    }

    private styleTargetFill(): ColorRGBA | null {
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        const sel = this.canvas.getSelectedAction();
        return sel ? sel.getFill() : null;
      }
      return this.canvas.getToolFill(tool);
    }

    private onFillPicked(): void {
      if (this.updatingPicker || !this.fillButton) return;
      const fill = rgbaToColor(this.fillButton.get_rgba());
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        // Same select-edit shape as the color picker; coalesce-by-key gives
        // a single history entry for a drag (see pushState in canvas_view.ts).
        this.canvas.replaceSelectedFill(fill);
      } else if (defaultFillForTool(tool) !== null) {
        this.canvas.setToolFill(tool, fill);
      }
      this.widthPreview.queue_draw();
    }

    private onColorPicked(): void {
      if (this.updatingPicker || !this.colorButton) return;
      const color = rgbaToColor(this.colorButton.get_rgba());
      const tool = this.canvas.getTool();
      const editorActive = this.editor.isActive();
      // Same routing as the font picker: editor wins during an active edit;
      // otherwise apply to selection or tool default. Tool default updates
      // for any non-select tool so picker changes are sticky.
      if (editorActive) {
        this.patchEditorStyle({color});
      } else if (tool === 'select') {
        // Recolor the selected action in place. No-op if no action selected
        // or its color isn't editable (refreshStylePicker will have already
        // disabled the picker in that case, but guard anyway).
        this.canvas.replaceSelectedColor(color);
      }
      if (tool !== 'select' && tool !== 'resize') {
        this.canvas.setToolColor(tool, color);
      }
      this.widthPreview.queue_draw();
    }

    private onWidthPicked(): void {
      if (this.updatingPicker || !this.widthScale) return;
      const width = Math.round(this.widthScale.get_value());
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        // In select mode, recolor → resize in-place; same select-edit shape.
        // pushState coalesces by `width:${i}` so a drag is one history entry,
        // not one per slider tick (see pushState in canvas_view.ts).
        this.canvas.replaceSelectedWidth(width);
      } else if (defaultWidthForTool(tool) !== null) {
        this.canvas.setToolWidth(tool, width);
      }
      this.widthPreview.queue_draw();
    }

    private buildStatusBar(): Gtk.Box {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_start: 12,
        margin_end: 12,
        margin_top: 4,
        margin_bottom: 4,
      });
      this.statusLabel = new Gtk.Label({
        label: '',
        halign: Gtk.Align.START,
        hexpand: true,
        css_classes: ['dim-label', 'caption'],
      });
      box.append(this.statusLabel);
      return box;
    }

    private refreshStatus(): void {
      if (!this.statusLabel) return;
      const img = this.canvas.getImageDimensions();
      if (!img) {
        this.statusLabel.set_label('');
        return;
      }
      const base = `${img.w} × ${img.h} px`;
      const r = this.canvas.getResizeDimensions();
      // U+2003 EM SPACE on either side of the arrow gives breathing room
      // without depending on Pango markup or label padding tricks.
      this.statusLabel.set_label(r ? `${base}\u2003→\u2003${r.w} \u00d7 ${r.h} px` : base);
    }

    // Show a destructive-action confirmation if the canvas has unsaved
    // annotations. `onProceed` runs only when the user explicitly discards,
    // or immediately if the canvas is already clean.
    private confirmDiscard(action: string, onProceed: () => void): void {
      if (!this.canvas.isDirty()) {
        onProceed();
        return;
      }
      const dialog = new Adw.AlertDialog({
        heading: 'Discard changes?',
        body: `${action} will replace your current work. Save (Ctrl+S) or copy (Ctrl+C) first if you want to keep it.`,
      });
      dialog.add_response('cancel', 'Cancel');
      dialog.add_response('discard', 'Discard');
      dialog.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
      dialog.set_default_response('cancel');
      dialog.set_close_response('cancel');
      dialog.connect('response', (_d, response) => {
        if (response === 'discard') onProceed();
      });
      dialog.present(this);
    }

    private openImageDialog(): void {
      this.confirmDiscard('Opening a new image', () => this.openImageDialogUnchecked());
    }

    private openImageDialogUnchecked(): void {
      const dialog = new Gtk.FileDialog({title: 'Open image', modal: true});

      const filter = new Gtk.FileFilter({name: 'Images'});
      for (const mime of IMAGE_MIME_TYPES) filter.add_mime_type(mime);
      const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
      filters.append(filter);
      dialog.set_filters(filters);
      dialog.set_default_filter(filter);

      dialog.open(this, null, (_src, result) => {
        try {
          const file = dialog.open_finish(result);
          if (file) this.openFile(file);
        } catch (e) {
          // Cancellation surfaces as a Gtk DialogError; ignore those and log the rest.
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.error('open_finish failed', e);
          }
        }
      });
    }

    createBlankCanvas(w: number, h: number): void {
      this.setImage(createBlankSurface(w, h, [1, 1, 1, 1]));
    }

    private newBlankCanvas(): void {
      this.confirmDiscard('Creating a blank canvas', () => this.showNewCanvasDialog());
    }

    private showNewCanvasDialog(): void {
      const dialog = new Adw.AlertDialog({
        heading: 'New Blank Canvas',
        body: 'Set the canvas size and background color.',
      });
      dialog.add_response('cancel', 'Cancel');
      dialog.add_response('create', 'Create');
      dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
      dialog.set_default_response('create');
      dialog.set_close_response('cancel');

      const grid = new Gtk.Grid({
        row_spacing: 8,
        column_spacing: 12,
      });

      grid.attach(
        new Gtk.Label({label: 'Size', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
        0,
        0,
        1,
        1
      );
      const presetDropdown = Gtk.DropDown.new_from_strings(SIZE_PRESETS.map((p) => p.label));
      presetDropdown.set_hexpand(true);
      presetDropdown.set_selected(DEFAULT_PRESET_INDEX);
      grid.attach(presetDropdown, 1, 0, 1, 1);

      grid.attach(
        new Gtk.Label({label: 'Width', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
        0,
        1,
        1,
        1
      );
      const widthSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
          lower: CANVAS_SIZE_MIN,
          upper: CANVAS_SIZE_MAX,
          step_increment: 1,
          page_increment: 100,
        }),
        digits: 0,
        width_request: 100,
      });
      widthSpin.set_value(SIZE_PRESETS[DEFAULT_PRESET_INDEX].w);
      grid.attach(widthSpin, 1, 1, 1, 1);

      grid.attach(
        new Gtk.Label({label: 'Height', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
        0,
        2,
        1,
        1
      );
      const heightSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
          lower: CANVAS_SIZE_MIN,
          upper: CANVAS_SIZE_MAX,
          step_increment: 1,
          page_increment: 100,
        }),
        digits: 0,
        width_request: 100,
      });
      heightSpin.set_value(SIZE_PRESETS[DEFAULT_PRESET_INDEX].h);
      grid.attach(heightSpin, 1, 2, 1, 1);

      grid.attach(
        new Gtk.Label({label: 'Fill', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
        0,
        3,
        1,
        1
      );
      const fillDialog = new Gtk.ColorDialog({with_alpha: true});
      const fillBtn = new Gtk.ColorDialogButton({dialog: fillDialog});
      fillBtn.set_rgba(colorToRgba([1, 1, 1, 1]));
      grid.attach(fillBtn, 1, 3, 1, 1);

      let updating = false;
      presetDropdown.connect('notify::selected', () => {
        if (updating) return;
        const idx = presetDropdown.get_selected();
        if (idx > 0 && idx < SIZE_PRESETS.length) {
          updating = true;
          widthSpin.set_value(SIZE_PRESETS[idx].w);
          heightSpin.set_value(SIZE_PRESETS[idx].h);
          updating = false;
        }
      });
      const syncPreset = (): void => {
        if (updating) return;
        const w = Math.round(widthSpin.get_value());
        const h = Math.round(heightSpin.get_value());
        const match = SIZE_PRESETS.findIndex((p) => p.w === w && p.h === h);
        updating = true;
        presetDropdown.set_selected(match >= 0 ? match : 0);
        updating = false;
      };
      widthSpin.connect('value-changed', syncPreset);
      heightSpin.connect('value-changed', syncPreset);

      dialog.set_extra_child(grid);

      dialog.connect('response', (_d, response) => {
        if (response !== 'create') return;
        const w = Math.round(widthSpin.get_value());
        const h = Math.round(heightSpin.get_value());
        const fill = rgbaToColor(fillBtn.get_rgba());
        this.setImage(createBlankSurface(w, h, fill));
      });

      dialog.present(this);
    }

    openFile(file: Gio.File): void {
      try {
        this.setImage(loadFromFile(file));
      } catch {
        const name = file.get_basename() ?? file.get_uri();
        this.toastOverlay.add_toast(
          new Adw.Toast({title: `Could not open "${name}": unsupported file format`})
        );
      }
    }

    private setImage(surface: Cairo.ImageSurface): void {
      // Discard any in-progress text edit or resize — they belonged to the old image.
      this.editor.cancel();
      if (this.canvas.getTool() === 'resize') this.exitResizeMode(false);
      this.canvas.setImage(surface);
      this.stack.set_visible_child_name('canvas');
      this.saveButton.set_sensitive(true);
      this.copyButton.set_sensitive(true);
    }

    private installDropTarget(): void {
      const dropTarget = Gtk.DropTarget.new(Gio.File.$gtype, Gdk.DragAction.COPY);
      dropTarget.connect('drop', (_target: unknown, file: Gio.File) => {
        if (!file) return false;
        this.confirmDiscard('Loading the dropped image', () => this.openFile(file));
        return true;
      });
      this.add_controller(dropTarget);
    }

    private installShortcuts(): void {
      const controller = new Gtk.ShortcutController();
      this.bindShortcut(controller, '<Control>n', () => this.newBlankCanvas());
      this.bindShortcut(controller, '<Control>o', () => this.openImageDialog());
      this.bindShortcut(controller, '<Control>v', () => this.pasteFromClipboard());
      // Undo/redo are disabled while resize mode is active: a pending region
      // is transient state that hasn't been committed, and rolling history
      // out from under it would be confusing (the resize would silently
      // target whatever surface the undo landed on).
      this.bindShortcut(controller, '<Control>z', () => {
        if (this.canvas.getTool() === 'resize') return;
        this.canvas.undo();
      });
      this.bindShortcut(controller, '<Control><Shift>z', () => {
        if (this.canvas.getTool() === 'resize') return;
        this.canvas.redo();
      });
      this.bindShortcut(controller, '<Control>y', () => {
        if (this.canvas.getTool() === 'resize') return;
        this.canvas.redo();
      });
      this.bindShortcut(controller, '<Control>s', () => {
        if (this.canvas.hasImage()) this.saveImageDialog();
      });
      // Ctrl+C must not steal the editor's text-copy shortcut when the editor
      // is open. The TextView's built-in handler normally consumes the event
      // before it bubbles here; this is a belt-and-suspenders gate.
      this.bindShortcut(controller, '<Control>c', () => {
        if (this.editor.isActive()) return false;
        if (this.canvas.hasImage()) this.copyImageToClipboard();
        return true;
      });
      this.bindShortcut(controller, 'Delete', () => this.canvas.deleteSelected());
      this.bindShortcut(controller, 'BackSpace', () => this.canvas.deleteSelected());
      // Enter and Escape only do anything when resize mode is active. The text
      // editor consumes these in its CAPTURE-phase controller before they
      // reach here, so we never conflict during editing.
      this.bindShortcut(controller, 'Return', () => {
        if (this.canvas.getTool() === 'resize') this.exitResizeMode(true);
      });
      this.bindShortcut(controller, 'Escape', () => {
        if (this.canvas.getTool() === 'resize') {
          this.exitResizeMode(false);
          return true;
        }
        // Deselect when the select tool has something picked. Returning false
        // when nothing is selected lets the event bubble (e.g. to a dialog).
        if (this.canvas.getTool() === 'select') return this.canvas.clearSelection();
        return false;
      });
      for (const tool of TOOLS) {
        this.bindShortcut(controller, tool.accelerator, () => this.selectTool(tool.id));
      }
      this.add_controller(controller);
    }

    private buildToolBar(): Gtk.Box {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 0,
        css_classes: ['linked'],
      });
      let group: Gtk.ToggleButton | null = null;
      for (const tool of TOOLS) {
        const tooltip =
          tool.id === 'select'
            ? `${tool.label} (${tool.accelerator.toUpperCase()})\nAlt+Click to cycle overlapping`
            : `${tool.label} (${tool.accelerator.toUpperCase()})`;
        const btn = new Gtk.ToggleButton({
          label: tool.label,
          tooltip_text: tooltip,
          active: tool.id === this.canvas.getTool(),
        });
        if (group) btn.set_group(group);
        else group = btn;
        btn.connect('toggled', () => {
          if (btn.get_active()) this.selectTool(tool.id);
        });
        this.toolButtons.set(tool.id, btn);
        box.append(btn);
      }
      return box;
    }

    private selectTool(id: ToolId): void {
      // Switching to a non-resize tool while in resize mode = "I changed my
      // mind." Cancel any in-progress region and hide the toolbar inline
      // (calling exitResizeMode here would recurse — it also calls back into
      // setActiveTool).
      if (this.canvas.getTool() === 'resize' && id !== 'resize') {
        this.canvas.cancelResize();
        this.resizeToolbar.set_visible(false);
      }
      // Commit any in-progress text edit before switching away from the text tool.
      this.editor.commitIfActive();
      this.setActiveTool(id);
    }

    private setActiveTool(id: ToolId): void {
      this.canvas.setTool(id);
      const btn = this.toolButtons.get(id);
      if (btn && !btn.get_active()) btn.set_active(true);
    }

    private buildResizeToolbar(): Gtk.Box {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.START,
        margin_top: 12,
        visible: false,
        css_classes: ['toolbar', 'osd'],
      });
      const cancelBtn = new Gtk.Button({label: 'Cancel'});
      cancelBtn.connect('clicked', () => this.exitResizeMode(false));
      const applyBtn = new Gtk.Button({
        label: 'Apply',
        css_classes: ['suggested-action'],
      });
      applyBtn.connect('clicked', () => this.exitResizeMode(true));
      box.append(cancelBtn);
      box.append(applyBtn);
      return box;
    }

    private toggleResizeMode(): void {
      if (this.canvas.getTool() === 'resize') {
        this.exitResizeMode(false);
      } else {
        this.enterResizeMode();
      }
    }

    private enterResizeMode(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      this.canvas.setTool('resize');
      this.resizeToolbar.set_visible(true);
    }

    private exitResizeMode(apply: boolean): void {
      if (this.canvas.getTool() !== 'resize') return;
      if (apply) this.canvas.applyResize();
      else this.canvas.cancelResize();
      this.resizeToolbar.set_visible(false);
      this.setActiveTool('select');
    }

    private bindShortcut(
      controller: Gtk.ShortcutController,
      accelerator: string,
      callback: () => boolean | void
    ): void {
      const trigger = Gtk.ShortcutTrigger.parse_string(accelerator);
      const action = Gtk.CallbackAction.new(() => {
        // Returning false from the callback means "not handled" — lets the
        // event keep propagating to other controllers (e.g. an editor's
        // built-in shortcuts). Any non-false return value handles the event.
        const result = callback();
        return result !== false;
      });
      controller.add_shortcut(new Gtk.Shortcut({trigger, action}));
    }

    private saveImageDialog(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();

      const dialog = new Gtk.FileDialog({title: 'Save image', modal: true});
      dialog.set_initial_name(defaultSaveFilename());
      dialog.set_initial_folder(Gio.File.new_for_path(defaultSaveFolderPath()));

      // Single combined filter — extension in the filename decides the format.
      // Two separate filters would mislead the user: Gtk.FileDialog doesn't
      // report which one was active, so a dropdown pick can't drive format.
      const filter = new Gtk.FileFilter({name: 'Image (PNG, JPEG)'});
      for (const key of Object.keys(FORMATS) as ImageFormat[]) {
        const f = FORMATS[key];
        filter.add_mime_type(f.mime);
        for (const p of f.patterns) filter.add_pattern(p);
      }
      const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
      filters.append(filter);
      dialog.set_filters(filters);
      dialog.set_default_filter(filter);

      dialog.save(this, null, (_src, result) => {
        let file: Gio.File;
        try {
          file = dialog.save_finish(result);
        } catch (e) {
          // User cancelled or dismissed.
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.error('save_finish failed', e);
          }
          return;
        }
        if (!file) return;

        const surface = this.canvas.exportSnapshot();
        if (!surface) return;

        let path = file.get_path();
        if (!path) return;

        const format = formatFromPath(path);
        // If the user typed a name without an extension, append the canonical
        // one for the format their filter implied (PNG by default).
        const lower = path.toLowerCase();
        const hasKnownExt =
          lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
        if (!hasKnownExt) path = path + FORMATS[format].ext;

        try {
          saveSurface(surface, path, format);
          this.canvas.markClean();
        } catch (e) {
          console.error('saveSurface failed', e);
        }
      });
    }

    private copyImageToClipboard(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      const surface = this.canvas.exportSnapshot();
      if (!surface) return;
      try {
        copySurfaceToClipboard(this.get_clipboard(), surface);
        this.canvas.markClean();
      } catch (e) {
        console.error('copySurfaceToClipboard failed', e);
      }
    }

    private pasteFromClipboard(): void {
      this.confirmDiscard('Pasting a new image', () => this.pasteFromClipboardUnchecked());
    }

    private pasteFromClipboardUnchecked(): void {
      const clipboard = this.get_clipboard();
      clipboard.read_async(IMAGE_MIME_TYPES, GLib.PRIORITY_DEFAULT, null, (_src, result) => {
        let stream: Gio.InputStream | null = null;
        try {
          [stream] = clipboard.read_finish(result);
        } catch {
          this.pasteUriList(clipboard);
        }
        if (!stream) return;

        // Decoding must be async: the local clipboard delivers bytes via a
        // pipe pumped by the main loop. A synchronous Pixbuf.new_from_stream
        // would block the loop waiting for bytes that never arrive — the
        // classic same-process clipboard deadlock.
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (_pbSrc, pbResult) => {
          try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pbResult);
            stream.close(null);
            if (pixbuf) this.setImage(loadFromPixbuf(pixbuf));
          } catch (e) {
            console.error('paste (image bytes) failed', e);
          }
        });
      });
    }

    private pasteUriList(clipboard: Gdk.Clipboard): void {
      const mimes: string[] = clipboard.get_formats()?.get_mime_types() ?? [];
      if (!mimes.includes('text/uri-list')) {
        console.log(`paste: nothing usable on clipboard (formats: ${mimes.join(', ') || 'none'})`);
        return;
      }
      clipboard.read_async(['text/uri-list'], GLib.PRIORITY_DEFAULT, null, (_src, result) => {
        try {
          const [stream] = clipboard.read_finish(result);
          if (!stream) throw new Error('clipboard read failed');
          const bytes = stream.read_bytes(64 * 1024, null);
          stream.close(null);
          const text = new TextDecoder().decode(bytes.toArray());
          const uri = text
            .split(/\r?\n/)
            .find((line) => line && !line.startsWith('#'))
            ?.trim();
          if (uri) this.openFile(Gio.File.new_for_uri(uri));
        } catch (e) {
          console.error('paste (uri-list) failed', e);
        }
      });
    }
  }
);

function colorToRgba(c: ColorRGBA): Gdk.RGBA {
  const rgba = new Gdk.RGBA();
  rgba.red = c[0];
  rgba.green = c[1];
  rgba.blue = c[2];
  rgba.alpha = c[3];
  return rgba;
}

function rgbaToColor(rgba: Gdk.RGBA): ColorRGBA {
  return [rgba.red, rgba.green, rgba.blue, rgba.alpha];
}
