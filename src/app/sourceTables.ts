// Source table docs: what an editor writes down about a warehouse table (owner, refresh, required
// filters, a markdown guide) and what a read of the warehouse stored beside it
// (docs/semantic-layer/02-source-tables.md, D1, D2). One index per connection and one doc per
// table, both records through recordFs. This file: the shapes and the whitelists that keep a
// field a later release writes (`facts`, `dismissed`) through every re-save.

import { sanitizeFacts, type TableFacts } from '../connectors/tableFacts';
import { isValidId } from './ids';

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
