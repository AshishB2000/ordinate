// Reading a Postgres-wire result — MAIN PROCESS ONLY. Split out of postgres.ts
// (at its file-size cap): the one bounded query every operation there runs, and
// the narrowing of what comes back — cells to the contract's scalars, type OIDs
// to the source's own type names.

import { Client, Query, types as pgTypes } from 'pg';
import { MAX_RESULT_BYTES, rowBytes } from './types';

/** The rowMode:'array' result shape. @types/pg's overloads do not line up with
 *  a `{text, rowMode, values}` object literal, so the cast is confined here. */
interface ArrayResult {
  fields?: { name: string; dataTypeID: number }[];
  /** Narrowed by cellValue as they arrived. */
  rows?: (string | number | boolean | null)[][];
  /** MAX_RESULT_BYTES stopped it. */
  truncated?: boolean;
}

export function queryArray(client: Client, text: string, values?: unknown[]): Promise<ArrayResult> {
  // queryMode 'extended' (T6.3): ONE statement per call. Without values pg uses
  // the simple protocol, which runs `select 1 ) x; commit; begin read write;
  // delete …` as four statements — past the read-only session and the LIMIT.
  const cfg = { text, rowMode: 'array', values, queryMode: 'extended' } as unknown as ConstructorParameters<typeof Query>[0];
  // NV-40: rows are counted as they arrive. Past MAX_RESULT_BYTES the client is
  // ended — pg would buffer the rest — and what arrived comes back truncated.
  const rows: NonNullable<ArrayResult['rows']> = [];
  let fields: ArrayResult['fields'];
  let bytes = 0;
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, res?: ArrayResult): void => {
      if (bytes > MAX_RESULT_BYTES) resolve({ fields, rows, truncated: true });
      else if (err) reject(err);
      else resolve({ fields: res?.fields, rows });
    };
    // The callback is Query's third argument (@types/pg leaves it out); with one, a read timeout settles it too.
    const q = new (Query as unknown as new (c: unknown, v: undefined, cb: typeof done) => Query)(cfg, undefined, done);
    q.on('row', (raw: unknown[], res?: { fields?: ArrayResult['fields'] }) => {
      fields ??= res?.fields;
      if (bytes > MAX_RESULT_BYTES) return;
      const row = raw.map(cellValue);
      bytes += rowBytes(row);
      if (bytes > MAX_RESULT_BYTES) void client.end().catch(() => {});
      else rows.push(row);
    });
    client.query(q);
  });
}

// ── Column types ─────────────────────────────────────────────────────────────

let oidNames: Map<number, string> | null = null;

/** The SOURCE's type name, verbatim — read out of `pg`'s own builtin OID table
 *  rather than a hand-copied list, so it cannot drift. An OID we do not know
 *  (an extension type, or a pgwire engine's own) reports `oid_<n>`: honest and
 *  useless beats plausible and wrong, because the caller maps this to a
 *  ColumnType and `007` must stay text. */
export function typeName(oid: number): string {
  if (!oidNames) {
    oidNames = new Map<number, string>();
    const builtins = (pgTypes as unknown as { builtins?: Record<string, unknown> } | undefined)?.builtins;
    for (const [k, val] of Object.entries(builtins || {})) {
      if (typeof val === 'number' && !oidNames.has(val)) oidNames.set(val, k.toLowerCase());
    }
  }
  return oidNames.get(oid) || `oid_${oid}`;
}

/** Narrow a driver value to what ConnectorRows allows. Dates become ISO strings
 *  and structured values become JSON, matching `connectionRun.cellToString`;
 *  a bigint becomes a string because a JS number would silently lose digits. */
function cellValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Buffer) return v.toString('base64');
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
