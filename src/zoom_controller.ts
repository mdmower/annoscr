import Gdk from 'gi://Gdk?version=4.0';
import GLib from 'gi://GLib?version=2.0';
import Graphene from 'gi://Graphene?version=1.0';
import Gtk from 'gi://Gtk?version=4.0';

import {CanvasView, ZOOM_MAX, ZOOM_MIN} from './canvas_view.js';
import {TextEditor} from './text_editor.js';
import {ZOOM_DETENTS, ZOOM_SCROLL_STEP} from './window_constants.js';
import {_} from './i18n.js';

// How long a cursor-anchored zoom's anchor outlives the last zoom event (ms):
// long enough for a smooth-scroll burst to share one anchor, short enough
// that a later unrelated canvas resize can't re-assert a stale one.
const ANCHOR_RETIRE_MS = 150;

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
  // Cursor-anchored zoom state: the image point to keep pinned at a
  // viewport-relative screen position. Kept in image space (not as a
  // precomputed scroll value) so each application can re-resolve it against
  // the transform at hand. Lives from the first zoom event of a scroll burst
  // until retired.
  private pendingAnchor: {ix: number; iy: number; sx: number; sy: number} | null = null;
  // Debounced retire timer for the anchor (0 = none). See scheduleAnchorRetire.
  private anchorRetireId = 0;

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
    // without depending on Pango markup or label padding tricks. Escaped
    // because eslint's no-irregular-whitespace rejects the literal character.
    this.statusLabel.set_label(r ? `${base}\u2003→\u2003${dims(r.w, r.h)}` : base);
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
    this.clearAnchor();
    this.canvas.setFitMode();
  }

  private setZoomFactor(factor: number): void {
    this.editor.commitIfActive();
    this.clearAnchor();
    this.canvas.setZoom(factor);
  }

  // Set a fixed zoom while keeping the image point under (screenX, screenY) —
  // viewport-relative coords — pinned at that same on-screen position.
  private zoomTo(factor: number, screenX: number, screenY: number): void {
    // Commit before reading the transform: a commit can add an action, which
    // in 1:1 mode can grow the displayed area and shift the offset.
    this.editor.commitIfActive();
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor));
    // Smooth scrolling lands several zoom events between layout passes. Only
    // the first derives the anchor (the transform is settled then); the rest
    // reuse it — re-deriving mid-flight (new zoom, stale allocation) would
    // re-anchor on a bogus image point and make the view wander.
    if (!this.pendingAnchor) {
      const oldScale = this.canvas.getZoomScale();
      const oldOff = this.canvas.getViewOffset();
      if (oldScale === null || oldOff === null) {
        this.canvas.setZoom(clamped);
        return;
      }
      // Image point under the screen position (content = screen + live
      // scroll). The view offset matters: in fit / zoomed-out views the image
      // is centered, and ignoring the letterbox margin lurches the view.
      this.pendingAnchor = {
        ix: (screenX + this.scrolled.get_hadjustment().get_value() - oldOff[0]) / oldScale,
        iy: (screenY + this.scrolled.get_vadjustment().get_value() - oldOff[1]) / oldScale,
        sx: screenX,
        sy: screenY,
      };
    }
    this.canvas.setZoom(clamped);
    // Apply NOW from predicted geometry so the first frame at the new scale
    // is already scrolled right — the resize hook alone is one frame late, a
    // lurch per smooth-scroll event. The hook then re-asserts the same values
    // from the live transform, and the debounced timer retires the anchor.
    this.applyAnchorPredicted(clamped);
    this.scheduleAnchorRetire();
  }

  // Apply the anchor under the PREDICTED transform for `zoom` (the layout
  // hasn't run yet). Range and value are configured together: the old range
  // would clamp the new value and leave the frame partially mis-scrolled.
  private applyAnchorPredicted(zoom: number): void {
    if (!this.pendingAnchor) return;
    const p = this.canvas.predictLayout(zoom);
    if (!p) return;
    const {ix, iy, sx, sy} = this.pendingAnchor;
    const setAdj = (adj: Gtk.Adjustment, target: number, upper: number): void => {
      const page = adj.get_page_size();
      const value = Math.min(Math.max(target, 0), Math.max(0, upper - page));
      adj.configure(value, 0, upper, adj.get_step_increment(), adj.get_page_increment(), page);
    };
    const targetH = p.offX + ix * zoom - sx;
    const targetV = p.offY + iy * zoom - sy;
    setAdj(this.scrolled.get_hadjustment(), targetH, p.w);
    setAdj(this.scrolled.get_vadjustment(), targetV, p.h);
  }

  // Scroll so the pending anchor's image point sits at its recorded on-screen
  // position under the canvas's CURRENT transform.
  private applyAnchor(): void {
    if (!this.pendingAnchor) return;
    const scale = this.canvas.getZoomScale();
    const off = this.canvas.getViewOffset();
    if (scale === null || off === null) return;
    const {ix, iy, sx, sy} = this.pendingAnchor;
    this.scrolled.get_hadjustment().set_value(off[0] + ix * scale - sx);
    this.scrolled.get_vadjustment().set_value(off[1] + iy * scale - sy);
  }

  // Retire the anchor shortly after a burst's last zoom event. Retiring only
  // CLEARS it — the view is already placed, and applying from a timer could
  // hit a mid-flight transform or clobber a pan started right after zooming.
  // Debounced: each zoom event extends the anchor's life.
  private scheduleAnchorRetire(): void {
    if (this.anchorRetireId !== 0) GLib.source_remove(this.anchorRetireId);
    this.anchorRetireId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANCHOR_RETIRE_MS, () => {
      this.anchorRetireId = 0;
      this.pendingAnchor = null;
      return GLib.SOURCE_REMOVE;
    });
  }

  // Drop the anchor immediately, for the zoom paths that must NOT anchor
  // (slider, Fit) — a still-live anchor from a just-finished Ctrl+scroll must
  // not re-assert itself on their relayouts.
  private clearAnchor(): void {
    this.pendingAnchor = null;
    if (this.anchorRetireId !== 0) {
      GLib.source_remove(this.anchorRetireId);
      this.anchorRetireId = 0;
    }
  }

  // Zoom anchored on the center of the visible viewport (for keyboard/button
  // zoom, which has no cursor position).
  zoomToCenter(factor: number): void {
    this.zoomTo(
      factor,
      this.scrolled.get_hadjustment().get_page_size() / 2,
      this.scrolled.get_vadjustment().get_page_size() / 2
    );
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

  // Re-apply the in-flight anchor after a zoom-driven canvas relayout (wired
  // to the canvas 'resize' signal by the window), pre-paint. Does NOT retire
  // the anchor: ranges can still be mid-update here, and a scroll burst needs
  // it alive across events — the debounced timer retires it.
  applyPendingScroll(): void {
    this.applyAnchor();
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
      // Anchor on the live seat-queried pointer, not the canvas's cached
      // motion position: a touchpad zoom moves no pointer, so nothing
      // refreshes the cache while the content scrolls underneath it.
      const ptr = this.pointerScreenPosition();
      if (ptr) this.zoomTo(factor, ptr[0], ptr[1]);
      else this.zoomToCenter(factor);
      return true;
    });
    this.scrolled.add_controller(scroll);
  }

  // The pointer's position in the scrolled window's frame, queried live from
  // the seat (scroll events carry no position on some stacks; see the caller
  // for why the motion cache won't do). Deliberately NOT canvas coordinates:
  // the canvas's scroll translation updates only when a layout consumes the
  // adjustments, and this zoom path writes them outside that flow
  // (applyAnchorPredicted before layout, the resize hook during it), so a
  // canvas-frame position can be arbitrarily stale against the live
  // adjustments. The scrolled window's frame doesn't depend on scrolling:
  // surface coords → native widget (minus the shadow/decoration surface
  // transform) → scrolled window. Null when the pointer isn't over the window.
  private pointerScreenPosition(): [number, number] | null {
    const native = this.canvas.get_native();
    const surface = native?.get_surface();
    const pointer = surface?.get_display().get_default_seat()?.get_pointer();
    if (!native || !surface || !pointer) return null;
    const [inside, px, py] = surface.get_device_position(pointer);
    if (!inside) return null;
    const [tx, ty] = native.get_surface_transform();
    const [ok, local] = (native as unknown as Gtk.Widget).compute_point(
      this.scrolled,
      new Graphene.Point({x: px - tx, y: py - ty})
    );
    if (!ok) return null;
    return [local.x, local.y];
  }
}
