import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {CANVAS_SIZE_MAX, CANVAS_SIZE_MIN} from './actions.js';
import {AnnoscrWindow} from './window.js';
import {getSettings} from './settings.js';
import {applyColorScheme} from './preferences.js';

const DEFAULT_BLANK_WIDTH = 640;
const DEFAULT_BLANK_HEIGHT = 480;

export const AnnoscrApplication = GObject.registerClass(
  {GTypeName: 'AnnoscrApplication'},
  class extends Adw.Application {
    private initialBlank: {w: number; h: number} | null = null;
    private initialCapture = false;

    constructor() {
      super({
        application_id: 'com.cmphys.Annoscr',
        flags: Gio.ApplicationFlags.HANDLES_OPEN,
      });
      this.add_main_option(
        'new',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.NONE,
        'Create a blank canvas',
        null
      );
      this.add_main_option(
        'width',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.INT,
        `Canvas width in pixels (default: ${DEFAULT_BLANK_WIDTH}, requires --new)`,
        'PIXELS'
      );
      this.add_main_option(
        'height',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.INT,
        `Canvas height in pixels (default: ${DEFAULT_BLANK_HEIGHT}, requires --new)`,
        'PIXELS'
      );
      this.add_main_option(
        'screenshot',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.NONE,
        'Capture a screenshot via the desktop portal on startup',
        null
      );
    }

    vfunc_startup(): void {
      super.vfunc_startup();
      applyColorScheme(getSettings().colorScheme);
      // When run from the build tree the launcher exports the source icon dir;
      // installed runs find the icons via the default hicolor search path.
      const iconPath = GLib.getenv('ANNOSCR_ICON_PATH');
      const display = Gdk.Display.get_default();
      if (iconPath && display) {
        Gtk.IconTheme.get_for_display(display).add_search_path(iconPath);
      }
    }

    vfunc_handle_local_options(options: GLib.VariantDict): number {
      const wv = options.lookup_value('width', GLib.VariantType.new('i'));
      const hv = options.lookup_value('height', GLib.VariantType.new('i'));
      if (options.contains('new')) {
        let w = DEFAULT_BLANK_WIDTH;
        let h = DEFAULT_BLANK_HEIGHT;
        if (wv) w = Math.max(CANVAS_SIZE_MIN, Math.min(CANVAS_SIZE_MAX, wv.get_int32()));
        if (hv) h = Math.max(CANVAS_SIZE_MIN, Math.min(CANVAS_SIZE_MAX, hv.get_int32()));
        this.initialBlank = {w, h};
      } else if (wv || hv) {
        console.warn('annoscr: --width/--height require --new; ignoring.');
      }
      if (options.contains('screenshot')) {
        this.initialCapture = true;
        if (options.contains('new')) {
          console.warn(
            'annoscr: --new has no effect with --screenshot; the screenshot replaces the canvas.'
          );
        }
      }
      // NOTE: these options are processed on whichever instance runs locally.
      // On a second invocation while one is already running, the local instance
      // forwards a bare activate/open to the primary, so the flags are not seen
      // there — that limitation is inherent to single-instance GApplication
      // without HANDLES_COMMAND_LINE and is left as documented behavior.
      return -1;
    }

    vfunc_activate(): void {
      const win = (this.active_window ?? new AnnoscrWindow(this)) as InstanceType<
        typeof AnnoscrWindow
      >;
      if (this.initialBlank) {
        win.createBlankCanvas(this.initialBlank.w, this.initialBlank.h);
        this.initialBlank = null;
      }
      if (this.initialCapture) {
        this.initialCapture = false;
        // captureScreenshot presents the window itself once capture resolves,
        // so we skip the present() below to avoid flashing an empty window.
        win.captureScreenshot();
        return;
      }
      win.present();
    }

    vfunc_open(files: Gio.File[], _hint: string): void {
      // A file argument routes here instead of vfunc_activate, so any --new /
      // --screenshot intent can't be honored — warn and drop it rather than
      // leaving it stranded for a later activation.
      if (this.initialBlank || this.initialCapture) {
        console.warn('annoscr: --new/--screenshot are ignored when a file is opened.');
        this.initialBlank = null;
        this.initialCapture = false;
      }
      const win = (this.active_window ?? new AnnoscrWindow(this)) as InstanceType<
        typeof AnnoscrWindow
      >;
      win.present();
      if (files.length > 0) win.openFileChecked(files[0]);
    }
  }
);
