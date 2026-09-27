// The resident fast paths behind `visual:data` — MAIN PROCESS.
//
// Split out of src/ipc/visuals.ts at the 800-line cap (.claude/rules/file-size.md).
// One job: answer a chart or a pivot straight off the stored Parquet, or return
// `null` so `ipc/visuals.vizDataFor` runs the JS reference instead. No IPC
// handler is registered here and no record is read or written.

import * as datasets from '../data/datasets';
import { recommendChartType } from '../analysis/vizData';
import type { VizDataResult } from '../analysis/vizData';
import { aggregateResident, resolveCatKey } from '../engine/residentQuery';
import type { ResidentMeasure } from '../engine/residentQuery';
import { pivotGridResident } from '../engine/pivotResident';
import { pivotChartData } from '../analysis/pivotData';
import * as trace from '../engine/residentTrace';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { FILTER_OPS, LIST_OPS } from '../data/filterOps';

// ── Phase 2.5: the resident fast path for `visual:data` ─────────────────────
//
// `visual:data` runs on every chart render and every cross-filter change, and
// until now it began by hydrating the WHOLE table into `Cell[][]` — measured at
// 1,173 ms for 1M rows, against 6.6 ms for the equivalent aggregate computed in
// place off the stored Parquet. So: when the answer is provably identical, ask
// DuckDB; otherwise keep hydrating.
//
// ONLY branch (A) of `buildVizData` — no split, at least one real aggregation,
// no geo — is rewired, because that is the only branch `aggregateResident`
// reproduces. (B) pivot and (C) raw have no resident equivalent and fall back
// verbatim. `buildVizData` stays the reference implementation: every rejection
// below, and every throw, silently returns null and the JS path runs.
//
// The subtle precondition is WARNINGS. `aggregateResident` returns numbers, not
// warnings, so the fast path may only be taken when `buildVizData` would have
// produced NONE. In branch (A) exactly three things warn, and all three are
// decidable from column METADATA alone, with no rows:
//   1. `transforms.stepFilter`  — unknown filter column / unknown filter op
//   2. `transforms.stepGroupAggregate` — unknown group (category) column
//   3. `transforms.aggregate`   — unknown measure column
// Check all three against the stored `ParsedColumn[]` and a warning is
// impossible; fail any and we fall back so the user still sees the warning.
// (The four guard-rail early returns each carry a warning too, so they are
// likewise left to `buildVizData`.)

// The op vocabulary comes from src/filterOps.ts so this gate cannot drift out of
// step with the three implementations — that drift is silent by construction
// (the fast path just stops firing and the JS path answers correctly, slowly).
// `visuals.sanitizeFilters` already guarantees a valid op, so the check itself is
// defence against a future divergence rather than a live case.
//
// `in`/`not in` add a FOURTH warning source to the three enumerated above: an
// empty value list makes `transforms.stepFilter` skip the step with a warning.
// Like the other three it is decidable from the step alone, with no rows.
export function filterCannotWarn(f: FilterStep, names: Set<string>): boolean {
  if (!f || f.type !== 'filter' || !names.has(f.column) || !FILTER_OPS.has(f.op)) return false;
  if (LIST_OPS.has(f.op) && (!Array.isArray(f.values) || f.values.length === 0)) return false;
  if (f.op === 'period' && !f.period) return false;
  return true;
}

/**
 * The PIVOT `visual:data` answer computed straight off Parquet, or `null`
 * meaning "use `buildVizData`".
 *
 * Same discipline as `residentVizData` below and the same warning-freedom
 * proof: a pivot's grouping sets warn for exactly the reasons branch (A) warns
 * — an unknown filter column or op, an unknown dimension, an unknown value
 * column — and all of them are decidable from the stored `ParsedColumn[]` with
 * no rows. Fail any and the JS reference answers, warning included.
 *
 * The FOLD is not duplicated: the resident path produces groups and hands them
 * to `pivotData.foldPivotGrid`, the same function the JS path calls.
 */
export async function residentPivotData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
): Promise<VizDataResult | null> {
  try {
    const pivot = encoding.pivot;
    if (!pivot || pivot.rows.length === 0 || pivot.values.length === 0) return null;

    const src = await datasets.residentSource(projectId, datasetId);
    if (!src) {
      trace.record('vizPivot', 'skipped');
      return null;
    }
    const names = new Set<string>();
    for (const c of src.columns) if (c && typeof c.name === 'string') names.add(c.name);
    for (const d of pivot.rows.concat(pivot.columns)) if (!names.has(d.column)) return null;
    for (const v of pivot.values) if (!names.has(v.column)) return null;
    for (const f of filters) if (!filterCannotWarn(f, names)) return null;

    const grid = pivotGridResident(src, pivot, filters);
    if (!grid) {
      trace.record('vizPivot', 'failed', `${pivot.rows.length}×${pivot.columns.length} dims`);
      return null;
    }
    trace.record('vizPivot', 'resident');

    const chart = pivotChartData(grid);
    return {
      data: { labels: chart.labels, series: chart.series, pivot: grid },
      recommendedShape: 'categorical',
      warnings: [],
    };
  } catch (_) {
    return null;
  }
}

