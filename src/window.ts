import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';

import { CanvasView } from './canvas_view.js';
import { loadFromFile, loadFromPixbuf } from './image_loader.js';
import { ToolId, makeTextAction } from './actions.js';
import { TextEditor } from './text_editor.js';
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
  { id: 'select',      label: 'Select',    accelerator: 's' },
  { id: 'pen',         label: 'Pen',       accelerator: 'p' },
  { id: 'highlighter', label: 'Highlight', accelerator: 'h' },
  { id: 'text',        label: 'Text',      accelerator: 't' },
  { id: 'number',      label: 'Number',    accelerator: 'n' },
  { id: 'line',        label: 'Line',      accelerator: 'l' },
  { id: 'arrow',       label: 'Arrow',     accelerator: 'a' },
  { id: 'rect',        label: 'Rect',      accelerator: 'r' },
  { id: 'oval',        label: 'Oval',      accelerator: 'o' },
];

export const AnnoscrWindow = GObject.registerClass(
  class AnnoscrWindow extends Adw.ApplicationWindow {
    private canvas: any;
    private stack: any;
    private editor: any; // TextEditor; typed `any` because of the GObject.registerClass dance
    private toolButtons: Map<ToolId, any> = new Map();
    private resizeToolbar: any;
    private resizeButton: any;
    private saveButton: any;
    private copyButton: any;

    constructor(app: any) {
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
        onCommit: (markup: string, ix: number, iy: number, rotation: number, replaceIndex?: number) => {
          if (replaceIndex !== undefined) {
            this.canvas.replaceAction(replaceIndex, makeTextAction(ix, iy, markup, rotation));
          } else {
            this.canvas.addAction(makeTextAction(ix, iy, markup, rotation));
          }
        },
        onCancel: (replaceIndex?: number) => {
          if (replaceIndex !== undefined) this.canvas.clearEditing();
        },
      });
      this.canvas.setTextEditRequestHandler((ix: number, iy: number, wx: number, wy: number, options?: any) => {
        // Click on canvas with text tool active (or double-click with select tool):
        // commit any prior edit, then begin a new one. Pass-through options
        // carry markup + replaceIndex for re-edit of an existing TextAction.
        this.editor.commitIfActive();
        this.editor.beginAt(ix, iy, wx, wy, options);
      });

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
      toolbar.set_content(this.stack);
      this.set_content(toolbar);

      this.installDropTarget();
      this.installShortcuts();
    }

    private openImageDialog(): void {
      const dialog = new Gtk.FileDialog({ title: 'Open image', modal: true });

      const filter = new Gtk.FileFilter({ name: 'Images' });
      filter.add_mime_type('image/png');
      filter.add_mime_type('image/jpeg');
      filter.add_mime_type('image/webp');
      filter.add_mime_type('image/gif');
      filter.add_mime_type('image/bmp');
      filter.add_mime_type('image/tiff');
      const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
      filters.append(filter);
      dialog.set_filters(filters);
      dialog.set_default_filter(filter);

      dialog.open(this, null, (_src: any, result: any) => {
        try {
          const file = dialog.open_finish(result);
          if (file) this.loadFile(file);
        } catch (e: any) {
          // Cancellation surfaces as a Gtk DialogError; ignore those and log the rest.
          if (!(e instanceof Gtk.DialogError) && !`${e}`.includes('Dismissed')) {
            logError(e, 'open_finish failed');
          }
        }
      });
    }

    private loadFile(file: any): void {
      try {
        this.setImage(loadFromFile(file));
      } catch (e) {
        logError(e, 'loadFile failed');
      }
    }

    private setImage(surface: any): void {
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
      dropTarget.connect('drop', (_target: any, file: any) => {
        if (!file) return false;
        this.loadFile(file);
        return true;
      });
      (this as any).add_controller(dropTarget);
    }

    private installShortcuts(): void {
      const controller = new Gtk.ShortcutController();
      this.bindShortcut(controller, '<Control>v', () => this.pasteFromClipboard());
      this.bindShortcut(controller, '<Control>z', () => this.canvas.undo());
      this.bindShortcut(controller, '<Control><Shift>z', () => this.canvas.redo());
      this.bindShortcut(controller, '<Control>y', () => this.canvas.redo());
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
      (this as any).add_controller(controller);
    }

    private buildToolBar(): any {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 0,
        css_classes: ['linked'],
      });
      let group: any = null;
      for (const tool of TOOLS) {
        const btn = new Gtk.ToggleButton({
          label: tool.label,
          tooltip_text: `${tool.label} (${tool.accelerator.toUpperCase()})`,
          active: tool.id === this.canvas.getTool(),
        });
        if (group) btn.set_group(group); else group = btn;
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

    private buildResizeToolbar(): any {
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.START,
        margin_top: 12,
        visible: false,
        css_classes: ['toolbar', 'osd'],
      });
      const cancelBtn = new Gtk.Button({ label: 'Cancel' });
      cancelBtn.connect('clicked', () => this.exitResizeMode(false));
      const applyBtn = new Gtk.Button({ label: 'Apply', css_classes: ['suggested-action'] });
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

    private bindShortcut(controller: any, accelerator: string, callback: () => boolean | void): void {
      const trigger = Gtk.ShortcutTrigger.parse_string(accelerator);
      const action = Gtk.CallbackAction.new(() => {
        // Returning false from the callback means "not handled" — lets the
        // event keep propagating to other controllers (e.g. an editor's
        // built-in shortcuts). Any non-false return value handles the event.
        const result = callback();
        return result !== false;
      });
      controller.add_shortcut(new Gtk.Shortcut({ trigger, action }));
    }

    private saveImageDialog(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();

      const dialog = new Gtk.FileDialog({ title: 'Save image', modal: true });
      dialog.set_initial_name(defaultSaveFilename());
      dialog.set_initial_folder(Gio.File.new_for_path(defaultSaveFolderPath()));

      // Single combined filter — extension in the filename decides the format.
      // Two separate filters would mislead the user: Gtk.FileDialog doesn't
      // report which one was active, so a dropdown pick can't drive format.
      const filter = new Gtk.FileFilter({ name: 'Image (PNG, JPEG)' });
      for (const key of Object.keys(FORMATS) as ImageFormat[]) {
        const f = FORMATS[key];
        filter.add_mime_type(f.mime);
        for (const p of f.patterns) filter.add_pattern(p);
      }
      const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
      filters.append(filter);
      dialog.set_filters(filters);
      dialog.set_default_filter(filter);

      dialog.save(this, null, (_src: any, result: any) => {
        let file: any;
        try {
          file = dialog.save_finish(result);
        } catch (e: any) {
          // User cancelled or dismissed.
          if (!(e instanceof Gtk.DialogError) && !`${e}`.includes('Dismissed')) {
            logError(e, 'save_finish failed');
          }
          return;
        }
        if (!file) return;

        const surface = this.canvas.exportSnapshot();
        if (!surface) return;

        let path = file.get_path();
        const format = formatFromPath(path);
        // If the user typed a name without an extension, append the canonical
        // one for the format their filter implied (PNG by default).
        const lower = path.toLowerCase();
        const hasKnownExt = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
        if (!hasKnownExt) path = path + FORMATS[format].ext;

        try {
          saveSurface(surface, path, format);
        } catch (e) {
          logError(e, 'saveSurface failed');
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
      } catch (e) {
        logError(e, 'copySurfaceToClipboard failed');
      }
    }

    private pasteFromClipboard(): void {
      const clipboard = this.get_clipboard();
      clipboard.read_async(IMAGE_MIME_TYPES, GLib.PRIORITY_DEFAULT, null, (_src: any, result: any) => {
        let stream: any = null;
        try {
          [stream] = clipboard.read_finish(result);
        } catch {
          this.pasteUriList(clipboard);
          return;
        }
        // Decoding must be async: the local clipboard delivers bytes via a
        // pipe pumped by the main loop. A synchronous Pixbuf.new_from_stream
        // would block the loop waiting for bytes that never arrive — the
        // classic same-process clipboard deadlock.
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (_pbSrc: any, pbResult: any) => {
          try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pbResult);
            stream.close(null);
            if (pixbuf) this.setImage(loadFromPixbuf(pixbuf));
          } catch (e) {
            logError(e, 'paste (image bytes) failed');
          }
        });
      });
    }

    private pasteUriList(clipboard: any): void {
      const mimes: string[] = clipboard.get_formats()?.get_mime_types() ?? [];
      if (!mimes.includes('text/uri-list')) {
        log(`paste: nothing usable on clipboard (formats: ${mimes.join(', ') || 'none'})`);
        return;
      }
      clipboard.read_async(['text/uri-list'], GLib.PRIORITY_DEFAULT, null, (_src: any, result: any) => {
        try {
          const [stream] = clipboard.read_finish(result);
          const bytes = stream.read_bytes(64 * 1024, null);
          stream.close(null);
          const text = new TextDecoder().decode(bytes.toArray());
          const uri = text.split(/\r?\n/).find(line => line && !line.startsWith('#'))?.trim();
          if (uri) this.loadFile(Gio.File.new_for_uri(uri));
        } catch (e) {
          logError(e, 'paste (uri-list) failed');
        }
      });
    }
  },
);
