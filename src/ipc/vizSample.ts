import { ipcMain } from 'electron';
import * as visuals from '../analysis/visuals';
import { paramValues, resolveFilterParams } from '../analysis/params';
import { sanitizeEncoding } from '../analysis/visuals';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { vizDataFor } from './visuals';
import { withPeriodOverlay } from './visualsOverlay';
import { withAnalytics } from './visualsAnalytics';
import { sanitizeOverlays } from '../analysis/analytics';

// The visual BUILDER's preview — MAIN PROCESS. Split from ./visuals.ts at its cap.
//
// `visual:preview` is `visual:data` with one difference: when the answer has
// no resident fast path and the table is over SAMPLE_MIN_ROWS, it is computed
// on an app-chosen, category-stratified sample (analysis/sampling) instead of
// a full hydrate, and the reply says so. Only the builder calls it. A saved
// visual, a dashboard tile, an export and every other caller use `visual:data`
// and compute in full.

export function register(): void {
  ipcMain.handle('visual:preview', async (_e, { projectId, datasetId, encoding, filters, params, analytics }: any = {}) => {
    try {
      // Sanitised exactly as `visual:data` sanitises — this is untrusted input.
      const enc = sanitizeEncoding(encoding);
      const values = paramValues(params);
      const bound = resolveFilterParams(visuals.sanitizeFilters(filters), values);
      const run = (p: string, d: string, e: VizEncoding, f: FilterStep[]) =>
        vizDataFor(p, d, e, f, { params: values, sample: true });
      const periods = await withPeriodOverlay(await run(projectId, datasetId, enc, bound.steps), projectId, datasetId, enc, bound.steps, run);
      const reply = await withAnalytics(periods, projectId, sanitizeOverlays(analytics), bound.steps, values);
      return reply.ok && bound.errors.length
        ? { ...reply, warnings: reply.warnings.concat(bound.errors), paramErrors: bound.errors }
        : reply;
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the visual data' };
    }
  });
}
