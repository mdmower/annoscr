import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';

import {setAccessibleLabel} from './a11y.js';
import {TAG_IMAGE, TAG_THUMBNAIL} from './document.js';
import {NotContainerError, readChunkFromFile} from './document_container.js';
import {_} from './i18n.js';
import {RecentEntry, forgetRecentFile, getRecentFiles} from './recent_files.js';
import {isRecord} from './validators.js';

// A horizontally scrolling list of recently opened files. Gtk.ListView recycles
// item widgets, so only visible thumbnails are ever realized and a long list
// costs a handful of widgets rather than hundreds.

// Thumbnail box in widget px; the strip's height follows from it.
const THUMB_W = 192;
const THUMB_H = 108;
// Placeholder icon size for a file that can't be previewed.
const PLACEHOLDER_ICON_PX = 48;

// Above this size an image isn't worth its preview and gets a placeholder; it
// scales during its decode, so the limit is generous and a screenshot never
// reaches it.
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
// Documents written before the container format parse whole on the main loop to
// reach their preview, so they keep a tighter limit. Container documents need no
// limit: their preview costs the same few reads at any size.
const MAX_LEGACY_DOCUMENT_BYTES = 32 * 1024 * 1024;

// An intact file that is simply too big to preview — distinct from a decode
// failure so each gets its own placeholder icon.
class OversizeError extends Error {}

// Boxes a RecentEntry so it can live in a Gio.ListStore.
const RecentItem = GObject.registerClass(
  {GTypeName: 'AnnoscrRecentItem'},
  class extends GObject.Object {
    // Assigned right after construction: GObject construction can't carry a
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

// Decode straight to thumbnail size, so a full-resolution screenshot is never
// materialized just to be shrunk afterwards.
function pixbufAtScale(
  stream: Gio.InputStream,
  cancellable: Gio.Cancellable
): Promise<GdkPixbuf.Pixbuf> {
  return new Promise((resolve, reject) => {
    GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
      stream,
      THUMB_W,
      THUMB_H,
      true,
      cancellable,
      (_src, res) => {
        try {
          const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_finish(res);
          if (!pixbuf) throw new Error('decode produced no pixbuf');
          // The new_from_stream family ignores EXIF orientation, so apply it
          // here as the image loader does — otherwise a rotated JPEG sits
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
// parseDocument would decode the full-resolution image and rebuild every action.
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
// carry no composited preview, so one built on a blank fill shows as a flat
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
  private readonly onOpen: (entry: RecentEntry) => void;
  // Thumbnails decoded this session. Nothing is cached on disk; this only stops
  // scrolling back and forth from decoding the same file twice.
  private readonly textures = new Map<string, Gdk.Texture>();
  private readonly items = new Map<Gtk.ListItem, ItemState>();
  private readonly actions = new Gio.SimpleActionGroup();
  private readonly factory: Gtk.SignalListItemFactory;
  private factoryHandlers: number[];

  constructor(onOpen: (entry: RecentEntry) => void) {
    this.onOpen = onOpen;
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
        // A popover must be dismissed and unparented before its parent goes.
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

    const scroller = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.NEVER,
      child: listView,
    });

    const empty = new Gtk.Label({
      label: _('Files you open will appear here'),
      css_classes: ['dim-label', 'caption'],
      // Matches the populated strip's height so toggling the list open doesn't
      // resize the window's content area.
      height_request: THUMB_H,
    });

    this.stack = new Gtk.Stack({css_classes: ['annoscr-recent-strip']});
    this.stack.add_named(empty, 'empty');
    this.stack.add_named(scroller, 'list');
    setAccessibleLabel(scroller, _('Recent files'));

    // Backs the per-thumbnail context menu; Show in Files reuses the
    // application's own action, so only Forget is local.
    const forget = new Gio.SimpleAction({
      name: 'forget',
      parameter_type: GLib.VariantType.new('s'),
    });
    forget.connect('activate', (_a, param) => {
      if (param) this.forgetEntry(param.deepUnpack() as string);
    });
    this.actions.add_action(forget);
    this.stack.insert_action_group('recent', this.actions);

    this.refresh();
  }

  getWidget(): Gtk.Widget {
    return this.stack;
  }

  setVisible(visible: boolean): void {
    this.stack.set_visible(visible);
  }

  // Release the factory's JS callbacks while the JS context is still healthy.
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

  // Drop every cached thumbnail. Clearing the history shouldn't leave decoded
  // images of those files sitting in memory for the rest of the session.
  clearThumbnailCache(): void {
    this.textures.clear();
  }

  // Drop one cached thumbnail so the next bind decodes afresh. Saving over an
  // already-listed image would otherwise keep showing its pre-annotation
  // thumbnail for the rest of the session.
  invalidateThumbnail(path: string): void {
    this.textures.delete(path);
  }

  // Rebuild the model from the stored list. Cheap: the items are small boxes,
  // and only the visible ones get widgets.
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
    // reaches this gesture without also opening the image; claiming the sequence
    // keeps it that way.
    const secondary = new Gtk.GestureClick({button: Gdk.BUTTON_SECONDARY});
    secondary.connect('pressed', (gesture, _n, x, y) => {
      gesture.set_state(Gtk.EventSequenceState.CLAIMED);
      this.showContextMenu(listItem, x, y);
    });
    button.add_controller(secondary);

    // The keyboard counterpart to the right-click menu, on the two keys GTK uses
    // for it elsewhere. With no pointer to aim at, it opens centered.
    const popupMenu = Gtk.CallbackAction.new(() => {
      this.showContextMenu(listItem);
      return true;
    });
    const menuKeys = new Gtk.ShortcutController({scope: Gtk.ShortcutScope.LOCAL});
    for (const keys of ['Menu', '<Shift>F10']) {
      const trigger = Gtk.ShortcutTrigger.parse_string(keys);
      if (trigger) menuKeys.add_shortcut(new Gtk.Shortcut({trigger, action: popupMenu}));
    }
    button.add_controller(menuKeys);

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
    const button = listItem.get_child();
    const px = x ?? (button ? button.get_width() / 2 : 0);
    const py = y ?? (button ? button.get_height() / 2 : 0);

    // Rebuilt per press rather than at bind time: the path is the action
    // target, and item widgets are recycled across different files.
    const model = new Gio.Menu();
    // Same label as the save notification's button, which took its wording from
    // the desktop portal - one action, one name.
    const reveal = Gio.MenuItem.new(_('Show in Files'), null);
    reveal.set_action_and_target_value('app.show-in-files', GLib.Variant.new_string(entry.path));
    model.append_item(reveal);
    const drop = Gio.MenuItem.new(_('Forget'), null);
    drop.set_action_and_target_value('recent.forget', GLib.Variant.new_string(entry.path));
    model.append_item(drop);

    state.menu.set_menu_model(model);
    state.menu.set_pointing_to(
      new Gdk.Rectangle({x: Math.round(px), y: Math.round(py), width: 1, height: 1})
    );
    state.menu.popup();
  }

  // Drop one entry. Nothing special-cases the image currently on the canvas:
  // forgetting it only removes the list entry, and saving puts it back through
  // the normal save path.
  private forgetEntry(path: string): void {
    forgetRecentFile(path);
    this.textures.delete(path);
    this.refresh();
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
        // rather than vanishing mid-scroll; missing ones are pruned at the next
        // launch or when clicked. Oversized gets the generic icon, not the
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
      // happens down that branch rather than here.
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
    return Gdk.Texture.new_for_pixbuf(await pixbufAtScale(stream, cancellable));
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
