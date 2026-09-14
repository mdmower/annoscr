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
import {anchorSurface, createBlankSurface} from './image_transforms.js';
import {assetFromFile, assetFromPixbuf, loadFromFile, loadFromPixbuf} from './image_loader.js';
import {takeScreenshot} from './screenshot.js';
import {
  Action,
  ColorRGBA,
  TEXT_STYLE,
  TRANSPARENT_FILL,
  makeTextAction,
  withShapeText,
} from './actions.js';
import type {ImageAsset} from './actions.js';
import {TextEditor, TextEditorBeginOptions, TextEditorStyle} from './text_editor.js';
import type {CanvasState, TextEditRequestOptions} from './canvas_view.js';
import {
  FORMATS,
  ImageFormat,
  copySurfaceToClipboard,
  defaultSaveFilename,
  defaultSaveFolderPath,
  formatFromPath,
  saveSurface,
  surfaceThumbnailPngBytes,
  writeFileBytes,
} from './exporter.js';
import {
  DOC_EXTENSION,
  DOC_PATTERN,
  defaultDocFilename,
  isDocumentName,
  parseDocument,
  serializeDocument,
} from './document.js';
import {
  AnnoscrSettings,
  StyleBarPosition,
  getSettings,
  undoMemoryBytes,
  updateSettings,
} from './settings.js';
import {presentPreferences} from './preferences.js';
import {presentShortcuts} from './shortcuts_dialog.js';
import {
  confirmDiscard,
  showAbout,
  showNewCanvasDialog,
  showReplaceBackgroundColorDialog,
  showReplaceBackgroundImageDialog,
  showScaleImageDialog,
} from './dialogs.js';
import {StyleBar} from './style_bar.js';
import {setChosenFonts} from './font_catalogue.js';
import {ZoomController} from './zoom_controller.js';
import {ToolBar} from './tool_bar.js';
import {RecentStrip} from './recent_strip.js';
import {
  RecentEntry,
  RecentKind,
  clearRecentFiles,
  forgetRecentFile,
  isStripVisible,
  pruneMissingRecentFiles,
  rememberOpenedFile,
  rememberSavedFile,
  setStripVisible,
} from './recent_files.js';
import {IMAGE_MIME_TYPES, TOOLS, installWindowCss} from './window_constants.js';
import {labelFromTooltip} from './a11y.js';
import {_} from './i18n.js';

// After an autoclose export we close the window but keep the process alive this
// long, so the just-sent notification's async D-Bus delivery completes before
// the app exits. The window is already destroyed, so the app appears closed
// meanwhile.
const NOTIFY_GRACE_MS = 1000;

// How long a cold-relaunch paste waits for the clipboard to advertise content
// (the Wayland selection offer arrives only once our window is focused) before
// giving up silently.
const CLIPBOARD_READY_TIMEOUT_MS = 3000;

// Expected, handled failures log their cause alone. Passing the error object
// would append a stack trace that is identical every time and says nothing the
// message doesn't.
function causeOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A file dialog offering the image types the loader decodes.
function imageFileDialog(title: string): Gtk.FileDialog {
  const dialog = new Gtk.FileDialog({title, modal: true});
  const filter = new Gtk.FileFilter({name: _('Images')});
  for (const mime of IMAGE_MIME_TYPES) filter.add_mime_type(mime);
  const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
  filters.append(filter);
  dialog.set_filters(filters);
  dialog.set_default_filter(filter);
  return dialog;
}

