// The catalog — descriptions, tags, owners and column docs. MAIN PROCESS ONLY.
//
// ONE side store per project, `userData/projects/<pid>/catalog.json`, rather
// than new fields on every record. Each record store whitelists its fields in
// its own normalize() (datasets, visuals, analyses, reports, metrics) and would
// silently drop a key it does not know — so documentation lives beside the
// records, keyed by `${kind}:${id}`, and no record store changes shape.
//
//   { schemaVersion: 1,
//     tags:    { sales: { color: 3 } },
//     records: { 'dataset:<uuid>': { description, tags, owner, updatedBy, updatedAt } },
//     columns: { '<datasetId>': { discount: { description, displayName, example,
//                                             sensitivity, updatedBy, updatedAt } } } }
//
// A METRIC's description is the one exception: the Metric record already has
// `description` (metrics.ts), so that field stays the single source of truth
// and catalogIndex.ts routes it there. Only tags/owner of a metric live here.
//
// `updatedBy` is `os.userInfo().username`, computed HERE on every write and
// never read off a renderer payload.
//
// Conventions copied from src/analysis/analysis.ts: UUID-check every id before
// it reaches a path, atomic temp-sibling-then-rename writes with a per-write
// random suffix, and a corrupt or missing file reads as EMPTY — never fatal.
// Every map is null-prototype, because tag and column names are user text and
// `__proto__` is a perfectly valid tag once normalised.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from './paths';
import { isValidId } from './ids';

// ── Kinds ────────────────────────────────────────────────────────────────────
// A dashboard is stored as an Analysis record, so its kind is 'analysis' — the
// string recents and search already use. 'story' is listed now so a story's
// docs validate the day the Story record lands (see catalogIndex.ts's hook).
export const CATALOG_KINDS = ['dataset', 'visual', 'analysis', 'metric', 'report', 'story'] as const;
export type CatalogKind = typeof CATALOG_KINDS[number];

export type Sensitivity = 'none' | 'personal' | 'financial';
const SENSITIVITIES: ReadonlySet<string> = new Set(['none', 'personal', 'financial']);

export interface RecordDoc {
  description: string;
  tags: string[];
  owner: string;
  updatedBy: string;
  updatedAt: string;
}

export interface ColumnDoc {
  description: string;
  /** What captions and pickers call the column. Empty = its own name. */
  displayName: string;
  example: string;
  sensitivity: Sensitivity;
  updatedBy: string;
  updatedAt: string;
}

export interface CatalogFile {
  schemaVersion: 1;
  /** Project-wide. `color` is an index into the 8-colour palette (.tag-c0…c7). */
  tags: Record<string, { color: number }>;
  records: Record<string, RecordDoc>;
  columns: Record<string, Record<string, ColumnDoc>>;
}

export const TAG_COLORS = 8;
const MAX_TAG_LEN = 32;
const MAX_TAGS = 12;
const MAX_DESCRIPTION = 2000;
const MAX_OWNER = 80;
const MAX_DISPLAY = 120;
const MAX_EXAMPLE = 200;
const MAX_COLUMN_NAME = 256;

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function clip(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

// ── Tags (PURE) ──────────────────────────────────────────────────────────────

/** '#Sales Q3 ' → 'sales-q3'. '' when nothing usable is left. */
export function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, MAX_TAG_LEN);
}

/** Normalise, drop empties, dedupe preserving first-seen order, cap at 12. */
export function normalizeTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out: string[] = [];
  for (const r of list) {
    const t = normalizeTag(r);
    if (t && out.indexOf(t) < 0) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * The colour a NEW tag gets: the first palette slot no existing tag holds, and
 * once all eight are taken, cycle by count. Stored on first use and never
 * recomputed, so a tag keeps its colour when others come and go.
 */
export function pickTagColor(tags: Record<string, { color: number }>): number {
  const used = new Set<number>();
  let count = 0;
  for (const k of Object.keys(tags)) {
    count += 1;
    used.add(tags[k].color);
  }
  for (let i = 0; i < TAG_COLORS; i += 1) if (!used.has(i)) return i;
  return count % TAG_COLORS;
}

/** Give every tag in `names` a stored colour if it has none yet. Mutates. */
export function registerTags(file: CatalogFile, names: string[]): void {
  for (const n of names) {
    if (!own(file.tags, n)) file.tags[n] = { color: pickTagColor(file.tags) };
  }
}

// ── Refs ─────────────────────────────────────────────────────────────────────

export function parseRef(ref: unknown): { kind: CatalogKind; id: string } | null {
  if (typeof ref !== 'string') return null;
  const at = ref.indexOf(':');
  if (at < 0) return null;
  const kind = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (!(CATALOG_KINDS as readonly string[]).includes(kind) || !isValidId(id)) return null;
  return { kind: kind as CatalogKind, id };
}

// ── Sanitising (every stored value is untrusted) ─────────────────────────────

export function emptyCatalog(): CatalogFile {
  return { schemaVersion: 1, tags: dict(), records: dict(), columns: dict() };
}

function sanitizeRecordDoc(raw: any): RecordDoc {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    description: clip(r.description, MAX_DESCRIPTION),
    tags: normalizeTags(r.tags),
    owner: clip(r.owner, MAX_OWNER),
    updatedBy: clip(r.updatedBy, MAX_OWNER),
    updatedAt: clip(r.updatedAt, 40),
  };
}

