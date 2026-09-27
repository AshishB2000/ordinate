// What an Assistant plan's steps MEAN — checked with the same validators the
// single actions use, before the card shows anything and again before each
// step runs. MAIN PROCESS ONLY. Pure over a context object: the caller loads
// the project (src/ai/planExec.ts), this decides.
//
// The validators, by kind — none of them new:
//   import    a file name or a dataset name (the picker does the rest)
//   step      transforms.sanitizeSteps, then the step APPLIED to an empty table
//             of the dataset's columns: the pipeline's own warnings ("Filter
//             skipped: unknown column") are the verdict, and its output columns
//             are what later steps may name
//   calc      formula.compile, then the same empty-table apply
//   metric    analysisPlan.validatePlan on a one-KPI sheet — the KPI validator
//   chart     analysisPlan.validatePlan on a one-visual sheet — what a drafted
//             dashboard and `create_visual` both go through
//   dashboard every visual and metric it names resolves
//   style     one of DASHBOARD_STYLE_PRESETS, on a dashboard that resolves
//   alert     alerts.sanitizeRule on the rule the step describes
//
// FORWARD REFERENCES. checkPlan folds the steps over the context: an import
// adds a dataset whose columns are not known yet, a calc adds a column, a chart
// a visual, a metric a metric, a dashboard a dashboard — so step 5 may name
// what step 2 made. A step over a dataset that is not imported yet cannot be
// checked against columns; it is DEFERRED, and checked for real when it runs,
// against the project as it then is.

import * as transforms from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import { compile } from '../formula/formula';
import { validatePlan } from '../analysis/analysisPlan';
import type { PlanContext } from '../analysis/analysisPlan';
import { DASHBOARD_STYLE_PRESETS } from '../analysis/dashboards';
import { sanitizeRule } from '../analysis/alerts';
import type { PlanStep } from './planSteps';

export interface CtxDataset {
  id: string;
  name: string;
  /** null until the import that creates it has run. */
  columns: ParsedColumn[] | null;
  rowCount: number;
  /** Calculated fields earlier plan steps add — their TYPE is not known until they run. */
  pending?: Array<{ name: string; expression: string }>;
  /** Created by this plan (a later step naming it means this one, not an older namesake). */
  fromRun?: boolean;
  /** The step that imports it, while it is still virtual. */
  importStep?: number;
}
export interface CtxRecord { id: string; name: string; fromRun?: boolean }
export interface CtxVisual extends CtxRecord { datasetId: string; chartType: string }
export interface CtxMetric extends CtxRecord { datasetId: string; column: string; aggregation: string }

export interface PlanCtx {
  datasets: CtxDataset[];
  visuals: CtxVisual[];
  metrics: CtxMetric[];
  dashboards: CtxRecord[];
}

export interface StepCheck {
  ok: boolean;
  /** Why it cannot run — the validator's own words. */
  error?: string;
  /** Set when the step is fine as far as can be known, and is checked again when it runs. */
  deferred?: string;
}

/** Id of a record a plan step WILL create — never a UUID, so it never reaches a path. */
export function virtualId(index: number): string {
  return 'plan:' + index;
}

const ZERO_ID = '00000000-0000-4000-8000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * By id, then a record this run created, then exact name, then case-insensitive
 * name — each only when unambiguous. `pick`'s rule (src/automation/resolve.ts)
 * with one addition: the run's own records win, so "Sales" after "import …
 * as Sales" means the new one even when an older "Sales" exists.
 */
export function resolveRef<T extends CtxRecord>(list: readonly T[], ref: string, what: string): { hit?: T; error?: string } {
  const r = String(ref || '').trim();
  if (!r) return { error: `No ${what} is named.` };
  const byId = list.find((x) => x.id === r);
  if (byId) return { hit: byId };
  const lower = r.toLowerCase();
  const own = list.filter((x) => x.fromRun && x.name.toLowerCase() === lower);
  if (own.length) return { hit: own[own.length - 1] };
  for (const same of [(x: T) => x.name === r, (x: T) => x.name.toLowerCase() === lower]) {
    const hits = list.filter(same);
    if (hits.length === 1) return { hit: hits[0] };
    if (hits.length > 1) return { error: `${hits.length} ${what}s are called "${r}" — rename one, or name it by id.` };
  }
  return { error: `No ${what} called "${r}".` };
}

function cloneCtx(ctx: PlanCtx): PlanCtx {
  return {
    datasets: ctx.datasets.map((d) => ({
      ...d, columns: d.columns ? d.columns.map((c) => ({ ...c })) : null, pending: d.pending ? d.pending.slice() : undefined,
    })),
    visuals: ctx.visuals.slice(),
    metrics: ctx.metrics.slice(),
    dashboards: ctx.dashboards.slice(),
  };
}

function deferral(ds: CtxDataset): string {
  return typeof ds.importStep === 'number'
    ? `Checked when it runs — "${ds.name}" is imported by step ${ds.importStep + 1}.`
    : `Checked when it runs — "${ds.name}" has no columns yet.`;
}

