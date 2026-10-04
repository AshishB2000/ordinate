import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as projects from '../app/projects';
import { detectAnomalies } from '../analysis/anomalies';
import { detectAnomaliesResident } from '../engine/anomaliesResident';
import { detectInsights, fromAnomaly, jsAgg, rankInsights, residentAgg } from '../analysis/insights';
import type { Insight } from '../analysis/insights';
import * as trace from '../engine/residentTrace';
import * as queryCache from '../engine/queryCache';
import * as computePool from '../engine/computePool';
import * as answerKey from '../data/answerKey';
import * as jobs from '../app/jobs';
import type { ParsedColumn } from '../data/parse';
import { attributeInsights } from '../analysis/events'; // r8:events
import { projectEvents } from '../analysis/eventStore';
import { vizDataFor } from './visuals';
import { sanitizeEncoding, sanitizeFilters } from '../analysis/visuals';

// Insights IPC — two channels, both request/response, both wrapped so a throw
// becomes { ok:false, error }.
//
//   insights:list     what the app found, per dataset, dismissals removed
//   insights:dismiss  hide one (or bring it back) for this project
//
// `register()` takes no deps: this is pure disk + the resident query layer, the
// same as `datasets.register()` / `recent.register()`. There is nothing to
// inject, so there is no deps object to invent.
//
// NO MODEL IS INVOLVED. Everything here is computed by the app; the dock may
// later narrate these figures (src/ipc/copilot.ts feeds them in as FACTS).

/**
 * Datasets scanned for one `insights:list` over a whole project, newest first.
 * Home shows six cards; scanning a fifty-dataset project to rank them would be
 * the slowest thing on the page.
 */
const MAX_DATASETS = 8;

/** Test hook (scripts/test-insights.ts). Not called by product code. */
export function clearCache(): void {
  queryCache.clear();
}

/**
 * Rows above which a recompute is a JOB (the Jobs popover shows it, it runs in
 * a compute worker, it can be cancelled). Below it the scan is tens of
 * milliseconds and a job row per dataset would be noise on Home.
 */
const JOB_MIN_ROWS = 100_000;

/**
 * Everything the app found in ONE dataset, ranked and capped. Dismissals are
 * NOT applied here — the cache holds the full set so dismissing one card does
 * not invalidate the scan.
 *
 * Cached in the answer cache (engine/queryCache, op `insights`) on the
 * dataset's updatedAt + pipeline, so opening Home twice costs one scan and a
 * refresh or a prepare step invalidates it. Resident first — in a compute
 * worker, off the main thread — and the JS reference as the fallback.
 * Returns [] for a missing dataset — never throws.
 */
export async function insightsForDataset(projectId: string, datasetId: string): Promise<Insight[]> {
  try {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) return [];
    const parts = await answerKey.keyParts(projectId, datasetId);
    if (!parts) return [];
    const key = queryCache.cacheKey('insights', parts, answerKey.ambient());
    // The project's events are matched AFTER the cache, on a copy: an event
    // edit must not wait for the data to change to be named. r8:events
    const named = (list: Insight[]): Promise<Insight[]> => projectEvents(projectId).then((evs) => attributeInsights(list, evs));
    return await named(await queryCache.through('insights', key, [datasetId, queryCache.projectDep(projectId)], async () => {
      if (meta.rowCount < JOB_MIN_ROWS) return scan(projectId, datasetId);
      const job = jobs.submit({
        kind: 'insights',
        label: `Insights · ${meta.name}`,
        projectId,
        datasetId,
        run: (ctx) => scan(projectId, datasetId, ctx.signal),
        resultOf: (list) => ({ message: `${list.length} finding${list.length === 1 ? '' : 's'}` }),
      });
      return job.done;
    }));
  } catch (_) {
    return [];
  }
}

async function scan(projectId: string, datasetId: string, signal?: AbortSignal): Promise<Insight[]> {
  let found: Insight[] | null = null;
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    found = computePool.available()
      ? await computePool.run<Insight[] | null>('insights', { datasetId, src }, { signal })
      : await residentInline(datasetId, src);
    trace.record('insights', found ? 'resident' : 'failed', found ? undefined : `${src.columns.length} column(s)`);
  } else {
    trace.record('insights', 'skipped');
  }

  if (!found) {
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return [];
    found = [
      ...(await detectInsights(datasetId, ds.columns, jsAgg(ds.columns, ds.rows))),
      ...detectAnomalies(ds.columns, ds.rows)
        .map((a) => fromAnomaly(datasetId, a, ds.columns))
        .filter((i): i is Insight => !!i),
    ];
  }
  return rankInsights(found);
}

