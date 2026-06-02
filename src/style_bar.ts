import Gtk from 'gi://Gtk?version=4.0';
import Cairo from 'cairo';

import {CanvasView} from './canvas_view.js';
import {TextEditor, TextEditorStyle} from './text_editor.js';
import {getAvailableFonts} from './font_catalogue.js';
import {colorToHex, colorToRgba, parseHexColor, rgbaToColor} from './gdk_color.js';
import {DASH_ORDER} from './window_constants.js';
import {_, formatN} from './i18n.js';
import {
  Action,
  ColorRGBA,
  DEFAULT_DASH,
  DashStyle,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  StampVariant,
  WIDTH_MAX,
  WIDTH_MIN,
  defaultDashForTool,
  defaultFillForTool,
  defaultFilledHeadForTool,
  defaultFontDescForTool,
  defaultFontSizeForTool,
  defaultWidthForTool,
  numberStampGroup,
  numberStampVariant,
} from './actions.js';

// Structural equality for style values (color arrays or scalar primitives),
// used to detect a multi-selection that disagrees on a property.
function styleValuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

// Set a control's caption, appending " (mixed)" when the selected actions
// disagree on that property — the disclosure that editing the control will
// flatten them to one value.
function setCaption(label: Gtk.Label, base: string, mixed: boolean): void {
  label.set_label(mixed ? `${base} ${_('(mixed)')}` : base);
}

