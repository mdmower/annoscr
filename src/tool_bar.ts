import Gtk from 'gi://Gtk?version=4.0';

import {CanvasView} from './canvas_view.js';
import {TextEditor} from './text_editor.js';
import {ToolId} from './actions.js';
import {TOOLS} from './window_constants.js';
import {_} from './i18n.js';

// The tool selector (header title widget) plus the resize-mode toolbar overlay
// and the mode transitions. Owns the tool toggle buttons and both bars; drives
// canvas tool state and commits any active edit through the canvas/editor refs.
// The window adds getWidget() as the header title, getResizeToolbar() as a view
// overlay, and routes the tool accelerators / resize button / Enter / Escape to
// selectTool/toggleResizeMode/exitResizeMode.
export class ToolBar {
  private toolBox: Gtk.Box;
  private resizeToolbar: Gtk.Box;
  private applyBtn!: Gtk.Button;
  private toolButtons: Map<ToolId, Gtk.ToggleButton> = new Map();

  constructor(
    private canvas: InstanceType<typeof CanvasView>,
    private editor: TextEditor
  ) {
    this.toolBox = this.buildToolBar();
    this.resizeToolbar = this.buildResizeToolbar();
  }

  getWidget(): Gtk.Box {
    return this.toolBox;
  }

  getResizeToolbar(): Gtk.Box {
    return this.resizeToolbar;
  }

  private buildToolBar(): Gtk.Box {
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 0,
      css_classes: ['linked'],
    });
    let group: Gtk.ToggleButton | null = null;
    for (const tool of TOOLS) {
      const base = `${_(tool.label)} (${tool.accelerator.toUpperCase()})`;
      const tooltip =
        tool.id === 'select'
          ? `${base}\n${_('Shift+Click (or Shift+Space) to add/remove')}\n${_('Alt+Scroll or < > to aim through a stack')}`
          : base;
      const btn = new Gtk.ToggleButton({
        icon_name: tool.icon,
        tooltip_text: tooltip,
        active: tool.id === this.canvas.getTool(),
      });
      if (group) btn.set_group(group);
      else group = btn;
      btn.connect('toggled', () => {
        if (btn.get_active()) this.selectTool(tool.id);
      });
      this.toolButtons.set(tool.id, btn);
      box.append(btn);
    }
    return box;
  }

  selectTool(id: ToolId): void {
    // Switching to a non-resize tool while in resize mode = "I changed my
    // mind." Cancel any in-progress region and hide the toolbar inline
    // (calling exitResizeMode here would recurse — it also calls back into
    // setActiveTool).
    if (this.canvas.getTool() === 'resize' && id !== 'resize') {
      this.canvas.cancelResize();
      this.resizeToolbar.set_visible(false);
    }
    // Commit any in-progress text edit before switching away from the text tool.
    this.editor.commitIfActive();
    this.setActiveTool(id);
  }

  private setActiveTool(id: ToolId): void {
    this.canvas.setTool(id);
    const btn = this.toolButtons.get(id);
    if (btn && !btn.get_active()) btn.set_active(true);
  }

  private buildResizeToolbar(): Gtk.Box {
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      halign: Gtk.Align.CENTER,
      valign: Gtk.Align.START,
      margin_top: 12,
      visible: false,
      css_classes: ['toolbar', 'osd'],
    });
    const cancelBtn = new Gtk.Button({label: _('Cancel')});
    cancelBtn.connect('clicked', () => this.exitResizeMode(false));
    this.applyBtn = new Gtk.Button({
      label: _('Apply'),
      css_classes: ['suggested-action'],
    });
    this.applyBtn.connect('clicked', () => this.exitResizeMode(true));
    box.append(cancelBtn);
    box.append(this.applyBtn);
    return box;
  }

  toggleResizeMode(): void {
    if (this.canvas.getTool() === 'resize') {
      this.exitResizeMode(false);
    } else {
      this.enterResizeMode();
    }
  }

  private enterResizeMode(): void {
    if (!this.canvas.hasImage()) return;
    this.editor.commitIfActive();
    // Resize needs the whole canvas (image + orphans) visible to drag the
    // edges; a fixed zoom would leave it cramped behind scrollbars.
    this.canvas.setFitMode();
    this.canvas.setTool('resize');
    this.resizeToolbar.set_visible(true);
    // Focus Apply so Enter applies the resize (the window's Return shortcut also
    // applies). Otherwise the first-appended Cancel button holds focus and
    // activates on Enter, cancelling. Tab still reaches both buttons.
    this.applyBtn.grab_focus();
  }

  exitResizeMode(apply: boolean): void {
    if (this.canvas.getTool() !== 'resize') return;
    if (apply) this.canvas.applyResize();
    else this.canvas.cancelResize();
    this.resizeToolbar.set_visible(false);
    this.setActiveTool('select');
  }
}
