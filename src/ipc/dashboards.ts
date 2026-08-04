import { ipcMain } from 'electron';
import * as dashboards from '../dashboards';
import * as datasets from '../datasets';
import * as visuals from '../visuals';
import * as copilot from '../copilot';
import * as anomalies from '../anomalies';
import * as anomaliesResident from '../anomaliesResident';
import * as residentQuery from '../residentQuery';
import * as trace from '../residentTrace';
import { computeMetric } from '../metricValue';
import type { MetricAggregation } from '../metricValue';
import { applyPipeline } from '../transforms';
import type { FilterStep } from '../transforms';
import { summarizeDashboard, explainAnomalies } from '../analyze';

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
    if (resident !== null) {
      trace.record('metric', 'resident');
      return { ok: true, value: resident };
    }
    trace.record('metric', 'failed', `aggregation=${spec.aggregation}, filters=${filters.length}`);
  } else {
    trace.record('metric', 'skipped');
  }
  if (target.ds === undefined) target.ds = await datasets.getDataset(projectId, datasetId);
  const ds = target.ds;
  if (!ds) return { ok: false, value: null };
  const table = filters.length
    ? applyPipeline({ columns: ds.columns, rows: ds.rows }, filters)
    : { columns: ds.columns, rows: ds.rows };
  return { ok: true, value: computeMetric(table.columns, table.rows, spec) };
}

// ── The resident anomaly path ───────────────────────────────────────────────
//
// `dashboard:explainAnomalies` was the LAST handler that hydrated a whole table:
// it loops every dataset a dashboard references and, per dataset, called
// `getDataset` (a full `Cell[][]` materialisation) so that `detectAnomalies`
// could fold over the rows. With the import cap at 1,000,000 rows that is
// several seconds per dataset, and the answer is at most twelve sentences.
//
// `anomaliesResident.detectAnomaliesResident` is a proven-equivalent
// implementation (differential test: the resident list must deep-equal the JS
// list over the same file's rows — same order, same `detail` strings, same
// severities). It answers the two rules that need real SQL — `numeric_outlier`
// and `period_change` — off the Parquet file, and reuses `statsResident` for
// `dominant_category` / `empty_heavy` / `constant_column`, exactly as
// `anomalies.ts` reuses `datasetStats` for the last two.
//
// THE JS PATH REMAINS THE REFERENCE IMPLEMENTATION, and the fallback is PER
// DATASET: a project can mix v2 (inline-rows) and v3 (Parquet) records, and a
// resident failure on one must not cost the others their fast path. Anything the
// resident path cannot answer — no Parquet, no bridge, a query failure, a
// non-reproducible option — returns `null` and that ONE dataset hydrates. A
// resident failure is a performance event, never a user-facing error.
//
// `buildAnomaliesFacts` is unchanged: it is pure string formatting over an
// already-computed list. The only thing it needed was the dataset NAME, which
// now comes from `getDatasetMeta` (a JSON metadata read that never touches the
// table) instead of from a hydrated `Dataset`.
//
// ── The threshold, and why it is NOT the metric one ─────────────────────────
// Measured on this repo, from a dataset ID to a finished `Anomaly[]` (so the JS
// column includes the hydration it cannot avoid), one dataset of 6 columns
// (2 numeric, 1 date, 3 text), warm bridge, median of 11:
//
//     rows       100   1,000   2,000   3,000   5,000   8,000   10,000   200,000   1,000,000
//     JS    ms  2.94    6.48    9.22   13.08   19.57   28.65    39.37    774.47        4,511
//     res.  ms 17.04   18.44   18.43   19.56   20.58   22.90    25.39    106.57          328
//
// Unlike `dashboard:metric`, the resident side here has a REAL floor — ~17 ms,
// near-flat to 5,000 rows. A metric card is one scalar from one statement; a
// full anomaly scan is six (`statsResident`'s two, plus this module's row-count
// + outlier aggregates, squared deviations, outlier predicate and period
// buckets), several of which sort or group the whole relation. So the crossover
// is ~5,500 rows, not ~100, and RESIDENT_MIN_ROWS (1,000) would make the
// resident path 2.8x SLOWER on a 1,000-row dataset. Hence a second, higher
// constant rather than a shared one.
//
// Above the crossover the gap grows with rows, because the JS side is hydration
// and the resident side is a fixed handful of scans: 1.6x at 10k, 7.3x at 200k,
// 13.8x at the 1,000,000-row import cap (4.5 s → 0.33 s).
//
// `rowCount` comes from `getDatasetMeta`, which reads it out of the JSON record
// without touching the table, so consulting the threshold costs nothing.
// ...but rows are only half the story, and the flat threshold above was WRONG
// on wide tables. The resident detector issues a handful of statements PER
// NUMERIC COLUMN, each paying the bridge's per-statement floor, so its cost
// scales with column count while the JS side scales with rows x columns.
// Measured (identical results throughout — this is purely cost):
//
//   numeric cols   rows     JS      resident   ratio
//              7   20,000    80 ms      92 ms   1.1x
//             17   20,000   171 ms     276 ms   1.6x
//             34   10,000   175 ms     528 ms   3.0x SLOWER
//             67   10,000   350 ms   1,459 ms   4.2x SLOWER
//            133    5,000   334 ms   5,909 ms  17.7x SLOWER
//
// At 1,000 columns it reached 57 seconds — a hang, on a path a user triggers
// by clicking "explain anomalies".
//
// So the gate is a budget, not a row count: spend one statement's worth of
// setup per numeric column only when there are enough rows to amortise it.
// A single-numeric-column table needs 5,000 rows, which reproduces the old
// threshold exactly; 133 numeric columns would need 665,000.
//
// The proper fix is to batch the per-column statements into one, the way
// statsResident folds every column into a single grouped scan. Until then this
// picks the faster path instead of assuming one always wins.
// Two terms, and BOTH are needed. A first attempt let a zero-numeric-column
// table skip the row check entirely, on the reasoning that there are no
// per-column statements to pay for — but the base statements (the grouped
// category scan, the period GROUP BY) still cost the bridge's fixed floor, so a
// four-row table was taking the resident path to answer something JS does
// instantly. A test caught it.
const ANOMALY_MIN_ROWS = 5_000; // pays for the base statements
const ANOMALY_ROWS_PER_NUMERIC_COL = 5_000; // pays for each column's own

