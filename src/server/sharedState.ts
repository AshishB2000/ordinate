// What every pod shares through Postgres so that any pod can serve any request
// (docs/any-pod/00-design.md): the abuse counters, the file tokens, the staged
// imports, the plan-run clock, and the job that sweeps what has expired. Wired once the schema is current (./app.ts); without
// DATABASE_URL nothing here runs and each store keeps its in-process copy.

import type { Pool } from 'pg';
import { ctx } from './context';
import * as counters from './counters';
import * as fileTokens from './fileTokens';
import * as stageStore from '../data/stageStore';
import * as planStore from '../ai/planStore';
import { useLeaseDb } from '../app/runLease';
import { pruneAudit } from './authz/audit';
import { defineJob } from './jobs/runner';

/** How often each org's expired tokens, stages, counter windows, plan runs and audit rows are swept. */
export const SHARED_SWEEP_EVERY_MS = 5 * 60_000;

let pool: Pool | null = null;
let defined = false;
let auditDays: number | null = null;

/** One pass for the job's org. Each part is independent: one failing does not stop the rest. */
export async function sweepOrg(p: Pool): Promise<void> {
  const org = ctx().org.id;
  const parts: Array<() => Promise<unknown>> = [
    () => counters.sweepEnded(p, org),
    () => fileTokens.sweep(p, org),
    () => stageStore.sweep(p, org),
    () => planStore.prune(),
    () => pruneAudit(p, org, auditDays),
  ];
  const errors: unknown[] = [];
  for (const part of parts) await part().catch((err: unknown) => errors.push(err));
  if (errors.length) throw errors[0]; // the runner logs it and records last_error
}

/** `auditRetentionDays`: AUDIT_RETENTION_DAYS (null keeps every audit row). */
export function wireSharedState(p: Pool, log: stageStore.Log, auditRetentionDays: number | null = null): void {
  pool = p;
  auditDays = auditRetentionDays;
  counters.useCounterDb(p);
  fileTokens.useFileTokenDb(p);
  stageStore.useStageDb(p, log);
  planStore.usePlanDb(p, log);
  useLeaseDb(p);
  if (defined) return; // a second app in one process (tests) shares the kind
  defined = true;
  defineJob('shared:sweep', {
    everyMs: SHARED_SWEEP_EVERY_MS,
    run: async () => { if (pool) await sweepOrg(pool); },
  });
}

/** On close: nothing reads a pool that has gone. */
export function unwireSharedState(): void {
  pool = null;
  counters.useCounterDb(null);
  fileTokens.useFileTokenDb(null);
  stageStore.useStageDb(null);
  planStore.usePlanDb(null);
  useLeaseDb(null);
}
