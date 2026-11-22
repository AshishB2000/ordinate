// The evaluation worker, on every pod: claims an `eval_runs` row with FOR UPDATE SKIP LOCKED under a lease and a heartbeat (the pattern of
// ../research/worker.ts). A pod serves at most PER_POD runs at once; the queue is Postgres, so any pod serves any run. A run whose pod
// died is retaken after its lease lapses (the cases already stored are never asked again), up to MAX_ATTEMPTS times, then failed.

import { randomUUID } from 'crypto';
import * as os from 'os';
import type { FastifyBaseLogger } from 'fastify';
import { isDraining } from '../lifecycle';
import { scrubbed } from '../db/pool';
import * as store from './db';
import { LeaseLost, execute, push } from './run';

let pollMs = 1_000;
let leaseMs = store.LEASE_MS;
/** Test hook: a faster poll and a shorter lease. */
export function tuneForTest(o: { pollMs?: number; leaseMs?: number }): void {
  if (o.pollMs) pollMs = o.pollMs;
  if (o.leaseMs) leaseMs = o.leaseMs;
}
let paused = false;
/** Test hook: no worker claims anything while paused (a crash test claims by hand). */
export function pauseForTest(on: boolean): void {
  paused = on;
}

type Log = Pick<FastifyBaseLogger, 'error' | 'warn'>;

/** Why a worker's leases were aborted: the pod is stopping, so its runs are handed back (not failed, not counted as an attempt). */
export class Stopping extends Error {
  constructor() {
    super('the evaluation worker is stopping');
    this.name = 'Stopping';
  }
}

/** Runs `run` under a heartbeat. A throw is the run's failure: ids and a code in the log, never a question or a reply. */
export async function work(run: store.Run, owner: string, log: Log, leases: Set<AbortController> = new Set()): Promise<void> {
  const lease = new AbortController();
  leases.add(lease);
  const beat = setInterval(() => {
    void store.heartbeat(run.orgId, run.id, owner, leaseMs).then((held) => { if (!held) lease.abort(new LeaseLost()); }, () => undefined);
  }, Math.max(200, leaseMs / 3));
  try {
    await execute(store.db(), run, owner, lease.signal);
  } catch (err) {
    if (err instanceof LeaseLost || lease.signal.aborted) {
      clearInterval(beat); // before the release: a late heartbeat tick must not extend the lease it just lapsed
      if (lease.signal.reason instanceof Stopping) await store.release(run.orgId, run.id, owner).catch(() => undefined); // handed back: another pod takes it at once
      else log.warn({ run: run.id }, 'evaluation run stopped: its lease was lost');
      return;
    }
    log.error({ err: scrubbed(err, ''), run: run.id }, 'evaluation run failed');
    await store.finish(run.orgId, run.id, owner, 'failed', 'error').then(() => push(run, 'failed'), () => undefined);
  } finally {
    clearInterval(beat);
    leases.delete(lease);
  }
}

export interface EvalWorker { stop(): Promise<void>; tick(): Promise<number> }
let latest: EvalWorker | null = null;
/** Test hook: the worker the app started last. */
export const latestForTest = (): EvalWorker | null => latest;

export function startEvalWorker(log: Log): EvalWorker {
  const owner = `${os.hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;
  const running = new Set<Promise<void>>();
  const leases = new Set<AbortController>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  /** Claims up to the free slots; returns how many it started. */
  async function tick(): Promise<number> {
    if (stopped || paused || isDraining() || !store.dbOrNull()) return 0;
    let started = 0;
    try {
      for (const gone of await store.failExhausted()) push(gone, 'failed');
      while (running.size < store.PER_POD) {
        const run = await store.claim(owner, leaseMs);
        if (!run) break;
        const p: Promise<void> = work(run, owner, log, leases).finally(() => running.delete(p));
        running.add(p);
        started += 1;
      }
    } catch (err) {
      if (!stopped) log.warn({ err: scrubbed(err, '') }, 'evaluation queue poll failed');
    }
    return started;
  }
  const loop = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick().finally(loop), pollMs);
    timer.unref();
  };
  loop();
  latest = {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const l of leases) l.abort(new Stopping());
      await Promise.allSettled(running);
    },
  };
  return latest;
}
