// The facts door — MAIN PROCESS ONLY (docs/semantic-layer/02-source-tables.md, D6, D15).
//
// The ONE way the app reads a warehouse table's comments, keys and partitions: `sourceTable:read`
// calls it on an editor's click and nothing else does. It is built like `describeTable` in
// connectionRun: the bounded context, the SSRF guard, every error through safeError. It takes the
// connector's `tableFacts` when it has one and `describeTable` otherwise (never both), then cuts
// the answer to the whitelist and redacts every string in it, because a warehouse can store a
// password in a comment as readily as it can echo one in an error.
//
// It is not a Live statement: no `warehouse()`, no `live_usage`, no `runBound` (test-liveUsage).

import { buildContext, guardHost, unknownConnector } from './connectionRun';
import { getConnector } from './index';
import { FACTS_ROWS, sanitizeFacts, type TableFacts } from './tableFacts';
import { redactSecrets, safeError } from './types';

export { FACTS_ROWS }; // defined beside the sanitizer so a family's reader can read it without importing the registry

/** Every string in `v` (array items and object values) through `redactSecrets`. */
function redacted<T>(v: T, secrets: Record<string, string>): T {
  if (typeof v === 'string') return redactSecrets(v, secrets) as T;
  if (Array.isArray(v)) return v.map((x) => redacted(x, secrets)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redacted(x, secrets)])) as T;
  return v;
}

/** null: this connector can read neither facts nor columns (SaaS, Trino, Presto, Elasticsearch, OpenSearch, Druid). */
export async function readTableFacts(
  connectorId: unknown,
  values: Record<string, unknown>,
  secrets: Record<string, string>,
  table: string,
): Promise<{ ok: true; facts: TableFacts } | { ok: false; error: string } | null> {
  const def = getConnector(connectorId);
  if (!def) return { ok: false, error: unknownConnector(connectorId) };
  if (typeof def.tableFacts !== 'function' && typeof def.describeTable !== 'function') return null;
  const ctx = buildContext(values, secrets, { rowLimit: FACTS_ROWS });
  const refused = await guardHost(def, ctx);
  if (refused) return { ok: false, error: refused };
  try {
    const name = String(table ?? '');
    const res = typeof def.tableFacts === 'function' ? await def.tableFacts(ctx, name) : await def.describeTable!(ctx, name);
    if (!res.ok) return { ok: false, error: safeError(res.error, ctx.secrets) };
    const facts = sanitizeFacts(res);
    return facts ? { ok: true, facts: redacted(facts, ctx.secrets) } : { ok: false, error: 'The source returned no columns for this table.' };
  } catch (err: unknown) {
    return { ok: false, error: safeError(err, ctx.secrets) };
  }
}
