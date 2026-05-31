import GLib from 'gi://GLib?version=2.0';

import {initI18n} from './i18n.js';
import {AnnoscrApplication} from './application.js';

// Bind the gettext domain before anything builds UI strings.
initI18n();

GLib.set_prgname('annoscr');
GLib.set_application_name('Annoscr');

const app = new AnnoscrApplication();
app.run(['annoscr', ...ARGV]);
