// Which warehouse tables a dataset is built from (docs/semantic-layer/02-source-tables.md, D9).
// The only place that decides it: from the dataset's origin on the server, and from its connection
// for a dataset saved before the workbench. Pure, so the list, the lineage and the dataset Guide
// agree. Metadata only: nothing here reads a row or asks a warehouse.

import type { DatasetOrigin } from './datasetOrigin';

/**
 * The names the dataset's source tables go by, exact as `listTables` gave them. An editor's link
 * (`readsTables`) wins; else the table it was imported from; a query with no link reads none (we
 * never parse SQL). The same precedence a refresh uses (`selectionForDataset`: SQL before table).
 * An origin with neither is the connection's own saved selection, which a refresh re-runs: its
 * table, unless it also has a query (`selectionSql` prefers the query).
 */
export function sourceTablesOf(origin: DatasetOrigin | undefined, conn: { table?: string; query?: string } | undefined): string[] {
  if (origin?.kind !== 'connection') return [];
  if (origin.readsTables?.length) return origin.readsTables;
  if (origin.sql) return [];
  if (origin.table) return [origin.table];
  const table = conn?.table?.trim();
  return table && !conn?.query?.trim() ? [table] : [];
}

/**
 * `tables` by the names their docs go by, deduped in order. A bare name (a link the picker stored before it
 * named schemas) becomes the one documented `schema.name` ending in it; with two such docs it stays as it is.
 */
export function docTablesOf(tables: string[], documented: readonly string[]): string[] {
  const one = (t: string): string => {
    if (t.includes('.') || documented.includes(t)) return t;
    const hits = documented.filter((d) => d.endsWith(`.${t}`));
    return hits.length === 1 ? hits[0] : t;
  };
  return [...new Set(tables.map(one))];
}
