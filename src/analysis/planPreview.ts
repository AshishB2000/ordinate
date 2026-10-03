// Plan PREVIEW — a validated plan rendered as exactly what would be built.
//
// Split out of analysisPlan.ts (.claude/rules/file-size.md): that file validates
// a plan, this one shows it, and planBuild.ts materialises it. The moved code is
// unchanged apart from the `export` keywords and these imports.
//
// The guarantee this module exists to keep: EVERY FIGURE HERE IS COMPUTED BY THE
// SAME FUNCTION THAT WILL COMPUTE IT AFTER THE BUILD. A preview that renders its
// numbers a second way is a preview that can lie.

import type { Cell, FilterStep } from '../data/transforms';
import type { FValue } from '../formula/formula';
import { compile } from '../formula/formula';
import * as datasets from '../data/datasets';
import * as visuals from './visuals';
import type { VizEncoding } from './visuals';
import type { VizDataResult } from './vizData';
import { sampleRowsResident } from '../engine/statsResident';
import type {
  AnalysisPlan, PlanContext, PlanDataset, PlanDrop,
  PlannedControl, PlannedMetric, PlannedText, PlannedVisual,
} from './analysisPlan';
import { loadPlanContext, validatePlan } from './analysisPlan';
// INVERTED IMPORT, deliberately. `vizDataFor` lives beside `residentVizData` in
// src/ipc/visuals.ts because that is where the resident-vs-JS decision for a
// chart already lives, and `register()` is inert until called (the same reason
// scripts/test-analysis.ts imports src/ipc/analyses.ts directly). Reaching for
// it here — rather than reimplementing the decision — is what makes the
// preview/build guarantee structural instead of aspirational.
import { vizDataFor } from '../ipc/visuals';
import { withTableCalcs } from './tableCalc';

/**
 * The JS-fallback ceiling for a PREVIEW chart, in rows. See `vizDataFor`: the
 * preview draws every card at once, so it cannot afford the per-chart hydrate
 * budget `visual:data` can. Resident (Parquet) datasets ignore this entirely —
 * they never hydrate at any size.
 */
export const PREVIEW_MAX_HYDRATE_ROWS = 50_000;

/** Rows evaluated to show a calculated field's sample output. Read off Parquet
 *  with a LIMIT; never a hydrate. */
export const CALC_SAMPLE_ROWS = 8;

export interface CalcFieldPreview {
  datasetId: string;
  datasetName: string;
  name: string;
  expression: string;
  /** Columns the compiled expression reads. */
  refs: string[];
  /** Columns it reads that the dataset does not have (still valid — they yield null). */
  unknownRefs: string[];
  /** Up to CALC_SAMPLE_ROWS real rows with the app-evaluated result. Empty when
   *  the table is not resident — a sample is a nicety, never worth a hydrate. */
  sample: { inputs: Record<string, Cell>; value: FValue }[];
}

export interface VisualPreview {
  sheet: number;
  index: number;
  kind: 'new' | 'existing';
  visualId?: string;
  datasetId: string;
  datasetName: string;
  name: string;
  chartType: string;
  encoding: VizEncoding;
  filters: FilterStep[];
  /** Computed by the SAME function that renders the built Visual, or null. */
  data: VizDataResult['data'] | null;
  recommendedShape: string | null;
  warnings: string[];
  /** Why `data` is null, when it is. Never a figure. */
  note?: string;
}

export interface PlanPreview {
  ok: true;
  name: string;
  rationale: string;
  /**
   * `visuals` carries a computed `data` per card because a chart is the thing a
   * reader cannot check by eye. `metrics` and `texts` pass through VERBATIM: a
   * KPI's figure is computed at render time by the same `dashboard:metric` call
   * the built tile makes, and previewing it here would be this module rendering
   * a number a second way — exactly what its header forbids.
   */
  sheets: {
    name: string;
    metrics: PlannedMetric[];
    visuals: VisualPreview[];
    texts: PlannedText[];
    /** Filter-bar chips, verbatim. A control computes nothing to preview — what
     *  it filters is the reader's own live selection — but a preview that hid
     *  the bar would still be showing less than the build produces. */
    controls: PlannedControl[];
  }[];
  calculatedFields: CalcFieldPreview[];
  dropped: PlanDrop[];
  /** The VALIDATED plan — exactly what to hand back to `buildPlan` on approval.
   *  Returned alongside the preview rather than instead of it, because the plan
   *  is the contract and the preview is only what the user looked at. */
  plan: AnalysisPlan;
}

/**
 * Validate a raw envelope and render a preview of exactly what survived.
 *
 * Costs at most: one small JSON per dataset, one stats query per resident
 * dataset, one aggregate per card, one `LIMIT 8` per calculated field. It does
 * NOT hydrate a table above PREVIEW_MAX_HYDRATE_ROWS and never hydrates one for
 * a sample. Works with no model configured — this is app code.
 *
 * `ctx` is optional purely so `analysis:draft` can reuse the context it already
 * loaded to build the FACTS block; omitting it loads a fresh one.
 */