export const AnnoscrWindow = GObject.registerClass(
  {GTypeName: 'AnnoscrWindow'},
  class extends Adw.ApplicationWindow {
    private canvas: InstanceType<typeof CanvasView>;
    private stack: Gtk.Stack;
    private editor: InstanceType<typeof TextEditor>;
    // Set true just before we explicitly call close() after the user has
    // chosen Discard, so the close-request handler doesn't re-prompt.
    private skipCloseConfirm: boolean = false;
    // Set when the close proceeds. An export that completes afterwards still
    // writes its file but skips the window's feedback.
    private closed: boolean = false;
    // Image exports, clipboard copies, and annotation-file saves, run one at
    // a time (enqueueExport).
    private exportQueue: Promise<void> = Promise.resolve();
    private saveButton: Gtk.Button;
    private copyButton: Gtk.Button;
    // Enabled once a canvas is open; the menu rows are insensitive until then.
    private canvasActions: Gio.SimpleAction[] = [];

    // Path of the annotation file currently being edited (set on open or save
    // of a .annoscr), so a re-save offers the same name/folder. Cleared
    // whenever a plain image replaces the canvas
    // (open/blank/paste/drop/screenshot), since that's no longer "this
    // document".
    private currentDocPath: string | null = null;
    // The collaborators the window builds and connects. Each owns one
    // region of the shell: the dockable style-picker bar, the scrolled view
    // plus bottom zoom bar, and the tool selector plus resize toolbar.
    private styleBar: StyleBar;
    // The four dock slots the style bar moves between (two ToolbarView bars,
    // two sides of the content box); applyStyleBarPosition parents the bar
    // into one and shows only that slot. The side slots keep a permanent
    // separator on their canvas edge.
    private styleTopSlot: Gtk.Box;
    private styleBottomSlot: Gtk.Box;
    private styleStartSlot: Gtk.Box;
    private styleEndSlot: Gtk.Box;
    private zoom: ZoomController;
    private toolbar: ToolBar;
    private toastOverlay: Adw.ToastOverlay;
    // The recent-files strip below the status bar, and the status-bar button
    // that shows/hides it.
    private recentStrip: RecentStrip;
    private recentToggle!: Gtk.ToggleButton;
    private recentToggleIcon!: Adw.ButtonContent;

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

      // Primary menu — packed first so it is placed at the right edge, next to
      // the window controls (the standard GNOME position).
      const menu = new Gio.Menu();
      const imageSection = new Gio.Menu();
      imageSection.append(_('Insert image file…'), 'win.insertimage');
      const replaceMenu = new Gio.Menu();
      replaceMenu.append(_('With image…'), 'win.replacebgimage');
      replaceMenu.append(_('With color…'), 'win.replacebgcolor');
      imageSection.append_submenu(_('Replace background'), replaceMenu);
      menu.append_section(null, imageSection);
      // Annotation-file open/save: a reopenable document (image + editable
      // actions), distinct from the prominent PNG/JPEG export on the header
      // bar.
      const fileSection = new Gio.Menu();
      fileSection.append(_('Open annotation file…'), 'win.opendoc');
      fileSection.append(_('Save annotation file…'), 'win.savedoc');
      // Always-dialog image export — the way to pick a one-off location when
      // "save without choosing a location" makes the header Save button (and
      // Ctrl+S) write silently to the default folder.
      fileSection.append(_('Save image as…'), 'win.saveas');
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

      // pack_end stacks right-to-left in source order, so to order the buttons
      // as [Rotate Left][Rotate Right] left-to-right we add Rotate Right first.
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
      // Start on the preferred tool. Must precede the ToolBar so its toggle
      // buttons initialize to the canvas's tool.
      this.canvas.setTool(getSettings().defaultTool);

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
          // shape at the target index, keeping the shape selected so it can be
          // edited further. Empty markup clears the text but keeps the shape.
          if (editTarget) {
            const shape = this.canvas.getActionAt(editTarget.index);
            if (shape) {
              // TextEditorStyle and the shape's TextStyle have identical
              // fields.
              this.canvas.replaceAction(editTarget.index, withShapeText(shape, markup, style));
              this.canvas.selectIndex(editTarget.index);
              // Remember this style as the shape tool's initial text style for
              // the next shape (empty markup = text cleared, so there's nothing
              // to remember).
              if (markup) this.canvas.rememberShapeTextStyle(editTarget.index, style);
            } else {
              this.canvas.clearEditing();
            }
            return;
          }
          // The editor is the source of truth for style + size during an
          // edit; pickers update style via refreshStyle and the corner grip
          // updates editorSize — both arrive here at commit.
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
          // Click on canvas with text tool active (or double-click with select
          // tool): commit any prior edit, then begin a new one. Pass-through
          // options hold markup + (replaceIndex | shapeIndex) for re-edit.
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
        // Takes the width a side-docked style bar leaves in the content box.
        hexpand: true,
      });
      this.stack.add_named(empty, 'empty');
      this.stack.add_named(viewOverlay, 'canvas');
      this.stack.set_visible_child_name('empty');

      this.styleBar = new StyleBar(this.canvas, this.editor);
      this.recentStrip = new RecentStrip(
        (entry) => this.openRecent(entry),
        (message) => this.showToast(message)
      );

      // The strip it reveals is directly below, and the status bar already
      // holds the other view controls.
      const statusBar = this.zoom.getStatusBar();
      this.zoom.setStatusCenterWidget(this.buildRecentToggle());
      // The two image-size commands, reached from the dimensions readout. They
      // are listed together because the difference between them is exactly what
      // is unclear when the size is wrong: one changes the visible region, the
      // other resamples.
      const sizeMenu = new Gio.Menu();
      // The "accel" attribute only prints the chord beside the item; the keys
      // themselves stay on the window's ShortcutController, which is where
      // their editor / no-image conditions live. Registering them as
      // application accelerators instead would invoke these actions
      // unconditionally.
      const sizeItem = (label: string, action: string, accel: string): Gio.MenuItem => {
        const item = Gio.MenuItem.new(label, action);
        item.set_attribute_value('accel', GLib.Variant.new_string(accel));
        return item;
      };
      sizeMenu.append_item(sizeItem(_('Crop or expand…'), 'win.cropcanvas', '<Control>e'));
      sizeMenu.append_item(sizeItem(_('Scale image…'), 'win.scaleimage', '<Control><Shift>e'));
      this.zoom.setSizeMenu(sizeMenu);

      this.styleTopSlot = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, visible: false});
      this.styleBottomSlot = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, visible: false});
      this.styleStartSlot = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, visible: false});
      this.styleStartSlot.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL}));
      this.styleEndSlot = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, visible: false});
      this.styleEndSlot.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL}));

      const contentBox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL});
      contentBox.append(this.styleStartSlot);
      contentBox.append(this.stack);
      contentBox.append(this.styleEndSlot);

      const toolbar = new Adw.ToolbarView();
      toolbar.add_top_bar(header);
      toolbar.add_top_bar(this.styleTopSlot);
      toolbar.set_content(contentBox);
      // Bottom bars stack downward in the order they're added: a bottom-docked
      // style bar sits just above the status bar, the strip below it.
      toolbar.add_bottom_bar(this.styleBottomSlot);
      toolbar.add_bottom_bar(statusBar);
      toolbar.add_bottom_bar(this.recentStrip.getWidget());
      this.toastOverlay = new Adw.ToastOverlay({child: toolbar});
      this.set_content(this.toastOverlay);
      this.applyStyleBarPosition(settings.styleBarPosition);

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
      // Files deleted since the last session are removed once, here.
      pruneMissingRecentFiles();
      this.applyRecentPreference();
      this.zoom.refresh();
      this.styleBar.refresh();

      this.installActions(app);
      this.installDropTarget();
      this.installColorSampleCancel();
      this.installShortcuts();
      this.installCloseGuard();
    }

    // A text button whose disclosure triangle points right while the strip is
    // hidden and down while it's shown.
    private buildRecentToggle(): Gtk.ToggleButton {
      this.recentToggleIcon = new Adw.ButtonContent({
        label: _('Recent files'),
        icon_name: 'pan-end-symbolic',
      });
      this.recentToggle = new Gtk.ToggleButton({
        child: this.recentToggleIcon,
        css_classes: ['flat'],
        tooltip_text: _('Show or hide recently opened files (Ctrl+H)'),
        active: isStripVisible(),
      });
      this.recentToggle.connect('toggled', () => {
        setStripVisible(this.recentToggle.get_active());
        this.applyRecentPreference();
      });
      return this.recentToggle;
    }

    // Switching the preference off also clears the list: having asked Annoscr
    // to stop remembering, the user shouldn't be left with the remembered paths
    // still on disk. Deliberately unconfirmed — the subtitle is what warns.
    private onRecentPreferenceChanged(): void {
      if (!getSettings().rememberRecentFiles) {
        clearRecentFiles();
        this.recentStrip.clearThumbnailCache();
      }
      this.applyRecentPreference();
    }

    // The preference gates the whole feature (strip and toggle are both
    // hidden); the toggle only controls whether the strip is expanded.
    private applyRecentPreference(): void {
      const enabled = getSettings().rememberRecentFiles;
      const shown = enabled && isStripVisible();
      this.recentToggle.set_visible(enabled);
      this.recentStrip.setVisible(shown);
      this.recentToggleIcon.set_icon_name(shown ? 'pan-down-symbolic' : 'pan-end-symbolic');
      if (shown) this.recentStrip.refresh();
    }

    // Screenshots arrive here too: the portal returns a file:// URI, so they
    // have a path like any other open.
    private recordOpened(file: Gio.File, kind: RecentKind): void {
      if (!getSettings().rememberRecentFiles) return;
      const path = file.get_path();
      // A non-local URI has no path to reopen from, so it can't be listed.
      if (path === null) return;
      // Reopening an already-listed file changes nothing, so leave the strip
      // exactly as it is rather than rebuilding it under the pointer.
      if (rememberOpenedFile(path, kind)) this.recentStrip.refresh();
    }

    // Record a just-saved file, which moves to the front of the strip whether
    // it was already listed or not.
    private recordSaved(path: string, kind: RecentKind): void {
      if (!getSettings().rememberRecentFiles) return;
      rememberSavedFile(path, kind);
      // A save that completes after the window closed has no strip to update.
      if (this.closed) return;
      // Always rebuild, even when the entry was already leftmost: the file's
      // contents just changed, so its thumbnail has to be decoded again.
      this.recentStrip.invalidateThumbnail(path);
      this.recentStrip.refresh();
    }

    // Reopen through the same guarded entry point the file manager and command
    // line use, so the unsaved-changes prompt and the image/document dispatch
    // apply.
    private openRecent(entry: RecentEntry): void {
      const file = Gio.File.new_for_path(entry.path);
      if (!file.query_exists(null)) {
        forgetRecentFile(entry.path);
        this.recentStrip.refresh();
        this.showToast(_('File was moved or deleted'));
        return;
      }
      this.openFileChecked(file);
    }

    // Restore per-tool styles saved in a previous session, if the user opted
    // in.
    private restoreToolStyles(): void {
      const s = getSettings();
      if (s.rememberToolStyles && s.toolStyles) this.canvas.importToolStyles(s.toolStyles);
    }

    // Dock the style bar on the window edge `pos` names: reparent it into
    // that slot (rebuilt vertical for the side docks) and show only that
    // slot. Applied at startup and live on a preference change.
    private applyStyleBarPosition(pos: StyleBarPosition): void {
      const bar = this.styleBar.getWidget();
      const parent = bar.get_parent();
      if (parent instanceof Gtk.Box) parent.remove(bar);
      this.styleBar.setVertical(pos === 'left' || pos === 'right');
      this.styleTopSlot.set_visible(pos === 'top');
      this.styleBottomSlot.set_visible(pos === 'bottom');
      this.styleStartSlot.set_visible(pos === 'left');
      this.styleEndSlot.set_visible(pos === 'right');
      switch (pos) {
        case 'top':
          this.styleTopSlot.append(bar);
          break;
        case 'bottom':
          this.styleBottomSlot.append(bar);
          break;
        case 'left':
          // Ahead of the slot's permanent separator, which sits on the
          // canvas edge.
          this.styleStartSlot.prepend(bar);
          break;
        case 'right':
          this.styleEndSlot.append(bar);
          break;
      }
    }

    // Push the undo-memory preference into the canvas as a byte budget.
    // Applied at startup and again whenever the preference changes.
    private applyUndoMemory(): void {
      this.canvas.setUndoMemoryBudget(undoMemoryBytes(getSettings().undoMemory));
    }

    // Persist per-tool styles on close, if the user opted in. Called from the
    // close guard, which every quit path passes through.
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
      const add = (name: string, cb: () => void): Gio.SimpleAction => {
        const action = new Gio.SimpleAction({name});
        action.connect('activate', () => cb());
        this.add_action(action);
        return action;
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
          onRecentFilesChanged: () => this.onRecentPreferenceChanged(),
          onStyleBarPositionChanged: () =>
            this.applyStyleBarPosition(getSettings().styleBarPosition),
        })
      );
      add('shortcuts', () => presentShortcuts(this));
      add('about', () => showAbout(this));
      add('quit', () => this.close());
      add('opendoc', () => this.openDocumentDialog());
      add('savedoc', () => this.saveDocumentDialog());
      add('saveas', () => this.saveImageDialog());
      add('insertimage', () => this.insertImageDialog());
      add('cropcanvas', () => this.toolbar.toggleResizeMode());
      add('scaleimage', () => this.scaleImageDialog());
      this.canvasActions = [
        add('replacebgimage', () => this.replaceBackgroundWithImage()),
        add('replacebgcolor', () => this.replaceBackgroundWithColor()),
      ];
      for (const a of this.canvasActions) a.set_enabled(false);
      app.set_accels_for_action('win.preferences', ['<Control>comma']);
      app.set_accels_for_action('win.shortcuts', ['<Control>question']);
      app.set_accels_for_action('win.quit', ['<Control>q']);
    }

    private installCloseGuard(): void {
      this.connect('close-request', () => {
        // Returning false lets the close proceed — flush prefs at those points.
        if (this.skipCloseConfirm || !this.canvas.isDirty()) {
          this.closed = true;
          this.flushSettings();
          this.recentStrip.shutdown();
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
      if (this.closed) return;
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
      const dialog = imageFileDialog(_('Open image'));
      dialog.open(this, null, (_src, result) => {
        try {
          const file = dialog.open_finish(result);
          if (file) this.openFile(file);
        } catch (e) {
          // Cancellation is reported as a Gtk DialogError; ignore those and log
          // the rest.
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.warn('open_finish failed', e);
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

    // Entry point for files passed in from outside (file manager "Open With",
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

    private isDocumentFile(file: Gio.File): boolean {
      const name = file.get_basename();
      return name !== null && isDocumentName(name);
    }

    // abandonOnCancel is set when this window was created solely to host a
    // fresh `annoscr --screenshot` launch (no instance was already running). In
    // that case a cancelled or failed capture closes the never-shown window
    // rather than leaving an empty welcome window behind; when Annoscr was
    // already running, a cancel keeps the window and shows a toast instead.
    captureScreenshot(abandonOnCancel = false): void {
      // Unmap the window first so Annoscr isn't in the shot when the user picks
      // a screen or full-screen region. The short delay gives the compositor
      // time to actually hide it before the portal's capture UI appears.
      this.set_visible(false);
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        takeScreenshot()
          .then((uri) => {
            if (!uri && abandonOnCancel) {
              // New `--screenshot` launch with nothing captured: destroy the
              // window so the app exits. destroy() (not close()) is
              // required since gtk_window_close() no-ops on a window that was
              // never realized, and this one stayed hidden for the capture, so
              // close() would leave it registered and the process would hang.
              this.destroy();
              return;
            }
            this.set_visible(true);
            this.present();
            if (uri) {
              confirmDiscard(this, _('Opening the screenshot'), this.canvas.isDirty(), () =>
                this.openFile(Gio.File.new_for_uri(uri))
              );
            }
          })
          .catch((e: unknown) => {
            // A user cancel and a portal failure both arrive here (the portal
            // reports them the same way).
            if (abandonOnCancel) {
              // New `--screenshot` launch: exit (see the destroy() note above).
              // Cancelling is routine, so this logs the cause in one line
              // instead of as an error.
              console.log(`screenshot capture did not complete: ${causeOf(e)}; exiting`);
              this.destroy();
              return;
            }
            // Log the cause so a genuine failure is diagnosable even though the
            // toast says cancelled.
            console.log(`takeScreenshot failed: ${causeOf(e)}`);
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
        this.recordOpened(file, 'image');
      } catch (e) {
        // Covers both load/decode failures and I/O errors (missing file,
        // permission denied), so the message stays general rather than always
        // citing the file format.
        console.log(`openFile failed: ${causeOf(e)}`);
        const name = file.get_basename() ?? file.get_uri();
        this.showToast(_('Could not open "%s"').replace('%s', name));
      }
    }

    private setImage(surface: Cairo.ImageSurface): void {
      // Discard any in-progress text edit or resize — they belonged to the old
      // image.
      this.editor.cancel();
      if (this.canvas.getTool() === 'resize') this.toolbar.exitResizeMode(false);
      // A plain image isn't tied to any annotation file.
      this.currentDocPath = null;
      this.canvas.setImage(surface);
      this.showCanvas();
    }

    private showCanvas(): void {
      this.stack.set_visible_child_name('canvas');
      this.saveButton.set_sensitive(true);
      this.copyButton.set_sensitive(true);
      for (const a of this.canvasActions) a.set_enabled(true);
    }

    // Same UI setup as setImage, but loads a saved document (surface + actions)
    // instead of a bare image.
    private setDocument(surface: Cairo.ImageSurface, actions: ReadonlyArray<Action>): void {
      this.editor.cancel();
      if (this.canvas.getTool() === 'resize') this.toolbar.exitResizeMode(false);
      this.canvas.loadDocument(surface, actions);
      this.showCanvas();
    }

    // Rotate the whole canvas 90°, committing any in-progress text edit first.
    // Shared by the header buttons and the Ctrl+R / Ctrl+Shift+R accelerators.
    // Resample the image to a new size (annotations scale with it). Distinct
    // from crop/expand, which changes the visible region without resampling.
    private scaleImageDialog(): void {
      const img = this.canvas.getImageDimensions();
      if (!img) return;
      this.editor.commitIfActive();
      showScaleImageDialog(this, img.w, img.h, (factor) => this.canvas.scaleImage(factor));
    }

    private rotateImage(dir: 'cw' | 'ccw'): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      this.canvas.rotate(dir);
    }

    // Replace the base image, keeping the canvas size and every annotation.
    // A pending crop is discarded first, as by every other command that
    // replaces the image.
    private replaceBackground(surface: Cairo.ImageSurface): void {
      if (this.canvas.getTool() === 'resize') this.toolbar.exitResizeMode(false);
      this.canvas.replaceBackground(surface);
    }

    private replaceBackgroundWithColor(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      showReplaceBackgroundColorDialog(this, (color) => {
        const img = this.canvas.getImageDimensions();
        if (img) this.replaceBackground(createBlankSurface(img.w, img.h, color));
      });
    }

    // The file is not recorded in the recent strip, like an inserted image. An
    // image of another size goes through the alignment dialog; its padding
    // color is the crop/expand fill, written back when the control was shown.
    private replaceBackgroundWithImage(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      const dialog = imageFileDialog(_('Replace background with image'));
      dialog.open(this, null, (_src, result) => {
        let file: Gio.File | null;
        try {
          file = dialog.open_finish(result);
        } catch (e) {
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.warn('open_finish failed', e);
          }
          return;
        }
        if (!file) return;
        let image: Cairo.ImageSurface;
        try {
          image = loadFromFile(file);
        } catch (e) {
          console.log(`replace background failed: ${causeOf(e)}`);
          const name = file.get_basename() ?? file.get_uri();
          this.showToast(_('Could not open "%s"').replace('%s', name));
          return;
        }
        const target = this.canvas.getImageDimensions();
        if (!target) return;
        const size = {w: image.getWidth(), h: image.getHeight()};
        if (size.w === target.w && size.h === target.h) {
          this.replaceBackground(image);
          return;
        }
        const fill = this.canvas.getToolFill('resize') ?? TRANSPARENT_FILL;
        showReplaceBackgroundImageDialog(this, size, target, fill, (anchor, padding) => {
          if (padding) this.canvas.setToolFill('resize', padding);
          this.replaceBackground(
            anchorSurface(image, target.w, target.h, anchor, padding ?? TRANSPARENT_FILL)
          );
        });
      });
    }

    // A file list, not a single file: a Gio.File target receives only the first
    // file of a multi-file drag.
    private installDropTarget(): void {
      const dropTarget = Gtk.DropTarget.new(Gdk.FileList.$gtype, Gdk.DragAction.COPY);
      dropTarget.connect('drop', (_target: unknown, value: unknown) => {
        if (!(value instanceof Gdk.FileList)) return false;
        const files = value.get_files();
        if (files.length === 0) return false;
        this.addFiles(files);
        return true;
      });
      this.add_controller(dropTarget);
    }

    // Add files as image items: dropped, pasted as a copied file list, or
    // picked in Insert image file. With no canvas, the first image that decodes
    // becomes the canvas and the rest become items on it. An annotation file
    // can't be an item, so the first one opens as the document (behind the
    // discard prompt) only when no image was given.
    private addFiles(files: ReadonlyArray<Gio.File>): void {
      const images = files.filter((f) => !this.isDocumentFile(f));
      if (images.length === 0) {
        const doc = files[0];
        if (!doc) return;
        confirmDiscard(this, _('Opening this annotation file'), this.canvas.isDirty(), () =>
          this.openDocumentFile(doc)
        );
        return;
      }
      let rest = images;
      while (!this.canvas.hasImage() && rest.length > 0) {
        this.openFile(rest[0]);
        rest = rest.slice(1);
      }
      const assets: ImageAsset[] = [];
      for (const file of rest) {
        try {
          assets.push(assetFromFile(file));
        } catch (e) {
          console.log(`insert image failed: ${causeOf(e)}`);
          const name = file.get_basename() ?? file.get_uri();
          this.showToast(_('Could not open "%s"').replace('%s', name));
        }
      }
      this.insertAssets(assets);
    }

    // Place image items on the open canvas and select them. Unlike a drawing
    // tool's placement this always switches to the select tool, since there is
    // no image tool to stay in.
    private insertAssets(assets: ImageAsset[]): void {
      if (assets.length === 0 || !this.canvas.hasImage()) return;
      // Also commits a text edit and leaves crop mode without applying it.
      this.toolbar.selectTool('select');
      this.canvas.insertImages(assets);
    }

    private insertImageDialog(): void {
      const dialog = imageFileDialog(_('Insert image file'));
      dialog.open_multiple(this, null, (_src, result) => {
        try {
          const list = dialog.open_multiple_finish(result);
          const files: Gio.File[] = [];
          for (let i = 0; i < list.get_n_items(); i++) {
            const item = list.get_item(i);
            if (item instanceof Gio.File) files.push(item);
          }
          this.addFiles(files);
        } catch (e) {
          if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
            console.warn('open_multiple_finish failed', e);
          }
        }
      });
    }

    // A press anywhere outside the canvas view (header, tool palette, style
    // bar, status bar, recent strip) cancels a pending eyedropper sample. The
    // loupe only tracks the pointer over the canvas, so a mode left live while
    // the user works elsewhere is invisible, and the next canvas click would
    // pick a color instead of doing what the tool says. Presses inside the
    // scroller - the canvas, its scrollbars, the text editor overlaid on it -
    // keep the mode: they're targeting a pixel, scrolling, or editing in place.
    private installColorSampleCancel(): void {
      const canvasArea = this.zoom.getScrolled();
      const press = new Gtk.GestureClick();
      press.set_button(0); // any button
      // Capture phase so the press is seen before the widget under it acts.
      press.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
      press.connect('pressed', (gesture, _n, x, y) => {
        // Observe only: denying the sequence leaves the pressed widget its
        // click (a claim in the capture phase would cancel every gesture
        // below).
        gesture.set_state(Gtk.EventSequenceState.DENIED);
        if (!this.canvas.isColorSampling()) return;
        const target = this.pick(x, y, Gtk.PickFlags.DEFAULT);
        if (target && (target === canvasArea || target.is_ancestor(canvasArea))) return;
        this.canvas.cancelColorSample();
      });
      this.add_controller(press);
    }

    private installShortcuts(): void {
      const controller = new Gtk.ShortcutController();
      this.bindShortcut(controller, '<Control>n', () => this.newBlankCanvas());
      this.bindShortcut(controller, '<Control>o', () => this.openImageDialog());
      this.bindShortcut(controller, '<Control><Shift>s', () => this.captureScreenshot());
      this.bindShortcut(controller, '<Control>v', () => this.pasteFromClipboard());
      // Paste as an image item, keeping the canvas. The editor is excluded so
      // the chord can't place an item behind an open text edit.
      this.bindShortcut(controller, '<Control><Shift>v', () => {
        if (this.editor.isActive()) return false;
        this.pasteAsItem();
        return true;
      });
      // Add files to the recent strip without opening any — the keyboard
      // equivalent of dropping them on it, and Insert to the strip's Delete.
      // App-wide
      // rather than scoped to a focused thumbnail because it acts on the list
      // as a whole, so it has to work while the strip is empty or collapsed.
      // Two conditions: the preference (with the feature off there's no list to
      // add to), and the text editor, which keeps Insert for its own overwrite
      // toggle in both standalone and shape-text edits.
      this.bindShortcut(controller, 'Insert', () => {
        if (this.editor.isActive() || !getSettings().rememberRecentFiles) return false;
        // set_active drives the toggle's own handler, which persists the state
        // and expands the strip; it no-ops when the strip is already shown.
        return this.recentStrip.presentAddDialog(() => this.recentToggle.set_active(true));
      });
      // Show or hide the recent strip through the status-bar toggle, which
      // persists the state. Inert while the preference hides the toggle.
      this.bindShortcut(controller, '<Control>h', () => {
        if (!getSettings().rememberRecentFiles) return false;
        this.recentToggle.set_active(!this.recentToggle.get_active());
        return true;
      });
      // Undo/redo are disabled while resize mode is active: a pending region
      // is transient state that hasn't been committed, and rolling history
      // out from under it would be confusing (the resize would silently
      // target whatever surface the undo produced).
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
      // Ctrl+C must not override the editor's text-copy shortcut when the
      // editor is open. The TextView's built-in handler normally consumes the
      // event before it bubbles here; this is a redundant guard.
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
      // and the two image-size commands (Ctrl+E crop/expand, Ctrl+Shift+E
      // scale) — the keyboard equivalents of the two header buttons and the
      // size menu. Gated while the text editor is open so the chords stay with
      // the focused TextView mid-edit.
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
      this.bindShortcut(controller, '<Control><Shift>e', () => {
        if (this.editor.isActive() || !this.canvas.hasImage()) return false;
        this.scaleImageDialog();
        return true;
      });
      this.bindShortcut(controller, 'Delete', () => this.canvas.deleteSelected());
      this.bindShortcut(controller, 'BackSpace', () => this.canvas.deleteSelected());
      // Select all annotations (select tool only; falls through otherwise so
      // the editor keeps Ctrl+A as select-all-text).
      this.bindShortcut(controller, '<Control>a', () => {
        if (this.editor.isActive()) return false;
        return this.canvas.selectAll();
      });
      // Duplicate the selection. Guarded so the chord falls through when
      // nothing is selected (or the editor is open) rather than consuming the
      // event.
      this.bindShortcut(controller, '<Control>d', () => {
        if (this.editor.isActive()) return false;
        return this.canvas.cloneSelected();
      });
      // Start a new stamp group: with the number tool, bump the placement group
      // so the next stamp restarts at 1; with the select tool, move the
      // selected stamps into a fresh group. Falls through otherwise.
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
      // Shift+Space toggles the hover candidate in/out of the selection — the
      // keyboard equivalent of Shift+Click. Shift avoids bare Space activating
      // a focused tool button; the editor captures it while typing.
      this.bindShortcut(controller, '<Shift>space', () => this.canvas.toggleHoverCandidate());
      // Enter confirms resize mode, or — with the select tool — opens the
      // editor on a lone selected text annotation (the keyboard equivalent of
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
        // A pending eyedropper sample cancels first, whatever the tool.
        if (this.canvas.cancelColorSample()) return true;
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
    //   Dig:  , / . (and their shifted < / > keyvals) move the select-tool
    //         hover candidate down/up through overlapping items — the precise,
    //         one-step alternative to Alt+scroll. Handled regardless of Shift so
    //         it works mid-gesture (e.g. while holding Shift to toggle).
    //
    //   Z-order:  Ctrl+[ / Ctrl+] lower/raise the selection one slot;
    //             Ctrl+Shift+[ / Ctrl+Shift+] send it to back / bring to front
    //             (the universal Photoshop/Illustrator/Figma convention).
    //
    // Both target methods return false when they don't act (no candidate /
    // empty selection / already at the end), so a stray key still falls
    // through. The focused text editor consumes these in its CAPTURE-phase
    // controller while typing; isActive() is a redundant guard.
    private installStackKeys(): void {
      const keys = new Gtk.EventControllerKey();
      keys.connect('key-pressed', (_c, keyval, _keycode, state) => {
        if (this.editor.isActive()) return false;
        if ((state & Gdk.ModifierType.CONTROL_MASK) !== 0) {
          const toEnd = (state & Gdk.ModifierType.SHIFT_MASK) !== 0;
          // Match both the unshifted and shifted keyvals of each bracket so the
          // Ctrl+Shift chord works whether the layout reports bracket* or
          // brace*.
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

    // Dialog-free save: default folder + format, auto-generated timestamped
    // name.
    private saveImageSilent(): void {
      this.editor.commitIfActive();
      const snapshot = this.canvas.exportSnapshot();
      if (!snapshot) return;
      const settings = getSettings();
      const format = settings.defaultSaveFormat;
      const folder = settings.defaultSaveFolder || defaultSaveFolderPath();
      const path = GLib.build_filenamev([folder, defaultSaveFilename(format)]);
      this.exportImage(snapshot, path, format, true);
    }

    // Run an encode-and-write after those already requested. In request order,
    // the last save requested is the last to mark the canvas clean. The hold
    // keeps the process running until the write completes if the window closes
    // first.
    private enqueueExport(job: () => Promise<void>): void {
      const app = this.get_application();
      app?.hold();
      this.exportQueue = this.exportQueue
        .then(job)
        .catch((e: unknown) => {
          console.warn('export failed', e);
        })
        .finally(() => app?.release());
    }

    private exportImage(
      snapshot: {surface: Cairo.ImageSurface; state: CanvasState},
      path: string,
      format: ImageFormat,
      silent: boolean
    ): void {
      this.enqueueExport(async () => {
        try {
          await saveSurface(snapshot.surface, path, format);
        } catch (e) {
          console.warn('saveSurface failed', e);
          this.showToast(_('Could not save image'));
          return;
        }
        this.canvas.markClean(snapshot.state);
        this.onImageSaved(path, silent, snapshot.surface);
      });
    }

    // Shared post-save handling for both the dialog and silent paths. On
    // autoclose the window is closing, so feedback is a system notification
    // (a toast would be destroyed with the window). Clicking it reopens the
    // saved file;
    // the "Show in Files" button is offered only for a silent save, since a
    // dialog save already let the user pick (and see) the folder.
    private onImageSaved(path: string, silent: boolean, surface: Cairo.ImageSurface): void {
      this.recordSaved(path, 'image');
      if (this.closed) return;
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
    // letterboxed thumbnail (as the screenshot portal shows one); a raw
    // FileIcon would be distorted by GNOME's square icon slot just like a
    // copy's bytes.
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

    // Close the window after an autoclose export, keeping the process alive
    // briefly so the notification's async delivery completes before the app
    // exits.
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
            console.warn('save_finish failed', e);
          }
          return;
        }
        if (!file) return;

        const snapshot = this.canvas.exportSnapshot();
        if (!snapshot) return;

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

        this.exportImage(snapshot, path, format, false);
      });
    }

    // Save the canvas as a reopenable annotation file (image + editable
    // actions). Counts as "saved" for the unsaved-changes guard, same as an
    // image export.
    private saveDocumentDialog(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();

      const settings = getSettings();
      const dialog = new Gtk.FileDialog({title: _('Save annotation file'), modal: true});
      // Re-saving an opened/saved document offers its own name + folder;
      // renaming is how the user makes a copy. Otherwise fall back to a fresh
      // timestamped name in the configured default folder.
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
            console.warn('save_finish failed', e);
          }
          return;
        }
        if (!file) return;

        const snapshot = this.canvas.documentSnapshot();
        if (!snapshot) return;

        let path = file.get_path();
        if (!path) return;
        if (!path.toLowerCase().endsWith(DOC_EXTENSION)) path += DOC_EXTENSION;

        this.enqueueExport(async () => {
          try {
            const data = await serializeDocument(snapshot.surface, snapshot.actions);
            await writeFileBytes(Gio.File.new_for_path(path), data);
          } catch (e) {
            console.warn('save annotation file failed', e);
            this.showToast(_('Could not save annotation file'));
            return;
          }
          // Track the saved path so a later re-save offers it (Save-As
          // behavior: saving to a new name switches the working document to
          // that name), unless another document was loaded during the save.
          if (this.canvas.markClean(snapshot.state)) this.currentDocPath = path;
          this.recordSaved(path, 'document');
        });
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
            console.warn('open_finish failed', e);
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
        const {surface, actions} = parseDocument(contents);
        this.setDocument(surface, actions);
        // Remember the opened file so a re-save offers the same name/folder.
        this.currentDocPath = file.get_path();
        this.recordOpened(file, 'document');
      } catch (e) {
        // parseDocument's DocumentError and any I/O error both arrive here; the
        // specific cause is logged, the user sees one general message.
        console.log(`openDocumentFile failed: ${causeOf(e)}`);
        this.showToast(_('Could not open annotation file'));
      }
    }

    private copyImageToClipboard(): void {
      if (!this.canvas.hasImage()) return;
      this.editor.commitIfActive();
      const snapshot = this.canvas.exportSnapshot();
      if (!snapshot) return;
      const clipboard = this.get_clipboard();
      this.enqueueExport(async () => {
        try {
          await copySurfaceToClipboard(clipboard, snapshot.surface);
        } catch (e) {
          console.warn('copySurfaceToClipboard failed', e);
          this.showToast(_('Could not copy image'));
          return;
        }
        if (this.closed) return;
        if (getSettings().closeAfterImageCopy) {
          // Clicking the notification reopens the copied image from the
          // clipboard. A copy doesn't mark the canvas saved, so skip the
          // discard prompt on close (the prefs info text warns of this),
          // unless the canvas was edited while the copy was encoding.
          this.sendExportNotification({
            title: _('Image copied to clipboard'),
            pasteOnClick: true,
            thumbnailBytes: surfaceThumbnailPngBytes(snapshot.surface),
          });
          this.closeAfterExport(this.canvas.isCurrentState(snapshot.state));
        } else {
          this.showToast(_('Image copied to clipboard'));
        }
      });
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
      this.readClipboard(
        (pixbuf) => this.setImage(loadFromPixbuf(pixbuf)),
        (files) => {
          // A copied file can be an annotation file as well as an image, so
          // it's routed like a drop. No discard guard here: pasteFromClipboard
          // already ran it.
          const file = files[0];
          if (this.isDocumentFile(file)) this.openDocumentFile(file);
          else this.openFile(file);
        }
      );
    }

    // Ctrl+Shift+V: the clipboard image becomes an image item, or the canvas
    // when none is open.
    private pasteAsItem(): void {
      this.readClipboard(
        (pixbuf) => {
          if (this.canvas.hasImage()) this.insertAssets([assetFromPixbuf(pixbuf)]);
          else this.setImage(loadFromPixbuf(pixbuf));
        },
        (files) => this.addFiles(files)
      );
    }

    // Read the clipboard: decoded image data when it offers some, else the
    // files of a copied file list (at least one). Toasts when it holds neither
    // or reading fails, including a failure in either handler.
    private readClipboard(
      onPixbuf: (pixbuf: GdkPixbuf.Pixbuf) => void,
      onFiles: (files: Gio.File[]) => void
    ): void {
      const clipboard = this.get_clipboard();
      clipboard.read_async(IMAGE_MIME_TYPES, GLib.PRIORITY_DEFAULT, null, (_src, result) => {
        let stream: Gio.InputStream | null = null;
        try {
          [stream] = clipboard.read_finish(result);
        } catch {
          this.readUriList(clipboard, onFiles);
        }
        if (!stream) return;

        // Decoding must be async: the local clipboard delivers bytes via a
        // pipe serviced by the main loop. A synchronous Pixbuf.new_from_stream
        // would block the loop waiting for bytes that never arrive — a
        // same-process clipboard deadlock.
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, (_pbSrc, pbResult) => {
          try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(pbResult);
            if (pixbuf) onPixbuf(pixbuf);
          } catch (e) {
            console.log(`paste (image bytes) failed: ${causeOf(e)}`);
            this.showToast(_('Could not paste image'));
          } finally {
            stream.close(null);
          }
        });
      });
    }

    private readUriList(clipboard: Gdk.Clipboard, onFiles: (files: Gio.File[]) => void): void {
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
          const uris = text
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('#'));
          // The file handlers report their own failures; only the empty-list
          // case needs a toast.
          if (uris.length > 0) onFiles(uris.map((uri) => Gio.File.new_for_uri(uri)));
          else this.showToast(_('Clipboard has no image to paste'));
        } catch (e) {
          console.log(`paste (uri-list) failed: ${causeOf(e)}`);
          this.showToast(_('Could not paste image'));
        } finally {
          stream?.close(null);
        }
      });
    }
  }
);
