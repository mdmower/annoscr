import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {CanvasView, ZOOM_MAX, ZOOM_MIN} from './canvas_view.js';
import {TextEditor} from './text_editor.js';
import {ZOOM_DETENTS, ZOOM_SCROLL_STEP} from './window_constants.js';
import {_} from './i18n.js';

// Owns the scrolled view of the canvas and the bottom status/zoom bar: the
// dimensions readout, the Fit/1:1 buttons, the log2 zoom slider, and the
// Ctrl+scroll zoom handler. Reads zoom/dimension state from the canvas and
// commits any active edit (through the editor) before changing zoom. The
// window builds the content overlay, hands it in, and gets back the scrolled
// widget + status bar; it calls refresh() on canvas state/resize and routes
// the keyboard zoom shortcuts to setFit/zoomToCenter/zoomStepDetent.
export class ZoomController {
  private scrolled: Gtk.ScrolledWindow;
  private statusBar: Gtk.Box;
  private statusLabel!: Gtk.Label;
  private zoomLabel!: Gtk.Label;
  private zoomSlider!: Gtk.Scale;
  private zoomControls!: Gtk.Box;
  // Guards programmatic zoom-slider updates from re-triggering the handler.
  private updatingZoom = false;
  // Scroll offset to apply after a zoom-driven relayout, so the anchored
  // point stays under the cursor once the new size is allocated.
  private pendingScroll: {h: number; v: number} | null = null;

