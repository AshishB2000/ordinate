// The Assistant's plan steps, run through the REAL code paths — MAIN PROCESS.
//
// Every executor below is the sequence an existing door already runs, called
// directly rather than re-implemented:
//   import     the native open dialog (on the server: the upload plan:next
//              hands over, T0.4) → parseAsJob (a job, parsed in a compute
//              worker) → datasets.saveDataset → runQualityChecks — the file
//              import's own three calls (src/ipc/datasetImport.ts, and
//              automation's `datasets import`)
//   step/calc  commitSteps (src/ipc/datasets.ts) — dataset:addStep's commit,
//              version and all
//   metric     metrics.saveMetric + versions.record — metric:save's body — and
//              resolveMetric for the KPI value the card shows
//   chart      checkVisual (validatePlan) → visuals.saveVisual → versions.record
//              — automation's `create_visual`
//   dashboard  planBuild.buildPlanRecords → analysis.saveAnalysis — the
//              Assistant dashboard build, with each KPI tile tied to its metric
//   style      analysis.updateAnalysis with a DASHBOARD_STYLE_PRESETS entry
//   alert      alertStore.saveRule — alerts:save's body
//
// Each returns the records it touched, so the run can undo them as one group
// per record (src/ai/planRun.ts): created → the Trash, changed → writeBack of
// what it was before (src/ipc/versions.ts's restore primitive).

import * as path from 'path';
import { randomUUID } from 'crypto';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as metrics from '../analysis/metrics';
import * as analysis from '../analysis/analysis';
import * as alertStore from '../analysis/alertStore';
import * as versions from '../app/versions';
import * as trash from '../app/trash';
import * as config from '../app/config';
import * as execConfig from '../app/execConfig';
import * as copilot from './copilot';
import { buildPlanRecords } from '../analysis/planBuild';
import { DASHBOARD_STYLE_PRESETS } from '../analysis/dashboards';
import type { DashboardStylePreset } from '../analysis/dashboards';
import { sourceKindForPath, storedKind } from '../data/fileImport';
import { serverDataDir } from '../server/context';
import { resolveUpload } from '../server/files';
import { runQualityChecks } from '../analysis/qualityRun';
import { commitSteps } from '../ipc/datasets';
import { writeBack } from '../ipc/versions';
import { parseAsJob } from '../ipc/datasetImport';
import { resolveMetric } from '../ipc/metrics';
import { checkVisual } from '../automation/creators';
import { dispatch, parseFirstObject } from './analyze';
import { checkStep, ctxFactsText, resolveRef } from './planCheck';
import type { PlanCtx, CtxRecord } from './planCheck';
import { sanitizePlanStep } from './planSteps';
import type { PlanStep } from './planSteps';
import { runLogText } from './planRun';
import type { PlanRun, RunDeps, StepOutcome, Touch, UndoGroup } from './planRun';

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The project as the plan sees it — metadata only, never a row. */
export async function loadProjectCtx(projectId: string, own: ReadonlySet<string> = new Set()): Promise<PlanCtx> {
  const [dsList, visList, metList, anList] = await Promise.all([
    datasets.listDatasets(projectId), visuals.listVisuals(projectId),
    metrics.listMetrics(projectId), analysis.listAnalyses(projectId),
  ]);
  const ctx: PlanCtx = { datasets: [], visuals: [], metrics: [], dashboards: [] };
  for (const d of dsList) {
    const meta = await datasets.getDatasetMeta(projectId, d.id);
    if (meta) ctx.datasets.push({ id: meta.id, name: meta.name, columns: meta.columns, rowCount: meta.rowCount, fromRun: own.has('dataset:' + meta.id) });
  }
  for (const v of visList) ctx.visuals.push({ id: v.id, name: v.name, datasetId: v.datasetId, chartType: v.chartType, fromRun: own.has('visual:' + v.id) });
  for (const m of metList) {
    const def = m.definition as { column?: string; aggregation?: string };
    ctx.metrics.push({
      id: m.id, name: m.name, datasetId: m.datasetId, fromRun: own.has('metric:' + m.id),
      column: typeof def.column === 'string' ? def.column : '', aggregation: typeof def.aggregation === 'string' ? def.aggregation : '',
    });
  }
  for (const a of anList) ctx.dashboards.push({ id: a.id, name: a.name, fromRun: own.has('dashboard:' + a.id) });
  return ctx;
}

function ownKeys(run: PlanRun): Set<string> {
  return new Set(run.touches.filter((t) => t.created).map((t) => t.type + ':' + t.id));
}

