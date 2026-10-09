// Admin → Live usage (live data L2.7): what Live datasets sent to the
// warehouse, per UTC day and connection, for the last 30 days — so the bill is
// never a surprise — beside the org's LIVE_DAILY_QUERY_LIMIT and today's count.
// Org admins only (src/api/admin.ts); the rows are the caller's org's
// (`live_usage` under forced RLS, or this pod's memory without Postgres).
//
// EVERY FIGURE IS MADE HERE. The page formats nothing but whole counts: the
// day's total, the share of the limit used and the byte labels ("1.2 GB",
// 1024-based as BigQuery bills) come from this reply; its meter is a <meter>
// given today's count and the limit. A connection's name, its
// connector and its project are read now, so a renamed connection shows its
// new name and a deleted one says so — the row and its count stay.

import { estimateLabel } from '../../connectors/bigqueryShape';
import { getConnector } from '../../connectors';
import { dailyLimit } from '../../engine/live/liveBudget';
import { registry } from '../rpc';
import { liveUsageDb, readUsage, utcDay, type UsageRow } from '../live/usageStore';

/** The page's window: today and the 29 UTC days before it. */
export const USAGE_DAYS = 30;

export interface LiveUsageRow extends UsageRow {
  /** The connection's name, or null when it was deleted. */
  readonly connection: string | null;
  /** Its connector's label ("Google BigQuery"), when known. */
  readonly connector: string | null;
  /** The project it lives in, or null when the project is gone. */
  readonly project: string | null;
  /** `bytes`, formatted ("1.2 GB"); null when the warehouse reports none. */
  readonly bytesLabel: string | null;
}

export interface LiveUsage {
  /** Today, UTC (`YYYY-MM-DD`): the day the limit counts. */
  readonly today: string;
  /** LIVE_DAILY_QUERY_LIMIT; 0 = no limit. */
  readonly limit: number;
  readonly todayQueries: number;
  readonly todayRefused: number;
  /** Today's share of the limit as the page prints it ("12%"; the meter beside it is the browser's own); null without a limit. */
  readonly usedLabel: string | null;
  /** No Postgres: the counts are this pod's, since it started. */
  readonly perPod: boolean;
  readonly days: number;
  readonly rows: LiveUsageRow[];
}

const bytesLabel = (n: number | null): string | null => (n === null ? null : estimateLabel(n).slice(1));

/** "12%": whole percents, but never "0%" for a day that has used some, nor "100%" short of the limit. */
export function percentLabel(used: number, limit: number): string {
  const p = (used * 100) / limit;
  const shown = used > 0 && p < 1 ? '<1' : used < limit && p > 99 ? '>99' : String(Math.min(100, Math.round(p)));
  return `${shown}%`;
}

interface Names {
  connection: string | null;
  connector: string | null;
  project: string | null;
}
const GONE: Names = { connection: null, connector: null, project: null };

/** Names for each (project, connection) the rows mention, read once each. */
async function labels(rows: readonly UsageRow[]): Promise<Map<string, Names>> {
  const projects = require('../../app/projects') as typeof import('../../app/projects');
  const connections = require('../../connectors/connections') as typeof import('../../connectors/connections');
  const out = new Map<string, Names>();
  for (const r of rows) {
    const key = `${r.projectId}\u0000${r.connectionId}`;
    if (out.has(key)) continue;
    const [p, c] = await Promise.all([projects.getProject(r.projectId), connections.getConnection(r.projectId, r.connectionId)]);
    out.set(key, { connection: c ? c.name : null, connector: c ? (getConnector(c.connectorId)?.label ?? null) : null, project: p ? p.name : null });
  }
  return out;
}

/** The reply for the caller's org under `limit` (LIVE_DAILY_QUERY_LIMIT). */
export async function liveUsage(limit: number): Promise<LiveUsage> {
  const pool = liveUsageDb()?.pool ?? null;
  const today = utcDay();
  const rows = await readUsage(pool, utcDay(USAGE_DAYS - 1));
  const names = await labels(rows);
  let todayQueries = 0;
  let todayRefused = 0;
  for (const r of rows) {
    if (r.day !== today) continue;
    todayQueries += r.queries;
    todayRefused += r.refused;
  }
  return {
    today,
    limit,
    todayQueries,
    todayRefused,
    usedLabel: limit > 0 ? percentLabel(todayQueries, limit) : null,
    perPod: pool === null,
    days: USAGE_DAYS,
    // Newest day first; within a day the busiest connection first — the bill's order.
    rows: rows
      .map((r) => ({ ...r, ...(names.get(`${r.projectId}\u0000${r.connectionId}`) ?? GONE), bytesLabel: bytesLabel(r.bytes) }))
      .sort((a, b) => b.day.localeCompare(a.day) || b.queries - a.queries || (a.connection ?? '').localeCompare(b.connection ?? '')),
  };
}

/** `admin:liveUsage`, under the limit the executor enforces (LIVE_DAILY_QUERY_LIMIT, read per call). */
export function register(): void {
  registry.handle('admin:liveUsage', async (): Promise<LiveUsage> => liveUsage(dailyLimit()));
}
