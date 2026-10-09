// The connections area's server calls (src/api/connections.ts). Contracts carry
// inputs only, so each reply is narrowed here by hand, mirrored from
// src/connectors/index.ts (CatalogEntry), src/connectors/connections.ts
// (PublicConnection) and src/ipc/connections.ts (the reply envelopes).
//
// Secrets: a value typed into a secret field travels ONE WAY, inside
// testAndSave / replaceSecret. Nothing here ever receives one back — a saved
// connection carries `secretSet` booleans and nothing else.

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import type { AutoRefreshEvery } from '../../api/datasets';

export type FieldType = 'text' | 'number' | 'password' | 'select' | 'checkbox' | 'textarea';

export interface CatalogField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  secret: boolean;
  help?: string;
}

export interface Connector {
  id: string;
  label: string;
  family: string;
  category: string;
  blurb?: string;
  fields: CatalogField[];
  /** False: no catalog to browse (HTTP engines, URL) — the workbench has no tree. */
  browsable: boolean;
  /** A SaaS source's fixed hosts. */
  hosts?: string[];
  /** True: the source prices a statement before it runs (BigQuery's dry run) — the editor shows it by Run. */
  estimates?: boolean;
  /** A dataset from it CAN be Live — asked at the warehouse each time (docs/live-data/00-plan.md D2). */
  live: boolean;
  /** With `live`: the checkbox a connection must have ticked before Live is offered for it (L3.2, D8 —
   *  PostgreSQL's "This is a read replica or a warehouse"). Absent: every connection may be Live. */
  liveOptIn?: string;
}

export type Logo = { path: string; color: string; title: string } | { src: string; title: string };

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  updatedAt: string;
}

export type ConnStatus = 'ok' | 'error' | 'untested';

export interface Connection {
  id: string;
  projectId: string;
  name: string;
  connectorId: string;
  values: Record<string, string | number | boolean | null>;
  lastRefreshedAt?: string | null;
  lastStatus: ConnStatus;
  lastError: string | null;
  queries: SavedQuery[];
  /** Per secret field: is a value stored? Never the value. */
  secretSet?: Record<string, boolean>;
  /** Datasets imported from it (connections:list only). */
  datasetCount?: number;
}

/** What `dataset:list` returns that this area reads (src/data/datasetSummary.ts). */
export interface ConnDataset {
  id: string;
  name: string;
  rowCount: number;
  updatedAt: string;
  originKind?: string;
  originConnId?: string;
  lastRefreshedAt?: string;
  lastRefreshStatus?: 'ok' | 'error';
  lastRefreshError?: string | null;
  autoRefresh?: { every?: AutoRefreshEvery | null };
  /** Incremental refresh is on: it may refresh every 5 or 15 minutes. */
  incrementalOn?: true;
  /** The last scheduled refresh took longer than its interval (the server decides). */
  behindSchedule?: true;
  /** A Live dataset keeps no rows here; its Refresh resets the cache (L2.1). */
  mode?: 'live';
  /** Fresh on ask (L3.1): the age past which a figure pulls the new rows first. */
  freshOnAsk?: { maxStalenessSec: number; fullDue?: true };
}

export interface PreviewColumn {
  name: string;
  type: 'text' | 'number' | 'date';
}
export type PreviewCell = string | number | boolean | null;

/** A bounded ParseResult (connection:run / connection:sample). */
export interface Preview {
  columns: PreviewColumn[];
  rows: PreviewCell[][];
  rowCount: number;
  warnings?: string[];
}

export interface Table {
  schema?: string;
  name: string;
}

export interface ColumnDetail {
  name: string;
  type: string;
  nullable?: boolean;
}

type Fail = { ok: false; error: string };
type Reply<T> = ({ ok: true } & T) | Fail;

/** Rows a preview paints — main bounds a Run and a sample at this. The import limit is separate. */
export const PREVIEW_ROWS = 500;

/** `schema.table`, or `table` for a source with no schema: the string describe/sample take. */
export const qualify = (t: Table): string => (t.schema ? `${t.schema}.${t.name}` : t.name);

/** A failed reply as a thrown Error, so TanStack Query's error state carries the server's message. */
function unwrap<T>(r: Reply<T>, fallback: string): { ok: true } & T {
  if (!r || r.ok === false) throw new Error((r && r.error) || fallback);
  return r;
}

export function useCatalog() {
  return useQuery({
    queryKey: ['connectors:catalog'],
    queryFn: async () => (await rpc('connectors:catalog')) as Connector[],
    staleTime: Infinity,
  });
}

export function useLogos() {
  return useQuery({
    queryKey: ['connectors:logos'],
    queryFn: async () => (await rpc('connectors:logos')) as Record<string, Logo>,
    staleTime: Infinity,
  });
}

export function useConnections(projectId: string | undefined) {
  return useQuery({
    queryKey: ['connections:list', projectId],
    queryFn: projectId === undefined ? skipToken : async () => (await rpc('connections:list', { projectId })) as Connection[],
  });
}

/** The project's dataset summaries — "3 datasets" on a card, the rail's list. */
export function useProjectDatasets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['dataset:list', projectId],
    queryFn: projectId === undefined ? skipToken : async () => (await rpc('dataset:list', { projectId })) as ConnDataset[],
  });
}

/** One listTables call serves the tree (its tables) and the rail's test (its warnings). */
type TablesReply = { tables: Table[]; warnings: string[] };

async function fetchTables(projectId: string, connId: string): Promise<TablesReply> {
  const r = unwrap((await rpc('connection:listTables', { projectId, connId })) as Reply<{ tables: Table[]; warnings?: string[] }>, 'Could not list tables');
  return { tables: r.tables, warnings: r.warnings ?? [] };
}

