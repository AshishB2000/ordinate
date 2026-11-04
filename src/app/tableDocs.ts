// What a person says about a DATASET as a table: its role, key, grain and a free-text guide, kept
// in catalog.json under `tables[<datasetId>]` (catalog.ts). Types and sanitizers only; the
// sanitizers are what keep a stored doc through every catalog read and re-save.

import { isValidId } from './ids';
import { clip } from './clip';
import { sanitizeHierarchies, type Hierarchy } from './hierarchies';

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
