import { ipcMain } from 'electron';
import * as visuals from '../visuals';
import * as datasets from '../datasets';
import { buildVizData, recommendChartType } from '../vizData';
import type { VizDataResult } from '../vizData';
import { aggregateResident } from '../residentQuery';
import type { ResidentMeasure } from '../residentQuery';
import { sanitizeEncoding, sanitizeChartType } from '../visuals';
import type { VizEncoding } from '../visuals';
import type { FilterStep } from '../transforms';
import { computeColumnSummariesResident } from '../statsResident';
import { computeColumnSummary } from '../datasetStats';
import type { ColumnSummary } from '../datasetStats';
import { suggestChart } from '../analyze';

// Visuals (saved charts/maps) IPC — list/get/save/update/delete a Visual, plus
// `visual:data` which loads a dataset and runs the PURE bridge (src/vizData.ts) to
// produce the exact `{labels, series}` (+ optional geo) the renderers consume. All
// are ipcMain.handle (request/response); a thrown error becomes { ok:false, error }
// so the renderer never sees an unhandled rejection. No deps object (pure disk),
// matching projects.register()/datasets.register().
//
// Number-accuracy: ALL aggregation math stays in the tested pure bridge, run in
// MAIN — the renderer never computes a figure and no model is involved. Visual
// overrides are chart STYLING only; visual filters are transforms filter steps
// applied to the rows BEFORE aggregation (still app-computed, strict number rule).

// Compact, plain-text column summary for the OPTIONAL AI chart suggestion. Every
// stat is app-computed (datasetStats) and embedded as a FACT — the model proposes
// chart STRUCTURE referencing these column names and never a data value/number.
// Takes metadata + ALREADY-COMPUTED summaries: it never needed the table, only
// one summary per column. The caller decides where those come from — Parquet-side
// (statsResident) or a hydrated fold — so a 1M-row dataset is no longer
// materialised to write a dozen lines of prompt.
function buildColumnSummaryText(
  ds: { name: string; rowCount: number; columns: datasets.Dataset['columns'] },
  summaries: ColumnSummary[],
): string {
  const lines: string[] = [];
  lines.push(`Dataset: "${ds.name}" (${ds.rowCount} rows, ${ds.columns.length} columns).`);
  lines.push('Columns:');
  ds.columns.forEach((col, c) => {
    const s = summaries[c];
    if (!s) return;
    if (s.type === 'number') {
      lines.push(`- ${s.name} (number): ${s.count ?? 0} numeric values, ${s.nonEmpty} non-empty`);
    } else {
      lines.push(`- ${s.name} (${s.type}): ${s.distinct ?? 0} distinct, ${s.nonEmpty} non-empty`);
    }
  });
  return lines.join('\n');
}

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

// Mirrors the private set at transforms.ts:101. `visuals.sanitizeFilters`
// already guarantees a valid op, so this is defence against a future divergence,
// not a live case — an unknown op would make transforms warn, and a warning is
// exactly what disqualifies the fast path.
const FILTER_OPS: ReadonlySet<string> = new Set([
  '=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty',
]);

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
    if (!src) return null;

    // The warning-freedom proof (see above). Column identity is exact and
    // case-sensitive, matching `transforms.colIndex`.
    const names = new Set<string>();
    for (const c of src.columns) if (c && typeof c.name === 'string') names.add(c.name);
    if (!names.has(encoding.category)) return null;
    for (const v of values) if (!names.has(v.column)) return null;
    for (const f of filters) {
      if (!f || f.type !== 'filter' || !names.has(f.column) || !FILTER_OPS.has(f.op)) return null;
    }

    // In an aggregated build `buildVizData` coerces a 'none' measure to 'sum'
    // AND relabels it ("sum of price", vizData.ts:133) so the legend never
    // understates the value. Coercing here reproduces both at once, because
    // `residentQuery.measureLabel` derives the name from the same aggregation.
    const measures: ResidentMeasure[] = values.map((v) => ({
      column: v.column,
      aggregation: v.aggregation === 'none' ? 'sum' : v.aggregation,
    }));

    const chart = aggregateResident(src, encoding.category, measures, filters);
    if (!chart) return null; // bridge down / query failed → JS path

    return {
      data: { labels: chart.labels, series: chart.series },
      // Pure, cheap, and needs only columns — call the real thing rather than
      // reimplementing the classification.
      recommendedShape: recommendChartType(src.columns, encoding).shape,
      warnings: [],
    };
  } catch (_) {
    return null;
  }
}

/** The reply shape of `visual:data`. `tooLarge` is only ever set by a caller
 *  that supplied `maxHydrateRows` (see below); `visual:data` itself never does. */
export type VizDataReply =
  | { ok: true; data: VizDataResult['data']; recommendedShape: string; warnings: string[] }
  | { ok: false; error: string; tooLarge?: true };