  constructor(
    private canvas: InstanceType<typeof CanvasView>,
    private editor: TextEditor,
    content: Gtk.Widget
  ) {
    this.scrolled = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
    });
    this.scrolled.set_child(content);
    this.installZoomScroll();
    this.statusBar = this.buildStatusBar();
  }

  getScrolled(): Gtk.ScrolledWindow {
    return this.scrolled;
  }

  getStatusBar(): Gtk.Box {
    return this.statusBar;
  }

  private buildStatusBar(): Gtk.Box {
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      margin_start: 12,
      margin_end: 12,
      margin_top: 4,
      margin_bottom: 4,
    });
    this.statusLabel = new Gtk.Label({
      label: '',
      halign: Gtk.Align.START,
      hexpand: true,
      css_classes: ['dim-label', 'caption'],
    });
    box.append(this.statusLabel);

    const fitBtn = new Gtk.Button({
      label: _('Fit'),
      tooltip_text: _('Fit to window (Ctrl+0)'),
      css_classes: ['flat'],
    });
    fitBtn.connect('clicked', () => this.setFit());
    const oneBtn = new Gtk.Button({
      // 1:1 is a zoom ratio, not translated.
      label: '1:1',
      tooltip_text: _('1:1 pixel zoom (Ctrl+1)'),
      css_classes: ['flat'],
    });
    oneBtn.connect('clicked', () => this.zoomToCenter(1));
    const zoomBtnBox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 0,
      css_classes: ['linked'],
    });
    zoomBtnBox.append(fitBtn);
    zoomBtnBox.append(oneBtn);

    // Log2 scale so equal slider travel doubles or halves the zoom and the
    // keyboard detents (25/50/100/200/400) sit at even intervals. Slider value
    // is log2(zoom); zoom is 2^value. No marks: GtkScale's mark feature also
    // snaps the value to them (baked in before we can intercept it), so the
    // slider stays free/continuous — exact stops come from Ctrl+/Ctrl- and 1:1.
    this.zoomSlider = new Gtk.Scale({
      orientation: Gtk.Orientation.HORIZONTAL,
      adjustment: new Gtk.Adjustment({
        lower: Math.log2(ZOOM_MIN),
        upper: Math.log2(ZOOM_MAX),
        step_increment: 0.05,
        page_increment: 1,
      }),
      draw_value: false,
      width_request: 225,
      valign: Gtk.Align.CENTER,
      tooltip_text: `${_('Drag to zoom')}\n${_('Hold Shift to fine-tune')}`,
    });
    this.zoomSlider.connect('value-changed', () => this.onZoomSliderChanged());

    this.zoomLabel = new Gtk.Label({
      label: '',
      // Pin to a fixed width. If this label resizes as the % text changes
      // (e.g. "100%" vs "114%" render at different widths in a proportional
      // font), the hexpand status label to its left absorbs the delta and
      // shifts the slider ~2px under a held thumb — which changes the zoom,
      // resizes the label again, and oscillates at the frame rate. width_chars=4
      // was too small for "100%" (wide %), so the label grew to fit content and
      // varied; 6 leaves headroom.
      width_chars: 6,
      max_width_chars: 6,
      xalign: 1,
      css_classes: ['dim-label', 'caption'],
    });

    this.zoomControls = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 6,
      visible: false,
    });
    this.zoomControls.append(zoomBtnBox);
    this.zoomControls.append(this.zoomSlider);
    this.zoomControls.append(this.zoomLabel);
    box.append(this.zoomControls);

    return box;
  }

  refresh(): void {
    if (!this.statusLabel) return;
    const img = this.canvas.getImageDimensions();
    if (!img) {
      this.statusLabel.set_label('');
      this.zoomControls.set_visible(false);
      return;
    }
    // Translatable "W \u00d7 H px" via a two-placeholder template, so a locale can
    // reorder or relabel the unit. Both the current and (resize-preview) target
    // dimensions render through the same template.
    const dims = (w: number, h: number): string =>
      _('%w \u00d7 %h px').replace('%w', String(w)).replace('%h', String(h));
    const base = dims(img.w, img.h);
    const r = this.canvas.getResizeDimensions();
    // U+2003 EM SPACE on either side of the arrow gives breathing room
    // without depending on Pango markup or label padding tricks.
    this.statusLabel.set_label(r ? `${base} → ${dims(r.w, r.h)}` : base);
    const scale = this.canvas.getZoomScale();
    if (scale !== null) {
      this.zoomLabel.set_label(`${Math.round(scale * 100)}%`);
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
      // Only move the thumb when it doesn't already represent this zoom.
      // Writing during an active drag would fight the mouse, oscillating the
      // thumb against the pointer.
      const sliderZoom = Math.pow(2, this.zoomSlider.get_value());
      if (Math.abs(sliderZoom - clamped) > 1e-6) {
        this.updatingZoom = true;
        this.zoomSlider.set_value(Math.log2(clamped));
        this.updatingZoom = false;
      }
    }
    this.zoomControls.set_visible(true);
  }

  setFit(): void {
    this.editor.commitIfActive();
    this.canvas.setFitMode();
  }

  private setZoomFactor(factor: number): void {
    this.editor.commitIfActive();
    this.canvas.setZoom(factor);
  }

  // Set a fixed zoom while keeping the image point at (anchorX, anchorY) —
  // widget-local coords, which equal content coords inside the viewport —
  // pinned under the same on-screen position.
  private zoomTo(factor: number, anchorX: number, anchorY: number): void {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor));
    const hadj = this.scrolled.get_hadjustment();
    const vadj = this.scrolled.get_vadjustment();
    const oldScale = this.canvas.getZoomScale() ?? 1;
    const ratio = clamped / oldScale;
    const hVal = anchorX * ratio - (anchorX - hadj.get_value());
    const vVal = anchorY * ratio - (anchorY - vadj.get_value());
    this.setZoomFactor(clamped);
    // Apply now (correct when zooming out / shrinking) and again after the
    // relayout grows the scrollable area (needed when zooming in).
    hadj.set_value(hVal);
    vadj.set_value(vVal);
    this.pendingScroll = {h: hVal, v: vVal};
  }

  // Zoom anchored on the center of the visible viewport (for keyboard/button
  // zoom, which has no cursor position).
  zoomToCenter(factor: number): void {
    const hadj = this.scrolled.get_hadjustment();
    const vadj = this.scrolled.get_vadjustment();
    const cx = hadj.get_value() + hadj.get_page_size() / 2;
    const cy = vadj.get_value() + vadj.get_page_size() / 2;
    this.zoomTo(factor, cx, cy);
  }

  // Step to the next/previous detent zoom from the current scale (Ctrl+/Ctrl-).
  zoomStepDetent(dir: 1 | -1): void {
    const cur = this.canvas.getZoomScale() ?? 1;
    let target: number;
    if (dir > 0) {
      target = ZOOM_DETENTS.find((d) => d > cur * 1.001) ?? ZOOM_MAX;
    } else {
      const below = ZOOM_DETENTS.filter((d) => d < cur * 0.999);
      target = below.length > 0 ? below[below.length - 1] : ZOOM_MIN;
    }
    this.zoomToCenter(target);
  }

  applyPendingScroll(): void {
    if (!this.pendingScroll) return;
    const {h, v} = this.pendingScroll;
    this.pendingScroll = null;
    this.scrolled.get_hadjustment().set_value(h);
    this.scrolled.get_vadjustment().set_value(v);
  }

  private onZoomSliderChanged(): void {
    if (this.updatingZoom) return;
    // Plain zoom (no scroll anchoring): the slider fires continuously while
    // dragging, and re-anchoring the scroll on every event yanks the view —
    // especially as the scrollable size crosses a scrollbar boundary. Let
    // GTK keep the scroll position; anchoring is for Ctrl+scroll and keys.
    this.setZoomFactor(Math.pow(2, this.zoomSlider.get_value()));
  }

  // Ctrl+scroll over the canvas zooms (anchored on the cursor) instead of
  // scrolling. A CAPTURE-phase controller on the scrolled window intercepts
  // the event before the built-in scroll handling.
  private installZoomScroll(): void {
    const scroll = new Gtk.EventControllerScroll();
    scroll.set_flags(Gtk.EventControllerScrollFlags.BOTH_AXES);
    scroll.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    scroll.connect('scroll', (controller, _dx, dy) => {
      const state = controller.get_current_event_state();
      if ((state & Gdk.ModifierType.CONTROL_MASK) === 0) return false;
      if (!this.canvas.hasImage()) return false;
      const cur = this.canvas.getZoomScale() ?? 1;
      const factor = cur * Math.exp(-dy * ZOOM_SCROLL_STEP);
      const ptr = this.canvas.getLastPointer();
      if (ptr) this.zoomTo(factor, ptr[0], ptr[1]);
      else this.zoomToCenter(factor);
      return true;
    });
    this.scrolled.add_controller(scroll);
  }
}
