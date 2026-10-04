// Server-only batches for the dashboards authoring screens (T2.8). The desktop
// reads each piece over instant IPC — one `analysis:get` per list card, one
// `visual:data` / `dashboard:metric` / `metric:compare` per tile, three
// channels per Metrics row; over the network that is a chatty page (plan §9).
// Each channel here answers a whole screen in one call by running the SAME
// stores and the SAME registered handlers a single call would, so a batched
// figure cannot differ from the unbatched one (scripts/test-analysesServer.ts
// compares them with Object.is).
//
// Nothing here computes a figure or formats one: every number comes out of a
// handler that already existed.

import { ipcMain } from './bus';
import { handlers } from '../server/rpc';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import type { MetricSummary } from '../analysis/metrics';
import { metricUsage } from '../analysis/metricUsage';
import { importImage, readImageDataUrl } from '../app/projectAssets';
import { FileTokenError, resolveUpload } from '../server/files';

/** What a card needs of a Visual to draw it — the record minus its bookkeeping. */
function visualDef(v: visuals.Visual) {
  return {
    id: v.id,
    name: v.name,
    datasetId: v.datasetId,
    chartType: v.chartType,
    encoding: v.encoding,
    overrides: v.overrides,
    filters: v.filters,
    ...(v.analytics && v.analytics.length ? { analytics: v.analytics } : {}),
    updatedAt: v.updatedAt,
  };
}
export type VisualDef = ReturnType<typeof visualDef>;

/** How many of the first sheet's visuals a list card previews (anList.ts AN_PREVIEW_MAX). */
const PREVIEW_MAX = 2;

/** A registered handler, called as the RPC layer calls it. Missing → a refusal, never a throw. */
async function call(event: unknown, channel: string, payload: unknown): Promise<any> { // any: each handler's own reply
  const h = handlers.get(channel);
  if (!h) return { ok: false, error: `${channel} is not available` };
  try {
    return await h(event, payload);
  } catch (err: any) { // any: a handler's throw
    return { ok: false, error: err?.message || `${channel} failed` };
  }
}

