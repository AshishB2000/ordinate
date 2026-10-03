// Pipelines IPC — the Data page's Pipelines tab (renderer/hub/pipelinesPage.ts).
//
// Every handler turns a throw into `{ ok:false, error }`. Nothing here decides
// what a node IS (src/app/pipelines.ts) or how it runs (src/app/pipelineRunner);
// schedule edits write the field the record ALREADY has — a dataset's
// autoRefresh, a report's schedule — and the pipeline's own cron, policy and
// pauses go to src/app/pipelineStore.
//
// The pipeline's cron rides the dataset scheduler's tick (refreshScheduler
// .afterTick), so there is no second timer — and in a headless run nothing is
// hooked at all, as the round's wiring asks.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as reportSpec from '../analysis/reportSpec';
import * as versions from '../app/versions';
import { isValidId } from '../app/ids';
import * as store from '../app/pipelineStore';
import * as runner from '../app/pipelineRunner';
import { loadView } from '../app/pipelineView';
import { sanitizePolicy } from '../app/pipelines';
import { describeCron, isValidTimeZone, nextCronRun, parseCron } from '../app/pipelineCron';

const fail = (err: unknown, fallback: string): { ok: false; error: string } =>
  ({ ok: false, error: err instanceof Error && err.message ? err.message : fallback });

/** The next `n` runs of an expression — the editor's live preview. */
export function preview(cron: unknown, tz: unknown, from = Date.now(), n = 3): { ok: boolean; text: string; next: string[] } {
  if (!parseCron(cron) || !isValidTimeZone(tz)) return { ok: false, text: 'Not a valid schedule', next: [] };
  const next: string[] = [];
  let t: number | null = from;
  while (next.length < n && t !== null) {
    t = nextCronRun(cron, tz, t);
    if (t !== null) next.push(new Date(t).toISOString());
  }
  return { ok: true, text: describeCron(cron), next };
}

export function register(deps: { headless?: boolean }): void {
  ipcMain.handle('pipelines:get', async (_e, { projectId }: any = {}) => {
    try {
      if (!isValidId(projectId)) return { ok: false, error: 'Unknown project.' };
      const view = await loadView(projectId);
      return { ...view, live: runner.liveState(projectId) };
    } catch (err) {
      return fail(err, 'Could not read the pipeline.');
    }
  });

  // Run a node and everything downstream; no node = the whole pipeline.
  ipcMain.handle('pipelines:run', async (_e, { projectId, nodeId }: any = {}) => {
    try {
      if (!isValidId(projectId)) return { ok: false, error: 'Unknown project.' };
      if (nodeId !== undefined && nodeId !== null && !store.isNodeId(nodeId)) return { ok: false, error: 'Unknown step.' };
      return await runner.runFrom(projectId, nodeId ? [nodeId] : [], 'manual');
    } catch (err) {
      return fail(err, 'The pipeline could not run.');
    }
  });

  // The pipeline's own schedule: { cron, tz } sets it, { cron: null } clears it,
  // { paused } pauses or resumes it.
  ipcMain.handle('pipelines:setSchedule', async (_e, { projectId, cron, tz, paused }: any = {}) => {
    try {
      if (!isValidId(projectId)) return { ok: false, error: 'Unknown project.' };
      if (cron !== undefined && cron !== null && (!parseCron(cron) || !isValidTimeZone(tz))) {
        return { ok: false, error: 'That is not a schedule: five fields — minute, hour, day, month, weekday.' };
      }
      const s = await store.update(projectId, (st) => {
        if (cron === null) { delete st.schedule; return; }
        if (cron !== undefined) {
          const same = st.schedule && st.schedule.cron === String(cron).trim().split(/\s+/).join(' ') && st.schedule.tz === tz;
          // A changed schedule starts counting now: it must not fire at once for a slot it never had.
          st.schedule = same && st.schedule ? st.schedule : { cron: String(cron), tz: String(tz), paused: false, since: new Date().toISOString() };
        }
        if (paused !== undefined && st.schedule) st.schedule.paused = paused === true;
      });
      return s ? { ok: true } : { ok: false, error: 'Could not save the schedule.' };
    } catch (err) {
      return fail(err, 'Could not save the schedule.');
    }
  });

  ipcMain.handle('pipelines:preview', async (_e, { cron, tz }: any = {}) => preview(cron, tz));

  ipcMain.handle('pipelines:setPolicy', async (_e, { projectId, policy }: any = {}) => {
    try {
      if (!isValidId(projectId)) return { ok: false, error: 'Unknown project.' };
      const s = await store.update(projectId, (st) => { st.policy = sanitizePolicy(policy); });
      return s ? { ok: true, policy: s.policy } : { ok: false, error: 'Could not save the retry policy.' };
    } catch (err) {
      return fail(err, 'Could not save the retry policy.');
    }
  });

  ipcMain.handle('pipelines:setPaused', async (_e, { projectId, nodeId, paused }: any = {}) => {
    try {
      if (!isValidId(projectId) || !store.isNodeId(nodeId)) return { ok: false, error: 'Unknown step.' };
      const s = await store.update(projectId, (st) => {
        st.paused = st.paused.filter((x) => x !== nodeId);
        if (paused === true) st.paused.push(nodeId);
      });
      return s ? { ok: true } : { ok: false, error: 'Could not save.' };
    } catch (err) {
      return fail(err, 'Could not save.');
    }
  });

  // A node's OWN schedule, written to its own record's existing field.
  ipcMain.handle('pipelines:setNodeSchedule', async (_e, { projectId, nodeId, every, cadence, at }: any = {}) => {
    try {
      if (!isValidId(projectId) || !store.isNodeId(nodeId)) return { ok: false, error: 'Unknown step.' };
      const [kind, id] = String(nodeId).split(':');
      if (kind === 'dataset') {
        const ev = every === 'off' || every === null ? null : every;
        if (ev !== null && !['hourly', 'daily', 'weekly'].includes(ev)) return { ok: false, error: 'Unknown interval.' };
        const r = await datasets.setAutoRefresh(projectId, id, { every: ev });
        return r === false ? { ok: false, error: 'This dataset has nothing to re-fetch.' } : { ok: true };
      }
      if (kind === 'report') {
        const before = await reportSpec.getReport(projectId, id);
        if (!before) return { ok: false, error: 'Report not found.' };
        const folder = before.schedule ? before.schedule.folder : '';
        const r = await reportSpec.updateReport(projectId, id, { schedule: { cadence, at, folder } });
        if (r) await versions.record(projectId, 'report', r, { before });
        return r ? { ok: true } : { ok: false, error: 'Could not save the report.' };
      }
      return { ok: false, error: 'This step runs after its inputs; it has no schedule of its own.' };
    } catch (err) {
      return fail(err, 'Could not save the schedule.');
    }
  });

  if (deps.headless) return;
  require('../app/refreshScheduler').afterTick(() => { void runner.tick(); });
}
