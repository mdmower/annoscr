import Gtk from 'gi://Gtk?version=4.0';
import Cairo from 'cairo';

import {ColorRGBA} from './actions.js';
import {colorToHex, colorToRgba, parseHexColor, rgbaToColor} from './gdk_color.js';
import {setLabelledBy} from './a11y.js';
import {_} from './i18n.js';

// Paint a color swatch: a checkerboard (so transparency is visible as such)
// with the color over it and a hairline border, matching the look of a stock
// GTK color button.
export function drawSwatch(cr: Cairo.Context, w: number, h: number, color: ColorRGBA): void {
  const cell = 5;
  cr.setSourceRGB(0.85, 0.85, 0.85);
  cr.paint();
  cr.setSourceRGB(0.55, 0.55, 0.55);
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) cr.rectangle(x, y, cell, cell);
    }
  }
  cr.fill();
  cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
  cr.rectangle(0, 0, w, h);
  cr.fill();
  cr.setSourceRGBA(0, 0, 0, 0.35);
  cr.setLineWidth(1);
  cr.rectangle(0.5, 0.5, w - 1, h - 1);
  cr.stroke();
}

export interface ColorControls {
  box: Gtk.Box;
  // The hex entry, for hosts that want it focused on open.
  entry: Gtk.Entry;
  // Show `c` in the controls without reporting it through onChosen.
  setColor: (c: ColorRGBA) => void;
  getColor: () => ColorRGBA;
}

// A hex entry, an opacity field, and a button into the full system
// Gtk.ColorDialog, stacked in a box. Every path reports the chosen color via
// `onChosen` even when it equals the shown one (so a mixed selection
// flattens). `hexRowEnd` is appended after the entry (the style bar's
// eyedropper button); `swatch` adds a preview of the current color before the
// Hex caption, for hosts that show it nowhere else; `onPaletteOpen` runs before
// the color dialog opens (a popover host closes itself); `activatesDefault`
// makes Enter in the entry and the opacity field run the host dialog's default
// response.
export function makeColorControls(opts: {
  onChosen: (color: ColorRGBA) => void;
  hexRowEnd?: Gtk.Widget;
  swatch?: boolean;
  onPaletteOpen?: () => void;
  activatesDefault?: boolean;
}): ColorControls {
  let current: ColorRGBA = [0, 0, 0, 1];
  // Suppress the entry/opacity change handlers while their values are set
  // programmatically (on sync, or when one control drives the other).
  let syncing = false;
  // The exact text syncControls() last wrote into the hex entry. applyHex
  // gates on this so an untouched entry never commits (see applyHex).
  let lastSyncedText = '';

  const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});

  const hexRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
  let swatchArea: Gtk.DrawingArea | null = null;
  if (opts.swatch) {
    swatchArea = new Gtk.DrawingArea({
      width_request: 28,
      height_request: 20,
      valign: Gtk.Align.CENTER,
    });
    swatchArea.set_draw_func((_w, cr, w, h) => drawSwatch(cr, w, h, current));
    hexRow.append(swatchArea);
  }
  const hexLabel = new Gtk.Label({label: _('Hex'), css_classes: ['caption']});
  hexRow.append(hexLabel);
  const hexEntry = new Gtk.Entry({
    max_length: 9,
    width_chars: 9,
    hexpand: true,
    tooltip_text: _('#RGB, #RGBA, #RRGGBB, or #RRGGBBAA'),
    activates_default: opts.activatesDefault === true,
  });
  setLabelledBy(hexEntry, hexLabel);
  hexRow.append(hexEntry);
  if (opts.hexRowEnd) hexRow.append(opts.hexRowEnd);
  box.append(hexRow);

  const opacityRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
  const opacityLabel = new Gtk.Label({label: _('Opacity'), css_classes: ['caption']});
  opacityRow.append(opacityLabel);
  opacityLabel.set_hexpand(true);
  opacityLabel.set_xalign(0);
  const opacitySpin = new Gtk.SpinButton({
    adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 10}),
    digits: 0,
    width_request: 64,
    valign: Gtk.Align.CENTER,
    xalign: 1,
    activates_default: opts.activatesDefault === true,
  });
  setLabelledBy(opacitySpin, opacityLabel);
  opacityRow.append(opacitySpin);
  box.append(opacityRow);

  const paletteBtn = new Gtk.Button({label: _('Palette…')});
  box.append(paletteBtn);

  // Reflect `current` into the entry + opacity field without re-triggering
  // commits.
  const syncControls = (): void => {
    syncing = true;
    lastSyncedText = colorToHex(current);
    hexEntry.set_text(lastSyncedText);
    opacitySpin.set_value(Math.round(current[3] * 100));
    syncing = false;
    swatchArea?.queue_draw();
  };

  const commit = (c: ColorRGBA): void => {
    current = c;
    swatchArea?.queue_draw();
    opts.onChosen(c);
  };

  // `force` true = the user pressed Enter (an explicit "apply this"), so the
  // shown value broadcasts even when unchanged — the way to flatten a mixed
  // selection to the displayed color. false = a focus-leave, which must not
  // commit an untouched entry: the shown hex is an 8-bit rounding of a float
  // color, so re-parsing an unedited entry yields a slightly different float
  // and looks like a change; a spurious leave (a popover's own open/dismiss
  // focus changes emit `leave` with no user input) would then silently flatten
  // a mixed multi-selection. Gate that case on the text differing.
  const applyHex = (force: boolean): void => {
    if (!force && hexEntry.get_text() === lastSyncedText) return;
    const parsed = parseHexColor(hexEntry.get_text());
    if (!parsed) {
      // Invalid input: snap the entry back to the live color.
      syncControls();
      return;
    }
    // 6-digit keeps the current opacity; 8-digit includes its own alpha.
    const alpha = parsed.hadAlpha ? parsed.color[3] : current[3];
    commit([parsed.color[0], parsed.color[1], parsed.color[2], alpha]);
    // syncControls() normalizes the text via set_text(), which puts the
    // cursor at position 0; move it to the end so editing can continue there.
    syncControls();
    hexEntry.set_position(-1);
  };
  hexEntry.connect('activate', () => applyHex(true));
  // Also apply when focus leaves the entry, so typing then clicking another
  // control commits without needing Enter.
  const focusCtl = new Gtk.EventControllerFocus();
  focusCtl.connect('leave', () => applyHex(false));
  hexEntry.add_controller(focusCtl);

  opacitySpin.connect('value-changed', () => {
    if (syncing) return;
    commit([current[0], current[1], current[2], opacitySpin.get_value() / 100]);
  });

  const dialog = new Gtk.ColorDialog({with_alpha: true});
  paletteBtn.connect('clicked', () => {
    opts.onPaletteOpen?.();
    const root = paletteBtn.get_root() as Gtk.Window | null;
    // Callback form (not the promise overload) — the project doesn't rely on
    // GJS promisifying GTK async methods. choose_rgba_finish throws when the
    // dialog is dismissed/cancelled, which we treat as "no change".
    dialog.choose_rgba(root, colorToRgba(current), null, (_source, res) => {
      try {
        const rgba = dialog.choose_rgba_finish(res);
        if (rgba) commit(rgbaToColor(rgba));
      } catch {
        // Cancelled or dismissed — leave the color untouched.
      }
    });
  });

  return {
    box,
    entry: hexEntry,
    setColor: (c) => {
      current = c;
      syncControls();
    },
    getColor: () => current,
  };
}
