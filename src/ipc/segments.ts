// Find segments + RFM IPC — the thin edge in front of analysis/segmentModel.ts,
// analysis/rfm.ts and engine/segmentResident.ts. MAIN PROCESS.
//
//   segments:features    the number columns, ticked or skipped (with why),
//                        from the dataset's column profile; RFM's pickers
//   segments:fit         a JOB (kind 'analysis'): resident in a compute
//                        worker, the JS reference over hydrated rows as the
//                        fallback — progress and Cancel through the Jobs system
//   segments:saveColumn  append the fitted model as a Prepare step
//   segments:rfm         a JOB: the eleven-segment breakdown
//   segments:rfmSave     the customer-level table as an ordinary dataset
//
// Every handler answers `{ ok:false, error }` rather than throwing. Nothing
// here computes a figure: it routes, and the modules above do the math.

import { ipcMain } from 'electron';
import * as datasets from '../data/datasets';
import * as transforms from '../data/transforms';
import * as jobs from '../app/jobs';
import type { JobContext } from '../app/jobs';
import * as computePool from '../engine/computePool';
import * as trace from '../engine/residentTrace';
import { computeColumnSummariesResident } from '../engine/statsResident';
import { computeColumnSummary } from '../data/datasetStats';
import { featureChoices, featureProblem, jsSegmentIo, runFit, SAMPLE_CAP } from '../analysis/segmentModel';
import type { FitResult } from '../analysis/segmentModel';
import { fitResident, rfmCustomersResident } from '../engine/segmentResident';
import { rfmBreakdown, rfmCustomersJs, rfmDefaults, rfmProblem, rfmTable } from '../analysis/rfm';
import type { RfmCustomers, RfmSpec } from '../analysis/rfm';
import { commitSteps } from './datasets';

type Progress = (fraction: number, note?: string) => void;
type Fail = { ok: false; error: string; cancelled?: boolean };

const NOT_FOUND: Fail = { ok: false, error: 'Dataset not found' };

function failure(err: unknown, what: string): Fail {
  const e = err as { name?: string; message?: string } | null;
  if (e && e.name === 'JobCancelled') return { ok: false, error: 'Cancelled', cancelled: true };
  return { ok: false, error: (e && e.message) || what };
}

/** The fit: resident (in a worker when threads are on), else the JS reference. */
export async function fitDataset(projectId: string, datasetId: string, features: string[], ctx?: JobContext): Promise<FitResult | { error: string }> {
  const progress: Progress = (f, note) => { if (ctx) ctx.progress(f, note); };
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const out = computePool.available()
      ? await computePool.run<FitResult | { error: string } | null>('segmentFit', { src, features }, { onProgress: progress, signal: ctx?.signal })
      : fitResident(src, features, progress);
    trace.record('segmentFit', out ? 'resident' : 'failed', out ? undefined : `${features.length} feature(s)`);
    if (out) return out;
  } else {
    trace.record('segmentFit', 'skipped');
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { error: 'Dataset not found' };
  const jsProgress: Progress = (f, note) => { if (ctx) ctx.checkCancelled(); progress(f, note); };
  return runFit(ds.columns, features, jsSegmentIo(ds.columns, ds.rows), jsProgress) || { error: 'Could not read the dataset' };
}

/** Per-customer aggregates: resident first, the JS reference as the fallback. */
export async function rfmCustomers(projectId: string, datasetId: string, spec: RfmSpec, ctx?: JobContext): Promise<RfmCustomers | null> {
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const out = computePool.available()
      ? await computePool.run<RfmCustomers | null>('rfm', { src, spec }, { signal: ctx?.signal })
      : rfmCustomersResident(src, spec);
    trace.record('segmentRfm', out ? 'resident' : 'failed', out ? undefined : 'rfm');
    if (out) return out;
  } else {
    trace.record('segmentRfm', 'skipped');
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  return ds ? rfmCustomersJs(ds, spec) : null;
}

function specOf(raw: unknown): RfmSpec {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  return { id: s(o.id), date: s(o.date), amount: s(o.amount) };
}

