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

// Build the catalogue from PangoCairo's default font map. Cached for the
// life of the process — installed fonts don't change while the app runs.
// Called lazily on first read so it runs after Gtk is initialized.
function resolve(): FontEntry[] {
  if (cached) return cached;
  const fontMap = PangoCairo.font_map_get_default();
  const installed = new Set<string>();
  for (const family of fontMap.list_families()) {
    installed.add(family.get_name());
  }
  cached = [
    ...pickAvailable(SANS_CANDIDATES, MAX_SANS, 'sans', installed),
    ...pickAvailable(SERIF_CANDIDATES, MAX_SERIF, 'serif', installed),
    ...pickAvailable(MONO_CANDIDATES, MAX_MONO, 'mono', installed),
  ];
  return cached;
}

export function getAvailableFonts(): ReadonlyArray<FontEntry> {
  return resolve();
}

// First sans entry — used as the text-tool default. Always non-null because
// pickAvailable guarantees at least one entry per group (generic alias
// fallback) and the sans group comes first in the catalogue.
export function getDefaultTextFont(): string {
  return resolve().find((f) => f.group === 'sans')!.family;
}
