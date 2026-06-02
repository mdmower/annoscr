import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

import {DashStyle, ToolId} from './actions.js';
import {N_} from './i18n.js';

// Maps the dash dropdown's selection index to a DashStyle (and back, via
// indexOf). Order must match the strings passed to Gtk.DropDown.new_from_strings.
export const DASH_ORDER: DashStyle[] = ['solid', 'dashed', 'dotted'];

const WINDOW_CSS = `
  .annoscr-font-size > text {
    padding-left: 12px;
  }
  .annoscr-opacity-scale > value {
    margin-left: 16px;
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

// Labels marked with N_ (extracted, not translated here): these are built into
// a Gtk.StringList at dialog-construction time, which is post-init, so the
// caller translates each with _() then. The pure-dimension entries carry a
// translator note since only the parenthetical (HD / Full HD) ever differs.
export const SIZE_PRESETS: SizePreset[] = [
  {label: N_('Custom'), w: 0, h: 0},
  {label: N_('640 × 480'), w: 640, h: 480},
  {label: N_('800 × 600'), w: 800, h: 600},
  {label: N_('1280 × 720 (HD)'), w: 1280, h: 720},
  {label: N_('1920 × 1080 (Full HD)'), w: 1920, h: 1080},
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

// Labels marked with N_ (extracted, not translated here): the toolbar reads
// `label` into tooltips at build time (post-init) and translates with _() there.
export const TOOLS: ToolDef[] = [
  {id: 'select', label: N_('Select'), icon: 'annoscr-select-symbolic', accelerator: 's'},
  {id: 'pen', label: N_('Pen'), icon: 'annoscr-pen-symbolic', accelerator: 'p'},
  {
    id: 'highlighter',
    label: N_('Highlight'),
    icon: 'annoscr-highlighter-symbolic',
    accelerator: 'h',
  },
  {id: 'text', label: N_('Text'), icon: 'annoscr-text-symbolic', accelerator: 't'},
  {id: 'number', label: N_('Number'), icon: 'annoscr-number-symbolic', accelerator: 'n'},
  {id: 'line', label: N_('Line'), icon: 'annoscr-line-symbolic', accelerator: 'l'},
  {id: 'arrow', label: N_('Arrow'), icon: 'annoscr-arrow-symbolic', accelerator: 'a'},
  {id: 'rect', label: N_('Rectangle'), icon: 'annoscr-rect-symbolic', accelerator: 'r'},
  {id: 'oval', label: N_('Oval'), icon: 'annoscr-oval-symbolic', accelerator: 'o'},
];
