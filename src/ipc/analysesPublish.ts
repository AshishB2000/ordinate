// Drafts and Publish — `analysis:publish`, `analysis:unpublish`, `analysis:discard`
// (src/api/analyses.ts). The writes are src/analysis/publishDashboard.ts; this is
// their replies. None returns the published copy's sheets: the view page reads
// them through `analysis:open { published: true }`.

import { ipcMain } from './bus';
import * as drafts from '../analysis/publishDashboard';
import { contentTag, isRecordChanged } from '../app/editConflict';
import { dashboardGone } from '../analysis/savedViewMessages';
import { nothingPublished } from '../analysis/draftMessages';

export function register(): void {
  ipcMain.handle('analysis:publish', async (_e, { projectId, id, base }: any = {}) => {
    try {
      const r = await drafts.publish(projectId, id, base);
      return r ? { ok: true, status: r.status, published: drafts.metaOf(r.analysis.published) } : { ok: false, error: dashboardGone() };
    } catch (err: any) { // any: a write's throw
      if (isRecordChanged(err)) throw err; // the route's 409, with the current tag
      return { ok: false, error: err?.message || dashboardGone() };
    }
  });

  ipcMain.handle('analysis:unpublish', async (_e, { projectId, id }: any = {}) => {
    const r = await drafts.unpublish(projectId, id);
    return r ? { ok: true, status: r.status } : { ok: false, error: dashboardGone() };
  });

  // The restored draft and its tag: the open editor's next base.
  ipcMain.handle('analysis:discard', async (_e, { projectId, id }: any = {}) => {
    const r = await drafts.discard(projectId, id);
    if (r === 'draft') return { ok: false, error: nothingPublished() };
    if (!r) return { ok: false, error: dashboardGone() };
    const { published, ...analysis } = r.analysis;
    return { ok: true, analysis, tag: contentTag('dashboard', r.analysis), status: r.status, published: drafts.metaOf(published) };
  });
}
