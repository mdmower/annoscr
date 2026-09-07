import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {setAccessibleLabel} from './a11y.js';
import {DOC_PATTERN, TAG_IMAGE, TAG_THUMBNAIL, isDocumentName} from './document.js';
import {NotContainerError, readChunkFromFile} from './document_container.js';
import {_} from './i18n.js';
import {RecentEntry, forgetRecentFile, getRecentFiles, rememberAddedFiles} from './recent_files.js';
import {isRecord} from './validators.js';
import {IMAGE_MIME_TYPES} from './window_constants.js';

// A horizontally scrolling list of recently opened files. Gtk.ListView recycles
// item widgets, so only visible thumbnails are ever realized and a long list
// costs a few widgets rather than hundreds.

// Thumbnail box in widget px; the strip's height follows from it.
const THUMB_W = 192;
const THUMB_H = 108;
// Placeholder icon size for a file that can't be previewed.
const PLACEHOLDER_ICON_PX = 48;

// Above this size an image gets a placeholder instead of a preview; it scales
// during its decode, so the limit is large and a screenshot never reaches it.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
// Documents written before the container format parse whole on the main loop to
// reach their preview, so they keep a tighter limit. Container documents need
// no limit: their preview costs the same few reads at any size.
const MAX_LEGACY_DOCUMENT_BYTES = 32 * 1024 * 1024;

// An intact file that is simply too big to preview — distinct from a decode
// failure so each gets its own placeholder icon.
class OversizeError extends Error {}

// Boxes a RecentEntry so it can be stored in a Gio.ListStore.
const RecentItem = GObject.registerClass(
  {GTypeName: 'AnnoscrRecentItem'},
  class extends GObject.Object {
    // Assigned right after construction: GObject construction can't take a
    // plain JS value.
    entry: RecentEntry = {path: '', kind: 'image'};
  }
);

interface ItemState {
  picture: Gtk.Picture;
  badge: Gtk.Image;
  menu: Gtk.PopoverMenu;
  entry: RecentEntry | null;
  loading: Gio.Cancellable | null;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function readStream(file: Gio.File, cancellable: Gio.Cancellable): Promise<Gio.InputStream> {
  return new Promise((resolve, reject) => {
    file.read_async(GLib.PRIORITY_LOW, cancellable, (_src, res) => {
      try {
        resolve(file.read_finish(res));
      } catch (e) {
        reject(toError(e));
      }
    });
  });
}

function fileSize(file: Gio.File, cancellable: Gio.Cancellable): Promise<number> {
  return new Promise((resolve, reject) => {
    file.query_info_async(
      'standard::size',
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_LOW,
      cancellable,
      (_src, res) => {
        try {
          resolve(file.query_info_finish(res).get_size());
        } catch (e) {
          reject(toError(e));
        }
      }
    );
  });
}

function loadContents(file: Gio.File, cancellable: Gio.Cancellable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    file.load_contents_async(cancellable, (_src, res) => {
      try {
        const [ok, contents] = file.load_contents_finish(res);
        if (!ok) throw new Error('load_contents returned false');
        resolve(contents);
      } catch (e) {
        reject(toError(e));
      }
    });
  });
}

// Decode straight to thumbnail size — in device pixels, so a HiDPI display
// gets a sharp preview — so a full-resolution screenshot is never materialized
// just to be shrunk afterwards.
function pixbufAtScale(
  stream: Gio.InputStream,
  scaleFactor: number,
  cancellable: Gio.Cancellable
): Promise<GdkPixbuf.Pixbuf> {
  return new Promise((resolve, reject) => {
    GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
      stream,
      THUMB_W * scaleFactor,
      THUMB_H * scaleFactor,
      true,
      cancellable,
      (_src, res) => {
        try {
          const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
          if (!pixbuf) throw new Error('decode produced no pixbuf');
          // The new_from_stream family ignores EXIF orientation, so apply it
          // here as the image loader does — otherwise a rotated JPEG appears
          // sideways in the strip but opens upright on the canvas.
          resolve(pixbuf.apply_embedded_orientation() ?? pixbuf);
        } catch (e) {
          reject(toError(e));
        }
      }
    );
  });
}