function sanitizeColumnDoc(raw: any): ColumnDoc {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    description: clip(r.description, MAX_DESCRIPTION),
    displayName: clip(r.displayName, MAX_DISPLAY),
    example: clip(r.example, MAX_EXAMPLE),
    sensitivity: SENSITIVITIES.has(r.sensitivity) ? r.sensitivity : 'none',
    updatedBy: clip(r.updatedBy, MAX_OWNER),
    updatedAt: clip(r.updatedAt, 40),
  };
}

export function sanitizeCatalog(raw: any): CatalogFile {
  const out = emptyCatalog();
  if (!raw || typeof raw !== 'object') return out;
  const tags = raw.tags && typeof raw.tags === 'object' ? raw.tags : {};
  for (const k of Object.keys(tags)) {
    const name = normalizeTag(k);
    const c = Number(tags[k] && tags[k].color);
    if (name && !own(out.tags, name)) {
      out.tags[name] = { color: Number.isInteger(c) && c >= 0 && c < TAG_COLORS ? c : pickTagColor(out.tags) };
    }
  }
  const records = raw.records && typeof raw.records === 'object' ? raw.records : {};
  for (const k of Object.keys(records)) {
    if (!parseRef(k)) continue;
    const doc = sanitizeRecordDoc(records[k]);
    registerTags(out, doc.tags); // a hand-edited tag with no colour still gets one
    out.records[k] = doc;
  }
  const columns = raw.columns && typeof raw.columns === 'object' ? raw.columns : {};
  for (const dsId of Object.keys(columns)) {
    if (!isValidId(dsId) || !columns[dsId] || typeof columns[dsId] !== 'object') continue;
    const cols = dict<ColumnDoc>();
    for (const name of Object.keys(columns[dsId])) {
      if (name && name.length <= MAX_COLUMN_NAME) cols[name] = sanitizeColumnDoc(columns[dsId][name]);
    }
    out.columns[dsId] = cols;
  }
  return out;
}

// ── Disk ─────────────────────────────────────────────────────────────────────

function getProjectsBase(): string {
  return path.join(appPaths.userData(), 'projects');
}

function catalogPath(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'catalog.json');
}

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

/** The whole file. Missing or corrupt → empty; never throws. */
export async function load(projectId: string): Promise<CatalogFile> {
  if (!isValidId(projectId)) return emptyCatalog();
  try {
    return sanitizeCatalog(JSON.parse(await fs.promises.readFile(catalogPath(projectId), 'utf8')));
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') console.error('[catalog] unreadable catalog, treating as empty:', err.message);
    return emptyCatalog();
  }
}

// Every write is read-modify-write of ONE file, and the Details popover saves
// on blur AND on Enter — two overlapping writes would drop one edit. A
// per-project promise chain serialises them.
// ponytail: one lock per project file; per-record files if write volume ever matters.
const chains = new Map<string, Promise<unknown>>();
async function mutate<T>(projectId: string, fn: (file: CatalogFile) => T): Promise<T> {
  const prev = chains.get(projectId) || Promise.resolve();
  const next = prev.catch(() => undefined).then(async () => {
    const file = await load(projectId);
    const result = fn(file);
    await fs.promises.mkdir(path.dirname(catalogPath(projectId)), { recursive: true });
    await writeJsonAtomic(catalogPath(projectId), file);
    return result;
  });
  chains.set(projectId, next);
  try {
    return await next;
  } finally {
    if (chains.get(projectId) === next) chains.delete(projectId);
  }
}

/** The OS account name, for `updatedBy`. Throws on some locked-down accounts. */
export function osUser(): string {
  try {
    return String(os.userInfo().username || '').trim().slice(0, MAX_OWNER);
  } catch (_) {
    return '';
  }
}

