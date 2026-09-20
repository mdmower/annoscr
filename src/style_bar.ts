import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Pango from 'gi://Pango?version=1.0';
import Cairo from 'cairo';

import {CanvasView} from './canvas_view.js';
import {TextEditor, TextEditorStyle} from './text_editor.js';
import {FontEntry, getAvailableFonts} from './font_catalogue.js';
import {drawSwatch, makeColorControls} from './color_controls.js';
import {ARROW_END_ORDER, DASH_ORDER, TOOLS} from './window_constants.js';
import {labelFromTooltip, setAccessibleLabel, setLabelledBy} from './a11y.js';
import {_, formatN} from './i18n.js';
import {
  Action,
  ActionType,
  ArrowEnd,
  CORNER_RADIUS_MAX,
  CORNER_RADIUS_MIN,
  ColorRGBA,
  DEFAULT_ARROW_HEAD,
  DEFAULT_ARROW_TAIL,
  DEFAULT_DASH,
  DashStyle,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  STAMP_START_MAX,
  STAMP_START_MIN,
  StampVariant,
  TextAlign,
  WIDTH_MAX,
  WIDTH_MIN,
  defaultArrowHeadForTool,
  defaultArrowTailForTool,
  defaultCornerRadiusForTool,
  defaultDashForTool,
  defaultFillForTool,
  defaultFontDescForTool,
  defaultFontSizeForTool,
  defaultTextColorForTool,
  defaultWidthForTool,
  getShapeTextEditState,
  isShapeAction,
  numberStampGroup,
  numberStampStart,
  numberStampVariant,
  parseStampStart,
  stampLabel,
  styleValuesEqual,
} from './actions.js';

interface MenuRow {
  label: string;
  run: () => void;
}

// The select-mode menu's contents. Rows are grouped into sections, which the
// menu divides with separators.
interface ActionsMenuSpec {
  // With a selection, the Select rows move into a submenu and the actions on
  // the selection follow it.
  selected: boolean;
  // All, then one row per annotation type present.
  select: MenuRow[][];
  actions: MenuRow[][];
  renumberNote: boolean;
}

// A select-by-type row label; null for tool ids that are not annotation types.
function typeRowLabel(type: ActionType, n: number): string | null {
  switch (type) {
    case 'pen':
      return formatN(_('Pen strokes (%d)'), n);
    case 'highlighter':
      return formatN(_('Highlights (%d)'), n);
    case 'text':
      return formatN(_('Text (%d)'), n);
    case 'number':
      return formatN(_('Number stamps (%d)'), n);
    case 'line':
      return formatN(_('Lines (%d)'), n);
    case 'arrow':
      return formatN(_('Arrows (%d)'), n);
    case 'rect':
      return formatN(_('Rectangles (%d)'), n);
    case 'oval':
      return formatN(_('Ovals (%d)'), n);
    case 'image':
      return formatN(_('Images (%d)'), n);
    default:
      return null;
  }
}

// Orange for the "mixed" marker dot. A concrete hex — Pango markup can't
// reference theme @colors — chosen to be visible on both light and dark caption
// backgrounds (Adwaita orange 4).
const MIX_DOT_COLOR = '#e66100';

// Fixed width of the vertical (left/right dock) properties panel — the
// side-dock counterpart of the horizontal bar's fixed height: groups showing
// and hiding never shift the canvas edge. It is only a floor, so it has to
// clear the widest group's natural width (caption plus a size spin button) or
// the panel grows for the tools that show that group and not for the others.
const DOCK_WIDTH = 250;

// Side of the square stroke-width preview, and with it the fixed height of the
// horizontal strip (the preview is its tallest control). Independent of
// WIDTH_MAX: the preview shows what a stroke looks like, and beyond a few tens
// of pixels a literal rendering would only make the bar taller — drawWidthPreview
// caps the drawn thickness here and the spin button states the exact value.
const WIDTH_PREVIEW_PX = 44;

// Cap on the font dropdown's button label, in characters (GtkLabel can cap
// its natural width only in characters, not pixels): the strip's button is as
// narrow as a short family name and stops growing here for a long one. Tuned
// by eye.
const FONT_BUTTON_MAX_CHARS = 22;

// A dropdown factory whose label ellipsizes. An unellipsized label's minimum
// width is its full text, so a selected long font family would force the
// fixed-width dock wider (DOCK_WIDTH is only a floor). Ellipsize is a
// GtkLabel property (GTK CSS has no text-overflow), so capping the button
// side takes a custom factory owning that label. max_width_chars caps the
// NATURAL width too: the strip's scroller allocates children their natural
// width, so this is what stops a long name from widening the strip's button
// while short names still get a button of their own width.
function ellipsizingFactory(): Gtk.SignalListItemFactory {
  const factory = new Gtk.SignalListItemFactory();
  factory.connect('setup', (_f, obj) => {
    (obj as Gtk.ListItem).set_child(
      new Gtk.Label({
        xalign: 0,
        ellipsize: Pango.EllipsizeMode.END,
        max_width_chars: FONT_BUTTON_MAX_CHARS,
      })
    );
  });
  factory.connect('bind', (_f, obj) => {
    const item = obj as Gtk.ListItem;
    const label = item.get_child() as Gtk.Label;
    label.set_label(item.get_item<Gtk.StringObject>().get_string());
  });
  return factory;
}

// Print a spin button's value without trailing zeros: "4" rather than "4.00",
// "2.5" rather than "2.50". The size controls keep decimals so a scaled
// annotation's exact size survives a round trip, but nearly every value set by
// hand is whole, and the padding is noise in a compact bar. String(Number(...))
// always emits "." — the same separator GTK's own spin-button parser accepts.
function trimSpinDisplay(spin: Gtk.SpinButton): void {
  spin.connect('output', () => {
    spin.set_text(String(Number(spin.get_value().toFixed(spin.get_digits()))));
    return true;
  });
}

// Set a control's caption. When the selected actions disagree on the property,
// a compact superscript dot trails the caption (rather than a "(mixed)" suffix
// that widens the group). The dot is visual-only: an explicit accessible label
// keeps the caption's name reading "Base (mixed)" so screen readers still
// announce the mixed state — GTK derives the control's labelled-by name from
// the label's accessible name, so the glyph never reaches AT.
function setCaption(label: Gtk.Label, base: string, mixed: boolean): void {
  if (mixed) {
    const esc = GLib.markup_escape_text(base, -1);
    label.set_markup(`${esc} <span foreground="${MIX_DOT_COLOR}"><sup>●</sup></span>`);
  } else {
    label.set_text(base);
  }
  setAccessibleLabel(label, mixed ? `${base} ${_('(mixed)')}` : base);
}