// The preview payload of a container document, or null when the file predates
// the container. Only the chunk headers and the preview itself are read, where
// parseDocument would decode the full-resolution image and rebuild every
// action.
async function containerPreviewBytes(
  file: Gio.File,
  cancellable: Gio.Cancellable
): Promise<Uint8Array | null> {
  try {
    // Prefer the composited preview; a document saved without one falls back to
    // its source image, which previews as a flat rectangle when the content is
    // all in the action stack.
    const preview =
      (await readChunkFromFile(file, TAG_THUMBNAIL, cancellable)) ??
      (await readChunkFromFile(file, TAG_IMAGE, cancellable));
    if (!preview) throw new Error('annotation file carries no embedded image');
    return preview;
  } catch (e) {
    // Only "this was never a container" falls back to the older reader; a
    // corrupt container is a real failure and stays one.
    if (e instanceof NotContainerError) return null;
    throw e;
  }
}

// The same preview out of a pre-container document: a JSON envelope with the
// image base64-encoded inside it, so the whole file parses to reach it. Those
// have no composited preview, so one built on a blank fill shows as a flat
// rectangle.
async function legacyPreviewBytes(
  file: Gio.File,
  cancellable: Gio.Cancellable
): Promise<Uint8Array> {
  const size = await fileSize(file, cancellable);
  if (size > MAX_LEGACY_DOCUMENT_BYTES) {
    throw new OversizeError(`${String(size)} bytes exceeds the preview limit`);
  }
  const contents = await loadContents(file, cancellable);
  const envelope: unknown = JSON.parse(new TextDecoder().decode(contents));
  if (!isRecord(envelope)) throw new Error('annotation file is not an object');
  const image = isRecord(envelope.image) ? envelope.image : null;
  if (!image || typeof image.data !== 'string') {
    throw new Error('annotation file carries no embedded image');
  }
  return GLib.base64_decode(image.data);
}

// Classify a file offered to the list: an annotation document by extension,
// anything else by the content type its name implies. Null means it can't be
// listed - a folder, a file Annoscr can't annotate, or a remote URI with no
// local path to reopen from. Name-only, so a drop of many files costs no I/O;
// a file that turns out to be undecodable still gets its placeholder later,
// exactly as a listed file whose contents changed does.
function listableEntry(file: Gio.File): RecentEntry | null {
  const path = file.get_path();
  if (path === null) return null;
  if (isDocumentName(path)) return {path, kind: 'document'};
  const [type] = Gio.content_type_guess(path, null);
  return type.startsWith('image/') ? {path, kind: 'image'} : null;
}

async function documentImageStream(
  file: Gio.File,
  cancellable: Gio.Cancellable
): Promise<Gio.InputStream> {
  const data =
    (await containerPreviewBytes(file, cancellable)) ??
    (await legacyPreviewBytes(file, cancellable));
  return Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(data));
}

export class RecentStrip {
  private readonly stack: Gtk.Stack;
  private readonly store: Gio.ListStore;
  private readonly listView: Gtk.ListView;
  private readonly onOpen: (entry: RecentEntry) => void;
  private readonly onNotify: (message: string) => void;
  // Thumbnails decoded this session. Nothing is cached on disk; this only stops
  // scrolling back and forth from decoding the same file twice.
  private readonly textures = new Map<string, Gdk.Texture>();
  private readonly items = new Map<Gtk.ListItem, ItemState>();
  private readonly actions = new Gio.SimpleActionGroup();
  private readonly factory: Gtk.SignalListItemFactory;
  private factoryHandlers: number[];
  // Whether focus was in the strip when the context menu was opened — i.e.
  // where focus returns when the menu closes. The menu itself takes focus, so
  // this can't be read at activation time; a menu-driven Forget uses it to
  // decide whether focus should move to a remaining thumbnail.
  private menuFocusInStrip = false;

