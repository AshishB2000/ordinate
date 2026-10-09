// Live datasets' channels (docs/live-data/00-plan.md L2.1) — server, MAIN ONLY.
//
//   connection:import {mode:'live'}  "Add from connection" → "Live": no rows are
//                                    fetched; the selection's columns are read
//                                    from the source's catalog (describeTable)
//                                    or by running it at a one-row cap, and
//                                    stored with DECLARED types (../data/liveSchema).
//   dataset:setMode                  The dataset's settings: extract → Live drops
//                                    the stored copy (only with `confirmDrop`,
//                                    the web's confirm dialog); Live → extract
//                                    runs a normal import of the same selection
//                                    ("Make a copy" can reuse it, L2.6); Live →
//                                    Live sets the cache age.
//   refresh on a Live dataset        bumps the cache epoch (plan D5) — nothing
//                                    is fetched, so nothing can go stale.
//   connection:setLiveOptIn          a PostgreSQL connection's "This is a read
//                                    replica or a warehouse" (L3.2, ./liveOptIn):
//                                    both Live doors above refuse without it.
//
// Every socket goes through connectionRun (the SSRF guard); the secret is
// resolved here, in main, exactly as ./connections.ts does; every error that
// leaves has been through safeError. No SQL text, URL or dialect reaches a
// reply — a dataset is named by its header only.

import { ipcMain } from './bus';
import * as connections from '../connectors/connections';
import * as connectionRun from '../connectors/connectionRun';
import { getConnector } from '../connectors';
import * as datasets from '../data/datasets';
import { loadSecrets } from './connectionSecrets';
import { liveColumns, type SourceColumn } from '../data/liveSchema';
import { bumpEpoch, isLive, parseMaxCacheAge, setMaxCacheAge } from '../data/liveDataset';
import { saveLiveRecord, toExtractRecord, toLiveRecord } from '../data/liveRecord';
import * as msg from '../data/liveMessages';
import * as queryCache from '../engine/queryCache';
import { scanDataset } from '../app/privacyStore';
import { announceRefreshed } from '../data/refreshEvents';
import type { ParsedColumn } from '../data/parse';
import { liveOfferRefusal, setLiveOptIn } from './liveOptIn';

type Fail = { ok: false; error: string; code?: string };
type Selection = { table?: string; query?: string };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const header = (d: { id: string; name: string; rowCount: number; columns: ParsedColumn[] }) =>
  ({ id: d.id, name: d.name, rowCount: d.rowCount, columns: d.columns.map((c) => ({ name: c.name, type: c.type })) });

/** What a connection origin re-runs — the same rule as ./connections selectionForDataset. */
function selectionOf(origin: unknown): Selection | null {
  const o = (origin && typeof origin === 'object' ? origin : {}) as Record<string, unknown>;
  if (o.kind !== 'connection') return null;
  if (typeof o.sql === 'string' && o.sql.trim()) return { query: o.sql };
  if (typeof o.table === 'string' && o.table.trim()) return { table: o.table };
  return null;
}

/**
 * The selection's columns with declared types, read without fetching rows: the
 * catalog for a table (or a one-row run where the connector has no catalog),
 * a one-row run for a query.
 */
export async function readLiveSchema(projectId: string, connId: string, sel: Selection): Promise<{ ok: true; columns: ParsedColumn[] } | Fail> {
  const conn = await connections.getConnection(projectId, connId);
  if (!conn) return { ok: false, error: msg.liveConnectionGoneMessage() };
  const def = getConnector(conn.connectorId);
  // Can THIS connection be Live: a live dialect, and the opt-in an OLTP source asks for (L3.2).
  const refusal = liveOfferRefusal(def, conn.values);
  if (refusal || !def || !def.live) return { ok: false, error: refusal ?? msg.liveNotOfferedMessage() };
  const secrets = await loadSecrets(connId, def);
  let cols: SourceColumn[];
  if (sel.table) {
    const described = await connectionRun.describeTable(conn.connectorId, conn.values, secrets, sel.table);
    if (described && !described.ok) return described;
    if (described) cols = described.columns;
    else {
      const sql = connectionRun.buildTableSql(def.family, sel.table, 1);
      if (!sql) return { ok: false, error: 'Invalid table name' };
      const ran = await connectionRun.explainSql(conn.connectorId, conn.values, secrets, sql);
      if (!ran.ok) return ran;
      cols = ran.columns;
    }
  } else if (sel.query) {
    const ran = await connectionRun.explainSql(conn.connectorId, conn.values, secrets, sel.query);
    if (!ran.ok) return ran;
    cols = ran.columns;
  } else {
    return { ok: false, error: 'Pick a table or run a query first.' };
  }
  const typed = liveColumns(def.live.dialect, cols);
  if (typed.ok) return typed;
  return { ok: false, error: typed.reason === 'duplicate' ? msg.liveDuplicateColumnMessage(typed.name) : msg.liveNoColumnsMessage() };
}