export async function previewPlan(projectId: string, raw: unknown, ctx?: PlanContext): Promise<PlanPreview> {
  const context = ctx || (await loadPlanContext(projectId));
  const { plan, dropped } = validatePlan(raw, context);
  return previewValidated(projectId, context, plan, dropped);
}

async function previewValidated(
  projectId: string,
  ctx: PlanContext,
  plan: AnalysisPlan,
  dropped: PlanDrop[],
): Promise<PlanPreview> {
  const byId = new Map(ctx.datasets.map((d) => [d.id, d]));

  // Calculated fields: compiled (again — the compile is the validation) and
  // evaluated over real rows by the app's own evaluator.
  const calculatedFields: CalcFieldPreview[] = [];
  for (const cf of plan.calculatedFields) {
    const ds = byId.get(cf.datasetId);
    if (!ds) continue;
    const compiled = compile(cf.expression);
    if (!compiled.ok) continue; // unreachable: validatePlan already dropped it
    const names = new Set(ds.columns.map((c) => c.name));
    const unknownRefs = compiled.fn.refs.filter((r) => !names.has(r));
    const sample: CalcFieldPreview['sample'] = [];
    const src = await datasets.residentSource(projectId, cf.datasetId);
    const rows = src ? await sampleRowsResident(src, CALC_SAMPLE_ROWS) : null;
    if (rows && src) {
      for (const row of rows) {
        const rowMap: Record<string, FValue> = {};
        src.columns.forEach((col, c) => { rowMap[col.name] = (row[c] ?? null) as FValue; });
        const inputs: Record<string, Cell> = {};
        for (const ref of compiled.fn.refs) inputs[ref] = (rowMap[ref] ?? null) as Cell;
        sample.push({ inputs, value: compiled.fn.evaluate(rowMap) });
      }
    }
    calculatedFields.push({
      datasetId: cf.datasetId,
      datasetName: ds.name,
      name: cf.name,
      expression: cf.expression,
      refs: compiled.fn.refs,
      unknownRefs,
      sample,
    });
  }

  const sheets: PlanPreview['sheets'] = [];
  for (let si = 0; si < plan.sheets.length; si += 1) {
    const sheet = plan.sheets[si];
    const out: VisualPreview[] = [];
    for (let vi = 0; vi < sheet.visuals.length; vi += 1) {
      out.push(await previewVisual(projectId, byId, sheet.visuals[vi], si, vi));
    }
    // Metrics and texts are carried through unchanged. Preview and build must
    // agree on the WHOLE sheet: a plan whose KPI row was built but never shown
    // breaks the guarantee at the top of this file just as surely as a wrong
    // figure would.
    sheets.push({
      name: sheet.name,
      metrics: sheet.metrics,
      visuals: out,
      texts: sheet.texts,
      controls: sheet.controls || [],
    });
  }

  return { ok: true, name: plan.name, rationale: plan.rationale, sheets, calculatedFields, dropped, plan };
}

async function previewVisual(
  projectId: string,
  byId: Map<string, PlanDataset>,
  pv: PlannedVisual,
  sheet: number,
  index: number,
): Promise<VisualPreview> {
  const ds = byId.get(pv.datasetId);
  const base: VisualPreview = {
    sheet,
    index,
    kind: pv.kind,
    visualId: pv.visualId,
    datasetId: pv.datasetId,
    datasetName: ds ? ds.name : '',
    name: pv.name,
    chartType: pv.chartType,
    encoding: pv.encoding,
    filters: pv.filters,
    data: null,
    recommendedShape: null,
    warnings: [],
  };

  // An existing saved Visual previews through its OWN stored definition, which
  // is what the analysis will show — never through a re-derived one.
  let encoding = pv.encoding;
  let filters = pv.filters;
  if (pv.kind === 'existing' && pv.visualId) {
    const v = await visuals.getVisual(projectId, pv.visualId);
    if (!v) {
      base.note = 'The saved visual was deleted.';
      return base;
    }
    encoding = v.encoding;
    filters = v.filters;
    base.encoding = encoding;
    base.filters = filters;
    base.chartType = v.chartType;
  }

  // A column that does not exist yet cannot be charted, and an approximation
  // would be a figure the built analysis could contradict. Show nothing.
  if (pv.needsCalcField) {
    base.note = `Chart appears once the calculated field "${pv.needsCalcField}" is created.`;
    return base;
  }

  // Table calculations exactly as `visual:data` applies them (tableCalc.ts), so
  // the preview and the built chart cannot disagree.
  const res = withTableCalcs(await vizDataFor(projectId, pv.datasetId, encoding, filters, {
    maxHydrateRows: PREVIEW_MAX_HYDRATE_ROWS,
  }), encoding);
  if (!res.ok) {
    base.note = res.tooLarge
      ? 'Too large to preview without the DuckDB bridge — the chart renders normally once built.'
      : res.error;
    return base;
  }
  base.data = res.data;
  base.recommendedShape = res.recommendedShape;
  base.warnings = res.warnings;
  return base;
}
