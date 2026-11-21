// The per-org sweep of evaluation rows: a scheduled job (src/server/jobs/runner.ts, one row per org) that deletes hidden conversations a
// crash left, runs past the newest 30 of a suite, and the question text of a thumbs-down whose conversation (or asker) is gone.

import { ctx } from '../context';
import { defineJob } from '../jobs/runner';
import * as store from './db';

const EVERY_MS = 60 * 60_000;

let wired = false;

export function wireEvalSweep(): void {
  if (wired) return; // a kind is defined once per process (the tests build several apps)
  wired = true;
  defineJob('evals:sweep', { everyMs: EVERY_MS, run: async () => { await store.sweep(ctx().org.id); } });
}
