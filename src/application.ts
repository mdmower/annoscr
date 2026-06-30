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
import {APP_VERSION} from './version.js';
import {_} from './i18n.js';

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
        'version',
        'v'.charCodeAt(0),
        GLib.OptionFlags.NONE,
        GLib.OptionArg.NONE,
        _('Print the version and exit'),
        null
      );
      this.add_main_option(
        'new',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.NONE,
        _('Create a blank canvas'),
        null
      );
      this.add_main_option(
        'width',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.INT,
        _('Canvas width in pixels (default: %d, requires --new)').replace(
          '%d',
          String(DEFAULT_BLANK_WIDTH)
        ),
        'PIXELS'
      );
      this.add_main_option(
        'height',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.INT,
        _('Canvas height in pixels (default: %d, requires --new)').replace(
          '%d',
          String(DEFAULT_BLANK_HEIGHT)
        ),
        'PIXELS'
      );
      this.add_main_option(
        'screenshot',
        0,
        GLib.OptionFlags.NONE,
        GLib.OptionArg.NONE,
        _('Capture a screenshot via the desktop portal on startup'),
        null
      );
      // GOptionContext only lists the flags by default; spell out the positional
      // FILE argument in the Usage line and explain it, so `--help` reveals that
      // an image or .annoscr file can be opened directly.
      this.set_option_context_parameter_string('[FILE]');
      this.set_option_context_summary(
        _('Annotate a screenshot. FILE is an image or .annoscr file to open.')
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

      // The "Show in Files" button on an autoclose-export notification routes
      // here. It can fire after the window (or the whole app) is gone, which
      // D-Bus-activates us headless — registering on the application (not a
      // window) is what lets the action be serviced in that case.
      const showInFiles = new Gio.SimpleAction({
        name: 'show-in-files',
        parameter_type: GLib.VariantType.new('s'),
      });
      showInFiles.connect('activate', (_action, param) => {
        if (param) this.showInFiles(param.deepUnpack() as string);
      });
      this.add_action(showInFiles);

      // Clicking an "Image saved" notification reopens the saved file. Like the
      // button above this can fire after the app has quit, D-Bus-activating us;
      // a window is created if there isn't one.
      const openFile = new Gio.SimpleAction({
        name: 'open-file',
        parameter_type: GLib.VariantType.new('s'),
      });
      openFile.connect('activate', (_action, param) => {
        if (!param) return;
        const win = this.ensureWindow();
        win.present();
        win.openFileChecked(Gio.File.new_for_path(param.deepUnpack() as string));
      });
      this.add_action(openFile);

      // Clicking an "Image copied to clipboard" notification reopens the copied
      // (flattened) image by pasting it back from the clipboard.
      const pasteClipboard = new Gio.SimpleAction({name: 'paste-clipboard'});
      pasteClipboard.connect('activate', () => {
        const win = this.ensureWindow();
        win.present();
        win.pasteWhenReady();
      });
      this.add_action(pasteClipboard);
    }

    private ensureWindow(): InstanceType<typeof AnnoscrWindow> {
      return (this.active_window ?? new AnnoscrWindow(this)) as InstanceType<typeof AnnoscrWindow>;
    }

    // Open the file manager on the given file's folder, highlighting the file.
    private showInFiles(path: string): void {
      const launcher = new Gtk.FileLauncher({file: Gio.File.new_for_path(path)});
      // Hold across the async call: a headless activation has no window keeping
      // the app alive, so without this the process could exit before the file
      // manager is launched.
      this.hold();
      launcher.open_containing_folder(this.active_window, null, (_src, res) => {
        try {
          launcher.open_containing_folder_finish(res);
        } catch (e) {
          console.error('open_containing_folder failed', e);
        }
        this.release();
      });
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

    // Answered on the local process, before the app registers or contacts a
    // running instance: print to stdout and return 0 to exit successfully.
    // Returning -1 for anything else lets normal startup proceed.
    vfunc_handle_local_options(options: GLib.VariantDict): number {
      if (options.contains('version')) {
        print(`annoscr ${APP_VERSION}`);
        return 0;
      }
      return -1;
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
      // No window yet means this is a fresh launch (no instance was already
      // running); a `--screenshot` capture cancelled in that case should abandon
      // the launch rather than leave an empty window behind.
      const freshLaunch = this.active_window === null;
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
        win.captureScreenshot(freshLaunch);
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
      // Single-document app: one canvas per process, so only the first file
      // can be honored.
      if (files.length > 1) {
        console.warn(`annoscr: opening only the first file; ignoring ${files.length - 1} more.`);
      }
      if (files.length > 0) win.openFileChecked(files[0]);
    }
  }
);
