// The weekly job (docs/autopilot/00-design.md, phase 2): kind `autopilot:weekly`, one row per org in the `jobs` table, polled hourly by
// every server. For each project that is switched on and not paused, it claims this week's run (a table row: exactly one server gets it,
// whoever polls) and runs it. The same tick prunes old usage rows. Postgres only.

import { logger } from '../../app/logger';
import { ctx } from '../context';
import { defineJob } from '../jobs/runner';
import { orgDb } from '../db/inOrg';
import { runProject } from './run';
import * as store from './store';
import { tellAdmins } from './tell';

const EVERY_MS = 60 * 60_000;

let wired = false;
export function wireAutopilot(): void {
  if (wired) return; // a kind is defined once per process (the tests build several apps)
  wired = true;
  defineJob('autopilot:weekly', { everyMs: EVERY_MS, run: async (_target, stopAt) => weeklyForOrg(new Date(), stopAt) });
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** Every due project of the caller's org. Past `stopAt` it starts no new project (true: some are left; the row is due again at once). */
export async function weeklyForOrg(now: Date, stopAt = Infinity): Promise<boolean> {
  if (!orgDb()) return false;
  const today = dayOf(now);
  const week = store.mondayOf(today);
  for (const s of (await store.allSettings()).values()) {
    if (!s.enabled || s.pausedReason !== null) continue;
    if (Date.now() >= stopAt) return true;
    const runId = await store.claimWeek(s.projectId, week, s.windowDays);
    if (!runId) continue; // another server has this week
    const out = await runProject(runId, s, today);
    if (out.state !== 'failed') await tellAdmins({ projectId: s.projectId, runId, state: out.state, counts: out.counts }, { who: s.runAs ?? '' });
  }
  await store.pruneUsage().catch((err: unknown) => logger.warn('[autopilot] pruning usage failed:', err instanceof Error ? err.message : String(err)));
  return false;
}

/** "Run now": the same body at once, as a manual run. Returns the run's id, or null when it failed to start. */
export async function runNow(projectId: string): Promise<string | 'busy' | null> {
  const s = await store.getSettings(projectId);
  const runId = await store.startManual(projectId, s.windowDays);
  if (runId === null) return 'busy'; // a run of this project is going: a double click, a second admin, or the weekly tick
  const today = dayOf(new Date());
  // A manual run acts as the admin pressing it (they asked), and only if Autopilot is on: the saved admin otherwise.
  const out = await runProject(runId, { ...s, runAs: ctx().user.email }, today);
  if (out.state === 'failed') return null;
  await tellAdmins({ projectId, runId, state: out.state, counts: out.counts }, { except: ctx().user.email, who: ctx().user.email });
  return runId;
}
