// Which path actually answered the question — MAIN PROCESS ONLY.
//
// Every resident (SQL-over-Parquet) module returns `null` on any failure and
// the caller quietly hydrates the whole table in JS instead. That fallback is
// the safety property of the design: a broken fast path is never WRONG, only
// slow. It is also the blind spot. A regression that makes `residentQuery`
// return `null` for every input is a ~600× slowdown that ships completely
// green — the differential tests still pass, because they exercise the module
// directly and never ask whether the CALL SITE still routes to it.
//
// The tests already half-know this: several spy on `datasets.getDataset` to
// assert the table was never hydrated. This module moves that instinct out of
// the test suite and into the product, where it can catch the regression on a
// real machine instead of only on a fixture.
//
// ── THE DISTINCTION THAT MAKES THIS USEFUL ───────────────────────────────────
// Fallbacks are NORMAL. Most datasets are small, and below the threshold the
// JS fold is the right answer — warning about those would be pure noise, and a
// log nobody reads is worse than no log. So an outcome is one of three things,
// and only one of them is a problem:
//
//   'resident'  the SQL path ran and produced the answer.
//   'skipped'   the SQL path was never attempted — no bridge, dataset not
//               resident, or below the call site's cost-model threshold. This
//               is a deliberate decision, counted but silent.
//   'failed'    the SQL path WAS attempted and came back null anyway. Nothing
//               about the input said it should. This is the regression signal,
//               and it warns.
//
// A cost-model threshold change shows up as 'skipped' going up. A broken fast
// path shows up as 'failed' — a number that should be zero on every machine.
//
// The warn is rate-limited to ONE per op per process. The failure mode being
// caught is systematic (every call fails, not one), so the first line carries
// all the information the thousandth would, and flooding a user's log with
// identical warnings is how a signal gets ignored.

export type Outcome = 'resident' | 'skipped' | 'failed';

export interface OpCounts {
  resident: number;
  skipped: number;
  failed: number;
  /** Detail from the most recent 'failed', for the log line. */
  lastFailure: string | null;
  /**
   * Answer-cache lookups (src/engine/queryCache.ts), under the op name
   * `cache:<op>`. A cache hit never reaches the resident path at all, so it is
   * counted here rather than as a 'resident' — the ratio of the two is what
   * says whether a warm dashboard open is actually warm.
   */
  hit: number;
  miss: number;
}

const counts = new Map<string, OpCounts>();
const warned = new Set<string>();

function slot(op: string): OpCounts {
  let c = counts.get(op);
  if (!c) {
    c = { resident: 0, skipped: 0, failed: 0, lastFailure: null, hit: 0, miss: 0 };
    counts.set(op, c);
  }
  return c;
}

/**
 * Record which path answered. `detail` is only kept for 'failed' — it is what
 * the warning prints, so it should name the input shape, never its contents
 * (this runs over user data and secrets must not reach a log).
 */
export function record(op: string, outcome: Outcome, detail?: string): void {
  const c = slot(op);
  c[outcome] += 1;
  if (outcome !== 'failed') return;

  c.lastFailure = detail ?? null;
  if (warned.has(op)) return;
  warned.add(op);
  console.warn(
    `[resident] ${op}: the SQL path was chosen and returned null — falling back to the ` +
      `JS path, which is correct but orders of magnitude slower` +
      (detail ? ` (${detail})` : '') +
      `. Further ${op} failures this session are counted, not logged.`,
  );
}

/** Record one answer-cache lookup, under `cache:<op>`. Silent either way. */
export function recordCache(op: string, outcome: 'hit' | 'miss'): void {
  slot('cache:' + op)[outcome] += 1;
}

/** Counts so far, by op. A copy — callers cannot mutate the live state. */
export function snapshot(): Record<string, OpCounts> {
  const out: Record<string, OpCounts> = {};
  for (const [op, c] of counts) out[op] = { ...c };
  return out;
}

/** Total 'failed' across every op. Zero is the only healthy value. */
export function failureCount(): number {
  let n = 0;
  for (const c of counts.values()) n += c.failed;
  return n;
}

/** Test hook. Not called by product code. */
export function reset(): void {
  counts.clear();
  warned.clear();
}
