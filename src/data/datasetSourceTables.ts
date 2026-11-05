// A dataset's source tables as an editor links them (docs/semantic-layer/02-source-tables.md, D11):
// `origin.readsTables` is a label. Nothing a refresh, a Live statement or `dataset:source` does reads it.
// Written through the record's own lock, as `markRefresh` is, without hydrating the table.

import { datasetFilePath, serialized } from './datasetRecord';
import { sanitizeReadsTables } from './datasetOrigin';
import { isValidId } from '../app/ids';

/** Writes origin.readsTables on a connection origin, or removes it for []. Null: not a connection dataset (or no record). */
export async function setReadsTables(projectId: string, datasetId: string, tables: string[]): Promise<string[] | null> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return null;
  const done = await serialized(datasetFilePath(projectId, datasetId), (raw) => {
    const origin = raw.origin as Record<string, unknown> | undefined;
    if (!origin || origin.kind !== 'connection') return null;
    const kept = sanitizeReadsTables(tables);
    if (kept.length) origin.readsTables = kept;
    else delete origin.readsTables;
    return kept;
  });
  return done || null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The connection's tables, those whose last name part is a whole word of `sql` first (an order, never a link), each group by name. */
export function choiceOrder(tables: string[], sql: string): string[] {
  const mentioned = (t: string): boolean => {
    const last = t.split('.').pop()!.replace(/^["`[]|["`\]]$/g, '');
    return !!last && new RegExp(`(?<![\\w$])${escapeRe(last)}(?![\\w$])`, 'i').test(sql);
  };
  const byName = (a: string, b: string): number => a.localeCompare(b);
  return [...tables.filter(mentioned).sort(byName), ...tables.filter((t) => !mentioned(t)).sort(byName)];
}
