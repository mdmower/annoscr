import GObject from 'gi://GObject?version=2.0';
import Gio from 'gi://Gio?version=2.0';
import Adw from 'gi://Adw?version=1';

import { AnnoscrWindow } from './window.js';

export const AnnoscrApplication = GObject.registerClass(
  class AnnoscrApplication extends Adw.Application {
    constructor() {
      super({
        application_id: 'com.cmphys.Annoscr',
        flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
      });
    }

    vfunc_activate(): void {
      const win = this.active_window ?? new AnnoscrWindow(this);
      win.present();
    }
  },
);
