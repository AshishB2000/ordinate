// Incremental refresh settings over IPC — MAIN PROCESS.
//
// The dataset page's "Incremental refresh" panel reads and writes one dataset's
// `incremental` block here. The refresh itself is NOT here: it runs through the
// ordinary refresh (datasetRefresh → incrementalRefresh), so "Full refresh now"
// only flags the next run as full and the renderer then clicks ↻ as usual.
//
// Everything a renderer sends is validated against the stored record: the
// cursor must be a number or date column of the stored table, the key one of
// its columns, the lookback a finite non-negative number.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as connections from '../connectors/connections';
import { getConnector } from '../connectors';
import { WATCHABLE } from '../connectors/folderWatch';
import { canPush } from '../connectors/incrementalSql';
import * as inc from '../data/incremental';
import type { IncrementalSettings } from '../data/incremental';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LOOKBACK = 1e12;

type View =
  | { ok: false; error: string }
  | { ok: true; eligible: false }
  | {
    ok: true;
    eligible: true;
    settings: IncrementalSettings | null;
    cursorColumns: { name: string; type: 'number' | 'date' }[];
    keyColumns: string[];
    /** How an incremental run fetches from this source. */
    fetch: 'server' | 'files' | 'after';
    source: string;
    fullEvery: number;
  };

/** What the panel shows for one dataset. Exported for the smoke. */
export async function incrementalView(projectId: string, datasetId: string): Promise<View> {
  if (!UUID_RE.test(String(projectId)) || !UUID_RE.test(String(datasetId))) return { ok: false, error: 'Dataset not found' };
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  if (!meta.origin || meta.origin.kind !== 'connection') return { ok: true, eligible: false };
  const columns = meta.sourceColumns ?? meta.columns;
  const conn = await connections.getConnection(projectId, meta.origin.connId);
  const def = conn ? getConnector(conn.connectorId) : null;
  return {
    ok: true,
    eligible: true,
    settings: meta.incremental ?? null,
    cursorColumns: columns.filter((c) => inc.isCursorType(c.type)).map((c) => ({ name: c.name, type: c.type as 'number' | 'date' })),
    keyColumns: columns.map((c) => c.name),
    fetch: conn && WATCHABLE[conn.connectorId] ? 'files' : def && canPush(def.family) ? 'server' : 'after',
    source: def ? def.label : 'the connection',
    fullEvery: inc.FULL_EVERY,
  };
}

async function save(projectId: string, datasetId: string, raw: Record<string, unknown>): Promise<View> {
  const view = await incrementalView(projectId, datasetId);
  if (!view.ok || !view.eligible) return view.ok ? { ok: false, error: 'Only a connection or folder dataset can refresh incrementally.' } : view;
  const cursorColumn = typeof raw.cursorColumn === 'string' ? raw.cursorColumn : '';
  if (!view.cursorColumns.some((c) => c.name === cursorColumn)) return { ok: false, error: 'Pick a number or date column as the cursor.' };
  const keyColumn = typeof raw.keyColumn === 'string' ? raw.keyColumn : '';
  if (keyColumn && !view.keyColumns.includes(keyColumn)) return { ok: false, error: 'That key column is not in this dataset.' };
  const lookback = Number(raw.lookback ?? 0);
  if (!Number.isFinite(lookback) || lookback < 0 || lookback > MAX_LOOKBACK) return { ok: false, error: 'The lookback must be zero or more.' };
  const written = await datasets.writeIncremental(projectId, datasetId, (cur) => {
    const next: IncrementalSettings = cur ? { ...cur } : { enabled: false, cursorColumn, lookback: 0, highWater: null, runsSinceFull: 0, log: [] };
    // A new cursor makes the old mark meaningless: the next run is full.
    if (next.cursorColumn !== cursorColumn) {
      next.highWater = null;
      next.runsSinceFull = 0;
    }
    next.enabled = raw.enabled === true;
    next.cursorColumn = cursorColumn;
    next.lookback = lookback;
    if (keyColumn) next.keyColumn = keyColumn;
    else delete next.keyColumn;
    return next;
  });
  return written === false ? { ok: false, error: 'Could not save the settings.' } : incrementalView(projectId, datasetId);
}

export function register(): void {
  ipcMain.handle('incremental:get', async (_e, { projectId, datasetId }: { projectId?: string; datasetId?: string } = {}) => {
    try {
      return await incrementalView(String(projectId), String(datasetId));
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read the settings' };
    }
  });

  ipcMain.handle('incremental:set', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await save(String(payload.projectId), String(payload.datasetId), payload);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save the settings' };
    }
  });

  // Flag the NEXT run as full; the renderer then runs the ordinary refresh.
  ipcMain.handle('incremental:requestFull', async (_e, { projectId, datasetId }: { projectId?: string; datasetId?: string } = {}) => {
    try {
      const view = await incrementalView(String(projectId), String(datasetId));
      if (!view.ok || !view.eligible || !view.settings || !view.settings.enabled) {
        return { ok: false, error: 'Turn on incremental refresh first.' };
      }
      const w = await datasets.writeIncremental(String(projectId), String(datasetId), (cur) => cur && { ...cur, fullNext: true });
      return w === false ? { ok: false, error: 'Could not flag a full refresh.' } : { ok: true };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not flag a full refresh' };
    }
  });
}
