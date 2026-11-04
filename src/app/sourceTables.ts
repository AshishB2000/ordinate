// Source table docs: what an editor writes down about a warehouse table (owner, refresh, required
// filters, a markdown guide) and what a read of the warehouse stored beside it
// (docs/semantic-layer/02-source-tables.md, D1, D2). One index per connection and one doc per
// table, both records through recordFs. This file: the shapes, the whitelists that keep a
// field a later release writes (`facts`, `dismissed`) through every re-save, and the store.
//
// Lock order is the doc, then the index, never the reverse. A create writes its new doc outside
// any lock and then takes the index's, so a crash leaves an unlisted doc, never an entry with no
// doc; a delete takes the entry out first for the same reason. Nothing is cached: every call
// reads the records, so any pod answers the same.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { connectionsDir } from '../connectors/connections';
import { sanitizeFacts, type TableFacts } from '../connectors/tableFacts';
import { contentTag, lockedUpdate, type Tagged } from './editConflict';
import { osUser } from './catalog';
import { isValidId } from './ids';
import { logger } from './logger';
import * as recordFs from './recordFs';
import { sourceTablesFull } from './sourceTableMessages';

export interface Dismissed {
  /** Short hashes of what an editor dismissed, never the text (viewers read the catalog). */
  table?: string;
  key?: string;
  columns?: Record<string, string>;
}

export interface SourceTableDoc {
  /** Exactly as `listTables` names it: trimmed at the ends, never case-folded (D2). */
  table: string;
  owner: string;
  refresh: string;
  requiredFilters: string;
  /** Markdown. */
  guide: string;
  facts?: TableFacts & { readAt: string; readBy: string };
  /** By dataset id. Never leaves the server. */
  dismissed?: Record<string, Dismissed>;
  updatedBy: string;
  updatedAt: string;
  schemaVersion: 1;
}

export interface SourceIndexEntry {
  table: string;
  docId: string;
  owner: string;
  hasGuide: boolean;
  readAt?: string;
}

export const MAX_SOURCE_DOCS = 2000, MAX_TABLE = 1000, MAX_OWNER = 80, MAX_REFRESH = 200, MAX_REQUIRED = 500, MAX_SOURCE_GUIDE = 8000;
const MAX_STAMP = 40;
const MAX_DISMISSED_DATASETS = 500, MAX_DISMISSED_COLUMNS = 2000, MAX_COLUMN_NAME = 256;
const HASH_RE = /^[A-Za-z0-9_-]{12}$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Clip, then trim: a second pass finds nothing left to cut. */
const line = (v: unknown, max: number): string => str(v).slice(0, max).trim();

function sanitizeDismissed(raw: unknown): Record<string, Dismissed> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: [string, Dismissed][] = [];
  for (const [datasetId, v] of Object.entries(raw)) {
    if (out.length === MAX_DISMISSED_DATASETS) break;
    const d = v as Record<string, unknown> | null;
    if (!isValidId(datasetId) || !d || typeof d !== 'object') continue;
    const one: Dismissed = {};
    if (HASH_RE.test(str(d.table))) one.table = str(d.table);
    if (HASH_RE.test(str(d.key))) one.key = str(d.key);
    const cols = d.columns && typeof d.columns === 'object' && !Array.isArray(d.columns) ? Object.entries(d.columns) : [];
    const kept = cols.filter(([name, h]) => name !== '' && name.length <= MAX_COLUMN_NAME && HASH_RE.test(str(h))).slice(0, MAX_DISMISSED_COLUMNS);
    // fromEntries defines own properties, so a column named __proto__ is data.
    if (kept.length) one.columns = Object.fromEntries(kept) as Record<string, string>;
    if (Object.keys(one).length) out.push([datasetId, one]);
  }
  return out.length ? Object.fromEntries(out) : undefined;
}

/** The doc a stored record is, or null without a table name. Keeps `facts` and `dismissed`, so a pod that never writes either does not drop them on a re-save. */
export function sanitizeSourceDoc(raw: unknown): SourceTableDoc | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return null;
  const table = str(r.table).trim();
  if (!table || table.length > MAX_TABLE) return null;
  const facts = sanitizeFacts(r.facts);
  const readAt = line((r.facts as Record<string, unknown> | null)?.readAt, MAX_STAMP);
  const readBy = line((r.facts as Record<string, unknown> | null)?.readBy, MAX_OWNER);
  const dismissed = sanitizeDismissed(r.dismissed);
  // The key order is fixed here, so two equal docs stringify equal.
  return {
    table,
    owner: line(r.owner, MAX_OWNER),
    refresh: line(r.refresh, MAX_REFRESH),
    requiredFilters: line(r.requiredFilters, MAX_REQUIRED),
    guide: str(r.guide).slice(0, MAX_SOURCE_GUIDE),
    ...(facts && readAt ? { facts: { ...facts, readAt, readBy } } : {}),
    ...(dismissed ? { dismissed } : {}),
    updatedBy: line(r.updatedBy, MAX_OWNER),
    updatedAt: line(r.updatedAt, MAX_STAMP),
    schemaVersion: 1,
  };
}

