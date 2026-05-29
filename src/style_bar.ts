import Gtk from 'gi://Gtk?version=4.0';
import Cairo from 'cairo';

import {CanvasView} from './canvas_view.js';
import {TextEditor, TextEditorStyle} from './text_editor.js';
import {getAvailableFonts} from './font_catalogue.js';
import {colorToRgba, rgbaToColor} from './gdk_color.js';
import {DASH_ORDER} from './window_constants.js';
import {
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
  defaultFontDescForTool,
  defaultFontSizeForTool,
  defaultWidthForTool,
} from './actions.js';

// The top style bar: per-tool/selection style pickers (color, fill, width,
// dash, stamp variant, font, font size). Owns its widgets and the picker
// signal handlers; reads tool/selection/editor state through the canvas and
// editor refs and writes style changes back through them. The window holds one
// instance, adds getWidget() to its toolbar, and calls refresh() whenever the
// canvas state changes (tool switch, selection change, edit lifecycle).
export class StyleBar {
  private widget: Gtk.Box;
  private colorButton!: Gtk.ColorDialogButton;
  private colorGroup!: Gtk.Box;
  private fillButton!: Gtk.ColorDialogButton;
  private fillGroup!: Gtk.Box;
  private widthScale!: Gtk.Scale;
  private widthPreview!: Gtk.DrawingArea;
  private widthGroup!: Gtk.Box;
  private dashGroup!: Gtk.Box;
  private dashDropdown!: Gtk.DropDown;
  private variantGroup!: Gtk.Box;
  private variantDropdown!: Gtk.DropDown;
  private fontGroup!: Gtk.Box;
  private fontDropdown!: Gtk.DropDown;
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

    // Color group
    const colorSep = makeSep();
    this.colorButton = new Gtk.ColorDialogButton({
      dialog: new Gtk.ColorDialog({with_alpha: true}),
    });
    this.colorButton.connect('notify::rgba', () => this.onColorPicked());
    this.colorGroup = makeGroup(
      colorSep,
      new Gtk.Label({label: 'Color', css_classes: ['caption']}),
      this.colorButton
    );
    styleBar.append(this.colorGroup);

    // Fill group
    const fillSep = makeSep();
    this.fillButton = new Gtk.ColorDialogButton({
      dialog: new Gtk.ColorDialog({with_alpha: true}),
    });
    this.fillButton.connect('notify::rgba', () => this.onFillPicked());
    this.fillGroup = makeGroup(
      fillSep,
      new Gtk.Label({label: 'Fill', css_classes: ['caption']}),
      this.fillButton
    );
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
    this.widthGroup = makeGroup(
      widthSep,
      new Gtk.Label({label: 'Width', css_classes: ['caption']}),
      this.widthScale,
      this.widthPreview
    );
    styleBar.append(this.widthGroup);

    // Dash group — selector index maps to DashStyle via DASH_ORDER below.
    const dashSep = makeSep();
    this.dashDropdown = Gtk.DropDown.new_from_strings(['Solid', 'Dashed', 'Dotted']);
    this.dashDropdown.connect('notify::selected', () => this.onDashPicked());
    this.dashGroup = makeGroup(
      dashSep,
      new Gtk.Label({label: 'Line', css_classes: ['caption']}),
      this.dashDropdown
    );
    styleBar.append(this.dashGroup);

    // Variant group
    const variantSep = makeSep();
    this.variantDropdown = Gtk.DropDown.new_from_strings(['Number', 'Letter']);
    this.variantDropdown.connect('notify::selected', () => this.onVariantPicked());
    this.variantGroup = makeGroup(
      variantSep,
      new Gtk.Label({label: 'Variant', css_classes: ['caption']}),
      this.variantDropdown
    );
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
    this.fontGroup = makeGroup(
      fontSep,
      new Gtk.Label({label: 'Font', css_classes: ['caption']}),
      this.fontDropdown,
      new Gtk.Label({label: 'Size', css_classes: ['caption'], margin_start: 6}),
      this.fontSizeSpinner
    );
    styleBar.append(this.fontGroup);

    this.styleGroupOrder = [
      {group: this.colorGroup, sep: colorSep},
      {group: this.fillGroup, sep: fillSep},
      {group: this.widthGroup, sep: widthSep},
      {group: this.dashGroup, sep: dashSep},
      {group: this.variantGroup, sep: variantSep},
      {group: this.fontGroup, sep: fontSep},
    ];

    return styleBar;
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
    if (!this.colorButton) return;
    this.updatingPicker = true;

    const color = this.styleTargetColor();
    this.colorGroup.set_visible(color !== null);
    if (color !== null) this.colorButton.set_rgba(colorToRgba(color));

    const fill = this.styleTargetFill();
    this.fillGroup.set_visible(fill !== null);
    if (fill !== null) this.fillButton.set_rgba(colorToRgba(fill));

    const width = this.styleTargetWidth();
    this.widthGroup.set_visible(width !== null);
    if (width !== null) this.widthScale.set_value(width);

    const dash = this.styleTargetDash();
    this.dashGroup.set_visible(dash !== null);
    if (dash !== null) this.dashDropdown.set_selected(Math.max(0, DASH_ORDER.indexOf(dash)));

    const tool = this.canvas.getTool();
    this.variantGroup.set_visible(tool === 'number');
    this.variantDropdown.set_selected(this.canvas.getStampVariant() === 'letter' ? 1 : 0);

    const fontDesc = this.styleTargetFontDesc();
    this.fontGroup.set_visible(fontDesc !== null);
    if (fontDesc !== null) {
      const idx = getAvailableFonts().findIndex((f) => f.family === fontDesc);
      this.fontDropdown.set_selected(idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION);
    }
    const fontSize = this.styleTargetFontSize();
    if (fontSize !== null) {
      this.fontSizeSpinner.set_value(fontSize);
    }

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

  private onVariantPicked(): void {
    if (this.updatingPicker || !this.variantDropdown) return;
    const variant: StampVariant = this.variantDropdown.get_selected() === 1 ? 'letter' : 'number';
    this.canvas.setStampVariant(variant);
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

  private styleTargetFontSize(): number | null {
    if (this.editor.isActive()) {
      return this.editor.getCurrentStyle()?.size ?? null;
    }
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      const sel = this.canvas.getSelectedAction();
      return sel ? sel.getFontSize() : null;
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
      const sel = this.canvas.getSelectedAction();
      return sel ? sel.getFontDesc() : null;
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
      const sel = this.canvas.getSelectedAction();
      return sel ? sel.getColor() : null;
    }
    return this.canvas.getToolColor(tool);
  }

  private styleTargetWidth(): number | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      const sel = this.canvas.getSelectedAction();
      return sel ? sel.getWidth() : null;
    }
    return this.canvas.getToolWidth(tool);
  }

  private styleTargetFill(): ColorRGBA | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      const sel = this.canvas.getSelectedAction();
      return sel ? sel.getFill() : null;
    }
    return this.canvas.getToolFill(tool);
  }

  private styleTargetDash(): DashStyle | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      const sel = this.canvas.getSelectedAction();
      return sel ? sel.getDash() : null;
    }
    return this.canvas.getToolDash(tool);
  }

  private onFillPicked(): void {
    if (this.updatingPicker || !this.fillButton) return;
    const fill = rgbaToColor(this.fillButton.get_rgba());
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

  private onColorPicked(): void {
    if (this.updatingPicker || !this.colorButton) return;
    const color = rgbaToColor(this.colorButton.get_rgba());
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
