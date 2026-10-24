// The process's shutdown state — SERVER ONLY, and a leaf: the draining flag,
// the error a draining pod answers with, and the two things the shutdown waits
// for that nothing else tracks (./shutdown.ts): every in-flight /api/ request's
// abort controller, and every RPC handler's promise (it can outlive its reply:
// ./limits.ts untilAborted).

import { restarting } from './lifecycleMessages';

let draining = false;
const requests = new Set<AbortController>();
const work = new Set<Promise<unknown>>();

/** What a draining pod refuses or aborts with: the route answers 503 with its message (./app.ts). */
export class Restarting extends Error {
  readonly code = 'restarting';
  constructor(message: string = restarting()) {
    super(message);
    this.name = 'Restarting';
  }
}

export function isRestarting(err: unknown): err is Restarting {
  return err instanceof Restarting;
}

/** True from the signal on: /readyz answers 503 and new jobs are refused. */
export function isDraining(): boolean {
  return draining;
}

export function startDraining(): void {
  draining = true;
}

/** Counts `ac` as an in-flight request until the returned function is called. */
export function trackRequest(ac: AbortController): () => void {
  requests.add(ac);
  return () => requests.delete(ac);
}

/** The HTTP deadline: abort every in-flight request with `reason`. Returns how many. */
export function abortRequests(reason: Error): number {
  const n = requests.size;
  for (const ac of requests) ac.abort(reason);
  return n;
}

/** Counts `p` until it settles. `then(del, del)`, never `finally`: that would re-raise its rejection. */
export function trackWork(p: Promise<unknown>): void {
  work.add(p);
  const del = (): void => {
    work.delete(p);
  };
  p.then(del, del);
}

/** Every tracked handler promise still running. */
export function pendingWork(): Promise<unknown>[] {
  return [...work];
}

/** Resolves once nothing tracked is left, work tracked by tracked work too (an afterRefresh starts refreshDependents). Callers cap it. */
export async function settleWork(): Promise<void> {
  while (work.size) await Promise.allSettled(work);
}

/** Test hook. */
export function resetForTest(): void {
  draining = false;
  requests.clear();
  work.clear();
}
