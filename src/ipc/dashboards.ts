import { ipcMain } from 'electron';
import * as dashboards from '../analysis/dashboards';
import * as answerKey from '../data/answerKey';
import * as queryCache from '../engine/queryCache';
import * as datasets from '../data/datasets';
import * as residentQuery from '../engine/residentQuery';
import * as trace from '../engine/residentTrace';
import { computeMetric } from '../analysis/metricValue';
import type { MetricAggregation } from '../analysis/metricValue';
import { applyPipeline } from '../data/transforms';
import type { FilterStep } from '../data/transforms';
import { joinedMetricFor } from './relationships';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import { paramTable } from '../data/paramReplay';

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
 * The ONE app-computed number for a metric card, resolved from scratch.
 *
 * EXPORTED for src/analysis/alertStore.ts, which is the only other caller: an
 * alert about a KPI must be about THE SAME NUMBER the card shows, and the only
 * way to guarantee that is for both to run this function rather than two
 * implementations that agree today. (scripts/test-alerts.ts still asserts the
 * agreement against `metricValue.computeMetric` with `Object.is`, so a future
 * fork of this path fails loudly instead of quietly drifting.)
 *
 * `filters` must ALREADY be sanitized by the caller — this is the same
 * `sanitizeDashboardFilters` contract the handler below holds, and it is a
 * security control, not a formatter.
 */
export async function computeCardMetric(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[] = [],
  params?: ParamValues,
): Promise<{ ok: boolean; value: number | null }> {
  // The answer cache (engine/queryCache): every KPI on an open dashboard, and
  // the same KPI again for an alert, a formula metric or a compare. A null
  // VALUE is a real answer and is kept; ok:false (dataset gone) is not.
  const parts = await answerKey.keyParts(projectId, datasetId);
  if (!parts) return computeCardMetricUncached(projectId, datasetId, spec, filters, params);
  const key = queryCache.cacheKey('metric', parts, {
    column: spec.column, aggregation: spec.aggregation, filters, params: params ?? null, ...answerKey.ambient(),
  });
  return queryCache.through('metric', key, [datasetId, queryCache.projectDep(projectId)],
    () => computeCardMetricUncached(projectId, datasetId, spec, filters, params), (r) => r.ok);
}

async function computeCardMetricUncached(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
  params?: ParamValues,
): Promise<{ ok: boolean; value: number | null }> {
  // A pipeline that references a dashboard parameter is replayed with the
  // query's values bound (data/paramReplay.ts); everything else is untouched.
  const replay = await paramTable(projectId, datasetId, params);
  if (replay) {
    const table = filters.length ? applyPipeline(replay, filters) : replay;
    return { ok: true, value: computeMetric(table.columns, table.rows, spec) };
  }
  const target = await loadMetricTarget(projectId, datasetId);
  return metricFor(projectId, datasetId, spec, filters, target);
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
  // A column or filter this dataset lacks may live on a RELATED one.
  const joined = await joinedMetricFor(projectId, datasetId, spec, filters);
  if (joined) return joined;
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

export function register() {
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
  ipcMain.handle('dashboard:metric', async (_e, { projectId, datasetId, column, aggregation, filters, params }: any = {}) => {
    try {
      // Parameters resolve FIRST — `[[threshold]]` becomes the number it names —
      // so both paths below see ordinary, typed filter steps.
      const values = paramValues(params);
      const bound = resolveFilterParams(dashboards.sanitizeDashboardFilters(filters), values);
      const spec = { column, aggregation: aggregation as MetricAggregation };
      const res = await computeCardMetric(projectId, datasetId, spec, bound.steps, values);
      if (!res.ok) return { ok: false, error: 'Dataset not found' };
      return bound.errors.length ? { ok: true, value: res.value, paramErrors: bound.errors } : { ok: true, value: res.value };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the metric' };
    }
  });
}
