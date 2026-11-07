// Which warehouse a Live dataset asks, and how — MAIN PROCESS ONLY.
// docs/live-data/00-plan.md L2.3.
//
// The dataset record says WHAT is asked: its declared columns (the only
// identifiers a statement may name, D4), its `live` block (cache age, epoch,
// schema sync time — D5) and its origin (a table, or the defining query). The
// connection says WHERE: the connector, its dialect, its non-secret values.
// The secrets store says HOW TO SIGN IN — read on the first warehouse call
// only, so a cache hit never touches it.
//
// Resolved per question, server side, exactly as ipc/connections resolves a
// refresh (the same connection read, the same `loadSecrets`), and NOTHING of
// it leaves the server: no SQL text, table name, host or secret is in a reply
// (`dataset:source` rule, R-L6). A refusal here is a typed failure with a
// catalog sentence, never an empty result.

import * as datasets from '../../data/datasets';
import * as connections from '../../connectors/connections';
import { getConnector } from '../../connectors';
import { quotedTable } from '../../connectors/connectionRun';
import { parseTablePath } from '../../connectors/bigqueryShape';
import type { ConnectorDef, LiveDialectId } from '../../connectors/types';
import { loadSecrets } from '../../ipc/connectionSecrets';
import { liveOfferRefusal } from '../../ipc/liveOptIn';
import { isLive } from '../../data/liveDataset';
import type { LiveSettings } from '../../data/liveDataset';
import type { FilterStep } from '../../data/transforms';
import * as liveMsg from '../../data/liveMessages';
import * as msg from '../liveQueryMessages';
import { ctx } from '../../server/context';
import type { CompileEnv, LiveSource } from './compile';
import type { LiveColumn, LiveRefusal } from './liveSpec';
import { refuse } from './liveSpec';
import { baseOfLive } from './liveBase';
import { declaredColumns } from '../../data/liveCalcs';

export interface LiveTarget {
  projectId: string;
  datasetId: string;
  /** The asking org: its cache entries, its concurrency slots, its warehouse identity. */
  org: string;
  /** The connection the statements go through: what the org's usage is counted against (L2.7). */
  connectionId: string;
  live: LiveSettings;
  columns: LiveColumn[];
  dialect: LiveDialectId;
  source: LiveSource;
  /** `env.base` holds the dataset's base filters, adapted (./liveBase) — unless the caller asked to skip them. */
  env: CompileEnv;
  /** The stored base filters (data/liveBaseFilters), for a caller that adapts them itself (the schema sync, against new columns). */
  baseFilters: FilterStep[];
  def: ConnectorDef;
  values: Record<string, unknown>;
  /** The connection's secrets, loaded once, on the first warehouse call. */
  secrets(): Promise<Record<string, string>>;
}

/** Why there is nothing to ask: no such (Live) dataset, no connection, or a source live cannot name. */
export type TargetProblem =
  | { ok: false; kind: 'unavailable'; error: string; dialect?: LiveDialectId }
  | { ok: false; kind: 'refused'; refusal: LiveRefusal; dialect?: LiveDialectId };

/**
 * Where a Live dataset's rows are, as the compiler names them. The defining
 * query wins over a table, as a refresh re-runs it (ipc/liveDatasets
 * selectionOf). A table name is held to the extract's own whitelist
 * (connectionRun.quotedTable) and split into parts the dialect quotes one by
 * one; a BigQuery path by its own validator. Null when neither is usable.
 */
export function liveSourceOf(origin: { sql?: unknown; table?: unknown }, def: ConnectorDef, dialect: LiveDialectId): LiveSource | null {
  const sql = typeof origin.sql === 'string' ? origin.sql : '';
  if (sql.trim()) return { kind: 'sql', sql };
  const table = typeof origin.table === 'string' ? origin.table.trim() : '';
  if (!table) return null;
  if (dialect === 'bigquery') {
    const p = parseTablePath(table);
    return p ? { kind: 'table', parts: [p.project, p.dataset, p.table].filter((x): x is string => !!x) } : null;
  }
  return quotedTable(def.family, table) === null ? null : { kind: 'table', parts: table.split('.') };
}

