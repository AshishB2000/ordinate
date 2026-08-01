import { ipcMain } from 'electron';
import * as dashboards from '../dashboards';
import * as datasets from '../datasets';
import * as visuals from '../visuals';
import * as copilot from '../copilot';
import * as anomalies from '../anomalies';
import * as residentQuery from '../residentQuery';
import { computeMetric } from '../metricValue';
import type { MetricAggregation } from '../metricValue';
import { applyPipeline } from '../transforms';
import type { FilterStep } from '../transforms';
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

// ── Phase 2.5: the resident metric path ─────────────────────────────────────
//
// `datasets.getDataset` hydrates the WHOLE stored table into `Cell[][]` before
// this file computes one scalar off one column. Measured (docs/phase-3 §1): at
// 1M rows that hydration is 1,173 ms of the 1,110–1,532 ms a metric card costs,
// while the same answer read straight off the Parquet file is 1.75–4.00 ms.
// `residentQuery.computeMetricResident` is a proven-equivalent (357 differential
// assertions) implementation of `metricValue.computeMetric`, so this handler now
// asks it FIRST and keeps the hydrate-and-fold path as the reference.
//
// THE JS PATH REMAINS THE REFERENCE IMPLEMENTATION. Anything the resident path
// cannot answer — no Parquet (a v2 record), no bridge, a query failure, or a
// `null` result, which is indistinguishable from a legitimate null — falls back
// to it SILENTLY. A resident failure is a performance event, never a user-facing
// error.
//
// ONE ANSWER CAN DIFFER, and it is documented rather than hidden: `sum`/`avg`
// over NON-INTEGER floats. JS folds left-to-right in row order, DuckDB combines
// vectorised partial sums, so the two disagree in the last ULPs — measured here
// at 1M rows, 487417204.09997433 (JS) against 487417204.1000064 (resident),
// 6.6e-14 relative. That is inherent to parallel reduction, is bounded and
// pinned by scripts/test-residentQuery.ts (relErr < 1e-12), and sits ~5 orders
// of magnitude below anything a formatted metric card renders. Integer-valued
// data — which is most dashboard data — is exact.
//
// ── The threshold ───────────────────────────────────────────────────────────
// Resident is not free: every query pays the ~0.5 ms SharedArrayBuffer handshake
// in src/duckdb.ts. docs/phase-3 §1 records the one negative result and says a
// metric card therefore "wants a row-count threshold" — a scalar metric over 10k
// rows costs 0.56 ms resident against 0.06 ms in JS. But that 0.06 ms is §1's
// column (a2), COMPUTE ONLY, with the table already hydrated. THIS HANDLER NEVER
// STARTS THERE: it begins at a dataset id, so its real JS cost is §1's column
// (a) — hydration included, 11.5 ms at 10k. Re-measured end to end through the
// shipped handler on this repo's own fixtures (sum over a numeric column, median
// of 41):
//
//     rows      100    250    500   1,000   2,000   5,000   10,000   20,000
//     JS   ms  1.02   1.08   1.26    1.85    2.66    5.88    10.73    20.05
//     res. ms  0.41   0.43   0.42    0.45    0.46    0.54     0.68     0.77
//
// There is no crossover. Resident is ahead by 2.5× at ONE HUNDRED rows, because
// the JS path pays a whole-file read plus a `Cell[][]` allocation that the query
// simply never makes. §1's threshold advice was correct for the numbers §1 was
// comparing and does not survive contact with the hydration this handler pays.
//
// The one place the (a2) comparison does apply is `computeMetricCards`, which
// hydrates a dataset ONCE and answers every card on it from that table: N cards
// cost `hydrate + 0.06N` ms in JS against `0.5N` ms resident. Measured at 4
// cards on one dataset, JS wins below ~1,000 rows (1.7 ms vs 1.9 ms at 1,000)
// and loses from there (10.9 vs 2.6 at 10k, 1,183 vs 15 at 1M).
//
// 1,000 is therefore the threshold, and it is deliberately low. Below it both
// paths finish inside ~2 ms, the difference is unobservable, and the tie goes to
// the shipped reference implementation. At and above it resident wins the
// single-card path outright and stops losing the multi-card one, and the gap
// then grows linearly with rows — 44× at 100k, 249× at 1M — because the JS side
// is hydration and the resident side is flat.
//
// `rowCount` comes from `getDatasetMeta`, which reads it out of the JSON record
// without touching the table, so consulting the threshold costs nothing.
const RESIDENT_MIN_ROWS = 1_000;

/**
 * One dataset, resolved for metric computation and cached per call.
 *
 * `src` non-null ⇒ the table can be queried in place. `ds` is loaded LAZILY and
 * only when the JS path is actually needed: `undefined` = never attempted,
 * `null` = missing/unreadable. Keeping both on one entry is what stops a
 * resident-then-fallback card from hydrating a dataset a second time.
 */
interface MetricTarget {
  src: residentQuery.ResidentSource | null;
  ds?: datasets.Dataset | null;
}

