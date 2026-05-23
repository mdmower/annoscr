import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import cairo from 'cairo';
import type Cairo from 'cairo';

import {AnnoscrApplication} from './application.js';
import {CanvasView} from './canvas_view.js';
import {loadFromFile, loadFromPixbuf} from './image_loader.js';
import {
  ColorRGBA,
  ToolId,
  WIDTH_MAX,
  WIDTH_MIN,
  defaultColorForTool,
  defaultWidthForTool,
  makeTextAction,
} from './actions.js';
import {TextEditor, TextEditorBeginOptions} from './text_editor.js';
import {
  FORMATS,
  ImageFormat,
  copySurfaceToClipboard,
  defaultSaveFilename,
  defaultSaveFolderPath,
  formatFromPath,
  saveSurface,
} from './exporter.js';

const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
];

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
    private resizeButton: Gtk.Button;
    private statusLabel: Gtk.Label = new Gtk.Label();
    // Set true just before we explicitly call close() after the user has
    // chosen Discard, so the close-request handler doesn't re-prompt.
    private skipCloseConfirm: boolean = false;
    private saveButton: Gtk.Button;
    private copyButton: Gtk.Button;
    // Assigned inside buildStyleBar(), which the constructor calls.
    private colorButton!: Gtk.ColorDialogButton;
    private widthScale!: Gtk.Scale;
    private widthPreview!: Gtk.DrawingArea;
    // Guard against the programmatic set_rgba() / set_value() we do in
    // refreshStylePicker firing change signals and looping back into the
    // user-edit handlers.
    private updatingPicker: boolean = false;

    constructor(app: InstanceType<typeof AnnoscrApplication>) {
      super({
        application: app,
        title: 'Annoscr',
        default_width: 960,
        default_height: 640,
      });

      const header = new Adw.HeaderBar();

      const openButton = new Gtk.Button({
        icon_name: 'document-open-symbolic',
        tooltip_text: 'Open image…',
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
      this.resizeButton = new Gtk.Button({
        icon_name: 'view-fullscreen-symbolic',
        tooltip_text: 'Resize canvas…',
      });
      this.resizeButton.connect('clicked', () => this.toggleResizeMode());
      header.pack_end(this.resizeButton);

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
          replaceIndex?: number
        ) => {
          const color = this.textColorFor(replaceIndex);
          if (replaceIndex !== undefined) {
            this.canvas.replaceAction(
              replaceIndex,
              makeTextAction(ix, iy, markup, rotation, color)
            );
          } else {
            this.canvas.addAction(makeTextAction(ix, iy, markup, rotation, color));
          }
        },
        onCancel: (replaceIndex?: number) => {
          if (replaceIndex !== undefined) this.canvas.clearEditing();
        },
      });
      this.canvas.setTextEditRequestHandler(
        (ix: number, iy: number, wx: number, wy: number, options?: TextEditorBeginOptions) => {
          // Click on canvas with text tool active (or double-click with select tool):
          // commit any prior edit, then begin a new one. Pass-through options
          // carry markup + replaceIndex for re-edit of an existing TextAction.
          this.editor.commitIfActive();
          this.editor.beginAt(ix, iy, wx, wy, options);
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
        description: 'Open an image, paste from the clipboard, or drop a file here.',
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
      this.set_content(toolbar);

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

    private buildStyleBar(): Gtk.Box {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        margin_start: 12,
        margin_end: 12,
        margin_top: 4,
        margin_bottom: 4,
      });

      const colorLabel = new Gtk.Label({
        label: 'Color',
        css_classes: ['caption'],
      });
      const dialog = new Gtk.ColorDialog({with_alpha: true});
      this.colorButton = new Gtk.ColorDialogButton({dialog});
      this.colorButton.connect('notify::rgba', () => this.onColorPicked());
      box.append(colorLabel);
      box.append(this.colorButton);

      // Visual gap between the two style controls.
      box.append(
        new Gtk.Separator({
          orientation: Gtk.Orientation.VERTICAL,
          margin_start: 8,
          margin_end: 8,
        })
      );

      const widthLabel = new Gtk.Label({
        label: 'Width',
        css_classes: ['caption'],
      });
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
      // Preview area: draws a horizontal stroke of the current width in
      // image-space pixels (≡ widget pixels at 1:1). Width clamps to the
      // preview height so very fat strokes don't overflow.
      this.widthPreview = new Gtk.DrawingArea({
        width_request: 56,
        height_request: WIDTH_MAX + 4,
        valign: Gtk.Align.CENTER,
      });
      this.widthPreview.set_draw_func((_w, cr, w, h) => this.drawWidthPreview(cr, w, h));

      box.append(widthLabel);
      box.append(this.widthScale);
      box.append(this.widthPreview);

      return box;
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
      cr.setLineCap(cairo.LineCap.ROUND);
      cr.moveTo(8, h / 2);
      cr.lineTo(w - 8, h / 2);
      cr.stroke();
    }

    // Sync the color picker with whatever color the active context expects:
    //   - select tool + selected action → that action's color (greyed if no
    //     action selected or its color isn't editable)
    //   - drawing tool → that tool's stored color (or default)
    //   - non-color tool (number / resize) → greyed; picker shows nothing
    //     meaningful
    private refreshStylePicker(): void {
      if (!this.colorButton) return;
      this.updatingPicker = true;

      const color = this.styleTargetColor();
      this.colorButton.set_sensitive(color !== null);
      if (color !== null) this.colorButton.set_rgba(colorToRgba(color));

      const width = this.styleTargetWidth();
      this.widthScale.set_sensitive(width !== null);
      if (width !== null) this.widthScale.set_value(width);

      this.updatingPicker = false;
      this.widthPreview.queue_draw();
    }

    // The color that the picker should currently display, or null when the
    // picker has no meaningful color to show (and should be disabled).
    private styleTargetColor(): ColorRGBA | null {
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

    private onColorPicked(): void {
      if (this.updatingPicker || !this.colorButton) return;
      const color = rgbaToColor(this.colorButton.get_rgba());
      const tool = this.canvas.getTool();
      if (tool === 'select') {
        // Recolor the selected action in place. No-op if no action selected
        // or its color isn't editable (refreshStylePicker will have already
        // disabled the picker in that case, but guard anyway).
        this.canvas.replaceSelectedColor(color);
      } else {
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
      filter.add_mime_type('image/png');
      filter.add_mime_type('image/jpeg');
      filter.add_mime_type('image/webp');
      filter.add_mime_type('image/gif');
      filter.add_mime_type('image/bmp');
      filter.add_mime_type('image/tiff');
      const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
      filters.append(filter);
      dialog.set_filters(filters);
      dialog.set_default_filter(filter);

      dialog.open(this, null, (_src, result) => {
        try {
          const file = dialog.open_finish(result);
          if (file) this.loadFile(file);
        } catch (e) {
          // Cancellation surfaces as a Gtk DialogError; ignore those and log the rest.
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.error('open_finish failed', e);
          }
        }
      });
    }

    private loadFile(file: Gio.File): void {
      try {
        this.setImage(loadFromFile(file));
      } catch (e) {
        console.error('loadFile failed', e);
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
        this.confirmDiscard('Loading the dropped image', () => this.loadFile(file));
        return true;
      });
      this.add_controller(dropTarget);
    }

    private installShortcuts(): void {
      const controller = new Gtk.ShortcutController();
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
        if (this.canvas.getTool() === 'resize') this.exitResizeMode(false);
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
        const btn = new Gtk.ToggleButton({
          label: tool.label,
          tooltip_text: `${tool.label} (${tool.accelerator.toUpperCase()})`,
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
          if (uri) this.loadFile(Gio.File.new_for_uri(uri));
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
