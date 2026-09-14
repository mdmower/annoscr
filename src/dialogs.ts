import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Cairo from 'cairo';

import {CANVAS_SIZE_MAX, CANVAS_SIZE_MIN, ColorRGBA} from './actions.js';
import {Anchor, AnchorFraction, createBlankSurface} from './image_transforms.js';
import {makeColorControls} from './color_controls.js';
import {colorToRgba, rgbaToColor} from './gdk_color.js';
import {DEFAULT_PRESET_INDEX, SIZE_PRESETS} from './window_constants.js';
import {getSettings} from './settings.js';
import {APP_VERSION} from './version.js';
import {setAccessibleLabel, setLabelledBy} from './a11y.js';
import {_} from './i18n.js';

export function showAbout(parent: Gtk.Widget): void {
  const about = new Adw.AboutDialog({
    // application_name is the brand; left untranslated on purpose.
    application_name: 'Annoscr',
    application_icon: 'com.cmphys.Annoscr',
    version: APP_VERSION,
    developer_name: 'Matt Mower',
    license_type: Gtk.License.GPL_3_0,
    comments: _('A lightweight screenshot annotation tool for GNOME.'),
    website: 'https://github.com/mdmower/annoscr',
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
    heading: _('Discard changes?'),
    // `action` is a translated verb phrase (e.g. "Opening a file") supplied by
    // the caller; %s keeps it out of the sentence's msgid.
    body: _(
      '%s will discard your current work. Save (Ctrl+S) first if you want to keep it.'
    ).replace('%s', action),
  });
  dialog.add_response('cancel', _('Cancel'));
  dialog.add_response('discard', _('Discard'));
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
    heading: _('New blank canvas'),
    body: _('Set the canvas size and background color.'),
  });
  dialog.add_response('cancel', _('Cancel'));
  dialog.add_response('create', _('Create'));
  dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
  dialog.set_default_response('create');
  dialog.set_close_response('cancel');

  const grid = new Gtk.Grid({
    row_spacing: 8,
    column_spacing: 12,
  });

  const sizeLabel = new Gtk.Label({
    label: _('Size'),
    halign: Gtk.Align.END,
    valign: Gtk.Align.CENTER,
  });
  grid.attach(sizeLabel, 0, 0, 1, 1);
  // SIZE_PRESETS labels are N_-marked; translate each here at build time.
  const presetDropdown = Gtk.DropDown.new_from_strings(SIZE_PRESETS.map((p) => _(p.label)));
  presetDropdown.set_hexpand(true);
  presetDropdown.set_selected(DEFAULT_PRESET_INDEX);
  setLabelledBy(presetDropdown, sizeLabel);
  grid.attach(presetDropdown, 1, 0, 1, 1);

  const widthLabel = new Gtk.Label({
    label: _('Width'),
    halign: Gtk.Align.END,
    valign: Gtk.Align.CENTER,
  });
  grid.attach(widthLabel, 0, 1, 1, 1);
  const widthSpin = new Gtk.SpinButton({
    adjustment: new Gtk.Adjustment({
      lower: CANVAS_SIZE_MIN,
      upper: CANVAS_SIZE_MAX,
      step_increment: 1,
      page_increment: 100,
    }),
    digits: 0,
    width_request: 100,
    xalign: 1,
  });
  widthSpin.set_value(SIZE_PRESETS[DEFAULT_PRESET_INDEX].w);
  setLabelledBy(widthSpin, widthLabel);
  grid.attach(widthSpin, 1, 1, 1, 1);

  const heightLabel = new Gtk.Label({
    label: _('Height'),
    halign: Gtk.Align.END,
    valign: Gtk.Align.CENTER,
  });
  grid.attach(heightLabel, 0, 2, 1, 1);
  const heightSpin = new Gtk.SpinButton({
    adjustment: new Gtk.Adjustment({
      lower: CANVAS_SIZE_MIN,
      upper: CANVAS_SIZE_MAX,
      step_increment: 1,
      page_increment: 100,
    }),
    digits: 0,
    width_request: 100,
    xalign: 1,
  });
  heightSpin.set_value(SIZE_PRESETS[DEFAULT_PRESET_INDEX].h);
  setLabelledBy(heightSpin, heightLabel);
  grid.attach(heightSpin, 1, 2, 1, 1);

  const fillLabel = new Gtk.Label({
    label: _('Fill'),
    halign: Gtk.Align.END,
    valign: Gtk.Align.CENTER,
  });
  grid.attach(fillLabel, 0, 3, 1, 1);
  const fillDialog = new Gtk.ColorDialog({with_alpha: true});
  const fillBtn = new Gtk.ColorDialogButton({dialog: fillDialog});
  fillBtn.set_rgba(colorToRgba([1, 1, 1, 1]));
  setLabelledBy(fillBtn, fillLabel);
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

