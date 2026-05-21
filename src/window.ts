import GObject from 'gi://GObject?version=2.0';
import Adw from 'gi://Adw?version=1';

export const AnnoscrWindow = GObject.registerClass(
  class AnnoscrWindow extends Adw.ApplicationWindow {
    constructor(app: any) {
      super({
        application: app,
        title: 'Annoscr',
        default_width: 960,
        default_height: 640,
      });

      const header = new Adw.HeaderBar();
      const toolbar = new Adw.ToolbarView();
      toolbar.add_top_bar(header);

      const status = new Adw.StatusPage({
        icon_name: 'image-x-generic-symbolic',
        title: 'Annoscr',
        description: 'Milestone 1 — hello-world window. Annotation canvas lands in milestone 3.',
      });
      toolbar.set_content(status);

      this.set_content(toolbar);
    }
  },
);
