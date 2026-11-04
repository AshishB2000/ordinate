// What a person says about a DATASET as a table: its role, key, grain and a free-text guide, kept
// in catalog.json under `tables[<datasetId>]` (catalog.ts). The sanitizers are what keep a stored doc
// through every catalog read and re-save; the store below reads and writes it under the catalog's lock.

import { isValidId } from './ids';
import { clip } from './clip';
import { sanitizeHierarchies, type Hierarchy } from './hierarchies';
import { getColumns, load, loadStrict, mutateCatalog, osUser } from './catalog';
import { closedToCaller } from '../data/rowAccess';
import type { FactTableDoc } from '../ai/columnNotes';

export type TableRole = '' | 'fact' | 'dimension';
const ROLES: readonly string[] = ['fact', 'dimension'];

/** Counted over the whole table when the key was last checked. Derived, never typed by a person. */
export interface KeyCheck { rows: number; empty: number; repeatedKeys: number; checkedAt: string }

export interface TableDoc {
  role: TableRole;
  /** One column name, matched exactly: never trimmed. '' = none. */
  key: string;
  grain: string;
  guide: string;
  keyCheck?: KeyCheck;
  /** Drill hierarchies over this dataset's columns; present only when there are any. */
  hierarchies?: Hierarchy[];
  updatedBy: string;
  updatedAt: string;
}

export const MAX_GRAIN = 200;
export const MAX_GUIDE = 8000;
const MAX_KEY = 256; // catalog.ts's MAX_COLUMN_NAME: a longer name cannot be documented
const MAX_STAMP = 80;

function count(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function sanitizeKeyCheck(raw: unknown): KeyCheck | undefined {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return undefined;
  if (!count(o.rows) || !count(o.empty) || !count(o.repeatedKeys) || typeof o.checkedAt !== 'string') return undefined;
  return { rows: o.rows, empty: o.empty, repeatedKeys: o.repeatedKeys, checkedAt: o.checkedAt.slice(0, MAX_STAMP) };
}

export function sanitizeTableDoc(raw: unknown): TableDoc {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const keyCheck = sanitizeKeyCheck(r.keyCheck);
  const hierarchies = sanitizeHierarchies(r.hierarchies);
  return {
    role: ROLES.includes(r.role as string) ? (r.role as TableRole) : '',
    key: typeof r.key === 'string' && r.key.length <= MAX_KEY ? r.key : '',
    grain: clip(r.grain, MAX_GRAIN),
    guide: clip(r.guide, MAX_GUIDE),
    ...(keyCheck && { keyCheck }),
    ...(hierarchies.length > 0 && { hierarchies }),
    updatedBy: clip(r.updatedBy, MAX_STAMP),
    updatedAt: clip(r.updatedAt, MAX_STAMP),
  };
}

/** dataset id -> doc, for valid ids with an object doc only. Null-prototype: ids are stored text. */
export function sanitizeTables(raw: unknown): Record<string, TableDoc> {
  const out = Object.create(null) as Record<string, TableDoc>;
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return out;
  for (const id of Object.keys(o)) {
    const doc = o[id];
    if (isValidId(id) && doc && typeof doc === 'object' && !Array.isArray(doc)) out[id] = sanitizeTableDoc(doc);
  }
  return out;
}

// ── The store ────────────────────────────────────────────────────────────────

const blank = (): TableDoc => sanitizeTableDoc({});

/** `strict`: an unreadable catalog THROWS instead of reading as "nothing documented" (`loadStrict`). */
export async function getTableDoc(projectId: string, datasetId: string, strict = false): Promise<TableDoc> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return blank();
  const file = await (strict ? loadStrict : load)(projectId);
  return file.tables?.[datasetId] ?? blank();
}

/** What a person typed: the fields PRESENT are merged. Clipped by `sanitizeTableDoc`; never `keyCheck`, `updatedBy` or `updatedAt`. */
export interface TablePatch { role?: unknown; key?: unknown; grain?: unknown; guide?: unknown }

/**
 * Merge the fields present in `patch`. A changed `key` drops the old key's `keyCheck`. Stamps who and when, here.
 * `keyChanged` is the store's own answer, taken under the lock against the key it replaced: a caller that must act on a
 * new key (count it) asks this, never a read of its own.
 */
export async function setTableDoc(projectId: string, datasetId: string, patch: TablePatch): Promise<{ table: TableDoc; keyChanged: boolean } | null> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return null;
  const p = patch && typeof patch === 'object' ? patch : {};
  return mutateCatalog(projectId, (file) => {
    const cur = file.tables?.[datasetId] ?? blank();
    const next = sanitizeTableDoc({
      role: p.role !== undefined ? p.role : cur.role,
      key: p.key !== undefined ? p.key : cur.key,
      grain: p.grain !== undefined ? p.grain : cur.grain,
      guide: p.guide !== undefined ? p.guide : cur.guide,
      keyCheck: p.key === undefined || p.key === cur.key ? cur.keyCheck : undefined,
      updatedBy: osUser(),
      updatedAt: new Date().toISOString(),
    });
    const tables = (file.tables ??= Object.create(null) as Record<string, TableDoc>);
    tables[datasetId] = next;
    return { table: next, keyChanged: next.key !== cur.key };
  });
}

/**
 * Store a key check — or clear it with null — only while the stored key is still `key`, the one that
 * was checked: a slow check for a key since changed must not stamp the new one. Null when it was not stored.
 * Derived data: `updatedBy` and `updatedAt` stay a person's.
 */
export async function writeKeyCheck(projectId: string, datasetId: string, key: string, check: KeyCheck | null): Promise<TableDoc | null> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return null;
  return mutateCatalog(projectId, (file) => {
    const tables = file.tables;
    const cur = tables?.[datasetId];
    if (!tables || !cur || cur.key !== key) return null;
    const next = sanitizeTableDoc({ ...cur, keyCheck: check ?? undefined });
    tables[datasetId] = next;
    return next;
  });
}

/** The doc a caller may read: counts over every row are withheld from a caller row access rules restrict (REDACT, as `quality:list`). */
export async function readableTableDoc(projectId: string, datasetId: string): Promise<TableDoc> {
  const doc = await getTableDoc(projectId, datasetId);
  if (!doc.keyCheck || !(await closedToCaller(projectId, datasetId))) return doc;
  const { keyCheck: _withheld, ...open } = doc;
  return open;
}

/**
 * The doc as the Assistant reads it, or undefined when nothing is written. A key with no grain reads as "One row per"
 * the key's name as the user calls it; `keyState` is left out when the key was never counted or the caller may not
 * count rows it cannot see (`readableTableDoc`).
 */
export async function tableFacts(projectId: string, datasetId: string): Promise<FactTableDoc | undefined> {
  const doc = await readableTableDoc(projectId, datasetId);
  if (!doc.role && !doc.key && !doc.grain && !doc.guide) return undefined;
  const out: FactTableDoc = {};
  if (doc.role) out.role = doc.role;
  if (doc.key) {
    out.key = doc.key;
    if (doc.keyCheck) out.keyState = doc.keyCheck.repeatedKeys > 0 ? 'repeats' : 'unique';
  }
  if (doc.grain) out.grain = doc.grain;
  else if (doc.key) out.grain = `One row per ${(await getColumns(projectId, datasetId))[doc.key]?.displayName || doc.key}`;
  if (doc.guide) out.guide = doc.guide;
  return out;
}