// The style bar: per-tool/selection style pickers (color, fill, width,
// dash, stamp variant, font, font size). Owns its widgets and the picker
// signal handlers; reads tool/selection/editor state through the canvas and
// editor refs and writes style changes back through them. The window holds one
// instance, docks getWidget() on the edge the styleBarPosition setting names
// (horizontal strip on top/bottom, vertical properties panel on left/right —
// see setVertical), and calls refresh() whenever the canvas state changes
// (tool switch, selection change, edit lifecycle).
export class StyleBar {
  // A scroller wrapping the bar so the variable-size control set never forces
  // the window larger — it scrolls (horizontally as a strip, vertically as a
  // panel) instead of resizing the window between tools. Overlay scrollbars
  // don't take layout space, so the canvas doesn't shift.
  private widget: Gtk.ScrolledWindow;
  // True in the vertical properties-panel layout (left/right dock).
  private vertical = false;
  // Color/Fill are custom swatch buttons. Clicking one opens a popover with an
  // inline hex entry + opacity field (set opacity to 0 for transparent / no
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
  private widthSpin!: Gtk.SpinButton;
  private widthPreview!: Gtk.DrawingArea;
  private widthGroup!: Gtk.Box;
  private widthLabel!: Gtk.Label;
  private dashGroup!: Gtk.Box;
  private dashLabel!: Gtk.Label;
  private dashDropdown!: Gtk.DropDown;
  // What the arrow draws at each end (arrow only): none, wings, or a filled
  // triangle. Two dropdowns matching the Dash/Variant controls.
  private arrowHeadGroup!: Gtk.Box;
  private arrowHeadLabel!: Gtk.Label;
  private arrowHeadDropdown!: Gtk.DropDown;
  private arrowTailGroup!: Gtk.Box;
  private arrowTailLabel!: Gtk.Label;
  private arrowTailDropdown!: Gtk.DropDown;
  // Rectangle corner radius (rect only): 0 = sharp, image-space px.
  private cornerGroup!: Gtk.Box;
  private cornerLabel!: Gtk.Label;
  private cornerSpin!: Gtk.SpinButton;
  // Opacity of the selected image items, as a percentage.
  private opacityGroup!: Gtk.Box;
  private opacityLabel!: Gtk.Label;
  private opacitySpin!: Gtk.SpinButton;
  // Callout-tail switch (selected rect/oval only): toggles a pointer tail
  // joined to the box outline; the tip is dragged by its own canvas handle.
  private tailGroup!: Gtk.Box;
  private tailLabel!: Gtk.Label;
  private tailSwitch!: Gtk.Switch;
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

  // Starting number for the stamp group. The value is always the number; the
  // letter variant only changes how it is displayed and typed, so a start above
  // 26 is kept across a variant switch even though it shows as a wrapped letter.
  private startGroup!: Gtk.Box;
  private startLabel!: Gtk.Label;
  private startSpin!: Gtk.SpinButton;
  // The variant the Start field currently renders in, read by its formatting
  // and parsing handlers.
  private startVariant: StampVariant = 'number';
  // The select-mode menu (select by type, and the actions on a selection) in
  // one overflow button, so it takes one bar slot. Visible whenever the select
  // tool is active.
  private actionsGroup!: Gtk.Box;
  private actionsPopover!: Gtk.Popover;
  // The menu's pages; reset to the first page when the menu closes.
  private actionsStack: Gtk.Stack | null = null;
  // JSON of the spec the menu was last built from; null forces a rebuild.
  private actionsMenuKey: string | null = null;
  // The spec changed while the menu was open; rebuilt when it closes, so rows
  // don't move under the pointer.
  private actionsMenuStale = false;
  // Text-style controls — each its own inline group, hidden when its property
  // doesn't apply (Text color / Font+Size for any text; Align for shape
  // text only). The bar scrolls horizontally when the full set overflows.
  private textColorGroup!: Gtk.Box;
  private textColorLabel!: Gtk.Label;
  private textColorSwatchSet!: (c: ColorRGBA | null) => void;
  private fontGroup!: Gtk.Box;
  private fontLabel!: Gtk.Label;
  private fontDropdown!: Gtk.DropDown;
  // Current dropdown items: the catalogue plus, when the applied font isn't in
  // it, a transient bare entry for that font (recomputed each refresh, never
  // persisted) so the menu always reflects what's applied.
  private fontModel: FontEntry[] = [];
  // True while handling a font pick. Applying the font re-enters refresh() →
  // applyFontModel synchronously; swapping the dropdown's model there (mid
  // notify::selected) crashes GtkDropDown, so the swap is suppressed until the
  // next, non-reentrant refresh.
  private inFontPick = false;
  private fontSizeLabel!: Gtk.Label;
  private fontSizeSpinner!: Gtk.SpinButton;
  private alignGroup!: Gtk.Box;
  private alignLabel!: Gtk.Label;
  private alignButtons!: Record<TextAlign, Gtk.ToggleButton>;
  // Ordered (group, separator) pairs for the first-visible-separator logic
  // in refresh().
  private styleGroupOrder: Array<{group: Gtk.Box; sep: Gtk.Separator}> = [];
  // Guard against the programmatic set_rgba() / set_value() calls in refresh()
  // emitting change signals and re-entering the user-edit handlers.
  private updatingPicker = false;

  constructor(
    private canvas: InstanceType<typeof CanvasView>,
    private editor: TextEditor
  ) {
    this.widget = new Gtk.ScrolledWindow({
      child: this.build(),
      hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.NEVER,
      // Don't let the bar's natural width propagate to (and grow) the window.
      propagate_natural_width: false,
      propagate_natural_height: true,
      // Explicit (sets hexpand-set): the panel layout's full-width controls
      // have hexpand set, which would otherwise propagate up through the
      // scroller and make a side dock split the window's spare width with
      // the canvas instead of staying at DOCK_WIDTH.
      hexpand: false,
    });
  }

  getWidget(): Gtk.ScrolledWindow {
    return this.widget;
  }

  // Rebuild the bar as the horizontal strip (top/bottom dock) or the vertical
  // properties panel (left/right dock). All controls are recreated; refresh()
  // restores group visibility and values on the fresh widgets.
  setVertical(vertical: boolean): void {
    if (vertical === this.vertical) return;
    this.vertical = vertical;
    this.widget.set_policy(
      vertical ? Gtk.PolicyType.NEVER : Gtk.PolicyType.AUTOMATIC,
      vertical ? Gtk.PolicyType.AUTOMATIC : Gtk.PolicyType.NEVER
    );
    // The panel is fixed-width (groups showing/hiding must not shift the
    // canvas edge) and must not propagate its natural height, which would
    // force the window taller than its tallest control set.
    this.widget.set_propagate_natural_height(!vertical);
    this.widget.set_size_request(vertical ? DOCK_WIDTH : -1, -1);
    this.widget.set_child(this.build());
    this.refresh();
  }

