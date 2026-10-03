import * as appPaths from '../app/paths';
import { ipcMain } from './bus';
import * as fs from 'fs';
import * as path from 'path';
import * as visuals from '../analysis/visuals';
import * as answerKey from '../data/answerKey';
import * as queryCache from '../engine/queryCache';
import * as datasets from '../data/datasets';
import { buildVizData } from '../analysis/vizData';
import type { VizDataResult } from '../analysis/vizData';
import * as trace from '../engine/residentTrace';
// The two resident fast paths `vizDataFor` tries before hydrating a row.
import { residentPivotData, residentVizData } from './visualsResident';
import { lodVizFor } from './lodData';
import { residentEngineData } from './visualsEngines';
import { authoringVizData } from './vizExtras';
import { withPeriodOverlay } from './visualsOverlay';
import { sampledVizData } from './vizSampleData';
import type { SampleInfo } from '../analysis/sampling';
import { withAnalytics } from './visualsAnalytics';
import { withEvents } from './events'; // r8:events
import { sanitizeOverlays } from '../analysis/analytics';
import { withTableCalcs } from '../analysis/tableCalc';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import { paramTable } from '../data/paramReplay';
import { sanitizeEncoding, sanitizeChartType } from '../analysis/visuals';
import type { VizEncoding } from '../analysis/visuals';
import type { Cell, FilterStep } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import { coerceValue } from '../data/parse';
import { CATEGORY_CAP, OTHER_LABEL } from '../analysis/categoryKey';
// The drill-down panel pages rows through the SAME two-path decision the Explore
// grid uses — see `pageFor`'s note on why there is only one of them.
import { pageFor } from './datasets';
import { MAX_LIMIT } from '../engine/datasetPage';
import type { PageRequest } from '../engine/datasetPage';
import { computeColumnSummariesResident } from '../engine/statsResident';
import { computeColumnSummary } from '../data/datasetStats';
import type { ColumnSummary } from '../data/datasetStats';
import { suggestCharts } from '../ai/analyze';
import * as versions from '../app/versions';
import * as trash from '../app/trash';
import { applyToChart, rowShaper } from '../app/sharePolicy';
import { isSharePath } from '../app/privacyStore';
import { withAsOf } from '../data/asOf';
import { driversVizData } from './drivers';
import { facetVizData, isFaceted } from './visualsFacets';
import { buildFacetData } from '../analysis/facets';
import { fxScope, fxVizContext, fxVizData } from './fxQuery';
import type { FxInfo } from '../analysis/fx';

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

// How many charts `visual:suggest` asks for, and the cap on each caption. Three
// fits the picker without scrolling and is three real model-side proposals, not
// one restyled; 120 chars is a caption, past which it is prose.
const SUGGEST_COUNT = 3;
const WHY_MAX = 120;

// ── Drill-down: the rows behind ONE mark ────────────────────────────────────
//
// The app's core claim is that it does the math and never invents a figure.
// This is the check on that claim: click a bar and get the rows it was computed
// from. Which means the row set has to be EXACTLY the aggregate's input — not a
// close one. A drill that quietly returns a superset would contradict the number
// printed above it, which is worse than having no drill at all.
//
// So the composition is deliberately dumb: the filter list that produced the
// figure, plus one equality filter per clicked axis, evaluated by the same
// compiler (`residentQuery.filterPredicates` via `datasetPage`). Everything that
// cannot be expressed that way REFUSES, with a sentence saying why.
//
// ── What can be re-derived, and what cannot ─────────────────────────────────
// `buildVizData` has three branches. (A) aggregated and (B) split/pivot are
// group-bys — a mark IS a group, and a group is exactly `category = X` (and, for
// (B), `AND series = Y`). (C) raw is not: it plots one point per ROW, several
// rows can share a label, and "the rows with this label" would be a superset of
// the single row clicked. Geo is not either: a region is a set of names matched
// by `geoMatch`, not one cell value.
//
// ── The ambiguity that is easy to miss ──────────────────────────────────────
// A group key and its LABEL are not the same thing. On a text column, `null` and
// `''` are two distinct groups (two bars) that both render with a blank label,
// and the string filter `= ''` matches both — so drilling a blank label could
// return two bars' worth of rows for one bar. On a number column the empty group
// is labelled `''` too, and `= ''` there matches nothing at all. Both are
// refused rather than approximated: a blank label cannot identify one group.
//
// Likewise a number column can only be matched on a value that survives
// `parse.coerceValue` — `isFiniteNumber` is strict, so a label that does not
// round-trip (an exponent form, say) is refused instead of matching zero rows
// under a non-zero bar.

