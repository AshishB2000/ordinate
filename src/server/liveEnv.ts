// What a Live query may cost — the warehouse settings (docs/live-data/00-plan.md
// §8, D9). Split out of ./env.ts, which re-exports every name here.
//
// Each parser is PURE and takes the raw variable, so the code that enforces a
// setting re-reads it per query (`liveMaxConcurrent(process.env.…)`) exactly
// as parseEnv validates it at startup: a typo stops the pod there, and a test
// can change a limit between two calls.

import { EnvError } from './envError';

/** LIVE_MAX_BYTES_BILLED's default: 10 GiB (docs/live-data/00-plan.md §8). */
export const DEFAULT_MAX_BYTES_BILLED = 10_737_418_240;

/**
 * LIVE_MAX_BYTES_BILLED: the ceiling on BigQuery's `maximumBytesBilled`, in
 * bytes, for every query a BigQuery connection runs (a connection may set it
 * lower, never higher). Pure, so the connector re-reads the variable the same
 * way at each query. Not positiveInt: 10 GiB has eleven digits.
 */
export function maxBytesBilled(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MAX_BYTES_BILLED;
  if (!/^\d{1,16}$/.test(raw) || Number(raw) === 0 || !Number.isSafeInteger(Number(raw))) {
    throw new EnvError(`LIVE_MAX_BYTES_BILLED must be a positive whole number of bytes, for example 10737418240 (10 GiB), got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/** LIVE_QUERY_TIMEOUT_MS (plan §8): one live warehouse statement, cancelled in the warehouse past it. Pure: re-read per query. */
export const DEFAULT_LIVE_QUERY_TIMEOUT_MS = 60_000;
export function liveQueryTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIVE_QUERY_TIMEOUT_MS;
  if (/^\d{3,7}$/.test(raw) && Number(raw) >= 100 && Number(raw) <= 3_600_000) return Number(raw);
  throw new EnvError(`LIVE_QUERY_TIMEOUT_MS must be a whole number of milliseconds from 100 to 3600000, got ${JSON.stringify(raw)}`);
}

/** LIVE_MAX_CONCURRENT (plan §8): live warehouse statements in flight per org per pod; more wait. Pure: re-read per query. */
export const DEFAULT_LIVE_MAX_CONCURRENT = 4;
export function liveMaxConcurrent(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIVE_MAX_CONCURRENT;
  if (/^\d{1,4}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 1000) return Number(raw);
  throw new EnvError(`LIVE_MAX_CONCURRENT must be a whole number from 1 to 1000, got ${JSON.stringify(raw)}`);
}

/**
 * LIVE_DAILY_QUERY_LIMIT (plan §8, L2.7): warehouse statements per org per UTC
 * day, counted across pods in Postgres (`live_usage`); `0` = no limit. Past it
 * a figure is the cached answer labelled stale, or a typed refusal. Pure:
 * re-read per query.
 */
export const DEFAULT_LIVE_DAILY_QUERY_LIMIT = 10_000;
export function liveDailyQueryLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIVE_DAILY_QUERY_LIMIT;
  if (/^\d{1,10}$/.test(raw) && Number(raw) <= 1_000_000_000) return Number(raw);
  throw new EnvError(`LIVE_DAILY_QUERY_LIMIT must be a whole number from 0 (no limit) to 1000000000, got ${JSON.stringify(raw)}`);
}

/**
 * LIVE_MIN_CACHE_AGE_PUBLIC_SEC (plan §8, L2.7): on a published /p/ page a
 * Live figure may be this old whatever its dataset's own cache age, so a public
 * link cannot be used to run up the warehouse bill. 0 – 30 days (the cache
 * age's own range); `0` = no floor. Pure: re-read per question.
 */
export const DEFAULT_LIVE_MIN_CACHE_AGE_PUBLIC_SEC = 60;
export function liveMinCacheAgePublicSec(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIVE_MIN_CACHE_AGE_PUBLIC_SEC;
  if (/^\d{1,7}$/.test(raw) && Number(raw) <= 2_592_000) return Number(raw);
  throw new EnvError(`LIVE_MIN_CACHE_AGE_PUBLIC_SEC must be a whole number of seconds from 0 to 2592000 (30 days), got ${JSON.stringify(raw)}`);
}