/** The worker's op, on this thread — for when worker threads are off. */
async function residentInline(datasetId: string, src: { parquetPath: string; columns: ParsedColumn[] }): Promise<Insight[] | null> {
  const anomalies = await detectAnomaliesResident(src);
  if (!anomalies) return null;
  return [
    ...(await detectInsights(datasetId, src.columns, residentAgg(src))),
    // `fromAnomaly` returns null for a finding that is true but useless as a
    // card (a change off a near-zero base) — the anomaly itself is untouched
    // for the watch and explain paths.
    ...anomalies.map((a) => fromAnomaly(datasetId, a, src.columns)).filter((i): i is Insight => !!i),
  ];
}

/** The project's dismissed-id set, or an empty one for a missing project. */
async function dismissedSet(projectId: string): Promise<Set<string>> {
  const proj = await projects.getProject(projectId);
  return new Set(proj?.dismissedInsights || []);
}

/**
 * One dataset's insights, or every dataset's when `datasetId` is omitted.
 * Exported for `ipc/copilot.ts` (the dock's FACTS) and for the smoke test.
 */
export async function listInsights(projectId: string, datasetId?: string): Promise<Insight[]> {
  const dismissed = await dismissedSet(projectId);
  const ids: string[] = datasetId
    ? [datasetId]
    : (await datasets.listDatasets(projectId)).slice(0, MAX_DATASETS).map((d) => d.id);

  const out: Insight[] = [];
  for (const id of ids) {
    for (const i of await insightsForDataset(projectId, id)) {
      if (!dismissed.has(i.id)) out.push(i);
    }
  }
  // Per-dataset lists are already ranked and capped; re-rank so a cross-dataset
  // Home row leads with the strongest finding in the whole project.
  return datasetId ? out : rankInsights(out, MAX_DATASETS * 2);
}

/** A card's sparkline: the insight's own chart, computed by the same function a tile uses. */
export interface Spark extends Record<string, unknown> {
  labels: unknown[];
  series: unknown[];
}

/** Rows above which Home draws no sparkline rather than hydrate a table without a resident fast path. */
const SPARK_MAX_HYDRATE = 250_000;

/**
 * Home's "What stands out" (T2.11, insights.ts insRenderHome): the project's
 * strongest findings that have a chart, at most `max`, each with its chart's
 * figures — one reply inside `home:overview`, so the row costs Home no round
 * trip (plan §9's RPC budget). A chart that cannot be computed gets no
 * sparkline; the card still carries its numbers.
 */
export async function standsOut(projectId: string, max = 6): Promise<Array<Insight & { spark: Spark | null }>> {
  const list = (await listInsights(projectId)).filter((i) => i.chart).slice(0, max);
  return Promise.all(list.map(async (i) => {
    let spark: Spark | null = null;
    try {
      const r = await vizDataFor(projectId, i.datasetId, sanitizeEncoding(i.chart!.encoding), sanitizeFilters(i.chart!.filters || []), { maxHydrateRows: SPARK_MAX_HYDRATE });
      // The chart's whole reply (minus event marks, which bury a 56px line), exactly what a tile draws from.
      if (r.ok) {
        const { events: _marks, ...data } = r.data as typeof r.data & { events?: unknown };
        spark = data as Spark;
      }
    } catch (_) { /* no sparkline */ }
    return { ...i, spark };
  }));
}

export function register() {
  ipcMain.handle('insights:list', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !projectId) return { ok: true, insights: [] };
      const id = typeof datasetId === 'string' && datasetId ? datasetId : undefined;
      return { ok: true, insights: await listInsights(projectId, id) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to list insights' };
    }
  });

  // `dismissed` defaults to true: the × on a card is the only caller today, and
  // the flag is what a future "show dismissed" toggle would flip.
  ipcMain.handle('insights:dismiss', async (_e, { projectId, id, dismissed }: any = {}) => {
    try {
      const list = await projects.setInsightDismissed(projectId, id, dismissed !== false);
      if (!list) return { ok: false, error: 'Project not found' };
      return { ok: true, dismissed: list };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to dismiss the insight' };
    }
  });
}
