// Workspace THEMES on disk — MAIN PROCESS ONLY.
//
// One file, userData/themes.json: `{ version, defaultId, themes: [...] }`. A
// theme is a WORKSPACE record, not a project one — the same palette is meant to
// dress dashboards across projects — so it lives beside config.json rather than
// under a project directory. The workspace default is stored here too (not in
// config) because it means nothing without the records it points at.
//
// Store conventions: every record goes through themeModel.sanitizeTheme on the
// way in AND on the way out; ids are UUIDs checked before use; writes are atomic
// (temp sibling, then rename) and serialised; a corrupt file reads as EMPTY —
// never fatal — and is kept aside as themes.json.corrupt before anything
// overwrites it, so a hand-edit gone wrong is recoverable.
//
// Bundles: a project bundle carries the theme records its dashboards name
// (bundleThemesEntry / importBundleThemes, called from src/app/bundle.ts).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from './paths';
import { themeModel } from '../analysis/themeTokens';
import type { ThemeRecord } from '../analysis/themeTokens';
import * as recordFs from './recordFs';

export const MAX_THEMES = 200;

export interface ThemeState {
  defaultId: string;
  themes: ThemeRecord[];
}

let fileOverride = '';
/** Tests point the store at a temp file; the app never calls this. */
export function _setStoreFile(file: string): void {
  fileOverride = file;
}
function storeFile(): string {
  return fileOverride || path.join(appPaths.userData(), 'themes.json');
}

/** Clamp an untrusted state: valid records only, unique ids, a default that exists. */
export function sanitizeState(raw: unknown): ThemeState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const themes: ThemeRecord[] = [];
  for (const t of Array.isArray(o.themes) ? o.themes : []) {
    const rec = themeModel.sanitizeTheme(t);
    if (!rec || !rec.id || seen.has(rec.id)) continue; // a record without an id cannot be referenced
    seen.add(rec.id);
    themes.push(rec);
    if (themes.length >= MAX_THEMES) break;
  }
  const d = themeModel.sanitizeThemeId(o.defaultId);
  return { defaultId: seen.has(d) ? d : '', themes };
}

async function readState(): Promise<ThemeState> {
  const file = storeFile();
  let text: string;
  try {
    text = await recordFs.readFile(file, 'utf8');
  } catch (_) {
    return { defaultId: '', themes: [] }; // no file yet — or unreadable, same answer
  }
  try {
    return sanitizeState(JSON.parse(text));
  } catch (_) {
    console.error('[themes] themes.json is not valid JSON — kept as themes.json.corrupt, reading as empty');
    await recordFs.copyFile(file, file + '.corrupt').catch(() => undefined);
    return { defaultId: '', themes: [] };
  }
}

async function writeState(state: ThemeState): Promise<void> {
  const file = storeFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

// Every read-modify-write goes through one chain: two quick saves from the
// editor must not interleave and drop one.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => undefined).then(fn);
  chain = next;
  return next;
}

export function listThemes(): Promise<ThemeState> {
  return serial(readState);
}

/** Create (no or unknown id) or replace a theme. Returns the stored record. */
export function saveTheme(raw: unknown): Promise<{ ok: boolean; theme?: ThemeRecord; error?: string }> {
  return serial(async () => {
    const rec = themeModel.sanitizeTheme(raw);
    if (!rec) return { ok: false, error: 'That is not a theme.' };
    const state = await readState();
    const at = rec.id ? state.themes.findIndex((t) => t.id === rec.id) : -1;
    if (at < 0 && state.themes.length >= MAX_THEMES) return { ok: false, error: `A workspace holds up to ${MAX_THEMES} themes.` };
    const theme: ThemeRecord = { ...rec, id: at >= 0 ? rec.id : rec.id || randomUUID(), updatedAt: new Date().toISOString() };
    if (at >= 0) state.themes[at] = theme;
    else state.themes.push(theme);
    await writeState(state);
    return { ok: true, theme };
  });
}

export function deleteTheme(id: unknown): Promise<{ ok: boolean }> {
  return serial(async () => {
    if (!themeModel.isId(id)) return { ok: false };
    const state = await readState();
    const key = id.toLowerCase();
    const themes = state.themes.filter((t) => t.id !== key);
    if (themes.length === state.themes.length) return { ok: false };
    await writeState({ defaultId: state.defaultId === key ? '' : state.defaultId, themes });
    return { ok: true };
  });
}

/** '' clears the workspace default. An id that is not a stored theme is refused. */
export function setDefaultTheme(id: unknown): Promise<{ ok: boolean }> {
  return serial(async () => {
    const state = await readState();
    const key = themeModel.sanitizeThemeId(id);
    if (id !== '' && !state.themes.some((t) => t.id === key)) return { ok: false };
    await writeState({ ...state, defaultId: id === '' ? '' : key });
    return { ok: true };
  });
}

// ── Bundles ──────────────────────────────────────────────────────────────────

const THEME_ID_RE = /"themeId"\s*:\s*"([0-9a-f-]{36})"/gi;

/**
 * The `themes.json` entry a project bundle carries: the records its dashboards
 * name by `style.themeId`. Null when none do. Read off the entries already
 * packed, so it names exactly what travels.
 */
export async function bundleThemesEntry(entries: Array<{ name: string; data: Buffer }>): Promise<{ name: string; data: Buffer } | null> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (!/^analyses\/[^/]+\.json$/.test(e.name)) continue;
    for (const m of e.data.toString('utf8').matchAll(THEME_ID_RE)) ids.add(m[1].toLowerCase());
  }
  if (!ids.size) return null;
  const themes = (await listThemes()).themes.filter((t) => ids.has(t.id));
  if (!themes.length) return null;
  return { name: 'themes.json', data: Buffer.from(JSON.stringify({ version: 1, themes }, null, 2), 'utf8') };
}

/**
 * Adopt the themes an imported bundle carries. A theme whose id is already
 * here is left alone — it is the same record come home (a restore, an export
 * from this install) and the local copy may be newer. `swap` is the import's
 * id remap, applied so a remapped reference still meets its record.
 */
export async function importBundleThemes(
  entries: Array<{ name: string; data: Buffer }>, swap: (s: string) => string,
): Promise<number> {
  const e = entries.find((x) => x.name === 'themes.json');
  if (!e) return 0;
  let incoming: ThemeRecord[];
  try {
    incoming = sanitizeState(JSON.parse(swap(e.data.toString('utf8')))).themes;
  } catch (_) {
    return 0; // an unreadable themes.json costs the look, never the import
  }
  return serial(async () => {
    const state = await readState();
    const have = new Set(state.themes.map((t) => t.id));
    const added = incoming.filter((t) => !have.has(t.id)).slice(0, Math.max(0, MAX_THEMES - state.themes.length));
    if (!added.length) return 0;
    await writeState({ ...state, themes: state.themes.concat(added) });
    return added.length;
  });
}
