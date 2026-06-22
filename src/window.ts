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
import {Action, ColorRGBA, TEXT_STYLE, makeTextAction, withShapeText} from './actions.js';
import {TextEditor, TextEditorBeginOptions, TextEditorStyle} from './text_editor.js';
import type {TextEditRequestOptions} from './canvas_view.js';
import {
  FORMATS,
  ImageFormat,
  copySurfaceToClipboard,
  defaultSaveFilename,
  defaultSaveFolderPath,
  formatFromPath,
  saveSurface,
  surfaceThumbnailPngBytes,
} from './exporter.js';
import {
  DOC_EXTENSION,
  DOC_PATTERN,
  defaultDocFilename,
  parseDocument,
  serializeDocument,
} from './document.js';
import {AnnoscrSettings, getSettings, undoMemoryBytes, updateSettings} from './settings.js';
import {presentPreferences} from './preferences.js';
import {presentShortcuts} from './shortcuts_dialog.js';
import {confirmDiscard, showAbout, showNewCanvasDialog} from './dialogs.js';
import {StyleBar} from './style_bar.js';
import {setChosenFonts} from './font_catalogue.js';
import {ZoomController} from './zoom_controller.js';
import {ToolBar} from './tool_bar.js';
import {IMAGE_MIME_TYPES, TOOLS, installWindowCss} from './window_constants.js';
import {labelFromTooltip} from './a11y.js';
import {_} from './i18n.js';

// After an autoclose export we close the window but keep the process alive this
// long, so the just-sent notification's async D-Bus delivery flushes before the
// app exits. The window is already gone, so the app looks closed meanwhile.
const NOTIFY_GRACE_MS = 1000;