function must<T extends CtxRecord>(list: readonly T[], ref: string, what: string): T {
  const r = resolveRef(list, ref, what);
  if (!r.hit) throw new Error(r.error || `No ${what} called "${ref}".`);
  return r.hit;
}

async function kpiOf(projectId: string, metricId: string): Promise<{ name: string; display: string } | null> {
  const r = await resolveMetric(projectId, metricId).catch(() => null);
  return r && r.ok ? { name: r.name, display: r.display } : null;
}

/** The file an import step reads: the upload the run was handed (single use). */
function pickImportFile(run: PlanRun): { path: string; name: string; done(): void } | null {
  const token = run.fileToken;
  run.fileToken = undefined;
  return token ? resolveUpload(token) : null;
}

async function runImport(run: PlanRun, step: Extract<PlanStep, { kind: 'import' }>): Promise<StepOutcome> {
  const pid = run.projectId;
  const picked = pickImportFile(run);
  if (!picked) return { ok: false, error: 'Choose the file to import, then run the step.' };
  // An upload's own path is `upload-<hex>`: its kind and name come from the client's file name.
  const kind = sourceKindForPath(picked.name);
  let parsed: Awaited<ReturnType<typeof parseAsJob>>;
  try {
    if (!kind) return { ok: false, error: `${picked.name} is not a CSV, JSON or Excel file.` };
    parsed = await parseAsJob(picked.path, kind, undefined, picked.name);
  } finally {
    picked.done();
  }
  const filePath = picked.path;
  const name = step.name || path.basename(picked.name, path.extname(picked.name));
  const saved = await datasets.saveDataset(pid, {
    name, sourceKind: storedKind(kind), columns: parsed.columns, rows: parsed.rows,
    // The server's upload was a temp file, deleted above: nothing to refresh from.
    ...(serverDataDir() !== null ? {} : { origin: { kind: 'file' as const, path: filePath } }),
  });
  if (!saved) return { ok: false, error: 'Could not save the dataset.' };
  await runQualityChecks(pid, saved.id);
  return {
    ok: true,
    result: {
      summary: `${fmt(saved.rowCount)} rows × ${saved.columns.length} columns from ${picked.name}`,
      rowsAfter: saved.rowCount,
      link: { type: 'dataset', id: saved.id, name: saved.name },
    },
    touches: [{ type: 'dataset', id: saved.id, name: saved.name, created: true }],
  };
}

async function runPrepare(run: PlanRun, step: Extract<PlanStep, { kind: 'step' | 'calc' }>, ctx: PlanCtx): Promise<StepOutcome> {
  const pid = run.projectId;
  const ds = must(ctx.datasets, step.dataset, 'dataset');
  const meta = await datasets.getDatasetMeta(pid, ds.id);
  if (!meta) return { ok: false, error: `"${ds.name}" could not be read.` };
  const prior = Array.isArray(meta.steps) ? meta.steps.slice() : [];
  const add = step.kind === 'calc' ? { type: 'calculated_field', name: step.name, expression: step.expression } : step.step;
  const res = await commitSteps(pid, ds.id, [...prior, add]);
  if (!res.ok) return { ok: false, error: res.error };
  const touch: Touch = { type: 'dataset', id: ds.id, name: ds.name, created: false, before: { id: ds.id, steps: prior } };
  if ((res.dataset.steps || []).length !== prior.length + 1) {
    return { ok: false, error: 'The prepare step was not accepted.', touches: [touch] };
  }
  const warnings = res.preview.warnings || [];
  const rows = `${fmt(meta.rowCount)} → ${fmt(res.preview.rowCount)} rows`;
  return {
    ok: true,
    result: {
      summary: (step.kind === 'calc' ? `Added "${step.name}" · ` : '') + rows + (warnings.length ? ` · ${warnings[0]}` : ''),
      rowsBefore: meta.rowCount,
      rowsAfter: res.preview.rowCount,
      link: { type: 'dataset', id: ds.id, name: ds.name },
    },
    touches: [touch],
  };
}

async function runMetric(run: PlanRun, step: Extract<PlanStep, { kind: 'metric' }>, ctx: PlanCtx): Promise<StepOutcome> {
  const pid = run.projectId;
  const ds = must(ctx.datasets, step.dataset, 'dataset');
  const m = await metrics.saveMetric(pid, {
    name: step.name, datasetId: ds.id, definition: { column: step.column, aggregation: step.aggregation }, filters: [],
  });
  if (!m) return { ok: false, error: 'Could not save the metric — check the dataset still exists.' };
  await versions.record(pid, 'metric', m);
  const kpi = await kpiOf(pid, m.id);
  return {
    ok: true,
    result: {
      summary: kpi ? `${kpi.name} = ${kpi.display}` : 'Metric defined',
      link: { type: 'metric', id: m.id, name: m.name },
      kpis: kpi ? [kpi] : [],
    },
    touches: [{ type: 'metric', id: m.id, name: m.name, created: true }],
  };
}

