import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Cairo from 'cairo';

import {CANVAS_SIZE_MAX, CANVAS_SIZE_MIN} from './actions.js';
import {createBlankSurface} from './image_transforms.js';
import {colorToRgba, rgbaToColor} from './gdk_color.js';
import {DEFAULT_PRESET_INDEX, SIZE_PRESETS} from './window_constants.js';
import {getSettings} from './settings.js';

export function showAbout(parent: Gtk.Widget): void {
  const about = new Adw.AboutDialog({
    application_name: 'Annoscr',
    application_icon: 'com.cmphys.Annoscr',
    version: '0.1.0',
    developer_name: 'Matt Mower',
    license_type: Gtk.License.GPL_3_0,
    comments: 'A lightweight screenshot annotation tool for GNOME.',
  });
  about.present(parent);
}

// Runs onProceed immediately when confirmation is disabled or there is nothing
// dirty to lose; otherwise gates it behind a destructive "Discard changes?"
// alert.
export function confirmDiscard(
  parent: Gtk.Widget,
  action: string,
  isDirty: boolean,
  onProceed: () => void
): void {
  if (!getSettings().confirmDiscard || !isDirty) {
    onProceed();
    return;
  }
  const dialog = new Adw.AlertDialog({
    heading: 'Discard changes?',
    body: `${action} will discard your current work. Save (Ctrl+S) first if you want to keep it.`,
  });
  dialog.add_response('cancel', 'Cancel');
  dialog.add_response('discard', 'Discard');
  dialog.set_response_appearance('discard', Adw.ResponseAppearance.DESTRUCTIVE);
  dialog.set_default_response('cancel');
  dialog.set_close_response('cancel');
  dialog.connect('response', (_d, response) => {
    if (response === 'discard') onProceed();
  });
  dialog.present(parent);
}

export function showNewCanvasDialog(
  parent: Gtk.Widget,
  onCreate: (surface: Cairo.ImageSurface) => void
): void {
  const dialog = new Adw.AlertDialog({
    heading: 'New blank canvas',
    body: 'Set the canvas size and background color.',
  });
  dialog.add_response('cancel', 'Cancel');
  dialog.add_response('create', 'Create');
  dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
  dialog.set_default_response('create');
  dialog.set_close_response('cancel');

  const grid = new Gtk.Grid({
    row_spacing: 8,
    column_spacing: 12,
  });

  grid.attach(
    new Gtk.Label({label: 'Size', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
    0,
    0,
    1,
    1
  );
  const presetDropdown = Gtk.DropDown.new_from_strings(SIZE_PRESETS.map((p) => p.label));
  presetDropdown.set_hexpand(true);
  presetDropdown.set_selected(DEFAULT_PRESET_INDEX);
  grid.attach(presetDropdown, 1, 0, 1, 1);

  grid.attach(
    new Gtk.Label({label: 'Width', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
    0,
    1,
    1,
    1
  );
  const widthSpin = new Gtk.SpinButton({
    adjustment: new Gtk.Adjustment({
      lower: CANVAS_SIZE_MIN,
      upper: CANVAS_SIZE_MAX,
      step_increment: 1,
      page_increment: 100,
    }),
    digits: 0,
    width_request: 100,
  });
  widthSpin.set_value(SIZE_PRESETS[DEFAULT_PRESET_INDEX].w);
  grid.attach(widthSpin, 1, 1, 1, 1);

  grid.attach(
    new Gtk.Label({label: 'Height', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
    0,
    2,
    1,
    1
  );
  const heightSpin = new Gtk.SpinButton({
    adjustment: new Gtk.Adjustment({
      lower: CANVAS_SIZE_MIN,
      upper: CANVAS_SIZE_MAX,
      step_increment: 1,
      page_increment: 100,
    }),
    digits: 0,
    width_request: 100,
  });
  heightSpin.set_value(SIZE_PRESETS[DEFAULT_PRESET_INDEX].h);
  grid.attach(heightSpin, 1, 2, 1, 1);

  grid.attach(
    new Gtk.Label({label: 'Fill', halign: Gtk.Align.END, valign: Gtk.Align.CENTER}),
    0,
    3,
    1,
    1
  );
  const fillDialog = new Gtk.ColorDialog({with_alpha: true});
  const fillBtn = new Gtk.ColorDialogButton({dialog: fillDialog});
  fillBtn.set_rgba(colorToRgba([1, 1, 1, 1]));
  grid.attach(fillBtn, 1, 3, 1, 1);

  let updating = false;
  presetDropdown.connect('notify::selected', () => {
    if (updating) return;
    const idx = presetDropdown.get_selected();
    if (idx > 0 && idx < SIZE_PRESETS.length) {
      updating = true;
      widthSpin.set_value(SIZE_PRESETS[idx].w);
      heightSpin.set_value(SIZE_PRESETS[idx].h);
      updating = false;
    }
  });
  const syncPreset = (): void => {
    if (updating) return;
    const w = Math.round(widthSpin.get_value());
    const h = Math.round(heightSpin.get_value());
    const match = SIZE_PRESETS.findIndex((p) => p.w === w && p.h === h);
    updating = true;
    presetDropdown.set_selected(match >= 0 ? match : 0);
    updating = false;
  };
  widthSpin.connect('value-changed', syncPreset);
  heightSpin.connect('value-changed', syncPreset);

  dialog.set_extra_child(grid);

  dialog.connect('response', (_d, response) => {
    if (response !== 'create') return;
    const w = Math.round(widthSpin.get_value());
    const h = Math.round(heightSpin.get_value());
    const fill = rgbaToColor(fillBtn.get_rgba());
    onCreate(createBlankSurface(w, h, fill));
  });

  dialog.present(parent);
}
