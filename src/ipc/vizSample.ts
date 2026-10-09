import { ipcMain } from './bus';
import * as visuals from '../analysis/visuals';
import { paramValues, resolveFilterParams } from '../analysis/params';
import { sanitizeEncoding } from '../analysis/visuals';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { vizDataFor } from './visuals';
import { withPeriodOverlay } from './visualsOverlay';
import { withAnalytics } from './visualsAnalytics';
import { withEvents } from './events'; // r8:events
import { withTableCalcs } from '../analysis/tableCalc';
import { sanitizeOverlays } from '../analysis/analytics';
import { stampAsOf } from '../data/figureAsOf';

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
      // Table calculations on the aggregated grid, exactly as `visual:data` runs them.
      const run = async (p: string, d: string, e: VizEncoding, f: FilterStep[]) =>
        withTableCalcs(await vizDataFor(p, d, e, f, { params: values, sample: true }), e);
      const periods = await withPeriodOverlay(await run(projectId, datasetId, enc, bound.steps), projectId, datasetId, enc, bound.steps, run);
      const reply = await withEvents(await withAnalytics(periods, projectId, sanitizeOverlays(analytics), bound.steps, values), projectId, datasetId, bound.steps); // r8:events
      // Dated like `visual:data` (data/figureAsOf): the builder's preview says how fresh it is too.
      return await stampAsOf(reply.ok && bound.errors.length
        ? { ...reply, warnings: reply.warnings.concat(bound.errors), paramErrors: bound.errors }
        : reply, projectId, [datasetId]);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the visual data' };
    }
  });
}