/**
 * Decide, for one dataset, whether the resident path is available AND worth it.
 * Never throws: every failure resolves to `{ src: null }`, i.e. "use the JS
 * path". `isResident()` is checked first so a machine without a working bridge
 * skips the metadata read entirely rather than parsing a v2 record's JSON (rows
 * and all) once here and again in `getDataset`.
 */
async function loadMetricTarget(projectId: string, datasetId: string): Promise<MetricTarget> {
  try {
    if (!residentQuery.isResident()) return { src: null };
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta || !meta.resident || meta.rowCount < RESIDENT_MIN_ROWS) return { src: null };
    const src = await datasets.residentSource(projectId, datasetId);
    return { src: src ?? null };
  } catch (_) {
    return { src: null };
  }
}

/**
 * The ONE app-computed number for a metric card. Tries the resident query, then
 * falls back to hydrate-and-fold.
 *
 * `filters` are the ALREADY-SANITIZED dashboard filter steps. Both paths skip a
 * filter naming a column the dataset lacks and compute the metric over the rest
 * (`transforms` skips it with a warning; `residentQuery.filterPredicate` omits
 * the predicate) — which is what lets one dashboard filter span heterogeneous
 * datasets, so the resident path needs no special case for it.
 *
 * `ok:false` means the dataset itself could not be loaded. A `null` VALUE is a
 * real answer (unknown column, non-numeric column, no numeric cells) — but it is
 * also what `computeMetricResident` returns on failure, and the two are
 * indistinguishable, so a resident null always falls through to the reference
 * path rather than being trusted.
 */
async function metricFor(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
  target: MetricTarget,
): Promise<{ ok: boolean; value: number | null }> {
  if (target.src) {
    const resident = residentQuery.computeMetricResident(target.src, spec, filters);
    if (resident !== null) return { ok: true, value: resident };
  }
  if (target.ds === undefined) target.ds = await datasets.getDataset(projectId, datasetId);
  const ds = target.ds;
  if (!ds) return { ok: false, value: null };
  const table = filters.length
    ? applyPipeline({ columns: ds.columns, rows: ds.rows }, filters)
    : { columns: ds.columns, rows: ds.rows };
  return { ok: true, value: computeMetric(table.columns, table.rows, spec) };
}

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
  //
  // Phase 2.5: `metricFor` answers this off the Parquet file when it can (see
  // RESIDENT_MIN_ROWS above) and hydrates otherwise. sanitizeDashboardFilters
  // still runs FIRST and unchanged — it is the security control that keeps
  // untrusted renderer input to filter-only steps, not a formatter, and BOTH
  // paths consume its output. The response shape is byte-identical either way.
  ipcMain.handle('dashboard:metric', async (_e, { projectId, datasetId, column, aggregation, filters }: any = {}) => {
    try {
      const steps = dashboards.sanitizeDashboardFilters(filters);
      const spec = { column, aggregation: aggregation as MetricAggregation };
      const target = await loadMetricTarget(projectId, datasetId);
      const res = await metricFor(projectId, datasetId, spec, steps, target);
      if (!res.ok) return { ok: false, error: 'Dataset not found' };
      return { ok: true, value: res.value };
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
  //
  // Phase 2.5: the cache now holds a MetricTarget rather than a hydrated
  // Dataset, so a dataset is resolved ONCE per call and every card on it reuses
  // that decision — a resident dataset is never hydrated, and a dataset that
  // does fall back is hydrated exactly once (lazily, inside metricFor) no matter
  // how many cards read it. No dashboard filters here, matching the previous
  // behaviour: this feeds the AI summary's FACTS block, which describes the
  // dashboard's stored cards, not a transient filter selection.
  async function computeMetricCards(projectId: string, d: dashboards.Dashboard): Promise<{ label: string; value: number | null }[]> {
    const targets = new Map<string, MetricTarget>();
    const computed: { label: string; value: number | null }[] = [];
    for (const page of d.pages || []) {
      for (const card of page.cards || []) {
        if (card.type !== 'metric' || !card.metric) continue;
        const m = card.metric;
        let target = targets.get(m.datasetId);
        if (!target) {
          target = await loadMetricTarget(projectId, m.datasetId);
          targets.set(m.datasetId, target);
        }
        const res = await metricFor(projectId, m.datasetId, { column: m.column, aggregation: m.aggregation }, [], target);
        computed.push({ label: m.label || `${m.aggregation}(${m.column})`, value: res.ok ? res.value : null });
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
      // METADATA ONLY — this loop reads name/columns/id and nothing else, so it
      // uses getDatasetMeta. It previously hydrated EVERY dataset in the project
      // (both the derived table and the immutable source) to build a prompt
      // listing column names: at the 50k row cap that is tens of MB parsed per
      // draft, for data that is never looked at.
      const dsByName = new Map<string, datasets.DatasetMeta>();
      const invLines: string[] = ['Datasets and their columns:'];
      for (const s of dsSummaries) {
        const ds = await datasets.getDatasetMeta(projectId, s.id);
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
