// Plan BUILD — a validated plan turned into real records.
//
// Split out of analysisPlan.ts (.claude/rules/file-size.md): that file validates
// a plan, planPreview.ts shows it, and this one materialises it.
//
// THE ONLY PLACE A DASHBOARD CARD IS BUILT. `buildPlan` puts the cards in a NEW
// Analysis; the starter layouts (starterPlan.ts, via `buildPlanRecords`) put
// them in one that is already open. Same validator, same arrangement
// (planLayout.ts), same sanitizeCards — one way tiles get created, whether a
// model or the app authored the plan.

import type { TransformStep } from '../data/transforms';
import * as datasets from '../data/datasets';
import * as visuals from './visuals';
import * as analysis from './analysis';
import * as dashboards from './dashboards';
import type { PlanDrop, PlannedCalcField, PlannedVisual } from './analysisPlan';
import { loadPlanContext, validatePlan } from './analysisPlan';
import { arrangeSheet } from './planLayout';
import { shapeRows } from './planRows';

/**
 * A plan turned into REAL records, minus the Analysis: the calculated fields and
 * Visuals are already saved, and the cards are handed back for the caller to
 * place. This is the ONE place a dashboard card is built.
 */
export interface PlanRecords {
  name: string;
  sheets: { name: string; cards: unknown[] }[];
  visualIds: string[];
  calculatedFields: { datasetId: string; name: string }[];
  dropped: PlanDrop[];
  warnings: string[];
}

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
export async function buildPlanRecords(projectId: string, raw: unknown): Promise<PlanRecords> {
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
    const cards: unknown[] = [];

    // CONTROLS FIRST, and with a zeroed layout. A control card is a filter-bar
    // chip (dashControlBar.ts), not a cell: the bar reads `layout` only to
    // recover the order the author built them in, and reserving a grid cell for
    // one would leave a hole nothing draws in. So they are never arranged.
    (sheet.controls || []).forEach((c, i) => {
      cards.push({ type: 'control', layout: { x: i, y: 0, w: 0, h: 0 }, control: c });
    });

    // VISUALS ARE SAVED BEFORE ANYTHING IS PLACED. A chart whose save failed is
    // not on the sheet, and a row arranged around it would keep its hole — a
    // spotlight with a rail and no chart beside it. So the sheet is arranged
    // over what survived, and the rows re-form without the ones that did not.
    const savedIds = new Map<PlannedVisual, string>();
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
      savedIds.set(pv, id);
    }
    const alive = sheet.visuals.filter((pv) => savedIds.has(pv));
    const at = arrangeSheet({
      ...sheet,
      visuals: alive,
      rows: sheet.rows && shapeRows(sheet.rows, (pv) => savedIds.has(pv)),
    });

    // THE ORDER OF `cards` IS NOT THE ARRANGEMENT, and does not follow it:
    // metrics, then visuals, then texts, each in the sheet's flat order, however
    // the rows interleave them. planExec.runDashboard ties each KPI card to its
    // metric by that order. Only the layouts say where a tile is.
    sheet.metrics.forEach((m, i) => cards.push({ type: 'metric', layout: at.metrics[i], metric: m }));
    alive.forEach((pv, i) => cards.push({ type: 'visual', layout: at.visuals[i], visualId: savedIds.get(pv) }));
    sheet.texts.forEach((t, i) => cards.push({ type: 'text', layout: at.texts[i], ...t }));
    // sanitizeCards is the same whitelist a hand-built sheet goes through — a
    // sheet IS a dashboards.Page.
    sheets.push({ name: sheet.name, cards: dashboards.sanitizeCards(cards) });
  }

  return { name: plan.name, sheets, visualIds, calculatedFields: appliedCalc, dropped, warnings };
}

/**
 * The Assistant's entry point: records, then a NEW Analysis to hold them.
 *
 * The starter layouts deliberately do NOT come through here. They run against an
 * Analysis that is already open, and `dashCurrent` is the live record the editor
 * owns — main writing it behind the editor's back would be clobbered by the next
 * debounced save. They call `buildPlanRecords` and let the renderer place the
 * cards, which is the same rule dockEdit.ts already follows for edit deltas.
 */
export async function buildPlan(
  projectId: string,
  raw: unknown,
): Promise<BuildResult | { ok: false; error: string }> {
  const r = await buildPlanRecords(projectId, raw);
  const saved = await analysis.saveAnalysis(projectId, { name: r.name, sheets: r.sheets });
  if (!saved) return { ok: false, error: 'Could not create the dashboard' };
  return {
    ok: true,
    analysis: saved,
    visualIds: r.visualIds,
    calculatedFields: r.calculatedFields,
    dropped: r.dropped,
    warnings: r.warnings,
  };
}