/** The clicked mark: the category label and, on a split chart, the series name. */
export interface DrillMark {
  category?: Cell;
  series?: Cell;
}

export type DrillResolution =
  | { available: true; filters: FilterStep[] }
  | { available: false; reason: string };

function markValue(v: unknown): Cell | undefined {
  if (typeof v === 'string' || typeof v === 'number') return v;
  return undefined;
}

/**
 * The filter list whose rows are exactly the mark's input, or a refusal.
 *
 * PURE — columns/encoding/filters/mark in, filters or a reason out. `filters` is
 * the list that produced the FIGURE (the visual's own filters merged with the
 * sheet's, in the caller's order), and is returned unchanged at the head of the
 * result so the panel can show it as chips.
 *
 * With NO mark this cannot fail on chart shape: the caller is asking for the
 * rows behind the whole visual, which is just its filters — that is the drill
 * entry point for maps and tables, where there is no mark to hit-test.
 */
export function resolveDrill(
  columns: ParsedColumn[],
  encoding: VizEncoding,
  filters: FilterStep[],
  mark?: DrillMark,
): DrillResolution {
  const base = Array.isArray(filters) ? filters.slice() : [];
  const cols = Array.isArray(columns) ? columns : [];
  const category = markValue(mark?.category);
  const series = markValue(mark?.series);
  if (category === undefined && series === undefined) return { available: true, filters: base };

  if (!encoding) return { available: false, reason: 'This visual has no encoding to identify the clicked mark by.' };
  if (encoding.geo) {
    return {
      available: false,
      reason:
        'A map region is matched to rows by NAME, not by one cell value, so the exact rows behind a region cannot be listed. Use ⋯ → Show underlying rows for the whole visual.',
    };
  }
  const values = Array.isArray(encoding.values) ? encoding.values : [];
  if (values.length > 0 && values.every((v) => v.aggregation === 'none')) {
    return {
      available: false,
      reason:
        'This chart plots one point per row rather than groups, so a point is a single row and not a set that can be re-derived by filtering.',
    };
  }
  if (typeof encoding.category !== 'string' || encoding.category === '') {
    return { available: false, reason: 'This visual has no category column, so a mark identifies nothing.' };
  }

  const hasSplit = typeof encoding.series === 'string' && encoding.series.length > 0;
  if (category === undefined) {
    return { available: false, reason: 'The clicked mark carries no category value.' };
  }
  // A mark on a split chart is a (category, series) CELL. Either half alone
  // selects a whole row or column of the pivot — a superset of what was clicked.
  if (hasSplit && series === undefined) {
    return {
      available: false,
      reason: 'This chart is split into series, so a mark needs both a category and a series to identify its rows.',
    };
  }
  if (!hasSplit && series !== undefined) {
    return { available: false, reason: 'This chart has no split column, so the clicked series cannot be resolved.' };
  }

  // A GROUPED chart's category axis is now bucketed (analysis/categoryKey): a
  // number column becomes ten ranges, a date column a grain, a text column its
  // top 50 plus 'Other'. A bucket LABEL is not a cell value, so `= '2023-01'`
  // on a date column stored as '2023-01-05' would return no rows under a
  // non-empty bar — the exact contradiction this whole panel exists to rule
  // out. Number and date are refused outright; a text bucket is still an exact
  // key EXCEPT 'Other', which is a set of keys and ambiguous besides (a real
  // category may literally be called Other).
  const catCol = cols.find((c) => c && c.name === encoding.category);
  if (catCol && catCol.type === 'number') {
    return {
      available: false,
      reason: `"${encoding.category}" is a number, so this axis is grouped into ranges rather than single values — a bar covers a span, not one value, so its rows cannot be identified by an exact match.`,
    };
  }
  if (catCol && catCol.type === 'date') {
    return {
      available: false,
      reason: `"${encoding.category}" is a date, so this axis is rolled up to a period rather than single days — a bar covers a range of dates, so its rows cannot be identified by an exact match.`,
    };
  }
  if (category === OTHER_LABEL) {
    return {
      available: false,
      reason: `"${OTHER_LABEL}" is every category outside the top ${CATEGORY_CAP}, not one of them, so the exact rows behind it cannot be listed.`,
    };
  }

  const steps: FilterStep[] = [];
  const cat = markStep(cols, encoding.category, category);
  if ('reason' in cat) return { available: false, reason: cat.reason };
  steps.push(cat.step);
  if (hasSplit) {
    const ser = markStep(cols, encoding.series as string, series as Cell);
    if ('reason' in ser) return { available: false, reason: ser.reason };
    steps.push(ser.step);
  }
  return { available: true, filters: base.concat(steps) };
}