// Modal size entry for scaling the whole image. The aspect ratio is always
// locked: a non-uniform scale has no defined answer for a stamp's circle, a
// font size, or a stroke width, all of which are single scalars. The factor is
// taken from whichever field the user edited and the other two are derived
// from it, so the edited field is exact and only the derived ones are rounded.
export function showScaleImageDialog(
  parent: Gtk.Widget,
  width: number,
  height: number,
  onScale: (factor: number) => void
): void {
  const dialog = new Adw.AlertDialog({
    heading: _('Scale image'),
    body: `${_('Annotations are scaled with the image.')}\n${_('The aspect ratio is locked.')}`,
  });
  dialog.add_response('cancel', _('Cancel'));
  dialog.add_response('scale', _('Scale'));
  dialog.set_response_appearance('scale', Adw.ResponseAppearance.SUGGESTED);
  dialog.set_default_response('scale');
  dialog.set_close_response('cancel');

  // Both axes stay within the canvas dimension limits, so the percentage bounds
  // are derived from whichever axis reaches a limit first. An image already
  // larger than the maximum keeps its own size as the upper bound instead of
  // being unscalable.
  const maxDim = Math.max(CANVAS_SIZE_MAX, width, height);
  // The shorter axis reaches the 1px floor first, the longer one the ceiling.
  const minFactor = Math.max(CANVAS_SIZE_MIN / width, CANVAS_SIZE_MIN / height);
  const maxFactor = Math.min(maxDim / width, maxDim / height);

  // Centered rather than filling the dialog: the caption column is narrow, so
  // a full-width grid leaves the whole block sitting left of center.
  const grid = new Gtk.Grid({row_spacing: 8, column_spacing: 12, halign: Gtk.Align.CENTER});

  const makeSpin = (
    row: number,
    caption: string,
    lower: number,
    upper: number,
    digits: number,
    step: number
  ): Gtk.SpinButton => {
    const label = new Gtk.Label({
      label: caption,
      halign: Gtk.Align.END,
      valign: Gtk.Align.CENTER,
    });
    grid.attach(label, 0, row, 1, 1);
    const spin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 10,
      }),
      digits,
      width_request: 100,
      xalign: 1,
    });
    setLabelledBy(spin, label);
    grid.attach(spin, 1, row, 1, 1);
    return spin;
  };

  // Every field's range comes from the same factor bounds, so no two of them
  // can disagree about what the smallest or largest allowed size is.
  const percentSpin = makeSpin(0, _('Scale (%)'), minFactor * 100, maxFactor * 100, 1, 1);
  const widthSpin = makeSpin(
    1,
    _('Width'),
    Math.round(width * minFactor),
    Math.round(width * maxFactor),
    0,
    1
  );
  const heightSpin = makeSpin(
    2,
    _('Height'),
    Math.round(height * minFactor),
    Math.round(height * maxFactor),
    0,
    1
  );

  let factor = 1;
  let updating = false;
  const setFactor = (f: number, edited: Gtk.SpinButton): void => {
    if (updating || !Number.isFinite(f) || f <= 0) return;
    factor = f;
    updating = true;
    if (edited !== percentSpin) percentSpin.set_value(f * 100);
    if (edited !== widthSpin) widthSpin.set_value(Math.round(width * f));
    if (edited !== heightSpin) heightSpin.set_value(Math.round(height * f));
    updating = false;
  };
  percentSpin.connect('value-changed', () => setFactor(percentSpin.get_value() / 100, percentSpin));
  widthSpin.connect('value-changed', () => setFactor(widthSpin.get_value() / width, widthSpin));
  heightSpin.connect('value-changed', () => setFactor(heightSpin.get_value() / height, heightSpin));
  updating = true;
  percentSpin.set_value(100);
  widthSpin.set_value(width);
  heightSpin.set_value(height);
  updating = false;

  dialog.set_extra_child(grid);

  dialog.connect('response', (_d, response) => {
    if (response === 'scale') onScale(factor);
  });

  // Open with the percentage ready to type over, rather than on the Cancel
  // button. set_focus designates the widget before the dialog is mapped, so
  // nothing reassigns focus afterwards.
  dialog.set_focus(percentSpin);
  dialog.present(parent);
}

