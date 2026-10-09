// A dataset's incremental refresh SETTINGS, as the web app reads and writes
// them (`incremental:get` / `incremental:set`, src/ipc/incremental.ts) — MAIN
// PROCESS. The desktop had this panel (renderer/hub/incremental.ts and
// src/ipc/incremental.ts until T8.1); this is its server port.
//
// What is stored is src/data/incremental.ts's block: the cursor column, an
// optional key column (update by key) or none (append), a lookback, the mark
// and the run log. The refresh itself is not here — it is the ordinary refresh
// (datasetRefresh → incrementalRefresh), on ↻, on a schedule, on a refresh URL
// or on ask.
//
// THE SERVER DECIDES EVERYTHING the panel offers, and re-checks all of it on a
// save against the stored record: the cursor must be a number or date column
// of the stored table (the prepare SOURCE when there is one — that is what an
// incremental run merges into), the key one of its columns, the lookback a
// finite non-negative number. Turning it ON is refused, with a catalog
// sentence, for a Live dataset, for anything not imported from a connection,
// for a connection that is gone, for a table with no number or date column,
// and for a source that cannot take the cursor predicate — an "incremental"
// run there reads the whole source and filters after the fetch, which is the
// very load the 5- and 15-minute cadences and fresh on ask are only allowed
// because incremental refresh avoids. Turning it OFF is always allowed (a
// desktop-imported record may have it on over such a source); it drops a
// 5/15-minute schedule to hourly and fresh on ask in the same write
// (datasetRecord.writeIncremental).
//
// A new cursor column makes the stored mark meaningless, so it is reset and
// the next run is full; so is the first run after turning it on.

import * as datasets from './datasets';
import * as inc from './incremental';
import type { Cell, IncrementalLogEntry, IncrementalSettings } from './incremental';
import { fullReason } from './incrementalRefresh';
import { isLive } from './liveDataset';
import * as connections from '../connectors/connections';
import { getConnector } from '../connectors';
import { canPush } from '../connectors/incrementalSql';
import { isValidId } from '../app/ids';
import {
  incrementalAppendNoKey, incrementalCannotPush, incrementalConnectionGone, incrementalNeedsConnection, incrementalNoCursorColumn,
  incrementalLookbackRange, incrementalNotForLive, incrementalNotRead, incrementalNotSaved, incrementalPickCursor, incrementalPickKey,
} from './incrementalMessages';

type Refusal = { ok: false; error: string };

/** What the panel shows for one dataset. Figures (counts, marks) are the record's; the browser only formats them. */
export interface IncrementalView {
  ok: true;
  /** Why incremental refresh cannot be turned ON here (the panel then only lets it be turned off), or null. */
  blocked: string | null;
  settings: {
    enabled: boolean;
    cursorColumn: string;
    keyColumn: string | null;
    lookback: number;
    highWater: Cell;
    runsSinceFull: number;
    lastFullAt: string | null;
    lastRunAt: string | null;
  } | null;
  /** Newest first, at most inc.MAX_LOG. */
  log: IncrementalLogEntry[];
  /** The stored table's columns that can be the cursor. */
  cursorColumns: { name: string; type: 'number' | 'date' }[];
  /** Every column a key may be. */
  keyColumns: string[];
  /**
   * How a run reaches the source: the cursor pushed into its SQL, or the whole source filtered after
   * the fetch. Null when no run reads a source here: a Live dataset, one not from a connection, or
   * one whose connection is gone (`blocked` says which).
   */
  fetch: 'server' | 'after' | null;
  /** The connector's name ("PostgreSQL"), never its address; '' when the connection is gone (then `blocked` says so). */
  source: string;
  /** Every Nth run is a full one. */
  fullEvery: number;
  /** When on: why the NEXT run will be full (incrementalRefresh.fullReason), or null. */
  nextFull: string | null;
}

/** What `incremental:set` takes, after the contract's shape check. */
export interface IncrementalPatch {
  enabled: boolean;
  cursorColumn: string;
  mode: 'upsert' | 'append';
  keyColumn?: string;
  lookback: number;
}

const MAX_LOOKBACK = 1e12;

