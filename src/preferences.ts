import Gio from 'gi://Gio?version=2.0';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

import {ColorScheme, getSettings, updateSettings} from './settings.js';

const COLOR_SCHEMES: ColorScheme[] = ['system', 'light', 'dark'];
const COLOR_SCHEME_LABELS = ['Follow system', 'Light', 'Dark'];

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

export function presentPreferences(parent: Gtk.Window): void {
  const s = getSettings();
  const dialog = new Adw.PreferencesDialog();
  const page = new Adw.PreferencesPage();
  dialog.add(page);

  // Appearance
  const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
  const schemeRow = new Adw.ComboRow({
    title: 'Color scheme',
    model: Gtk.StringList.new(COLOR_SCHEME_LABELS),
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
  const tools = new Adw.PreferencesGroup({title: 'Tools'});
  const rememberRow = new Adw.SwitchRow({
    title: 'Remember tool styles between sessions',
    subtitle: 'Restore each tool’s color, width, fill, and font on the next launch',
    active: s.rememberToolStyles,
  });
  rememberRow.connect('notify::active', () => {
    updateSettings({rememberToolStyles: rememberRow.get_active()});
  });
  tools.add(rememberRow);
  page.add(tools);

  // Saving
  const saving = new Adw.PreferencesGroup({title: 'Saving'});
  const folderRow = new Adw.ActionRow({title: 'Default save folder'});
  const folderBtn = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
  const clearBtn = new Gtk.Button({
    icon_name: 'edit-clear-symbolic',
    tooltip_text: 'Reset to Pictures folder',
    valign: Gtk.Align.CENTER,
    css_classes: ['flat'],
  });
  const refreshFolderRow = (): void => {
    const folder = getSettings().defaultSaveFolder;
    folderRow.set_subtitle(folder || 'Pictures folder');
    clearBtn.set_visible(!!folder);
  };
  folderBtn.connect('clicked', () => {
    const fd = new Gtk.FileDialog({title: 'Default save folder', modal: true});
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
    title: 'Default format',
    model: Gtk.StringList.new(['PNG', 'JPEG']),
    selected: s.defaultSaveFormat === 'jpeg' ? 1 : 0,
  });
  formatRow.connect('notify::selected', () => {
    updateSettings({defaultSaveFormat: formatRow.get_selected() === 1 ? 'jpeg' : 'png'});
  });
  saving.add(formatRow);
  page.add(saving);

  // Behavior
  const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
  const confirmRow = new Adw.SwitchRow({
    title: 'Confirm before discarding unsaved changes',
    subtitle: 'Ask before replacing an annotated canvas you haven’t saved',
    active: s.confirmDiscard,
  });
  confirmRow.connect('notify::active', () => {
    updateSettings({confirmDiscard: confirmRow.get_active()});
  });
  behavior.add(confirmRow);
  page.add(behavior);

  dialog.present(parent);
}
