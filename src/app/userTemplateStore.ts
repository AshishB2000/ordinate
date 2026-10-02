// User templates on disk — WORKSPACE records, not project ones: one JSON file
// per template under userData/templates/<uuid>.json, so a template saved in one
// project is offered in every other. MAIN PROCESS ONLY.
//
// Same conventions as every record store: the id is UUID-checked before it
// touches a path, writes are atomic (temp sibling, then rename), and a corrupt
// file is skipped, never fatal. Every read goes through the same whitelist an
// imported file does (userTemplateFile.sanitizeUserTemplate) — a file on disk is
// only as trusted as whatever last wrote it.
//
// Bundles: a project bundle carries the templates captured FROM its dashboards
// (`templates.json`, the themes.json pattern), and importing one adopts them,
// merging by id and never overwriting a template already here.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import type { UserTemplate } from '../analysis/userTemplate';
import { sanitizeUserTemplate } from '../analysis/userTemplateFile';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TEMPLATES = 500;

let dirOverride = '';
/** Tests point the store at a temp dir; the app never calls this. */
export function _setStoreDir(dir: string): void { dirOverride = dir; }
function dir(): string { return dirOverride || path.join(app.getPath('userData'), 'templates'); }
function fileOf(id: string): string { return path.join(dir(), id.toLowerCase() + '.json'); }

async function writeAtomic(file: string, obj: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

/** Every template, newest first. */
export async function listTemplates(): Promise<UserTemplate[]> {
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir()); } catch (_) { return []; }
  const out: UserTemplate[] = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    if (!UUID_RE.test(id)) continue; // temp files, strays
    const t = await getTemplate(id);
    if (t) out.push(t);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getTemplate(id: unknown): Promise<UserTemplate | null> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  try {
    const t = sanitizeUserTemplate(JSON.parse(await fs.promises.readFile(fileOf(id), 'utf8')), () => id);
    return t && t.id === id.toLowerCase() ? t : null;
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') console.error('[templates] skipping unreadable template', id, err.message);
    return null;
  }
}

/** Write a template (already sanitized). A new id is minted when it has none. */
export async function saveTemplate(t: UserTemplate): Promise<UserTemplate | null> {
  const clean = sanitizeUserTemplate(t, randomUUID);
  if (!clean) return null;
  if (!(await getTemplate(clean.id)) && (await listTemplates()).length >= MAX_TEMPLATES) return null;
  await writeAtomic(fileOf(clean.id), clean);
  return clean;
}

export async function updateTemplate(id: unknown, patch: { name?: unknown; description?: unknown }): Promise<UserTemplate | null> {
  const t = await getTemplate(id);
  if (!t) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim().slice(0, 120);
  if (typeof patch.description === 'string') t.description = patch.description.slice(0, 500);
  return saveTemplate(t);
}

export async function deleteTemplate(id: unknown): Promise<boolean> {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return false;
  try { await fs.promises.rm(fileOf(id), { force: true }); return true; } catch (_) { return false; }
}

/** Add templates that are not here yet; one already here is left alone. */
export async function adoptTemplates(incoming: UserTemplate[]): Promise<number> {
  let added = 0;
  for (const t of incoming) {
    if (await getTemplate(t.id)) continue;
    if (await saveTemplate(t)) added += 1;
  }
  return added;
}

// ── Bundles ──────────────────────────────────────────────────────────────────

/** The `templates.json` a project bundle carries: the templates captured from
 *  the dashboards in it. Null when there are none. */
export async function bundleTemplatesEntry(entries: Array<{ name: string; data: Buffer }>): Promise<{ name: string; data: Buffer } | null> {
  const ids = new Set(entries.map((e) => /^analyses\/([0-9a-f-]{36})\.json$/i.exec(e.name)).filter(Boolean).map((m) => m![1].toLowerCase()));
  const templates = (await listTemplates()).filter((t) => t.sourceAnalysisId && ids.has(t.sourceAnalysisId.toLowerCase()));
  if (!templates.length) return null;
  return { name: 'templates.json', data: Buffer.from(JSON.stringify({ version: 1, templates }, null, 2), 'utf8') };
}

/** Adopt a bundle's templates. `swap` is the import's id remap. Never fatal. */
export async function importBundleTemplates(entries: Array<{ name: string; data: Buffer }>, swap: (s: string) => string): Promise<number> {
  const e = entries.find((x) => x.name === 'templates.json');
  if (!e) return 0;
  try {
    const raw = JSON.parse(swap(e.data.toString('utf8')));
    const list = (Array.isArray(raw && raw.templates) ? raw.templates : [])
      .map((t: unknown) => sanitizeUserTemplate(t, randomUUID))
      .filter((t: UserTemplate | null): t is UserTemplate => !!t);
    return await adoptTemplates(list);
  } catch (_) {
    return 0; // a template costs a gallery card, never the import
  }
}
