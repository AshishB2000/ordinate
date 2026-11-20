// The Slack worker, on every pod: claims a `slack_questions` row with FOR UPDATE SKIP LOCKED under a lease and a
// heartbeat (the src/server/jobs/runner.ts pattern), so a crashed pod's question is retaken by another and the thread
// still gets one answer (./answer.ts edits the placeholder it kept).
//
// A pod serves at most CONCURRENCY questions at once; the queue is Postgres, so any pod serves any question. A question
// that fails is answered with a fixed sentence and marked failed; one whose pod dies is retaken after its lease lapses,
// up to MAX_ATTEMPTS times, then marked failed so a thread is never left waiting.

import { randomUUID } from 'crypto';
import * as os from 'os';
import type { FastifyBaseLogger } from 'fastify';
import { isDraining } from '../lifecycle';
import { scrubbed } from '../db/pool';
import * as say from '../slackMessages';
import { LeaseLost, processQuestion } from './answer';
import { onWake } from './wake';
import { updateMessage } from './client';
import * as store from './db';
import { note } from './render';
import { startSocketManager, type SocketManager } from './socket';

let pollMs = 1_000;
let leaseMs = store.LEASE_MS;
/** Test hook: a faster poll and a shorter lease. */
export function tuneForTest(o: { pollMs?: number; leaseMs?: number }): void {
  if (o.pollMs) pollMs = o.pollMs;
  if (o.leaseMs) leaseMs = o.leaseMs;
}
const CONCURRENCY = 2;
const IDLE_MS = 30_000;
let paused = false;
/** Test hook: no worker claims anything while paused (a crash test claims by hand). */
export function pauseForTest(on: boolean): void {
  paused = on;
}

/** Runs `q` under a heartbeat; a throw is the answer's failure, said in fixed words. */
async function run(q: store.Question, owner: string, log: Pick<FastifyBaseLogger, 'error' | 'warn'>): Promise<void> {
  const pool = store.db();
  // The heartbeat is the lease: when it says the lease is lost (another pod retook the row), the work stops (its signal aborts).
  const lease = new AbortController();
  const beat = setInterval(() => {
    void store.heartbeat(q.id, owner, leaseMs).then((held) => { if (!held) lease.abort(new LeaseLost()); }, () => undefined);
  }, Math.max(200, leaseMs / 3));
  try {
    await processQuestion(pool, q, owner, lease.signal);
  } catch (err) {
    if (err instanceof LeaseLost || lease.signal.aborted) { // the pod that retook it finishes it
      log.warn({ question: q.id }, 'slack question stopped: its lease was lost');
      return;
    }
    log.error({ err: scrubbed(err, '') , question: q.id }, 'slack question failed');
    try {
      const inst = await store.installByTeam(q.teamId);
      const token = inst ? await store.getSecret(q.orgId, 'botToken') : null;
      const latest = await store.questionById(q.orgId, q.id);
      if (token && latest?.placeholderTs) await updateMessage(token, q.channelId, latest.placeholderTs, note(say.failed()));
    } catch {
      // the thread keeps its placeholder; the row below still says failed
    }
    await store.finish(q.id, owner, 'failed', 'error').catch(() => undefined);
  } finally {
    clearInterval(beat);
  }
}

export interface SlackWorker { stop(): Promise<void>; tick(): Promise<number>; sockets: SocketManager }

let latest: SlackWorker | null = null;
/** Test hook: the worker the app started last. */
export const latestForTest = (): SlackWorker | null => latest;

export function startSlackWorker(log: Pick<FastifyBaseLogger, 'error' | 'warn'>): SlackWorker {
  const owner = `${os.hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`;
  const running = new Set<Promise<void>>();
  const sockets = startSocketManager(owner, log); // this pod's Socket Mode connections, if an install asks for them
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let idleUntil = 0; // no workspace switched on: look again later (a question or an install on this pod wakes it)
  const unwake = onWake(() => { idleUntil = 0; });

  /** Claims up to the free slots; returns how many it started. */
  async function tick(): Promise<number> {
    if (stopped || paused || isDraining() || !store.dbOrNull()) return 0;
    let started = 0;
    if (Date.now() < idleUntil) return 0;
    try {
      if (!(await store.anyEnabledInstall())) { // nothing to serve: no claim, no sweep of exhausted rows, until the next look
        idleUntil = Date.now() + IDLE_MS;
        return 0;
      }
      for (const gone of await store.failExhausted()) {
        const inst = await store.installByTeam(gone.teamId);
        const token = inst ? await store.getSecret(gone.orgId, 'botToken') : null;
        if (token && gone.placeholderTs) await updateMessage(token, gone.channelId, gone.placeholderTs, note(say.failed())).catch(() => undefined);
      }
      while (running.size < CONCURRENCY) {
        const q = await store.claim(owner, leaseMs);
        if (!q) break;
        const p: Promise<void> = run(q, owner, log).finally(() => running.delete(p));
        running.add(p);
        started += 1;
      }
    } catch (err) {
      if (!stopped) log.warn({ err: scrubbed(err, '') }, 'slack queue poll failed');
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
    sockets,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      unwake();
      await sockets.stop();
      await Promise.allSettled(running);
    },
  };
  return latest;
}