/**
 * One clicked axis → one equality filter, or the reason it cannot be one.
 *
 * The value is compared AS THE LABEL CARRIED IT. Every column is stored VARCHAR
 * and the label came from those same cells, so an `=` on the raw string is
 * exact — no trimming, no coercion, `007` stays `007`.
 */
function markStep(
  cols: ParsedColumn[],
  column: string,
  value: Cell,
): { step: FilterStep } | { reason: string } {
  const col = cols.find((c) => c && c.name === column);
  if (!col) {
    return {
      reason: `"${column}" is not a stored column of this dataset, so the rows behind this mark cannot be looked up.`,
    };
  }
  // A blank label does not identify a group: `null` and `''` are two groups that
  // both render blank, and on a number column blank is the no-value group, which
  // no equality filter selects.
  if (value === null || String(value).trim() === '') {
    return {
      reason: `The clicked mark has a blank "${column}", which can mean either an empty value or a missing one — those are different rows, so the exact set is ambiguous.`,
    };
  }
  if (col.type === 'number' && coerceValue(value, 'number') === null) {
    return {
      reason: `"${String(value)}" is not a value the number column "${column}" can be matched on, so its rows cannot be identified exactly.`,
    };
  }
  return { step: { type: 'filter', column, op: '=', value } };
}

// ── CSV export of the drilled rows ──────────────────────────────────────────

/** Past this many rows the export asks first. */
const EXPORT_WARN_ROWS = 1_000_000;

/**
 * How many rows one read pulls across the bridge.
 *
 * `datasetPage.MAX_LIMIT`, i.e. the largest window the paged read will serve.
 * Each read is ONE bounded call — the same call the Explore grid makes for a
 * page — and the loop yields to the event loop between them, so a long export
 * costs many short blocks rather than one long freeze of every window, the menu
 * bar and the hotkey.
 */
const EXPORT_CHUNK = MAX_LIMIT;

/**
 * One CSV record, RFC-4180.
 *
 * Quote only when required (a comma, a quote or a line break), doubling any
 * embedded quote. A null cell is an EMPTY FIELD, not the text "null" — and an
 * empty field is distinguishable from a quoted empty string, which is as close
 * as CSV gets to preserving the `null` vs `''` distinction the storage layer
 * keeps.
 *
 * NOTE: no BOM, here or at the head of the file. `src/duckdb.ts` loses a leading
 * U+FEFF from every string it returns and `datasetPage` already repairs that on
 * projection, so cells arrive here correct; prepending a BOM for a spreadsheet's
 * benefit would corrupt a cell that legitimately starts with one.
 */
