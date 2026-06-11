import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {ColorScheme, UndoMemory, getSettings, updateSettings} from './settings.js';
import {labelFromTooltip} from './a11y.js';
import {_, N_} from './i18n.js';

const COLOR_SCHEMES: ColorScheme[] = ['system', 'light', 'dark'];
// N_-marked (module-level); translated at dialog-build time with _() below.
const COLOR_SCHEME_LABELS = [N_('Follow system'), N_('Light'), N_('Dark')];

// Row order ↔ preset mapping for the undo-memory ComboRow. Labels are the bare
// sizes (mirroring settings.undoMemoryBytes) — friendly names made the
// ComboRow's collapsed value truncate.
const UNDO_MEMORY_ORDER: UndoMemory[] = ['low', 'normal', 'high', 'unlimited'];
const UNDO_MEMORY_LABELS = [N_('128 MiB'), N_('256 MiB'), N_('1 GiB'), N_('Unlimited')];

// Apply a color scheme via libadwaita. Called from the dialog on change and
// once at startup so the saved choice takes effect before any UI is shown.
export function applyColorScheme(scheme: ColorScheme): void {
  const mgr = Adw.StyleManager.get_default();
  switch (scheme) {
    case 'light':
      mgr.set_color_scheme(Adw.ColorScheme.FORCE_LIGHT);
      break;
    case 'dark':
      mgr.set_color_scheme(Adw.ColorScheme.FORCE_DARK);
      break;
    default:
      mgr.set_color_scheme(Adw.ColorScheme.DEFAULT);
      break;
  }
}

export interface PreferencesCallbacks {
  // The chosen font set changed; the caller pushes it into the catalogue and
  // rebuilds the font dropdown.
  onFontsChanged?: () => void;
  // The undo-memory preset changed; the caller re-applies it to the canvas.
  onUndoMemoryChanged?: () => void;
}

