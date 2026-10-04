// Data snapshots' calls (src/api/analyticsB.ts → src/ipc/snapshots.ts) and
// their reply shapes, mirrored from the handler (src/data/snapshotDiffJs.ts
// DiffResult for a comparison). Every count is the server's — row counts off
// the snapshot index, `delta` = current rows − snapshot rows, the diff's
// tallies and cells from DuckDB over the two Parquet files.

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';

export interface SnapshotItem {
  stamp: string;
  at: string;
  rowCount: number;
  columns: string[];
  hasSource: boolean;
  /** Current rows − this snapshot's rows, computed on the server. */
  delta: number;
}
export interface SnapshotList {
  ok: true;
  eligible: boolean;
  refreshable: boolean;
  keep: number;
  current: { at: string; rowCount: number; columns: string[] };
  items: SnapshotItem[];
}
type Fail = { ok: false; error: string };

export type Cell = string | null;
export interface Diff {
  mode: 'key' | 'row';
  key: string | null;
  columns: string[];
  addedColumns: string[];
  removedColumns: string[];
  counts: { added: number; removed: number; changed: number; unchanged: number };
  duplicates: { old: number; new: number };
  added: Array<{ values: Cell[] }>;
  removed: Array<{ values: Cell[] }>;
  changed: Array<{ key: Cell; cells: Array<{ column: string; old: Cell; new: Cell }> }>;
  limit: number;
}

async function ask<T>(p: Promise<unknown>, fallback: string): Promise<T> {
  const r = (await p) as (T & { ok: true }) | Fail | null;
  if (!r || r.ok === false) throw new Error((r && r.error) || fallback);
  return r as T;
}

export const listKey = (projectId: string, datasetId: string) => ['snapshots:list', projectId, datasetId] as const;

export function useSnapshots(projectId: string, datasetId: string) {
  return useQuery({
    queryKey: listKey(projectId, datasetId),
    queryFn: () => ask<SnapshotList>(rpc('snapshots:list', { projectId, datasetId }), 'Could not read the snapshots.'),
  });
}

export function useDiff(projectId: string, datasetId: string, stamp: string | null, key: string | null) {
  return useQuery({
    queryKey: ['snapshots:diff', projectId, datasetId, stamp, key],
    queryFn: stamp === null ? skipToken : async () => (await ask<{ diff: Diff }>(rpc('snapshots:diff', { projectId, datasetId, stamp, key }), 'Could not compare the snapshot.')).diff,
  });
}

export const setKeep = (projectId: string, datasetId: string, keep: number) =>
  ask<{ keep: number; removed: number }>(rpc('snapshots:setKeep', { projectId, datasetId, keep }), 'Could not change how many snapshots are kept.');

export const restore = (projectId: string, datasetId: string, stamp: string) =>
  ask<{ dataset: { rowCount: number } }>(rpc('snapshots:restore', { projectId, datasetId, stamp }), 'Could not restore the snapshot.');

/** The "As of" picker's times for the datasets on a page (newest first), each with the datasets that have it. */
export function useStamps(projectId: string, datasetIds: string[]) {
  return useQuery({
    queryKey: ['snapshots:stamps', projectId, datasetIds],
    queryFn: datasetIds.length
      ? async () => (await ask<{ items: Array<{ at: string; datasets: string[] }> }>(rpc('snapshots:stamps', { projectId, datasetIds, metricIds: [] }), 'Could not list the snapshot times.')).items
      : skipToken,
  });
}

/** After a restore or a retention change: the list, the picker and every read of the dataset. */
export function useSnapshotRefresh(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return () => {
    for (const k of ['snapshots:list', 'snapshots:stamps', 'snapshots:diff', 'dataset:columns', 'dataset:list', 'dataset:page']) void qc.invalidateQueries({ queryKey: [k, projectId] });
    void qc.invalidateQueries({ queryKey: listKey(projectId, datasetId) });
  };
}

const whenFmt = (seconds: boolean, withYear: boolean) =>
  new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), ...(withYear ? { year: 'numeric' } : {}) });

/** "Sep 26, 9:44 PM" — the year only when it is not this one, seconds only when asked. Formatting only. */
export function when(iso: string, seconds = false): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return whenFmt(seconds, d.getFullYear() !== new Date().getFullYear()).format(d);
}

/** Labels for a list of times: with seconds when two would otherwise read the same (snapWhenAll). */
export function whenAll(isos: string[]): string[] {
  const plain = isos.map((t) => when(t));
  return new Set(plain).size === plain.length ? plain : isos.map((t) => when(t, true));
}
