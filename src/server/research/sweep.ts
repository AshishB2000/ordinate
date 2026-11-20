// The per-org sweep of research runs: a scheduled job (src/server/jobs/runner.ts, one row per org) that deletes the runs of people who
// are no longer in the org, and runs older than 90 days that were never added to a project. A Story, once added, is not touched.

import { ctx } from '../context';
import { defineJob } from '../jobs/runner';
import * as store from './db';

const EVERY_MS = 6 * 60 * 60_000;

let wired = false;

export function wireResearchSweep(): void {
  if (wired) return; // a kind is defined once per process (the tests build several apps)
  wired = true;
  defineJob('research:sweep', { everyMs: EVERY_MS, run: async () => { await store.sweep(ctx().org.id); } });
}