/**
 * THE one function that turns (dataset, encoding, filters) into chart data.
 *
 * Extracted from the `visual:data` handler so that ANY other caller which needs
 * "what will this chart show?" — notably the analysis-plan PREVIEW — goes
 * through the identical resident-then-JS decision with the identical arguments.
 * That is not a tidiness point: it is the reason a previewed chart and the
 * chart the built Visual renders cannot disagree. Same function, same inputs,
 * same output.
 *
 * Takes ALREADY-SANITIZED encoding/filters, exactly like `residentVizData`.
 *
 * `maxHydrateRows` is an OPTIONAL cost ceiling on the JS fallback, and it is a
 * cost model rather than a flag. `visual:data` omits it (one chart, drawn
 * because the user is looking at it, may pay ~1.2 s to hydrate 1M rows). The
 * plan preview supplies one, because it draws EVERY chart in the plan at once:
 * eight charts × a full 1M-row hydrate each is ~9 s and eight table copies
 * resident in main's heap. Above the ceiling the honest answer is "no preview
 * for this card", never a slow one and never a guessed one.
 */
export async function vizDataFor(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  opts: { maxHydrateRows?: number } = {},
): Promise<VizDataReply> {
  // Fast path: an aggregated chart over a resident (v3) dataset, answered
  // without hydrating a single row. Returns null unless provably identical.
  const fast = await residentVizData(projectId, datasetId, encoding, filters);
  if (fast) return { ok: true, data: fast.data, recommendedShape: fast.recommendedShape, warnings: fast.warnings };

  if (typeof opts.maxHydrateRows === 'number') {
    // Metadata read — one small JSON, no rows, no migration.
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) return { ok: false, error: 'Dataset not found' };
    if (meta.rowCount > opts.maxHydrateRows) {
      return { ok: false, error: 'Too large to preview without the DuckDB bridge', tooLarge: true };
    }
  }

  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { ok: false, error: 'Dataset not found' };
  const result = buildVizData(ds.columns, ds.rows, encoding, filters);
  return { ok: true, data: result.data, recommendedShape: result.recommendedShape, warnings: result.warnings };
}

export function register() {
  ipcMain.handle('visual:list', async (_e, { projectId }: any = {}) => visuals.listVisuals(projectId));

  ipcMain.handle('visual:get', async (_e, { projectId, id }: any = {}) => visuals.getVisual(projectId, id));

  ipcMain.handle('visual:save', async (_e, { projectId, datasetId, name, chartType, encoding, overrides, filters }: any = {}) => {
    try {
      const saved = await visuals.saveVisual(projectId, { name, datasetId, chartType, encoding, overrides, filters });
      if (!saved) return { ok: false, error: 'Invalid project/dataset, or it no longer exists' };
      return saved;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the visual' };
    }
  });

  ipcMain.handle('visual:update', async (_e, { projectId, id, name, chartType, encoding, overrides, filters }: any = {}) => {
    try {
      const visual = await visuals.updateVisual(projectId, id, { name, chartType, encoding, overrides, filters });
      return visual ? { ok: true, visual } : { ok: false, error: 'Could not update the visual' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the visual' };
    }
  });

  ipcMain.handle('visual:delete', async (_e, { projectId, id }: any = {}) => ({
    ok: await visuals.deleteVisual(projectId, id),
  }));

  // Duplicate a saved visual into an independent copy (new UUID, name + " (copy)",
  // dataset/encoding/type/overrides/filters copied). Returns the new Visual.
  ipcMain.handle('visual:duplicate', async (_e, { projectId, id }: any = {}) => {
    try {
      const copy = await visuals.duplicateVisual(projectId, id);
      return copy ? { ok: true, visual: copy } : { ok: false, error: 'Could not duplicate the visual' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to duplicate the visual' };
    }
  });

  // Load the dataset's DERIVED columns/rows and run the pure bridge. The encoding
  // and filters are untrusted renderer input → sanitized before the math. Visual
  // filters (transforms filter steps) are applied to rows BEFORE aggregation.
  ipcMain.handle('visual:data', async (_e, { projectId, datasetId, encoding, filters }: any = {}) => {
    try {
      // Sanitisation FIRST, always — the encoding and the filters are untrusted
      // renderer input, and both paths below consume the sanitized values.
      const enc = sanitizeEncoding(encoding);
      const flt = visuals.sanitizeFilters(filters);
      return await vizDataFor(projectId, datasetId, enc, flt);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the visual data' };
    }
  });

  // OPTIONAL AI chart suggestion. Builds the SAME compact column summary (app-
  // computed stats as facts), asks the model to propose STRUCTURE ONLY (a single
  // encoding + chart type referencing the given columns), sanitizes it, and returns
  // it WITHOUT saving — the renderer populates the builder for the user to review.
  // No model configured → { ok:false, notReady:true } for a gentle hint.
  ipcMain.handle('visual:suggest', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      // Fast path: metadata + Parquet-side summaries, no table hydrated. This
      // prompt is a dozen lines of column stats — it never justified loading a
      // million rows. Falls back whole, never half.
      let summaryText: string | null = null;
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      const src = await datasets.residentSource(projectId, datasetId);
      if (meta && src) {
        const summaries = computeColumnSummariesResident(src);
        if (summaries) summaryText = buildColumnSummaryText(meta, summaries);
      }
      if (summaryText === null) {
        const ds = await datasets.getDataset(projectId, datasetId);
        if (!ds) return { ok: false, error: 'Dataset not found' };
        const summaries = ds.columns.map((col, c) =>
          computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
        );
        summaryText = buildColumnSummaryText(ds, summaries);
      }
      const res = await suggestChart(summaryText);
      if (res.ok) {
        return { ok: true, encoding: sanitizeEncoding(res.encoding), chartType: sanitizeChartType(res.chartType) };
      }
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not suggest a chart' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to suggest a chart' };
    }
  });
}
