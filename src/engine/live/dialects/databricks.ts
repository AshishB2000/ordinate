// The Databricks SQL dialect (docs/live-data/00-plan.md L2.2). Golden shapes in
// scripts/test-liveCompile.ts; verified in L2.8.
//
// Placeholders are named parameter markers (`:p0`), sent in the statement
// execution API's `parameters`. `try_cast` accepts any input type. `trunc(d,
// 'WEEK')` is a Monday and returns a DATE (date_trunc would return a
// TIMESTAMP). The connector runs with the session time zone at UTC, so a
// TIMESTAMP casts to its UTC day.

import type { LiveParam } from '../../../connectors/types';
import type { SqlDialect } from '../dialect';
import { JS_WHITESPACE, finiteBySubtraction, sqlInt } from '../dialect';

const TYPE: Record<LiveParam['type'], string> = {
  text: 'STRING', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP',
};

const UNIT: Record<string, string> = { week: 'WEEK', month: 'MM', quarter: 'QUARTER', year: 'YEAR' };

/** A backquoted identifier; a backquote is doubled. */
function ident(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

export const databricksDialect: SqlDialect = {
  id: 'databricks',
  ident,
  placeholder: (i, p) => `CAST(:p${i} AS ${TYPE[p.type]})`,
  toDouble: (x) => `CAST(${x} AS DOUBLE)`,
  toInt: (x) => `CAST(${x} AS INT)`,
  text: (c) => `CAST(${c} AS STRING)`,
  number: (c) => finiteBySubtraction(`try_cast(${c} AS DOUBLE)`),
  date: (c) => `try_cast(${c} AS DATE)`,
  isoDay: (d) => `date_format(${d}, 'yyyy-MM-dd')`,
  epochDay: (d) => `datediff(${d}, DATE '1970-01-01')`,
  trunc: (d, unit) => `trunc(${d}, '${UNIT[unit]}')`,
  blank: (x, b) => `(${x} IS NULL OR btrim(${x}, ${b.bind('text', JS_WHITESPACE)}) = '')`,
  like: (x, p) => `${x} LIKE ${p} ESCAPE '!'`,
  likeEscape: '!',
  label: (x) => x,
  tableSample: (plan) => `TABLESAMPLE (${sqlInt(plan.rows)} ROWS)`,
};
