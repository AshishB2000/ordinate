// One Live statement, run on its connector — MAIN PROCESS ONLY.
// docs/live-data/00-plan.md L2.3 (D4, D9).
//
// The Live twin of connectionRun's `fetchRows`: the same per-call
// ConnectorContext, the same SSRF guard and host pin (`guardHost`), the same
// `safeError` on every way out — so a Live query reaches the warehouse exactly
// as an extract refresh does, plus what only Live carries:
//
//   costTag 'live'   tagged on the warehouse's own query log (Snowflake
//                    QUERY_TAG, BigQuery job labels), so the bill reads back
//                    per purpose;
//   maxBytes         LIVE_MAX_BYTES_BILLED (BigQuery takes the lower of it and
//                    the connection's own field);
//   timeoutMs        LIVE_QUERY_TIMEOUT_MS, given by the executor, NOT clamped
//                    to the extract's 30 s — a warehouse aggregate over a big
//                    table may need its minute;
//   signal           the caller's hang-up and the timeout, combined by the
//                    executor: the connector cancels the warehouse statement.
//
// The statement and its parameters come from the live compiler, never from a
// user, and the secrets are resolved by the caller (src/engine/live/liveTarget.ts)
// exactly as ipc/connections resolves them for a refresh.

import type { ConnectorDef, ConnectorError, ConnectorRows, LiveParam } from './types';
import { safeError } from './types';
import { guardHost } from './connectionRun';
import { maxBytesBilled } from '../server/env';

/**
 * The row cap of a Live statement. Its rows are GROUPS (at most 51 categories
 * per series, bins, days under a week calendar), so a result this long is a
 * question no chart can show — the executor refuses a truncated one rather than
 * draw part of it.
 */
export const LIVE_ROW_LIMIT = 100_000;

export interface LiveRunOpts {
  /** Fires on the caller's hang-up or the timeout; the connector cancels on it. */
  signal: AbortSignal;
  /** LIVE_QUERY_TIMEOUT_MS: the connector's own statement timeout. */
  timeoutMs: number;
}

/** Run one compiled statement with its parameters bound. Every error is redacted. */
export async function runLiveBound(
  def: ConnectorDef,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  sql: string,
  params: LiveParam[],
  opts: LiveRunOpts,
): Promise<ConnectorRows | ConnectorError> {
  const live = def.live;
  if (!live || typeof live.runBound !== 'function') return { ok: false, error: 'This source cannot answer live questions.' };
  const ctx = {
    values: values && typeof values === 'object' ? values : {},
    secrets: secrets && typeof secrets === 'object' ? secrets : {},
    rowLimit: LIVE_ROW_LIMIT,
    timeoutMs: opts.timeoutMs,
    costTag: 'live' as const,
    maxBytes: maxBytesBilled(process.env.LIVE_MAX_BYTES_BILLED),
    signal: opts.signal,
  };
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };
  try {
    const res = await live.runBound(ctx, sql, params);
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    const rows = Array.isArray(res.rows) ? res.rows : [];
    // Trust, then verify — as fetchRows does: a connector that ignored the cap is clipped AND reported.
    return { ok: true, columns: res.columns || [], rows: rows.slice(0, LIVE_ROW_LIMIT), truncated: res.truncated === true || rows.length > LIVE_ROW_LIMIT };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}
