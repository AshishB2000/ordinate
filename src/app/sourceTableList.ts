// The Source tables tab's list and its "To fill in next" strip (docs/semantic-layer/02-source-tables.md,
// D4, D5): per connection, the union of the documented tables (the index) and the tables datasets are
// built from (D9). Records only: no warehouse call, no dataset hydrated. Editor-only, like its channels.

import { getConnector } from '../connectors';
import * as connections from '../connectors/connections';
import type { Connection } from '../connectors/connections';
import { estimateLabel } from '../connectors/bigqueryShape';
import type { ConnectorDef } from '../connectors/types';
import * as datasets from '../data/datasets';
import { docTablesOf, sourceTablesOf } from '../data/sourceTableOf';
import { listSourceIndex, type SourceTableDoc } from './sourceTables';

/** Also the rank: a gap earlier in the list is shown first. */
export type SourceTodoKind = 'used_no_doc' | 'never_read' | 'no_owner' | 'no_guide' | 'stale_read';
const RANK: readonly SourceTodoKind[] = ['used_no_doc', 'never_read', 'no_owner', 'no_guide', 'stale_read'];

export interface SourceRow { docId?: string; table: string; owner: string; hasGuide: boolean; readAt?: string; datasetIds: string[] }
export interface SourceConn { connId: string; name: string; connectorId: string; label: string; readsFacts: boolean; factsWake?: true; rows: SourceRow[] }
export interface SourceTodo { connId: string; docId?: string; table: string; kind: SourceTodoKind }
export interface UsedDataset { id: string; name: string }

export const SOURCE_TODO_SHOWN = 4, STALE_DAYS = 30;

/** Can a click read this connector's tables from the warehouse? */
export function readsFactsOf(def: ConnectorDef | null): boolean {
  return !!def && (typeof def.tableFacts === 'function' || typeof def.describeTable === 'function');
}

/** A connection as the tab names it (an editor reads the stored name), with its connector's label: the tab asks no catalog. */
export function connectionHead(c: Connection): Omit<SourceConn, 'rows'> {
  const def = getConnector(c.connectorId);
  return { connId: c.id, name: c.name, connectorId: c.connectorId, label: def?.label ?? c.connectorId, readsFacts: readsFactsOf(def), ...(def?.factsWake ? { factsWake: true as const } : {}) };
}

/** A doc as `:get` and `:read` reply, built key by key (`dismissed` never leaves). The server formats the size; the web never divides it. */
export function docView(docId: string, d: SourceTableDoc) {
  const facts = d.facts && { ...d.facts, ...(d.facts.bytes !== undefined ? { sizeLabel: estimateLabel(d.facts.bytes) } : {}) };
  return { docId, table: d.table, owner: d.owner, refresh: d.refresh, requiredFilters: d.requiredFilters, guide: d.guide, ...(facts ? { facts } : {}), updatedBy: d.updatedBy, updatedAt: d.updatedAt };
}

function gapsOf(c: SourceConn, r: SourceRow, now: number): SourceTodoKind[] {
  if (r.docId === undefined) return ['used_no_doc']; // notes that do not exist yet have no other gap
  const gaps: SourceTodoKind[] = [];
  if (c.readsFacts && !r.readAt) gaps.push('never_read');
  if (!r.owner) gaps.push('no_owner');
  if (!r.hasGuide) gaps.push('no_guide');
  if (c.readsFacts && r.readAt && now - Date.parse(r.readAt) > STALE_DAYS * 86_400_000) gaps.push('stale_read');
  return gaps;
}

/** Every row's gaps, by rank and then in row order: the first SOURCE_TODO_SHOWN, and how many more there are. */
export function sourceTodoOf(conns: SourceConn[], now: number): { todo: SourceTodo[]; more: number } {
  const all: SourceTodo[] = [];
  for (const c of conns) for (const r of c.rows) for (const kind of gapsOf(c, r, now)) all.push({ connId: c.connId, ...(r.docId ? { docId: r.docId } : {}), table: r.table, kind });
  all.sort((a, b) => RANK.indexOf(a.kind) - RANK.indexOf(b.kind)); // stable: row order within a kind
  return { todo: all.slice(0, SOURCE_TODO_SHOWN), more: Math.max(0, all.length - SOURCE_TODO_SHOWN) };
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }): number => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1);

/**
 * connId → table (as its doc names it: docTablesOf) → the datasets built from it, by name. Metadata only: the summaries, then each
 * one's origin (`getDatasetMeta` never hydrates). A Live view and a copy of it are two datasets on
 * one table; a query with no link is on none (D9).
 */
export async function usedTables(projectId: string, conns: Connection[]): Promise<Map<string, Map<string, UsedDataset[]>>> {
  const byId = new Map(conns.map((c) => [c.id, c]));
  const out = new Map<string, Map<string, UsedDataset[]>>();
  const documented = new Map(await Promise.all(conns.map(async (c) => [c.id, (await listSourceIndex(projectId, c.id)).map((e) => e.table)] as const)));
  const mine = (await datasets.listDatasets(projectId)).filter((d) => d.originConnId !== undefined && byId.has(d.originConnId));
  for (const d of mine.map((x) => ({ id: x.id, name: x.name, connId: x.originConnId as string })).sort(byName)) {
    const meta = await datasets.getDatasetMeta(projectId, d.id);
    const perTable = out.get(d.connId) ?? new Map<string, UsedDataset[]>();
    for (const table of docTablesOf(sourceTablesOf(meta?.origin, byId.get(d.connId)), documented.get(d.connId) ?? [])) perTable.set(table, [...(perTable.get(table) ?? []), { id: d.id, name: d.name }]);
    out.set(d.connId, perTable);
  }
  return out;
}

export async function sourceList(projectId: string): Promise<{ connections: SourceConn[]; todo: SourceTodo[]; more: number }> {
  const conns = await connections.listConnections(projectId);
  const used = await usedTables(projectId, conns);
  const out: SourceConn[] = [];
  for (const c of conns) {
    const built = used.get(c.id) ?? new Map<string, UsedDataset[]>();
    const indexed = await listSourceIndex(projectId, c.id);
    const documented: SourceRow[] = indexed.map((e) => ({
      docId: e.docId, table: e.table, owner: e.owner, hasGuide: e.hasGuide, ...(e.readAt ? { readAt: e.readAt } : {}), datasetIds: (built.get(e.table) ?? []).map((d) => d.id),
    }));
    const docs = new Set(indexed.map((e) => e.table));
    const undocumented: SourceRow[] = [...built.keys()].filter((t) => !docs.has(t)).sort((a, b) => a.localeCompare(b))
      .map((table) => ({ table, owner: '', hasGuide: false, datasetIds: (built.get(table) ?? []).map((d) => d.id) }));
    const rows = [...documented, ...undocumented];
    if (rows.length) out.push({ ...connectionHead(c), rows });
  }
  return { connections: out, ...sourceTodoOf(out, Date.now()) };
}