// "W × H px", the status bar's template, so the two read the same.
function dims(w: number, h: number): string {
  return _('%w \u00d7 %h px').replace('%w', String(w)).replace('%h', String(h));
}

// Replace the base image with a solid color. White by default, remembered
// nowhere: a background color and the crop/expand padding color are different
// things.
export function showReplaceBackgroundColorDialog(
  parent: Gtk.Widget,
  onReplace: (color: ColorRGBA) => void
): void {
  const dialog = new Adw.AlertDialog({
    heading: _('Replace background with color'),
    body: _('Annotations are kept.'),
  });
  dialog.add_response('cancel', _('Cancel'));
  dialog.add_response('replace', _('Replace'));
  dialog.set_response_appearance('replace', Adw.ResponseAppearance.SUGGESTED);
  dialog.set_default_response('replace');
  dialog.set_close_response('cancel');

  const controls = makeColorControls({onChosen: () => {}, swatch: true});
  controls.setColor([1, 1, 1, 1]);
  dialog.set_extra_child(controls.box);

  dialog.connect('response', (_d, response) => {
    if (response === 'replace') onReplace(controls.getColor());
  });
  dialog.set_focus(controls.entry);
  dialog.present(parent);
}

// The nine anchor positions in reading order, with the names used as tooltips
// and accessible labels.
const ANCHORS: ReadonlyArray<{x: AnchorFraction; y: AnchorFraction; name: string}> = [
  {x: 0, y: 0, name: _('Top left')},
  {x: 0.5, y: 0, name: _('Top center')},
  {x: 1, y: 0, name: _('Top right')},
  {x: 0, y: 0.5, name: _('Center left')},
  {x: 0.5, y: 0.5, name: _('Center')},
  {x: 1, y: 0.5, name: _('Center right')},
  {x: 0, y: 1, name: _('Bottom left')},
  {x: 0.5, y: 1, name: _('Bottom center')},
  {x: 1, y: 1, name: _('Bottom right')},
];

// An anchor button's icon: a 4:3 canvas outline centered in the area, with a
// filled marker at the anchor, in the widget's foreground color so it follows
// the theme.
export function drawAnchorIcon(
  cr: Cairo.Context,
  w: number,
  h: number,
  anchor: Anchor,
  rgb: [number, number, number]
): void {
  const rw = w - 3;
  const rh = Math.min(h - 3, Math.round(rw * 0.75));
  const x0 = (w - rw) / 2;
  const y0 = (h - rh) / 2;
  cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], 0.5);
  cr.setLineWidth(1);
  cr.rectangle(x0, y0, rw, rh);
  cr.stroke();
  const r = 3;
  const cx = x0 + r + (rw - 2 * r) * anchor.x;
  const cy = y0 + r + (rh - 2 * r) * anchor.y;
  cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
  cr.arc(cx, cy, r, 0, 2 * Math.PI);
  cr.fill();
}

// A 3x3 grid of toggle buttons choosing an Anchor; Center starts active.
function makeAnchorGrid(): {grid: Gtk.Grid; getAnchor: () => Anchor} {
  const grid = new Gtk.Grid({row_spacing: 2, column_spacing: 2, halign: Gtk.Align.START});
  let anchor: Anchor = {x: 0.5, y: 0.5};
  let group: Gtk.ToggleButton | null = null;
  ANCHORS.forEach((a, i) => {
    const icon = new Gtk.DrawingArea({width_request: 20, height_request: 20});
    icon.set_draw_func((widget, cr, w, h) => {
      const c = widget.get_color();
      drawAnchorIcon(cr, w, h, a, [c.red, c.green, c.blue]);
    });
    const btn = new Gtk.ToggleButton({
      child: icon,
      tooltip_text: a.name,
      active: a.x === anchor.x && a.y === anchor.y,
    });
    setAccessibleLabel(btn, a.name);
    if (group) btn.set_group(group);
    else group = btn;
    btn.connect('toggled', () => {
      if (btn.get_active()) anchor = {x: a.x, y: a.y};
    });
    grid.attach(btn, i % 3, Math.floor(i / 3), 1, 1);
  });
  return {grid, getAnchor: () => anchor};
}