// ── Records ──────────────────────────────────────────────────────────────────

const EMPTY_DOC: RecordDoc = { description: '', tags: [], owner: '', updatedBy: '', updatedAt: '' };

export async function getDoc(projectId: string, ref: string): Promise<RecordDoc | null> {
  if (!isValidId(projectId) || !parseRef(ref)) return null;
  const file = await load(projectId);
  return own(file.records, ref) ? file.records[ref] : { ...EMPTY_DOC, tags: [] };
}

export interface DocPatch { description?: unknown; tags?: unknown; owner?: unknown }

/** Merge the fields PRESENT in `patch`; stamp updatedBy/updatedAt. */
export async function setDoc(projectId: string, ref: string, patch: DocPatch): Promise<RecordDoc | null> {
  if (!isValidId(projectId) || !parseRef(ref)) return null;
  const p = patch && typeof patch === 'object' ? patch : {};
  return mutate(projectId, (file) => {
    const cur = own(file.records, ref) ? file.records[ref] : { ...EMPTY_DOC, tags: [] };
    const next: RecordDoc = {
      description: p.description !== undefined ? clip(p.description, MAX_DESCRIPTION) : cur.description,
      tags: p.tags !== undefined ? normalizeTags(p.tags) : cur.tags,
      owner: p.owner !== undefined ? clip(p.owner, MAX_OWNER) : cur.owner,
      updatedBy: osUser(),
      updatedAt: new Date().toISOString(),
    };
    registerTags(file, next.tags);
    file.records[ref] = next;
    return next;
  });
}

// ── Columns ──────────────────────────────────────────────────────────────────

export async function getColumns(projectId: string, datasetId: string): Promise<Record<string, ColumnDoc>> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return dict();
  const file = await load(projectId);
  return own(file.columns, datasetId) ? file.columns[datasetId] : dict();
}

export interface ColumnPatch { description?: unknown; displayName?: unknown; example?: unknown; sensitivity?: unknown }

export async function setColumn(
  projectId: string, datasetId: string, column: string, patch: ColumnPatch,
): Promise<ColumnDoc | null> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return null;
  if (typeof column !== 'string' || !column || column.length > MAX_COLUMN_NAME) return null;
  const p = patch && typeof patch === 'object' ? patch : {};
  return mutate(projectId, (file) => {
    if (!own(file.columns, datasetId)) file.columns[datasetId] = dict();
    const cols = file.columns[datasetId];
    const cur = own(cols, column) ? cols[column] : sanitizeColumnDoc({});
    const next: ColumnDoc = {
      description: p.description !== undefined ? clip(p.description, MAX_DESCRIPTION) : cur.description,
      displayName: p.displayName !== undefined ? clip(p.displayName, MAX_DISPLAY) : cur.displayName,
      example: p.example !== undefined ? clip(p.example, MAX_EXAMPLE) : cur.example,
      sensitivity: p.sensitivity !== undefined
        ? (SENSITIVITIES.has(String(p.sensitivity)) ? p.sensitivity as Sensitivity : 'none')
        : cur.sensitivity,
      updatedBy: osUser(),
      updatedAt: new Date().toISOString(),
    };
    cols[column] = next;
    return next;
  });
}

/**
 * column → display name, for every column that has one. For captions and the
 * Assistant's answer cards: a caption says "Discount" where the column is
 * `disc_pct`, because that is what the user called it.
 */
export async function displayNames(projectId: string, datasetId: string): Promise<Record<string, string>> {
  const cols = await getColumns(projectId, datasetId);
  const out: Record<string, string> = {};
  for (const name of Object.keys(cols)) {
    if (cols[name].displayName && name !== '__proto__') out[name] = cols[name].displayName;
  }
  return out;
}

// ── Sensitivity (PURE) ───────────────────────────────────────────────────────

/** Which classes appear among these column docs, in a fixed order. */
export function sensitivityClasses(docs: Array<Record<string, ColumnDoc>>): Array<'financial' | 'personal'> {
  const seen = new Set<string>();
  for (const cols of docs) for (const k of Object.keys(cols)) seen.add(cols[k].sensitivity);
  return (['financial', 'personal'] as const).filter((c) => seen.has(c));
}

/** The report cover's lines. Values are never redacted — this only SAYS so. */
export function sensitivityLines(classes: Array<'financial' | 'personal'>): string[] {
  return classes.map((c) => `Contains ${c} data`);
}
