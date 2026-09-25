import { ipcMain } from 'electron';
import * as versions from '../app/versions';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as metrics from '../analysis/metrics';
import * as reportSpec from '../analysis/reportSpec';
import * as datasets from '../data/datasets';

// Version history IPC — list a record's saves, read one, restore one.
//
// A RESTORE IS A SAVE. The old content goes back through the record's OWN store
// update (so it is re-sanitized exactly like an edit would be) and the result is
// recorded as a new version with `restoredFrom` — history stays append-only,
// and undoing a restore is restoring the version before it.
//
// A dataset's version is its prepare pipeline: restoring one re-runs
// updateSteps over the immutable source. The source Parquet is never touched.

// ponytail: restore writes one of five record shapes; each store sanitizes its own
async function writeBack(projectId: string, type: string, id: string, rec: any): Promise<any> {
  if (type === 'dashboard') {
    return analysis.updateAnalysis(projectId, id, { name: rec.name, sheets: rec.sheets, filters: rec.filters, style: rec.style });
  }
  if (type === 'visual') {
    return visuals.updateVisual(projectId, id, {
      name: rec.name, chartType: rec.chartType, encoding: rec.encoding, overrides: rec.overrides, filters: rec.filters,
    });
  }
  if (type === 'metric') {
    return metrics.updateMetric(projectId, id, {
      name: rec.name, definition: rec.definition, filters: rec.filters, format: rec.format,
      // '' clears a description the restored version did not have.
      description: rec.description === undefined ? '' : rec.description,
      direction: rec.direction === undefined ? null : rec.direction,
    });
  }
  if (type === 'report') {
    return reportSpec.updateReport(projectId, id, {
      name: rec.name, format: rec.format, pages: rec.pages, cover: rec.cover, paper: rec.paper,
      includeFilters: rec.includeFilters, narrative: rec.narrative,
      schedule: rec.schedule === undefined ? null : rec.schedule,
    });
  }
  if (type === 'dataset') {
    const res = await datasets.updateSteps(projectId, id, Array.isArray(rec.steps) ? rec.steps : []);
    return res ? { id, steps: res.dataset.steps || [] } : null;
  }
  return null;
}

export function register(): void {
  ipcMain.handle('versions:list', async (_e, { projectId, type, id }: any = {}) =>
    versions.list(String(projectId || ''), String(type || ''), String(id || '')));

  ipcMain.handle('versions:get', async (_e, { projectId, type, id, key }: any = {}) =>
    versions.get(String(projectId || ''), String(type || ''), String(id || ''), String(key || '')));

  ipcMain.handle('versions:restore', async (_e, { projectId, type, id, key }: any = {}) => {
    try {
      const pid = String(projectId || '');
      const rid = String(id || '');
      if (!versions.isVersionType(type)) return { ok: false, error: 'Unknown record type.' };
      const v = await versions.get(pid, type, rid, String(key || ''));
      if (!v) return { ok: false, error: 'That version is gone.' };
      const saved = await writeBack(pid, type, rid, v.record);
      if (!saved) return { ok: false, error: 'The record could not be restored — it may have been deleted.' };
      const meta = await versions.record(pid, type, saved, { restoredFrom: v.savedAt });
      return { ok: true, record: saved, version: meta, unchanged: meta === null };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Restore failed.' };
    }
  });
}
