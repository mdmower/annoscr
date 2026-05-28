import GLib from 'gi://GLib?version=2.0';
import GObject from 'gi://GObject?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Adw from 'gi://Adw?version=1';

import {CANVAS_SIZE_MAX, CANVAS_SIZE_MIN} from './actions.js';
import {AnnoscrWindow} from './window.js';

const DEFAULT_BLANK_WIDTH = 640;
const DEFAULT_BLANK_HEIGHT = 480;

export const AnnoscrApplication = GObject.registerClass(
  {GTypeName: 'AnnoscrApplication'},
  class extends Adw.Application {
    private initialBlank: {w: number; h: number} | null = null;

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
    }

    vfunc_handle_local_options(options: GLib.VariantDict): number {
      if (options.contains('new')) {
        let w = DEFAULT_BLANK_WIDTH;
        let h = DEFAULT_BLANK_HEIGHT;
        const wv = options.lookup_value('width', GLib.VariantType.new('i'));
        if (wv) w = Math.max(CANVAS_SIZE_MIN, Math.min(CANVAS_SIZE_MAX, wv.get_int32()));
        const hv = options.lookup_value('height', GLib.VariantType.new('i'));
        if (hv) h = Math.max(CANVAS_SIZE_MIN, Math.min(CANVAS_SIZE_MAX, hv.get_int32()));
        this.initialBlank = {w, h};
      }
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
      win.present();
    }

    vfunc_open(files: Gio.File[], _hint: string): void {
      const win = (this.active_window ?? new AnnoscrWindow(this)) as InstanceType<
        typeof AnnoscrWindow
      >;
      win.present();
      if (files.length > 0) win.openFileChecked(files[0]);
    }
  }
);
