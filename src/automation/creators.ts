// The automation surface's chart spec, and its two CREATORS — MAIN PROCESS.
//
// `aggregate`, `create_visual` and `create_dashboard` all take a structure a
// tool wrote, so none of them trusts it: every chart goes through
// `analysisPlan.validatePlan` — the one validator the Assistant's plans, their
// preview and their build share — and every plan through the same call with
// the project's real context. A spec the app would refuse from a model it
// refuses from a script, with the validator's own reason.
//
// Stricter than the Assistant in one way: ANY drop is a refusal for a single
// chart. A plan may lose a card and still be worth building; a visual that
// lost its filter is a different visual, and an aggregate that lost it is a
// wrong number.
//
// WRITES: records only. `saveVisual` and `planBuild.buildPlan` write visual and
// analysis JSON; a plan's calculated fields — the one part of a plan that
// changes a DATASET (they append a prepare step) — are removed before either
// validation or build, and reported as dropped.

import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as versions from '../app/versions';
import { loadPlanContext, validatePlan } from '../analysis/analysisPlan';
import type { PlanContext, PlanDrop, PlannedVisual } from '../analysis/analysisPlan';
import { buildPlan } from '../analysis/planBuild';
import { resolveFilterParams } from '../analysis/params';
import { vizDataFor } from '../ipc/visuals';
import { AutomationError } from './errors';
import { pick, runJob } from './resolve';
import type { Args, Ctx } from './registry';
import * as sharePolicy from '../app/sharePolicy';

/**
 * One chart spec through `validatePlan`, as a one-visual plan over a context of
 * just its dataset. The context carries no column stats: those are for the
 * model's FACTS block, and validation never reads them.
 */
export async function checkVisual(projectId: string, datasetRef: string, raw: Record<string, unknown>): Promise<PlannedVisual> {
  const ds = pick(await datasets.listDatasets(projectId), datasetRef, 'dataset');
  const meta = await datasets.getDatasetMeta(projectId, ds.id);
  if (!meta) throw new AutomationError('not_found', `Dataset "${datasetRef}" could not be read.`);
  const ctx: PlanContext = {
    datasets: [{ id: meta.id, name: meta.name, rowCount: meta.rowCount, columns: meta.columns, resident: meta.resident }],
    visuals: [],
  };
  const { plan, dropped } = validatePlan({ name: 'automation', sheets: [{ name: 'S', visuals: [{ ...raw, datasetId: ds.id }] }] }, ctx);
  if (dropped.length) {
    throw new AutomationError('usage', dropped.map((d) => d.message.replace(/^Sheet "S" visual 1 /, 'Visual ')).join(' '));
  }
  const v = plan.sheets[0] && plan.sheets[0].visuals[0];
  if (!v) throw new AutomationError('usage', 'The visual spec was not valid.');
  return v;
}

/**
 * A tool's filters are filter STEPS without the `type` a stored step carries.
 * The sanitizer DROPS a step it cannot read — which here would silently widen
 * an aggregate to rows the caller excluded — so a step that does not survive
 * it is refused by position instead.
 */
function filterSteps(raw: unknown): unknown[] {
  if (raw === undefined) return [];
  const list = (Array.isArray(raw) ? raw : []).map((f) =>
    (f && typeof f === 'object' && !Array.isArray(f) ? { type: 'filter', ...(f as Record<string, unknown>) } : f));
  const bad = list.findIndex((f) => visuals.sanitizeFilters([f]).length !== 1);
  if (bad >= 0) throw new AutomationError('usage', `Filter ${bad + 1} is not a valid filter: it needs a column, an op and (for most ops) a value.`);
  return list;
}

/**
 * A pivot carries BOTH its own block and the mirrored chart fields, exactly as
 * the builder saves one (pivotBuilder.ts `encodingFromPivot`); a caller that
 * sends only the pivot block gets the mirror filled in, never invented.
 */
function withPivotMirror(chartType: string, enc: unknown): unknown {
  if (chartType !== 'pivot' || !enc || typeof enc !== 'object') return enc;
  const e = enc as Record<string, unknown>;
  const p = e.pivot as { rows?: Array<{ column?: string }>; columns?: Array<{ column?: string }>; values?: Array<{ column?: string; aggregation?: string }> } | undefined;
  if (e.category || !p || typeof p !== 'object') return enc;
  const out: Record<string, unknown> = {
    ...e,
    category: p.rows && p.rows[0] ? p.rows[0].column : '',
    values: (p.values || []).map((v) => ({ column: v.column, aggregation: v.aggregation || 'sum' })),
  };
  if (p.columns && p.columns[0] && p.columns[0].column) out.series = p.columns[0].column;
  return out;
}

