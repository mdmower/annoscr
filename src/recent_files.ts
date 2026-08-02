import GLib from 'gi://GLib?version=2.0';

import {asBool, asNonEmptyString, isRecord} from './validators.js';

// Recently opened files, plus the strip's shown/hidden state.
//
// Kept out of settings.json, which is portable between machines and
// hand-edited: these are absolute paths that mean nothing elsewhere, and the
// list is rewritten on every open. The XDG state directory is for exactly this
// — it names recently used files as its own example.

export type RecentKind = 'image' | 'document';

export interface RecentEntry {
  path: string;
  kind: RecentKind;
}

// How many entries are retained. Fixed rather than configurable: the
// preference is a plain on/off switch, and this cap is stated in its subtitle.
export const RECENT_LIMIT = 500;

interface AppState {
  recentFiles: RecentEntry[];
  stripVisible: boolean;
}

const DEFAULTS: AppState = {recentFiles: [], stripVisible: true};

function statePath(): string {
  return GLib.build_filenamev([GLib.get_user_state_dir(), 'annoscr', 'state.json']);
}

function asKind(v: unknown): RecentKind | undefined {
  return v === 'image' || v === 'document' ? v : undefined;
}

// Per-field validation, as settings.json and .annoscr get: a malformed entry
// must not reach the widget factory. Bad entries drop; the list survives.
function asEntries(v: unknown): RecentEntry[] {
  if (!Array.isArray(v)) return [];
  const out: RecentEntry[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (out.length >= RECENT_LIMIT) break;
    if (!isRecord(raw)) continue;
    const path = asNonEmptyString(raw.path);
    const kind = asKind(raw.kind);
    if (path === undefined || kind === undefined || seen.has(path)) continue;
    seen.add(path);
    out.push({path, kind});
  }
  return out;
}

function loadState(): AppState {
  try {
    const [ok, bytes] = GLib.file_get_contents(statePath());
    if (!ok) return {...DEFAULTS};
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(raw)) return {...DEFAULTS};
    return {
      recentFiles: asEntries(raw.recentFiles),
      stripVisible: asBool(raw.stripVisible) ?? DEFAULTS.stripVisible,
    };
  } catch {
    // Missing file (first run) or malformed JSON - start empty.
    return {...DEFAULTS};
  }
}

function saveState(s: AppState): void {
  try {
    const path = statePath();
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, new TextEncoder().encode(JSON.stringify(s, null, 2)));
  } catch (e) {
    // Never let a failed write break an open; the list is best-effort.
    console.warn('saveState failed', e);
  }
}

let cached: AppState | null = null;

function state(): AppState {
  if (!cached) cached = loadState();
  return cached;
}

export function getRecentFiles(): ReadonlyArray<RecentEntry> {
  return state().recentFiles;
}

// Add a newly opened file at the front. Entries stay in FIRST-opened order,
// newest leftmost: reopening deliberately does not move one, so hunting through
// the strip never rearranges what is being hunted through. Returns whether
// anything changed, so a reopen skips the rebuild and its scroll reset.
export function rememberOpenedFile(path: string, kind: RecentKind): boolean {
  const s = state();
  if (s.recentFiles.some((e) => e.path === path)) return false;
  s.recentFiles = [{path, kind}, ...s.recentFiles].slice(0, RECENT_LIMIT);
  saveState(s);
  return true;
}

// Put a just-saved file at the front, listed already or not — the deliberate
// exception to the ordering above. Opening a file is a search and must not
// disturb the order; saving one changes it, and the result is what the user
// reaches for next. Returns whether anything moved.
export function rememberSavedFile(path: string, kind: RecentKind): boolean {
  const s = state();
  if (s.recentFiles[0]?.path === path) return false;
  const rest = s.recentFiles.filter((e) => e.path !== path);
  s.recentFiles = [{path, kind}, ...rest].slice(0, RECENT_LIMIT);
  saveState(s);
  return true;
}

export function forgetRecentFile(path: string): void {
  const s = state();
  const kept = s.recentFiles.filter((e) => e.path !== path);
  if (kept.length === s.recentFiles.length) return;
  s.recentFiles = kept;
  saveState(s);
}

// Drop entries whose file is gone. Called once at startup, because during a
// session a failed thumbnail is left in place rather than vanishing mid-scroll.
// A file that exists but can't be read passes this test, so a permissions
// problem never costs the user an entry. One stat per entry.
export function pruneMissingRecentFiles(): boolean {
  const s = state();
  const kept = s.recentFiles.filter((e) => GLib.file_test(e.path, GLib.FileTest.EXISTS));
  if (kept.length === s.recentFiles.length) return false;
  s.recentFiles = kept;
  saveState(s);
  return true;
}

export function clearRecentFiles(): void {
  const s = state();
  if (s.recentFiles.length === 0) return;
  s.recentFiles = [];
  saveState(s);
}

export function isStripVisible(): boolean {
  return state().stripVisible;
}

export function setStripVisible(visible: boolean): void {
  const s = state();
  if (s.stripVisible === visible) return;
  s.stripVisible = visible;
  saveState(s);
}
