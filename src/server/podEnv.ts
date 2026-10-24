// The pod's own lifecycle settings (docs/pod-lifecycle/00-design.md). Split out
// of ./env.ts, which re-exports every name here.

import { EnvError } from './envError';

export interface PodEnv {
  /**
   * SHUTDOWN_GRACE_SECONDS, in ms: the whole shutdown budget, from the signal to
   * the exit (./shutdown.ts). Keep it below the orchestrator's grace minus any
   * preStop wait: the chart enforces terminationGracePeriodSeconds − 5.
   */
  readonly shutdownGraceMs: number;
  /** DATABASE_POOL_MAX: Postgres connections this pod's pool may open (./db/pool.ts). The bus holds one more. */
  readonly databasePoolMax: number;
}

export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 20;
export const DEFAULT_DATABASE_POOL_MAX = 10;

export function parsePod(src: Readonly<Record<string, string | undefined>>): PodEnv {
  return Object.freeze({
    shutdownGraceMs: wholeIn('SHUTDOWN_GRACE_SECONDS', src.SHUTDOWN_GRACE_SECONDS, DEFAULT_SHUTDOWN_GRACE_SECONDS, 1, 300) * 1000,
    databasePoolMax: wholeIn('DATABASE_POOL_MAX', src.DATABASE_POOL_MAX, DEFAULT_DATABASE_POOL_MAX, 1, 1000),
  });
}

function wholeIn(name: string, raw: string | undefined, dflt: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return dflt;
  if (/^\d{1,6}$/.test(raw) && Number(raw) >= min && Number(raw) <= max) return Number(raw);
  throw new EnvError(`${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
}
