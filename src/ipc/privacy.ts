import { ipcMain } from 'electron';
import * as store from '../app/privacyStore';
import * as sharePolicy from '../app/sharePolicy';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import { sanitizeEncoding } from '../analysis/visuals';

// Privacy IPC — sensitivity proposals, the Share policy, and the policy applied
// to a chart the renderer already holds (Copy data, a pivot's CSV).
//
// Nothing here ever returns the project's masking key: replies carry levels,
// column names, the policy and masked TOKENS, and the tests hold every channel
// to that (scripts/test-sharePolicy.ts). Ids are UUID-checked in the stores.

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function register(): void {
  /** Settings → Privacy: the policy, every dataset's marked columns and its pending proposals. */
  ipcMain.handle('privacy:overview', async (_e, { projectId }: { projectId?: unknown } = {}) => {
    try {
      const pid = str(projectId);
      const project = await projects.getProject(pid);
      if (!project) return { ok: false, error: 'That project is gone.' };
      const [policy, reviews, list] = await Promise.all([store.getPolicy(pid), store.allReviews(pid), datasets.listDatasets(pid)]);
      const out = [];
      for (const d of list) {
        const sensitive = await sharePolicy.markedColumns(pid, d.id);
        const pending = (reviews[d.id] ? reviews[d.id].pending : []).filter((p) => !sensitive.some((m) => m.column === p.column));
        if (sensitive.length || pending.length) out.push({ id: d.id, name: d.name, sensitive, pending });
      }
      return { ok: true, projectName: project.name, policy, datasets: out, datasetCount: list.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read the privacy settings.' };
    }
  });

  ipcMain.handle('privacy:setPolicy', async (_e, { projectId, policy }: { projectId?: unknown; policy?: unknown } = {}) => {
    const next = await store.setPolicy(str(projectId), policy);
    return next ? { ok: true, policy: next } : { ok: false, error: 'Could not save the share policy.' };
  });

  /** One dataset's pending proposals plus the levels already on its columns. */
  ipcMain.handle('privacy:review', async (_e, { projectId, datasetId }: { projectId?: unknown; datasetId?: unknown } = {}) => {
    const pid = str(projectId);
    const did = str(datasetId);
    const [review, marked, policy] = await Promise.all([store.getReview(pid, did), sharePolicy.markedColumns(pid, did), store.getPolicy(pid)]);
    const levels: Record<string, string> = {};
    for (const m of marked) levels[m.column] = m.level;
    // A column marked since the scan (from its Details popover, say) is decided.
    return { ok: true, pending: review.pending.filter((p) => !levels[p.column]), levels, policy };
  });

  ipcMain.handle('privacy:decide', async (_e, { projectId, datasetId, column, level }: Record<string, unknown> = {}) =>
    ({ ok: await store.decide(str(projectId), str(datasetId), str(column), level) }));

  /** Detect again over the stored table — for datasets imported before detection existed. */
  ipcMain.handle('privacy:scan', async (_e, { projectId, datasetIds }: { projectId?: unknown; datasetIds?: unknown } = {}) => {
    const pid = str(projectId);
    const ids = Array.isArray(datasetIds) ? datasetIds.map(str).filter(Boolean) : (await datasets.listDatasets(pid)).map((d) => d.id);
    let found = 0;
    for (const id of ids) found += (await store.scanDataset(pid, await datasets.getDataset(pid, id))).length;
    return { ok: true, found, scanned: ids.length };
  });

  /** "2 sensitive columns will be masked" for an export dialog. */
  ipcMain.handle('privacy:summary', async (_e, { projectId, path, datasetIds }: Record<string, unknown> = {}) => {
    if (!store.isSharePath(path)) return { ok: false, error: 'Unknown share path.' };
    const ids = Array.isArray(datasetIds) ? datasetIds.map(str).filter(Boolean) : null;
    return { ok: true, ...(await sharePolicy.policySummary(str(projectId), ids, path)) };
  });

  /**
   * The policy applied to a chart reply the renderer already holds, for the
   * two exports that copy what is on screen (Copy data, a pivot's CSV). The
   * reply is only ever an INPUT here — what comes back is at most as revealing
   * as what went in.
   */
  ipcMain.handle('privacy:shareReply', async (_e, { projectId, datasetId, encoding, reply, path }: Record<string, unknown> = {}) => {
    if (!store.isSharePath(path) || path === 'bundle') return { ok: false, error: 'Unknown share path.' };
    const r = reply && typeof reply === 'object' ? (reply as sharePolicy.ChartReplyLike) : { ok: false };
    return sharePolicy.applyToChart(str(projectId), str(datasetId), sanitizeEncoding(encoding), r, path);
  });
}
