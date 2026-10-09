// Snowflake statement text and bind values — MAIN PROCESS ONLY, pure. Split out
// of snowflake.ts (one job: what goes in `statement` and `bindings`).
//
// VALUES ARE BOUND, NEVER INLINED (plan D4, threat model R-L1): a compiled live
// statement carries `?` placeholders and each value travels in `bindings` as a
// string — the SQL API's rule — under its Snowflake type. DATE values are epoch
// milliseconds and TIMESTAMP_NTZ epoch nanoseconds, the API's documented value
// formats; the session runs with TIMEZONE=UTC, so an NTZ is the UTC instant the
// ISO string named.

import type { ConnectorError, LiveParam } from './types';

/** User SQL on its own line inside the row cap (rule F3). */
export function cappedStatement(sql: string, cap: number): string {
  return `select * from (\n${sql}\n) limit ${cap + 1}`;
}

/** The `?` placeholders Snowflake will bind: those outside strings, quoted identifiers and comments. */
export function countPlaceholders(sql: string): number {
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      for (i++; i < sql.length; i++) {
        if (c === "'" && sql[i] === '\\') { i++; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i++; continue; } break; }
      }
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if ((c === '/' && sql[i + 1] === '*') || (c === '$' && sql[i + 1] === '$')) {
      const end = sql.indexOf(c === '/' ? '*/' : '$$', i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === '?') n++;
  }
  return n;
}

// ── bindings ────────────────────────────────────────────────────────────────

export interface SfBinding {
  type: 'TEXT' | 'FIXED' | 'REAL' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP_NTZ';
  /** Always a string (the API's rule), or null for SQL NULL. */
  value: string | null;
}

const NULL_TYPE: Readonly<Record<LiveParam['type'], SfBinding['type']>> = {
  text: 'TEXT', number: 'FIXED', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP_NTZ',
};
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;

/** One LiveParam → its binding. DATE is epoch milliseconds and TIMESTAMP_NTZ epoch nanoseconds,
 *  the SQL API's documented value formats; the session runs in UTC, so NTZ is the UTC instant. */
function bindingOf(p: LiveParam): SfBinding | string {
  const v = p.value;
  if (v === null) return { type: NULL_TYPE[p.type] ?? 'TEXT', value: null };
  switch (p.type) {
    case 'text':
      return { type: 'TEXT', value: String(v) };
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'is not a finite number';
      return { type: Number.isSafeInteger(v) ? 'FIXED' : 'REAL', value: String(v) };
    case 'boolean':
      return typeof v === 'boolean' ? { type: 'BOOLEAN', value: String(v) } : 'is not a boolean';
    case 'date': {
      const m = typeof v === 'string' ? ISO_DATE.exec(v) : null;
      const ms = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
      if (!m || new Date(ms).toISOString().slice(0, 10) !== v) return 'is not a YYYY-MM-DD date';
      return { type: 'DATE', value: String(ms) };
    }
    case 'timestamp': {
      const m = typeof v === 'string' ? ISO_TS.exec(v) : null;
      const ms = m ? Date.parse(`${m[1]}${m[2] ? '.' + m[2].slice(0, 3).padEnd(3, '0') : ''}${m[3] ?? 'Z'}`) : NaN;
      if (!m || !Number.isFinite(ms)) return 'is not an ISO-8601 timestamp';
      const nanos = BigInt(ms) * 1_000_000n + BigInt((m[2] ?? '').slice(3).padEnd(6, '0'));
      return { type: 'TIMESTAMP_NTZ', value: nanos.toString() };
    }
    default:
      return 'has an unknown type';
  }
}

/** LiveParam[] → `bindings` ({"1": …, "2": …}), positional in text order. */
export function buildBindings(params: LiveParam[]): { ok: true; bindings: Record<string, SfBinding> } | ConnectorError {
  const bindings: Record<string, SfBinding> = {};
  for (let i = 0; i < params.length; i++) {
    const b = bindingOf(params[i]);
    if (typeof b === 'string') return { ok: false, error: `Parameter ${i + 1} ${b}` };
    bindings[String(i + 1)] = b;
  }
  return { ok: true, bindings };
}
