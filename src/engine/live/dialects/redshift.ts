// The Redshift dialect (docs/live-data/00-plan.md L2.2). Golden shapes in
// scripts/test-liveCompile.ts; L2.8 runs the matrix on Postgres in CI, so every
// spelling here is ALSO valid Postgres (`$n` placeholders, `date - date`, BTRIM,
// POSIX `~`) — the portable subset the plan asks for.
//
// Neither engine has a safe cast, so a `number`/`date` column the warehouse
// stores as TEXT is gated by a regular expression before the CAST (a value the
// gate lets through but the CAST rejects — `2023-02-31` — is a loud warehouse
// error, never a wrong figure). A typed column is CAST directly. VARCHAR casts
// name a length: a bare VARCHAR is 256 characters in Redshift and would cut a
// label short.

import type { LiveParam } from '../../../connectors/types';
import type { SqlDialect } from '../dialect';
import { JS_WHITESPACE, doubleQuoted, finiteBySubtraction } from '../dialect';

const TEXT = 'VARCHAR(65535)';

const TYPE: Record<LiveParam['type'], string> = {
  text: TEXT, number: 'DOUBLE PRECISION', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP',
};

const NUMBER_TEXT = "'^[[:space:]]*[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][+-]?[0-9]+)?[[:space:]]*$'";
const DATE_TEXT = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}'";

export const redshiftDialect: SqlDialect = {
  id: 'redshift',
  ident: doubleQuoted,
  placeholder: (i, p) => `CAST($${i + 1} AS ${TYPE[p.type]})`,
  toDouble: (x) => `CAST(${x} AS DOUBLE PRECISION)`,
  toInt: (x) => `CAST(${x} AS INTEGER)`,
  text: (c) => `CAST(${c} AS ${TEXT})`,
  number: (c, storedAsText) => finiteBySubtraction(storedAsText
    ? `CASE WHEN CAST(${c} AS ${TEXT}) ~ ${NUMBER_TEXT} THEN CAST(${c} AS DOUBLE PRECISION) END`
    : `CAST(${c} AS DOUBLE PRECISION)`),
  date: (c, storedAsText) => (storedAsText
    ? `CASE WHEN CAST(${c} AS ${TEXT}) ~ ${DATE_TEXT} THEN CAST(SUBSTRING(CAST(${c} AS ${TEXT}), 1, 10) AS DATE) END`
    : `CAST(${c} AS DATE)`),
  isoDay: (d) => `TO_CHAR(${d}, 'YYYY-MM-DD')`,
  epochDay: (d) => `(${d} - DATE '1970-01-01')`,
  trunc: (d, unit) => `CAST(DATE_TRUNC('${unit}', ${d}) AS DATE)`,
  blank: (x, b) => `(${x} IS NULL OR BTRIM(${x}, ${b.bind('text', JS_WHITESPACE)}) = '')`,
  like: (x, p) => `${x} LIKE ${p} ESCAPE '!'`,
  likeEscape: '!',
  label: (x) => x,
  caseKey: (x, b) => `LOWER(BTRIM(${x}, ${b.bind('text', JS_WHITESPACE)}))`,
  // Redshift has no TABLESAMPLE, and this dialect stays the Postgres-portable subset:
  // the profile's LIMIT bounds the rows.
  tableSample: () => null,
};
