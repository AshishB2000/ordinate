import { ipcMain } from 'electron';
import * as datasets from '../data/datasets';
import * as projects from '../app/projects';
import { detectAnomalies } from '../analysis/anomalies';
import { detectAnomaliesResident } from '../engine/anomaliesResident';
import { detectInsights, fromAnomaly, jsAgg, rankInsights, residentAgg } from '../analysis/insights';
import type { Insight } from '../analysis/insights';
import * as trace from '../engine/residentTrace';

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

/**
 * Per-dataset cache, keyed on the dataset's own `updatedAt` — so opening Home
 * twice costs one scan, and a refresh or a prepare step invalidates it by
 * moving the key. Process-lifetime and unbounded by design: one entry per
 * dataset the user actually opened, each a handful of short strings.
 */
const cache = new Map<string, { key: string; insights: Insight[] }>();

/** Test hook (scripts/test-insights.ts). Not called by product code. */
export function clearCache(): void {
  cache.clear();
}

/**
 * Everything the app found in ONE dataset, ranked and capped. Dismissals are
 * NOT applied here — the cache holds the full set so dismissing one card does
 * not invalidate the scan.
 *
 * Resident fast path first, JS reference as the fallback, for both halves: the
 * three new rules share one aggregator (`insights.Agg`) and the five anomaly
 * kinds keep the pairing `anomalies` / `anomaliesResident` already ships.
 * Returns [] for a missing dataset — never throws.
 */
export async function insightsForDataset(projectId: string, datasetId: string): Promise<Insight[]> {
  try {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) return [];
    const cacheKey = projectId + ':' + datasetId;
    const hit = cache.get(cacheKey);
    if (hit && hit.key === meta.updatedAt) return hit.insights;

    let found: Insight[] | null = null;
    const src = await datasets.residentSource(projectId, datasetId);
    if (src) {
      const anomalies = detectAnomaliesResident(src);
      if (anomalies) {
        trace.record('insights', 'resident');
        found = [
          ...detectInsights(datasetId, src.columns, residentAgg(src)),
          // `fromAnomaly` returns null for a finding that is true but useless
          // as a card (a change off a near-zero base) — the anomaly itself is
          // untouched for the watch and explain paths.
          ...anomalies.map((a) => fromAnomaly(datasetId, a, src.columns)).filter((i): i is Insight => !!i),
        ];
      } else {
        trace.record('insights', 'failed', `${src.columns.length} column(s)`);
      }
    } else {
      trace.record('insights', 'skipped');
    }

    if (!found) {
      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return [];
      found = [
        ...detectInsights(datasetId, ds.columns, jsAgg(ds.columns, ds.rows)),
        ...detectAnomalies(ds.columns, ds.rows)
          .map((a) => fromAnomaly(datasetId, a, ds.columns))
          .filter((i): i is Insight => !!i),
      ];
    }

    const ranked = rankInsights(found);
    cache.set(cacheKey, { key: meta.updatedAt, insights: ranked });
    return ranked;
  } catch (_) {
    return [];
  }
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