export function register(): void {
  ipcMain.handle('analysis:gallery', async (_e, { projectId }: any = {}) => {
    const out = [];
    for (const s of await analysis.listAnalyses(projectId)) {
      const a = await analysis.getAnalysis(projectId, s.id);
      const previews: VisualDef[] = [];
      for (const c of (a && a.sheets[0] ? a.sheets[0].cards : [])) {
        if (c.type !== 'visual' || !c.visualId) continue;
        // A dangling visualId is a hole in the sheet, not a card to draw.
        const v = await visuals.getVisual(projectId, c.visualId);
        if (v) previews.push(visualDef(v));
        if (previews.length >= PREVIEW_MAX) break;
      }
      // The sheets' ids and names: a navigation card's target picker (actionEditor.ts aeTargetFields).
      const sheets = a ? a.sheets.map((p) => ({ id: p.id, name: p.name })) : [];
      out.push({ id: s.id, name: s.name, sheetCount: s.sheetCount, updatedAt: s.updatedAt, previews, sheets });
    }
    return out;
  });

  // ponytail: every visual of the project, with its definition — a few KB each.
  // Page by the cards' ids if a project ever holds thousands.
  ipcMain.handle('analysis:open', async (_e, { projectId, id }: any = {}) => {
    const a = await analysis.getAnalysis(projectId, id);
    if (!a) return { ok: false, error: 'That dashboard could not be loaded.' };
    const defs: VisualDef[] = [];
    for (const s of await visuals.listVisuals(projectId)) {
      const v = await visuals.getVisual(projectId, s.id);
      if (v) defs.push(visualDef(v));
    }
    return { ok: true, analysis: a, visuals: defs };
  });

  ipcMain.handle('analysis:tiles', async (e, { projectId, params, items }: any = {}) =>
    Promise.all((Array.isArray(items) ? items : []).map(async (it: any) => { // any: contract-checked item
      if (it.kind === 'visual') {
        return call(e, 'visual:data', {
          projectId, datasetId: it.datasetId, encoding: it.encoding, filters: it.filters, params, analytics: it.analytics,
        });
      }
      // A statistics card (statsTile.ts): the spec recomputed under the sheet's filters by stats:tile.
      if (it.kind === 'stats') return call(e, 'stats:tile', { projectId, spec: it.spec, filters: it.filters, params });
      // A KPI that names a saved metric shows THE METRIC (its formula, its
      // format); one whose metric is gone falls back to its own stored
      // column and aggregation — dashFiltersUi.ts renderMetricCard's order.
      let res: any = null; // any: one of two handlers' replies
      if (it.metricId) {
        const r = await call(e, 'metric:value', { projectId, id: it.metricId, filters: it.filters, params });
        if (r && r.ok !== false) {
          res = { ok: true, value: r.value, display: r.display, name: r.name, ...(r.paramErrors ? { paramErrors: r.paramErrors } : {}) };
        }
      }
      if (!res) {
        if (!it.column) return { ok: false, error: 'The metric this card showed was deleted.' };
        const r = await call(e, 'dashboard:metric', {
          projectId, datasetId: it.datasetId, column: it.column, aggregation: it.aggregation, filters: it.filters, params,
        });
        if (!r || r.ok === false) return { ok: false, error: (r && r.error) || 'The metric could not be computed.' };
        res = { ok: true, value: r.value, ...(r.paramErrors ? { paramErrors: r.paramErrors } : {}) };
      }
      if (it.compare) {
        res.compare = await call(e, 'metric:compare', {
          projectId,
          card: { metricId: it.metricId, datasetId: it.datasetId, column: it.column, aggregation: it.aggregation },
          filters: it.filters, compare: it.compare, params,
        });
      }
      return res;
    })));

  // An image card's picture (layoutKinds.ts): the upload (T0.4) copied into the
  // project by content — PNG / JPG / script-free SVG, 5 MB — the desktop's
  // `asset:pickImage` without its native dialog. The browser names a token, never a path.
  ipcMain.handle('asset:importImage', async (_e, { projectId, fileToken }: any = {}) => {
    let up;
    try {
      up = resolveUpload(fileToken);
    } catch (err) {
      if (err instanceof FileTokenError) return { ok: false, error: 'That upload has expired. Choose the image again.' };
      throw err;
    }
    try {
      const res = await importImage(projectId, up.path);
      return 'error' in res ? { ok: false, error: res.error } : { ok: true, asset: res };
    } finally {
      up.done();
    }
  });
  // ponytail: assets live on the pod's DATA_DIR like the workspace logo; a
  // multi-pod deployment on S3 needs them moved beside the Parquet (T5.2).
  ipcMain.handle('asset:read', async (_e, { projectId, id, ext }: any = {}) => {
    const dataUrl = await readImageDataUrl(projectId, id, ext);
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'That image is missing from the project.' };
  });

  ipcMain.handle('metric:table', async (e, { projectId }: any = {}) => {
    const listed = await call(e, 'metric:list', { projectId });
    if (!listed || listed.ok === false) return listed;
    const rows: Record<string, unknown> = {};
    // Every metric at once (the desktop streamed rows in; one reply must not wait on them in turn).
    await Promise.all((listed.metrics as MetricSummary[]).map(async (m) => {
      const [value, series] = await Promise.all([call(e, 'metric:value', { projectId, id: m.id }), call(e, 'metric:series', { projectId, id: m.id })]);
      let usage: unknown = null;
      try {
        usage = await metricUsage(projectId, m.id);
      } catch (_) {
        usage = null; // a usage read that failed must not claim "used by nothing"
      }
      rows[m.id] = {
        display: value && value.ok !== false ? value.display : null,
        series: series && series.ok !== false && series.series ? series.series.values : null,
        usage,
      };
    }));
    return { ok: true, metrics: listed.metrics, rows };
  });

  ipcMain.handle('metric:values', async (e, { projectId, ids, filters, params }: any = {}) =>
    Promise.all((Array.isArray(ids) ? ids : []).map(async (id: string) => {
      const r = await call(e, 'metric:value', { projectId, id, filters, params });
      return r && r.ok !== false ? { id, ok: true, value: r.value, display: r.display } : { id, ok: false };
    })));
}