  constructor(onOpen: (entry: RecentEntry) => void, onNotify: (message: string) => void) {
    this.onOpen = onOpen;
    this.onNotify = onNotify;
    this.store = new Gio.ListStore({item_type: RecentItem.$gtype});

    const factory = new Gtk.SignalListItemFactory();
    this.factory = factory;
    this.factoryHandlers = [
      factory.connect('setup', (_f, obj: GObject.Object) => this.setupItem(obj as Gtk.ListItem)),
      factory.connect('bind', (_f, obj: GObject.Object) => this.bindItem(obj as Gtk.ListItem)),
      factory.connect('unbind', (_f, obj: GObject.Object) => this.cancelLoad(obj as Gtk.ListItem)),
      factory.connect('teardown', (_f, obj: GObject.Object) => {
        const listItem = obj as Gtk.ListItem;
        this.cancelLoad(listItem);
        // A popover must be dismissed and unparented before its parent is
        // destroyed.
        const menu = this.items.get(listItem)?.menu;
        menu?.popdown();
        menu?.unparent();
        this.items.delete(listItem);
      }),
    ];

    const listView = new Gtk.ListView({
      orientation: Gtk.Orientation.HORIZONTAL,
      model: Gtk.NoSelection.new(this.store),
      factory,
      // Each item is a button that handles its own activation, so the list's
      // own selection/activation behavior would only duplicate it.
      single_click_activate: false,
      css_classes: ['annoscr-recent-list'],
    });
    this.listView = listView;

    const scroller = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.NEVER,
      child: listView,
    });

    const empty = new Gtk.Label({
      label: _('Files you open will appear here. Drop files or press Insert to add them.'),
      css_classes: ['dim-label', 'caption'],
      // Matches the populated strip's height so toggling the list open doesn't
      // resize the window's content area.
      height_request: THUMB_H,
    });

    this.stack = new Gtk.Stack({css_classes: ['annoscr-recent-strip']});
    this.stack.add_named(empty, 'empty');
    this.stack.add_named(scroller, 'list');
    setAccessibleLabel(scroller, _('Recent files'));

    // The action group for the per-thumbnail context menu; Show in Files reuses
    // the application's own action, so only Forget is local.
    const forget = new Gio.SimpleAction({
      name: 'forget',
      parameter_type: GLib.VariantType.new('s'),
    });
    forget.connect('activate', (_a, param) => {
      if (param) this.forgetEntry(param.deepUnpack() as string, this.menuFocusInStrip);
    });
    this.actions.add_action(forget);
    this.stack.insert_action_group('recent', this.actions);

    this.installDropTarget();
    this.refresh();
  }

  // Files dropped on the strip are listed, not opened: this is how a set of
  // screenshots is queued for annotating one at a time, without disturbing
  // whatever is on the canvas. The window's own drop target still opens a file
  // dropped anywhere else; this one is deeper in the widget tree, so it
  // receives the drop before that one.
  private installDropTarget(): void {
    // GdkFileList rather than GFile, which receives only the first of a
    // multi-file drag. A single file arrives as a one-entry list, and a source
    // offering a plain GFile still advertises text/uri-list, which GDK
    // deserializes to this - so one type covers every file drag.
    const target = Gtk.DropTarget.new(Gdk.FileList.$gtype, Gdk.DragAction.COPY);
    target.connect('drop', (_t, value: unknown) => this.onDrop(value));
    target.connect('enter', () => {
      this.setDropHighlight(true);
      return Gdk.DragAction.COPY;
    });
    target.connect('leave', () => this.setDropHighlight(false));
    this.stack.add_controller(target);
  }

  private setDropHighlight(on: boolean): void {
    if (on) this.stack.add_css_class('annoscr-recent-drop');
    else this.stack.remove_css_class('annoscr-recent-drop');
  }

  private onDrop(value: unknown): boolean {
    this.setDropHighlight(false);
    if (!(value instanceof Gdk.FileList)) return false;
    this.addFiles(value.get_files());
    return true;
  }

  // List files without opening any - the final step shared by the two ways
  // files are added, a drop on the strip and the Add dialog. Reports whether
  // the list actually grew, which the caller uses to reveal a collapsed strip.
  private addFiles(files: Gio.File[]): boolean {
    // An empty list produces no message; the toasts below are for files that
    // were rejected.
    if (files.length === 0) return false;

    const entries: RecentEntry[] = [];
    for (const file of files) {
      const entry = listableEntry(file);
      if (entry) entries.push(entry);
    }
    // Both failures are otherwise invisible: nothing opens and the strip
    // doesn't change, so without a message the request appears ignored.
    if (entries.length === 0) {
      this.onNotify(_('Only images and annotation files can be added'));
      return false;
    }
    if (!rememberAddedFiles(entries)) {
      this.onNotify(_('Already in recent files'));
      return false;
    }
    // Rebuilding resets the scroll to the start, where the new entries are.
    this.refresh();
    return true;
  }

  // The keyboard counterpart to dropping files on the strip: pick several at
  // once and list them without opening any. `onAdded` runs only when the list
  // grew, so the window can reveal a collapsed strip rather than leaving the
  // result hidden. Returns whether the dialog opened at all.
  presentAddDialog(onAdded: () => void): boolean {
    const root = this.stack.get_root();
    if (!(root instanceof Gtk.Window)) return false;

    const dialog = new Gtk.FileDialog({title: _('Add to recent files'), modal: true});
    // One filter covering everything the strip can list, matching what a drop
    // on it accepts.
    const filter = new Gtk.FileFilter({name: _('Images and annotation files')});
    for (const mime of IMAGE_MIME_TYPES) filter.add_mime_type(mime);
    filter.add_pattern(DOC_PATTERN);
    const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
    filters.append(filter);
    dialog.set_filters(filters);
    dialog.set_default_filter(filter);

    dialog.open_multiple(root, null, (_src, result) => {
      let picked: Gio.ListModel;
      try {
        picked = dialog.open_multiple_finish(result);
      } catch (e) {
        // Cancelling is routine and is reported as a Gtk.DialogError; log the
        // rest.
        if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
          console.warn('open_multiple_finish failed', e);
        }
        return;
      }
      const files: Gio.File[] = [];
      for (let i = 0; i < picked.get_n_items(); i++) {
        const item = picked.get_item(i);
        if (item instanceof Gio.File) files.push(item);
      }
      if (this.addFiles(files)) onAdded();
    });
    return true;
  }

  getWidget(): Gtk.Widget {
    return this.stack;
  }

  setVisible(visible: boolean): void {
    this.stack.set_visible(visible);
  }

  // Release the factory's JS callbacks while the JS context is still valid.
  // Closing the window makes GTK emit unbind and teardown for every live item,
  // and those wrappers can be mid-GC-sweep by then, which GJS refuses to call
  // into (one CRITICAL per bound item).
  shutdown(): void {
    for (const state of this.items.values()) {
      state.loading?.cancel();
      // Disconnecting below stops teardown running, so release popovers here.
      state.menu.popdown();
      state.menu.unparent();
    }
    this.items.clear();
    this.textures.clear();
    for (const id of this.factoryHandlers) this.factory.disconnect(id);
    this.factoryHandlers = [];
  }

  // Discard every cached thumbnail. Clearing the history shouldn't leave
  // decoded images of those files in memory for the rest of the session.
  clearThumbnailCache(): void {
    this.textures.clear();
  }

  // Discard one cached thumbnail so the next bind decodes again. Saving over an
  // already-listed image would otherwise keep showing its pre-annotation
  // thumbnail for the rest of the session.
  invalidateThumbnail(path: string): void {
    this.textures.delete(path);
  }

  // Rebuild the model from the stored list. Cheap: the items are small
  // GObject wrappers, and only the visible ones get widgets.
  refresh(): void {
    const entries = getRecentFiles();
    this.store.remove_all();
    for (const entry of entries) {
      const item = new RecentItem();
      item.entry = entry;
      this.store.append(item);
    }
    this.stack.set_visible_child_name(entries.length > 0 ? 'list' : 'empty');
  }

  private setupItem(listItem: Gtk.ListItem): void {
    const picture = new Gtk.Picture({
      content_fit: Gtk.ContentFit.CONTAIN,
      width_request: THUMB_W,
      height_request: THUMB_H,
    });
    const badge = new Gtk.Image({
      icon_name: 'document-edit-symbolic',
      halign: Gtk.Align.END,
      valign: Gtk.Align.END,
      pixel_size: 12,
      visible: false,
      css_classes: ['annoscr-recent-badge'],
    });
    const overlay = new Gtk.Overlay({child: picture});
    overlay.add_overlay(badge);

    const button = new Gtk.Button({
      child: overlay,
      css_classes: ['flat', 'annoscr-recent-item'],
    });
    button.connect('clicked', () => {
      const entry = this.items.get(listItem)?.entry;
      if (entry) this.onOpen(entry);
    });

    const menu = new Gtk.PopoverMenu({has_arrow: false, halign: Gtk.Align.START});
    menu.set_parent(button);

    // A GtkButton only activates on the primary button, so a secondary press
    // reaches this gesture without also opening the image; claiming the
    // sequence keeps it that way.
    const secondary = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
    secondary.connect('pressed', (gesture, _n, x, y) => {
      gesture.set_state(Gtk.EventSequenceState.CLAIMED);
      this.showContextMenu(listItem, x, y);
    });
    button.add_controller(secondary);

    // Keyboard counterparts to the pointer. These are LOCAL to the focused
    // thumbnail and run before the window's own controller, so Delete forgets
    // the focused file rather than reaching the canvas selection.
    const itemKeys = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.LOCAL});
    const bind = (keys: string, run: () => boolean): void => {
      const trigger = Gtk.ShortcutTrigger.parse_string(keys);
      if (!trigger) return;
      itemKeys.add_shortcut(new Gtk.Shortcut({trigger, action: Gtk.CallbackAction.new(run)}));
    };
    // The right-click menu, on the two keys GTK uses for it elsewhere. With no
    // pointer position, it opens centered.
    for (const keys of ['Menu', '<Shift>F10']) {
      bind(keys, () => {
        this.showContextMenu(listItem);
        return true;
      });
    }
    // The menu's own two entries, reachable without opening it. Delete and
    // Backspace are the app's delete keys throughout; Ctrl+Alt+O is what Files
    // binds to opening a recent item's location.
    for (const keys of ['Delete', 'BackSpace']) {
      bind(keys, () => this.forgetItem(listItem));
    }
    bind('<Control><Alt>o', () => this.revealItem(listItem));
    button.add_controller(itemKeys);

    // Without this the row and its button would both be tab stops. Focus alone
    // never opens anything: activation stays on GtkButton's own Enter/Space.
    listItem.set_focusable(false);
    listItem.set_child(button);
    this.items.set(listItem, {picture, badge, menu, entry: null, loading: null});
  }

  // x/y are relative to the thumbnail button; omitted (the keyboard path) puts
  // the menu at its center.
  private showContextMenu(listItem: Gtk.ListItem, x?: number, y?: number): void {
    const state = this.items.get(listItem);
    const entry = state?.entry;
    if (!state || !entry) return;
    // Read before the popover opens and takes focus itself: the keyboard path
    // arrives with the thumbnail focused, a right-click leaves focus where it
    // was (a claimed gesture doesn't move it).
    this.menuFocusInStrip = this.stripContainsFocus();
    const button = listItem.get_child();
    const px = x ?? (button ? button.get_width() / 2 : 0);
    const py = y ?? (button ? button.get_height() / 2 : 0);

    // Rebuilt per press rather than at bind time: the path is the action
    // target, and item widgets are recycled across different files.
    const model = new Gio.Menu();
    // Wording shared with the save notification's button, which took it from
    // the desktop portal - one action, one name. Both entries name their key
    // the way the selection-actions menu does; GTK renders no accel for a menu
    // model whose action has none set application-wide.
    const reveal = Gio.MenuItem.new(_('Show in Files (Ctrl+Alt+O)'), null);
    reveal.set_action_and_target_value('app.show-in-files', GLib.Variant.new_string(entry.path));
    model.append_item(reveal);
    const drop = Gio.MenuItem.new(_('Forget (Delete)'), null);
    drop.set_action_and_target_value('recent.forget', GLib.Variant.new_string(entry.path));
    model.append_item(drop);

    state.menu.set_menu_model(model);
    state.menu.set_pointing_to(
      new Gdk.Rectangle({x: Math.round(px), y: Math.round(py), width: 1, height: 1})
    );
    state.menu.popup();
  }

  // Whether the window's keyboard focus is on the strip or inside it.
  private stripContainsFocus(): boolean {
    const root = this.stack.get_root();
    const focus = root instanceof Gtk.Window ? root.get_focus() : null;
    return focus !== null && (focus === this.stack || focus.is_ancestor(this.stack));
  }

  // The two menu entries as key handlers. Both report "not handled" with no
  // bound file, so the key falls through to the window rather than being
  // consumed by a recycled item that currently shows nothing. Delete is LOCAL
  // to the focused thumbnail, so focus is in the strip by definition.
  private forgetItem(listItem: Gtk.ListItem): boolean {
    const entry = this.items.get(listItem)?.entry;
    if (!entry) return false;
    this.forgetEntry(entry.path, true);
    return true;
  }

  private revealItem(listItem: Gtk.ListItem): boolean {
    const entry = this.items.get(listItem)?.entry;
    if (!entry) return false;
    return this.stack.activate_action('app.show-in-files', GLib.Variant.new_string(entry.path));
  }

  // Remove one entry. Nothing special-cases the image currently on the canvas:
  // forgetting it only removes the list entry, and saving puts it back through
  // the normal save path.
  //
  // `focusStrip` says whether focus belongs in the strip afterwards. Rebuilding
  // the model destroys the focused thumbnail, so a keyboard-driven forget moves
  // focus to the item now at the removed position (the new last one when the
  // last entry was removed) — otherwise a keyboard walk through the strip ends
  // at the first Delete. A pointer-driven forget must not do that: moving focus
  // off the canvas would make a later Delete forget another file instead of
  // deleting the canvas selection.
  private forgetEntry(path: string, focusStrip: boolean): void {
    const position = getRecentFiles().findIndex((e) => e.path === path);
    forgetRecentFile(path);
    this.textures.delete(path);
    this.refresh();
    // The rebuild also resets the scroll, which scroll_to puts back.
    const remaining = this.store.get_n_items();
    if (position < 0 || remaining === 0) return;
    this.listView.scroll_to(
      Math.min(position, remaining - 1),
      focusStrip ? Gtk.ListScrollFlags.FOCUS : Gtk.ListScrollFlags.NONE,
      null
    );
  }

  private bindItem(listItem: Gtk.ListItem): void {
    const state = this.items.get(listItem);
    const item = listItem.get_item();
    if (!state || !(item instanceof RecentItem)) return;

    const entry = item.entry;
    state.entry = entry;
    state.badge.set_visible(entry.kind === 'document');

    const name = GLib.path_get_basename(entry.path);
    const button = listItem.get_child();
    if (button) {
      button.set_tooltip_text(`${name}\n${GLib.path_get_dirname(entry.path)}`);
      setAccessibleLabel(button, name);
    }

    const cached = this.textures.get(entry.path);
    if (cached) {
      this.showThumbnail(state.picture, cached);
      return;
    }

    state.picture.set_paintable(null);
    const cancellable = new Gio.Cancellable();
    state.loading = cancellable;
    this.loadTexture(entry, cancellable)
      .then((texture) => {
        this.textures.set(entry.path, texture);
        // The item may have been recycled onto a different file while this
        // decode was in flight; only paint if it still shows this one.
        if (state.entry?.path === entry.path) this.showThumbnail(state.picture, texture);
      })
      .catch((e: unknown) => {
        if (cancellable.is_cancelled()) return;
        // Missing, unreadable, or oversized. The entry stays with a placeholder
        // rather than disappearing mid-scroll; missing ones are pruned at the
        // next launch or when clicked. Oversized gets the generic icon, not the
        // broken one — nothing is wrong with it.
        console.log(`annoscr: no thumbnail for ${entry.path} (${toError(e).message})`);
        if (state.entry?.path === entry.path) {
          this.showPlaceholder(
            state.picture,
            e instanceof OversizeError ? 'image-x-generic-symbolic' : 'image-missing-symbolic'
          );
        }
      })
      .finally(() => {
        if (state.loading === cancellable) state.loading = null;
      });
  }

  private cancelLoad(listItem: Gtk.ListItem): void {
    const state = this.items.get(listItem);
    if (!state) return;
    state.loading?.cancel();
    state.loading = null;
    state.entry = null;
  }

  private async loadTexture(
    entry: RecentEntry,
    cancellable: Gio.Cancellable
  ): Promise<Gdk.Texture> {
    const file = Gio.File.new_for_path(entry.path);
    let stream: Gio.InputStream;
    if (entry.kind === 'document') {
      // Any size limit that applies belongs to the older format, so the stat
      // happens in that branch rather than here.
      stream = await documentImageStream(file, cancellable);
    } else {
      // Checked before anything is read, so an oversized file costs one stat
      // rather than a full decode.
      const size = await fileSize(file, cancellable);
      if (size > MAX_IMAGE_BYTES) {
        throw new OversizeError(`${String(size)} bytes exceeds the preview limit`);
      }
      stream = await readStream(file, cancellable);
    }
    try {
      const scaleFactor = this.stack.get_scale_factor();
      return Gdk.Texture.new_for_pixbuf(await pixbufAtScale(stream, scaleFactor, cancellable));
    } finally {
      // GdkPixbuf's stream decoders leave the stream open, and an unclosed file
      // stream keeps its descriptor until GC — enough binds would exhaust
      // the process's descriptors. Closed without the cancellable: a cancelled
      // decode would fail its own close and hide the cancellation.
      try {
        stream.close(null);
      } catch {
        // A read-only stream that won't close has nothing left to report.
      }
    }
  }

  private showThumbnail(picture: Gtk.Picture, texture: Gdk.Texture): void {
    picture.set_content_fit(Gtk.ContentFit.CONTAIN);
    picture.set_paintable(texture);
  }

  // SCALE_DOWN rather than CONTAIN: an icon stretched to fill the thumbnail box
  // renders blurry, so it draws at its own size, centered.
  private showPlaceholder(picture: Gtk.Picture, iconName: string): void {
    const display = picture.get_display();
    const icon = Gtk.IconTheme.get_for_display(display).lookup_icon(
      iconName,
      null,
      PLACEHOLDER_ICON_PX,
      picture.get_scale_factor(),
      Gtk.TextDirection.NONE,
      Gtk.IconLookupFlags.NONE
    );
    picture.set_content_fit(Gtk.ContentFit.SCALE_DOWN);
    picture.set_paintable(icon);
  }
}