/** The index a stored record is: valid doc ids, the first entry per exact name (and per doc) wins, at most MAX_SOURCE_DOCS. */
export function sanitizeIndex(raw: unknown): SourceIndexEntry[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  const ids = new Set<string>();
  const out: SourceIndexEntry[] = [];
  for (const v of raw) {
    const e = v as Record<string, unknown> | null;
    const table = str(e?.table).trim();
    const docId = str(e?.docId);
    if (!e || !table || table.length > MAX_TABLE || !isValidId(docId) || names.has(table) || ids.has(docId)) continue;
    names.add(table);
    ids.add(docId);
    const entry: SourceIndexEntry = { table, docId, owner: line(e.owner, MAX_OWNER), hasGuide: e.hasGuide === true };
    const readAt = line(e.readAt, MAX_STAMP);
    if (readAt) entry.readAt = readAt;
    out.push(entry);
    if (out.length === MAX_SOURCE_DOCS) break;
  }
  return out;
}

// ── The store ────────────────────────────────────────────────────────────────

function partsOk(...ids: string[]): void {
  if (!ids.every(isValidId)) throw new Error('invalid id'); // a path is never built from anything else
}

/** `connections/<connId>/tables/<docId>.json` */
export function docPath(projectId: string, connId: string, docId: string): string {
  partsOk(projectId, connId, docId);
  return path.join(connectionsDir(projectId), connId, 'tables', docId + '.json');
}

/** `connections/<connId>.tables.json` */
export function indexPath(projectId: string, connId: string): string {
  partsOk(projectId, connId);
  return path.join(connectionsDir(projectId), connId + '.tables.json');
}

/** Temp sibling, then rename: a crash never leaves half a record. */
async function writeJson(file: string, obj: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

/** The parsed record, or null when it is missing or damaged (damage is logged, never fatal). */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await recordFs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') logger.error('[sourceTables] Skipping an unreadable record:', path.basename(file), err instanceof Error ? err.message : err);
    return null;
  }
}

/** The doc and the tag of the bytes as stored, from ONE read. */
async function readDoc(file: string): Promise<Tagged<SourceTableDoc> | null> {
  const data = await readJson(file);
  const rec = sanitizeSourceDoc(data);
  if (data !== null && !rec) logger.error('[sourceTables] Skipping a doc with no table:', path.basename(file));
  return rec ? { rec, tag: contentTag('sourceTable', data) } : null;
}

const readIndex = async (projectId: string, connId: string): Promise<SourceIndexEntry[]> => sanitizeIndex(await readJson(indexPath(projectId, connId)));

/** What the list needs of a doc, so the tab costs one small read per connection. */
const entryOf = (docId: string, d: SourceTableDoc): SourceIndexEntry => ({
  table: d.table, docId, owner: d.owner, hasGuide: d.guide.trim() !== '', ...(d.facts ? { readAt: d.facts.readAt } : {}),
});

/** Under the index's lock. */
const editIndex = (projectId: string, connId: string, change: (cur: SourceIndexEntry[]) => SourceIndexEntry[] | null): Promise<void> => {
  const file = indexPath(projectId, connId);
  return recordFs.locked(file, async () => {
    const next = change(await readIndex(projectId, connId));
    if (next) await writeJson(file, next);
  });
};

/** The index entry of a doc, re-derived from it. A doc with no entry stays unlisted: nothing re-lists it. */
const syncIndex = (projectId: string, connId: string, docId: string, d: SourceTableDoc): Promise<void> =>
  editIndex(projectId, connId, (cur) => (cur.some((e) => e.docId === docId) ? cur.map((e) => (e.docId === docId ? entryOf(docId, d) : e)) : null));

export async function listSourceIndex(projectId: string, connId: string): Promise<SourceIndexEntry[]> {
  return isValidId(projectId) && isValidId(connId) ? readIndex(projectId, connId) : [];
}

export async function readSourceDoc(projectId: string, connId: string, docId: string): Promise<Tagged<SourceTableDoc> | null> {
  return isValidId(projectId) && isValidId(connId) && isValidId(docId) ? readDoc(docPath(projectId, connId, docId)) : null;
}

/** What a person typed: each present field replaces the stored one, an absent one keeps it. */
export interface SourcePatch { owner?: string; refresh?: string; requiredFilters?: string; guide?: string }
const HUMAN = ['owner', 'refresh', 'requiredFilters', 'guide'] as const;
const typed = (p: SourcePatch): SourcePatch => Object.fromEntries(HUMAN.filter((k) => typeof p[k] === 'string').map((k) => [k, p[k]]));