/**
 * The aggregated (branch A) `visual:data` answer computed straight off Parquet,
 * or `null` meaning "not provably equivalent — use `buildVizData`".
 *
 * Takes ALREADY-SANITIZED encoding/filters: sanitisation is a security control
 * over untrusted renderer input and must run before anything else, including
 * this. Never throws.
 */
export async function residentVizData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
): Promise<VizDataResult | null> {
  try {
    if (!encoding) return null;
    // A pivot is branch (D) and has its own resident path above.
    if (encoding.pivot) return null;
    // So are the cohort and event-funnel encodings (ipc/visualsEngines).
    if (encoding.cohort || encoding.eventFunnel) return null;
    // Geo derives its region items from the finished series, and a split or an
    // all-'none' encoding is branch (B)/(C). None are reproducible here.
    if (encoding.geo) return null;
    if (typeof encoding.series === 'string' && encoding.series.length > 0) return null;
    if (typeof encoding.category !== 'string' || encoding.category === '') return null;
    const values = Array.isArray(encoding.values) ? encoding.values : [];
    if (values.length === 0) return null;
    if (values.every((v) => v.aggregation === 'none')) return null;

    // v2 record, missing .parquet, or no working bridge → the JS path.
    const src = await datasets.residentSource(projectId, datasetId);
    if (!src) {
      trace.record('vizAggregate', 'skipped');
      return null;
    }

    // The warning-freedom proof (see above). Column identity is exact and
    // case-sensitive, matching `transforms.colIndex`.
    const names = new Set<string>();
    for (const c of src.columns) if (c && typeof c.name === 'string') names.add(c.name);
    if (!names.has(encoding.category)) return null;
    for (const v of values) if (!names.has(v.column)) return null;
    for (const f of filters) {
      if (!filterCannotWarn(f, names)) return null;
    }

    // In an aggregated build `buildVizData` coerces a 'none' measure to 'sum'
    // AND relabels it ("sum of price", vizData.ts:133) so the legend never
    // understates the value. Coercing here reproduces both at once, because
    // `residentQuery.measureLabel` derives the name from the same aggregation.
    const measures: ResidentMeasure[] = values.map((v) => ({
      column: v.column,
      aggregation: v.aggregation === 'none' ? 'sum' : v.aggregation,
    }));

    // The category key (10 bins / a date grain / the top-50 cap) is resolved by
    // pre-queries over the same relation before the aggregate runs.
    //
    // A `null` on a DATE column is a DECISION, not a fault: SQL implements only
    // the two canonical date shapes and hands anything else to the JS
    // `Date.parse` path deliberately. residentTrace's taxonomy calls that
    // 'skipped' — counted, silent. On a number or text column nothing about the
    // input can produce a null, so one there IS the regression signal and warns.
    // (No column NAME in the detail: it is a header out of the user's own file.)
    const catType = src.columns.find((c) => c && c.name === encoding.category)?.type;
    const plan = resolveCatKey(src, encoding.category, measures, filters, encoding.grain, encoding.bins);
    if (!plan) {
      trace.record('vizCategoryKey', catType === 'date' ? 'skipped' : 'failed', `category type ${catType}`);
      return null;
    }
    trace.record('vizCategoryKey', 'resident');

    const chart = aggregateResident(src, encoding.category, measures, filters, plan.key);
    if (!chart) {
      trace.record('vizAggregate', 'failed', `${measures.length} measure(s), filters=${filters.length}`);
      return null; // bridge down / query failed → JS path
    }
    trace.record('vizAggregate', 'resident');

    return {
      data: { labels: chart.labels, series: chart.series },
      // Pure, cheap, and needs only columns — call the real thing rather than
      // reimplementing the classification.
      recommendedShape: recommendChartType(src.columns, encoding).shape,
      // Still EMPTY, and it has to be: the whole fast path is gated on
      // `buildVizData` having produced no warning. The cap's inline note travels
      // on `category.note`, which is not a warning.
      warnings: [],
      category: plan.info,
    };
  } catch (_) {
    return null;
  }
}
