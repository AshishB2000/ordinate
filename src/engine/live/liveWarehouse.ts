// One Live statement to the warehouse: THE ONE DOOR — MAIN PROCESS ONLY.
// docs/live-data/00-plan.md L2.3 (the call), L2.7 (the limits), D9, R-L2.
// Split out of ./liveQuery.ts (which asks the questions, and re-exports
// `warehouse` and `LiveCallError`) when L2.7 took that file to 500 lines.
//
// Every warehouse statement a Live dataset sends goes through `warehouse()` —
// a chart's, a KPI's, an answer's and its period MAX() (./liveQuery), and
// L2.4's DISTINCT lookups and L2.5's profile and sample statements too — so it
// is slotted, limited, counted and timed out in one place:
//
//   ./liveBudget acquire     a LIVE_MAX_CONCURRENT slot per org per pod; a
//                            caller that hangs up while queued is never sent
//   ./liveBudget checkDaily  LIVE_DAILY_QUERY_LIMIT: admitting the statement
//                            IS counting it (live_usage, across pods); asked
//                            once the slot is held
//   runLiveBound             the SSRF guard, costTag 'live', the row cap,
//                            LIVE_QUERY_TIMEOUT_MS + the caller's signal
//   ./liveBudget noteCall    the bytes the warehouse reported billing, added
//                            to the statement's usage row when it settles
//
// `runLiveBound` is called here and nowhere else in src/, and it is the only
// caller of a connector's `live.runBound`: test-liveUsage fails otherwise.

import { runLiveBound } from '../../connectors/liveRun';
import type { ConnectorError, ConnectorRows } from '../../connectors/types';
import { safeError } from '../../connectors/types';
import { liveQueryTimeoutMs } from '../../server/liveEnv';
import * as budget from './liveBudget';
import type { CompiledQuery } from './compile';
import type { LiveRows } from './shape';
import type { LiveTarget } from './liveTarget';

/** Why one statement did not answer. */
export type CallKind = 'failed' | 'timeout' | 'cancelled' | 'tooLarge' | 'daily';

/**
 * One warehouse statement did not answer. `detail` is for the server log only
 * — except for `daily`, where it is the catalog sentence for the viewer.
 */
export class LiveCallError extends Error {
  readonly kind: CallKind;
  readonly detail: string;
  constructor(kind: CallKind, detail = '') {
    super(`live ${kind}`);
    this.name = 'LiveCallError';
    this.kind = kind;
    this.detail = detail;
  }
}

/** The residentTrace op of a dialect: `live:<dialect>`. */
export const opOf = (dialect: string | undefined): string => `live:${dialect ?? 'unknown'}`;

/** LIVE_QUERY_TIMEOUT_MS, re-read per statement (env.ts refused a bad value at startup). */
export function timeoutMs(): number {
  try {
    return liveQueryTimeoutMs(process.env.LIVE_QUERY_TIMEOUT_MS);
  } catch {
    return liveQueryTimeoutMs(undefined);
  }
}

/** A statement's failure, logged ONCE here — not once per asker of a shared question. A hang-up is not logged. */
export function failed(t: LiveTarget, kind: CallKind, detail = ''): LiveCallError {
  const e = new LiveCallError(kind, detail);
  // The server log's line: dataset id, step kind, the connector's (redacted) words.
  if (kind !== 'cancelled') console.warn(`[live] ${opOf(t.dialect)} dataset ${t.datasetId}: ${kind}${detail ? ` — ${detail}` : ''}`);
  return e;
}

const ABORTED = Symbol('aborted');

/** `p`, or ABORTED as soon as `signal` fires — the caller stops waiting; `p` runs on. */
function untilAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    void p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * Send ONE compiled statement of Live dataset `t` to its warehouse — the one
 * door (see the header). In order: a concurrency slot; the daily limit, which
 * counts the statement it admits; `runBound` under `shared` + the timeout. The
 * slot is held until the CONNECTOR settles — a cancelled statement still
 * winding down still counts — and the bytes it billed are noted then; this
 * caller stops waiting the moment either signal fires.
 *
 * Call it inside the asking request's context (`ctx()`): the statement is
 * counted against that org. It caches nothing and shares nothing — a caller
 * that wants one call per question wraps it in its own cache and flight, as
 * ./liveQuery does.
 *
 * @param t       the resolved target (./liveTarget `liveTarget`): org,
 *                connection, dialect, the connector and its secrets
 * @param query   one compiled statement: SQL text plus its bind parameters
 *                (values are ALWAYS parameters, never SQL text)
 * @param shared  aborting it cancels the statement (in the warehouse too)
 * @returns       the rows, positional to `query.columns`
 * @throws        LiveCallError — `cancelled` (shared fired), `timeout`,
 *                `failed` (the warehouse, the secrets, or a usage count that
 *                could not be written: fail closed), `tooLarge` (past the
 *                row cap) or `daily` (LIVE_DAILY_QUERY_LIMIT; `detail` is the
 *                catalog sentence). Logged once here; a hang-up is not logged.
 */
export async function warehouse(t: LiveTarget, query: CompiledQuery, shared: AbortSignal): Promise<LiveRows> {
  let release: () => void;
  try {
    release = await budget.acquire(t.org, t.datasetId, shared);
  } catch {
    throw new LiveCallError('cancelled');
  }
  let daily: budget.DailyCheck;
  try {
    daily = await budget.checkDaily({ org: t.org, projectId: t.projectId, connectionId: t.connectionId, datasetId: t.datasetId });
  } catch (err: unknown) {
    // The count could not be written (Postgres down): fail closed — an uncounted statement is an unbounded one.
    release();
    throw failed(t, 'failed', `the usage count: ${safeError(err)}`);
  }
  if (!daily.ok) {
    release();
    throw new LiveCallError('daily', daily.message);
  }
  if (shared.aborted) {
    // Every asker hung up while it was being counted: counted (the cautious side), never sent.
    release();
    throw new LiveCallError('cancelled');
  }
  const ticket = daily.ticket;
  const ms = timeoutMs();
  const timer = AbortSignal.timeout(ms);
  const signal = AbortSignal.any([shared, timer]);
  let call: Promise<ConnectorRows | ConnectorError>;
  try {
    const secrets = await t.secrets();
    call = runLiveBound(t.def, t.values, secrets, query.sql, query.params, { signal, timeoutMs: ms });
  } catch (err: unknown) {
    release();
    throw failed(t, 'failed', safeError(err));
  }
  void call.then((r) => {
    release();
    budget.noteCall(ticket, r.ok ? r.bytes : undefined);
  }, release);
  const res = await untilAbort(call, signal);
  if (res === ABORTED) throw failed(t, shared.aborted ? 'cancelled' : 'timeout');
  if (!res.ok) throw failed(t, shared.aborted ? 'cancelled' : timer.aborted ? 'timeout' : 'failed', res.error);
  if (res.truncated) throw new LiveCallError('tooLarge');
  return res.rows;
}
