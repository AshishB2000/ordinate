import { ipcMain } from 'electron';
import * as visuals from '../visuals';
import * as datasets from '../datasets';
import { buildVizData } from '../vizData';
import { sanitizeEncoding, sanitizeChartType } from '../visuals';
import { computeColumnSummary } from '../datasetStats';
import { suggestChart } from '../analyze';

// Visuals (saved charts/maps) IPC — list/get/save/update/delete a Visual, plus
// `visual:data` which loads a dataset and runs the PURE bridge (src/vizData.ts) to
// produce the exact `{labels, series}` (+ optional geo) the renderers consume. All
// are ipcMain.handle (request/response); a thrown error becomes { ok:false, error }
// so the renderer never sees an unhandled rejection. No deps object (pure disk),
// matching projects.register()/datasets.register().
//
// Number-accuracy: ALL aggregation math stays in the tested pure bridge, run in
// MAIN — the renderer never computes a figure and no model is involved. Visual
// overrides are chart STYLING only; visual filters are transforms filter steps
// applied to the rows BEFORE aggregation (still app-computed, strict number rule).

// Compact, plain-text column summary for the OPTIONAL AI chart suggestion. Every
// stat is app-computed (datasetStats) and embedded as a FACT — the model proposes
// chart STRUCTURE referencing these column names and never a data value/number.
function buildColumnSummaryText(ds: datasets.Dataset): string {
  const lines: string[] = [];
  lines.push(`Dataset: "${ds.name}" (${ds.rowCount} rows, ${ds.columns.length} columns).`);
  lines.push('Columns:');
  ds.columns.forEach((col, c) => {
    const s = computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null)));
    if (s.type === 'number') {
      lines.push(`- ${s.name} (number): ${s.count ?? 0} numeric values, ${s.nonEmpty} non-empty`);
    } else {
      lines.push(`- ${s.name} (${s.type}): ${s.distinct ?? 0} distinct, ${s.nonEmpty} non-empty`);
    }
  });
  return lines.join('\n');
}

export function register() {
  ipcMain.handle('visual:list', async (_e, { projectId }: any = {}) => visuals.listVisuals(projectId));

  ipcMain.handle('visual:get', async (_e, { projectId, id }: any = {}) => visuals.getVisual(projectId, id));

  ipcMain.handle('visual:save', async (_e, { projectId, datasetId, name, chartType, encoding, overrides, filters }: any = {}) => {
    try {
      const saved = await visuals.saveVisual(projectId, { name, datasetId, chartType, encoding, overrides, filters });
      if (!saved) return { ok: false, error: 'Invalid project/dataset, or it no longer exists' };
      return saved;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the visual' };
    }
  });

  ipcMain.handle('visual:update', async (_e, { projectId, id, name, chartType, encoding, overrides, filters }: any = {}) => {
    try {
      const visual = await visuals.updateVisual(projectId, id, { name, chartType, encoding, overrides, filters });
      return visual ? { ok: true, visual } : { ok: false, error: 'Could not update the visual' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the visual' };
    }
  });

  ipcMain.handle('visual:delete', async (_e, { projectId, id }: any = {}) => ({
    ok: await visuals.deleteVisual(projectId, id),
  }));

  // Duplicate a saved visual into an independent copy (new UUID, name + " (copy)",
  // dataset/encoding/type/overrides/filters copied). Returns the new Visual.
  ipcMain.handle('visual:duplicate', async (_e, { projectId, id }: any = {}) => {
    try {
      const copy = await visuals.duplicateVisual(projectId, id);
      return copy ? { ok: true, visual: copy } : { ok: false, error: 'Could not duplicate the visual' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to duplicate the visual' };
    }
  });

  // Load the dataset's DERIVED columns/rows and run the pure bridge. The encoding
  // and filters are untrusted renderer input → sanitized before the math. Visual
  // filters (transforms filter steps) are applied to rows BEFORE aggregation.
  ipcMain.handle('visual:data', async (_e, { projectId, datasetId, encoding, filters }: any = {}) => {
    try {
      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: false, error: 'Dataset not found' };
      const result = buildVizData(ds.columns, ds.rows, sanitizeEncoding(encoding), visuals.sanitizeFilters(filters));
      return { ok: true, data: result.data, recommendedShape: result.recommendedShape, warnings: result.warnings };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the visual data' };
    }
  });

  // OPTIONAL AI chart suggestion. Builds the SAME compact column summary (app-
  // computed stats as facts), asks the model to propose STRUCTURE ONLY (a single
  // encoding + chart type referencing the given columns), sanitizes it, and returns
  // it WITHOUT saving — the renderer populates the builder for the user to review.
  // No model configured → { ok:false, notReady:true } for a gentle hint.
  ipcMain.handle('visual:suggest', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const ds = await datasets.getDataset(projectId, datasetId);
      if (!ds) return { ok: false, error: 'Dataset not found' };
      const res = await suggestChart(buildColumnSummaryText(ds));
      if (res.ok) {
        return { ok: true, encoding: sanitizeEncoding(res.encoding), chartType: sanitizeChartType(res.chartType) };
      }
      if (res.errorType === 'not_ready') return { ok: false, notReady: true };
      return { ok: false, error: res.message || 'Could not suggest a chart' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to suggest a chart' };
    }
  });
}
