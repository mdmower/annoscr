import GLib from 'gi://GLib?version=2.0';
import Gettext from 'gettext';

// Gettext domain — matches meson.project_name() (the .mo files install as
// <localedir>/<lang>/LC_MESSAGES/annoscr.mo).
const DOMAIN = 'annoscr';

// Initialize translation: bind the domain to the locale directory and select
// it as the default. Called once at startup, before any _() lookup.
//
// US-English fallback is implicit and needs no special handling: gettext
// returns the msgid unchanged when no catalogue matches the OS locale, and our
// msgids ARE the US-English source strings. So an unsupported locale simply
// shows English. libintl reads the OS locale from the environment
// (LANGUAGE/LC_ALL/LC_MESSAGES/LANG) via the C library's own setlocale, which
// GLib has already run by the time we get here.
export function initI18n(): void {
  // The build tree exports ANNOSCR_LOCALE_DIR (set by the launcher); an
  // installed run leaves it unset and libintl uses its compiled-in default
  // search path (<prefix>/share/locale).
  const localeDir = GLib.getenv('ANNOSCR_LOCALE_DIR');
  if (localeDir) Gettext.bindtextdomain(DOMAIN, localeDir);
  Gettext.textdomain(DOMAIN);
}

// Translate a single string. Wrap every user-facing literal in this; xgettext
// extracts the calls (keyword `_`) into po/annoscr.pot. The name is the gettext
// convention so the extractor's default keyword set also recognizes it.
export function _(msgid: string): string {
  return Gettext.gettext(msgid);
}

// Translate a format string carrying a single `%d`, then substitute `n`. Keeps
// the number out of the msgid so translators get a clean "Group %d" to render
// per their locale (and can move the placeholder). Only the first `%d` is
// replaced — all current call sites pass one.
export function formatN(msgid: string, n: number): string {
  return Gettext.gettext(msgid).replace('%d', String(n));
}

// Mark a string for extraction WITHOUT translating it now — a runtime no-op.
// Use it for string literals defined at module load (constant tables like TOOLS
// / SIZE_PRESETS), which are evaluated before initI18n() binds the domain;
// translate them at the point of use with _(). xgettext extracts N_ too (it's
// in meson's glib keyword preset), so the strings still land in the catalogue.
export function N_(msgid: string): string {
  return msgid;
}
