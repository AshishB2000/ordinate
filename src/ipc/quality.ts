// Data-quality IPC — the thin edge in front of src/analysis/qualityRun.ts.
//
// Every handler is `ipcMain.handle` and turns a throw into `{ ok:false, error }`.
// Nothing here evaluates a rule or composes a sentence: rules are sanitized in
// qualityRules, run and stored by qualityRun, and the failing-row page is the
// ordinary `datasetPage` window with the rule as a main-built row filter — the
// renderer names a rule by id and never sends a predicate.

import { ipcMain } from 'electron';
import * as quality from '../analysis/qualityRun';
import { pageFor } from './datasets';
import { getDatasetMeta } from '../data/datasets';
import * as jobs from '../app/jobs';

/**
 * "Run checks" as a job — the button below, and a pipeline's quality step
 * (src/app/pipelineRunner.ts). One at a time per dataset, and the resident
 * evaluation runs in a compute worker.
 */
// ponytail: ids are untrusted renderer values here, as they were inline — the stores UUID-check them.
export async function submitQualityRun(projectId: any, datasetId: any): Promise<{ id: string; done: Promise<unknown> }> {
  const meta = await getDatasetMeta(projectId, datasetId);
  return jobs.submit({
    kind: 'quality',
    label: `Quality checks · ${meta ? meta.name : 'dataset'}`,
    projectId: typeof projectId === 'string' ? projectId : undefined,
    datasetId: typeof datasetId === 'string' ? datasetId : undefined,
    run: async (ctx) => {
      ctx.progress(0.1, `${meta && meta.quality ? meta.quality.rules.length : 0} rule(s)`);
      return quality.runQualityChecks(projectId, datasetId);
    },
    resultOf: (events) => ({ message: events.length ? `${events.length} rule(s) started failing` : 'Checks finished' }),
  });
}

export function register(): void {
  // Rules + the latest run + the 30-run history, in one read of the record.
  ipcMain.handle('quality:list', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const q = await quality.listQuality(projectId, datasetId);
      if (!q) return { ok: false, error: 'Dataset not found' };
      return { ok: true, rules: q.rules, latest: q.latest || null, history: q.history || [] };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read the rules' };
    }
  });

  // Add or edit (an id that matches edits). Runs the checks before answering.
  ipcMain.handle('quality:save', async (_e, { projectId, datasetId, rule }: any = {}) => {
    try {
      return await quality.saveRule(projectId, datasetId, rule);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save the rule' };
    }
  });

  ipcMain.handle('quality:delete', async (_e, { projectId, datasetId, ruleId }: any = {}) => {
    try {
      return { ok: await quality.deleteRule(projectId, datasetId, String(ruleId || '')) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not delete the rule' };
    }
  });

  // "Run checks" — the hook itself, then the fresh state. A JOB: one at a time
  // per dataset, and the resident evaluation runs in a compute worker.
  ipcMain.handle('quality:run', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      await (await submitQualityRun(projectId, datasetId)).done;
      const q = await quality.listQuality(projectId, datasetId);
      if (!q) return { ok: false, error: 'Dataset not found' };
      return { ok: true, rules: q.rules, latest: q.latest || null, history: q.history || [] };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not run the checks' };
    }
  });

  // The editor's live "would fail N rows now". Nothing is stored.
  ipcMain.handle('quality:preview', async (_e, { projectId, datasetId, rule }: any = {}) => {
    try {
      return await quality.previewRule(projectId, datasetId, rule);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not preview the rule' };
    }
  });

  // "Show failing rows": one window of the rows a stored rule fails, with the
  // grid's own search/sort/paging. Same reply shape as `dataset:page`.
  ipcMain.handle('quality:failingRows', async (_e, { projectId, datasetId, ruleId, offset, limit, search, sortColumn, sortDir }: any = {}) => {
    try {
      const filter = await quality.failingRowFilter(projectId, datasetId, String(ruleId || ''));
      if ('error' in filter) return { ok: false, error: filter.error };
      return await pageFor(projectId, datasetId, { offset, limit, search, sortColumn, sortDir, rowFilter: filter }, 'qualityFailingRows');
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read the failing rows' };
    }
  });
}