/**
 * The one-dataset context validatePlan needs. A column a plan step is about to
 * add is left OUT of the columns and handed in as a calculated field instead —
 * validatePlan's own "proposed column" rule — because its type is unknown
 * until it runs, and judging it `text` would refuse a sum of it.
 */
function planContextFor(ds: CtxDataset): { ctx: PlanContext; calcs: Array<{ datasetId: string; name: string; expression: string }> } {
  const pending = ds.pending || [];
  const pendingNames = new Set(pending.map((p) => p.name));
  return {
    ctx: {
      datasets: [{
        id: ds.id, name: ds.name, rowCount: ds.rowCount, resident: false,
        columns: (ds.columns || []).filter((c) => !pendingNames.has(c.name)),
      }],
      visuals: [],
    },
    calcs: pending.map((p) => ({ datasetId: ds.id, name: p.name, expression: p.expression })),
  };
}

/** The pipeline over an empty table of `ds`'s columns: its warnings, and its output columns. */
function dryApply(ds: CtxDataset, step: transforms.TransformStep): { warnings: string[]; columns: ParsedColumn[] } {
  const res = transforms.applyPipeline({ columns: (ds.columns || []).map((c) => ({ ...c })), rows: [] }, [step]);
  return { warnings: res.warnings, columns: res.columns };
}

function firstDrop(dropped: Array<{ message: string }>): string {
  // validatePlan's messages open with where in ITS envelope ("Sheet "S" visual
  // 1 dropped: …"); the step already says where, so keep the reason.
  const m = dropped.length ? dropped[0].message : '';
  const at = m.indexOf(' dropped: ');
  return at >= 0 ? m.slice(at + ' dropped: '.length) : m;
}

/**
 * One step against a context. Returns the verdict and the context AFTER the
 * step, so the next one may name what this one creates. A failed step changes
 * nothing downstream — its names do not exist.
 */
