import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {_, N_} from './i18n.js';

interface Shortcut {
  keys: string[];
  // Optional second accelerator shown as an "or" alternative (e.g. Ctrl+Y for
  // redo). Both are really bound in window.ts installShortcuts.
  alt?: string[];
  desc: string;
}

interface Section {
  title: string;
  // Optional group subtitle (e.g. a caveat shared by the section's items).
  description?: string;
  items: Shortcut[];
}

// Mirrors the bindings wired in window.ts (installShortcuts + the menu accels).
// Kept in sync by hand — there's no single source of truth for accelerators yet.
// Section titles + descriptions are N_-marked (this table is built at module
// load, pre-init); presentShortcuts translates them with _() at display time.
// Keycap names (Ctrl, Shift, …) stay literal — they mirror physical keys.
const SECTIONS: Section[] = [
  {
    title: N_('General'),
    items: [
      {keys: ['Ctrl', 'N'], desc: N_('New blank canvas')},
      {keys: ['Ctrl', 'O'], desc: N_('Open image')},
      {keys: ['Ctrl', 'Shift', 'S'], desc: N_('Take screenshot')},
      {keys: ['Ctrl', 'S'], desc: N_('Save image')},
      {keys: ['Ctrl', 'C'], desc: N_('Copy to clipboard')},
      {keys: ['Ctrl', 'V'], desc: N_('Paste image')},
      {keys: ['Ctrl', ','], desc: N_('Preferences')},
      {keys: ['Ctrl', '?'], desc: N_('Keyboard shortcuts')},
      {keys: ['Ctrl', 'Q'], desc: N_('Quit')},
    ],
  },
  {
    title: N_('Edit'),
    items: [
      {keys: ['Ctrl', 'Z'], desc: N_('Undo')},
      {keys: ['Ctrl', 'Shift', 'Z'], alt: ['Ctrl', 'Y'], desc: N_('Redo')},
      {keys: ['Delete'], alt: ['Backspace'], desc: N_('Delete selection')},
      {keys: ['Ctrl', 'A'], desc: N_('Select all annotations (select tool)')},
      {keys: ['Ctrl', 'D'], desc: N_('Duplicate selection')},
      {keys: ['Ctrl', 'G'], desc: N_('Start a new stamp group (number / select tool)')},
      {keys: ['Esc'], desc: N_('Deselect')},
      {keys: ['['], alt: [']'], desc: N_('Walk through annotations (select tool)')},
      {keys: ['Space'], desc: N_('Select the aimed item, or place a stamp / text')},
      {keys: ['Shift', 'Space'], desc: N_('Add/remove the aimed item (select tool)')},
      {keys: ['Arrow keys'], desc: N_('Nudge the selection (Shift: larger steps)')},
      {keys: ['Ctrl', 'Arrow keys'], desc: N_('Resize selection (resizable items)')},
      {keys: ['Alt', '←'], alt: ['Alt', '→'], desc: N_('Rotate selection 15° (rotatable items)')},
      {keys: [','], alt: ['.'], desc: N_('Aim through items under the pointer (select tool)')},
      {keys: ['Enter'], desc: N_('Edit selected text (select tool)')},
    ],
  },
  {
    title: N_('Image'),
    items: [
      {keys: ['Ctrl', 'R'], desc: N_('Rotate right (90°)')},
      {keys: ['Ctrl', 'Shift', 'R'], desc: N_('Rotate left (90°)')},
      {keys: ['Ctrl', 'E'], desc: N_('Resize canvas')},
    ],
  },
  {
    title: N_('Z-order (select tool)'),
    description: N_('Reordering renumbers stamps within their group.'),
    items: [
      {keys: ['Ctrl', '['], desc: N_('Send backward')},
      {keys: ['Ctrl', ']'], desc: N_('Bring forward')},
      {keys: ['Ctrl', 'Shift', '['], desc: N_('Send to back')},
      {keys: ['Ctrl', 'Shift', ']'], desc: N_('Bring to front')},
    ],
  },
  {
    title: N_('Tools'),
    items: [
      {keys: ['S'], desc: N_('Select')},
      {keys: ['P'], desc: N_('Pen')},
      {keys: ['H'], desc: N_('Highlighter')},
      {keys: ['T'], desc: N_('Text')},
      {keys: ['N'], desc: N_('Number stamp')},
      {keys: ['L'], desc: N_('Line')},
      {keys: ['A'], desc: N_('Arrow')},
      {keys: ['R'], desc: N_('Rectangle')},
      {keys: ['O'], desc: N_('Oval')},
    ],
  },
  {
    title: N_('View'),
    items: [
      {keys: ['Ctrl', '0'], desc: N_('Fit to window')},
      {keys: ['Ctrl', '1'], desc: N_('1∶1 zoom')},
      {keys: ['Ctrl', '+'], desc: N_('Zoom in')},
      {keys: ['Ctrl', '−'], desc: N_('Zoom out')},
      {keys: ['Ctrl', 'Scroll'], desc: N_('Zoom at the pointer')},
      {keys: ['Arrow keys'], desc: N_('Pan the canvas (when nothing is selected)')},
    ],
  },
  {
    title: N_('Resize mode'),
    items: [
      {keys: ['Enter'], desc: N_('Apply resize')},
      {keys: ['Esc'], desc: N_('Cancel resize')},
    ],
  },
];

// Append one accelerator (a chord) as keycap chips joined by dim "+" labels.
// Relies on the .annoscr-keycap CSS class installed with WINDOW_CSS (window.ts).
function appendCombo(box: Gtk.Box, keys: string[]): void {
  const combo = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 4});
  keys.forEach((k, i) => {
    if (i > 0) combo.append(new Gtk.Label({label: '+', css_classes: ['dim-label', 'caption']}));
    combo.append(new Gtk.Label({label: k, css_classes: ['annoscr-keycap']}));
  });
  box.append(combo);
}

// Render a shortcut as its primary accelerator, plus an "or"-separated
// alternative when one exists (e.g. redo = Ctrl+Shift+Z or Ctrl+Y).
function buildKeys(sc: Shortcut): Gtk.Widget {
  const box = new Gtk.Box({
    orientation: Gtk.Orientation.HORIZONTAL,
    spacing: 6,
    valign: Gtk.Align.CENTER,
  });
  appendCombo(box, sc.keys);
  if (sc.alt) {
    box.append(new Gtk.Label({label: _('or'), css_classes: ['dim-label', 'caption']}));
    appendCombo(box, sc.alt);
  }
  return box;
}

export function presentShortcuts(parent: Gtk.Window): void {
  const dialog = new Adw.Dialog({
    title: _('Keyboard shortcuts'),
    content_width: 520,
    content_height: 640,
  });

  const page = new Adw.PreferencesPage();
  for (const section of SECTIONS) {
    const group = new Adw.PreferencesGroup({title: _(section.title)});
    if (section.description) group.set_description(_(section.description));
    for (const sc of section.items) {
      const row = new Adw.ActionRow({title: _(sc.desc)});
      row.add_suffix(buildKeys(sc));
      group.add(row);
    }
    page.add(group);
  }

  const toolbarView = new Adw.ToolbarView();
  toolbarView.add_top_bar(new Adw.HeaderBar());
  toolbarView.set_content(page);
  dialog.set_child(toolbarView);
  dialog.present(parent);
}