export function useTables(projectId: string, connId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['connection:listTables', projectId, connId],
    queryFn: enabled ? () => fetchTables(projectId, connId) : skipToken,
    retry: false,
    select: (d: TablesReply) => d.tables,
  });
}

/** What the last test said beside "OK" (an administrator role, say) — the same cache entry as useTables. */
export function useTableWarnings(projectId: string, connId: string, enabled: boolean): string[] {
  return (
    useQuery({
      queryKey: ['connection:listTables', projectId, connId],
      queryFn: enabled ? () => fetchTables(projectId, connId) : skipToken,
      retry: false,
      select: (d: TablesReply) => d.warnings,
    }).data ?? []
  );
}

/** Invalidate what a connection write changes: the list (and its cards' dataset counts). */
export function useRefreshLists(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['connections:list', projectId] });
    void qc.invalidateQueries({ queryKey: ['dataset:list', projectId] });
  };
}

export async function testAndSave(input: {
  projectId: string;
  connectorId: string;
  name?: string;
  values: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
}) {
  const r = unwrap((await rpc('connection:testAndSave', input)) as Reply<{ connection: Connection; warnings?: string[] }>, 'Could not connect');
  return { connection: r.connection, warnings: r.warnings ?? [] };
}

export async function describeTable(projectId: string, connId: string, table: string) {
  const r = unwrap(
    (await rpc('connection:describe', { projectId, connId, table })) as Reply<{ schema: { columns: ColumnDetail[]; rowEstimate?: number } | null }>,
    'Columns unavailable',
  );
  return r.schema;
}

export async function sampleTable(projectId: string, connId: string, table: string) {
  return unwrap((await rpc('connection:sample', { projectId, connId, table, limit: PREVIEW_ROWS })) as Reply<{ preview: Preview }>, 'Could not read that table').preview;
}

export async function runQuery(projectId: string, connId: string, query: string) {
  return unwrap(
    (await rpc('connection:run', { projectId, connId, tableOrQuery: { query }, limit: PREVIEW_ROWS })) as Reply<{ preview: Preview }>,
    'Could not run the query',
  ).preview;
}

export async function explainQuery(projectId: string, connId: string, sql: string) {
  return unwrap((await rpc('connection:explain', { projectId, connId, sql })) as Reply<{ columns: ColumnDetail[] }>, 'Could not check the query').columns;
}

/** What a statement would read, from the source's free dry run: bytes and the server's "~1.2 GB" label. */
export interface Estimate {
  bytes: number;
  label: string;
}

export async function estimateQuery(projectId: string, connId: string, sql: string) {
  return unwrap((await rpc('connection:estimate', { projectId, connId, sql })) as Reply<{ estimate: Estimate | null }>, 'Could not estimate the query').estimate;
}

export async function saveQuery(projectId: string, connId: string, q: { id?: string; name?: string; sql?: string }) {
  return unwrap((await rpc('connection:saveQuery', { projectId, connId, ...q })) as Reply<{ queries: SavedQuery[] }>, 'Could not save that query').queries;
}

export async function deleteQuery(projectId: string, connId: string, queryId: string) {
  return unwrap((await rpc('connection:deleteQuery', { projectId, connId, queryId })) as Reply<{ queries: SavedQuery[] }>, 'Could not delete that query').queries;
}

export async function deleteConnection(projectId: string, connId: string) {
  unwrap((await rpc('connection:delete', { projectId, connId })) as Reply<object>, 'Could not delete the connection');
}

export async function replaceSecret(projectId: string, connId: string, key: string, value: string) {
  return unwrap((await rpc('connection:replaceSecret', { projectId, connId, key, value })) as Reply<{ connection: Connection }>, 'Could not replace it').connection;
}

/** "Copy the data" (an import) or "Live" (the schema only; questions go to the warehouse). */
export type SaveMode = 'extract' | 'live';

/**
 * Is Live offered for THIS connection: the connector can be Live and, when it asks for an
 * opt-in, the connection has it ticked. The server's own rule (src/connectors/index.ts
 * `isLiveOffered`), which also enforces it — this only decides what the workbench shows.
 */
export function liveOffered(def: Connector | null | undefined, conn: Pick<Connection, 'values'>): boolean {
  if (!def?.live) return false;
  return !def.liveOptIn || conn.values[def.liveOptIn] === true;
}

/** Tick or untick a connection's Live opt-in. Unticking is refused while Live datasets ask it — the error says how many. */
export async function setLiveOptIn(projectId: string, connId: string, on: boolean) {
  return unwrap((await rpc('connection:setLiveOptIn', { projectId, connId, on })) as Reply<{ on: boolean }>, 'Could not change it').on;
}

export async function importDataset(input: {
  projectId: string;
  connId: string;
  name: string;
  table?: string;
  sql?: string;
  queryId?: string;
  limit: number;
  mode?: SaveMode;
}) {
  return unwrap(
    (await rpc('connection:import', input)) as Reply<{ dataset: { id: string; name: string; rowCount: number; mode?: 'live' } }>,
    'Could not save the dataset',
  ).dataset;
}

export async function refreshDataset(projectId: string, connId: string, datasetId: string) {
  unwrap((await rpc('connection:refresh', { projectId, connId, datasetId })) as Reply<object>, 'Could not refresh that dataset');
}

export async function setSchedule(projectId: string, datasetId: string, every: AutoRefreshEvery | null) {
  unwrap((await rpc('dataset:update', { projectId, datasetId, autoRefresh: every })) as Reply<object>, 'Could not change the schedule');
}
