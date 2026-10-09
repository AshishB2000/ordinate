// Figures that follow their data (docs/live-data/00-plan.md, L0.1): when the
// server says a dataset has new rows (`hub:dataset-refreshed` — every refresh
// door, every pod, src/data/refreshEvents.ts), every query that reads that
// dataset is invalidated, so an open dashboard redraws without a reload.
//
// Mounted ONCE, in the app shell. TanStack refetches only the queries a screen
// is showing (active observers); the rest are marked stale and re-read when
// next shown — so a refresh costs the open page one batch per kind
// (`analysis:tiles`, `visual:dataBatch`), not one call per tile, and the RPC
// budget holds.
//
// Debounced per dataset (500 ms): a refresh that re-runs SQL datasets
// downstream (data/datasetDependents) announces each of them, and a burst of
// one dataset's events is one invalidation.
//
// After a dropped event stream (`onReconnect`) every figure query is
// invalidated: events sent while it was down are gone. Only figure queries —
// NOT every query: an open editor's own document (`analysis:open`,
// `prepare:get`, staleTime Infinity) must not be re-read under the person
// editing it.

import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { onReconnect, subscribe } from './events';

export const REFRESHED_CHANNEL = 'hub:dataset-refreshed';
export const DEBOUNCE_MS = 500;

/** Which dataset moved (src/data/refreshEvents.ts `Refreshed`; a scheduled failure carries `ok: false`). */
export interface Refreshed {
  projectId: string;
  datasetId: string;
  ok: boolean;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
/** A request object (`{ projectId, datasetId, … }`) that reads this dataset. */
const reqReads = (v: unknown, r: Refreshed): boolean => isRec(v) && v.projectId === r.projectId && v.datasetId === r.datasetId;
const sameProject = (k: QueryKey, r: Refreshed): boolean => k[1] === r.projectId;
const sameDataset = (k: QueryKey, r: Refreshed): boolean => k[1] === r.projectId && k[2] === r.datasetId;

/**
 * Every query that draws a figure from a dataset, by its key's first element,
 * and whether it reads THIS one. The keys are the hooks' own (web/src/api,
 * web/src/features/*): a hook that changes its key shape changes it here, and
 * freshness.test.ts holds each one to its real key.
 *
 * Where a key does not name the dataset (a metric's ids, a gallery's visual
 * ids, a summary of a whole sheet), the whole project's entries go — still only
 * the ones on screen are refetched.
 */
export const READS: Readonly<Record<string, (k: QueryKey, r: Refreshed) => boolean>> = {
  // ['visual:data', req] (web/src/api/visuals.ts) · ['visual:data', projectId, datasetId, encoding] (NewVisualDialog)
  'visual:data': (k, r) => reqReads(k[1], r) || sameDataset(k, r),
  // ['visual:preview', req] — the builder.
  'visual:preview': (k, r) => reqReads(k[1], r),
  // ['visual:thumbs', projectId, visualId, updatedAt] — the gallery.
  'visual:thumbs': sameProject,
  // ['analysis:tile', projectId, params, scope, req] — every dashboard tile; a stats tile names it in its spec.
  'analysis:tile': (k, r) => sameProject(k, r) && isRec(k[4]) && (k[4].datasetId === r.datasetId || (isRec(k[4].spec) && k[4].spec.datasetId === r.datasetId)),
  // ['metric:values', projectId, ids, filters, params]
  'metric:values': sameProject,
  // ['summary:compute', req] — the Summary card, over a whole sheet.
  'summary:compute': (k, r) => isRec(k[1]) && k[1].projectId === r.projectId,
  // ['dashboard:asOfStamps', projectId, datasetIds, metricIds] — snapshot times and the sheet's freshness.
  'dashboard:asOfStamps': (k, r) => sameProject(k, r) && ((Array.isArray(k[2]) && k[2].includes(r.datasetId)) || (Array.isArray(k[3]) && k[3].length > 0)),
  // ['answer:card', projectId, JSON.stringify(spec)] — an answer in the Assistant.
  'answer:card': (k, r) => sameProject(k, r) && typeof k[2] === 'string' && specReads(k[2], r.datasetId),
  // The dataset's own reads: the list's row counts and freshness, its header, stats and source.
  'dataset:list': sameProject,
  'dataset:columns': sameDataset,
  'dataset:stats': sameDataset,
  'dataset:source': sameDataset,
  'dataset:profile': sameDataset,
  'dataset:distinct': sameDataset,
};

function specReads(json: string, datasetId: string): boolean {
  try {
    const spec: unknown = JSON.parse(json);
    return isRec(spec) && spec.datasetId === datasetId;
  } catch {
    return false;
  }
}

/** A failed refresh moved no rows: only the list's status dot is news. */
const ON_FAILURE = new Set(['dataset:list']);

/** Does the query under `key` read the dataset `r` names? PURE. */
export function readsDataset(key: QueryKey, r: Refreshed): boolean {
  const head = key[0];
  if (typeof head !== 'string' || !Object.hasOwn(READS, head)) return false;
  if (!r.ok && !ON_FAILURE.has(head)) return false;
  return READS[head](key, r);
}

/** Is this a query that draws a figure from data — what a reconnect re-reads? PURE. */
export function isFigureQuery(key: QueryKey): boolean {
  return typeof key[0] === 'string' && Object.hasOwn(READS, key[0]);
}

/** The event's payload, checked — a frame that does not name a project and a dataset is ignored. */
export function refreshedOf(p: unknown): Refreshed | null {
  if (!isRec(p) || typeof p.projectId !== 'string' || typeof p.datasetId !== 'string' || !p.projectId || !p.datasetId) return null;
  return { projectId: p.projectId, datasetId: p.datasetId, ok: p.ok !== false };
}

/** Keeps every figure on screen in step with its data. Mount once (the app shell). */
export function useDatasetFreshness(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const pending = new Map<string, { r: Refreshed; timer: ReturnType<typeof setTimeout> }>();
    const offEvent = subscribe(REFRESHED_CHANNEL, (p) => {
      const got = refreshedOf(p);
      if (!got) return;
      const k = `${got.projectId}\n${got.datasetId}`;
      const prev = pending.get(k);
      clearTimeout(prev?.timer);
      // A success anywhere in the window wins over a failure: it is the wider invalidation.
      const r = prev && prev.r.ok ? prev.r : got;
      const timer = setTimeout(() => {
        pending.delete(k);
        void qc.invalidateQueries({ predicate: (q) => readsDataset(q.queryKey, r) });
      }, DEBOUNCE_MS);
      pending.set(k, { r, timer });
    });
    const offReconnect = onReconnect(() => void qc.invalidateQueries({ predicate: (q) => isFigureQuery(q.queryKey) }));
    return () => {
      offEvent();
      offReconnect();
      for (const { timer } of pending.values()) clearTimeout(timer);
    };
  }, [qc]);
}
