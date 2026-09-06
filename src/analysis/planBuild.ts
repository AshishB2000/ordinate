// Plan BUILD — a validated plan turned into real records.
//
// Split out of analysisPlan.ts (.claude/rules/file-size.md): that file validates
// a plan, planPreview.ts shows it, and this one materialises it.
//
// THE ONLY PLACE A DASHBOARD CARD IS BUILT. `buildPlan` puts the cards in a NEW
// Analysis; the starter layouts (starterPlan.ts, via `buildPlanRecords`) put
// them in one that is already open. Same validator, same packer, same
// sanitizeCards — one way tiles get created, whether a model or the app authored
// the plan.

import type { TransformStep } from '../data/transforms';
import * as datasets from '../data/datasets';
import * as visuals from './visuals';
import * as analysis from './analysis';
import * as dashboards from './dashboards';
import type { PlanDrop, PlannedCalcField } from './analysisPlan';
import { loadPlanContext, validatePlan } from './analysisPlan';

export interface BuildResult {
  ok: true;
  analysis: analysis.Analysis;
  /** Ids of the Visuals the build created or reused, in plan order. */
  visualIds: string[];
  /** Calculated fields actually appended as TransformSteps. */
  calculatedFields: { datasetId: string; name: string }[];
  dropped: PlanDrop[];
  /** Pipeline warnings from applying the calculated-field steps. */
  warnings: string[];
}

/** Flow packer, moved verbatim from the old draft handler: visual cards 6×6,
 *  left→right, wrapping at GRID_COLS. The app assigns geometry; the model never
 *  gets to. */
function packer() {
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  return (w: number, h: number) => {
    if (cx + w > dashboards.GRID_COLS) { cx = 0; cy += rowH; rowH = 0; }
    const layout = { x: cx, y: cy, w, h };
    cx += w;
    if (h > rowH) rowH = h;
    return layout;
  };
}

/**
 * Turn an approved plan into real records, through the EXISTING APIs only.
 *
 * Re-validates first, with the same `validatePlan` the preview used: the plan
 * comes back over IPC and is untrusted again, and re-deciding it with the same
 * function on the same context is what makes "what you previewed is what you
 * get" a property rather than a promise.
 *
 * Order mirrors validation: calculated fields become ordinary
 * `calculated_field` TransformSteps FIRST (so a visual encoding against one has
 * its column by the time the Visual is saved), then Visuals, then the Analysis.
 * Nothing here is special-cased: an AI calculated field is removable and
 * reorderable in Prepare exactly like a hand-written one.
 */
export async function buildPlan(
  projectId: string,
  raw: unknown,
): Promise<BuildResult | { ok: false; error: string }> {
  const ctx = await loadPlanContext(projectId);
  const { plan, dropped } = validatePlan(raw, ctx);

  // 1. Calculated fields → TransformSteps, appended to the dataset's existing
  //    pipeline. updateSteps sanitizes, recomputes from the immutable source and
  //    persists — the same call `dataset:addStep` makes.
  const warnings: string[] = [];
  const appliedCalc: { datasetId: string; name: string }[] = [];
  const byDataset = new Map<string, PlannedCalcField[]>();
  for (const cf of plan.calculatedFields) {
    const list = byDataset.get(cf.datasetId) || [];
    list.push(cf);
    byDataset.set(cf.datasetId, list);
  }
  for (const [datasetId, fields] of byDataset) {
    // Metadata read for the EXISTING steps — updateSteps loads the table itself,
    // so there is no reason for this to be a second hydrate.
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) continue;
    const steps: TransformStep[] = Array.isArray(meta.steps) ? meta.steps.slice() : [];
    for (const f of fields) steps.push({ type: 'calculated_field', name: f.name, expression: f.expression });
    const res = await datasets.updateSteps(projectId, datasetId, steps);
    if (!res) continue;
    for (const w of res.output.warnings) warnings.push(w);
    for (const f of fields) appliedCalc.push({ datasetId, name: f.name });
  }

  // 2. Visuals. A referenced saved visual is reused by id — the plan says "put
  //    this chart here", not "make another copy of it".
  const visualIds: string[] = [];
  const sheets: { name: string; cards: unknown[] }[] = [];
  for (const sheet of plan.sheets) {
    // PER SHEET. It used to be created once for the whole plan, outside this
    // loop, so sheet 2's first card inherited sheet 1's cursor and started N
    // rows down its own empty grid — every sheet after the first opened with a
    // band of blank rows above it. Each sheet is its own Page with its own grid.
    const place = packer();
    const cards: unknown[] = [];
    for (const pv of sheet.visuals) {
      let id = pv.visualId;
      if (pv.kind === 'new') {
        const saved = await visuals.saveVisual(projectId, {
          name: pv.name,
          datasetId: pv.datasetId,
          chartType: pv.chartType,
          encoding: pv.encoding,
          filters: pv.filters,
        });
        if (!saved) continue;
        id = saved.id;
      }
      if (!id) continue;
      visualIds.push(id);
      cards.push({ type: 'visual', layout: place(6, 6), visualId: id });
    }
    // sanitizeCards is the same whitelist a hand-built sheet goes through — a
    // sheet IS a dashboards.Page.
    sheets.push({ name: sheet.name, cards: dashboards.sanitizeCards(cards) });
  }

  // 3. The Analysis.
  const saved = await analysis.saveAnalysis(projectId, { name: plan.name, sheets });
  if (!saved) return { ok: false, error: 'Could not create the dashboard' };

  return { ok: true, analysis: saved, visualIds, calculatedFields: appliedCalc, dropped, warnings };
}