export async function aggregate(ctx: Ctx, a: Args): Promise<unknown> {
  // The chart type only steers validation (a pivot is judged as a pivot); the
  // numbers do not depend on it.
  const chartType = (a.encoding as Record<string, unknown>).pivot ? 'pivot' : 'column';
  const v = await checkVisual(ctx.projectId, String(a.dataset), {
    name: 'aggregate', chartType, encoding: withPivotMirror(chartType, a.encoding), filters: filterSteps(a.filters),
  });
  const steps = resolveFilterParams(v.filters, new Map()).steps;
  const reply = await vizDataFor(ctx.projectId, v.datasetId, v.encoding, steps);
  if (!reply.ok) throw new AutomationError('runtime', reply.error);
  // The Share policy's EXPORT path: labels drawn from a sensitive column leave
  // as tokens, or the answer is refused — automation is a door out of the app.
  const shaped = await sharePolicy.applyToChart(ctx.projectId, v.datasetId, v.encoding, reply, 'export');
  if (!shaped.ok) throw new AutomationError('runtime', `${shaped.error}: a column this aggregate reads is marked sensitive.`);
  const data = shaped.data;
  const out: Record<string, unknown> = {
    labels: data.labels,
    series: data.series.map((s) => ({ name: s.name, values: s.values })),
    warnings: reply.warnings,
  };
  if (data.pivot) out.pivot = data.pivot;
  if (reply.category && reply.category.note) out.note = reply.category.note;
  return out;
}

export async function createVisual(ctx: Ctx, a: Args): Promise<unknown> {
  const chartType = String(a.chartType);
  const v = await checkVisual(ctx.projectId, String(a.dataset), {
    name: a.name, chartType, encoding: withPivotMirror(chartType, a.encoding), filters: filterSteps(a.filters),
  });
  if (v.chartType === 'pivot') {
    const p = v.encoding.pivot;
    if (!p || !p.rows.length || !p.values.length) {
      throw new AutomationError('usage', 'A pivot needs encoding.pivot with at least one row and one value.');
    }
  }
  const pid = ctx.projectId;
  return runJob(
    { kind: 'automation', label: `Create visual "${v.name}"`, projectId: pid },
    async () => {
      const saved = await visuals.saveVisual(pid, {
        name: v.name, datasetId: v.datasetId, chartType: v.chartType, encoding: v.encoding, filters: v.filters,
      });
      if (!saved) throw new AutomationError('runtime', 'Could not save the visual.');
      await versions.record(pid, 'visual', saved);
      return { id: saved.id, name: saved.name, chartType: saved.chartType, datasetId: saved.datasetId };
    },
    (r) => `Visual "${r.name}" created by automation`,
  );
}

const CALC_DROP: PlanDrop = {
  kind: 'formula',
  where: 'calculatedFields',
  message: 'Calculated fields dropped: they add a column to a dataset, and automation never changes data. Add the field in Ordinate, then use its column.',
};

export async function createDashboard(ctx: Ctx, rawPlan: unknown): Promise<unknown> {
  const plan = { ...(rawPlan as Record<string, unknown>) };
  const extra: PlanDrop[] = [];
  if (Array.isArray(plan.calculatedFields) && plan.calculatedFields.length) extra.push(CALC_DROP);
  delete plan.calculatedFields;

  const pid = ctx.projectId;
  const planCtx = await loadPlanContext(pid);
  const checked = validatePlan(plan, planCtx);
  const tiles = checked.plan.sheets.reduce(
    (n, s) => n + s.visuals.length + s.metrics.length + s.texts.length + (s.controls ? s.controls.length : 0), 0);
  if (!tiles) {
    const why = [...extra, ...checked.dropped].map((d) => d.message).join(' ');
    throw new AutomationError('usage', 'Nothing in this plan could be built.' + (why ? ' ' + why : ''));
  }
  const existing = new Set(planCtx.visuals.map((v) => v.id));
  return runJob(
    { kind: 'automation', label: `Create dashboard "${checked.plan.name}"`, projectId: pid },
    async () => {
      const res = await buildPlan(pid, plan);
      if (!res.ok) throw new AutomationError('runtime', res.error);
      await versions.record(pid, 'dashboard', res.analysis);
      for (const id of res.visualIds) {
        if (existing.has(id)) continue;
        const saved = await visuals.getVisual(pid, id);
        if (saved) await versions.record(pid, 'visual', saved);
      }
      return {
        id: res.analysis.id,
        name: res.analysis.name,
        sheets: res.analysis.sheets.length,
        visualIds: res.visualIds,
        dropped: [...extra, ...res.dropped].map((d) => ({ where: d.where, message: d.message })),
      };
    },
    (r) => `Dashboard "${r.name}" created by automation`,
  );
}
