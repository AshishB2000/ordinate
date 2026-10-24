// The ONE shutdown sequence — SERVER ONLY (docs/pod-lifecycle/00-design.md §3.1).
// main.ts runs it on SIGTERM/SIGINT; it never relies on Fastify's hook order.
//
//   T = SHUTDOWN_GRACE_SECONDS, from the signal. Each step moves on the moment
//   its await settles; the times are caps, so an idle pod exits in milliseconds.
//
//   1  draining: /readyz 503, new jobs refused
//   2  the scheduled-job runner stops claiming (awaited with step 3)
//   3  in-process jobs: waited for until 0.5 T, then cancelled through their
//      signal; each owner's tab hears (the bus is still up for a remote tab)
//   3b the bus stops                                                  ≤ 0.7 T
//   4  app.close(): streams end, in-flight HTTP finishes; at 0.7 T every
//      request still running is aborted (503) and its socket closed  ≤ 0.8 T
//   5  RPC handlers that outlived their reply                         ≤ 0.8 T
//   5b EVERY DuckDB call is interrupted — unconditionally: a runner claim, a
//      subscription, a republish or a fresh-on-ask pull owns DuckDB work that
//      none of the above can see
//   6  every DuckDB worker closed through its own queue; the S3 credential
//      instance (main thread) closed                                 ≤ 0.95 T
//   6b compute threads, then the Postgres pool                          ≤ T
//
// Returns the DuckDB workers still alive (by org); main.ts never exits around one.

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import * as duck from '../engine/duckdb';
import * as computePool from '../engine/computePool';
import * as s3 from '../engine/s3';
import * as jobs from '../app/jobs';
import { appPool, background } from './app';
import { abortRequests, Restarting, settleWork, startDraining } from './lifecycle';
import { restartedWhileRunning } from './lifecycleMessages';

/** Resolves with `p`'s value, or undefined at `deadlineAt` — whichever is first. */
function capped<T>(p: Promise<T>, deadlineAt: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), Math.max(0, deadlineAt - Date.now())); });
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function shutdown(app: FastifyInstance, budgetMs: number, log: FastifyBaseLogger): Promise<string[]> {
  const t0 = Date.now();
  const at = (f: number): number => t0 + Math.round(budgetMs * f);
  /** A failing step is logged and the sequence goes on: nothing may skip the DuckDB close. */
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log.error({ err, step: name }, 'shutdown step failed');
    }
  };

  startDraining();
  jobs.refuseNew(() => new Restarting());
  log.info({ budgetMs }, 'shutting down');
  const bg = background();
  const runner = bg.runner ? bg.runner.stop() : Promise.resolve();

  await step('jobs', async () => {
    const left = await jobs.drain(at(0.5), new Restarting(restartedWhileRunning()), Math.min(1000, budgetMs * 0.05));
    if (left.length) log.warn({ jobs: left.map((j) => ({ id: j.id, kind: j.kind })) }, 'jobs still running at the shutdown deadline');
    if ((await capped(runner.then(() => true), at(0.55))) !== true) log.warn('a scheduled job was still running; its lease lapses and another pod retakes it');
  });
  await step('bus', () => capped(bg.bus ? bg.bus.stop() : Promise.resolve(), at(0.7)));
  await step('http', async () => {
    const closed = app.close();
    if ((await capped(closed.then(() => true), at(0.7))) === true) return;
    const aborted = abortRequests(new Restarting());
    await sleep(Math.min(250, Math.max(0, at(0.8) - Date.now())));
    app.server.closeAllConnections();
    log.warn({ aborted }, 'requests still running at the HTTP deadline were answered 503');
    await capped(closed, at(0.8));
  });
  await step('detached', () => capped(settleWork(), at(0.8)));
  duck.interruptAll();
  let survivors: string[] = [];
  await step('duckdb', async () => {
    // The workers and the S3 credential instance (main thread) close side by side, under one
    // deadline; a lookup still running then is a survivor like a worker: never exited around.
    const [workers, s3Closed] = await Promise.all([duck.closeAll(at(0.95)), s3.close(at(0.95))]);
    survivors = s3Closed ? workers : [...workers, 's3'];
  });
  await step('compute', () => capped(computePool.shutdown(), at(1)));
  await step('postgres', async () => {
    const pool = appPool();
    if (pool && (await capped(pool.end().then(() => true), at(1))) !== true) log.warn('Postgres clients were still checked out at the deadline');
  });
  log.info({ ms: Date.now() - t0, survivors: survivors.length }, 'shutdown finished');
  return survivors;
}
