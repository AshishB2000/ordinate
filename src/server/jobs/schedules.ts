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
//   hub:dataset-refreshed  → every tab of the org (desktop: every hub window)
//   alerts:fired           → every tab of the org, one per project per tick
// both through sse.publish, so a tab on any pod gets them.
//
// Not carried over: `reports:run-due` (the desktop renderer generates reports;
// the server has no generator until the reports port), the alert "explain"
// model call (T2.12 routes AI keys first).

import * as scheduler from '../../app/refreshScheduler';
import * as config from '../../app/config';
import * as trash from '../../app/trash';
import * as pipelineRunner from '../../app/pipelineRunner';
import * as alertStore from '../../analysis/alertStore';
import { ctx } from '../context';
import { publish } from '../sse';
import { defineJob } from './runner';

/** The desktop tick's interval (refreshScheduler TICK_MS). */
export const TICK_EVERY_MS = 60_000;

let wired = false;

/** Hooks the tick's callbacks to server delivery and declares the `tick` job. Once per process. */
export function wireSchedules(): void {
  if (wired) return;
  wired = true;
  const org = () => ({ org: ctx().org.id });

  scheduler.setEnabledCheck(() => config.get().autoRefresh !== false);
  scheduler.onRefreshed((o) => publish(org(), 'hub:dataset-refreshed', o));
  // ipc/alerts' evaluateOnly, which cannot load here (its delivery imports Electron).
  scheduler.onEvaluateAlerts(async (projectId, datasetId) => {
    await alertStore.syncWatchRules(projectId);
    return alertStore.evaluateProject(projectId, datasetId);
  });
  scheduler.onTickAlerts((batches) => {
    for (const b of batches) publish(org(), 'alerts:fired', b);
  });
  // ponytail: ipc/pipelines and ipc/trash add these same hooks when registered;
  // they are not registered on the server yet — drop these two when they are.
  scheduler.afterTick(() => { void pipelineRunner.tick().catch(() => undefined); });
  scheduler.afterTick(() => { void trash.purgeExpired().catch(() => 0); });

  defineJob('tick', {
    everyMs: TICK_EVERY_MS,
    run: async () => { await scheduler.tickNow(); },
  });
}