/**
 * The record's columns with the warehouse's own type names, where a schema sync recorded them (L2.5): the
 * dialects that cannot safe-cast a typed value (Snowflake, Redshift) read them. A calc has none.
 */
export function typedColumns(meta: { columns: { name: string; type: LiveColumn['type'] }[]; live?: Pick<LiveSettings, 'profile'> }): LiveColumn[] {
  const sourceTypes = new Map((meta.live?.profile?.columns ?? []).map((p) => [p.name, p.sourceType]));
  return meta.columns.map((c) => {
    const sourceType = sourceTypes.get(c.name);
    return sourceType ? { name: c.name, type: c.type, sourceType } : { name: c.name, type: c.type };
  });
}

/**
 * Everything one Live question needs, or why it cannot be asked. The dataset's base filters are
 * adapted here, once, into `env.base` — a step that cannot be applied refuses the question
 * (`baseFilter`), never skips. `base: 'skip'` leaves them to the caller: the schema sync adapts them
 * against the columns it has just read.
 */
export async function liveTarget(projectId: string, datasetId: string, opts: { base?: 'skip' } = {}): Promise<{ ok: true; target: LiveTarget } | TargetProblem> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, kind: 'unavailable', error: msg.liveDatasetMissing() };
  if (!isLive(meta) || !meta.live) return { ok: false, kind: 'unavailable', error: msg.liveNotLive() };
  // b0: a dataset that asks another tool's semantic layer (part 7) has no table or SQL here: refused first, before base filters and calcs.
  if (meta.live.semanticPending) return { ok: false, kind: 'refused', refusal: refuse('semanticPending') };
  // 00a: a stored list of calculated fields this pod cannot read in full answers nothing: a calc it dropped would read as an unknown column.
  if (meta.live.calculatedUnreadable) return { ok: false, kind: 'refused', refusal: refuse('calculatedUnreadable', meta.live.calculated?.[0]?.name) };
  const origin = meta.origin;
  if (!origin || origin.kind !== 'connection') return { ok: false, kind: 'refused', refusal: refuse('badSource') };
  const conn = await connections.getConnection(projectId, origin.connId);
  if (!conn) return { ok: false, kind: 'unavailable', error: liveMsg.liveConnectionGoneMessage() };
  const def = getConnector(conn.connectorId);
  // Asked on EVERY question, not only at create: a connection that loses its
  // read-replica opt-in (L3.2) stops being asked at once, whatever its datasets say.
  const refusal = liveOfferRefusal(def, conn.values);
  if (refusal || !def || !def.live) return { ok: false, kind: 'unavailable', error: refusal ?? liveMsg.liveNotOfferedMessage() };
  const dialect = def.live.dialect;
  const found = liveSourceOf(origin, def, dialect);
  if (!found) return { ok: false, kind: 'refused', refusal: refuse('badSource'), dialect };
  // The calcs travel with the source, so they are in every cache key; none: today's source, today's key.
  const source: LiveSource = meta.live.calculated?.length ? { ...found, calcs: meta.live.calculated } : found;
  const columns = typedColumns(meta);
  const env: CompileEnv = { dialect, source, columns };
  if (opts.base !== 'skip') {
    // Over the declared columns: a base filter sits innermost, before any calc exists, so one naming a calc refuses.
    const b = baseOfLive(meta.live, declaredColumns({ columns, live: meta.live }));
    if (!b.ok) return { ok: false, kind: 'refused', refusal: b, dialect };
    if (b.base.length) env.base = b.base;
  }
  let secrets: Promise<Record<string, string>> | null = null;
  return {
    ok: true,
    target: {
      projectId,
      datasetId,
      org: ctx().org.id,
      connectionId: conn.id,
      live: meta.live,
      columns,
      dialect,
      source,
      env,
      baseFilters: meta.live.baseFilters ?? [],
      def,
      values: conn.values,
      secrets: () => (secrets ??= loadSecrets(conn.id, def)),
    },
  };
}
