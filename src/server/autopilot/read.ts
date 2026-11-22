// What a run reads of one project, in the acting admin's context and across every folder (`wholeProject`: a chart on a dashboard
// in a folder the admin cannot open must still count as used, or it fails open and the chart is trashed). The result is `PlanIn`
// (./plan.ts): plain data, so the decisions are the pure function's.

import * as datasets from '../../data/datasets';
import * as visuals from '../../analysis/visuals';
import { statusFor } from '../../analysis/statusStore';
import { isLive } from '../../data/liveDataset';
import { wholeProject } from '../authz/folders';
import { addDays, type DatasetIn, type PlanIn, type Settings, type VisualIn } from './plan';
import * as store from './store';

export async function readProject(projectId: string, s: Settings, today: string): Promise<PlanIn> {
  return wholeProject(async () => {
    const cutoff = addDays(today, -s.windowDays);
    const status = statusFor(projectId);

    const vis: VisualIn[] = [];
    for (const sum of await visuals.listVisuals(projectId)) {
      const v = await visuals.getVisual(projectId, sum.id);
      if (v) vis.push({ id: v.id.toLowerCase(), name: v.name, datasetId: v.datasetId.toLowerCase(), createdAt: v.createdAt, encoding: v.encoding as never, filters: v.filters, overrides: v.overrides as never, analytics: (v.analytics ?? []) as never });
    }

    const dsets = new Map<string, DatasetIn>();
    for (const sum of await datasets.listDatasets(projectId)) {
      const m = await datasets.getDatasetMeta(projectId, sum.id);
      if (!m) continue;
      const st = await status(`dataset:${m.id}`);
      dsets.set(m.id.toLowerCase(), {
        id: m.id.toLowerCase(), name: m.name, columns: m.columns.map((c) => c.name), live: isLive(m),
        missing: [...(m.live?.missingColumns ?? [])], certified: st !== null && st.state !== 'retired',
      });
    }

    const certifiedMetrics = new Set<string>();
    for (const id of new Set(vis.flatMap((v) => (Array.isArray(v.encoding?.values) ? v.encoding.values : []).map((m: { metricId?: string }) => m && m.metricId).filter(Boolean) as string[]))) {
      const st = await status(`metric:${id}`);
      if (st !== null && st.state !== 'retired') certifiedMetrics.add(id);
    }

    // What mentions a chart: read from the stored text of every record that could (see store.scanMentions). It throws rather than say "nothing".
    const used = await store.scanMentions(projectId);
    const firstSeen = await store.noteSeen(projectId, vis.map((v) => v.id), today);

    const usage = await store.readUsage(projectId, cutoff, today, s.windowDays);
    return {
      today,
      settings: { windowDays: s.windowDays, slowMs: s.slowMs, trashUnused: s.trashUnused, repairRenames: s.repairRenames },
      visuals: vis, datasets: dsets, renames: await store.readRenames(projectId),
      usedElsewhere: used, certifiedMetrics, usage: { ...usage, firstSeen },
    };
  });
}
