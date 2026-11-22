// What a run reads of one project, in the acting admin's context and across every folder (`wholeProject`: a chart on a dashboard
// in a folder the admin cannot open must still count as used, or it fails open and the chart is trashed). The result is `PlanIn`
// (./plan.ts): plain data, so the decisions are the pure function's.

import * as analysis from '../../analysis/analysis';
import * as alertStore from '../../analysis/alertStore';
import * as datasets from '../../data/datasets';
import * as reportSpec from '../../analysis/reportSpec';
import * as stories from '../../analysis/stories';
import * as visuals from '../../analysis/visuals';
import { statusFor } from '../../analysis/statusStore';
import { isLive } from '../../data/liveDataset';
import { wholeProject } from '../authz/folders';
import { addDays, type DatasetIn, type PlanIn, type Settings, type VisualIn } from './plan';
import * as store from './store';

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every id-shaped string in a stored record: the most conservative reading of "mentions this chart". */
export function uuidsIn(rec: unknown): string[] {
  return (JSON.stringify(rec) ?? '').match(UUID_G)?.map((x) => x.toLowerCase()) ?? [];
}

export async function readProject(projectId: string, s: Settings, today: string): Promise<PlanIn> {
  return wholeProject(async () => {
    const cutoff = addDays(today, -s.windowDays);
    const status = statusFor(projectId);

    const vis: VisualIn[] = [];
    for (const sum of await visuals.listVisuals(projectId)) {
      const v = await visuals.getVisual(projectId, sum.id);
      if (v) vis.push({ id: v.id.toLowerCase(), name: v.name, datasetId: v.datasetId.toLowerCase(), createdAt: v.createdAt, encoding: v.encoding as never, filters: v.filters });
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

    // What mentions a chart: dashboards (the draft and its published copy are one record), Stories, reports and alert rules.
    const used = new Set<string>();
    for (const a of await analysis.listAnalyses(projectId)) for (const id of uuidsIn((await analysis.readAnalysis(projectId, a.id))?.rec)) used.add(id);
    for (const st of await stories.listStories(projectId)) for (const id of uuidsIn(await stories.getStory(projectId, st.id))) used.add(id);
    for (const r of await reportSpec.readAll(projectId)) for (const id of uuidsIn(r)) used.add(id);
    for (const id of uuidsIn((await alertStore.load(projectId)).rules)) used.add(id);

    const usage = await store.readUsage(projectId, cutoff, today, s.windowDays);
    return {
      today,
      settings: { windowDays: s.windowDays, slowMs: s.slowMs, trashUnused: s.trashUnused, repairRenames: s.repairRenames },
      visuals: vis, datasets: dsets, renames: await store.readRenames(projectId),
      usedElsewhere: used, certifiedMetrics, usage,
    };
  });
}
