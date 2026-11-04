// Small pure helpers the SQL families' facts readers share (mysqlFacts, mssqlFacts, oracleFacts,
// snowflakeFacts). No driver, no fs, no network: a reader gets its rows from the FactsQuery it is handed.

import type { FactsQuery, TableFacts } from './tableFacts';
import { MAX_INDEXES } from './tableFacts';

export type FactParam = string | number | null;

export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
/** A catalog figure (a row count, a byte size): a finite number of zero or more, else nothing. */
export const figure = (v: unknown): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
/** A catalog's yes/no in the spellings the engines use ('YES', 'Y', 'true', 1); anything else is unknown. */
export const flag = (v: unknown): boolean | undefined => {
  const s = str(v).toLowerCase();
  return ['yes', 'y', 'true', 't', '1'].includes(s) ? true : ['no', 'n', 'false', 'f', '0'].includes(s) ? false : undefined;
};

/** A statement whose failure costs its field, never the read. */
export async function attempt(q: FactsQuery, sql: string, params: FactParam[]): Promise<unknown[][] | undefined> {
  try {
    return await q(sql, params);
  } catch {
    return undefined;
  }
}

/** `table` split on `.`; null unless it has 1..maxParts parts and none is empty (a bad name never opens a socket). */
export function nameParts(table: unknown, maxParts: number): string[] | null {
  const parts = str(table).trim().split('.');
  return parts.length > maxParts || parts.some((p) => !p) ? null : parts;
}

/** Index rows, already ordered by index then position, folded into one entry per index (at most MAX_INDEXES). */
export function foldIndexes(rows: { name: string; column: string; unique: boolean; kind: string }[]): NonNullable<TableFacts['indexes']> {
  const byName = new Map<string, NonNullable<TableFacts['indexes']>[number]>();
  for (const r of rows) {
    if (!r.name || !r.column) continue;
    const have = byName.get(r.name);
    if (have) have.columns.push(r.column);
    else if (byName.size < MAX_INDEXES) byName.set(r.name, { name: r.name, columns: [r.column], unique: r.unique, ...(r.kind ? { kind: r.kind } : {}) });
  }
  return [...byName.values()];
}
