// The ClickHouse dialect (docs/live-data/00-plan.md L2.2). Golden shapes in
// scripts/test-liveCompile.ts; verified in a nightly container in L2.8.
//
// Placeholders carry their type: `{p0:Float64}`, sent as `param_p0` over HTTP
// (the connector escapes each value in the TSV form ClickHouse parses them in).
// Strings are BYTES to ClickHouse, which is why "empty" is an RE2 match (UTF-8
// aware) and not trim() with a character set — a byte-wise trim would eat the
// bytes of `₀` (E2 82 80), every one of which also occurs in some JS space.
// Every function name is spelled in ClickHouse's own (case-sensitive) form.

import type { LiveParam } from '../../../connectors/types';
import type { SqlDialect } from '../dialect';
import { WS_REGEX_CLASS } from '../dialect';

const TYPE: Record<LiveParam['type'], string> = {
  text: 'String', number: 'Float64', boolean: 'Bool', date: 'Date32', timestamp: "DateTime64(3, 'UTC')",
};

const TRUNC: Record<string, string> = {
  week: 'toMonday', month: 'toStartOfMonth', quarter: 'toStartOfQuarter', year: 'toStartOfYear',
};

/** A backquoted identifier; `\` and `` ` `` are escaped with a backslash. */
function ident(name: string): string {
  return '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

// Inside a ClickHouse string literal a backslash is an escape, so the regex's
// own backslashes are doubled to reach RE2 intact.
const CLASS_LITERAL = WS_REGEX_CLASS.replace(/\\/g, '\\\\');

export const clickhouseDialect: SqlDialect = {
  id: 'clickhouse',
  ident,
  placeholder: (i, p) => `{p${i}:${TYPE[p.type]}}`,
  toDouble: (x) => `toFloat64(${x})`,
  toInt: (x) => `toInt64(${x})`,
  text: (c) => `CAST(${c} AS Nullable(String))`,
  number: (c) => {
    const v = `accurateCastOrNull(${c}, 'Float64')`;
    return `CASE WHEN isFinite(${v}) THEN ${v} END`;
  },
  date: (c, storedAsText) => (storedAsText ? `toDate32OrNull(${c})` : `toDate32(${c})`),
  isoDay: (d) => `toString(${d})`,
  epochDay: (d) => `toInt64(dateDiff('day', toDate32('1970-01-01'), ${d}))`,
  trunc: (d, unit) => `${TRUNC[unit]}(${d})`,
  blank: (x) => `(${x} IS NULL OR match(${x}, '^[${CLASS_LITERAL}]*$'))`,
  like: (x, p) => `${x} LIKE ${p}`,
  likeEscape: '\\',
  label: (x) => x,
  // RE2 again, not trim(): a byte-wise trim would eat a multi-byte character (above).
  caseKey: (x) => `lowerUTF8(replaceRegexpAll(${x}, '^[${CLASS_LITERAL}]+|[${CLASS_LITERAL}]+$', ''))`,
};
