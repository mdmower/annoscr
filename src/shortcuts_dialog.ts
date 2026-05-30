import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

interface Shortcut {
  keys: string[];
  // Optional second accelerator shown as an "or" alternative (e.g. Ctrl+Y for
  // redo). Both are really bound in window.ts installShortcuts.
  alt?: string[];
  desc: string;
}

interface Section {
  title: string;
  items: Shortcut[];
}

// Mirrors the bindings wired in window.ts (installShortcuts + the menu accels).
// Kept in sync by hand — there's no single source of truth for accelerators yet.
const SECTIONS: Section[] = [
  {
    title: 'General',
    items: [
      {keys: ['Ctrl', 'N'], desc: 'New blank canvas'},
      {keys: ['Ctrl', 'O'], desc: 'Open image'},
      {keys: ['Ctrl', 'Shift', 'S'], desc: 'Take screenshot'},
      {keys: ['Ctrl', 'S'], desc: 'Save image'},
      {keys: ['Ctrl', 'C'], desc: 'Copy to clipboard'},
      {keys: ['Ctrl', 'V'], desc: 'Paste image'},
      {keys: ['Ctrl', ','], desc: 'Preferences'},
      {keys: ['Ctrl', '?'], desc: 'Keyboard shortcuts'},
      {keys: ['Ctrl', 'Q'], desc: 'Quit'},
    ],
  },
  {
    title: 'Edit',
    items: [
      {keys: ['Ctrl', 'Z'], desc: 'Undo'},
      {keys: ['Ctrl', 'Shift', 'Z'], alt: ['Ctrl', 'Y'], desc: 'Redo'},
      {keys: ['Delete'], alt: ['Backspace'], desc: 'Delete selection'},
      {keys: ['Ctrl', 'D'], desc: 'Duplicate selection'},
      {keys: ['Ctrl', 'G'], desc: 'Start a new stamp group (number / select tool)'},
      {keys: ['Esc'], desc: 'Deselect'},
      {keys: ['['], alt: [']'], desc: 'Aim up / down through overlapping items (select tool)'},
      {keys: ['Shift', 'Space'], desc: 'Add/remove aimed item (select tool)'},
    ],
  },
  {
    title: 'Tools',
    items: [
      {keys: ['S'], desc: 'Select'},
      {keys: ['P'], desc: 'Pen'},
      {keys: ['H'], desc: 'Highlighter'},
      {keys: ['T'], desc: 'Text'},
      {keys: ['N'], desc: 'Number stamp'},
      {keys: ['L'], desc: 'Line'},
      {keys: ['A'], desc: 'Arrow'},
      {keys: ['R'], desc: 'Rectangle'},
      {keys: ['O'], desc: 'Oval'},
    ],
  },
  {
    title: 'View',
    items: [
      {keys: ['Ctrl', '0'], desc: 'Fit to window'},
      {keys: ['Ctrl', '1'], desc: '1∶1 zoom'},
      {keys: ['Ctrl', '+'], desc: 'Zoom in'},
      {keys: ['Ctrl', '−'], desc: 'Zoom out'},
      {keys: ['Ctrl', 'Scroll'], desc: 'Zoom at the pointer'},
    ],
  },
  {
    title: 'Resize mode',
    items: [
      {keys: ['Enter'], desc: 'Apply resize'},
      {keys: ['Esc'], desc: 'Cancel resize'},
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
    box.append(new Gtk.Label({label: 'or', css_classes: ['dim-label', 'caption']}));
    appendCombo(box, sc.alt);
  }
  return box;
}

export function presentShortcuts(parent: Gtk.Window): void {
  const dialog = new Adw.Dialog({
    title: 'Keyboard shortcuts',
    content_width: 520,
    content_height: 640,
  });

  const page = new Adw.PreferencesPage();
  for (const section of SECTIONS) {
    const group = new Adw.PreferencesGroup({title: section.title});
    for (const sc of section.items) {
      const row = new Adw.ActionRow({title: sc.desc});
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