// A titled group with the title centered above `child`: a bordered frame
// (the HTML fieldset) when it sits beside another group, a plain caption when
// it stands alone.
function fieldset(title: string, child: Gtk.Widget, bordered: boolean): Gtk.Widget {
  if (bordered) {
    child.margin_top = 10;
    child.margin_bottom = 10;
    child.margin_start = 12;
    child.margin_end = 12;
    return new Gtk.Frame({label: title, label_xalign: 0.5, child});
  }
  const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
  const label = new Gtk.Label({label: title, halign: Gtk.Align.CENTER});
  setLabelledBy(child, label);
  box.append(label);
  box.append(child);
  return box;
}

// Width of the image dialog's content. An alert dialog is content-sized,
// clamped to 372 px, or 600 px with prefer_wide_layout, so this request
// chooses the width the two fieldsets and the wrapped text get.
const REPLACE_DIALOG_WIDTH = 460;

// Replace the base image with an image of a different size. The canvas keeps
// its size: per axis, a larger image is cropped and a smaller one padded, and
// the anchor decides where the image sits. `fill` initializes the padding
// color; it is reported back only when padding occurs (the Fill group is
// hidden otherwise), so the caller can remember it.
export function showReplaceBackgroundImageDialog(
  parent: Gtk.Widget,
  image: {w: number; h: number},
  canvas: {w: number; h: number},
  fill: ColorRGBA,
  onReplace: (anchor: Anchor, fill: ColorRGBA | null) => void
): void {
  const cropX = image.w > canvas.w;
  const cropY = image.h > canvas.h;
  const padX = image.w < canvas.w;
  const padY = image.h < canvas.h;
  let effect: string;
  if ((cropX || cropY) && !(padX || padY)) {
    effect = _('The image will be cropped to fit the canvas.');
  } else if ((padX || padY) && !(cropX || cropY)) {
    effect = _('The canvas will be padded around the image.');
  } else if (cropX) {
    effect = _('The image will be cropped horizontally and the canvas padded vertically.');
  } else {
    effect = _('The image will be cropped vertically and the canvas padded horizontally.');
  }
  const sizes = _('The image is %i and the canvas is %c.')
    .replace('%i', dims(image.w, image.h))
    .replace('%c', dims(canvas.w, canvas.h));
  const advice = _(
    'To keep the whole image at its size, cancel and crop or expand the canvas to %s first.'
  ).replace('%s', dims(image.w, image.h));
  // The explanation is built here rather than as the dialog body, which an
  // alert dialog centers.
  const dialog = new Adw.AlertDialog({
    heading: _('Replace background with image'),
    prefer_wide_layout: true,
  });
  dialog.add_response('cancel', _('Cancel'));
  dialog.add_response('replace', _('Replace'));
  dialog.set_response_appearance('replace', Adw.ResponseAppearance.SUGGESTED);
  dialog.set_default_response('replace');
  dialog.set_close_response('cancel');

  const content = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 12,
    width_request: REPLACE_DIALOG_WIDTH,
  });
  // max_width_chars keeps a wrapping label's natural width small, so the box
  // width, not the text length, decides the dialog width.
  const paragraph = (text: string): Gtk.Label =>
    new Gtk.Label({label: text, wrap: true, xalign: 0, max_width_chars: 40});
  content.append(paragraph(`${sizes} ${effect}`));
  content.append(paragraph(advice));

  const showFill = padX || padY;
  const groups = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 12});
  const anchors = makeAnchorGrid();
  anchors.grid.set_halign(Gtk.Align.CENTER);
  anchors.grid.set_valign(Gtk.Align.START);
  const anchorGroup = fieldset(_('Alignment'), anchors.grid, showFill);
  anchorGroup.set_hexpand(!showFill);
  groups.append(anchorGroup);
  let controls: ReturnType<typeof makeColorControls> | null = null;
  if (showFill) {
    controls = makeColorControls({onChosen: () => {}, swatch: true});
    controls.setColor(fill);
    controls.box.set_valign(Gtk.Align.START);
    const fillGroup = fieldset(_('Fill'), controls.box, true);
    fillGroup.set_hexpand(true);
    groups.append(fillGroup);
  }
  content.append(groups);
  dialog.set_extra_child(content);

  dialog.connect('response', (_d, response) => {
    if (response !== 'replace') return;
    onReplace(anchors.getAnchor(), controls ? controls.getColor() : null);
  });
  dialog.present(parent);
}
