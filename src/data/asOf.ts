// "As of" — read the datasets as they were at a past time. MAIN PROCESS ONLY.
//
// A dashboard or a chart can be viewed against a chosen snapshot time. That is
// VIEW STATE: it arrives as an `asOf` field on the ordinary read requests
// (visual:data, metric:value, dashboard:metric), is never stored, and changes
// nothing on disk.
//
// HOW. A read handler runs inside `withAsOf(projectId, asOf, fn)`, which opens an
// AsyncLocalStorage scope for the duration of that one request. The three
// dataset reads everything bottoms out in — datasets.getDatasetMeta,
// residentSource and getDataset — ask `metaHook`/`residentHook`/`datasetHook`
// first; inside a scope each dataset is resolved by snapshotNames.pickAsOf and
// answered from its snapshot file instead. So every path a figure can take —
// the resident fast path, the JS fallback, a join through a relationship, a
// parameter replay — reads the same past, without a parameter threaded through
// forty signatures. The answer cache keys on the scope's time too
// (answerKey.ambient), so an as-of answer can never be served as a latest one.
//
// NO DATA. A dataset that had no data yet at that time resolves to 'none': its
// reads return null, and `withAsOf` answers the whole request with
// "No data as of <time>" rather than a figure — never silently the latest.
//
// A WRITE inside a scope is refused (datasets.persist calls assertWritable): an
// as-of read hydrates snapshot rows, and persisting those as the current table
// would be data loss dressed as a read.

import { AsyncLocalStorage } from 'async_hooks';
import { isValidId } from '../app/ids';
import * as datasets from './datasets'; // call-time only — datasets.ts imports this file
import type { Dataset, DatasetMeta } from './datasets';
import * as snapshots from './snapshots';
import type { SnapshotInfo } from './snapshots';
import { pickAsOf } from './snapshotNames';
import * as parquetStore from '../engine/parquetStore';

type Resolved =
  | { kind: 'current' }
  | { kind: 'none' }
  | { kind: 'snapshot'; meta: DatasetMeta; snap: SnapshotInfo };

interface Scope {
  projectId: string;
  at: number;
  iso: string;
  picks: Map<string, Promise<Resolved>>;
  missing: Set<string>;
}

const als = new AsyncLocalStorage<Scope>();

export interface AsOfMissing {
  ok: false;
  error: string;
  /** The ISO time nothing existed at. */
  asOfMissing: string;
}

/** The scope's time, or undefined outside one — part of every answer-cache key. */
export function asOfIso(): string | undefined {
  const s = als.getStore();
  return s ? s.iso : undefined;
}

export function assertWritable(): void {
  if (als.getStore()) throw new Error('A dataset write inside an as-of read was refused.');
}

/** "Sep 26, 2026, 9:44 PM" — the time as the note under a card says it. */
export function asOfLabel(at: number): string {
  return new Date(at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function resolveNow(scope: Scope, projectId: string, id: string): Promise<Resolved> {
  // Outside the scope (als.exit): this is the one read that must see the present.
  const cur = await datasets.getDatasetMeta(projectId, id);
  if (!cur) return { kind: 'current' }; // gone: the ordinary path reports it
  const list = await snapshots.list(projectId, id);
  const pick = pickAsOf(list.map((s) => s.stamp), Date.parse(cur.lastRefreshedAt || cur.updatedAt), scope.at);
  if (pick.kind !== 'snapshot') return pick;
  const snap = list.find((s) => s.stamp === pick.stamp) as SnapshotInfo;
  const meta: DatasetMeta = {
    ...cur, columns: snap.columns, rowCount: snap.rowCount,
    updatedAt: snap.at, lastRefreshedAt: snap.at, resident: true,
  };
  delete meta.sourceColumns;
  if (snap.sourceColumns) meta.sourceColumns = snap.sourceColumns;
  return { kind: 'snapshot', meta, snap };
}

async function resolve(projectId: string, id: string): Promise<{ scope: Scope; r: Resolved } | null> {
  const scope = als.getStore();
  if (!scope || scope.projectId !== projectId) return null;
  let p = scope.picks.get(id);
  if (!p) {
    p = als.exit(() => resolveNow(scope, projectId, id));
    scope.picks.set(id, p);
  }
  const r = await p;
  if (r.kind === 'none') scope.missing.add(id);
  return { scope, r };
}

// ── The three hooks datasets.ts asks first. `undefined` = read the present. ──

export async function metaHook(projectId: string, id: string): Promise<DatasetMeta | null | undefined> {
  const x = await resolve(projectId, id);
  if (!x || x.r.kind === 'current') return undefined;
  return x.r.kind === 'none' ? null : structuredClone(x.r.meta);
}

export async function residentHook(
  projectId: string,
  id: string,
): Promise<{ parquetPath: string; columns: DatasetMeta['columns'] } | null | undefined> {
  const x = await resolve(projectId, id);
  if (!x || x.r.kind === 'current') return undefined;
  if (x.r.kind === 'none' || !parquetStore.isSupported()) return null;
  return { parquetPath: x.r.snap.parquetPath, columns: structuredClone(x.r.snap.columns) };
}

export async function datasetHook(projectId: string, id: string): Promise<Dataset | null | undefined> {
  const x = await resolve(projectId, id);
  if (!x || x.r.kind === 'current') return undefined;
  if (x.r.kind === 'none') return null;
  const { meta, snap } = x.r;
  const table = await parquetStore.readTableAsync(snap.parquetPath, snap.columns);
  if (!table) return null;
  const { resident: _r, sourceColumns: _s, ...rest } = structuredClone(meta);
  const ds: Dataset = { ...rest, columns: table.columns, rows: table.rows, rowCount: table.rows.length, schemaVersion: 2 };
  if (snap.sourcePath && snap.sourceColumns) {
    const src = await parquetStore.readTableAsync(snap.sourcePath, snap.sourceColumns);
    if (!src) return null;
    ds.source = { columns: src.columns, rows: src.rows };
  }
  return ds;
}

// ── Running a read as of a time ──────────────────────────────────────────────

/** Run `fn` with every dataset read as of `at` (ms). `missing` = something had no data yet. */
export async function runAsOf<T>(projectId: string, at: number, fn: () => Promise<T>): Promise<{ value: T; missing: boolean }> {
  const scope: Scope = { projectId, at, iso: new Date(at).toISOString(), picks: new Map(), missing: new Set() };
  const value = await als.run(scope, fn);
  return { value, missing: scope.missing.size > 0 };
}

/**
 * The request wrapper the read handlers use. No `asOf` (or an empty one) is the
 * ordinary latest read, untouched. A time is validated here, at the boundary.
 */
export async function withAsOf<T>(projectId: unknown, asOf: unknown, fn: () => Promise<T>): Promise<T | AsOfMissing | { ok: false; error: string }> {
  if (asOf === undefined || asOf === null || asOf === '') return fn();
  const at = typeof asOf === 'string' ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(at)) return { ok: false, error: 'That "as of" time could not be read.' };
  if (!isValidId(projectId)) return fn(); // no project: nothing to resolve, the handler reports it
  const r = await runAsOf(projectId, at, fn);
  if (!r.missing) return r.value;
  return { ok: false, error: `No data as of ${asOfLabel(at)}`, asOfMissing: new Date(at).toISOString() };
}