export function presentPreferences(parent: Gtk.Window, callbacks?: PreferencesCallbacks): void {
  const s = getSettings();
  const dialog = new Adw.PreferencesDialog();
  const page = new Adw.PreferencesPage();
  dialog.add(page);

  // Appearance
  const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
  const schemeRow = new Adw.ComboRow({
    title: _('Color scheme'),
    model: Gtk.StringList.new(COLOR_SCHEME_LABELS.map((l) => _(l))),
    selected: Math.max(0, COLOR_SCHEMES.indexOf(s.colorScheme)),
  });
  schemeRow.connect('notify::selected', () => {
    const scheme = COLOR_SCHEMES[schemeRow.get_selected()] ?? 'system';
    applyColorScheme(scheme);
    updateSettings({colorScheme: scheme});
  });
  appearance.add(schemeRow);
  page.add(appearance);

  // Tools
  const tools = new Adw.PreferencesGroup({title: _('Tools')});
  const rememberRow = new Adw.SwitchRow({
    title: _('Remember tool styles between sessions'),
    subtitle: _("Restore each tool's color, width, fill, and font on the next launch"),
    active: s.rememberToolStyles,
  });
  rememberRow.connect('notify::active', () => {
    const active = rememberRow.get_active();
    // Turning the setting off also forgets the already-saved styles, so toggling
    // it back on starts fresh rather than restoring stale values.
    updateSettings(
      active ? {rememberToolStyles: true} : {rememberToolStyles: false, toolStyles: undefined}
    );
  });
  tools.add(rememberRow);
  page.add(tools);

  // Text fonts — curate which families appear in the text font dropdown.
  const fontsGroup = new Adw.PreferencesGroup({
    title: _('Text fonts'),
    description: _(
      'Choose which font families appear in the text font menu, in order — the first is the default. Leave empty to use an automatic selection.'
    ),
  });
  // Working copy; settings (and the persisted JSON) only ever see fresh copies.
  const families: string[] = [...(s.fontFamilies ?? [])];
  let fontRows: Gtk.Widget[] = [];

  const commitFonts = (): void => {
    updateSettings({fontFamilies: families.length > 0 ? [...families] : undefined});
    rebuildFontRows();
    callbacks?.onFontsChanged?.();
  };

  const makeIconButton = (icon: string, tip: string, onClick: () => void): Gtk.Button => {
    const btn = new Gtk.Button({
      icon_name: icon,
      tooltip_text: tip,
      valign: Gtk.Align.CENTER,
      css_classes: ['flat'],
    });
    labelFromTooltip(btn);
    btn.connect('clicked', onClick);
    return btn;
  };

  function rebuildFontRows(): void {
    for (const row of fontRows) fontsGroup.remove(row);
    fontRows = [];
    if (families.length === 0) {
      const empty = new Adw.ActionRow({
        title: _('Automatic selection'),
        subtitle: _('Common sans, serif, and monospace families'),
        sensitive: false,
      });
      fontsGroup.add(empty);
      fontRows.push(empty);
      return;
    }
    families.forEach((family, i) => {
      const row = new Adw.ActionRow({title: family});
      const up = makeIconButton('go-up-symbolic', _('Move up'), () => {
        [families[i - 1], families[i]] = [families[i], families[i - 1]];
        commitFonts();
      });
      up.set_sensitive(i > 0);
      const down = makeIconButton('go-down-symbolic', _('Move down'), () => {
        [families[i + 1], families[i]] = [families[i], families[i + 1]];
        commitFonts();
      });
      down.set_sensitive(i < families.length - 1);
      const remove = makeIconButton('list-remove-symbolic', _('Remove'), () => {
        families.splice(i, 1);
        commitFonts();
      });
      row.add_suffix(up);
      row.add_suffix(down);
      row.add_suffix(remove);
      fontsGroup.add(row);
      fontRows.push(row);
    });
  }

  const addFontBtn = new Gtk.Button({
    label: _('Add…'),
    valign: Gtk.Align.CENTER,
    css_classes: ['flat'],
  });
  addFontBtn.connect('clicked', () => {
    const fd = new Gtk.FontDialog({title: _('Add a font'), modal: true});
    // Callback form: GJS doesn't expose the promise overload for this call.
    fd.choose_family(parent, null, null, (_src, res) => {
      try {
        const family = fd.choose_family_finish(res);
        const name = family.get_name();
        if (!families.includes(name)) {
          families.push(name);
          commitFonts();
        }
      } catch (e) {
        if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
          console.error('choose_family failed', e);
        }
      }
    });
  });
  fontsGroup.set_header_suffix(addFontBtn);
  rebuildFontRows();
  page.add(fontsGroup);

  // Saving
  const saving = new Adw.PreferencesGroup({title: _('Saving')});
  const folderRow = new Adw.ActionRow({title: _('Default save folder')});
  const folderBtn = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
  const clearBtn = new Gtk.Button({
    icon_name: 'edit-clear-symbolic',
    tooltip_text: _('Reset to Pictures folder'),
    valign: Gtk.Align.CENTER,
    css_classes: ['flat'],
  });
  labelFromTooltip(clearBtn);
  const refreshFolderRow = (): void => {
    const folder = getSettings().defaultSaveFolder;
    folderRow.set_subtitle(folder || _('Pictures folder'));
    clearBtn.set_visible(!!folder);
  };
  folderBtn.connect('clicked', () => {
    const fd = new Gtk.FileDialog({title: _('Default save folder'), modal: true});
    const cur = getSettings().defaultSaveFolder;
    if (cur) fd.set_initial_folder(Gio.File.new_for_path(cur));
    fd.select_folder(parent, null, (_src, res) => {
      try {
        const file = fd.select_folder_finish(res);
        const path = file?.get_path();
        if (path) {
          updateSettings({defaultSaveFolder: path});
          refreshFolderRow();
        }
      } catch (e) {
        if (!(e instanceof Gtk.DialogError && e.code === Gtk.DialogError.DISMISSED)) {
          console.error('select_folder failed', e);
        }
      }
    });
  });
  clearBtn.connect('clicked', () => {
    updateSettings({defaultSaveFolder: ''});
    refreshFolderRow();
  });
  refreshFolderRow();
  folderRow.add_suffix(clearBtn);
  folderRow.add_suffix(folderBtn);
  saving.add(folderRow);

  const formatRow = new Adw.ComboRow({
    title: _('Default format'),
    // PNG / JPEG are format names, not translated.
    model: Gtk.StringList.new(['PNG', 'JPEG']),
    selected: s.defaultSaveFormat === 'jpeg' ? 1 : 0,
  });
  formatRow.connect('notify::selected', () => {
    updateSettings({defaultSaveFormat: formatRow.get_selected() === 1 ? 'jpeg' : 'png'});
  });
  saving.add(formatRow);
  page.add(saving);

  // Behavior
  const behavior = new Adw.PreferencesGroup({title: _('Behavior')});
  const confirmRow = new Adw.SwitchRow({
    title: _('Confirm before discarding unsaved changes'),
    subtitle: _("Ask before replacing an annotated canvas you haven't saved"),
    active: s.confirmDiscard,
  });
  confirmRow.connect('notify::active', () => {
    updateSettings({confirmDiscard: confirmRow.get_active()});
  });
  behavior.add(confirmRow);

  const selectAfterRow = new Adw.SwitchRow({
    title: _('Select after placing'),
    subtitle: _('Switch to the select tool and select each annotation right after you place it'),
    active: s.selectAfterPlacement,
  });
  selectAfterRow.connect('notify::active', () => {
    updateSettings({selectAfterPlacement: selectAfterRow.get_active()});
  });
  behavior.add(selectAfterRow);

  const undoMemoryRow = new Adw.ComboRow({
    title: _('Undo memory'),
    subtitle: _(
      'Rotating or resizing the canvas keeps a full image copy per undo step; the oldest steps are dropped over this limit'
    ),
    model: Gtk.StringList.new(UNDO_MEMORY_LABELS.map((l) => _(l))),
    selected: Math.max(0, UNDO_MEMORY_ORDER.indexOf(s.undoMemory)),
  });
  undoMemoryRow.connect('notify::selected', () => {
    const preset = UNDO_MEMORY_ORDER[undoMemoryRow.get_selected()] ?? 'normal';
    updateSettings({undoMemory: preset});
    callbacks?.onUndoMemoryChanged?.();
  });
  behavior.add(undoMemoryRow);
  page.add(behavior);

  dialog.present(parent);
}
