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
        flags: Gio.ApplicationFlags.HANDLES_OPEN | Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
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

    private applyOptions(options: GLib.VariantDict): void {
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
    }

    // HANDLES_COMMAND_LINE routes every CLI invocation here on the PRIMARY
    // instance — including a second `annoscr --screenshot` fired while a window
    // is already open. Parsing the flags here (rather than in
    // handle_local_options, which runs on the transient local process and never
    // touches the primary's state) is what lets them reach the running instance.
    vfunc_command_line(cmdline: Gio.ApplicationCommandLine): number {
      this.applyOptions(cmdline.get_options_dict());
      // After option parsing GOptionContext leaves only positionals in argv,
      // with argv[0] the program name. create_file_for_arg resolves each path
      // against the invoking process's cwd, which may differ from the primary's.
      const positionals = cmdline.get_arguments().slice(1);
      if (positionals.length > 0) {
        this.open(
          positionals.map((arg) => cmdline.create_file_for_arg(arg)),
          ''
        );
      } else {
        this.activate();
      }
      return 0;
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
      // Reached both from the desktop "Open With" path and from command_line
      // when positional file args are present. A file takes precedence, so any
      // --new / --screenshot intent can't be honored — warn and drop it rather
      // than leaving it stranded for a later activation.
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