function anomalyResidentWorthIt(meta: datasets.DatasetMeta): boolean {
  const numericCols = meta.columns.filter((c) => c.type === 'number').length;
  const needed = Math.max(ANOMALY_MIN_ROWS, numericCols * ANOMALY_ROWS_PER_NUMERIC_COL);
  return meta.rowCount >= needed;
}

/**
 * One dataset's app-detected anomalies plus the name `buildAnomaliesFacts`
 * quotes, or `null` when the dataset is missing/unreadable (the caller skips
 * it, exactly as the pre-rewire `if (!ds) continue` did).
 *
 * Never throws: any resident failure degrades to the hydrate-and-fold path.
 */
async function anomaliesFor(
  projectId: string,
  datasetId: string,
): Promise<{ name: string; list: anomalies.Anomaly[] } | null> {
  try {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (meta && meta.resident && anomalyResidentWorthIt(meta) && anomaliesResident.isAnomaliesResident()) {
      const src = await datasets.residentSource(projectId, datasetId);
      if (src) {
        const list = anomaliesResident.detectAnomaliesResident(src);
        // `[]` is a real answer (a clean dataset); only `null` means fall back.
        if (list !== null) {
          trace.record('anomalies', 'resident');
          return { name: meta.name, list };
        }
        trace.record('anomalies', 'failed', `${meta.rowCount} rows × ${meta.columns.length} cols`);
      } else {
        trace.record('anomalies', 'failed', 'no resident source for a resident dataset');
      }
    } else {
      trace.record('anomalies', 'skipped');
    }
  } catch (_) {
    /* fall through to the reference path */
    trace.record('anomalies', 'failed', 'threw');
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  return { name: ds.name, list: anomalies.detectAnomalies(ds.columns, ds.rows) };
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

  // A PUBLISHED dashboard (analysisId set) is READ-ONLY. The refusal is enforced
  // in dashboards.updateDashboard, which every main-process caller goes through;
  // this branch exists only to say WHY, since the store can only answer null.
  // Without it the renderer's ~600 ms autosave debounce would overwrite a
  // snapshot the moment a card was nudged.
  ipcMain.handle('dashboard:update', async (_e, { projectId, id, name, pages, filters }: any = {}) => {
    try {
      const existing = await dashboards.getDashboard(projectId, id);
      if (existing && existing.analysisId) {
        return {
          ok: false,
          readOnly: true,
          error: 'This dashboard is a published snapshot. Edit it in its analysis, then publish again.',
        };
      }
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

  // `dashboard:draft` USED TO LIVE HERE. It is DELETED, not aliased or
  // deprecated-but-live: its body moved verbatim to `analysis:draft` in
  // src/ipc/analyses.ts and now produces `sheets` for an analysis instead of
  // `pages` for a dashboard. The AI's output is a first draft — the thing a user
  // immediately wants to edit — so it belongs on the authoring surface, not in
  // the published snapshot. Two AI paths that both create a layout, differing
  // subtly, is the failure mode an alias would have shipped.

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
          // A PUBLISHED card carries its visual's definition inline, so the
          // dataset id is right there — strictly better than a disk read, and
          // required: the source Visual may have been edited or deleted since,
          // and the snapshot must not follow it. The `visualId` branch stays for
          // legacy dashboards, which have no inline spec.
          else if (card.type === 'visual' && card.visual) addId(card.visual.datasetId);
          else if (card.type === 'visual' && card.visualId) {
            const v = await visuals.getVisual(projectId, card.visualId);
            if (v) addId(v.datasetId);
          }
        }
      }

      const all: anomalies.Anomaly[] = [];
      const factsBlocks: string[] = [];
      for (const dsId of datasetIds) {
        const found = await anomaliesFor(projectId, dsId);
        if (!found || found.list.length === 0) continue;
        all.push(...found.list);
        factsBlocks.push(anomalies.buildAnomaliesFacts(found.name, found.list));
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