export function register(): void {
  ipcMain.handle('segments:features', async (_e, { projectId, datasetId }: { projectId?: string; datasetId?: string } = {}) => {
    try {
      const meta = await datasets.getDatasetMeta(String(projectId || ''), String(datasetId || ''));
      if (!meta) return NOT_FOUND;
      const src = await datasets.residentSource(meta.projectId, meta.id);
      let summaries = src ? computeColumnSummariesResident(src) : null;
      trace.record('segmentFeatures', src ? (summaries ? 'resident' : 'failed') : 'skipped');
      if (!summaries) {
        const ds = await datasets.getDataset(meta.projectId, meta.id);
        if (!ds) return NOT_FOUND;
        summaries = ds.columns.map((c, i) => computeColumnSummary(c, ds.rows.map((r) => (r ? r[i] ?? null : null))));
      }
      return {
        ok: true,
        name: meta.name,
        rowCount: meta.rowCount,
        sampleCap: SAMPLE_CAP,
        features: featureChoices(meta.columns, summaries, meta.rowCount),
        otherColumns: meta.columns.filter((c) => c.type !== 'number').length,
        columns: meta.columns.map((c) => ({ name: c.name, type: c.type })),
        rfm: rfmDefaults(meta.columns),
      };
    } catch (err) {
      return failure(err, 'Could not read the columns');
    }
  });

  ipcMain.handle('segments:fit', async (_e, { projectId, datasetId, features }: { projectId?: string; datasetId?: string; features?: unknown } = {}) => {
    try {
      const meta = await datasets.getDatasetMeta(String(projectId || ''), String(datasetId || ''));
      if (!meta) return NOT_FOUND;
      const problem = featureProblem(meta.columns, features);
      if (problem) return { ok: false, error: problem };
      const list = (features as string[]).slice();
      const job = jobs.submit({
        kind: 'analysis',
        label: `Find segments · ${meta.name}`,
        projectId: meta.projectId,
        datasetId: meta.id,
        run: (ctx) => fitDataset(meta.projectId, meta.id, list, ctx),
        resultOf: (r) => ({ message: 'error' in r ? r.error : `${r.k} segments` }),
      });
      const out = await job.done;
      if ('error' in out) return { ok: false, error: out.error };
      return { ok: true, result: out };
    } catch (err) {
      return failure(err, 'Could not find segments');
    }
  });

  ipcMain.handle('segments:saveColumn', async (_e, { projectId, datasetId, step }: { projectId?: string; datasetId?: string; step?: unknown } = {}) => {
    try {
      const meta = await datasets.getDatasetMeta(String(projectId || ''), String(datasetId || ''));
      if (!meta) return NOT_FOUND;
      const clean = transforms.sanitizeSteps([step]);
      const s = clean[0];
      if (clean.length !== 1 || s.type !== 'segment') return { ok: false, error: 'The segment model is not valid — run Find segments again.' };
      if (meta.columns.some((c) => c.name === s.column)) return { ok: false, error: `There is already a column called "${s.column}".` };
      const res = await commitSteps(meta.projectId, meta.id, [...(meta.steps || []), s]);
      if (!res.ok) return { ok: false, error: res.error };
      const warnings = res.preview.warnings.filter((w: string) => w.startsWith('Segment skipped'));
      if (warnings.length) return { ok: false, error: warnings[0] };
      return { ok: true, column: s.column, steps: (res.dataset.steps || []).length };
    } catch (err) {
      return failure(err, 'Could not save the column');
    }
  });

  ipcMain.handle('segments:rfm', async (_e, { projectId, datasetId, spec }: { projectId?: string; datasetId?: string; spec?: unknown } = {}) => {
    try {
      const meta = await datasets.getDatasetMeta(String(projectId || ''), String(datasetId || ''));
      if (!meta) return NOT_FOUND;
      const s = specOf(spec);
      const problem = rfmProblem(meta.columns, s);
      if (problem) return { ok: false, error: problem };
      const job = jobs.submit({
        kind: 'analysis',
        label: `RFM · ${meta.name}`,
        projectId: meta.projectId,
        datasetId: meta.id,
        run: async (ctx) => {
          ctx.progress(0.1, 'Adding up each customer');
          const agg = await rfmCustomers(meta.projectId, meta.id, s, ctx);
          ctx.progress(0.9, 'Scoring');
          return agg ? rfmBreakdown(agg) : null;
        },
        resultOf: (r) => ({ message: r ? `${r.customers.toLocaleString('en-US')} customers scored` : 'Nothing to score' }),
      });
      const out = await job.done;
      if (!out) return NOT_FOUND;
      if (!out.customers) return { ok: false, error: `No row has a customer id, a date "${s.date}" can be read as, and a number in "${s.amount}".` };
      return { ok: true, result: out };
    } catch (err) {
      return failure(err, 'Could not score the customers');
    }
  });

  ipcMain.handle('segments:rfmSave', async (_e, { projectId, datasetId, spec }: { projectId?: string; datasetId?: string; spec?: unknown } = {}) => {
    try {
      const meta = await datasets.getDatasetMeta(String(projectId || ''), String(datasetId || ''));
      if (!meta) return NOT_FOUND;
      const s = specOf(spec);
      const problem = rfmProblem(meta.columns, s);
      if (problem) return { ok: false, error: problem };
      const agg = await rfmCustomers(meta.projectId, meta.id, s);
      if (!agg || !agg.customers.length) return { ok: false, error: 'There are no customers to save.' };
      const t = rfmTable(agg, s.id);
      const saved = await datasets.saveDataset(meta.projectId, { name: `${meta.name} — RFM`, sourceKind: 'combined', columns: t.columns, rows: t.rows });
      if (!saved) return { ok: false, error: 'Could not save the dataset' };
      return { ok: true, dataset: { id: saved.id, name: saved.name, rowCount: saved.rowCount } };
    } catch (err) {
      return failure(err, 'Could not save the dataset');
    }
  });
}
