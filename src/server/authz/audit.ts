// The audit trail (T3.3, table `audit_log` in 0006_authz.sql): sign-ins,
// sign-outs, and every write/admin RPC (record writes, publishes, connection
// and role changes) plus `audit: true` reads (exports).
//
// What a row may hold is fixed here, not by the caller: action, channel,
// actor (email), org, outcome, request id, and ids — UUID-shaped values found
// under `id` / `…Id` keys of the parsed input. Never another field value: an
// input can carry rows, formulas, URLs or a connection password.

import type { Pool } from 'pg';

export type AuditAction = 'rpc' | 'login' | 'logout' | 'logout_everywhere';
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

/** Writes one row. No pool (dev without Postgres) → nothing to write to. */
export async function audit(pool: Pool | null, e: AuditEntry): Promise<void> {
  if (!pool) return;
  await pool.query(
    `INSERT INTO audit_log (org_id, actor, action, channel, project_id, target_ids, outcome, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7, $8)`,
    [e.org, e.actor, e.action, e.channel ?? null, e.projectId ?? null, [...(e.targets ?? [])], e.outcome, e.requestId ?? null],
  );
}