export async function incrementalView(projectId: string, datasetId: string): Promise<IncrementalView | Refusal> {
  if (!isValidId(projectId) || !isValidId(datasetId)) return { ok: false, error: incrementalNotRead() };
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: incrementalNotRead() };
  const columns = meta.sourceColumns ?? meta.columns;
  const cursorColumns = columns.filter((c) => inc.isCursorType(c.type)).map((c) => ({ name: c.name, type: c.type as 'number' | 'date' }));
  const conn = meta.origin?.kind === 'connection' ? await connections.getConnection(projectId, meta.origin.connId) : null;
  const def = conn ? getConnector(conn.connectorId) : null;
  const fetch: IncrementalView['fetch'] = !def || isLive(meta) ? null : canPush(def.family) ? 'server' : 'after';
  const source = def ? def.label : '';
  let blocked: string | null = null;
  if (isLive(meta)) blocked = incrementalNotForLive();
  else if (meta.origin?.kind !== 'connection') blocked = incrementalNeedsConnection();
  else if (!def) blocked = incrementalConnectionGone();
  else if (!cursorColumns.length) blocked = incrementalNoCursorColumn();
  else if (fetch === 'after') blocked = incrementalCannotPush(source);
  const s = meta.incremental;
  return {
    ok: true,
    blocked,
    settings: s ? {
      enabled: s.enabled,
      cursorColumn: s.cursorColumn,
      keyColumn: s.keyColumn ?? null,
      lookback: s.lookback,
      highWater: s.highWater,
      runsSinceFull: s.runsSinceFull,
      lastFullAt: s.lastFullAt ?? null,
      lastRunAt: s.lastRunAt ?? null,
    } : null,
    log: s ? s.log : [],
    cursorColumns,
    keyColumns: columns.map((c) => c.name),
    fetch,
    source,
    fullEvery: inc.FULL_EVERY,
    nextFull: s && s.enabled ? fullReason(s, columns, meta.resident) : null,
  };
}

/** Validate a patch against the dataset as it is stored, then write it. Resolves with the new view, or the refusal. */
export async function saveIncremental(projectId: string, datasetId: string, p: IncrementalPatch): Promise<IncrementalView | Refusal> {
  const view = await incrementalView(projectId, datasetId);
  if (!view.ok) return view;
  // Live and non-connection datasets keep no incremental block at all: nothing to turn off either.
  if (view.blocked === incrementalNotForLive() || view.blocked === incrementalNeedsConnection()) return { ok: false, error: view.blocked };
  if (!p.enabled) {
    // Off is always allowed and needs no valid cursor (the stored one may name a column since gone);
    // the rest of the block and its log stay for when it is turned back on.
    if (!view.settings?.enabled) return view;
    const off = await datasets.writeIncremental(projectId, datasetId, (cur) => (cur ? { ...cur, enabled: false } : cur));
    return off === false ? { ok: false, error: incrementalNotSaved() } : incrementalView(projectId, datasetId);
  }
  if (view.blocked) return { ok: false, error: view.blocked };
  if (!view.cursorColumns.some((c) => c.name === p.cursorColumn)) return { ok: false, error: incrementalPickCursor() };
  if (p.mode === 'upsert' && (!p.keyColumn || !view.keyColumns.includes(p.keyColumn))) return { ok: false, error: incrementalPickKey() };
  if (p.mode === 'append' && p.keyColumn !== undefined) return { ok: false, error: incrementalAppendNoKey() };
  if (!Number.isFinite(p.lookback) || p.lookback < 0 || p.lookback > MAX_LOOKBACK) return { ok: false, error: incrementalLookbackRange() };
  const written = await datasets.writeIncremental(projectId, datasetId, (cur) => {
    const next: IncrementalSettings = cur
      ? { ...cur }
      : { enabled: false, cursorColumn: p.cursorColumn, lookback: 0, highWater: null, runsSinceFull: 0, log: [] };
    // A new cursor makes the old mark meaningless: the next run is full and sets a new one.
    if (next.cursorColumn !== p.cursorColumn) {
      next.highWater = null;
      next.runsSinceFull = 0;
    }
    next.enabled = true;
    next.cursorColumn = p.cursorColumn;
    next.lookback = p.lookback;
    if (p.mode === 'upsert' && p.keyColumn) next.keyColumn = p.keyColumn;
    else delete next.keyColumn;
    return next;
  });
  if (written === false) return { ok: false, error: incrementalNotSaved() };
  return incrementalView(projectId, datasetId);
}