export function csvLine(cells: readonly Cell[]): string {
  return cells
    .map((c) => {
      if (c == null) return '';
      const s = String(c);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    })
    .join(',');
}

/** `price by region` → `price-by-region.csv`, and never a path. */
function csvFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return (slug || 'underlying-rows') + '.csv';
}

/**
 * Stream the filtered row set to `filePath`, a window at a time.
 *
 * Nothing bigger than one window is ever resident: rows are read in chunks,
 * written, and dropped. Backpressure is honoured (`write` returning false waits
 * for `drain`), which is also what yields the event loop between reads.
 *
 * `total` bounds the loop, so a table that grows under the export cannot make it
 * run away — the file is the row set as counted, which is the count the panel
 * showed.
 */
async function writeDrillCsv(
  filePath: string,
  projectId: string,
  datasetId: string,
  base: PageRequest,
  columns: ParsedColumn[],
  total: number,
  shapeRow: (r: Cell[]) => Cell[] = (r) => r,
): Promise<number> {
  const out = fs.createWriteStream(filePath, { encoding: 'utf8' });
  const write = (s: string): Promise<void> =>
    new Promise((resolve, reject) => {
      out.once('error', reject);
      if (out.write(s)) resolve();
      else out.once('drain', () => resolve());
    });

  let written = 0;
  try {
    await write(csvLine(columns.map((c) => c.name)) + '\r\n');
    for (let offset = 0; offset < total; offset += EXPORT_CHUNK) {
      const res = await pageFor(projectId, datasetId, { ...base, offset, limit: EXPORT_CHUNK }, 'drillExport');
      if (!res.ok || res.rows.length === 0) break;
      await write(res.rows.map((r) => csvLine(shapeRow(r))).join('\r\n') + '\r\n');
      written += res.rows.length;
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return written;
}

/** The reply shape of `visual:data`. `tooLarge` is only ever set by a caller
 *  that supplied `maxHydrateRows` (see below); `visual:data` itself never does. */
export type VizDataReply =
  | {
      ok: true;
      data: VizDataResult['data'];
      recommendedShape: string;
      warnings: string[];
      /** How the category axis was bucketed — see analysis/categoryKey. */
      category?: VizDataResult['category'];
      /** Present when a period overlay was drawn — see ./visualsOverlay. */
      overlay?: { kind: 'previous_year'; caption?: string; pct?: number };
      /** Present when the BUILDER preview was computed on a sample — see ./vizSampleData. */
      sample?: SampleInfo & { note: string };
      /** Present when a money measure was converted — see ./fxQuery. */
      fx?: FxInfo;
    }
  | { ok: false; error: string; tooLarge?: true };

/** The JS fallback's cost ceiling (below): a reply when it is exceeded, else null. */
async function overCeiling(projectId: string, datasetId: string, max?: number): Promise<VizDataReply | null> {
  if (typeof max !== 'number') return null;
  // Metadata read — one small JSON, no rows, no migration.
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  if (meta.rowCount > max) {
    return { ok: false, error: 'Too large to preview without the DuckDB bridge', tooLarge: true };
  }
  return null;
}

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
  opts: { maxHydrateRows?: number; params?: ParamValues; sample?: boolean } = {},
): Promise<VizDataReply> {
  // The answer cache (engine/queryCache): a dashboard re-open, a type switch in
  // the builder or a tab coming back asks the same question over unchanged
  // data. Only successful answers are kept; an error is recomputed every time.
  const parts = await answerKey.keyParts(projectId, datasetId);
  if (!parts) return computeVizData(projectId, datasetId, encoding, filters, opts);
  const op = encoding && encoding.pivot ? 'pivot' : 'aggregate';
  const fxc = await fxVizContext(projectId, datasetId, encoding, filters);
  const key = queryCache.cacheKey(op, parts, {
    encoding, filters, params: opts.params ?? null, max: opts.maxHydrateRows ?? null, sample: opts.sample === true,
    ...answerKey.ambient(), fx: fxc ? fxc.key : undefined,
  });
  return queryCache.through(op, key, [datasetId, queryCache.projectDep(projectId)],
    () => computeVizData(projectId, datasetId, encoding, filters, opts), (r) => r.ok);
}

async function computeVizData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  opts: { maxHydrateRows?: number; params?: ParamValues; sample?: boolean },
): Promise<VizDataReply> {
  // A key-drivers waterfall tile is a QUESTION, answered afresh (ipc/drivers.ts).
  if (encoding && encoding.drivers) return driversVizData(projectId, datasetId, encoding, filters, opts.params);
  const converted = await fxVizData(projectId, datasetId, encoding, filters, opts); // money measures, in the target currency
  if (converted) return converted;
  // A pipeline that references a dashboard parameter answers from the dataset
  // REPLAYED with the query's values bound (data/paramReplay.ts) — the stored
  // table holds those fields unbound. Everything else is untouched below.
  const replay = await paramTable(projectId, datasetId, opts.params);
  if (replay) {
    const r = (isFaceted(encoding) ? buildFacetData : buildVizData)(replay.columns, replay.rows, encoding, filters);
    return {
      ok: true, data: r.data, recommendedShape: r.recommendedShape,
      warnings: r.warnings.concat(replay.errors), category: r.category,
    };
  }

  // Small multiples: one grouped query with the facet dims added (./visualsFacets).
  const faceted = await facetVizData(projectId, datasetId, encoding, filters, (e, f) => vizDataFor(projectId, datasetId, e, f, opts), opts.maxHydrateRows);
  if (faceted) return faceted;
  // r7:lod — context filters or an INCLUDE/EXCLUDE field: the LOD pass first.
  const lod = await lodVizFor(projectId, datasetId, encoding, filters, opts.maxHydrateRows);
  if (lod) return lod;
  // A field or filter from a RELATED dataset, or a map: vizExtras answers instead.
  // Every map hydrates (no resident path draws one), so the ceiling holds first.
  if (encoding && encoding.geo) {
    const over = await overCeiling(projectId, datasetId, opts.maxHydrateRows);
    if (over) return over;
  }
  const joined = await authoringVizData(projectId, datasetId, encoding, filters);
  if (joined) return joined;
  const engine = await residentEngineData(projectId, datasetId, encoding, filters); // cohort / event funnel
  if (engine) return { ok: true, data: engine.data, recommendedShape: engine.recommendedShape, warnings: engine.warnings };
  // Fast path: an aggregated chart (or a pivot) over a resident (v3) dataset,
  // answered without hydrating a single row. Null unless provably identical.
  const fast = encoding && encoding.pivot
    ? await residentPivotData(projectId, datasetId, encoding, filters)
    : await residentVizData(projectId, datasetId, encoding, filters);
  if (fast) {
    return {
      ok: true,
      data: fast.data,
      recommendedShape: fast.recommendedShape,
      warnings: fast.warnings,
      category: fast.category,
    };
  }

  const over = await overCeiling(projectId, datasetId, opts.maxHydrateRows);
  if (over) return over;

  // The builder's preview (`visual:preview`) samples a big table here rather
  // than hydrate all of it on every edit — and says so on the reply.
  if (opts.sample) {
    const sampled = await sampledVizData(projectId, datasetId, encoding, filters);
    if (sampled) return sampled;
  }

  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { ok: false, error: 'Dataset not found' };
  const result = buildVizData(ds.columns, ds.rows, encoding, filters);
  return {
    ok: true,
    data: result.data,
    recommendedShape: result.recommendedShape,
    warnings: result.warnings,
    category: result.category,
  };
}

