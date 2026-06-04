import PangoCairo from 'gi://PangoCairo?version=1.0';

// Preference order per group (most-preferred first). Walked at startup
// against the system's installed font families; the first N hits per group
// populate the font dropdown.
const SANS_CANDIDATES: ReadonlyArray<string> = [
  'Adwaita Sans',
  'Ubuntu',
  'DejaVu Sans',
  'Liberation Sans',
  'Cantarell',
  'Nimbus Sans',
  'Noto Sans',
  'FreeSans',
  'URW Gothic',
  'Open Sans',
];

const SERIF_CANDIDATES: ReadonlyArray<string> = [
  'DejaVu Serif',
  'Liberation Serif',
  'Nimbus Roman',
  'URW Bookman',
  'FreeSerif',
  'Noto Serif',
  'Century Schoolbook L',
  'EB Garamond',
  'Gentium Plus',
  'Linux Libertine',
];

const MONO_CANDIDATES: ReadonlyArray<string> = [
  'Adwaita Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Nimbus Mono PS',
];

const MAX_SANS = 5;
const MAX_SERIF = 5;
const MAX_MONO = 3;

export type FontGroup = 'sans' | 'serif' | 'mono';

export interface FontEntry {
  // Pango family name passed to FontDescription.from_string and stored on
  // the TextAction. Either a specific family (e.g. 'Liberation Sans') or
  // the generic Pango alias ('Sans' / 'Serif' / 'Monospace') as fallback.
  family: string;
  group: FontGroup;
  // What the dropdown shows. The dropdown can't render entries in their own
  // font, so the suffix tag is the only group indicator the user sees.
  label: string;
}

let cached: FontEntry[] | null = null;

// The user's chosen families (Preferences), pushed in via setChosenFonts so this
// module needs no settings import — that would close an import cycle
// settings → actions → font_catalogue. Empty = automatic selection.
let chosenFonts: ReadonlyArray<string> = [];

function pickAvailable(
  candidates: ReadonlyArray<string>,
  max: number,
  group: FontGroup,
  installed: Set<string>
): FontEntry[] {
  const picked: FontEntry[] = [];
  for (const family of candidates) {
    if (picked.length >= max) break;
    if (installed.has(family)) {
      picked.push({family, group, label: `${family} · ${group}`});
    }
  }
  if (picked.length === 0) {
    // Pango's generic family aliases ('Sans' / 'Serif' / 'Monospace') always
    // resolve to *some* installed font via fontconfig, so they're a safe
    // last-resort fallback. Labeled with the group suffix for consistency.
    const alias = group === 'sans' ? 'Sans' : group === 'serif' ? 'Serif' : 'Monospace';
    picked.push({family: alias, group, label: `${alias} · ${group}`});
  }
  return picked;
}

// Build the catalogue from PangoCairo's default font map. Cached until the user
// edits the font set (setChosenFonts) — installed fonts don't change while the
// app runs, but the chosen subset can. Called lazily on first read so it runs
// after Gtk is initialized.
function resolve(): FontEntry[] {
  if (cached) return cached;
  // name → family, so we can both test installation and read is_monospace.
  const installed = new Map(
    PangoCairo.font_map_get_default()
      .list_families()
      .map((f) => [f.get_name(), f] as const)
  );

  // A user-chosen list (Preferences) wins, in its given order. Families no
  // longer installed are silently dropped; if none survive, fall through to the
  // automatic selection so the dropdown is never empty.
  if (chosenFonts.length > 0) {
    const entries: FontEntry[] = [];
    for (const name of chosenFonts) {
      const family = installed.get(name);
      // The label is the bare family name: the user curated and ordered this
      // list, so the sans/serif/mono suffix the automatic set carries is noise.
      if (family)
        entries.push({family: name, group: family.is_monospace ? 'mono' : 'sans', label: name});
    }
    if (entries.length > 0) {
      cached = entries;
      return cached;
    }
  }

  const installedNames = new Set(installed.keys());
  cached = [
    ...pickAvailable(SANS_CANDIDATES, MAX_SANS, 'sans', installedNames),
    ...pickAvailable(SERIF_CANDIDATES, MAX_SERIF, 'serif', installedNames),
    ...pickAvailable(MONO_CANDIDATES, MAX_MONO, 'mono', installedNames),
  ];
  return cached;
}

export function getAvailableFonts(): ReadonlyArray<FontEntry> {
  return resolve();
}

// Set the user's chosen font families (from settings) and drop the cached
// catalogue so the next read rebuilds it. Called once at startup and again
// whenever the set changes in Preferences.
export function setChosenFonts(families: ReadonlyArray<string>): void {
  chosenFonts = families;
  cached = null;
}

// First catalogue entry — the text-tool default. Always non-null: a user list
// only takes effect when at least one chosen family is installed, and the
// automatic fallback guarantees at least one entry per group.
export function getDefaultTextFont(): string {
  return resolve()[0].family;
}
