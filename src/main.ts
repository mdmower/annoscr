import GLib from 'gi://GLib?version=2.0';

import {initI18n} from './i18n.js';
import {AnnoscrApplication} from './application.js';
import {getSettings} from './settings.js';
import {setChosenFonts} from './font_catalogue.js';

// Bind the gettext domain before anything builds UI strings.
initI18n();

// Apply the user's chosen font set before any UI reads the font catalogue.
setChosenFonts(getSettings().fontFamilies ?? []);

GLib.set_prgname('annoscr');
GLib.set_application_name('Annoscr');

const app = new AnnoscrApplication();
app.run(['annoscr', ...ARGV]);
