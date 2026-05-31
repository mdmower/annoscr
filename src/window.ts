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
import {takeScreenshot} from './screenshot.js';
import {ColorRGBA, TEXT_STYLE, defaultColorForTool, makeTextAction} from './actions.js';
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
import {getSettings, updateSettings} from './settings.js';
import {presentPreferences} from './preferences.js';
import {presentShortcuts} from './shortcuts_dialog.js';
import {confirmDiscard, showAbout, showNewCanvasDialog} from './dialogs.js';
import {StyleBar} from './style_bar.js';
import {ZoomController} from './zoom_controller.js';
import {ToolBar} from './tool_bar.js';
import {IMAGE_MIME_TYPES, TOOLS, installWindowCss} from './window_constants.js';
import {_} from './i18n.js';

export const AnnoscrWindow = GObject.registerClass(
  {GTypeName: 'AnnoscrWindow'},
  class extends Adw.ApplicationWindow {
    private canvas: InstanceType<typeof CanvasView>;
    private stack: Gtk.Stack;
    private editor: InstanceType<typeof TextEditor>;
    // Set true just before we explicitly call close() after the user has
    // chosen Discard, so the close-request handler doesn't re-prompt.
    private skipCloseConfirm: boolean = false;
    private saveButton: Gtk.Button;
    private copyButton: Gtk.Button;
    // Constructed in the constructor; owns the top style-picker bar.
    private styleBar!: StyleBar;
    // Constructed in the constructor; owns the scrolled view + bottom zoom bar.
    private zoom!: ZoomController;
    // Constructed in the constructor; owns the tool selector + resize toolbar.
    private toolbar!: ToolBar;
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
        tooltip_text: _('New blank canvas… (Ctrl+N)'),
      });
      newButton.connect('clicked', () => this.newBlankCanvas());
      header.pack_start(newButton);

      const openButton = new Gtk.Button({
        icon_name: 'document-open-symbolic',
        tooltip_text: _('Open image… (Ctrl+O)'),
      });
      openButton.connect('clicked', () => this.openImageDialog());
      header.pack_start(openButton);

      const captureButton = new Gtk.Button({
        icon_name: 'camera-photo-symbolic',
        tooltip_text: _('Take screenshot… (Ctrl+Shift+S)'),
      });
      captureButton.connect('clicked', () => this.captureScreenshot());
      header.pack_start(captureButton);

      this.saveButton = new Gtk.Button({
        icon_name: 'document-save-symbolic',
        tooltip_text: _('Save image… (Ctrl+S)'),
        sensitive: false,
      });
      this.saveButton.connect('clicked', () => this.saveImageDialog());
      header.pack_start(this.saveButton);

      this.copyButton = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        tooltip_text: _('Copy image to clipboard (Ctrl+C)'),
        sensitive: false,
      });
      this.copyButton.connect('clicked', () => this.copyImageToClipboard());
      header.pack_start(this.copyButton);

      // Primary menu — packed first so it lands at the right edge, next to the
      // window controls (the standard GNOME spot).
      const menu = new Gio.Menu();
      menu.append(_('Preferences'), 'win.preferences');
      menu.append(_('Keyboard shortcuts'), 'win.shortcuts');
      menu.append(_('About Annoscr'), 'win.about');
      menu.append(_('Quit'), 'win.quit');
      const menuButton = new Gtk.MenuButton({
        icon_name: 'open-menu-symbolic',
        tooltip_text: _('Main menu'),
        menu_model: menu,
        primary: true,
      });
      header.pack_end(menuButton);

      // pack_end stacks right-to-left in source order, so to land the buttons
      // as [Rotate Left][Rotate Right][Resize] left-to-right we add Resize first.
      const resizeButton = new Gtk.Button({
        icon_name: 'view-fullscreen-symbolic',
        tooltip_text: _('Resize canvas…'),
      });
      resizeButton.connect('clicked', () => this.toolbar.toggleResizeMode());
      header.pack_end(resizeButton);

      const rotateRightBtn = new Gtk.Button({
        icon_name: 'object-rotate-right-symbolic',
        tooltip_text: _('Rotate right (90°)'),
      });
      rotateRightBtn.connect('clicked', () => {
        this.editor.commitIfActive();
        this.canvas.rotate('cw');
      });
      header.pack_end(rotateRightBtn);

      const rotateLeftBtn = new Gtk.Button({
        icon_name: 'object-rotate-left-symbolic',
        tooltip_text: _('Rotate left (90°)'),
      });
      rotateLeftBtn.connect('clicked', () => {
        this.editor.commitIfActive();
        this.canvas.rotate('ccw');
      });
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
          this.styleBar.refresh();
        },
        onDelete: (replaceIndex: number) => {
          // Re-edit cleared to empty + confirmed → drop the action (undoable).
          this.canvas.removeAction(replaceIndex);
          this.styleBar.refresh();
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
          this.styleBar.refresh();
        }
      );

      const contentOverlay = new Gtk.Overlay();
      contentOverlay.set_child(this.canvas);
      contentOverlay.add_overlay(this.editor.getWidget());

      this.zoom = new ZoomController(this.canvas, this.editor, contentOverlay);
      this.toolbar = new ToolBar(this.canvas, this.editor);

      const viewOverlay = new Gtk.Overlay();
      viewOverlay.set_child(this.zoom.getScrolled());
      viewOverlay.add_overlay(this.toolbar.getResizeToolbar());

      header.set_title_widget(this.toolbar.getWidget());

      const empty = new Adw.StatusPage({
        icon_name: 'image-x-generic-symbolic',
        // title is the brand name; left untranslated.
        title: 'Annoscr',
        description: _(
          'Create a blank canvas, open an image, paste from the clipboard, or drop a file here.'
        ),
      });

      this.stack = new Gtk.Stack({
        transition_type: Gtk.StackTransitionType.CROSSFADE,
      });
      this.stack.add_named(empty, 'empty');
      this.stack.add_named(viewOverlay, 'canvas');
      this.stack.set_visible_child_name('empty');

      this.styleBar = new StyleBar(this.canvas, this.editor);

      const toolbar = new Adw.ToolbarView();
      toolbar.add_top_bar(header);
      toolbar.add_top_bar(this.styleBar.getWidget());
      toolbar.set_content(this.stack);
      toolbar.add_bottom_bar(this.zoom.getStatusBar());
      this.toastOverlay = new Adw.ToastOverlay({child: toolbar});
      this.set_content(this.toastOverlay);

      this.canvas.setStateChangeHandler(() => {
        this.zoom.refresh();
        this.styleBar.refresh();
      });
      this.canvas.connect('resize', () => {
        this.zoom.refresh();
        this.zoom.applyPendingScroll();
      });
      this.restoreToolStyles();
      this.zoom.refresh();
      this.styleBar.refresh();

      this.installActions(app);
      this.installDropTarget();
      this.installShortcuts();
      this.installCloseGuard();
    }

    // Restore per-tool styles saved in a previous session, if the user opted in.
    private restoreToolStyles(): void {
      const s = getSettings();
      if (s.rememberToolStyles && s.toolStyles) this.canvas.importToolStyles(s.toolStyles);
    }

    // Persist per-tool styles on the way out, if the user opted in. Called from
    // the close guard, the choke point every quit path passes through.
    private flushSettings(): void {
      if (getSettings().rememberToolStyles) {
        updateSettings({toolStyles: this.canvas.exportToolStyles()});
      }
    }

    private installActions(app: InstanceType<typeof AnnoscrApplication>): void {
      const add = (name: string, cb: () => void): void => {
        const action = new Gio.SimpleAction({name});
        action.connect('activate', () => cb());
        this.add_action(action);
      };
      add('preferences', () => presentPreferences(this));
      add('shortcuts', () => presentShortcuts(this));
      add('about', () => showAbout(this));
      add('quit', () => this.close());
      app.set_accels_for_action('win.preferences', ['<Control>comma']);
      app.set_accels_for_action('win.shortcuts', ['<Control>question']);
      app.set_accels_for_action('win.quit', ['<Control>q']);
    }

    private installCloseGuard(): void {
      this.connect('close-request', () => {
        // Returning false lets the close proceed — flush prefs at those points.
        if (this.skipCloseConfirm || !this.canvas.isDirty()) {
          this.flushSettings();
          return false;
        }
        confirmDiscard(this, _('Closing the window'), this.canvas.isDirty(), () => {
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

    private showToast(title: string): void {
      this.toastOverlay.add_toast(new Adw.Toast({title}));
    }

    // Show a destructive-action confirmation if the canvas has unsaved
    // annotations. `onProceed` runs only when the user explicitly discards,
    // or immediately if the canvas is already clean.

    private openImageDialog(): void {
      confirmDiscard(this, _('Opening a new image'), this.canvas.isDirty(), () =>
        this.openImageDialogUnchecked()
      );
    }

    private openImageDialogUnchecked(): void {
      const dialog = new Gtk.FileDialog({title: _('Open image'), modal: true});

      const filter = new Gtk.FileFilter({name: _('Images')});
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
      // Guards an unsaved canvas before replacing it. Harmless at cold startup
      // (confirmDiscard proceeds immediately when nothing is dirty); the guard
      // matters now that `--new` can reach an already-running instance.
      confirmDiscard(this, _('Creating a blank canvas'), this.canvas.isDirty(), () =>
        this.setImage(createBlankSurface(w, h, [1, 1, 1, 1]))
      );
    }

    private newBlankCanvas(): void {
      confirmDiscard(this, _('Creating a blank canvas'), this.canvas.isDirty(), () =>
        showNewCanvasDialog(this, (surface) => this.setImage(surface))
      );
    }

    // Entry point for files handed in from outside (file manager "Open With",
    // command-line argument). Guards an unsaved canvas before replacing it.
    openFileChecked(file: Gio.File): void {
      confirmDiscard(this, _('Opening this image'), this.canvas.isDirty(), () =>
        this.openFile(file)
      );
    }

    captureScreenshot(): void {
      // Unmap the window first so Annoscr isn't in the shot when the user picks
      // a screen or full-screen region. The short delay gives the compositor
      // time to actually hide it before the portal's capture UI appears.
      this.set_visible(false);
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        takeScreenshot()
          .then((uri) => {
            this.set_visible(true);
            this.present();
            if (uri) {
              confirmDiscard(this, _('Opening the screenshot'), this.canvas.isDirty(), () =>
                this.openFile(Gio.File.new_for_uri(uri))
              );
            }
          })
          .catch(() => {
            this.set_visible(true);
            this.present();
            this.showToast(_('Screenshot cancelled'));
          });
        return GLib.SOURCE_REMOVE;
      });
    }

    openFile(file: Gio.File): void {
      try {
        this.setImage(loadFromFile(file));
      } catch (e) {
        // Covers both load/decode failures and I/O errors (missing file,
        // permission denied), so the message stays general rather than always
        // blaming the file format.
        console.error('openFile failed', e);
        const name = file.get_basename() ?? file.get_uri();
        this.showToast(_('Could not open "%s"').replace('%s', name));
      }
    }

    private setImage(surface: Cairo.ImageSurface): void {
      // Discard any in-progress text edit or resize — they belonged to the old image.
      this.editor.cancel();
      if (this.canvas.getTool() === 'resize') this.toolbar.exitResizeMode(false);
      this.canvas.setImage(surface);
      this.stack.set_visible_child_name('canvas');
      this.saveButton.set_sensitive(true);
      this.copyButton.set_sensitive(true);
    }

    private installDropTarget(): void {
      const dropTarget = Gtk.DropTarget.new(Gio.File.$gtype, Gdk.DragAction.COPY);
      dropTarget.connect('drop', (_target: unknown, file: Gio.File) => {
        if (!file) return false;
        confirmDiscard(this, _('Opening the dropped image'), this.canvas.isDirty(), () =>
          this.openFile(file)
        );
        return true;
      });
      this.add_controller(dropTarget);
    }

    private installShortcuts(): void {
      const controller = new Gtk.ShortcutController();
      this.bindShortcut(controller, '<Control>n', () => this.newBlankCanvas());
      this.bindShortcut(controller, '<Control>o', () => this.openImageDialog());
      this.bindShortcut(controller, '<Control><Shift>s', () => this.captureScreenshot());
      this.bindShortcut(controller, '<Control>v', () => this.pasteFromClipboard());
      // Undo/redo are disabled while resize mode is active: a pending region
      // is transient state that hasn't been committed, and rolling history
      // out from under it would be confusing (the resize would silently
      // target whatever surface the undo landed on).
      //
      // They're also gated while the text editor is open: the focused TextView
      // consumes Ctrl+Z for its own buffer undo, but once that stack is empty
      // the event bubbles here and would roll back canvas history mid-edit.
      // isActive() short-circuits that so canvas history only moves when no
      // edit is in progress.
      const editingOrResizing = (): boolean =>
        this.editor.isActive() || this.canvas.getTool() === 'resize';
      this.bindShortcut(controller, '<Control>z', () => {
        if (editingOrResizing()) return;
        this.canvas.undo();
      });
      this.bindShortcut(controller, '<Control><Shift>z', () => {
        if (editingOrResizing()) return;
        this.canvas.redo();
      });
      this.bindShortcut(controller, '<Control>y', () => {
        if (editingOrResizing()) return;
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
      this.bindShortcut(controller, '<Control>0', () => {
        if (this.canvas.hasImage()) this.zoom.setFit();
      });
      this.bindShortcut(controller, '<Control>1', () => {
        if (this.canvas.hasImage()) this.zoom.zoomToCenter(1);
      });
      const zoomIn = (): void => {
        if (this.canvas.hasImage()) this.zoom.zoomStepDetent(1);
      };
      const zoomOut = (): void => {
        if (this.canvas.hasImage()) this.zoom.zoomStepDetent(-1);
      };
      this.bindShortcut(controller, '<Control>plus', zoomIn);
      this.bindShortcut(controller, '<Control>equal', zoomIn);
      this.bindShortcut(controller, '<Control>KP_Add', zoomIn);
      this.bindShortcut(controller, '<Control>minus', zoomOut);
      this.bindShortcut(controller, '<Control>KP_Subtract', zoomOut);
      this.bindShortcut(controller, 'Delete', () => this.canvas.deleteSelected());
      this.bindShortcut(controller, 'BackSpace', () => this.canvas.deleteSelected());
      // Duplicate the selection. Guarded so the chord falls through when nothing
      // is selected (or the editor is open) rather than swallowing the event.
      this.bindShortcut(controller, '<Control>d', () => {
        if (this.editor.isActive()) return false;
        return this.canvas.cloneSelected();
      });
      // Start a new stamp group: with the number tool, bump the placement group
      // so the next stamp restarts at 1; with the select tool, move the selected
      // stamps into a fresh group. Falls through otherwise.
      this.bindShortcut(controller, '<Control>g', () => {
        if (this.editor.isActive()) return false;
        const tool = this.canvas.getTool();
        if (tool === 'number') {
          this.canvas.newPlacementGroup();
          return true;
        }
        if (tool === 'select') return this.canvas.reassignSelectedGroup('new');
        return false;
      });
      // Shift+Space toggles the aimed item in/out of the selection — the
      // keyboard twin of Shift+Click. Shift avoids bare Space activating a
      // focused tool button; the editor captures it while typing.
      this.bindShortcut(controller, '<Shift>space', () => this.canvas.toggleHoverCandidate());
      // Enter and Escape only do anything when resize mode is active. The text
      // editor consumes these in its CAPTURE-phase controller before they
      // reach here, so we never conflict during editing.
      this.bindShortcut(controller, 'Return', () => {
        if (this.canvas.getTool() === 'resize') this.toolbar.exitResizeMode(true);
      });
      this.bindShortcut(controller, 'Escape', () => {
        if (this.canvas.getTool() === 'resize') {
          this.toolbar.exitResizeMode(false);
          return true;
        }
        // Deselect when the select tool has something picked. Returning false
        // when nothing is selected lets the event bubble (e.g. to a dialog).
        if (this.canvas.getTool() === 'select') return this.canvas.clearSelection();
        return false;
      });
      for (const tool of TOOLS) {
        this.bindShortcut(controller, tool.accelerator, () => this.toolbar.selectTool(tool.id));
      }
      this.add_controller(controller);
      this.installDigKeys();
    }

    // [ and ] dig the select-tool hover candidate up/down through overlapping
    // items (the precise, one-step alternative to Alt+scroll). Handled with a
    // key controller rather than ShortcutController accelerators so they fire
    // regardless of held Shift/Alt — a convenience mid-gesture (e.g. while
    // holding Shift to toggle). That also means matching the shifted keyvals
    // brace{left,right}, since Shift+[ delivers braceleft, not bracketleft.
    // Ctrl is excluded to leave room for Ctrl-chords. digHoverCandidate returns
    // false unless it actually dug, so a stray bracket still falls through (and
    // the focused text editor consumes them while typing).
    private installDigKeys(): void {
      const keys = new Gtk.EventControllerKey();
      keys.connect('key-pressed', (_c, keyval, _keycode, state) => {
        if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0) return false;
        if (keyval === Gdk.KEY_bracketleft || keyval === Gdk.KEY_braceleft) {
          return this.canvas.digHoverCandidate(-1);
        }
        if (keyval === Gdk.KEY_bracketright || keyval === Gdk.KEY_braceright) {
          return this.canvas.digHoverCandidate(1);
        }
        return false;
      });
      this.add_controller(keys);
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

      const settings = getSettings();
      const dialog = new Gtk.FileDialog({title: _('Save image'), modal: true});
      dialog.set_initial_name(defaultSaveFilename(settings.defaultSaveFormat));
      dialog.set_initial_folder(
        Gio.File.new_for_path(settings.defaultSaveFolder || defaultSaveFolderPath())
      );

      // Single combined filter — extension in the filename decides the format.
      // Two separate filters would mislead the user: Gtk.FileDialog doesn't
      // report which one was active, so a dropdown pick can't drive format.
      const filter = new Gtk.FileFilter({name: _('Image (PNG, JPEG)')});
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

        // If the user typed a name without an extension, fall back to the
        // configured default format and append its canonical extension;
        // otherwise the typed extension drives the format.
        const lower = path.toLowerCase();
        const hasKnownExt =
          lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
        const format = hasKnownExt ? formatFromPath(path) : settings.defaultSaveFormat;
        if (!hasKnownExt) path = path + FORMATS[format].ext;

        try {
          saveSurface(surface, path, format);
          this.canvas.markClean();
        } catch (e) {
          console.error('saveSurface failed', e);
          this.showToast(_('Could not save image'));
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
        console.error('copySurfaceToClipboard failed', e);
        this.showToast(_('Could not copy image'));
      }
    }

    private pasteFromClipboard(): void {
      confirmDiscard(this, _('Pasting a new image'), this.canvas.isDirty(), () =>
        this.pasteFromClipboardUnchecked()
      );
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
            if (pixbuf) this.setImage(loadFromPixbuf(pixbuf));
          } catch (e) {
            console.error('paste (image bytes) failed', e);
            this.showToast(_('Could not paste image'));
          } finally {
            stream.close(null);
          }
        });
      });
    }

    private pasteUriList(clipboard: Gdk.Clipboard): void {
      const mimes: string[] = clipboard.get_formats()?.get_mime_types() ?? [];
      if (!mimes.includes('text/uri-list')) {
        console.log(`paste: nothing usable on clipboard (formats: ${mimes.join(', ') || 'none'})`);
        this.showToast(_('Clipboard has no image to paste'));
        return;
      }
      clipboard.read_async(['text/uri-list'], GLib.PRIORITY_DEFAULT, null, (_src, result) => {
        let stream: Gio.InputStream | null = null;
        try {
          [stream] = clipboard.read_finish(result);
          if (!stream) throw new Error('clipboard read failed');
          const bytes = stream.read_bytes(64 * 1024, null);
          const text = new TextDecoder().decode(bytes.toArray());
          const uri = text
            .split(/\r?\n/)
            .find((line) => line && !line.startsWith('#'))
            ?.trim();
          // openFile reports its own failures; only the empty-list case needs
          // a toast here.
          if (uri) this.openFile(Gio.File.new_for_uri(uri));
          else this.showToast('Clipboard has no image to paste');
        } catch (e) {
          console.error('paste (uri-list) failed', e);
          this.showToast('Could not paste image');
        } finally {
          stream?.close(null);
        }
      });
    }
  }
);
