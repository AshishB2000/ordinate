// Fresh on ask (docs/live-data/00-plan.md L3.1) — the setting and the rule that
// says when a pull is due. MAIN PROCESS, pure: no fs, no clock (callers pass
// `now`), no I/O. src/data/freshOnAsk.ts does the asking.
//
// A copy of a Postgres or MySQL table is as old as its last refresh. A schedule
// refreshes it every N whether anyone looks or not; FRESH ON ASK refreshes it
// when someone does: a chart, a KPI tile or an AI answer that reads a copy older
// than `maxStalenessSec` first pulls the rows added since — and waits a moment
// for them (FRESH_ON_ASK_WAIT_MS), so the answer includes them.
//
// ONLY WITH INCREMENTAL REFRESH. A pull on ask must be cheap for the source,
// which only an incremental run is (the rows past the cursor). The setting is
// refused without it — at the RPC, and here, where a stored one reads back as
// absent — and turning incremental refresh off drops it in the same write
// (datasetRecord.writeIncremental).
//
// NEVER A FULL REFRESH. When the incremental machinery would make the next run
// full — the first run, every 7th, "Full refresh now", a cursor or key column
// gone (incrementalRefresh.fullReason) — the verdict is `full`: no pull. The
// refresh itself runs in 'incremental' mode, which skips rather than runs a full
// one if it discovers the need only after fetching (columns changed). The next
// scheduled or manual refresh does the full run; fresh on ask resumes after it.
//
// NEVER LIVE. A Live dataset is asked at the warehouse every time (L2); it has
// no copy to pull into, and its record keeps no incremental block either.
//
// ONE PULL PER WINDOW. `triggeredAt` records when a pull was last started, on
// any pod; inside the window that follows, a stale copy is `held` — a pull that
// failed is not retried on every ask, and a slow one is not started twice.

import type { IncrementalSettings } from './incremental';
import { FULL_EVERY } from './incremental';

export interface FreshOnAsk {
  /** Pull the new rows before answering when the copy is older than this. */
  maxStalenessSec: number;
  /** When a fresh-on-ask pull was last STARTED (any pod) — at most one per window. Server-side only. */
  triggeredAt?: string;
}

/** The picker's choices, in seconds: 1 min, 5 min, 15 min, 1 h. */
export const FRESH_ON_ASK_CHOICES: readonly number[] = [60, 300, 900, 3600];
/**
 * The bounds the API takes. A minute at least: the window is also the rate
 * limit — one pull per dataset per window, whoever asks — so below a minute a
 * busy dashboard would become a poll of the source. A day at most: past that a
 * schedule is the tool.
 */
export const MIN_STALENESS_SEC = 60;
export const MAX_STALENESS_SEC = 86_400;

/** What a stale copy gets when asked. */
export type FreshVerdict =
  /** Not on: no setting, incremental refresh off, or a Live dataset. Never pulls. */
  | 'off'
  /** Younger than the setting. */
  | 'fresh'
  /** Stale, but a pull was started inside this window already: wait for it if it is still running. */
  | 'held'
  /** Stale, but the next refresh must be full: not on ask. */
  | 'full'
  /** Stale: pull the new rows. */
  | 'due';

/** A requested age: an integer within the bounds, or null (refused, never clamped). */
export function parseMaxStaleness(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_STALENESS_SEC || raw > MAX_STALENESS_SEC) return null;
  return raw;
}

const isoOrUndefined = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : undefined;

/**
 * Whitelist a stored block. Undefined unless incremental refresh is on and the
 * dataset is not Live — passed in from the SANITIZED record, so a hand-edited
 * one cannot switch fresh on ask on. An out-of-range age is clamped (a record
 * must still load); the API refuses one before it gets here.
 */
export function sanitizeFreshOnAsk(raw: unknown, on: { incrementalOn: boolean; live: boolean }): FreshOnAsk | undefined {
  if (!on.incrementalOn || on.live || !raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.maxStalenessSec !== 'number' || !Number.isFinite(o.maxStalenessSec)) return undefined;
  const out: FreshOnAsk = { maxStalenessSec: Math.min(MAX_STALENESS_SEC, Math.max(MIN_STALENESS_SEC, Math.floor(o.maxStalenessSec))) };
  const at = isoOrUndefined(o.triggeredAt);
  if (at) out.triggeredAt = at;
  return out;
}

/**
 * Carry `freshOnAsk` from a raw record onto its normalized form
 * (datasets.normalize), AFTER `incremental` and `mode` are settled there.
 */
export function applyFreshOnAsk(
  target: { freshOnAsk?: FreshOnAsk; incremental?: { enabled: boolean }; mode?: string },
  data: { freshOnAsk?: unknown },
): void {
  const fo = sanitizeFreshOnAsk(data.freshOnAsk, { incrementalOn: target.incremental?.enabled === true, live: target.mode === 'live' });
  if (fo) target.freshOnAsk = fo;
}

/** How old a copy is at `now`, in ms. Never refreshed, or an unreadable stamp: infinitely old. */
export function ageMs(lastRefreshedAt: string | undefined, now: number): number {
  const t = lastRefreshedAt ? Date.parse(lastRefreshedAt) : NaN;
  return Number.isFinite(t) ? now - t : Infinity;
}

export interface VerdictInput {
  mode?: unknown;
  freshOnAsk?: FreshOnAsk;
  incremental?: Pick<IncrementalSettings, 'enabled'>;
  /** The copy's last SUCCESSFUL refresh (markRefresh moves it on a success only). */
  lastRefreshedAt?: string;
  /** The latest pull start known — this pod's memory or the record's `triggeredAt`, as epoch ms. */
  triggeredAtMs?: number;
  /** incrementalRefresh.fullReason for the record: why the next run would be full, or null. */
  fullReason: string | null;
}

/** THE due rule. */
export function freshOnAskVerdict(m: VerdictInput, now: number): FreshVerdict {
  if (m.mode === 'live' || !m.freshOnAsk || m.incremental?.enabled !== true) return 'off';
  const windowMs = m.freshOnAsk.maxStalenessSec * 1000;
  if (ageMs(m.lastRefreshedAt, now) < windowMs) return 'fresh';
  if (m.triggeredAtMs !== undefined && Number.isFinite(m.triggeredAtMs) && now - m.triggeredAtMs < windowMs) return 'held';
  if (m.fullReason) return 'full';
  return 'due';
}

/**
 * Will the next incremental run be a full one, by the counters alone? What the
 * dataset list says ("waits for a full refresh") without the stored columns
 * fullReason also checks; the ask itself always runs fullReason.
 */
export function nextRunIsFull(s: Pick<IncrementalSettings, 'enabled' | 'fullNext' | 'highWater' | 'runsSinceFull'> | undefined): boolean {
  if (!s || !s.enabled) return false;
  return s.fullNext === true || s.highWater === null || s.runsSinceFull >= FULL_EVERY - 1;
}
