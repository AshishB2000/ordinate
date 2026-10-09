// How fresh a figure is (docs/live-data/00-plan.md, L0.2) — MAIN PROCESS.
//
// Every chart, KPI and answer reply carries `asOf` (src/api/asOf.ts): when the
// rows under the figure are from. For a copied (extract) dataset that is its
// last SUCCESSFUL refresh — markRefresh moves `lastRefreshedAt` only on a
// success, so a source that keeps failing goes on saying how old its data
// really is. Live datasets (L2) will answer with the time the warehouse did.
//
// A figure read from several datasets (a join, a formula metric) is only as
// fresh as its STALEST input, so the oldest time wins.
//
// Stamped on the reply OUTSIDE the answer cache (engine/queryCache), never
// cached with the figure: a refresh writes the new table first and the
// markers after it (datasetRefresh.refreshLocked), so an answer cached in
// between would keep the old time for as long as it stayed cached. It costs
// one metadata read per dataset — no rows.
//
// Inside an as-of read (./asOf.ts) the metadata IS the snapshot's, so a sheet
// viewed "as of" a past time is dated with that time.

import type { AsOf } from '../api/asOf';
import * as datasets from './datasets';
import type { DatasetMeta } from './datasets';

type Stamps = Pick<DatasetMeta, 'lastRefreshedAt' | 'createdAt' | 'updatedAt' | 'sourceKind'>;

/** A stored time as canonical ISO, or null when it does not parse. */
function iso(v: unknown): string | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * When a dataset's rows are from — PURE. The last refresh; with none (a paste,
 * a file imported once), when the rows were saved: `createdAt`, because a
 * rename or a prepare edit bumps `updatedAt` without the data being any newer
 * (the reason `lastRefreshedAt` exists, datasets.ts). An input table and a
 * capture are edited in place — the stored table IS the source — so for them
 * the last edit is the honest time.
 */
export function dataAt(meta: Stamps): string | null {
  const refreshed = iso(meta.lastRefreshedAt);
  if (refreshed) return refreshed;
  if (meta.sourceKind === 'input' || meta.sourceKind === 'capture') return iso(meta.updatedAt) ?? iso(meta.createdAt);
  return iso(meta.createdAt) ?? iso(meta.updatedAt);
}

/** The `asOf` of a figure computed from these datasets' metadata — PURE; the oldest wins. */
export function asOfFrom(metas: ReadonlyArray<Stamps | null | undefined>): AsOf | undefined {
  let oldest: string | null = null;
  for (const m of metas) {
    const at = m ? dataAt(m) : null;
    if (at && (oldest === null || at < oldest)) oldest = at;
  }
  return oldest ? { at: oldest, mode: 'extract' } : undefined;
}

/** The `asOf` of a figure read from these datasets (ids; blanks and repeats ignored). */
export async function figureAsOf(projectId: string, datasetIds: ReadonlyArray<string | undefined>): Promise<AsOf | undefined> {
  const ids = [...new Set(datasetIds.filter((d): d is string => typeof d === 'string' && d !== ''))];
  if (!ids.length) return undefined;
  return asOfFrom(await Promise.all(ids.map((id) => datasets.getDatasetMeta(projectId, id).catch(() => null))));
}

/**
 * A successful reply with its `asOf` stamped on; a refusal goes back untouched.
 * A dataset with no readable time leaves the reply as it was rather than
 * inventing one.
 */
export async function stampAsOf<R extends { ok: boolean }>(reply: R, projectId: string, datasetIds: ReadonlyArray<string | undefined>): Promise<R | (R & { asOf: AsOf })> {
  if (!reply || reply.ok !== true) return reply;
  const asOf = await figureAsOf(projectId, datasetIds);
  return asOf ? { ...reply, asOf } : reply;
}

/**
 * "Oct 9, 2026, 1:00 AM UTC" — the time as the AI facts state it (src/ai/answerFacts).
 * UTC and labelled, because the server does not know the reader's time zone and
 * a model must not convert one; the browser's caption shows local time.
 */
export function utcLabel(at: string): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  }).replace(/[\u202f\u00a0]/g, ' ') + ' UTC'; // newer ICU puts a narrow no-break space before "AM"
}