/** `connection:import` with `mode: 'live'` — the schema stored, no rows fetched. */
export async function createLiveDataset(p: Record<string, unknown>) {
  const projectId = str(p.projectId);
  const connId = str(p.connId);
  const sql = str(p.sql);
  const table = sql ? '' : str(p.table);
  if (!sql && !table) return { ok: false, error: 'Pick a table or run a query first.' };
  const maxCacheAgeSec = parseMaxCacheAge(p.maxCacheAgeSec);
  if (maxCacheAgeSec === null) return { ok: false, error: msg.liveCacheAgeRangeMessage() };
  const schema = await readLiveSchema(projectId, connId, sql ? { query: sql } : { table });
  if (!schema.ok) return schema;
  const origin: Record<string, unknown> = { kind: 'connection', connId, ...(sql ? { sql } : { table }) };
  if (sql && str(p.queryId)) origin.queryId = str(p.queryId);
  const ds = await saveLiveRecord(projectId, { name: str(p.name) || table || 'Connection data', columns: schema.columns, origin, maxCacheAgeSec });
  if (!ds) return { ok: false, error: 'Invalid project, or the project no longer exists' };
  return { ok: true, dataset: { ...header(ds), mode: 'live' as const } };
}

/** Refresh on a Live dataset: reset its cache. Null when the dataset is not Live (the caller refreshes it as usual). */
export async function refreshLive(projectId: string, id: string) {
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta || !isLive(meta)) return null;
  const live = await bumpEpoch(projectId, id);
  if (!live) return { ok: false as const, error: 'Could not reset the cache' };
  queryCache.invalidateDataset(id, projectId);
  // Every refresh is announced (L0.1), so an open dashboard re-asks the warehouse.
  announceRefreshed({ projectId, datasetId: id, name: meta.name, rowsBefore: 0, rowsAfter: 0 });
  return { ok: true as const, dataset: header(meta), warnings: [] as string[], warningCount: 0, live: { epoch: live.epoch } };
}

/** `dataset:setMode`. */
export async function setDatasetMode(p: Record<string, unknown>) {
  const projectId = str(p.projectId);
  const id = str(p.datasetId);
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const maxCacheAgeSec = p.maxCacheAgeSec === undefined ? undefined : parseMaxCacheAge(p.maxCacheAgeSec);
  if (maxCacheAgeSec === null) return { ok: false, error: msg.liveCacheAgeRangeMessage() };

  if (p.mode === 'live') {
    if (isLive(meta)) {
      const live = maxCacheAgeSec === undefined ? meta.live : await setMaxCacheAge(projectId, id, maxCacheAgeSec);
      if (!live) return { ok: false, error: 'Could not change the cache age' };
      return { ok: true, mode: 'live', dataset: header(meta), maxCacheAgeSec: live.maxCacheAgeSec };
    }
    const sel = selectionOf(meta.origin);
    if (!sel || meta.origin?.kind !== 'connection') return { ok: false, error: msg.liveNeedsConnectionMessage() };
    if ((meta.steps ?? []).length > 0) return { ok: false, error: msg.liveHasStepsMessage() };
    // Can this source answer live at all? Asked before the confirm, so nobody confirms a drop that cannot happen.
    const conn = await connections.getConnection(projectId, meta.origin.connId);
    if (!conn) return { ok: false, error: msg.liveConnectionGoneMessage() };
    const refusal = liveOfferRefusal(getConnector(conn.connectorId), conn.values);
    if (refusal) return { ok: false, error: refusal };
    if (p.confirmDrop !== true) return { ok: false, code: 'confirm_drop', error: msg.liveConfirmDropMessage() };
    const schema = await readLiveSchema(projectId, meta.origin.connId, sel);
    if (!schema.ok) return schema;
    if (!(await toLiveRecord(projectId, id, schema.columns, maxCacheAgeSec))) return { ok: false, error: 'Could not switch the dataset to Live' };
    const after = await datasets.getDatasetMeta(projectId, id);
    return { ok: true, mode: 'live', dataset: after ? header(after) : header(meta), maxCacheAgeSec: after?.live?.maxCacheAgeSec };
  }

  if (!isLive(meta)) return { ok: true, mode: 'extract', dataset: header(meta) };
  const sel = selectionOf(meta.origin);
  if (!sel || meta.origin?.kind !== 'connection') return { ok: false, error: msg.liveConnectionGoneMessage() };
  const conn = await connections.getConnection(projectId, meta.origin.connId);
  if (!conn) return { ok: false, error: msg.liveConnectionGoneMessage() };
  const secrets = await loadSecrets(conn.id, getConnector(conn.connectorId));
  // A normal import: the app's own row cap, the connector's own bounds.
  const ran = await connectionRun.runConnection(conn.connectorId, conn.values, secrets, sel, { rowLimit: connectionRun.ROW_LIMIT });
  if (!ran.ok) return ran;
  const ds = await toExtractRecord(projectId, id, ran.result);
  if (!ds) return { ok: false, error: 'Could not copy the data' };
  await scanDataset(projectId, ds);
  return { ok: true, mode: 'extract', dataset: header(ds), warnings: ran.result.warnings ?? [] };
}

export function register(): void {
  ipcMain.handle('dataset:setMode', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await setDatasetMode(payload);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not change the dataset' };
    }
  });
  ipcMain.handle('connection:setLiveOptIn', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await setLiveOptIn(payload);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not change the connection' };
    }
  });
}
