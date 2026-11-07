// What a warehouse knows about one table (docs/semantic-layer/02-source-tables.md, D6), and the
// whitelist every reply of it passes. Pure: no fs, no network. A driver's answer is untrusted
// text, so a bad field is dropped (never repaired), strings are clipped, and a figure is a finite
// non-negative number or nothing. Sanitizing twice gives what sanitizing once did.

import type { ConnectorError } from './types';

export interface FactColumn {
  name: string;
  type: string;
  nullable?: boolean;
  comment?: string;
  key?: true;
}

export interface TableFacts {
  comment?: string;
  columns: FactColumn[];
  primaryKey?: { columns: string[]; enforced: boolean };
  partition?: { columns: string[]; method?: string; required?: boolean };
  clusterBy?: string[];
  sortKey?: string[];
  distribution?: { style: string; columns: string[] };
  indexes?: { name: string; columns: string[]; unique: boolean; kind?: string }[];
  rowEstimate?: number;
  bytes?: number;
  lastModified?: string;
}

/** What a family's reader runs its catalog statements through: bound values, positional rows. Every reader takes this, so none imports its driver module. */
export type FactsQuery = (sql: string, params: (string | number | null)[]) => Promise<unknown[][]>;
export type FactsReply = ({ ok: true } & TableFacts) | ConnectorError;
/** Opens one connection (guarded and closed by the driver module) and hands `read` a query function on it. */
export type OpenFacts = (read: (q: FactsQuery) => Promise<FactsReply>) => Promise<FactsReply>;

/** The most rows one catalog statement of a facts read may return (the door's bound; a table's columns are its largest answer). */
export const FACTS_ROWS = 2_000;

export const MAX_FACT_COLUMNS = 2000, MAX_COMMENT = 2000, MAX_INDEXES = 50, MAX_KEY_COLUMNS = 32;
/** A column's name and type, and a key, index or method name: a table's facts reach about 5 MB at these caps (a record holds 8 MiB). */
const MAX_NAME = 256;
const MAX_DATE = 40;

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const figure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A list of names, clipped, at most MAX_KEY_COLUMNS of them; `min` is how many a field needs to mean anything. */
function names(v: unknown, min = 1): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x !== '').slice(0, MAX_KEY_COLUMNS).map((x) => x.slice(0, MAX_NAME));
  return out.length >= min ? out : undefined;
}

function sanitizeColumn(raw: unknown): FactColumn | null {
  const c = raw as Record<string, unknown> | null;
  const name = text(c?.name, MAX_NAME);
  if (!c || !name) return null;
  const out: FactColumn = { name, type: text(c.type, MAX_NAME) };
  if (typeof c.nullable === 'boolean') out.nullable = c.nullable;
  const comment = text(c.comment, MAX_COMMENT);
  if (comment) out.comment = comment;
  if (c.key === true) out.key = true;
  return out;
}

function sanitizeIndexFact(raw: unknown): NonNullable<TableFacts['indexes']>[number] | null {
  const i = raw as Record<string, unknown> | null;
  const name = text(i?.name, MAX_NAME);
  const columns = names(i?.columns);
  if (!i || !name || !columns || typeof i.unique !== 'boolean') return null;
  const kind = text(i.kind, MAX_NAME);
  return kind ? { name, columns, unique: i.unique, kind } : { name, columns, unique: i.unique };
}

/** The facts a reply may hold, or null when it has no `columns` list (nothing to show). */
export function sanitizeFacts(raw: unknown): TableFacts | null {
  const f = raw as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || !Array.isArray(f.columns)) return null;
  const out: TableFacts = { columns: f.columns.slice(0, MAX_FACT_COLUMNS).map(sanitizeColumn).filter((c): c is FactColumn => c !== null) };
  const comment = text(f.comment, MAX_COMMENT);
  if (comment) out.comment = comment;
  const pk = f.primaryKey as Record<string, unknown> | null;
  const pkColumns = names(pk?.columns);
  if (pkColumns && typeof pk?.enforced === 'boolean') out.primaryKey = { columns: pkColumns, enforced: pk.enforced };
  const part = f.partition as Record<string, unknown> | null;
  const partColumns = names(part?.columns);
  if (partColumns) {
    out.partition = { columns: partColumns };
    const method = text(part?.method, MAX_NAME);
    if (method) out.partition.method = method;
    if (typeof part?.required === 'boolean') out.partition.required = part.required;
  }
  const clusterBy = names(f.clusterBy);
  if (clusterBy) out.clusterBy = clusterBy;
  const sortKey = names(f.sortKey);
  if (sortKey) out.sortKey = sortKey;
  const dist = f.distribution as Record<string, unknown> | null;
  const distColumns = names(dist?.columns, 0); // EVEN and ALL distribution name no column
  const style = text(dist?.style, MAX_NAME);
  if (style && distColumns) out.distribution = { style, columns: distColumns };
  const indexes = Array.isArray(f.indexes) ? f.indexes.slice(0, MAX_INDEXES).map(sanitizeIndexFact).filter((i): i is NonNullable<typeof i> => i !== null) : [];
  if (indexes.length) out.indexes = indexes;
  if (figure(f.rowEstimate)) out.rowEstimate = f.rowEstimate;
  if (figure(f.bytes)) out.bytes = f.bytes;
  const modified = text(f.lastModified, MAX_DATE);
  if (/^\d{4}-\d{2}-\d{2}/.test(modified) && !Number.isNaN(Date.parse(modified))) out.lastModified = modified;
  return out;
}
