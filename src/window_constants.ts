import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {DashStyle, ToolId} from './actions.js';

// Maps the dash dropdown's selection index to a DashStyle (and back, via
// indexOf). Order must match the strings passed to Gtk.DropDown.new_from_strings.
export const DASH_ORDER: DashStyle[] = ['solid', 'dashed', 'dotted'];

const WINDOW_CSS = `
  .annoscr-font-size > text {
    padding-left: 12px;
  }
  .annoscr-keycap {
    min-width: 1.4em;
    padding: 1px 6px;
    border-radius: 6px;
    border: 1px solid alpha(@window_fg_color, 0.25);
    background-color: alpha(@window_fg_color, 0.08);
    font-size: 0.85em;
  }
`;

let windowCssInstalled = false;
export function installWindowCss(): void {
  if (windowCssInstalled) return;
  const display = Gdk.Display.get_default();
  if (!display) return;
  const provider = new Gtk.CssProvider();
  provider.load_from_string(WINDOW_CSS);
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  Gtk.StyleContext.add_provider_for_display(
    display,
    provider,
    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
  );
  windowCssInstalled = true;
}

export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
];

export interface SizePreset {
  label: string;
  w: number;
  h: number;
}

export const SIZE_PRESETS: SizePreset[] = [
  {label: 'Custom', w: 0, h: 0},
  {label: '640 × 480', w: 640, h: 480},
  {label: '800 × 600', w: 800, h: 600},
  {label: '1280 × 720 (HD)', w: 1280, h: 720},
  {label: '1920 × 1080 (Full HD)', w: 1920, h: 1080},
];

export const DEFAULT_PRESET_INDEX = 2;

// Sticky zoom levels the slider snaps to and Ctrl+/Ctrl- step through.
export const ZOOM_DETENTS = [0.25, 0.5, 1, 2, 4];
// Multiplicative step per Ctrl+scroll notch (exp of accumulated wheel delta).
export const ZOOM_SCROLL_STEP = 0.15;

export interface ToolDef {
  id: ToolId;
  label: string;
  icon: string;
  accelerator: string;
}

export const TOOLS: ToolDef[] = [
  {id: 'select', label: 'Select', icon: 'annoscr-select-symbolic', accelerator: 's'},
  {id: 'pen', label: 'Pen', icon: 'annoscr-pen-symbolic', accelerator: 'p'},
  {id: 'highlighter', label: 'Highlight', icon: 'annoscr-highlighter-symbolic', accelerator: 'h'},
  {id: 'text', label: 'Text', icon: 'annoscr-text-symbolic', accelerator: 't'},
  {id: 'number', label: 'Number', icon: 'annoscr-number-symbolic', accelerator: 'n'},
  {id: 'line', label: 'Line', icon: 'annoscr-line-symbolic', accelerator: 'l'},
  {id: 'arrow', label: 'Arrow', icon: 'annoscr-arrow-symbolic', accelerator: 'a'},
  {id: 'rect', label: 'Rect', icon: 'annoscr-rect-symbolic', accelerator: 'r'},
  {id: 'oval', label: 'Oval', icon: 'annoscr-oval-symbolic', accelerator: 'o'},
];
