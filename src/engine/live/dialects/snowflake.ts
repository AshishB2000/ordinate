// The Snowflake dialect (docs/live-data/00-plan.md L1.2, L2.2). Golden shapes in
// scripts/test-liveCompile.ts; verified against a real account in L2.8.
//
// Placeholders are `?`, bound positionally through the SQL API's `bindings`
// (L1.2), so `params[i]` IS binding `i + 1`. The connector sends every statement
// with WEEK_START = 1 and TIMEZONE = 'UTC': DATE_TRUNC('WEEK', …) is then a
// Monday (ISO), and a TIMESTAMP_LTZ casts to its UTC day — the day an extract
// writes (zoned values are stored as UTC ISO text).
//
// Snowflake's TRY_ casts take STRING input only, so the safe reading of a
// `number`/`date` column depends on how the warehouse stores it: a string column
// goes through TRY_TO_DOUBLE / TRY_TO_DATE, a typed one through a plain CAST
// (which cannot fail on a typed value). `sourceType` decides; absent, the
// column is taken to be stored as declared.

import type { LiveParam } from '../../../connectors/types';
import type { SqlDialect } from '../dialect';
import { JS_WHITESPACE, doubleQuoted, finiteBySubtraction } from '../dialect';

const TYPE: Record<LiveParam['type'], string> = {
  text: 'VARCHAR', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP_NTZ',
};

export const snowflakeDialect: SqlDialect = {
  id: 'snowflake',
  ident: doubleQuoted,
  placeholder: (_i, p) => `CAST(? AS ${TYPE[p.type]})`,
  toDouble: (x) => `CAST(${x} AS DOUBLE)`,
  toInt: (x) => `CAST(${x} AS INTEGER)`,
  text: (c) => `CAST(${c} AS VARCHAR)`,
  number: (c, storedAsText) => finiteBySubtraction(storedAsText ? `TRY_TO_DOUBLE(TO_VARCHAR(${c}))` : `CAST(${c} AS DOUBLE)`),
  date: (c, storedAsText, sourceType) => {
    if (storedAsText) return `TRY_TO_DATE(TO_VARCHAR(${c}))`;
    // A TIMESTAMP_TZ keeps its own offset; its day is the UTC day only once converted.
    if (/TIMESTAMP_TZ/i.test(sourceType)) return `CAST(CONVERT_TIMEZONE('UTC', ${c}) AS DATE)`;
    return `CAST(${c} AS DATE)`;
  },
  isoDay: (d) => `TO_CHAR(${d}, 'YYYY-MM-DD')`,
  epochDay: (d) => `DATEDIFF('day', DATE '1970-01-01', ${d})`,
  trunc: (d, unit) => `DATE_TRUNC('${unit.toUpperCase()}', ${d})`,
  // The whitespace class travels as a bound value: no literal escaping to get wrong.
  blank: (x, b) => `(${x} IS NULL OR TRIM(${x}, ${b.bind('text', JS_WHITESPACE)}) = '')`,
  like: (x, p) => `${x} LIKE ${p} ESCAPE '!'`,
  likeEscape: '!',
  label: (x) => x,
};