  private build(): Gtk.Box {
    const vertical = this.vertical;
    const styleBar = vertical
      ? new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 6,
          margin_start: 10,
          margin_end: 10,
          margin_top: 6,
          margin_bottom: 10,
        })
      : new Gtk.Box({
          orientation: Gtk.Orientation.HORIZONTAL,
          spacing: 6,
          margin_start: 12,
          margin_end: 12,
          margin_top: 4,
          margin_bottom: 4,
          // Fixed height so the bar always occupies the same space regardless
          // of which groups are visible. Without this, hiding/showing groups
          // resizes the canvas and shifts the image. (The vertical panel's
          // counterpart is the fixed DOCK_WIDTH on the scroller.)
          height_request: WIDTH_PREVIEW_PX,
        });

    const makeSep = (): Gtk.Separator =>
      vertical
        ? new Gtk.Separator({
            orientation: Gtk.Orientation.HORIZONTAL,
            margin_top: 4,
            margin_bottom: 4,
          })
        : new Gtk.Separator({
            orientation: Gtk.Orientation.VERTICAL,
            margin_start: 8,
            margin_end: 8,
          });

    // Horizontal strip: one row of [separator, caption, controls].
    const makeGroup = (sep: Gtk.Separator, ...children: Gtk.Widget[]): Gtk.Box => {
      const g = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
      g.append(sep);
      for (const c of children) g.append(c);
      return g;
    };

    // Vertical panel: every group is a column that starts with its separator
    // (the first-visible-separator logic in refresh() relies on the separator
    // being inside the group), so hiding a group hides its divider too.
    const makeColumn = (sep: Gtk.Separator, ...rows: Gtk.Widget[]): Gtk.Box => {
      const g = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
      g.append(sep);
      for (const r of rows) g.append(r);
      return g;
    };

    // Caption sharing a row with a compact control (swatch, switch, short
    // dropdown, the align cluster): caption left, control at the right edge.
    const makeRowGroup = (
      sep: Gtk.Separator,
      label: Gtk.Label,
      ...controls: Gtk.Widget[]
    ): Gtk.Box => {
      if (!vertical) return makeGroup(sep, label, ...controls);
      label.set_xalign(0);
      label.set_hexpand(true);
      const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
      row.append(label);
      for (const c of controls) row.append(c);
      return makeColumn(sep, row);
    };

    // Caption heading full-width controls (the font dropdown): caption above,
    // controls below spanning the panel width.
    const makeStackGroup = (
      sep: Gtk.Separator,
      label: Gtk.Label,
      ...controls: Gtk.Widget[]
    ): Gtk.Box => {
      if (!vertical) return makeGroup(sep, label, ...controls);
      label.set_xalign(0);
      return makeColumn(sep, label, ...controls);
    };

    // Select-mode menu, first in the bar, left of the per-property controls.
    // The panel has room for a labeled button; the strip stays icon-only.
    const actionsSep = makeSep();
    const actionsMenu = vertical
      ? new Gtk.MenuButton({label: _('Select and arrange')})
      : new Gtk.MenuButton({
          icon_name: 'view-more-symbolic',
          tooltip_text: _('Select and arrange'),
          valign: Gtk.Align.CENTER,
        });
    if (!vertical) labelFromTooltip(actionsMenu);
    this.actionsPopover = new Gtk.Popover();
    this.actionsStack = null;
    this.actionsMenuKey = null;
    this.actionsMenuStale = false;
    this.actionsPopover.connect('closed', () => {
      this.actionsStack?.set_visible_child_full('main', Gtk.StackTransitionType.NONE);
      if (!this.actionsMenuStale) return;
      this.actionsMenuStale = false;
      this.refreshActionsMenu();
    });
    actionsMenu.set_popover(this.actionsPopover);
    this.actionsGroup = vertical
      ? makeColumn(actionsSep, actionsMenu)
      : makeGroup(actionsSep, actionsMenu);
    styleBar.append(this.actionsGroup);

    // Color group
    const colorSep = makeSep();
    const colorSwatch = this.makeSwatchButton((c) => this.onColorPicked(c));
    this.colorSwatchSet = colorSwatch.setColor;
    this.colorLabel = new Gtk.Label({label: _('Color'), css_classes: ['caption']});
    setLabelledBy(colorSwatch.button, this.colorLabel);
    this.colorGroup = makeRowGroup(colorSep, this.colorLabel, colorSwatch.button);
    styleBar.append(this.colorGroup);

    // Fill group
    const fillSep = makeSep();
    const fillSwatch = this.makeSwatchButton((c) => this.onFillPicked(c));
    this.fillSwatchSet = fillSwatch.setColor;
    this.fillLabel = new Gtk.Label({label: _('Fill'), css_classes: ['caption']});
    setLabelledBy(fillSwatch.button, this.fillLabel);
    this.fillGroup = makeRowGroup(fillSep, this.fillLabel, fillSwatch.button);
    styleBar.append(this.fillGroup);

    // Width group
    const widthSep = makeSep();
    this.widthSpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: WIDTH_MIN,
        upper: WIDTH_MAX,
        step_increment: 1,
        page_increment: 10,
      }),
      // Whole-pixel steps, two decimals typeable: scaling the image multiplies
      // every width, so a stroke can legitimately be a fraction of a pixel,
      // but stepping through those fractions is never what anyone wants.
      digits: 2,
      width_request: 76,
      valign: Gtk.Align.CENTER,
      xalign: 1,
    });
    trimSpinDisplay(this.widthSpin);
    this.widthSpin.connect('value-changed', () => this.onWidthPicked());
    this.widthPreview = new Gtk.DrawingArea({
      width_request: WIDTH_PREVIEW_PX,
      height_request: WIDTH_PREVIEW_PX,
      valign: Gtk.Align.CENTER,
    });
    this.widthPreview.set_draw_func((_w, cr, w, h) => this.drawWidthPreview(cr, w, h));
    this.widthLabel = new Gtk.Label({label: _('Width'), css_classes: ['caption']});
    this.widthGroup = makeRowGroup(widthSep, this.widthLabel, this.widthSpin, this.widthPreview);
    styleBar.append(this.widthGroup);

    // Dash group — selector index maps to DashStyle via DASH_ORDER below.
    const dashSep = makeSep();
    this.dashDropdown = Gtk.DropDown.new_from_strings([_('Solid'), _('Dashed'), _('Dotted')]);
    this.dashDropdown.connect('notify::selected', () => this.onDashPicked());
    this.dashLabel = new Gtk.Label({label: _('Line'), css_classes: ['caption']});
    this.dashGroup = makeRowGroup(dashSep, this.dashLabel, this.dashDropdown);
    styleBar.append(this.dashGroup);

    // Corners group (rectangle only) — the corner radius in px.
    const cornerSep = makeSep();
    this.cornerSpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: CORNER_RADIUS_MIN,
        upper: CORNER_RADIUS_MAX,
        step_increment: 1,
        page_increment: 25,
      }),
      // One decimal, for the same reason as the width control.
      digits: 1,
      width_request: 76,
      valign: Gtk.Align.CENTER,
      xalign: 1,
    });
    trimSpinDisplay(this.cornerSpin);
    this.cornerSpin.connect('value-changed', () => this.onCornerRadiusPicked());
    this.cornerLabel = new Gtk.Label({label: _('Corners'), css_classes: ['caption']});
    this.cornerGroup = makeRowGroup(cornerSep, this.cornerLabel, this.cornerSpin);
    styleBar.append(this.cornerGroup);

    // Opacity group (selected image items only).
    const opacitySep = makeSep();
    this.opacitySpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 10}),
      width_request: 76,
      valign: Gtk.Align.CENTER,
      xalign: 1,
    });
    this.opacitySpin.connect('value-changed', () => this.onOpacityPicked());
    this.opacityLabel = new Gtk.Label({label: _('Opacity'), css_classes: ['caption']});
    this.opacityGroup = makeRowGroup(opacitySep, this.opacityLabel, this.opacitySpin);
    styleBar.append(this.opacityGroup);

    // Callout group (selected rect/oval only) — a switch toggling the pointer
    // tail; there's deliberately no tool default (see replaceSelectedTail), so
    // the group never shows in placement modes.
    const tailSep = makeSep();
    this.tailSwitch = new Gtk.Switch({valign: Gtk.Align.CENTER});
    this.tailSwitch.connect('notify::active', () => this.onTailPicked());
    this.tailLabel = new Gtk.Label({label: _('Callout'), css_classes: ['caption']});
    this.tailGroup = makeRowGroup(tailSep, this.tailLabel, this.tailSwitch);
    styleBar.append(this.tailGroup);

    // Arrow ends (arrow only) — selector index maps to an ArrowEnd via
    // ARROW_END_ORDER. Head is the end the arrow was dragged to.
    const arrowEndRows = (): string[] => [_('None'), _('Wings'), _('Filled')];
    const arrowHeadSep = makeSep();
    this.arrowHeadDropdown = Gtk.DropDown.new_from_strings(arrowEndRows());
    this.arrowHeadDropdown.connect('notify::selected', () => this.onArrowHeadPicked());
    this.arrowHeadLabel = new Gtk.Label({label: _('Head'), css_classes: ['caption']});
    this.arrowHeadGroup = makeRowGroup(arrowHeadSep, this.arrowHeadLabel, this.arrowHeadDropdown);
    styleBar.append(this.arrowHeadGroup);

    const arrowTailSep = makeSep();
    this.arrowTailDropdown = Gtk.DropDown.new_from_strings(arrowEndRows());
    this.arrowTailDropdown.connect('notify::selected', () => this.onArrowTailPicked());
    this.arrowTailLabel = new Gtk.Label({label: _('Tail'), css_classes: ['caption']});
    this.arrowTailGroup = makeRowGroup(arrowTailSep, this.arrowTailLabel, this.arrowTailDropdown);
    styleBar.append(this.arrowTailGroup);

    // Group selector (stamp). Rows are filled in refresh() from the canvas's
    // group list; the model starts empty.
    const groupSep = makeSep();
    this.groupModel = Gtk.StringList.new([]);
    this.groupDropdown = new Gtk.DropDown({model: this.groupModel});
    this.groupDropdown.connect('notify::selected', () => this.onGroupPicked());
    this.groupLabel = new Gtk.Label({label: _('Group'), css_classes: ['caption']});
    this.groupGroup = makeRowGroup(groupSep, this.groupLabel, this.groupDropdown);
    styleBar.append(this.groupGroup);

    // Variant group
    const variantSep = makeSep();
    this.variantDropdown = Gtk.DropDown.new_from_strings([_('Number'), _('Letter')]);
    this.variantDropdown.connect('notify::selected', () => this.onVariantPicked());
    this.variantLabel = new Gtk.Label({label: _('Variant'), css_classes: ['caption']});
    this.variantGroup = makeRowGroup(variantSep, this.variantLabel, this.variantDropdown);
    styleBar.append(this.variantGroup);

    // Start group (stamp). GJS cannot set the `input` signal's out parameter,
    // so the handler rewrites the entry to the numeric form and lets GTK's own
    // conversion read that back.
    const startSep = makeSep();
    this.startSpin = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: STAMP_START_MIN,
        upper: STAMP_START_MAX,
        step_increment: 1,
        page_increment: 10,
      }),
      width_request: 76,
      valign: Gtk.Align.CENTER,
      xalign: 1,
    });
    // GJS can't set the new_value out parameter, so the handler rewrites the
    // text to its numeric form and returns FALSE (not handled), and GTK's
    // default conversion parses the rewritten text.
    this.startSpin.connect('input', () => {
      this.normalizeStartText();
      return 0;
    });
    this.startSpin.connect('output', () => {
      this.showStartValue();
      return true;
    });
    this.startSpin.connect('value-changed', () => this.onStartPicked());
    this.startLabel = new Gtk.Label({label: _('Start'), css_classes: ['caption']});
    this.startGroup = makeRowGroup(startSep, this.startLabel, this.startSpin);
    styleBar.append(this.startGroup);

    // Text color group — the getTextColor channel (a text's glyphs, or the text
    // embedded in a shape), distinct from the stroke/outline Color.
    const textColorSep = makeSep();
    const textColorSwatch = this.makeSwatchButton((c) => this.onTextColorPicked(c));
    this.textColorSwatchSet = textColorSwatch.setColor;
    this.textColorLabel = new Gtk.Label({label: _('Text color'), css_classes: ['caption']});
    setLabelledBy(textColorSwatch.button, this.textColorLabel);
    this.textColorGroup = makeRowGroup(textColorSep, this.textColorLabel, textColorSwatch.button);
    styleBar.append(this.textColorGroup);

    // Font group (family + size).
    const fontSep = makeSep();
    this.fontModel = [...getAvailableFonts()];
    this.fontDropdown = Gtk.DropDown.new_from_strings(this.fontModel.map((f) => f.label));
    // Popup rows keep the stock factory (moved to the list-factory property
    // before the button factory is replaced): full names, and the popover may
    // be wider than the button. The button's label ellipsizes in both layouts
    // so a long selected family can't force the dock wider or take most of the
    // strip.
    this.fontDropdown.set_list_factory(this.fontDropdown.get_factory());
    this.fontDropdown.set_factory(ellipsizingFactory());
    this.fontDropdown.connect('notify::selected', () => this.onFontDescPicked());
    this.fontSizeSpinner = new Gtk.SpinButton({
      adjustment: new Gtk.Adjustment({
        lower: FONT_SIZE_MIN,
        upper: FONT_SIZE_MAX,
        step_increment: 1,
        page_increment: 10,
      }),
      // One decimal, for the same reason as the width scale.
      digits: 1,
      width_request: 76,
      xalign: 1,
    });
    trimSpinDisplay(this.fontSizeSpinner);
    this.fontSizeSpinner.connect('value-changed', () => this.onFontSizePicked());
    this.fontLabel = new Gtk.Label({label: _('Font'), css_classes: ['caption']});
    this.fontSizeLabel = new Gtk.Label({
      label: _('Size'),
      css_classes: ['caption'],
      margin_start: vertical ? 0 : 6,
    });
    if (vertical) {
      // Family dropdown full-width under the Font caption; Size gets its own
      // caption-left row beneath it.
      this.fontDropdown.set_hexpand(true);
      this.fontSizeLabel.set_xalign(0);
      this.fontSizeLabel.set_hexpand(true);
      const sizeRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
      sizeRow.append(this.fontSizeLabel);
      sizeRow.append(this.fontSizeSpinner);
      this.fontGroup = makeStackGroup(fontSep, this.fontLabel, this.fontDropdown, sizeRow);
    } else {
      this.fontGroup = makeGroup(
        fontSep,
        this.fontLabel,
        this.fontDropdown,
        this.fontSizeLabel,
        this.fontSizeSpinner
      );
    }
    styleBar.append(this.fontGroup);

    // Align group (shape text only) — L/C/R radio cluster.
    const alignSep = makeSep();
    const left = this.makeAlignToggle('format-justify-left-symbolic', _('Align left'), 'left');
    const center = this.makeAlignToggle(
      'format-justify-center-symbolic',
      _('Align center'),
      'center',
      left
    );
    const right = this.makeAlignToggle(
      'format-justify-right-symbolic',
      _('Align right'),
      'right',
      left
    );
    this.alignButtons = {left, center, right};
    const alignBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      css_classes: ['linked'],
    });
    alignBox.append(left);
    alignBox.append(center);
    alignBox.append(right);
    this.alignLabel = new Gtk.Label({label: _('Align'), css_classes: ['caption']});
    this.alignGroup = makeRowGroup(alignSep, this.alignLabel, alignBox);
    styleBar.append(this.alignGroup);

    this.styleGroupOrder = [
      {group: this.actionsGroup, sep: actionsSep},
      {group: this.colorGroup, sep: colorSep},
      {group: this.fillGroup, sep: fillSep},
      {group: this.widthGroup, sep: widthSep},
      {group: this.dashGroup, sep: dashSep},
      {group: this.cornerGroup, sep: cornerSep},
      {group: this.opacityGroup, sep: opacitySep},
      {group: this.tailGroup, sep: tailSep},
      {group: this.arrowHeadGroup, sep: arrowHeadSep},
      {group: this.arrowTailGroup, sep: arrowTailSep},
      {group: this.groupGroup, sep: groupSep},
      {group: this.variantGroup, sep: variantSep},
      {group: this.startGroup, sep: startSep},
      {group: this.textColorGroup, sep: textColorSep},
      {group: this.fontGroup, sep: fontSep},
      {group: this.alignGroup, sep: alignSep},
    ];

    // Name each control by its caption. The control's accessible name tracks
    // the caption's accessible name, so the "(mixed)" that setCaption keeps in
    // the caption's accessible label (the dot is visual-only) reaches AT with
    // no further code. (Swatches and align toggles are labelled at their
    // creation above.)
    setLabelledBy(this.widthSpin, this.widthLabel);
    setLabelledBy(this.cornerSpin, this.cornerLabel);
    setLabelledBy(this.opacitySpin, this.opacityLabel);
    setLabelledBy(this.tailSwitch, this.tailLabel);
    setLabelledBy(this.dashDropdown, this.dashLabel);
    setLabelledBy(this.arrowHeadDropdown, this.arrowHeadLabel);
    setLabelledBy(this.arrowTailDropdown, this.arrowTailLabel);
    setLabelledBy(this.groupDropdown, this.groupLabel);
    setLabelledBy(this.variantDropdown, this.variantLabel);
    setLabelledBy(this.fontDropdown, this.fontLabel);
    setLabelledBy(this.fontSizeSpinner, this.fontSizeLabel);

    return styleBar;
  }

  // What the select-mode menu shows, from the selection and the action counts.
  private actionsMenuSpec(): ActionsMenuSpec {
    const sel = this.canvas.getSelectedActions();
    const counts = this.canvas.countByType();
    const types: MenuRow[] = [];
    for (const type of [...TOOLS.map((t): ActionType => t.id), 'image' as const]) {
      const n = counts.get(type);
      const label = n ? typeRowLabel(type, n) : null;
      if (label) types.push({label, run: () => this.canvas.selectType(type)});
    }
    const all: MenuRow = {label: _('All (Ctrl+A)'), run: () => this.canvas.selectAll()};
    const select = types.length > 0 ? [[all], types] : [[all]];
    if (sel.length === 0) return {selected: false, select, actions: [], renumberNote: false};

    const typed: MenuRow[] = [];
    // Add/Edit text for a lone rect/oval, labeled by whether it has text.
    if (sel.length === 1 && isShapeAction(sel[0])) {
      const hasText = (getShapeTextEditState(sel[0])?.markup ?? '') !== '';
      typed.push({
        label: hasText ? _('Edit text') : _('Add text'),
        run: () => this.canvas.editSelectedText(),
      });
    }
    // Offered only when a selected segment is bent, never as a no-op.
    if (sel.some((a) => a.getCurve() === true)) {
      typed.push({label: _('Straighten'), run: () => this.canvas.straightenSelected()});
    }
    const actions: MenuRow[][] = [
      [{label: _('Duplicate (Ctrl+D)'), run: () => this.canvas.cloneSelected()}],
      [
        {
          label: _('Bring to front (Ctrl+Shift+])'),
          run: () => this.canvas.reorderSelected('front'),
        },
        {label: _('Bring forward (Ctrl+])'), run: () => this.canvas.reorderSelected('raise')},
        {label: _('Send backward (Ctrl+[)'), run: () => this.canvas.reorderSelected('lower')},
        {label: _('Send to back (Ctrl+Shift+[)'), run: () => this.canvas.reorderSelected('back')},
      ],
    ];
    if (typed.length > 0) actions.unshift(typed);
    return {
      selected: true,
      select,
      actions,
      // Duplicate and the z-order moves renumber stamps, and nothing else.
      renumberNote: sel.some((a) => numberStampGroup(a) !== null),
    };
  }

  // Rebuild the select-mode menu if its spec changed (deferred to close while
  // it is open).
  private refreshActionsMenu(): void {
    const spec = this.actionsMenuSpec();
    // JSON.stringify omits the run functions, so this compares the rows'
    // labels and structure.
    const key = JSON.stringify(spec);
    if (key === this.actionsMenuKey) return;
    if (this.actionsPopover.get_visible()) {
      this.actionsMenuStale = true;
      return;
    }
    this.actionsMenuKey = key;
    this.fillActionsMenu(spec);
  }

  // Close the menu, then run a row's command on an idle. An autohide popover
  // restores its parent's focus widget as it closes, which would take focus
  // from the text editor that Add/Edit text opens; and the command's state
  // change rebuilds this menu, which must not happen inside the row's own
  // signal handler.
  private runFromMenu(run: () => void): void {
    this.actionsPopover.popdown();
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      run();
      return GLib.SOURCE_REMOVE;
    });
  }

  private makeRenumberNote(): Gtk.Label {
    return new Gtk.Label({
      label: _('Stamps renumber within their group.'),
      css_classes: ['caption', 'dim-label'],
      xalign: 0,
      wrap: true,
      max_width_chars: 26,
      margin_top: 4,
    });
  }

  // Flat buttons in a Gtk.Stack; with a selection, the Select rows are on a
  // second page that slides in.
  private fillActionsMenu(spec: ActionsMenuSpec): void {
    const page = (): Gtk.Box =>
      new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 6,
        margin_end: 6,
      });
    const flatButton = (...children: Gtk.Widget[]): Gtk.Button => {
      const content = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
      for (const c of children) content.append(c);
      return new Gtk.Button({child: content, css_classes: ['flat']});
    };
    const separator = (): Gtk.Separator => new Gtk.Separator({margin_top: 4, margin_bottom: 4});
    const appendSections = (box: Gtk.Box, sections: MenuRow[][]): void => {
      sections.forEach((rows, i) => {
        if (i > 0) box.append(separator());
        for (const {label, run} of rows) {
          const btn = flatButton(new Gtk.Label({label, xalign: 0, hexpand: true}));
          btn.connect('clicked', () => this.runFromMenu(run));
          box.append(btn);
        }
      });
    };

    const stack = new Gtk.Stack({
      transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
      interpolate_size: true,
      vhomogeneous: false,
    });
    const main = page();
    stack.add_named(main, 'main');
    if (!spec.selected) {
      main.append(
        new Gtk.Label({
          label: _('Select'),
          xalign: 0,
          css_classes: ['heading', 'dim-label'],
          margin_start: 12,
          margin_top: 4,
          margin_bottom: 4,
        })
      );
      appendSections(main, spec.select);
    } else {
      const sub = page();
      stack.add_named(sub, 'select');
      const open = flatButton(
        new Gtk.Label({label: _('Select'), xalign: 0, hexpand: true}),
        new Gtk.Image({icon_name: 'go-next-symbolic'})
      );
      const back = flatButton(
        new Gtk.Image({icon_name: 'go-previous-symbolic'}),
        new Gtk.Label({label: _('Select'), hexpand: true, css_classes: ['heading']})
      );
      open.connect('clicked', () => {
        stack.set_visible_child(sub);
        back.grab_focus();
      });
      back.connect('clicked', () => {
        stack.set_visible_child(main);
        open.grab_focus();
      });
      main.append(open);
      main.append(separator());
      appendSections(main, spec.actions);
      sub.append(back);
      sub.append(separator());
      appendSections(sub, spec.select);
      if (spec.renumberNote) main.append(this.makeRenumberNote());
    }
    this.actionsStack = stack;
    this.actionsPopover.set_child(stack);
  }

  // An alignment toggle. Passing `group` links it into the radio cluster so
  // exactly one stays active. Only the button that just became active applies
  // (the same click deactivates a sibling, which also emits toggled).
  private makeAlignToggle(
    icon: string,
    tooltip: string,
    align: TextAlign,
    group?: Gtk.ToggleButton
  ): Gtk.ToggleButton {
    const btn = new Gtk.ToggleButton({icon_name: icon, tooltip_text: tooltip});
    setAccessibleLabel(btn, tooltip);
    if (group) btn.set_group(group);
    btn.connect('toggled', () => {
      if (this.updatingPicker || !btn.get_active()) return;
      this.onAlignPicked(align);
    });
    return btn;
  }

  // Press the alignment button matching `align`, or none when null (mixed / not
  // applicable). The radio group keeps the others unpressed.
  private setActiveAlign(align: TextAlign | null): void {
    this.alignButtons.left.set_active(align === 'left');
    this.alignButtons.center.set_active(align === 'center');
    this.alignButtons.right.set_active(align === 'right');
  }

  // A color swatch button whose popover holds the shared hex / opacity /
  // Palette… controls plus the in-canvas eyedropper. Every path reports the
  // chosen color via `onChosen` even when it equals the shown one (so a mixed
  // selection flattens). Returns the button plus a setter that repaints the
  // swatch.
  private makeSwatchButton(onChosen: (color: ColorRGBA) => void): {
    button: Gtk.MenuButton;
    setColor: (c: ColorRGBA | null) => void;
  } {
    let current: ColorRGBA = [0, 0, 0, 1];

    const area = new Gtk.DrawingArea({
      width_request: 28,
      height_request: 20,
      valign: Gtk.Align.CENTER,
    });
    area.set_draw_func((_w, cr, w, h) => drawSwatch(cr, w, h, current));
    // A MenuButton (not a plain Button with a set_parent'd popover): it owns
    // the popover and unparents it on dispose, avoiding the "Finalizing
    // GtkButton … still has children left" warning at quit. No dropdown arrow
    // because the swatch is a custom child and always-show-arrow defaults off.
    const button = new Gtk.MenuButton({child: area, tooltip_text: _('Pick a color')});

    // In-canvas eyedropper: closes the popover and puts the canvas into
    // color-sampling mode. The picked pixel sets RGB and keeps the current
    // opacity — a composited pixel is opaque-blended, so its alpha isn't
    // recoverable (and a pick should never silently zero a fill's opacity).
    const pickBtn = new Gtk.Button({
      icon_name: 'color-select-symbolic',
      tooltip_text: _('Pick a color from the image'),
      valign: Gtk.Align.CENTER,
    });
    labelFromTooltip(pickBtn);

    const commit = (c: ColorRGBA): void => {
      current = c;
      area.queue_draw();
      onChosen(c);
    };

    const popover = new Gtk.Popover({autohide: true});
    const controls = makeColorControls({
      onChosen: commit,
      hexRowEnd: pickBtn,
      onPaletteOpen: () => popover.popdown(),
    });
    const box = controls.box;
    box.margin_top = 8;
    box.margin_bottom = 8;
    box.margin_start = 8;
    box.margin_end = 8;
    popover.set_child(box);
    button.set_popover(popover);

    pickBtn.connect('clicked', () => {
      popover.popdown();
      this.canvas.beginColorSample((c) => commit([c[0], c[1], c[2], current[3]]));
    });

    // MenuButton shows the popover itself; sync the entry/opacity field to the
    // live color just before it opens (create-popup-func runs pre-show, so
    // there's no flash of stale values).
    button.set_create_popup_func(() => controls.setColor(current));

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
    // Cap visible thickness to the preview height so the full width range
    // still fits visually; the spin button shows the exact value when the
    // preview is at its maximum.
    const drawWidth = Math.min(width, h - 2);
    cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
    cr.setLineWidth(drawWidth);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.moveTo(8, h / 2);
    cr.lineTo(w - 8, h / 2);
    cr.stroke();
  }

  // Rebuild the font dropdown after the chosen set changes in Preferences.
  // refresh() recomputes the model (catalogue + any transient applied font) and
  // re-syncs the selection under the updatingPicker guard.
  rebuildFontDropdown(): void {
    this.refresh();
  }

  // Point the font dropdown at `target`, rebuilding its item list only when it
  // changes. The list is the catalogue plus, when `target` isn't in it, a
  // transient bare entry so the menu matches the applied font (e.g. one removed
  // from Preferences but still in use). The transient entry is never persisted,
  // so it drops as soon as the target font is back in the list or no longer the
  // current one. Must be called under the updatingPicker guard (set_model /
  // set_selected would otherwise emit a spurious pick).
  private applyFontModel(target: string | null): void {
    // Re-entered from a font pick (see inFontPick) — the dropdown already shows
    // the user's choice; a model swap here would crash. Reconciled next
    // refresh.
    if (this.inFontPick) return;
    const catalogue = getAvailableFonts();
    const model: FontEntry[] = [...catalogue];
    if (target !== null && !catalogue.some((f) => f.family === target)) {
      // group is unused for display here — the label is the bare family name.
      model.push({family: target, group: 'sans', label: target});
    }
    const changed =
      model.length !== this.fontModel.length ||
      model.some((f, i) => f.family !== this.fontModel[i].family);
    if (changed) {
      this.fontModel = model;
      this.fontDropdown.set_model(Gtk.StringList.new(model.map((f) => f.label)));
    }
    const idx = model.findIndex((f) => f.family === target);
    this.fontDropdown.set_selected(idx >= 0 ? idx : Gtk.INVALID_LIST_POSITION);
  }

  refresh(): void {
    if (!this.colorGroup) return;
    this.updatingPicker = true;

    const selectMode = this.canvas.getTool() === 'select' && !this.editor.isActive();
    this.actionsGroup.set_visible(selectMode);
    if (selectMode) this.refreshActionsMenu();

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
    if (width !== null) this.widthSpin.set_value(width);
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

    const corner = this.styleTargetCornerRadius();
    this.cornerGroup.set_visible(corner !== null);
    if (corner !== null) this.cornerSpin.set_value(corner);
    setCaption(
      this.cornerLabel,
      _('Corners'),
      this.selectionMixed((a) => a.getCornerRadius())
    );

    const opacity = this.styleTargetOpacity();
    this.opacityGroup.set_visible(opacity !== null);
    if (opacity !== null) this.opacitySpin.set_value(Math.round(opacity * 100));
    setCaption(
      this.opacityLabel,
      _('Opacity'),
      this.selectionMixed((a) => a.getOpacity())
    );

    const arrowHead = this.styleTargetArrowHead();
    this.arrowHeadGroup.set_visible(arrowHead !== null);
    if (arrowHead !== null)
      this.arrowHeadDropdown.set_selected(Math.max(0, ARROW_END_ORDER.indexOf(arrowHead)));
    setCaption(
      this.arrowHeadLabel,
      _('Head'),
      this.selectionMixed((a) => a.getArrowHead())
    );

    const arrowTail = this.styleTargetArrowTail();
    this.arrowTailGroup.set_visible(arrowTail !== null);
    if (arrowTail !== null)
      this.arrowTailDropdown.set_selected(Math.max(0, ARROW_END_ORDER.indexOf(arrowTail)));
    setCaption(
      this.arrowTailLabel,
      _('Tail'),
      this.selectionMixed((a) => a.getArrowTail())
    );

    const tail = this.styleTargetTail();
    this.tailGroup.set_visible(tail !== null);
    if (tail !== null) this.tailSwitch.set_active(tail);
    setCaption(
      this.tailLabel,
      _('Callout'),
      this.selectionMixed((a) => a.getTail())
    );

    this.refreshStampControls();
    this.refreshTextControls();

    // Hide the leading separator on the first visible group so there's no
    // unpaired divider at the bar's leading edge (left of the strip, top of the
    // panel).
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

  // The text-style groups: each shows when its property applies (Text color and
  // Font+Size for any text; Align for shape text only). The bar scrolls when
  // the full set overflows.
  private refreshTextControls(): void {
    const textColor = this.styleTargetTextColor();
    this.textColorGroup.set_visible(textColor !== null);
    this.textColorSwatchSet(textColor);
    setCaption(
      this.textColorLabel,
      _('Text color'),
      this.selectionMixed((a) => a.getTextColor())
    );

    // Font + size share one group (they co-occur for any text).
    const fontDesc = this.styleTargetFontDesc();
    this.fontGroup.set_visible(fontDesc !== null);
    if (fontDesc !== null) this.applyFontModel(fontDesc);
    setCaption(
      this.fontLabel,
      _('Font'),
      this.selectionMixed((a) => a.getFontDesc())
    );
    const fontSize = this.styleTargetFontSize();
    if (fontSize !== null) this.fontSizeSpinner.set_value(fontSize);
    setCaption(
      this.fontSizeLabel,
      _('Size'),
      this.selectionMixed((a) => a.getFontSize())
    );

    // Align: shape text only.
    const align = this.styleTargetAlign();
    const alignMixed = this.selectionMixed((a) => a.getAlign());
    this.alignGroup.set_visible(align !== null);
    this.setActiveAlign(align === null || alignMixed ? null : align);
    setCaption(this.alignLabel, _('Align'), alignMixed);
  }

  // The Group selector and per-group Variant control (both number-stamp only).
  // Split out of refresh() so each stays simple. Group shows for the number
  // tool (picks the placement group) and for a stamps-only selection (reassigns
  // it); Variant shows the active group's value (placement) or the selection's
  // (select), marking "(mixed)" when selected stamps disagree.
  private refreshStampControls(): void {
    const tool = this.canvas.getTool();

    // Populated groups are the reassignment targets shown in select mode. The
    // number tool additionally adds its placement group, which may still be
    // empty (a new "+ New group") — that's the one empty group allowed to show.
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

    // Start shares the variant's visibility: both describe the group, so they
    // appear together whenever a group is addressable.
    const startValue: number | null =
      tool === 'number'
        ? this.canvas.getPlacementGroupStart()
        : tool === 'select'
          ? this.selectionSummary((a) => numberStampStart(a)).value
          : null;
    this.startGroup.set_visible(startValue !== null);
    if (startValue !== null) {
      this.startVariant = variantValue ?? 'number';
      this.startSpin.set_value(startValue);
      // set_value only emits `output` when the value actually changes, so the
      // text is written directly — a variant switch alone leaves it unchanged.
      this.showStartValue();
    }
    setCaption(
      this.startLabel,
      _('Start'),
      this.selectionMixed((a) => numberStampStart(a))
    );
  }

  // Render the Start field: the number itself, or the letter it maps to.
  private showStartValue(): void {
    this.startSpin.set_text(stampLabel(this.startSpin.get_value(), this.startVariant));
  }

  // Rewrite the Start field's text into the digits GTK's own conversion reads,
  // so a typed letter becomes its count and anything unparseable restores the
  // current value instead of falling back to zero.
  private normalizeStartText(): void {
    const parsed = parseStampStart(this.startSpin.get_text(), this.startVariant);
    this.startSpin.set_text(String(parsed ?? this.startSpin.get_value()));
  }

  // Rebuild the group dropdown rows to "Group 1..count" plus a trailing
  // "+ New group". Labels are positional (gap-free); groupIds (set in refresh)
  // holds the index → stable id mapping the handlers use.
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

  private onStartPicked(): void {
    if (this.updatingPicker || !this.startSpin) return;
    const start = Math.round(this.startSpin.get_value());
    if (this.canvas.getTool() === 'select') {
      this.canvas.setSelectedGroupsStart(start);
    } else {
      this.canvas.setPlacementGroupStart(start);
    }
  }

  private onFontDescPicked(): void {
    if (this.updatingPicker || !this.fontDropdown) return;
    const idx = this.fontDropdown.get_selected();
    if (idx === Gtk.INVALID_LIST_POSITION) return;
    if (idx >= this.fontModel.length) return;
    const fontDesc = this.fontModel[idx].family;
    const tool = this.canvas.getTool();
    const editorActive = this.editor.isActive();
    // Applying the font re-enters refresh() → applyFontModel; the guard keeps
    // that from swapping the dropdown's model mid-emission (would crash).
    this.inFontPick = true;
    try {
      // Active edit → apply to the editor (which propagates to commit and
      // updates the live preview + caret focus). Outside an edit, fall back
      // to the standard select-vs-tool routing. The remembered tool default
      // also updates for text-tool placements so the next click inherits.
      if (editorActive) {
        this.patchEditorStyle({fontDesc});
      } else if (tool === 'select') {
        this.canvas.replaceSelectedFontDesc(fontDesc);
      }
      if (defaultFontDescForTool(tool) !== null) {
        this.canvas.setToolFontDesc(tool, fontDesc);
      }
    } finally {
      this.inFontPick = false;
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

  // Alignment routing: the editor takes it during a box edit (live
  // justification + commit), else broadcast to the selected shape's text. No
  // tool default.
  private onAlignPicked(align: TextAlign): void {
    if (this.editor.isActive()) {
      this.patchEditorStyle({align});
    } else if (this.canvas.getTool() === 'select') {
      this.canvas.replaceSelectedAlign(align);
    }
  }

  // Summarize a style property over the whole selection. A control is
  // "applicable" only when EVERY selected action has the property (its getter
  // is non-null) — that's the shared-control rule. The displayed value is the
  // first selected action's; `mixed` is true when they don't all agree. Empty
  // selection or any member without the property → not applicable.
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
  // so refresh() can mark the control's caption as "(mixed)". Never mixed
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

  // Alignment applies only to shape text: during a box edit (the editor owns
  // it) or a selected shape-with-text. Null hides the Align row (standalone
  // text and every tool). No tool default — there's no tool that places
  // alignable text.
  private styleTargetAlign(): TextAlign | null {
    if (this.editor.isActive()) {
      return this.editor.isBoxEdit() ? (this.editor.getCurrentStyle()?.align ?? null) : null;
    }
    if (this.canvas.getTool() === 'select') {
      return this.selectionSummary((a) => a.getAlign()).value;
    }
    return null;
  }

  // The stroke/outline color the picker should display, or null when there's
  // none. During a text edit this is null (text has no stroke) — the glyph
  // color is the text-color channel below.
  private styleTargetColor(): ColorRGBA | null {
    if (this.editor.isActive()) return null;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getColor()).value;
    }
    return this.canvas.getToolColor(tool);
  }

  // The text-foreground color to display: the editor owns it during an edit
  // (the committed glyph color), else the selection summary or tool default.
  private styleTargetTextColor(): ColorRGBA | null {
    if (this.editor.isActive()) {
      return this.editor.getCurrentStyle()?.color ?? null;
    }
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getTextColor()).value;
    }
    return this.canvas.getToolTextColor(tool);
  }

  private styleTargetWidth(): number | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getWidth()).value;
    }
    return this.canvas.getToolWidth(tool);
  }

  private styleTargetCornerRadius(): number | null {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getCornerRadius()).value;
    }
    return this.canvas.getToolCornerRadius(tool);
  }

  private styleTargetFill(): ColorRGBA | null {
    // Hidden during any text edit: the editor doesn't preview a fill change, so
    // showing the control is misleading. A standalone text's background plate
    // is edited in select mode; a shape's fill likewise.
    if (this.editor.isActive()) return null;
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

  // Opacity to display, or null to hide the control. Select-mode only: image
  // items are the only actions with an opacity, and no tool places them.
  private styleTargetOpacity(): number | null {
    if (this.editor.isActive() || this.canvas.getTool() !== 'select') return null;
    return this.selectionSummary((a) => a.getOpacity()).value;
  }

  // Callout-tail state to display, or null when the control should hide (text
  // edit, non-select tool, or no selected box shape). Select-mode only: the
  // tail is per-shape geometry with no tool default. `false` is a real value —
  // compare against null.
  private styleTargetTail(): boolean | null {
    if (this.editor.isActive()) return null;
    if (this.canvas.getTool() !== 'select') return null;
    return this.selectionSummary((a) => a.getTail()).value;
  }

  // The arrow end to display, or null when there's no applicable target (text
  // edit, or a tool/selection with no arrowhead).
  private styleTargetArrowHead(): ArrowEnd | null {
    if (this.editor.isActive()) return null;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getArrowHead()).value;
    }
    return this.canvas.getToolArrowHead(tool);
  }

  private styleTargetArrowTail(): ArrowEnd | null {
    if (this.editor.isActive()) return null;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      return this.selectionSummary((a) => a.getArrowTail()).value;
    }
    return this.canvas.getToolArrowTail(tool);
  }

  // Called from the fill swatch's dialog on OK (with the chosen color), so it
  // commits even when the color equals the one shown — broadcasting to every
  // selected action flattens a mixed selection as intended.
  private onFillPicked(fill: ColorRGBA): void {
    const tool = this.canvas.getTool();
    const editorActive = this.editor.isActive();
    // Same routing as the color picker: the editor takes it during an active
    // text edit (Fill = the background plate); otherwise apply to the
    // selection.
    if (editorActive) {
      this.patchEditorStyle({bg: fill});
    } else if (tool === 'select') {
      // Coalesce-by-key gives a single history entry for a drag (see pushState
      // in canvas_view.ts).
      this.canvas.replaceSelectedFill(fill);
    }
    // Remembered tool default for any non-select tool that has a fill
    // (rect/oval/number/text plus the resize padding fill).
    if (tool !== 'select' && defaultFillForTool(tool) !== null) {
      this.canvas.setToolFill(tool, fill);
    }
    this.widthPreview.queue_draw();
  }

  private onDashPicked(): void {
    if (this.updatingPicker || !this.dashDropdown) return;
    const dash = DASH_ORDER[this.dashDropdown.get_selected()] ?? DEFAULT_DASH;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      // Same select-edit structure as the other pickers; coalesce-by-key keeps
      // a rapid re-pick to one history entry (see pushState in canvas_view.ts).
      this.canvas.replaceSelectedDash(dash);
    } else if (defaultDashForTool(tool) !== null) {
      this.canvas.setToolDash(tool, dash);
    }
  }

  private onArrowHeadPicked(): void {
    if (this.updatingPicker || !this.arrowHeadDropdown) return;
    const end = ARROW_END_ORDER[this.arrowHeadDropdown.get_selected()] ?? DEFAULT_ARROW_HEAD;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      this.canvas.replaceSelectedArrowHead(end);
    } else if (defaultArrowHeadForTool(tool) !== null) {
      this.canvas.setToolArrowHead(tool, end);
    }
  }

  private onArrowTailPicked(): void {
    if (this.updatingPicker || !this.arrowTailDropdown) return;
    const end = ARROW_END_ORDER[this.arrowTailDropdown.get_selected()] ?? DEFAULT_ARROW_TAIL;
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      this.canvas.replaceSelectedArrowTail(end);
    } else if (defaultArrowTailForTool(tool) !== null) {
      this.canvas.setToolArrowTail(tool, end);
    }
  }

  private onOpacityPicked(): void {
    if (this.updatingPicker || !this.opacitySpin) return;
    if (this.canvas.getTool() !== 'select') return;
    this.canvas.replaceSelectedOpacity(this.opacitySpin.get_value() / 100);
  }

  // Select-mode only (the control is hidden otherwise); no tool default to
  // write — see replaceSelectedTail.
  private onTailPicked(): void {
    if (this.updatingPicker || !this.tailSwitch) return;
    if (this.canvas.getTool() !== 'select') return;
    this.canvas.replaceSelectedTail(this.tailSwitch.get_active());
  }

  // Called from the color swatch's dialog on OK (with the chosen color); see
  // onFillPicked for why this commits regardless of whether the value changed.
  // This is the stroke/outline Color — hidden during a text edit, so (unlike
  // the text-color picker) it has no editor branch.
  private onColorPicked(color: ColorRGBA): void {
    const tool = this.canvas.getTool();
    if (tool === 'select') {
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

  // The text-foreground color picker (getTextColor). The editor owns it during
  // an active text edit; otherwise it broadcasts to the selection / is
  // remembered as the tool default — same structure as onColorPicked.
  private onTextColorPicked(color: ColorRGBA): void {
    const tool = this.canvas.getTool();
    const editorActive = this.editor.isActive();
    if (editorActive) {
      this.patchEditorStyle({color});
    } else if (tool === 'select') {
      this.canvas.replaceSelectedTextColor(color);
    }
    if (tool !== 'select' && tool !== 'resize' && defaultTextColorForTool(tool) !== null) {
      this.canvas.setToolTextColor(tool, color);
    }
    this.widthPreview.queue_draw();
  }

  private onWidthPicked(): void {
    if (this.updatingPicker || !this.widthSpin) return;
    const width = this.widthSpin.get_value();
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      // In select mode, resize the selection in place; same select-edit
      // structure as recolor.
      // pushState coalesces by `width:${i}` so a run of steps is one history
      // entry, not one per step (see pushState in canvas_view.ts).
      this.canvas.replaceSelectedWidth(width);
    } else if (defaultWidthForTool(tool) !== null) {
      this.canvas.setToolWidth(tool, width);
    }
    this.widthPreview.queue_draw();
  }

  private onCornerRadiusPicked(): void {
    if (this.updatingPicker || !this.cornerSpin) return;
    const radius = this.cornerSpin.get_value();
    const tool = this.canvas.getTool();
    if (tool === 'select') {
      this.canvas.replaceSelectedCornerRadius(radius);
    } else if (defaultCornerRadiusForTool(tool) !== null) {
      this.canvas.setToolCornerRadius(tool, radius);
    }
  }
}
