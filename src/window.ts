import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import { CanvasView } from './canvas_view.js';
import { loadFromFile, loadFromStream } from './image_loader.js';

const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
];

export const AnnoscrWindow = GObject.registerClass(
  class AnnoscrWindow extends Adw.ApplicationWindow {
    private canvas: any;
    private stack: any;

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

      this.canvas = new CanvasView();

      const empty = new Adw.StatusPage({
        icon_name: 'image-x-generic-symbolic',
        title: 'Annoscr',
        description: 'Open an image, paste from the clipboard, or drop a file here.',
      });

      this.stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
      });
      this.stack.add_named(empty, 'empty');
      this.stack.add_named(this.canvas, 'canvas');
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
      this.canvas.setImage(surface);
      this.stack.set_visible_child_name('canvas');
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
      (this as any).add_controller(controller);
    }

    private bindShortcut(controller: any, accelerator: string, callback: () => void): void {
      const trigger = Gtk.ShortcutTrigger.parse_string(accelerator);
      const action = Gtk.CallbackAction.new(() => { callback(); return true; });
      controller.add_shortcut(new Gtk.Shortcut({ trigger, action }));
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
        try {
          this.setImage(loadFromStream(stream));
        } catch (e) {
          logError(e, 'paste (image bytes) failed');
        }
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
