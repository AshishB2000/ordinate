// Prepare power-step IPC — the editors' previews and the step list's counts.
//
// Everything a preview shows is counted HERE, by the app, over the step's real
// input (the dataset's source with the steps before it applied): a lookup's
// matched rate, a date format's failures, a union's column match, and the rows
// into and out of the step. The renderer only formats what comes back.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { applyPipelineAsync } from '../data/regexOffThread';
import type { TableData, TransformStep } from '../data/transforms';
import type { PipelineContext } from '../data/stepTypes';
import { loadStepRefs } from '../data/stepRefs';
import { checkPowerStep } from '../data/stepsSanitize';
import { lookupStats, unionPlan } from '../data/stepsCombine';
import { parseDatePreview } from '../data/stepsClean';

/** The table a step at `index` would receive (index < 0 or past the end: after every step). */
export async function inputAt(projectId: string, datasetId: string, index: number, extra: TransformStep): Promise<{
  input: TableData; ctx: PipelineContext;
} | null> {
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  const source: TableData = ds.source ?? { columns: ds.columns, rows: ds.rows };
  const steps = ds.steps || [];
  const prefix = Number.isInteger(index) && index >= 0 && index < steps.length ? steps.slice(0, index) : steps;
  const ctx = await loadStepRefs(projectId, datasetId, [...prefix, extra]);
  // ponytail: a full fold per preview; the resident path could serve the prefix if a big dataset makes this slow
  const input = prefix.length ? await applyPipelineAsync(source, prefix, ctx) : source;
  return { input: { columns: input.columns, rows: input.rows }, ctx };
}

function pct(part: number, whole: number): number {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0;
}

export async function stepPreview(projectId: string, datasetId: string, index: number, raw: unknown): Promise<unknown> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // A lookup is previewable before any column is chosen: the rate needs keys only.
  const probe = r.type === 'lookup_join' && (!Array.isArray(r.columns) || !r.columns.length)
    ? { ...r, columns: [r.rightKey] }
    : r;
  const step = checkPowerStep(probe);
  if (typeof step === 'string') return { ok: false, error: step };
  const at = await inputAt(projectId, datasetId, index, step);
  if (!at) return { ok: false, error: 'Dataset not found' };
  const { input, ctx } = at;
  const out = await applyPipelineAsync(input, [step], ctx);
  const res: Record<string, unknown> = { ok: true, before: input.rows.length, after: out.rowCount, warnings: out.warnings };
  if (step.type === 'lookup_join') {
    const stats = lookupStats(input, step, ctx);
    if (stats) res.lookup = { ...stats, ratePct: pct(stats.matched, stats.total) };
  } else if (step.type === 'parse_date') {
    const pd = parseDatePreview(input, step);
    // `filled`: the values it tried — the "of N" the preview prints, so a browser never adds two counts.
    res.parseDate = { ...pd, filled: pd.parsed + pd.failed };
  } else if (step.type === 'union' && ctx.tables[step.datasetId]) {
    const other = ctx.tables[step.datasetId];
    const plan = unionPlan(input.columns, other.columns, step.mapping);
    res.union = {
      otherRows: other.rows.length,
      unmatched: plan.unmatched,
      missing: input.columns.filter((_, k) => plan.source[k] < 0).map((c) => c.name),
    };
  }
  return res;
}

/** The step list's "1,250 → 1,180 rows": stored with the last recompute, or recomputed once for an older record. */
export async function stepCounts(projectId: string, datasetId: string): Promise<unknown> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const steps = meta.steps || [];
  if (!steps.length) return { ok: true, stepCounts: [] };
  if (meta.stepCounts) return { ok: true, stepCounts: meta.stepCounts };
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { ok: false, error: 'Dataset not found' };
  const source: TableData = ds.source ?? { columns: ds.columns, rows: ds.rows };
  const out = await applyPipelineAsync(source, steps, await loadStepRefs(projectId, datasetId, steps));
  return { ok: true, stepCounts: out.stepCounts || [] };
}

/**
 * The Prepare page's opening state (server only, T2.6): the prepared columns,
 * the steps, the rows into and out of each, the row count — and nothing about
 * the rows themselves or where they came from (the grid pages the stored table).
 */
export async function prepareState(projectId: string, datasetId: string): Promise<unknown> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  const counts = (await stepCounts(projectId, datasetId)) as { ok: boolean; stepCounts?: unknown };
  return {
    id: meta.id,
    name: meta.name,
    rowCount: meta.rowCount,
    columns: meta.columns,
    steps: meta.steps || [],
    stepCounts: counts.ok ? counts.stepCounts : null,
    updatedAt: meta.updatedAt,
  };
}

// ponytail: IPC payloads are untrusted JSON envelopes (typed any, as in datasets.ts); every field is coerced before use.
export function register(): void {
  ipcMain.handle('prepare:get', async (_e, { projectId, datasetId }: any = {}) =>
    prepareState(String(projectId || ''), String(datasetId || '')));
  ipcMain.handle('prepare:stepPreview', async (_e, { projectId, datasetId, index, step }: any = {}) => {
    try {
      return await stepPreview(String(projectId || ''), String(datasetId || ''), Number(index), step);
    } catch (err: any) { // ponytail: any thrown value, reported by its message only
      return { ok: false, error: err?.message || 'Could not preview the step' };
    }
  });
  ipcMain.handle('prepare:stepCounts', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      return await stepCounts(String(projectId || ''), String(datasetId || ''));
    } catch (err: any) { // ponytail: any thrown value, reported by its message only
      return { ok: false, error: err?.message || 'Could not count the steps' };
    }
  });
}
