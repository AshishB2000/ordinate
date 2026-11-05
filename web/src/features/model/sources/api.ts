// The Source tables tab's server calls (src/api/sourceTables.ts, docs/semantic-layer/02-source-tables.md D14).
// Every channel is `write`: only an editor's web asks them. Contracts carry inputs only, so each reply is
// narrowed here by hand, mirrored from src/app/sourceTableList.ts and src/ipc/sourceTables.ts. Opening the
// tab, the list, the strip and the panel reads records only; the warehouse is asked on a click alone.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { okOr, type Fail } from '../../data/api';
import { ago } from '../../data/format';

/** src/app/sourceTableList.ts SourceTodoKind, in the server's rank. */
export type SourceTodoKind = 'used_no_doc' | 'never_read' | 'no_owner' | 'no_guide' | 'stale_read';
export interface SourceRow {
  /** Absent: a table datasets are built from that has no doc yet. */
  docId?: string;
  table: string;
  owner: string;
  hasGuide: boolean;
  readAt?: string;
  datasetIds: string[];
}
export interface SourceConn {
  connId: string;
  name: string;
  connectorId: string;
  /** The connector's own name ("Snowflake"): the tab asks no catalog. */
  label: string;
  /** A click can read this connection's tables from the warehouse. */
  readsFacts: boolean;
  /** Reading runs on a warehouse that a read can start (Databricks). */
  factsWake?: true;
  rows: SourceRow[];
}
export interface SourceTodo {
  connId: string;
  docId?: string;
  table: string;
  kind: SourceTodoKind;
}
export interface SourceList {
  ok: true;
  connections: SourceConn[];
  todo: SourceTodo[];
  more: number;
}

/** What a read stored (src/connectors/tableFacts.ts TableFacts), with who read it and the server's size label. */
export interface SourceFacts {
  comment?: string;
  columns: { name: string; type: string; nullable?: boolean; comment?: string; key?: true }[];
  primaryKey?: { columns: string[]; enforced: boolean };
  partition?: { columns: string[]; method?: string; required?: boolean };
  clusterBy?: string[];
  sortKey?: string[];
  distribution?: { style: string; columns: string[] };
  indexes?: { name: string; columns: string[]; unique: boolean; kind?: string }[];
  rowEstimate?: number;
  bytes?: number;
  /** "~12.4 GB": the server formats the size; this never divides it. */
  sizeLabel?: string;
  lastModified?: string;
  readAt: string;
  readBy: string;
}
/** A doc as `sourceTable:get` and `:read` reply (src/app/sourceTableList.ts docView). */
export interface SourceDoc {
  docId: string;
  table: string;
  owner: string;
  refresh: string;
  requiredFilters: string;
  guide: string;
  facts?: SourceFacts;
  updatedBy: string;
  updatedAt: string;
}
export interface SourceGot {
  ok: true;
  doc: SourceDoc;
  /** The edit tag the open copy was built on: a save sends it as `base`. */
  tag: string;
  datasets: { id: string; name: string }[];
}

export const LIST = 'sourceTable:list';
export const GET = 'sourceTable:get';

export const useSourceTables = (projectId: string) =>
  useQuery({
    queryKey: [LIST, projectId],
    queryFn: async () => okOr((await rpc(LIST, { projectId })) as SourceList | Fail, 'Source tables'),
  });

/** One doc: Overview, Columns and Guide. Records only. */
export const useSourceDoc = (projectId: string, connId: string, docId: string) =>
  useQuery({
    queryKey: [GET, projectId, connId, docId],
    queryFn: async () => okOr((await rpc(GET, { projectId, connId, docId })) as SourceGot | Fail, 'The notes'),
  });

/** Read from warehouse: an editor's click, the only thing here that asks it. A refusal keeps the facts the doc had. */
export function useReadFacts(projectId: string, connId: string, docId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = (await rpc('sourceTable:read', { projectId, connId, docId })) as { ok: true; doc: SourceDoc } | Fail;
      if (!r.ok) throw new Error(r.error || 'The table could not be read.');
      return r.doc;
    },
    onSuccess: (doc) => {
      // A read never moves the edit tag (updateSourceDoc), so the open copy keeps it.
      client.setQueryData<SourceGot>([GET, projectId, connId, docId], (old) => old && { ...old, doc });
      void client.invalidateQueries({ queryKey: [LIST, projectId] });
    },
  });
}

/** One strip item in words: "RETURNS: no doc". A stale read says how long ago, from the row's own `readAt`. */
export function sourceTodoText(t: SourceTodo, readAt?: string): string {
  switch (t.kind) {
    case 'used_no_doc':
      return `${t.table}: no doc`;
    case 'never_read':
      return `${t.table}: never read`;
    case 'no_owner':
      return `${t.table}: no owner`;
    case 'no_guide':
      return `${t.table}: no guide`;
    case 'stale_read':
      return `${t.table}: read ${ago(readAt)}`;
  }
}

/** The panel tab a strip item opens. */
export const sourceTodoPanel = (kind: SourceTodoKind): 'overview' | 'columns' | 'guide' =>
  kind === 'no_guide' ? 'guide' : kind === 'never_read' || kind === 'stale_read' ? 'columns' : 'overview';

/** "Start its notes", + Add and Connections' link: create the empty doc (idempotent by the exact name), its id back. */
export async function startNotes(projectId: string, connId: string, table: string): Promise<string> {
  const r = (await rpc('sourceTable:save', { projectId, connId, table, patch: {} })) as { ok: true; docId: string } | Fail;
  if (!r.ok) throw new Error(r.error || 'The notes could not be started.');
  return r.docId;
}
