import { ipcMain } from 'electron';
import * as dashboards from '../dashboards';
import * as datasets from '../datasets';
import * as visuals from '../visuals';
import * as copilot from '../copilot';
import * as anomalies from '../anomalies';
import { computeMetric } from '../metricValue';
import type { MetricAggregation } from '../metricValue';
import { applyPipeline } from '../transforms';
import { draftDashboard, summarizeDashboard, explainAnomalies } from '../analyze';

// Dashboards IPC — list/get/save/update/delete a Dashboard, plus `dashboard:metric`
// which loads a dataset and runs the PURE src/metricValue.ts helper to produce the
// ONE app-computed number a metric card shows. All are ipcMain.handle
// (request/response); a thrown error becomes { ok:false, error } so the renderer
// never sees an unhandled rejection. No deps object (pure disk), matching
// projects.register()/visuals.register().
//
// Number-accuracy: the metric value is computed ONLY by computeMetric in MAIN
// (strict number rule) — the renderer never computes a figure and no model is
// involved. Visual cards REUSE the existing `visual:data` channel; there is no new
// charting IPC here.

export function register() {
  ipcMain.handle('dashboard:list', async (_e, { projectId }: any = {}) =>
    dashboards.listDashboards(projectId),
  );

  ipcMain.handle('dashboard:get', async (_e, { projectId, id }: any = {}) =>
    dashboards.getDashboard(projectId, id),
  );

  ipcMain.handle('dashboard:save', async (_e, { projectId, name, pages, filters }: any = {}) => {
    try {
      const saved = await dashboards.saveDashboard(projectId, { name, pages, filters });
      if (!saved) return { ok: false, error: 'Invalid project, or it no longer exists' };
      return saved;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the dashboard' };
    }
  });

  ipcMain.handle('dashboard:update', async (_e, { projectId, id, name, pages, filters }: any = {}) => {
    try {
      const dashboard = await dashboards.updateDashboard(projectId, id, { name, pages, filters });
      return dashboard ? { ok: true, dashboard } : { ok: false, error: 'Could not update the dashboard' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the dashboard' };
    }
  });

  ipcMain.handle('dashboard:delete', async (_e, { projectId, id }: any = {}) => ({
    ok: await dashboards.deleteDashboard(projectId, id),
  }));

  // Load the dataset's DERIVED columns/rows (the same source the visual bridge
  // uses), apply the dashboard-wide filters FIRST (Week 10 — the SAME tested pure
  // pipeline visual cards use, so one dashboard filter drives the metric card too),
  // then run the pure metric helper. Filters are untrusted renderer input →
  // sanitized to filter-only steps before the math; a filter on a column the
  // dataset lacks is skipped with a warning (never throws), so one dashboard filter
  // safely spans heterogeneous datasets. Still 100% app-computed (strict-number
  // rule intact); no model involved. Dataset missing → { ok:false }.
  ipcMain.handle('dashboard:metric', async (_e, { projectId, datasetId, column, aggregation, filters }: any = {}) => {
    try {
      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: false, error: 'Dataset not found' };
      const steps = dashboards.sanitizeDashboardFilters(filters);
      const table = steps.length
        ? applyPipeline({ columns: ds.columns, rows: ds.rows }, steps)
        : { columns: ds.columns, rows: ds.rows };
      const value = computeMetric(table.columns, table.rows, {
        column,
        aggregation: aggregation as MetricAggregation,
      });
      return { ok: true, value };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the metric' };
    }
  });

  // ── Week 12: embedded AI actions ──────────────────────────────────────────
  // The model proposes STRUCTURE or narrates PROSE only; the app computes every
  // number. Each is executionReady-gated (soft notReady), CONFIRM-before-apply
  // (draft returns WITHOUT saving), and produces an editable artifact.

  // Compute each metric card's ONE app-computed number for a dashboard, caching
  // each referenced dataset (reuses the exact logic of ipc/copilot.buildFacts's
  // dashboard branch — the model never sees a raw dataset, only these figures).
  async function computeMetricCards(projectId: string, d: dashboards.Dashboard): Promise<{ label: string; value: number | null }[]> {
    const dsCache = new Map<string, Awaited<ReturnType<typeof datasets.getDataset>>>();
    const computed: { label: string; value: number | null }[] = [];
    for (const page of d.pages || []) {
      for (const card of page.cards || []) {
        if (card.type !== 'metric' || !card.metric) continue;
        const m = card.metric;
        let ds = dsCache.get(m.datasetId);
        if (ds === undefined) {
          ds = await datasets.getDataset(projectId, m.datasetId);
          dsCache.set(m.datasetId, ds);
        }
        const value = ds ? computeMetric(ds.columns, ds.rows, { column: m.column, aggregation: m.aggregation }) : null;
        computed.push({ label: m.label || `${m.aggregation}(${m.column})`, value });
      }
    }
    return computed;
  }

  // AI-DRAFTED LAYOUT. Build a compact inventory (datasets → columns; saved visuals
  // by name), ask the model for a name + cards referencing ONLY those names, then
  // RESOLVE names→ids in MAIN (verify columns exist, clamp aggregations, map visual
  // names→ids), ASSIGN the grid layout ourselves (flow packer), and sanitize into
  // pages. Returns { ok, name, pages } WITHOUT saving — the renderer confirms, then
  // calls the existing dashboard:save. Every figure is computed later at render.
  const DRAFT_AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
  ipcMain.handle('dashboard:draft', async (_e, { projectId }: any = {}) => {
    try {
      const dsSummaries = await datasets.listDatasets(projectId);
      const vList = await visuals.listVisuals(projectId);
      if (dsSummaries.length === 0 && vList.length === 0) {
        return { ok: false, error: 'Add a dataset or visual before drafting a dashboard.' };
      }

      // Load each dataset's columns for the inventory + name→(id, columns) lookup.
      const dsByName = new Map<string, datasets.Dataset>();
      const invLines: string[] = ['Datasets and their columns:'];
      for (const s of dsSummaries) {
        const ds = await datasets.getDataset(projectId, s.id);
        if (!ds) continue;
        dsByName.set(ds.name, ds);
        invLines.push(`- "${ds.name}": ${ds.columns.map((c) => `${c.name} (${c.type})`).join(', ') || '(no columns)'}`);
      }
      invLines.push('');
      invLines.push('Saved visuals (reference by exact name):');
      const vByName = new Map<string, string>(); // name → visualId
      vList.forEach((v) => vByName.set(v.name, v.id));
      invLines.push(vList.length ? vList.map((v) => `- "${v.name}"`).join('\n') : '- (none)');

      const res = await draftDashboard(invLines.join('\n'));
      if (!res.ok) {
        if (res.errorType === 'not_ready') return { ok: false, notReady: true };
        return { ok: false, error: res.message || 'Could not draft a dashboard' };
      }

      const structure = (res.structure && typeof res.structure === 'object' ? res.structure : {}) as Record<string, unknown>;
      const name = typeof structure.name === 'string' && structure.name.trim() ? structure.name.trim() : 'AI dashboard';
      const rawCards = Array.isArray(structure.cards) ? structure.cards : [];

      // Flow packer: metric 3×2, visual 6×6, text 12×2 — laid out left→right,
      // wrapping at GRID_COLS. Resolve every reference; drop anything unresolvable.
      const packed: unknown[] = [];
      let cx = 0;
      let cy = 0;
      let rowH = 0;
      const place = (w: number, h: number) => {
        if (cx + w > dashboards.GRID_COLS) { cx = 0; cy += rowH; rowH = 0; }
        const layout = { x: cx, y: cy, w, h };
        cx += w;
        if (h > rowH) rowH = h;
        return layout;
      };
      for (const raw of rawCards) {
        const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
        if (!c) continue;
        if (c.type === 'metric') {
          const ds = typeof c.dataset === 'string' ? dsByName.get(c.dataset) : undefined;
          if (!ds) continue;
          const column = typeof c.column === 'string' ? c.column : '';
          if (!ds.columns.some((col) => col.name === column)) continue; // column must exist
          const aggregation = typeof c.aggregation === 'string' && DRAFT_AGGS.has(c.aggregation) ? c.aggregation : 'sum';
          const label = typeof c.label === 'string' ? c.label : `${aggregation}(${column})`;
          packed.push({ type: 'metric', layout: place(3, 2), metric: { datasetId: ds.id, column, aggregation, label } });
        } else if (c.type === 'visual') {
          const visualId = typeof c.visual === 'string' ? vByName.get(c.visual) : undefined;
          if (!visualId) continue;
          packed.push({ type: 'visual', layout: place(6, 6), visualId });
        } else if (c.type === 'text') {
          const heading = typeof c.heading === 'string' ? c.heading : undefined;
          const text = typeof c.text === 'string' ? c.text : undefined;
          if (heading === undefined && text === undefined) continue;
          packed.push({ type: 'text', layout: place(12, 2), heading, text });
        }
      }

      // sanitizeCards drops anything still malformed; wrap into a single page.
      const cards = dashboards.sanitizeCards(packed);
      const pages = [{ name: 'Page 1', cards }];
      return { ok: true, name, pages };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to draft a dashboard' };
    }
  });

  // AI SUMMARY (prose). Recompute every metric card in MAIN, format them as FACTS
  // via the existing pure copilot.dashboardFacts (guard line + app-computed numbers),
  // and ask the model only to narrate. Returns { ok, text, provenance }. The model
  // never writes a figure. No model → { ok:false, notReady:true }.
  ipcMain.handle('dashboard:summary', async (_e, { projectId, id }: any = {}) => {
    try {
      const d = await dashboards.getDashboard(projectId, id);
      if (!d) return { ok: false, error: 'Dashboard not found' };
      const computed = await computeMetricCards(projectId, d);
      const facts = copilot.dashboardFacts(d, computed);
      const res = await summarizeDashboard(facts.text);
      if (res.ok) return { ok: true, text: res.text, provenance: facts.provenance };
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not summarize the dashboard' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to summarize the dashboard' };
    }
  });

  // AI ANOMALY EXPLANATION (app detects, model explains). Collect the dashboard's
  // referenced dataset ids (metric cards directly, visual cards via their visual),
  // dedup, run the PURE detectAnomalies over each, format app-computed FACTS via
  // anomalies.buildAnomaliesFacts, and ask the model only to contextualize. Returns
  // the raw app-detected list too, so the renderer shows the computed facts distinct
  // from the AI prose. No anomalies → { ok, text:null, anomalies:[] } (no model call
  // needed). No model → { ok:false, notReady:true }.
  ipcMain.handle('dashboard:explainAnomalies', async (_e, { projectId, id }: any = {}) => {
    try {
      const d = await dashboards.getDashboard(projectId, id);
      if (!d) return { ok: false, error: 'Dashboard not found' };

      // Referenced dataset ids: metric cards carry datasetId; visual cards point at
      // a Visual whose datasetId we resolve. Dedup, preserving first-seen order.
      const datasetIds: string[] = [];
      const seen = new Set<string>();
      const addId = (dsId: string | undefined) => {
        if (dsId && !seen.has(dsId)) { seen.add(dsId); datasetIds.push(dsId); }
      };
      for (const page of d.pages || []) {
        for (const card of page.cards || []) {
          if (card.type === 'metric' && card.metric) addId(card.metric.datasetId);
          else if (card.type === 'visual' && card.visualId) {
            const v = await visuals.getVisual(projectId, card.visualId);
            if (v) addId(v.datasetId);
          }
        }
      }

      const all: anomalies.Anomaly[] = [];
      const factsBlocks: string[] = [];
      for (const dsId of datasetIds) {
        const ds = await datasets.getDataset(projectId, dsId);
        if (!ds) continue;
        const list = anomalies.detectAnomalies(ds.columns, ds.rows);
        if (list.length === 0) continue;
        all.push(...list);
        factsBlocks.push(anomalies.buildAnomaliesFacts(ds.name, list));
      }

      if (all.length === 0) return { ok: true, text: null, anomalies: [] };

      const res = await explainAnomalies(factsBlocks.join('\n\n'));
      if (res.ok) return { ok: true, text: res.text, anomalies: all };
      if (res.errorType === 'not_ready') return { ok: false, notReady: true, anomalies: all };
      return { ok: false, error: res.message || 'Could not explain the anomalies', anomalies: all };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to explain the anomalies' };
    }
  });
}