// Paint a color swatch: a checkerboard (so transparency reads as such) with the
// color over it and a hairline border, matching the look of the stock color
// button we replaced.
function drawSwatch(cr: Cairo.Context, w: number, h: number, color: ColorRGBA): void {
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

// The top style bar: per-tool/selection style pickers (color, fill, width,
// dash, stamp variant, font, font size). Owns its widgets and the picker
// signal handlers; reads tool/selection/editor state through the canvas and
// editor refs and writes style changes back through them. The window holds one
// instance, adds getWidget() to its toolbar, and calls refresh() whenever the
// canvas state changes (tool switch, selection change, edit lifecycle).
export class StyleBar {
  private widget: Gtk.Box;
  // Color/Fill are custom swatch buttons. Clicking one opens a popover with an
  // inline hex entry + opacity slider (drag opacity to 0 for transparent / no
  // fill) and a "Palette…" button into the full system Gtk.ColorDialog
  // (palette + custom hex editor + screen picker). We drive the dialog
  // ourselves so a pick commits even when it equals the shown color —
  // flattening a mixed selection — which a stock Gtk.ColorDialogButton's
  // *changed*-only notify would drop. `*SwatchSet` repaints the swatch.
  private colorGroup!: Gtk.Box;
  private colorLabel!: Gtk.Label;
  private colorSwatchSet!: (c: ColorRGBA | null) => void;
  private fillGroup!: Gtk.Box;
  private fillLabel!: Gtk.Label;
  private fillSwatchSet!: (c: ColorRGBA | null) => void;
  private widthScale!: Gtk.Scale;
  private widthPreview!: Gtk.DrawingArea;
  private widthGroup!: Gtk.Box;
  private widthLabel!: Gtk.Label;
  private dashGroup!: Gtk.Box;
  private dashLabel!: Gtk.Label;
  private dashDropdown!: Gtk.DropDown;
  // Filled-arrowhead selector (arrow only): Open (stroked) vs Filled (solid
  // triangle). A 2-row dropdown to match the Dash/Variant idiom.
  private filledHeadGroup!: Gtk.Box;
  private filledHeadLabel!: Gtk.Label;
  private filledHeadDropdown!: Gtk.DropDown;
  // Group selector for the number stamp: choose the placement group (number
  // tool) or reassign the selected stamps (select tool). The model is rebuilt
  // each refresh from the canvas's live group list, with a trailing "+ New
  // group" entry; `groupIds` maps a row index back to a stable group id.
  private groupGroup!: Gtk.Box;
  private groupLabel!: Gtk.Label;
  private groupDropdown!: Gtk.DropDown;
  private groupModel!: Gtk.StringList;
  private groupIds: number[] = [];
  private variantGroup!: Gtk.Box;
  private variantLabel!: Gtk.Label;
  private variantDropdown!: Gtk.DropDown;
  // Select-mode action (not a style picker): duplicates the current selection.
  // Visible only when the select tool has something selected.
  private duplicateGroup!: Gtk.Box;
  private fontGroup!: Gtk.Box;
  private fontLabel!: Gtk.Label;
  private fontDropdown!: Gtk.DropDown;
  private fontSizeLabel!: Gtk.Label;
  private fontSizeSpinner!: Gtk.SpinButton;
  // Ordered (group, separator) pairs for the first-visible-separator logic
  // in refresh().
  private styleGroupOrder: Array<{group: Gtk.Box; sep: Gtk.Separator}> = [];
  // Guard against the programmatic set_rgba() / set_value() we do in refresh()
  // firing change signals and looping back into the user-edit handlers.
  private updatingPicker = false;

  constructor(
    private canvas: InstanceType<typeof CanvasView>,
    private editor: TextEditor
  ) {
    this.widget = this.build();
  }

  getWidget(): Gtk.Box {
    return this.widget;
  }

  private build(): Gtk.Box {
    const styleBar = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      margin_start: 12,
      margin_end: 12,
      margin_top: 4,
      margin_bottom: 4,
      // Fixed height so the bar always occupies the same space regardless
      // of which groups are visible. Without this, hiding/showing groups
      // resizes the canvas and shifts the image.
      height_request: WIDTH_MAX + 4,
    });

    const makeSep = (): Gtk.Separator =>
      new Gtk.Separator({
        orientation: Gtk.Orientation.VERTICAL,
        margin_start: 8,
        margin_end: 8,
      });

    const makeGroup = (sep: Gtk.Separator, ...children: Gtk.Widget[]): Gtk.Box => {
      const g = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
      g.append(sep);
      for (const c of children) g.append(c);
      return g;
    };

    // Duplicate group — a select-mode action, not a style picker. Leads the
    // bar so it sits left of the per-property controls. Ctrl+D is the keyboard
    // equivalent (window.ts).
    const duplicateSep = makeSep();
    const duplicateBtn = new Gtk.Button({
      icon_name: 'edit-copy-symbolic',
      tooltip_text: _('Duplicate selection (Ctrl+D)'),
      valign: Gtk.Align.CENTER,
    });
    duplicateBtn.connect('clicked', () => this.canvas.cloneSelected());
    this.duplicateGroup = makeGroup(duplicateSep, duplicateBtn);
    styleBar.append(this.duplicateGroup);

    // Color group
    const colorSep = makeSep();
    const colorSwatch = this.makeSwatchButton((c) => this.onColorPicked(c));
    this.colorSwatchSet = colorSwatch.setColor;
    this.colorLabel = new Gtk.Label({label: _('Color'), css_classes: ['caption']});
    this.colorGroup = makeGroup(colorSep, this.colorLabel, colorSwatch.button);
    styleBar.append(this.colorGroup);

    // Fill group
    const fillSep = makeSep();
    const fillSwatch = this.makeSwatchButton((c) => this.onFillPicked(c));
    this.fillSwatchSet = fillSwatch.setColor;
    this.fillLabel = new Gtk.Label({label: _('Fill'), css_classes: ['caption']});
    this.fillGroup = makeGroup(fillSep, this.fillLabel, fillSwatch.button);
    styleBar.append(this.fillGroup);

    // Width group
    const widthSep = makeSep();
    this.widthScale = new Gtk.Scale({
      orientation: Gtk.Orientation.HORIZONTAL,
      adjustment: new Gtk.Adjustment({
        lower: WIDTH_MIN,
        upper: WIDTH_MAX,
        step_increment: 1,
        page_increment: 5,
      }),
      digits: 0,
      draw_value: true,
      value_pos: Gtk.PositionType.RIGHT,
      width_request: 160,
    });
    this.widthScale.connect('value-changed', () => this.onWidthPicked());
    this.widthPreview = new Gtk.DrawingArea({
      width_request: 56,
      height_request: WIDTH_MAX + 4,
      valign: Gtk.Align.CENTER,
    });
    this.widthPreview.set_draw_func((_w, cr, w, h) => this.drawWidthPreview(cr, w, h));
    this.widthLabel = new Gtk.Label({label: _('Width'), css_classes: ['caption']});
    this.widthGroup = makeGroup(widthSep, this.widthLabel, this.widthScale, this.widthPreview);
    styleBar.append(this.widthGroup);

    // Dash group — selector index maps to DashStyle via DASH_ORDER below.
    const dashSep = makeSep();
    this.dashDropdown = Gtk.DropDown.new_from_strings([_('Solid'), _('Dashed'), _('Dotted')]);
    this.dashDropdown.connect('notify::selected', () => this.onDashPicked());
    this.dashLabel = new Gtk.Label({label: _('Line'), css_classes: ['caption']});
    this.dashGroup = makeGroup(dashSep, this.dashLabel, this.dashDropdown);
    styleBar.append(this.dashGroup);

    // Arrowhead group (arrow only) — row 0 = open, row 1 = filled.
    const filledHeadSep = makeSep();
    this.filledHeadDropdown = Gtk.DropDown.new_from_strings([_('Open'), _('Filled')]);
    this.filledHeadDropdown.connect('notify::selected', () => this.onFilledHeadPicked());
    this.filledHeadLabel = new Gtk.Label({label: _('Arrowhead'), css_classes: ['caption']});
    this.filledHeadGroup = makeGroup(filledHeadSep, this.filledHeadLabel, this.filledHeadDropdown);
    styleBar.append(this.filledHeadGroup);

    // Group selector (stamp). Rows are filled in refresh() from the canvas's
    // group list; the model starts empty.
    const groupSep = makeSep();
    this.groupModel = Gtk.StringList.new([]);
    this.groupDropdown = new Gtk.DropDown({model: this.groupModel});
    this.groupDropdown.connect('notify::selected', () => this.onGroupPicked());
    this.groupLabel = new Gtk.Label({label: _('Group'), css_classes: ['caption']});
    this.groupGroup = makeGroup(groupSep, this.groupLabel, this.groupDropdown);
    styleBar.append(this.groupGroup);

    // Variant group
    const variantSep = makeSep();
    this.variantDropdown = Gtk.DropDown.new_from_strings([_('Number'), _('Letter')]);
    this.variantDropdown.connect('notify::selected', () => this.onVariantPicked());
    this.variantLabel = new Gtk.Label({label: _('Variant'), css_classes: ['caption']});
    this.variantGroup = makeGroup(variantSep, this.variantLabel, this.variantDropdown);
    styleBar.append(this.variantGroup);

    // Font group
    const fontSep = makeSep();
    this.fontDropdown = Gtk.DropDown.new_from_strings(getAvailableFonts().map((f) => f.label));
    this.fontDropdown.connect('notify::selected', () => this.onFontDescPicked());
    this.fontSizeSpinner = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: FONT_SIZE_MIN,
        upper: FONT_SIZE_MAX,
        step_increment: 1,
        page_increment: 4,
      }),
      digits: 0,
      width_request: 64,
    });
    this.fontSizeSpinner.add_css_class('annoscr-font-size');
    this.fontSizeSpinner.connect('value-changed', () => this.onFontSizePicked());
    this.fontLabel = new Gtk.Label({label: _('Font'), css_classes: ['caption']});
    this.fontSizeLabel = new Gtk.Label({
      label: _('Size'),
      css_classes: ['caption'],
      margin_start: 6,
    });
    this.fontGroup = makeGroup(
      fontSep,
      this.fontLabel,
      this.fontDropdown,
      this.fontSizeLabel,
      this.fontSizeSpinner
    );
    styleBar.append(this.fontGroup);

    this.styleGroupOrder = [
      {group: this.duplicateGroup, sep: duplicateSep},
      {group: this.colorGroup, sep: colorSep},
      {group: this.fillGroup, sep: fillSep},
      {group: this.widthGroup, sep: widthSep},
      {group: this.dashGroup, sep: dashSep},
      {group: this.filledHeadGroup, sep: filledHeadSep},
      {group: this.groupGroup, sep: groupSep},
      {group: this.variantGroup, sep: variantSep},
      {group: this.fontGroup, sep: fontSep},
    ];

    return styleBar;
  }

  // A color swatch button whose popover holds an inline hex entry + opacity
  // slider and a button into the full system Gtk.ColorDialog. Every path
  // reports the chosen color via `onChosen` even when it equals the shown one
  // (so a mixed selection flattens). Returns the button plus a setter that
  // repaints the swatch.
  private makeSwatchButton(onChosen: (color: ColorRGBA) => void): {
    button: Gtk.MenuButton;
    setColor: (c: ColorRGBA | null) => void;
  } {
    let current: ColorRGBA = [0, 0, 0, 1];
    // Suppress the entry/slider change handlers while we set their values
    // programmatically (on popup, or when one control drives the other).
    let syncing = false;

    const area = new Gtk.DrawingArea({
      width_request: 28,
      height_request: 20,
      valign: Gtk.Align.CENTER,
    });
    area.set_draw_func((_w, cr, w, h) => drawSwatch(cr, w, h, current));
    // A MenuButton (not a plain Button + set_parent'd popover): it owns the
    // popover and unparents it on dispose, avoiding the "Finalizing GtkButton …
    // still has children left" warning at quit. No dropdown arrow because the
    // swatch is a custom child and always-show-arrow defaults off.
    const button = new Gtk.MenuButton({child: area, tooltip_text: _('Pick a color')});

    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 8,
      margin_top: 8,
      margin_bottom: 8,
      margin_start: 8,
      margin_end: 8,
    });

    const hexRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
    hexRow.append(new Gtk.Label({label: _('Hex'), css_classes: ['caption']}));
    const hexEntry = new Gtk.Entry({
      max_length: 9,
      width_chars: 9,
      hexpand: true,
      tooltip_text: _('#RGB, #RGBA, #RRGGBB, or #RRGGBBAA'),
    });
    hexRow.append(hexEntry);
    box.append(hexRow);

    const opacityRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
    opacityRow.append(new Gtk.Label({label: _('Opacity'), css_classes: ['caption']}));
    const opacityScale = new Gtk.Scale({
      orientation: Gtk.Orientation.HORIZONTAL,
      adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 10}),
      digits: 0,
      draw_value: true,
      value_pos: Gtk.PositionType.RIGHT,
      hexpand: true,
      width_request: 160,
      // Adds a left margin on the value node so the number isn't flush against
      // the thumb at 100 (see WINDOW_CSS in window_constants.ts).
      css_classes: ['annoscr-opacity-scale'],
    });
    opacityRow.append(opacityScale);
    box.append(opacityRow);

    const paletteBtn = new Gtk.Button({label: _('Palette…')});
    box.append(paletteBtn);

    const popover = new Gtk.Popover({autohide: true});
    popover.set_child(box);
    button.set_popover(popover);

    const commit = (c: ColorRGBA): void => {
      current = c;
      area.queue_draw();
      onChosen(c);
    };

    // Reflect `current` into the entry + slider without re-triggering commits.
    const syncControls = (): void => {
      syncing = true;
      hexEntry.set_text(colorToHex(current));
      opacityScale.set_value(Math.round(current[3] * 100));
      syncing = false;
    };

    const applyHex = (): void => {
      const parsed = parseHexColor(hexEntry.get_text());
      if (!parsed) {
        // Invalid input: snap the entry back to the live color.
        syncing = true;
        hexEntry.set_text(colorToHex(current));
        syncing = false;
        return;
      }
      // 6-digit keeps the current opacity; 8-digit carries its own alpha.
      const alpha = parsed.hadAlpha ? parsed.color[3] : current[3];
      const next: ColorRGBA = [parsed.color[0], parsed.color[1], parsed.color[2], alpha];
      // Only commit a real edit. Without this, merely opening the popover and
      // dismissing it (focus-leave with unchanged text) would commit — and on a
      // mixed multi-selection that would silently flatten it. An intentional
      // change still commits (and flattens a mixed selection) as expected.
      if (!next.every((v, i) => v === current[i])) commit(next);
      // syncControls() normalizes the text via set_text(), which parks the
      // cursor at position 0; move it to the end so editing resumes naturally.
      syncControls();
      hexEntry.set_position(-1);
    };
    hexEntry.connect('activate', applyHex);
    // Also apply when focus leaves the entry, so typing then clicking the
    // slider/another control commits without needing Enter.
    const focusCtl = new Gtk.EventControllerFocus();
    focusCtl.connect('leave', applyHex);
    hexEntry.add_controller(focusCtl);

    opacityScale.connect('value-changed', () => {
      if (syncing) return;
      commit([current[0], current[1], current[2], opacityScale.get_value() / 100]);
    });

    const dialog = new Gtk.ColorDialog({with_alpha: true});
    paletteBtn.connect('clicked', () => {
      popover.popdown();
      const root = button.get_root() as Gtk.Window | null;
      // Callback form (not the promise overload) — the project doesn't rely on
      // GJS promisifying GTK async methods. choose_rgba_finish throws when the
      // dialog is dismissed/cancelled, which we treat as "no change".
      dialog.choose_rgba(root, colorToRgba(current), null, (_source, res) => {
        try {
          const rgba = dialog.choose_rgba_finish(res);
          if (rgba) commit(rgbaToColor(rgba));
        } catch {
          // Cancelled or dismissed — leave the selection untouched.
        }
      });
    });

    // MenuButton shows the popover itself; sync the entry/slider to the live
    // color just before it opens (create-popup-func runs pre-show, so there's
    // no flash of stale values).
    button.set_create_popup_func(() => syncControls());

    return {
      button,
      setColor: (c: ColorRGBA | null) => {
        if (c) {
          current = c;
          area.queue_draw();
        }
      },
    };
  }

  private drawWidthPreview(cr: Cairo.Context, w: number, h: number): void {
    const color = this.styleTargetColor();
    const width = this.styleTargetWidth();
    if (color === null || width === null) return;
    // Cap visible thickness to the preview height so the full slider range
    // still fits visually; the slider's numeric readout carries the exact
    // value when the bar saturates.
    const drawWidth = Math.min(width, h - 2);
    cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
    cr.setLineWidth(drawWidth);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.moveTo(8, h / 2);
    cr.lineTo(w - 8, h / 2);
    cr.stroke();
  }

  refresh(): void {
    if (!this.colorGroup) return;
    this.updatingPicker = true;

    // Duplicate is a select-mode action on the current selection — show it only
    // when the select tool has something picked (and not during a text edit).
    this.duplicateGroup.set_visible(
      this.canvas.getTool() === 'select' &&
        !this.editor.isActive() &&
        this.canvas.getSelectedActions().length > 0
    );

    const color = this.styleTargetColor();
    this.colorGroup.set_visible(color !== null);
    this.colorSwatchSet(color);
    setCaption(
      this.colorLabel,
      _('Color'),
      this.selectionMixed((a) => a.getColor())
    );

    const fill = this.styleTargetFill();
    this.fillGroup.set_visible(fill !== null);
    this.fillSwatchSet(fill);
    setCaption(
      this.fillLabel,
      _('Fill'),
      this.selectionMixed((a) => a.getFill())
    );

    const width = this.styleTargetWidth();
    this.widthGroup.set_visible(width !== null);
    if (width !== null) this.widthScale.set_value(width);
    setCaption(
      this.widthLabel,
      _('Width'),
      this.selectionMixed((a) => a.getWidth())
    );

    const dash = this.styleTargetDash();
    this.dashGroup.set_visible(dash !== null);
    if (dash !== null) this.dashDropdown.set_selected(Math.max(0, DASH_ORDER.indexOf(dash)));
    setCaption(
      this.dashLabel,
      _('Line'),
      this.selectionMixed((a) => a.getDash())
    );

    const filledHead = this.styleTargetFilledHead();
    this.filledHeadGroup.set_visible(filledHead !== null);
    if (filledHead !== null) this.filledHeadDropdown.set_selected(filledHead ? 1 : 0);
    setCaption(
      this.filledHeadLabel,
      _('Arrowhead'),
      this.selectionMixed((a) => a.getFilledHead())
    );

    this.refreshStampControls();

    const fontDesc = this.styleTargetFontDesc();
    this.fontGroup.set_visible(fontDesc !== null);
    if (fontDesc !== null) {
      const idx = getAvailableFonts().findIndex((f) => f.family === fontDesc);
      this.fontDropdown.set_selected(idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION);
    }
    setCaption(
      this.fontLabel,
      _('Font'),
      this.selectionMixed((a) => a.getFontDesc())
    );
    const fontSize = this.styleTargetFontSize();
    if (fontSize !== null) {
      this.fontSizeSpinner.set_value(fontSize);
    }
    setCaption(
      this.fontSizeLabel,
      _('Size'),
      this.selectionMixed((a) => a.getFontSize())
    );

    // Hide the leading separator on the first visible group so there's no
    // orphan divider at the left edge.
    let firstVisible = true;
    for (const {group, sep} of this.styleGroupOrder) {
      if (group.get_visible()) {
        sep.set_visible(!firstVisible);
        firstVisible = false;
      }
    }

    this.updatingPicker = false;
    this.widthPreview.queue_draw();
  }

  // Patch the editor's current style with new field values from a picker
  // change so the live TextView and the eventual commit both reflect the
  // user's latest pick. The editor (not toolColors / the selected action)
  // is the source of truth for style while an edit is in progress.
  private patchEditorStyle(overrides: Partial<TextEditorStyle>): void {
    if (!this.editor.isActive()) return;
    const current = this.editor.getCurrentStyle();
    if (!current) return;
    this.editor.refreshStyle({...current, ...overrides});
  }

  // The Group selector and per-group Variant control (both number-stamp only).
  // Pulled out of refresh() so each stays simple. Group shows for the number
  // tool (picks the placement group) and for a stamps-only selection (reassigns
  // it); Variant shows the active group's value (placement) or the selection's
  // (select), flagging "(mixed)" when selected stamps disagree.
  private refreshStampControls(): void {
    const tool = this.canvas.getTool();

    // Populated groups are the reassignment targets shown in select mode. The
    // number tool additionally folds in its placement group, which may still be
    // empty (a fresh "+ New group") — that's the one empty group allowed to show.
    const present = this.canvas.getStampGroupIds();
    const placement = this.canvas.getPlacementGroupId();
    const groupIds =
      tool === 'number' && !present.includes(placement)
        ? [...present, placement].sort((a, b) => a - b)
        : present;
    this.groupIds = groupIds;
    const groupSummary = this.selectionSummary((a) => numberStampGroup(a));
    const groupVisible = tool === 'number' || (tool === 'select' && groupSummary.value !== null);
    this.groupGroup.set_visible(groupVisible);
    if (groupVisible) {
      this.rebuildGroupModel(groupIds.length);
      let selectedRow = Gtk.INVALID_LIST_POSITION;
      let groupMixed = false;
      if (tool === 'number') {
        selectedRow = groupIds.indexOf(this.canvas.getPlacementGroupId());
      } else if (groupSummary.mixed) {
        groupMixed = true;
      } else if (groupSummary.value !== null) {
        selectedRow = groupIds.indexOf(groupSummary.value);
      }
      this.groupDropdown.set_selected(selectedRow >= 0 ? selectedRow : Gtk.INVALID_LIST_POSITION);
      setCaption(this.groupLabel, _('Group'), groupMixed);
    }

    const variantValue: StampVariant | null =
      tool === 'number'
        ? this.canvas.getPlacementGroupVariant()
        : tool === 'select'
          ? this.selectionSummary((a) => numberStampVariant(a)).value
          : null;
    this.variantGroup.set_visible(variantValue !== null);
    if (variantValue !== null) {
      this.variantDropdown.set_selected(variantValue === 'letter' ? 1 : 0);
    }
    setCaption(
      this.variantLabel,
      _('Variant'),
      this.selectionMixed((a) => numberStampVariant(a))
    );
  }

  // Rebuild the group dropdown rows to "Group 1..count" plus a trailing
  // "+ New group". Labels are positional (gap-free); groupIds (set in refresh)
  // carries the index → stable id mapping the handlers use.
  private rebuildGroupModel(count: number): void {
    const labels: string[] = [];
    for (let i = 0; i < count; i++) labels.push(formatN(_('Group %d'), i + 1));
    labels.push(_('+ New group'));
    this.groupModel.splice(0, this.groupModel.get_n_items(), labels);
  }

  private onGroupPicked(): void {
    if (this.updatingPicker || !this.groupDropdown) return;
    const row = this.groupDropdown.get_selected();
    if (row === Gtk.INVALID_LIST_POSITION) return;
    // The trailing row past the real groups is "+ New group".
    const isNew = row >= this.groupIds.length;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      this.canvas.reassignSelectedGroup(isNew ? 'new' : this.groupIds[row]);
    } else if (isNew) {
      this.canvas.newPlacementGroup();
    } else {
      this.canvas.setPlacementGroup(this.groupIds[row]);
    }
    // Resync the row in case the action was a no-op (e.g. "+ New group" while
    // the current group is already empty) and so produced no state change.
    this.refresh();
  }

  private onVariantPicked(): void {
    if (this.updatingPicker || !this.variantDropdown) return;
    const variant: StampVariant = this.variantDropdown.get_selected() === 1 ? 'letter' : 'number';
    if (this.canvas.getTool() === 'select') {
      this.canvas.setSelectedGroupsVariant(variant);
    } else {
      this.canvas.setPlacementGroupVariant(variant);
    }
  }

  private onFontDescPicked(): void {
    if (this.updatingPicker || !this.fontDropdown) return;
    const idx = this.fontDropdown.get_selected();
    if (idx === Gtk.INVALID_LIST_POSITION) return;
    const fonts = getAvailableFonts();
    if (idx >= fonts.length) return;
    const fontDesc = fonts[idx].family;
    const tool = this.canvas.getTool();
    const editorActive = this.editor.isActive();
    // Active edit → flow into the editor (which propagates to commit and
    // updates the live preview + caret focus). Outside an edit, fall back
    // to the standard select-vs-tool routing. Sticky tool default also
    // updates for text-tool placements so the next click inherits.
    if (editorActive) {
      this.patchEditorStyle({fontDesc});
    } else if (tool === 'select') {
      this.canvas.replaceSelectedFontDesc(fontDesc);
    }
    if (defaultFontDescForTool(tool) !== null) {
      this.canvas.setToolFontDesc(tool, fontDesc);
    }
  }

  private onFontSizePicked(): void {
    if (this.updatingPicker || !this.fontSizeSpinner) return;
    const size = Math.round(this.fontSizeSpinner.get_value());
    const tool = this.canvas.getTool();
    const editorActive = this.editor.isActive();
    if (editorActive) {
      this.patchEditorStyle({size});
    } else if (tool === 'select') {
      this.canvas.replaceSelectedFontSize(size);
    }
    if (defaultFontSizeForTool(tool) !== null) {
      this.canvas.setToolFontSize(tool, size);
    }
  }

  // Summarize a style property over the whole selection. A control is
  // "applicable" only when EVERY selected action carries the property (its
  // getter is non-null) — that's the shared-control rule. The displayed value
  // is the first selected action's; `mixed` flags that they don't all agree.
  // Empty selection or any non-carrying member → not applicable.
  private selectionSummary<T>(get: (a: Action) => T | null): {value: T | null; mixed: boolean} {
    const sel = this.canvas.getSelectedActions();
    if (sel.length === 0) return {value: null, mixed: false};
    let value: T | null = null;
    let have = false;
    let mixed = false;
    for (const a of sel) {
      const v = get(a);
      if (v === null) return {value: null, mixed: false};
      if (!have) {
        value = v;
        have = true;
      } else if (!styleValuesEqual(value, v)) {
        mixed = true;
      }
    }
    return {value, mixed};
  }

  // Whether the current select-mode multi-selection disagrees on a property,
  // so refresh() can flag the control's caption as "(mixed)". Never mixed
  // outside select mode or during an edit (single source of truth there).
  private selectionMixed<T>(get: (a: Action) => T | null): boolean {
    if (this.canvas.getTool() !== 'select' || this.editor.isActive()) return false;
    return this.selectionSummary(get).mixed;
  }

  private styleTargetFontSize(): number | null {
    if (this.editor.isActive()) {
      return this.editor.getCurrentStyle()?.size ?? null;
    }
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getFontSize()).value;
    }
    return this.canvas.getToolFontSize(tool);
  }

  private styleTargetFontDesc(): string | null {
    // During an active edit the editor owns the style; show what it has
    // (and therefore what will be committed), not the selected action or
    // tool default.
    if (this.editor.isActive()) {
      return this.editor.getCurrentStyle()?.fontDesc ?? null;
    }
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getFontDesc()).value;
    }
    return this.canvas.getToolFontDesc(tool);
  }

  // The color that the picker should currently display, or null when the
  // picker has no meaningful color to show (and should be disabled).
  private styleTargetColor(): ColorRGBA | null {
    if (this.editor.isActive()) {
      return this.editor.getCurrentStyle()?.color ?? null;
    }
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getColor()).value;
    }
    return this.canvas.getToolColor(tool);
  }

  private styleTargetWidth(): number | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getWidth()).value;
    }
    return this.canvas.getToolWidth(tool);
  }

  private styleTargetFill(): ColorRGBA | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getFill()).value;
    }
    return this.canvas.getToolFill(tool);
  }

  private styleTargetDash(): DashStyle | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getDash()).value;
    }
    return this.canvas.getToolDash(tool);
  }

  // Filled-arrowhead state to display, or null when no applicable target (text
  // edit, or a tool/selection with no arrowhead). `false` is a real value, so
  // callers must compare against null, not test truthiness.
  private styleTargetFilledHead(): boolean | null {
    if (this.editor.isActive()) return null;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getFilledHead()).value;
    }
    return this.canvas.getToolFilledHead(tool);
  }

  // Called from the fill swatch's dialog on OK (with the chosen color), so it
  // commits even when the color equals the one shown — broadcasting to every
  // selected action flattens a mixed selection as intended.
  private onFillPicked(fill: ColorRGBA): void {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      // Same select-edit shape as the color picker; coalesce-by-key gives
      // a single history entry for a drag (see pushState in canvas_view.ts).
      this.canvas.replaceSelectedFill(fill);
    } else if (defaultFillForTool(tool) !== null) {
      this.canvas.setToolFill(tool, fill);
    }
    this.widthPreview.queue_draw();
  }

  private onDashPicked(): void {
    if (this.updatingPicker || !this.dashDropdown) return;
    const dash = DASH_ORDER[this.dashDropdown.get_selected()] ?? DEFAULT_DASH;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      // Same select-edit shape as the other pickers; coalesce-by-key keeps a
      // rapid re-pick to one history entry (see pushState in canvas_view.ts).
      this.canvas.replaceSelectedDash(dash);
    } else if (defaultDashForTool(tool) !== null) {
      this.canvas.setToolDash(tool, dash);
    }
  }

  private onFilledHeadPicked(): void {
    if (this.updatingPicker || !this.filledHeadDropdown) return;
    const filled = this.filledHeadDropdown.get_selected() === 1;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      this.canvas.replaceSelectedFilledHead(filled);
    } else if (defaultFilledHeadForTool(tool) !== null) {
      this.canvas.setToolFilledHead(tool, filled);
    }
  }

  // Called from the color swatch's dialog on OK (with the chosen color); see
  // onFillPicked for why this commits regardless of whether the value changed.
  private onColorPicked(color: ColorRGBA): void {
    const tool = this.canvas.getTool();
    const editorActive = this.editor.isActive();
    // Same routing as the font picker: editor wins during an active edit;
    // otherwise apply to selection or tool default. Tool default updates
    // for any non-select tool so picker changes are sticky.
    if (editorActive) {
      this.patchEditorStyle({color});
    } else if (tool === 'select') {
      // Recolor the selected action in place. No-op if no action selected
      // or its color isn't editable (refresh() will have already
      // disabled the picker in that case, but guard anyway).
      this.canvas.replaceSelectedColor(color);
    }
    if (tool !== 'select' && tool !== 'resize') {
      this.canvas.setToolColor(tool, color);
    }
    this.widthPreview.queue_draw();
  }

  private onWidthPicked(): void {
    if (this.updatingPicker || !this.widthScale) return;
    const width = Math.round(this.widthScale.get_value());
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      // In select mode, recolor → resize in-place; same select-edit shape.
      // pushState coalesces by `width:${i}` so a drag is one history entry,
      // not one per slider tick (see pushState in canvas_view.ts).
      this.canvas.replaceSelectedWidth(width);
    } else if (defaultWidthForTool(tool) !== null) {
      this.canvas.setToolWidth(tool, width);
    }
    this.widthPreview.queue_draw();
  }
}