/** A new doc for `table`, or the one that already has that exact name (`created: false`, the patch unused). */
export async function createSourceDoc(projectId: string, connId: string, table: string, patch: SourcePatch): Promise<{ ok: true; docId: string; created: boolean } | { ok: false; error: string }> {
  const name = table.trim();
  if (!name || name.length > MAX_TABLE) throw new Error('A source table needs a name of 1 to 1,000 characters.'); // the contract refuses this first
  const has = (cur: SourceIndexEntry[]): SourceIndexEntry | undefined => cur.find((e) => e.table === name);
  const before = await readIndex(projectId, connId);
  const known = has(before);
  if (known) return { ok: true, docId: known.docId, created: false };
  if (before.length >= MAX_SOURCE_DOCS) return { ok: false, error: sourceTablesFull() };
  const docId = randomUUID();
  const doc = sanitizeSourceDoc({ table: name, ...typed(patch), updatedBy: osUser(), updatedAt: new Date().toISOString() });
  if (!doc) throw new Error('A source table needs a name of 1 to 1,000 characters.');
  await writeJson(docPath(projectId, connId, docId), doc);
  let result: { ok: true; docId: string; created: boolean } | { ok: false; error: string } = { ok: true, docId, created: true };
  await editIndex(projectId, connId, (cur) => {
    const raced = has(cur);
    if (raced) result = { ok: true, docId: raced.docId, created: false };
    else if (cur.length >= MAX_SOURCE_DOCS) result = { ok: false, error: sourceTablesFull() };
    else return [...cur, entryOf(docId, doc)];
    return null;
  });
  // Someone else's doc won the name (or the cap was reached): ours is listed nowhere. Best effort.
  if (!result.ok || !result.created) await recordFs.rm(docPath(projectId, connId, docId), { force: true }).catch(() => undefined);
  return result;
}

/** One guarded read-modify-write of a doc, holding it, with the index entry re-derived inside. */
function edit(projectId: string, connId: string, docId: string, base: string | undefined, change: (d: SourceTableDoc) => SourceTableDoc): Promise<SourceTableDoc | null> {
  const file = docPath(projectId, connId, docId);
  return lockedUpdate('sourceTable', { projectId, id: docId, file }, base, () => readDoc(file), async (existing) => {
    const next = sanitizeSourceDoc(change(existing)) ?? existing;
    await writeJson(file, next);
    await syncIndex(projectId, connId, docId, next);
    return next;
  });
}

/** An editor's save: the typed fields, stamped with who and when here. A stale `base` throws ERECORDCHANGED and nothing changes. Null when the doc is gone. */
export async function saveSourceDoc(projectId: string, connId: string, docId: string, patch: SourcePatch, base?: string): Promise<Tagged<SourceTableDoc> | null> {
  if (![projectId, connId, docId].every(isValidId)) return null;
  const saved = await edit(projectId, connId, docId, base, (d) => ({ ...d, ...typed(patch), updatedBy: osUser(), updatedAt: new Date().toISOString() }));
  return saved ? { rec: saved, tag: contentTag('sourceTable', saved) } : null;
}

/**
 * A change to what is not typed (facts, dismissals) under the doc's lock, then the index's. It can
 * move neither the name nor a typed field nor who and when last edited, so the edit tag stays put
 * and an open editor never sees a 409 for a read.
 */
export async function updateSourceDoc(projectId: string, connId: string, docId: string, fn: (d: SourceTableDoc) => SourceTableDoc): Promise<SourceTableDoc | null> {
  if (![projectId, connId, docId].every(isValidId)) return null;
  return edit(projectId, connId, docId, undefined, (d) => ({ ...fn(d), table: d.table, owner: d.owner, refresh: d.refresh, requiredFilters: d.requiredFilters, guide: d.guide, updatedBy: d.updatedBy, updatedAt: d.updatedAt }));
}

/** The doc and its entry go; the entry first, so a crash leaves an unlisted doc and never a dangling entry. False when there was neither. */
export async function deleteSourceDoc(projectId: string, connId: string, docId: string): Promise<boolean> {
  if (![projectId, connId, docId].every(isValidId)) return false;
  const file = docPath(projectId, connId, docId);
  return recordFs.locked(file, async () => {
    let listed = false;
    await editIndex(projectId, connId, (cur) => {
      listed = cur.some((e) => e.docId === docId);
      return listed ? cur.filter((e) => e.docId !== docId) : null;
    });
    const stored = await recordFs.exists(file);
    if (stored) await recordFs.rm(file, { force: true });
    return listed || stored;
  });
}