async function runChart(run: PlanRun, step: Extract<PlanStep, { kind: 'chart' }>, ctx: PlanCtx): Promise<StepOutcome> {
  const pid = run.projectId;
  const ds = must(ctx.datasets, step.dataset, 'dataset');
  // A model's filters are steps without the `type` a stored step carries — the
  // same fill `create_visual` makes (src/automation/creators.ts filterSteps).
  const filters = step.filters.map((f) => (f && typeof f === 'object' && !Array.isArray(f) ? { type: 'filter', ...(f as Record<string, unknown>) } : f));
  const v = await checkVisual(pid, ds.id, { name: step.name, chartType: step.chartType, encoding: step.encoding, filters });
  const saved = await visuals.saveVisual(pid, { name: v.name, datasetId: v.datasetId, chartType: v.chartType, encoding: v.encoding, filters: v.filters });
  if (!saved) return { ok: false, error: 'Could not save the visual.' };
  await versions.record(pid, 'visual', saved);
  return {
    ok: true,
    result: { summary: 'Saved to Visuals', link: { type: 'visual', id: saved.id, name: saved.name } },
    touches: [{ type: 'visual', id: saved.id, name: saved.name, created: true }],
  };
}

async function runDashboard(run: PlanRun, step: Extract<PlanStep, { kind: 'dashboard' }>, ctx: PlanCtx): Promise<StepOutcome> {
  const pid = run.projectId;
  const vis = step.visuals.map((n) => must(ctx.visuals, n, 'visual'));
  const mets = step.metrics.map((n) => must(ctx.metrics, n, 'metric'));
  const recs = await buildPlanRecords(pid, {
    name: step.name,
    sheets: [{
      name: 'Overview',
      visuals: vis.map((v) => ({ visual: v.id })),
      metrics: mets.map((m) => ({ datasetId: m.datasetId, column: m.column, aggregation: m.aggregation, label: m.name })),
    }],
  });
  // Every tile is an existing record, so a drop means the dashboard would not be
  // the one the plan describes — refuse rather than build a different one.
  if (recs.dropped.length) return { ok: false, error: recs.dropped[0].message };
  // Tie each KPI tile to its metric, in plan order, so it shows the metric's
  // own format and follows its definition.
  let k = 0;
  for (const card of (recs.sheets[0] ? recs.sheets[0].cards : []) as Array<{ type?: string; metric?: { metricId?: string } }>) {
    if (card.type === 'metric' && card.metric && mets[k]) card.metric.metricId = mets[k++].id;
  }
  const style = DASHBOARD_STYLE_PRESETS[config.get().branding.dashboardStyle as DashboardStylePreset];
  const saved = await analysis.saveAnalysis(pid, { name: recs.name, sheets: recs.sheets, style });
  if (!saved) return { ok: false, error: 'Could not create the dashboard.' };
  await versions.record(pid, 'dashboard', saved);
  const tiles = vis.length + mets.length;
  return {
    ok: true,
    result: { summary: `${tiles} tile${tiles === 1 ? '' : 's'}`, link: { type: 'dashboard', id: saved.id, name: saved.name } },
    touches: [{ type: 'dashboard', id: saved.id, name: saved.name, created: true }],
  };
}

async function runStyle(run: PlanRun, step: Extract<PlanStep, { kind: 'style' }>, ctx: PlanCtx): Promise<StepOutcome> {
  const pid = run.projectId;
  const target = step.dashboard
    ? must(ctx.dashboards, step.dashboard, 'dashboard')
    : ctx.dashboards.filter((d) => d.fromRun).pop();
  if (!target) return { ok: false, error: 'Name the dashboard to style.' };
  const before = await analysis.getAnalysis(pid, target.id);
  if (!before) return { ok: false, error: `"${target.name}" could not be read.` };
  const updated = await analysis.updateAnalysis(pid, target.id, { style: DASHBOARD_STYLE_PRESETS[step.preset as DashboardStylePreset] });
  if (!updated) return { ok: false, error: 'Could not restyle the dashboard.' };
  await versions.record(pid, 'dashboard', updated, { before });
  return {
    ok: true,
    result: { summary: `Styled ${step.preset}`, link: { type: 'dashboard', id: target.id, name: target.name } },
    touches: [{ type: 'dashboard', id: target.id, name: target.name, created: false, before }],
  };
}