// How long a cold-relaunch paste waits for the clipboard to advertise content
// (the Wayland selection offer arrives only once our window is focused) before
// giving up silently.
const CLIPBOARD_READY_TIMEOUT_MS = 3000;

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

    // Path of the annotation file currently being edited (set on open or save of
    // a .annoscr), so a re-save offers the same name/folder. Cleared whenever a
    // plain image replaces the canvas (open/blank/paste/drop/screenshot), since
    // that's no longer "this document".
    private currentDocPath: string | null = null;
    // Constructed in the constructor; owns the top style-picker bar.
    private styleBar!: StyleBar;
    // Constructed in the constructor; owns the scrolled view + bottom zoom bar.
    private zoom!: ZoomController;
    // Constructed in the constructor; owns the tool selector + resize toolbar.
    private toolbar!: ToolBar;
    private toastOverlay!: Adw.ToastOverlay;

    constructor(app: InstanceType<typeof AnnoscrApplication>) {
      const settings = getSettings();
      super({
        application: app,
        title: 'Annoscr',
        default_width: Math.round(settings.windowWidth),
        default_height: Math.round(settings.windowHeight),
      });
      if (settings.windowMaximized) this.maximize();

      installWindowCss();

      const header = new Adw.HeaderBar();

      const newButton = new Gtk.Button({
        icon_name: 'document-new-symbolic',
        tooltip_text: _('New blank canvas… (Ctrl+N)'),
      });
      newButton.connect('clicked', () => this.newBlankCanvas());
      labelFromTooltip(newButton);
      header.pack_start(newButton);

      const openButton = new Gtk.Button({
        icon_name: 'document-open-symbolic',
        tooltip_text: _('Open image… (Ctrl+O)'),
      });
      openButton.connect('clicked', () => this.openImageDialog());
      labelFromTooltip(openButton);
      header.pack_start(openButton);

      const captureButton = new Gtk.Button({
        icon_name: 'camera-photo-symbolic',
        tooltip_text: _('Take screenshot… (Ctrl+Shift+S)'),
      });
      captureButton.connect('clicked', () => this.captureScreenshot());
      labelFromTooltip(captureButton);
      header.pack_start(captureButton);

      this.saveButton = new Gtk.Button({
        icon_name: 'document-save-symbolic',
        tooltip_text: _('Save image (Ctrl+S)'),
        sensitive: false,
      });
      this.saveButton.connect('clicked', () => this.saveImage());
      labelFromTooltip(this.saveButton);
      header.pack_start(this.saveButton);

      this.copyButton = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        tooltip_text: _('Copy image to clipboard (Ctrl+C)'),
        sensitive: false,
      });
      this.copyButton.connect('clicked', () => this.copyImageToClipboard());
      labelFromTooltip(this.copyButton);
      header.pack_start(this.copyButton);

      // Primary menu — packed first so it lands at the right edge, next to the
      // window controls (the standard GNOME spot).
      const menu = new Gio.Menu();
      // Always-dialog image export — the escape hatch for picking a one-off
      // location when "save without choosing a location" makes the header Save
      // button (and Ctrl+S) write silently to the default folder.
      const imageSection = new Gio.Menu();
      imageSection.append(_('Save image as…'), 'win.saveas');
      menu.append_section(null, imageSection);
      // Annotation-file open/save: a reopenable document (image + editable
      // actions), distinct from the prominent PNG/JPEG export on the header bar.
      const fileSection = new Gio.Menu();
      fileSection.append(_('Open annotation file…'), 'win.opendoc');
      fileSection.append(_('Save annotation file…'), 'win.savedoc');
      menu.append_section(null, fileSection);
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
      labelFromTooltip(menuButton);
      header.pack_end(menuButton);

      // pack_end stacks right-to-left in source order, so to land the buttons
      // as [Rotate Left][Rotate Right][Resize] left-to-right we add Resize first.
      const resizeButton = new Gtk.Button({
        icon_name: 'view-fullscreen-symbolic',
        tooltip_text: _('Resize canvas… (Ctrl+E)'),
      });
      resizeButton.connect('clicked', () => this.toolbar.toggleResizeMode());
      labelFromTooltip(resizeButton);
      header.pack_end(resizeButton);

      const rotateRightBtn = new Gtk.Button({
        icon_name: 'object-rotate-right-symbolic',
        tooltip_text: _('Rotate right 90° (Ctrl+R)'),
      });
      rotateRightBtn.connect('clicked', () => this.rotateImage('cw'));
      labelFromTooltip(rotateRightBtn);
      header.pack_end(rotateRightBtn);

      const rotateLeftBtn = new Gtk.Button({
        icon_name: 'object-rotate-left-symbolic',
        tooltip_text: _('Rotate left 90° (Ctrl+Shift+R)'),
      });
      rotateLeftBtn.connect('clicked', () => this.rotateImage('ccw'));
      labelFromTooltip(rotateLeftBtn);
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
          replaceIndex?: number,
          selectAfter?: boolean,
          editTarget?
        ) => {
          // Shape text: write the (possibly empty) markup + style onto the box
          // shape at the target index, keeping the shape selected so it stays in
          // hand. Empty markup clears the text but keeps the shape.
          if (editTarget) {
            const shape = this.canvas.getActionAt(editTarget.index);
            if (shape) {
              // TextEditorStyle and the shape's TextStyle carry identical fields.
              this.canvas.replaceAction(editTarget.index, withShapeText(shape, markup, style));
              this.canvas.selectIndex(editTarget.index);
              // Remember this style as the shape tool's seed for the next shape
              // (empty markup = text cleared, so there's nothing to remember).
              if (markup) this.canvas.rememberShapeTextStyle(editTarget.index, style);
            } else {
              this.canvas.clearEditing();
            }
            return;
          }
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
            style.bg,
            editorSize
          );
          if (replaceIndex !== undefined) {
            this.canvas.replaceAction(replaceIndex, action);
            // An Enter commit of a re-edit leaves the annotation selected so
            // it's immediately movable/resizable/re-editable; click-away and
            // other incidental commits pass false and leave it unselected.
            if (selectAfter) this.canvas.selectIndex(replaceIndex);
          } else {
            this.canvas.addAction(action);
          }
        },
        onCancel: () => {
          // Always restore the hidden action (un-hides a re-edited text or a
          // shape whose text was being edited; harmless for a fresh placement).
          this.canvas.clearEditing();
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
        (ix: number, iy: number, wx: number, wy: number, options?: TextEditRequestOptions) => {
          // Click on canvas with text tool active (or double-click with select tool):
          // commit any prior edit, then begin a new one. Pass-through options
          // carry markup + (replaceIndex | shapeIndex) for re-edit.
          const wasActive = this.editor.isActive();
          this.editor.commitIfActive();
          // Shape text: the canvas supplies the box geometry + the shape's text
          // style. Route the editor into box mode targeting that shape.
          if (options?.shapeIndex !== undefined && options.textStyle && options.boxMode) {
            const begin: TextEditorBeginOptions = {
              markup: options.markup,
              // The shape's TextStyle has the same fields as TextEditorStyle.
              style: options.textStyle,
              editTarget: {kind: 'shape', index: options.shapeIndex},
              boxMode: options.boxMode,
            };
            this.editor.beginAt(ix, iy, wx, wy, begin);
            this.styleBar.refresh();
            return;
          }
          // With select-after-placement on, committing a fresh text just
          // switched us to the select tool with that text selected (one
          // placement = one selection), so this click already "finished" the
          // text — don't also reopen a new editor at it. Re-edits
          // (replaceIndex) and the first open of a chain (nothing was active)
          // still proceed. getTool()==='select' is the precise signal that the
          // commit triggered the switch.
          if (
            wasActive &&
            options?.replaceIndex === undefined &&
            this.canvas.getTool() === 'select'
          ) {
            this.styleBar.refresh();
            return;
          }
          // Editor preview uses the same color/font the commit will use, so
          // placement and sizing reflect the final TextAction. Standalone text
          // is always left-aligned (its align control is hidden).
          const color = this.textColorFor(options?.replaceIndex);
          const fontDesc = this.textFontDescFor(options?.replaceIndex);
          const fontSize = this.textFontSizeFor(options?.replaceIndex);
          const bg = this.textBgFor(options?.replaceIndex);
          const style: TextEditorStyle = {color, fontDesc, size: fontSize, bg, align: 'left'};
          this.editor.beginAt(ix, iy, wx, wy, {
            markup: options?.markup,
            replaceIndex: options?.replaceIndex,
            rotation: options?.rotation,
            editorSize: options?.editorSize,
            style,
            scale: options?.scale,
          });
          // Picker now reflects the editor's style (color + font of the
          // in-progress edit), so refresh to point dropdown + buttons at it.
          this.styleBar.refresh();
        }
      );
      // A canvas press outside the editor while re-editing finishes the edit.
      // The editor's own callbacks (onCommit/onDelete) refresh the style bar.
      this.canvas.setCommitRequestHandler(() => this.editor.commitIfActive());

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
      this.canvas.setPlacementHandler((index) => {
        if (!getSettings().selectAfterPlacement) return;
        // Switch via the toolbar so the tool palette's toggle buttons stay in
        // sync, then select the just-placed action so it's immediately
        // editable/resizable/rotatable.
        this.toolbar.selectTool('select');
        this.canvas.selectIndex(index);
      });
      this.canvas.connect('resize', () => {
        this.zoom.refresh();
        this.zoom.applyPendingScroll();
      });
      this.restoreToolStyles();
      this.applyUndoMemory();
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

    // Push the undo-memory preference into the canvas as a byte budget.
    // Applied at startup and again whenever the preference changes.
    private applyUndoMemory(): void {
      this.canvas.setUndoMemoryBudget(undoMemoryBytes(getSettings().undoMemory));
    }

    // Persist per-tool styles on the way out, if the user opted in. Called from
    // the close guard, the choke point every quit path passes through.
    private flushSettings(): void {
      const partial: Partial<AnnoscrSettings> = {};
      if (getSettings().rememberToolStyles) {
        partial.toolStyles = this.canvas.exportToolStyles();
      }
      // get_default_size tracks the current size while unmaximized and retains
      // the last unmaximized size while maximized, so we persist both freely.
      const [w, h] = this.get_default_size();
      if (w > 0 && h > 0) {
        partial.windowWidth = w;
        partial.windowHeight = h;
      }
      partial.windowMaximized = this.maximized;
      updateSettings(partial);
    }

    private installActions(app: InstanceType<typeof AnnoscrApplication>): void {
      const add = (name: string, cb: () => void): void => {
        const action = new Gio.SimpleAction({name});
        action.connect('activate', () => cb());
        this.add_action(action);
      };
      add('preferences', () =>
        presentPreferences(this, {
          onFontsChanged: () => {
            // The chosen font set changed — push it into the catalogue and
            // rebuild the dropdown.
            setChosenFonts(getSettings().fontFamilies ?? []);
            this.styleBar.rebuildFontDropdown();
          },
          onUndoMemoryChanged: () => this.applyUndoMemory(),
        })
      );
      add('shortcuts', () => presentShortcuts(this));
      add('about', () => showAbout(this));
      add('quit', () => this.close());
      add('opendoc', () => this.openDocumentDialog());
      add('savedoc', () => this.saveDocumentDialog());
      add('saveas', () => this.saveImageDialog());
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
        const c = existing?.getTextColor();
        if (c) return c;
      }
      return this.canvas.getToolTextColor('text') ?? TEXT_STYLE.color;
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

    // The text background plate (the Fill control). Re-edits keep the existing
    // action's plate; fresh text uses the tool default (transparent white).
    private textBgFor(replaceIndex: number | undefined): ColorRGBA {
      if (replaceIndex !== undefined) {
        const existing = this.canvas.getActionAt(replaceIndex);
        const b = existing?.getFill();
        if (b) return b;
      }
      return this.canvas.getToolFill('text') ?? TEXT_STYLE.bg;
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
    // command-line argument). Routes a .annoscr to the document opener and any
    // other file to the image loader, guarding an unsaved canvas first.
    openFileChecked(file: Gio.File): void {
      if (this.isDocumentFile(file)) {
        confirmDiscard(this, _('Opening this annotation file'), this.canvas.isDirty(), () =>
          this.openDocumentFile(file)
        );
      } else {
        confirmDiscard(this, _('Opening this image'), this.canvas.isDirty(), () =>
          this.openFile(file)
        );
      }
    }

    // Whether an incoming file is an annotation document, by extension — the same
    // classification the file manager and CLI rely on.
    private isDocumentFile(file: Gio.File): boolean {
      const name = file.get_basename();
      return name !== null && name.toLowerCase().endsWith(DOC_EXTENSION);
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
          .catch((e: unknown) => {
            // A user cancel and a portal failure both land here (the portal
            // reports them the same way); log the cause so a genuine failure
            // is diagnosable even though the toast reads as a cancel.
            console.error('takeScreenshot failed', e);
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
      // A plain image isn't tied to any annotation file.
      this.currentDocPath = null;
      this.canvas.setImage(surface);
      this.stack.set_visible_child_name('canvas');
      this.saveButton.set_sensitive(true);
      this.copyButton.set_sensitive(true);
    }

    // Same UI setup as setImage, but loads a saved document (surface + actions)
    // instead of a bare image.
    private setDocument(surface: Cairo.ImageSurface, actions: ReadonlyArray<Action>): void {
      this.editor.cancel();
      if (this.canvas.getTool() === 'resize') this.toolbar.exitResizeMode(false);
      this.canvas.loadDocument(surface, actions);
      this.stack.set_visible_child_name('canvas');
      this.saveButton.set_sensitive(true);
      this.copyButton.set_sensitive(true);
    }

    // Rotate the whole canvas 90°, committing any in-progress text edit first.
    // Shared by the header buttons and the Ctrl+R / Ctrl+Shift+R accelerators.
    private rotateImage(dir: 'cw' | 'ccw'): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      this.canvas.rotate(dir);
    }

    private installDropTarget(): void {
      const dropTarget = Gtk.DropTarget.new(Gio.File.$gtype, Gdk.DragAction.COPY);
      dropTarget.connect('drop', (_target: unknown, file: Gio.File) => {
        if (!file) return false;
        if (this.isDocumentFile(file)) {
          confirmDiscard(
            this,
            _('Opening the dropped annotation file'),
            this.canvas.isDirty(),
            () => this.openDocumentFile(file)
          );
        } else {
          confirmDiscard(this, _('Opening the dropped image'), this.canvas.isDirty(), () =>
            this.openFile(file)
          );
        }
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
        this.saveImage();
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
      // Whole-canvas rotate (Ctrl+R clockwise, Ctrl+Shift+R counter-clockwise)
      // and resize (Ctrl+E) — the keyboard twins of the header buttons. Gated
      // while the text editor is open so the chords stay with the focused
      // TextView mid-edit.
      this.bindShortcut(controller, '<Control>r', () => {
        if (this.editor.isActive()) return false;
        this.rotateImage('cw');
        return true;
      });
      this.bindShortcut(controller, '<Control><Shift>r', () => {
        if (this.editor.isActive()) return false;
        this.rotateImage('ccw');
        return true;
      });
      this.bindShortcut(controller, '<Control>e', () => {
        if (this.editor.isActive() || !this.canvas.hasImage()) return false;
        this.toolbar.toggleResizeMode();
        return true;
      });
      this.bindShortcut(controller, 'Delete', () => this.canvas.deleteSelected());
      this.bindShortcut(controller, 'BackSpace', () => this.canvas.deleteSelected());
      // Select all annotations (select tool only; falls through otherwise so the
      // editor keeps Ctrl+A as select-all-text).
      this.bindShortcut(controller, '<Control>a', () => {
        if (this.editor.isActive()) return false;
        return this.canvas.selectAll();
      });
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
      // Enter confirms resize mode, or — with the select tool — opens the
      // editor on a lone selected text annotation (the keyboard twin of
      // double-clicking it). Escape only acts in resize/select. The text editor
      // consumes both in its CAPTURE-phase controller before they reach here,
      // so we never conflict during editing.
      this.bindShortcut(controller, 'Return', () => {
        if (this.canvas.getTool() === 'resize') {
          this.toolbar.exitResizeMode(true);
          return true;
        }
        return this.canvas.editSelectedText();
      });
      this.bindShortcut(controller, 'Escape', () => {
        if (this.canvas.getTool() === 'resize') {
          this.toolbar.exitResizeMode(false);
          return true;
        }
        // Cancel an in-progress marquee, else deselect when the select tool has
        // something picked. Returning false when there's nothing to cancel or
        // deselect lets the event bubble (e.g. to a dialog).
        if (this.canvas.getTool() === 'select') {
          if (this.canvas.cancelBand()) return true;
          return this.canvas.clearSelection();
        }
        return false;
      });
      for (const tool of TOOLS) {
        this.bindShortcut(controller, tool.accelerator, () => this.toolbar.selectTool(tool.id));
      }
      this.add_controller(controller);
      this.installStackKeys();
    }

    // Two depth gestures on one key controller (not ShortcutController
    // accelerators, which can't be trusted for shifted punctuation — Shift+[
    // delivers braceleft, not bracketleft):
    //
    //   Aim:  , / . (and their < / > shifted twins) dig the select-tool hover
    //         candidate down/up through overlapping items — the precise,
    //         one-step alternative to Alt+scroll. Fired regardless of Shift so
    //         it works mid-gesture (e.g. while holding Shift to toggle).
    //
    //   Z-order:  Ctrl+[ / Ctrl+] lower/raise the selection one slot;
    //             Ctrl+Shift+[ / Ctrl+Shift+] send it to back / bring to front
    //             (the universal Photoshop/Illustrator/Figma convention).
    //
    // Both target methods return false when they don't act (no candidate /
    // empty selection / already at the end), so a stray key still falls
    // through. The focused text editor consumes these in its CAPTURE-phase
    // controller while typing; isActive() is a belt-and-suspenders gate.
    private installStackKeys(): void {
      const keys = new Gtk.EventControllerKey();
      keys.connect('key-pressed', (_c, keyval, _keycode, state) => {
        if (this.editor.isActive()) return false;
        if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0) {
          const toEnd = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
          // Match both the unshifted and shifted keyvals of each bracket so the
          // Ctrl+Shift chord works whether the layout reports bracket* or brace*.
          if (keyval === Gdk.KEY_bracketleft || keyval === Gdk.KEY_braceleft) {
            return this.canvas.reorderSelected(toEnd ? 'back' : 'lower');
          }
          if (keyval === Gdk.KEY_bracketright || keyval === Gdk.KEY_braceright) {
            return this.canvas.reorderSelected(toEnd ? 'front' : 'raise');
          }
          return false;
        }
        if (keyval === Gdk.KEY_comma || keyval === Gdk.KEY_less) {
          return this.canvas.digHoverCandidate(-1);
        }
        if (keyval === Gdk.KEY_period || keyval === Gdk.KEY_greater) {
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

    // The header Save button and Ctrl+S. Writes silently to the default folder
    // when the preference is set; otherwise opens the save dialog. "Save image
    // as…" always takes the dialog path.
    private saveImage(): void {
      if (!this.canvas.hasImage()) return;
      if (getSettings().saveWithoutDialog) this.saveImageSilent();
      else this.saveImageDialog();
    }

    // Dialog-free save: default folder + format, auto-generated timestamped name.
    private saveImageSilent(): void {
      this.editor.commitIfActive();
      const surface = this.canvas.exportSnapshot();
      if (!surface) return;
      const settings = getSettings();
      const format = settings.defaultSaveFormat;
      const folder = settings.defaultSaveFolder || defaultSaveFolderPath();
      const path = GLib.build_filenamev([folder, defaultSaveFilename(format)]);
      try {
        saveSurface(surface, path, format);
        this.canvas.markClean();
        this.onImageSaved(path, true, surface);
      } catch (e) {
        console.error('saveSurface failed', e);
        this.showToast(_('Could not save image'));
      }
    }

    // Shared post-save handling for both the dialog and silent paths. On
    // autoclose the window is going away, so feedback is a system notification
    // (a toast would die with the window). Clicking it reopens the saved file;
    // the "Show in Files" button is offered only for a silent save, since a
    // dialog save already let the user pick (and see) the folder.
    private onImageSaved(path: string, silent: boolean, surface: Cairo.ImageSurface): void {
      if (getSettings().closeAfterImageSave) {
        this.sendExportNotification({
          title: _('Image saved'),
          body: GLib.path_get_basename(path),
          openPath: path,
          showInFiles: silent,
          thumbnailBytes: surfaceThumbnailPngBytes(surface),
        });
        this.closeAfterExport(false);
      } else if (silent) {
        // Stayed open with no dialog shown — confirm with an in-window toast.
        this.showToast(_('Saved %s').replace('%s', GLib.path_get_basename(path)));
      }
      // Dialog save without autoclose: the file dialog itself was the feedback.
    }

    // Post-autoclose feedback. A notification is owned by the session, so it
    // outlives the closing window. The image is shown as the icon — a square
    // letterboxed thumbnail (as the screenshot portal shows one); a raw FileIcon
    // would be distorted by GNOME's square icon slot just like a copy's bytes.
    private sendExportNotification(opts: {
      title: string;
      body?: string;
      // A saved file: clicking the notification reopens it in Annoscr; with
      // showInFiles, a button also reveals it in the file manager.
      openPath?: string;
      showInFiles?: boolean;
      // A clipboard copy: clicking the notification opens the copied image.
      pasteOnClick?: boolean;
      // The square thumbnail bytes for the notification icon.
      thumbnailBytes?: GLib.Bytes;
    }): void {
      const app = this.get_application();
      if (!app) return;
      const notification = Gio.Notification.new(opts.title);
      if (opts.body) notification.set_body(opts.body);
      if (opts.thumbnailBytes) notification.set_icon(Gio.BytesIcon.new(opts.thumbnailBytes));
      if (opts.openPath) {
        notification.set_default_action_and_target(
          'app.open-file',
          GLib.Variant.new_string(opts.openPath)
        );
        if (opts.showInFiles) {
          // "Show in Files" matches the desktop portal's button wording.
          notification.add_button_with_target(
            _('Show in Files'),
            'app.show-in-files',
            GLib.Variant.new_string(opts.openPath)
          );
        }
      } else if (opts.pasteOnClick) {
        notification.set_default_action('app.paste-clipboard');
      }
      app.send_notification('annoscr-export', notification);
    }

    // Close the window after an autoclose export, holding the process briefly so
    // the notification's async delivery completes before the app exits.
    private closeAfterExport(skipConfirm: boolean): void {
      const app = this.get_application();
      if (skipConfirm) this.skipCloseConfirm = true;
      if (app) {
        app.hold();
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTIFY_GRACE_MS, () => {
          app.release();
          return GLib.SOURCE_REMOVE;
        });
      }
      this.close();
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
          this.onImageSaved(path, false, surface);
        } catch (e) {
          console.error('saveSurface failed', e);
          this.showToast(_('Could not save image'));
        }
      });
    }

    // Save the canvas as a reopenable annotation file (image + editable actions).
    // Counts as "saved" for the unsaved-changes guard, same as an image export.
    private saveDocumentDialog(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();

      const settings = getSettings();
      const dialog = new Gtk.FileDialog({title: _('Save annotation file'), modal: true});
      // Re-saving an opened/saved document offers its own name + folder; renaming
      // is how the user makes a copy. Otherwise fall back to a fresh timestamped
      // name in the configured default folder.
      const docFolder = this.currentDocPath
        ? Gio.File.new_for_path(this.currentDocPath).get_parent()
        : null;
      dialog.set_initial_name(
        this.currentDocPath ? GLib.path_get_basename(this.currentDocPath) : defaultDocFilename()
      );
      dialog.set_initial_folder(
        docFolder ?? Gio.File.new_for_path(settings.defaultSaveFolder || defaultSaveFolderPath())
      );

      const filter = new Gtk.FileFilter({name: _('Annotation file')});
      filter.add_pattern(DOC_PATTERN);
      const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
      filters.append(filter);
      dialog.set_filters(filters);
      dialog.set_default_filter(filter);

      dialog.save(this, null, (_src, result) => {
        let file: Gio.File;
        try {
          file = dialog.save_finish(result);
        } catch (e) {
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.error('save_finish failed', e);
          }
          return;
        }
        if (!file) return;

        const snapshot = this.canvas.documentSnapshot();
        if (!snapshot) return;

        let path = file.get_path();
        if (!path) return;
        if (!path.toLowerCase().endsWith(DOC_EXTENSION)) path += DOC_EXTENSION;

        try {
          const text = serializeDocument(snapshot.surface, snapshot.actions);
          Gio.File.new_for_path(path).replace_contents(
            new TextEncoder().encode(text),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
          );
          this.canvas.markClean();
          // Track the saved path so a later re-save offers it (Save-As behavior:
          // saving to a new name switches the working document to that name).
          this.currentDocPath = path;
        } catch (e) {
          console.error('save annotation file failed', e);
          this.showToast(_('Could not save annotation file'));
        }
      });
    }

    private openDocumentDialog(): void {
      confirmDiscard(this, _('Opening an annotation file'), this.canvas.isDirty(), () =>
        this.openDocumentDialogUnchecked()
      );
    }

    private openDocumentDialogUnchecked(): void {
      const dialog = new Gtk.FileDialog({title: _('Open annotation file'), modal: true});
      const filter = new Gtk.FileFilter({name: _('Annotation file')});
      filter.add_pattern(DOC_PATTERN);
      const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
      filters.append(filter);
      dialog.set_filters(filters);
      dialog.set_default_filter(filter);

      dialog.open(this, null, (_src, result) => {
        let file: Gio.File;
        try {
          file = dialog.open_finish(result);
        } catch (e) {
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.error('open_finish failed', e);
          }
          return;
        }
        if (file) this.openDocumentFile(file);
      });
    }

    private openDocumentFile(file: Gio.File): void {
      try {
        const [ok, contents] = file.load_contents(null);
        if (!ok) throw new Error('load_contents returned false');
        const {surface, actions} = parseDocument(new TextDecoder().decode(contents));
        this.setDocument(surface, actions);
        // Remember the opened file so a re-save offers the same name/folder.
        this.currentDocPath = file.get_path();
      } catch (e) {
        // parseDocument's DocumentError and any I/O error both land here; the
        // specific cause is logged, the user sees one general message.
        console.error('openDocumentFile failed', e);
        this.showToast(_('Could not open annotation file'));
      }
    }

    private copyImageToClipboard(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      const surface = this.canvas.exportSnapshot();
      if (!surface) return;
      try {
        copySurfaceToClipboard(this.get_clipboard(), surface);
        if (getSettings().closeAfterImageCopy) {
          // Clicking the notification reopens the copied image from the
          // clipboard. A copy doesn't mark the canvas saved, so skip the
          // discard prompt on the way out (the prefs info text warns of this).
          this.sendExportNotification({
            title: _('Image copied to clipboard'),
            pasteOnClick: true,
            thumbnailBytes: surfaceThumbnailPngBytes(surface),
          });
          this.closeAfterExport(true);
        } else {
          this.showToast(_('Image copied to clipboard'));
        }
      } catch (e) {
        console.error('copySurfaceToClipboard failed', e);
        this.showToast(_('Could not copy image'));
      }
    }

    // Reopen the copied image when the "Image copied to clipboard" notification
    // is clicked (the app's paste-clipboard action), creating a window first if
    // needed. On a cold relaunch the new process hasn't received the clipboard
    // selection offer yet — on Wayland it arrives only once our window is
    // focused — so an immediate read finds nothing. Wait until the clipboard
    // advertises content, then paste; bounded by a timeout, and silent on
    // give-up so a cold start doesn't flash a misleading "no image" toast.
    pasteWhenReady(): void {
      const clipboard = this.get_clipboard();
      const ready = (): boolean => {
        const mimes = clipboard.get_formats()?.get_mime_types() ?? [];
        return IMAGE_MIME_TYPES.some((m) => mimes.includes(m)) || mimes.includes('text/uri-list');
      };
      if (ready()) {
        this.pasteFromClipboard();
        return;
      }
      let changedId = 0;
      let timeoutId = 0;
      const finish = (doPaste: boolean): void => {
        if (changedId) {
          clipboard.disconnect(changedId);
          changedId = 0;
        }
        if (timeoutId) {
          GLib.source_remove(timeoutId);
          timeoutId = 0;
        }
        if (doPaste) this.pasteFromClipboard();
      };
      changedId = clipboard.connect('changed', () => {
        if (ready()) finish(true);
      });
      timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLIPBOARD_READY_TIMEOUT_MS, () => {
        timeoutId = 0;
        finish(ready());
        return GLib.SOURCE_REMOVE;
      });
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
          else this.showToast(_('Clipboard has no image to paste'));
        } catch (e) {
          console.error('paste (uri-list) failed', e);
          this.showToast(_('Could not paste image'));
        } finally {
          stream?.close(null);
        }
      });
    }
  }
);
