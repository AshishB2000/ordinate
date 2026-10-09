// "This dataset has new rows" — the push every open tab of a project reader
// gets after a successful refresh (docs/live-data/00-plan.md, L0.1) — MAIN PROCESS.
//
// ONE announcement for every door a refresh comes through: the dataset row's
// and the dashboard's ↻ (`dataset:refresh`), the scheduler's tick, a pipeline
// run — all of which go through queueRefresh (./refreshJob) — and the SQL
// datasets re-run downstream of a change (./datasetDependents). The browser
// (web/src/api/freshness.ts) invalidates that dataset's figures, so an open
// dashboard redraws without a reload.
//
// Delivered as the scheduler's was before (src/server/jobs/schedules.ts
// `pushToReaders`): to the tabs of the members who may READ the project — not
// the whole org (T6.3: the payload names the dataset) — on every pod, over
// the Postgres fan-out. Without a database it is the dev org's own tabs.
//
// The payload is the scheduler's `AutoRefreshOutcome` shape:
// `{ projectId, datasetId, name, ok: true, rowsBefore, rowsAfter }` — without
// the tick's optional `alertsFired`, which is counted after the refresh lands
// and which no tab reads (the alerts arrive as their own `alerts:fired`). A
// failed refresh is not announced here; the scheduler still pushes its own.
//
// It never throws and never delays the refresh: a push that fails (no request
// context, a reader lookup that errs) is dropped — a tab that missed it
// re-reads on its next view, or on reconnect.

export const REFRESHED_CHANNEL = 'hub:dataset-refreshed';

export interface Refreshed {
  projectId: string;
  datasetId: string;
  name: string;
  ok: true;
  rowsBefore: number;
  rowsAfter: number;
}

export function announceRefreshed(o: Omit<Refreshed, 'ok'>): void {
  try {
    // Lazy: the scheduler's module loads the refresh path itself, and nothing
    // here should load server delivery where a test runs without it.
    const schedules = require('../server/jobs/schedules') as typeof import('../server/jobs/schedules');
    const payload: Refreshed = { projectId: o.projectId, datasetId: o.datasetId, name: o.name, ok: true, rowsBefore: o.rowsBefore, rowsAfter: o.rowsAfter };
    schedules.pushToReaders(o.projectId, REFRESHED_CHANNEL, payload);
  } catch (_) {
    // Outside a request or a job (no org to address): nobody to tell.
  }
}