async function runAlert(run: PlanRun, step: Extract<PlanStep, { kind: 'alert' }>, ctx: PlanCtx): Promise<StepOutcome> {
  const pid = run.projectId;
  const m = must(ctx.metrics, step.metric, 'metric');
  const saved = await alertStore.saveRule(pid, {
    id: randomUUID(),
    name: step.name || `${m.name} ${step.op} ${step.value}`,
    datasetId: m.datasetId,
    metric: { column: m.column, aggregation: m.aggregation, metricId: m.id, label: m.name },
    compare: 'threshold',
    threshold: { op: step.op, value: step.value },
    enabled: true,
  });
  if (!saved) return { ok: false, error: 'That alert rule is not complete.' };
  const kpi = await kpiOf(pid, m.id);
  return {
    ok: true,
    result: {
      summary: `Fires when ${m.name} ${step.op} ${step.value}` + (kpi ? ` · now ${kpi.display}` : ''),
      link: { type: 'alert', id: saved.id, name: saved.name },
      kpis: kpi ? [kpi] : [],
    },
    touches: [{ type: 'alert', id: saved.id, name: saved.name, created: true }],
  };
}

/** The deps planRun needs, bound to the real stores. */
export const RUN_DEPS: RunDeps = {
  loadCtx: (run) => loadProjectCtx(run.projectId, ownKeys(run)),
  execute: async (run, step, _index, ctx) => {
    switch (step.kind) {
      case 'import': return runImport(run, step);
      case 'step':
      case 'calc': return runPrepare(run, step, ctx);
      case 'metric': return runMetric(run, step, ctx);
      case 'chart': return runChart(run, step, ctx);
      case 'dashboard': return runDashboard(run, step, ctx);
      case 'style': return runStyle(run, step, ctx);
      case 'alert': return runAlert(run, step, ctx);
    }
    return { ok: false, error: 'Unknown step.' };
  },
};

/** One undo group: created → the Trash; changed → written back to what it was. */
export async function undoGroup(projectId: string, g: UndoGroup): Promise<{ ok: boolean; error?: string }> {
  if (g.action === 'trash') {
    const r = await trash.trashRecord(projectId, g.type, g.id);
    return r.ok ? { ok: true } : { ok: false, error: 'It could not be moved to the Trash.' };
  }
  const saved = await writeBack(projectId, g.type, g.id, g.before);
  if (!saved) return { ok: false, error: 'It could not be put back — it may have been deleted.' };
  if (versions.isVersionType(g.type)) await versions.record(projectId, g.type, saved);
  return { ok: true };
}

/** The run, as one assistant turn in the conversation it came from. */
export async function logRun(run: PlanRun): Promise<string> {
  const text = runLogText(run);
  await copilot.appendTurn(run.projectId, { role: 'assistant', text }, run.threadId || undefined).catch(() => null);
  return text;
}

const FIX_PROMPT =
  'You repair ONE step of an Ordinate plan that the app refused to run. Reply with ONLY the corrected step as ' +
  'one JSON object, in exactly the format of the step you are given — no markdown, no prose. Use ONLY the ' +
  'dataset, column, visual, metric and dashboard names listed in FACTS; name columns exactly as listed. Fix ' +
  'what the error says and change nothing else. NEVER output a computed number.';

/** Fix: re-ask the model with the app's error; the answer is checked like any step. */
export async function fixStep(run: PlanRun, index: number): Promise<{ ok: true; step: PlanStep } | { ok: false; error: string }> {
  if (!execConfig.executionReady()) return { ok: false, error: 'Fix needs an AI model — set one up in Settings, or edit the step yourself.' };
  const ctx = await loadProjectCtx(run.projectId, ownKeys(run));
  const text = [
    'FACTS', ctxFactsText(ctx), '',
    `STEP ${index + 1}: ${JSON.stringify(run.steps[index])}`, '',
    `THE APP REFUSED IT: ${run.errors[index] || 'unknown error'}`, '',
    `WHAT THE USER ASKED FOR: ${run.intent}`,
  ].join('\n');
  const { rawText, error } = await dispatch(FIX_PROMPT, [{ role: 'user', text }]);
  if (error) return { ok: false, error: error.message || 'The model did not answer.' };
  const step = sanitizePlanStep(parseFirstObject(rawText));
  if (!step) return { ok: false, error: 'The Assistant did not propose a usable step.' };
  const { check } = checkStep(step, ctx, index);
  if (!check.ok) return { ok: false, error: `The Assistant's fix did not pass either: ${check.error}` };
  return { ok: true, step };
}
