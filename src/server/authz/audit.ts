// The audit trail (T3.3, table `audit_log` in 0006_authz.sql): sign-ins,
// sign-outs, password changes (0010_passwords.sql), and every write/admin RPC
// (record writes, publishes, connection and role changes) plus `audit: true`
// reads (exports). Refreshes no member clicked (0011_refresh_hooks.sql): a
// refresh URL's call (`hook_refresh`, actor = the hook's creator, ids = the
// hook and its dataset) and a scheduled refresh (`scheduled_refresh`, actor =
// the jobs identity, outcome = the refresh's own). An embed view (0017_embed.sql):
// `embed_view`, actor `embed`, ids = the published link and the dashboard.
//
// What a row may hold is fixed here, not by the caller: action, channel,
// actor (email), org, outcome, request id, and ids — UUID-shaped values found
// under `id` / `…Id` keys of the parsed input. Never another field value: an
// input can carry rows, formulas, URLs or a connection password.
//
// Every row is also one `audit` log line with the same fields, so an operator
// who needs years of history keeps it in their log drain. Postgres keeps rows
// for AUDIT_RETENTION_DAYS (unset: forever); `pruneAudit` deletes older ones
// (docs/server/audit-retention.md).

import type { Pool } from 'pg';
import { logFields } from '../../app/logger';

export type AuditAction = 'rpc' | 'login' | 'logout' | 'logout_everywhere' | 'password_change' | 'hook_refresh' | 'scheduled_refresh' | 'embed_view';
export type Outcome = 'ok' | 'denied' | 'error';

export interface AuditEntry {
  readonly org: string;
  readonly actor: string | null;
  readonly action: AuditAction;
  readonly outcome: Outcome;
  readonly channel?: string;
  readonly projectId?: string | null;
  readonly targets?: readonly string[];
  readonly requestId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEY = /^(id|.+Id)$/;
const MAX_DEPTH = 4;
const MAX_IDS = 32;

/** Every UUID under an `id`/`…Id` key of `input` (nested objects and arrays, bounded), deduplicated. */
export function targetIds(input: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || out.size >= MAX_IDS || !v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (ID_KEY.test(k) && typeof x === 'string' && UUID_RE.test(x)) out.add(x.toLowerCase());
      else walk(x, depth + 1);
      if (out.size >= MAX_IDS) return;
    }
  };
  walk(input, 0);
  return [...out];
}

/** The log line's fields: exactly the row's, under one key so they never mix with the line's own `org` / `reqId`. */
function logAudit(e: AuditEntry): void {
  logFields('audit', {
    audit: { org: e.org, actor: e.actor, action: e.action, channel: e.channel ?? null, projectId: e.projectId ?? null, targets: [...(e.targets ?? [])], outcome: e.outcome, requestId: e.requestId ?? null },
  });
}

/** Writes one row, and its log line. No pool (dev without Postgres) → nothing to write to. */
export async function audit(pool: Pool | null, e: AuditEntry): Promise<void> {
  if (!pool) return;
  logAudit(e);
  await pool.query(
    `INSERT INTO audit_log (org_id, actor, action, channel, project_id, target_ids, outcome, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8)`,
    [e.org, e.actor, e.action, e.channel ?? null, e.projectId ?? null, [...(e.targets ?? [])], e.outcome, e.requestId ?? null],
  );
}

/** Writes many rows in ONE statement (an IdP map change that re-applied many members). No pool → nothing. */
export async function auditMany(pool: Pool | null, entries: readonly AuditEntry[]): Promise<void> {
  if (!pool || !entries.length) return;
  for (const e of entries) logAudit(e);
  const rows = entries.map((e) => ({
    org: e.org, actor: e.actor, action: e.action, channel: e.channel ?? null, project_id: e.projectId ?? null,
    targets: (e.targets ?? []).join(','), outcome: e.outcome, request_id: e.requestId ?? null,
  }));
  await pool.query(
    `INSERT INTO audit_log (org_id, actor, action, channel, project_id, target_ids, outcome, request_id)
     SELECT v.org, v.actor, v.action, v.channel, v.project_id, string_to_array(v.targets, ',')::uuid[], v.outcome, v.request_id
       FROM json_to_recordset($1::json) AS v(org text, actor text, action text, channel text, project_id uuid, targets text, outcome text, request_id text)`,
    [JSON.stringify(rows)],
  );
}

/** Rows one DELETE removes; a pass runs up to PRUNE_BATCHES of them, so a first pass over years of rows never holds one long lock. */
export const PRUNE_BATCH = 5000;
const PRUNE_BATCHES = 40;

/**
 * Deletes `org`'s rows older than `days` (null or 0: keeps all). Runs on the
 * shared sweep (../sharedState.ts), one org at a time; a backlog bigger than
 * one pass finishes over the next ones. Returns how many it deleted.
 */
export async function pruneAudit(pool: Pool, org: string, days: number | null): Promise<number> {
  if (!days) return 0;
  let total = 0;
  for (let i = 0; i < PRUNE_BATCHES; i++) {
    const r = await pool.query(
      `DELETE FROM audit_log WHERE id IN (
         SELECT id FROM audit_log WHERE org_id = $1 AND at < now() - $2 * interval '1 day' LIMIT $3)`,
      [org, days, PRUNE_BATCH],
    );
    total += r.rowCount ?? 0;
    if ((r.rowCount ?? 0) < PRUNE_BATCH) break;
  }
  return total;
}
