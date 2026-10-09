// The BigQuery dialect (docs/live-data/00-plan.md L1.3, L2.2). Golden shapes in
// scripts/test-liveCompile.ts; verified against a real project in L2.8.
//
// Placeholders are NAMED (`@p0`), sent as `queryParameters` with
// `parameterMode: 'NAMED'`. SAFE_CAST accepts any input type, so the storage of
// a column does not matter. A TIMESTAMP casts to its UTC day. LIKE has no ESCAPE
// clause: the backslash is the escape, and since the pattern is a bound VALUE it
// is a plain backslash, not a doubled one in a literal.

import type { LiveParam } from '../../../connectors/types';
import type { SqlDialect } from '../dialect';
import { JS_WHITESPACE, sqlPercent } from '../dialect';

const TYPE: Record<LiveParam['type'], string> = {
  text: 'STRING', number: 'FLOAT64', boolean: 'BOOL', date: 'DATE', timestamp: 'TIMESTAMP',
};

const UNIT: Record<string, string> = { week: 'ISOWEEK', month: 'MONTH', quarter: 'QUARTER', year: 'YEAR' };

/** A backquoted identifier; `\` and `` ` `` are escaped with a backslash. */
function ident(name: string): string {
  return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

export const bigqueryDialect: SqlDialect = {
  id: 'bigquery',
  ident,
  placeholder: (i, p) => `CAST(@p${i} AS ${TYPE[p.type]})`,
  toDouble: (x) => `CAST(${x} AS FLOAT64)`,
  toInt: (x) => `CAST(${x} AS INT64)`,
  text: (c) => `CAST(${c} AS STRING)`,
  number: (c) => {
    const v = `SAFE_CAST(${c} AS FLOAT64)`;
    return `CASE WHEN NOT IS_INF(${v}) AND NOT IS_NAN(${v}) THEN ${v} END`;
  },
  date: (c) => `SAFE_CAST(${c} AS DATE)`,
  isoDay: (d) => `FORMAT_DATE('%Y-%m-%d', ${d})`,
  epochDay: (d) => `UNIX_DATE(${d})`,
  trunc: (d, unit) => `DATE_TRUNC(${d}, ${UNIT[unit]})`,
  blank: (x, b) => `(${x} IS NULL OR TRIM(${x}, ${b.bind('text', JS_WHITESPACE)}) = '')`,
  like: (x, p) => `${x} LIKE ${p}`,
  likeEscape: '\\',
  label: (x) => x,
  // Block sampling — it is what cuts the bytes BILLED (a LIMIT does not), so it needs the
  // table's row estimate to pick a percent; without one the LIMIT bounds the rows and
  // the estimate gate (../schemaSync.ts) bounds the bill. Tables only: never a query source.
  tableSample: (plan) => (plan.percent === undefined ? null : `TABLESAMPLE SYSTEM (${sqlPercent(plan.percent)} PERCENT)`),
};
