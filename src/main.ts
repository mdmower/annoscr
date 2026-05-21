import GLib from 'gi://GLib?version=2.0';

import { AnnoscrApplication } from './application.js';

GLib.set_prgname('annoscr');
GLib.set_application_name('Annoscr');

const app = new AnnoscrApplication();
app.run(['annoscr', ...ARGV]);