export function checkStep(step: PlanStep, ctx: PlanCtx, index: number): { check: StepCheck; next: PlanCtx } {
  const fail = (error: string) => ({ check: { ok: false, error }, next: ctx });
  const next = cloneCtx(ctx);
  const vid = virtualId(index);

  const datasetOf = (ref: string): { ds?: CtxDataset; error?: string } => {
    const r = resolveRef(next.datasets, ref, 'dataset');
    return r.hit ? { ds: r.hit } : { error: r.error };
  };

  switch (step.kind) {
    case 'import': {
      const name = step.name || step.file.replace(/\.[^.]+$/, '');
      if (!name) return fail('Name the file to import.');
      if (step.file && !/\.(csv|json|xlsx)$/i.test(step.file)) {
        return fail(`"${step.file}" is not a file Ordinate imports — CSV, JSON or Excel.`);
      }
      next.datasets.push({ id: vid, name, columns: null, rowCount: 0, fromRun: true, importStep: index });
      return { check: { ok: true, deferred: 'You pick the file when this step runs.' }, next };
    }

    case 'step':
    case 'calc': {
      const { ds, error } = datasetOf(step.dataset);
      if (!ds) return fail(error || 'Unknown dataset.');
      const raw = step.kind === 'calc'
        ? { type: 'calculated_field', name: step.name, expression: step.expression }
        : step.step;
      const clean = transforms.sanitizeSteps([raw]);
      if (clean.length !== 1) {
        const t = raw && typeof (raw as Record<string, unknown>).type === 'string' ? String((raw as Record<string, unknown>).type) : '';
        return fail(t ? `"${t}" is not a prepare step Ordinate knows, or it is missing a field.` : 'The step has no type.');
      }
      const s = clean[0];
      if (s.type === 'calculated_field') {
        if (!s.name) return fail('The calculated field has no name.');
        const compiled = compile(s.expression);
        if (!compiled.ok) return fail(`The formula did not compile — ${compiled.error}.`);
      }
      if (!ds.columns) {
        if (s.type === 'calculated_field') ds.pending = [...(ds.pending || []), { name: s.name, expression: s.expression }];
        return { check: { ok: true, deferred: deferral(ds) }, next };
      }
      if (s.type === 'calculated_field' && ds.columns.some((c) => c.name === s.name)) {
        return fail(`"${ds.name}" already has a column called "${s.name}".`);
      }
      const dry = dryApply(ds, s);
      if (dry.warnings.length) return fail(dry.warnings.join(' '));
      ds.columns = dry.columns;
      if (s.type === 'calculated_field') ds.pending = [...(ds.pending || []), { name: s.name, expression: s.expression }];
      return { check: { ok: true }, next };
    }

    case 'metric': {
      const { ds, error } = datasetOf(step.dataset);
      if (!ds) return fail(error || 'Unknown dataset.');
      if (!step.name) return fail('The metric has no name.');
      if (next.metrics.some((m) => m.name.toLowerCase() === step.name.toLowerCase())) {
        return fail(`A metric called "${step.name}" already exists.`);
      }
      if (ds.columns) {
        const { ctx: pctx, calcs } = planContextFor(ds);
        const { dropped } = validatePlan({
          calculatedFields: calcs,
          sheets: [{ name: 'S', metrics: [{ datasetId: ds.id, column: step.column, aggregation: step.aggregation }] }],
        }, pctx);
        const bad = dropped.filter((d) => d.where.startsWith('sheets'));
        if (bad.length) return fail(firstDrop(bad));
      }
      next.metrics.push({ id: vid, name: step.name, datasetId: ds.id, column: step.column, aggregation: step.aggregation, fromRun: true });
      return { check: ds.columns ? { ok: true } : { ok: true, deferred: deferral(ds) }, next };
    }

    case 'chart': {
      const { ds, error } = datasetOf(step.dataset);
      if (!ds) return fail(error || 'Unknown dataset.');
      if (!step.name) return fail('The chart has no name.');
      if (ds.columns) {
        const { ctx: pctx, calcs } = planContextFor(ds);
        const { dropped } = validatePlan({
          calculatedFields: calcs,
          sheets: [{ name: 'S', visuals: [{ name: step.name, datasetId: ds.id, chartType: step.chartType, encoding: step.encoding, filters: step.filters }] }],
        }, pctx);
        const bad = dropped.filter((d) => d.where.startsWith('sheets'));
        if (bad.length) return fail(firstDrop(bad));
      }
      next.visuals.push({ id: vid, name: step.name, datasetId: ds.id, chartType: step.chartType, fromRun: true });
      return { check: ds.columns ? { ok: true } : { ok: true, deferred: deferral(ds) }, next };
    }

    case 'dashboard': {
      if (!step.name) return fail('The dashboard has no name.');
      if (!step.visuals.length && !step.metrics.length) return fail('A dashboard needs at least one chart or metric.');
      for (const v of step.visuals) {
        const r = resolveRef(next.visuals, v, 'visual');
        if (!r.hit) return fail(r.error || 'Unknown visual.');
      }
      for (const m of step.metrics) {
        const r = resolveRef(next.metrics, m, 'metric');
        if (!r.hit) return fail(r.error || 'Unknown metric.');
        if (!r.hit.column) return fail(`"${r.hit.name}" is a formula metric; a plan's KPI tiles are column metrics.`);
      }
      next.dashboards.push({ id: vid, name: step.name, fromRun: true });
      return { check: { ok: true }, next };
    }

    case 'style': {
      if (!Object.prototype.hasOwnProperty.call(DASHBOARD_STYLE_PRESETS, step.preset)) {
        return fail(`"${step.preset}" is not a style — clean, executive, dense or dark.`);
      }
      if (step.dashboard) {
        const r = resolveRef(next.dashboards, step.dashboard, 'dashboard');
        if (!r.hit) return fail(r.error || 'Unknown dashboard.');
      } else if (!next.dashboards.some((d) => d.fromRun)) {
        return fail('Name the dashboard to style.');
      }
      return { check: { ok: true }, next };
    }

    case 'alert': {
      const r = resolveRef(next.metrics, step.metric, 'metric');
      if (!r.hit) return fail(r.error || 'Unknown metric.');
      const m = r.hit;
      if (!['>', '<', '>=', '<='].includes(step.op)) return fail(`"${step.op}" is not a comparison an alert can make — use >, <, >= or <=.`);
      if (step.value === null) return fail('An alert needs the number to compare against.');
      // The dataset is checked by the metric resolving above; a virtual one
      // stands in as the zero id so the rest of the rule is judged on its own.
      const rule = sanitizeRule({
        id: ZERO_ID,
        datasetId: UUID_RE.test(m.datasetId) ? m.datasetId : ZERO_ID,
        name: step.name || m.name,
        metric: { column: m.column, aggregation: m.aggregation },
        compare: 'threshold',
        threshold: { op: step.op, value: step.value },
      });
      if (!rule) return fail(`An alert on "${m.name}" is not possible — it needs a ${m.aggregation || 'column'} metric.`);
      return { check: { ok: true }, next };
    }
  }
  return fail('Unknown step.');
}

/** Every step, in order, each against the context the steps before it leave. */
export function checkPlan(steps: readonly PlanStep[], ctx: PlanCtx): StepCheck[] {
  const out: StepCheck[] = [];
  let cur = ctx;
  steps.forEach((s, i) => {
    const { check, next } = checkStep(s, cur, i);
    out.push(check);
    cur = next;
  });
  return out;
}

/** The context as FACTS for the Fix prompt: names and declared types, never a row. */
export function ctxFactsText(ctx: PlanCtx): string {
  const lines: string[] = ['Datasets:'];
  for (const d of ctx.datasets) {
    lines.push(`- "${d.name}": ` + (d.columns ? d.columns.map((c) => `${c.name} (${c.type})`).join(', ') : 'not imported yet'));
  }
  if (ctx.visuals.length) lines.push('Visuals: ' + ctx.visuals.map((v) => `"${v.name}"`).join(', '));
  if (ctx.metrics.length) lines.push('Metrics: ' + ctx.metrics.map((m) => `"${m.name}"`).join(', '));
  if (ctx.dashboards.length) lines.push('Dashboards: ' + ctx.dashboards.map((d) => `"${d.name}"`).join(', '));
  return lines.join('\n');
}
