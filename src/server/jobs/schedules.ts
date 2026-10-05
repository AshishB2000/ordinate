// The server's schedules: the desktop's one-minute tick, run through the jobs
// table (./runner.ts) once per org instead of on a per-process timer.
//
// The desktop wires src/app/refreshScheduler.ts in src/app/refreshWiring.ts
// (unchanged; it still runs there). This is the server's copy of that wiring,
// and it runs the SAME tickNow, so everything that rides the tick keeps its
// order — due dataset refreshes, then alert rules (the anomaly watch is an
// `anomaly` rule) and quality checks on the fresh data, then the after-tick
// work: pipeline crons (src/app/pipelineRunner.tick → pipelineCron) and the
// Trash purge.
//
// What changes on the server is delivery — no OS notification, no hub window:
//   hub:dataset-refreshed  → every tab of a member who may READ the project
//   alerts:fired           → the same, one per project per tick
// both through sse.publish, so a tab on any pod gets them. Not the whole org
// (T6.3): an alert carries the project's figures and a refresh its dataset's
// name, and an org member with no grant on the project must see neither. A
// refresh error is cut like every other origin text (no URL query, no path).
//
// Not carried over: `reports:run-due` (the desktop renderer generates reports;
// the server has no generator until the reports port), the alert "explain"
// model call (T2.12 routes AI keys first).

import * as scheduler from '../../app/refreshScheduler';
import * as config from '../../app/config';
import * as pipelineRunner from '../../app/pipelineRunner';
import * as alertStore from '../../analysis/alertStore';
import type { Pool } from 'pg';
import { redactOriginText } from '../../data/datasetOrigin';
import { readerEmails } from '../authz/index';
import { ctx } from '../context';
import { publish } from '../sse';
import { defineJob } from './runner';
import { scheduleRepublish } from '../../publish/hosted';

/** The desktop tick's interval (refreshScheduler TICK_MS). */
export const TICK_EVERY_MS = 60_000;

let wired = false;
let readersVia: { pool: Pool; devAuth: boolean } | null = null;

/**
 * Pushes `channel` to the tabs of every member who may read `projectId`. Under
 * dev sign-in (`everyone`) there is one identity and it is an org admin, so the
 * org is the same set of tabs.
 */
export async function toReaders(pool: Pool, everyone: boolean, projectId: string, channel: string, payload: unknown): Promise<void> {
  const org = ctx().org.id;
  if (everyone) return publish({ org }, channel, payload);
  for (const user of await readerEmails(pool, org, projectId)) publish({ org, user }, channel, payload);
}

/**
 * `toReaders` for a handler outside the tick (an "evaluate now", a comment
 * written — T2.9). Without Postgres there are no grants and the one identity is
 * the dev admin, so the org's tabs are the readers.
 */
export function pushToReaders(projectId: string, channel: string, payload: unknown): void {
  if (!readersVia) return publish({ org: ctx().org.id }, channel, payload);
  void toReaders(readersVia.pool, readersVia.devAuth, projectId, channel, payload).catch(() => undefined);
}

/**
 * Hooks the tick's callbacks to server delivery and declares the `tick` job.
 * Once per process. `devAuth`: AUTH_MODE=dev (see `toReaders`).
 */
export function wireSchedules(pool: Pool, devAuth: boolean): void {
  if (wired) return;
  wired = true;
  readersVia = { pool, devAuth };
  const push = (projectId: string, channel: string, payload: unknown): void => {
    void toReaders(pool, devAuth, projectId, channel, payload).catch(() => undefined);
  };

  scheduler.setEnabledCheck(() => config.get().autoRefresh !== false);
  scheduler.onRefreshed((o) => {
    push(o.projectId, 'hub:dataset-refreshed', o.error === undefined ? o : { ...o, error: redactOriginText(o.error) });
    // A published site that reads it, opted in, is rebuilt at its link (T2.9; the desktop's job hook).
    if (o.ok) scheduleRepublish(o.projectId, o.datasetId);
  });
  // ipc/alerts' evaluateOnly, which cannot load here (its delivery imports Electron).
  scheduler.onEvaluateAlerts(async (projectId, datasetId) => {
    await alertStore.syncWatchRules(projectId);
    return alertStore.evaluateProject(projectId, datasetId);
  });
  scheduler.onTickAlerts((batches) => {
    for (const b of batches) push(b.projectId, 'alerts:fired', b);
  });
  // ponytail: ipc/pipelines adds this same hook when registered; it is not
  // registered on the server yet — drop this when it is. (ipc/trash is, since
  // T2.2: its own afterTick hook runs the 30-day Trash purge.)
  scheduler.afterTick(() => { void pipelineRunner.tick().catch(() => undefined); });

  defineJob('tick', {
    everyMs: TICK_EVERY_MS,
    run: async () => { await scheduler.tickNow(); },
  });
}