export function register() {
  ipcMain.handle('visual:list', async (_e, { projectId }: any = {}) => visuals.listVisuals(projectId));

  ipcMain.handle('visual:get', async (_e, { projectId, id }: any = {}) => visuals.getVisual(projectId, id));

  ipcMain.handle('visual:save', async (_e, { projectId, datasetId, name, chartType, encoding, overrides, filters, analytics }: any = {}) => {
    try {
      const saved = await visuals.saveVisual(projectId, { name, datasetId, chartType, encoding, overrides, filters, analytics });
      if (!saved) return { ok: false, error: 'Invalid project/dataset, or it no longer exists' };
      await versions.record(projectId, 'visual', saved);
      return saved;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the visual' };
    }
  });

  ipcMain.handle('visual:update', async (_e, { projectId, id, name, chartType, encoding, overrides, filters, favorite, analytics }: any = {}) => {
    try {
      const before = await visuals.getVisual(projectId, id);
      const visual = await visuals.updateVisual(projectId, id, { name, chartType, encoding, overrides, filters, favorite, analytics });
      if (visual) await versions.record(projectId, 'visual', visual, { before });
      return visual ? { ok: true, visual } : { ok: false, error: 'Could not update the visual' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the visual' };
    }
  });

  // To the Trash. `permanent` is for undoing an Assistant edit that CREATED the
  // visual — taking back your own draft is not a delete to keep for 30 days.
  ipcMain.handle('visual:delete', async (_e, { projectId, id, permanent }: any = {}) => {
    if (permanent !== true) return trash.trashRecord(projectId, 'visual', id);
    await versions.forget(projectId, 'visual', id);
    return { ok: await visuals.deleteVisual(projectId, id) };
  });

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
  //
  // `share` ('export' | 'report' | 'publish') marks a request whose answer is
  // about to LEAVE the app: the project's Share policy is applied to the reply
  // here, after vizDataFor, so a cached answer is shaped on its way out and the
  // cache never holds a masked one (app/sharePolicy.ts).
  // `asOf` (view state, data/asOf.ts): every dataset read as of that time.
  ipcMain.handle('visual:data', async (_e, { projectId, datasetId, encoding, filters, params, share, analytics, asOf, currency }: any = {}) => withAsOf(projectId, asOf, () => fxScope(currency, async () => {
    try {
      // Sanitisation FIRST, always — the encoding and the filters are untrusted
      // renderer input, and both paths below consume the sanitized values.
      // Then the dashboard's parameters, through the one resolver: a filter
      // value `[[threshold]]` becomes the typed value it names.
      const enc = sanitizeEncoding(encoding);
      const values = paramValues(params);
      const bound = resolveFilterParams(visuals.sanitizeFilters(filters), values);
      const flt = bound.steps;
      // Table calculations run on the aggregated grid, after either path (and
      // on the overlay's prior slice alike, so both sides mean the same thing).
      const run = async (p: string, d: string, e: VizEncoding, f: FilterStep[]) =>
        withTableCalcs(await vizDataFor(p, d, e, f, { params: values }), e);
      const computed = await withPeriodOverlay(await run(projectId, datasetId, enc, flt), projectId, datasetId, enc, flt, run);
      const shaped = isSharePath(share) && share !== 'bundle'
        ? await applyToChart(projectId, datasetId, enc, computed, share)
        : computed;
      // The Analytics pane's overlays, resolved on the finished reply under the
      // same scope — AFTER the share policy, so an overlay can only name what
      // the shaped chart still shows.
      const reply = await withEvents(await withAnalytics(shaped, projectId, sanitizeOverlays(analytics), flt, values), projectId, datasetId, flt); // r8:events
      // A parameter that cannot be made well-typed is a VALIDATION message the
      // tile shows — never a silently empty chart.
      return reply.ok && bound.errors.length
        ? { ...reply, warnings: reply.warnings.concat(bound.errors), paramErrors: bound.errors }
        : reply;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the visual data' };
    }
  })));

  // ── The rows behind one mark (drill-down) ────────────────────────────────
  //
  // A READ, and only a read: it writes no filter, touches no card, and works on
  // a published snapshot exactly as on an authoring surface. The caller passes
  // the SAME filter list it passed to `visual:data` (the visual's own filters
  // merged with the sheet's) — resolved by the renderer, which is where a
  // published card's frozen `card.visual` definition wins over `card.visualId`.
  // Main never re-resolves the visual, so a snapshot drills against what it was
  // published with rather than a later edit.
  //
  // Returns the resolved filter list so the panel can render it as chips, or
  // `available: false` + a reason when the row set cannot be derived faithfully.
  ipcMain.handle('visual:rows', async (_e, { projectId, datasetId, encoding, filters, mark, page, params, asOf }: any = {}) => withAsOf(projectId, asOf, async () => {
    try {
      // Untrusted renderer input, sanitized before anything reads it — the same
      // two whitelists `visual:data` runs, and the same parameter resolution,
      // so the rows behind a mark are selected by the filters that drew it.
      const enc = sanitizeEncoding(encoding);
      const flt = resolveFilterParams(visuals.sanitizeFilters(filters), paramValues(params)).steps;

      // Metadata only: the column list is all `resolveDrill` needs, and the grid
      // needs it for headers. No rows are hydrated to answer a refusal.
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      if (!meta) return { ok: false, error: 'Dataset not found' };

      const resolved = resolveDrill(meta.columns, enc, flt, mark);
      if (!resolved.available) return { ok: true, available: false, reason: resolved.reason };

      const p = page && typeof page === 'object' ? page : {};
      const req: PageRequest = {
        offset: p.offset,
        limit: p.limit,
        search: p.search,
        sortColumn: p.sortColumn,
        sortDir: p.sortDir,
        filters: resolved.filters,
      };
      const res = await pageFor(projectId, datasetId, req, 'drillRows');
      if (!res.ok) return res;
      return {
        ok: true,
        available: true,
        filters: resolved.filters,
        columns: meta.columns,
        rows: res.rows,
        total: res.total,
        offset: res.offset,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to read the underlying rows' };
    }
  }));

  // ── The drilled rows as a CSV file ───────────────────────────────────────
  //
  // Plain-text row export — NOT the spreadsheet export CLAUDE.md lists as out of
  // scope. No xlsx, no formatting, no new dependency: RFC-4180 text, UTF-8, one
  // header line, written with `fs`.
  //
  // It re-resolves the drill from the SAME arguments the panel resolved, so the
  // file is the grid: same filters, same search, same order. A refusal here is
  // the same refusal the panel got, and the panel disables the button on one
  // anyway — this is the second lock, not the first.
  ipcMain.handle('visual:rowsExport', async (_e, { projectId, datasetId, encoding, filters, mark, page, name, params, asOf }: any = {}) => withAsOf(projectId, asOf, async () => {
    try {
      const enc = sanitizeEncoding(encoding);
      const flt = resolveFilterParams(visuals.sanitizeFilters(filters), paramValues(params)).steps;
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      if (!meta) return { ok: false, error: 'Dataset not found' };

      const resolved = resolveDrill(meta.columns, enc, flt, mark);
      if (!resolved.available) return { ok: false, error: resolved.reason };

      const p = page && typeof page === 'object' ? page : {};
      const base: PageRequest = {
        offset: 0,
        limit: 0, // count only — `readPage` short-circuits before reading a row
        search: p.search,
        sortColumn: p.sortColumn,
        sortDir: p.sortDir,
        filters: resolved.filters,
      };
      const counted = await pageFor(projectId, datasetId, base, 'drillExport');
      if (!counted.ok) return counted;
      // Desktop-only (native dialogs); required here so the server loads this module without Electron.
      const { dialog } = (require('electron') as typeof import('electron'));
      const total = counted.total;
      if (total === 0) return { ok: false, error: 'There are no rows to export.' };

      // The cap IS the filtered total — the file is the row set the panel is
      // showing, never more. Past a million rows say so BEFORE writing: a
      // warning that arrives after a 1M-row file has been written is not a
      // warning. (The import cap is 1,000,000, so this is a backstop for a
      // future raise rather than a live case today.)
      if (total > EXPORT_WARN_ROWS) {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Export anyway', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `This will write ${total.toLocaleString()} rows.`,
          detail: 'A file this large can take a while to write and to open.',
        });
        if (response !== 0) return { ok: false, canceled: true };
      }

      const safe = csvFileName(name);
      const { filePath, canceled } = await dialog.showSaveDialog({
        title: 'Export these rows',
        defaultPath: path.join(appPaths.downloads(), safe),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };

      // The rows LEAVE the app here, so the Share policy shapes them: a
      // sensitive column is masked or dropped from the header and every row.
      const shaper = await rowShaper(projectId, datasetId, meta.columns, 'export');
      const written = await writeDrillCsv(filePath, projectId, datasetId, base, shaper.columns, total, shaper.row);
      return { ok: true, dest: filePath, rows: written };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to export the rows' };
    }
  }));

  // OPTIONAL AI chart suggestion. Builds the SAME compact column summary (app-
  // computed stats as facts), asks the model to propose STRUCTURE ONLY (an
  // encoding + chart type + a short structural caption, referencing the given
  // columns), sanitizes every option, and returns them WITHOUT saving — the
  // renderer draws each one for the user to pick from.
  // No model configured → { ok:false, notReady:true } for a gentle hint.
  //
  // `intent` is the user's own words. It is UNTRUSTED and goes to the model in
  // the USER message (see analyze.suggestCharts), never the system prompt.
  ipcMain.handle('visual:suggest', async (_e, { projectId, datasetId, intent }: any = {}) => {
    try {
      // Fast path: metadata + Parquet-side summaries, no table hydrated. This
      // prompt is a dozen lines of column stats — it never justified loading a
      // million rows. Falls back whole, never half.
      let summaryText: string | null = null;
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      const src = await datasets.residentSource(projectId, datasetId);
      if (meta && src) {
        const summaries = computeColumnSummariesResident(src);
        if (summaries) {
          summaryText = buildColumnSummaryText(meta, summaries);
          trace.record('columnSummaries', 'resident');
        } else {
          trace.record('columnSummaries', 'failed', `${meta.rowCount} rows × ${meta.columns.length} cols`);
        }
      } else {
        trace.record('columnSummaries', 'skipped');
      }
      if (summaryText === null) {
        const ds = await datasets.getDataset(projectId, datasetId);
        if (!ds) return { ok: false, error: 'Dataset not found' };
        const summaries = ds.columns.map((col, c) =>
          computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))),
        );
        summaryText = buildColumnSummaryText(ds, summaries);
      }
      const res = await suggestCharts(summaryText, typeof intent === 'string' ? intent : '', SUGGEST_COUNT);
      if (res.ok) {
        // Sanitisation is a security control over MODEL output, exactly as it is
        // over renderer input: the encoding and the type go through the same two
        // whitelists a saved visual does, and `why` is coerced to a bounded
        // string so a runaway caption cannot become the UI.
        const options = res.options.map((o) => ({
          encoding: sanitizeEncoding(o),
          chartType: sanitizeChartType(o.chartType),
          why: typeof o.why === 'string' ? o.why.slice(0, WHY_MAX) : '',
        }));
        return { ok: true, options };
      }
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not suggest a chart' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to suggest a chart' };
    }
  });
}
