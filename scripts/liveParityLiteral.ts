// The LITERAL twin of the live-parity fixture (docs/live-data/00-plan.md L2.8):
// the rows as a DEFINING QUERY that selects them from literals, each cast to
// the type that warehouse would hold — for an engine the run may not write.
// The real-account nightly's Snowflake and BigQuery roles are read-only (and
// BigQuery's scratch dataset optional), so scripts/warehouseLiveParity.ts loads
// its fixture this way; scripts/test-liveParityPostgres.ts proves the twin on
// CI's Postgres, with the same backslash escaping. Helper; not a suite itself.
//
// A Live dataset over SQL is a production shape (a defining query, rule F3), so
// a matrix over this twin runs the path a user's query does: the compiler wraps
// it, the connector caps it, the warehouse plans it.
//
//   Snowflake  SELECT CAST(c0 AS VARCHAR) AS "many", … FROM (VALUES (…), …) AS v(c0, …)
//   BigQuery   SELECT CAST(c0 AS STRING) AS `many`, … FROM UNNEST(ARRAY<STRUCT<c0 STRING, …>>[(…), …])
//   Postgres   as Snowflake, every literal an E'…' string
//
// Every literal is TEXT (or NULL), so no engine infers a column type from the
// first rows; the CAST is the only typing, exactly the store's.

import type { LiveSource } from '../src/engine/live/compile';
import type { CompileDialectId } from '../src/engine/live/dialect';
import type { ParityEngine, Store, StoredColumn } from './liveParityFixture';

const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');

type Cell = string | number | null;

/** How one engine spells the twin. */
export interface Spelling {
  /** The CAST target for each store. */
  type: Record<Store, string>;
  /** …and the type name a schema sync records (`sourceType`). */
  name: Record<Store, string>;
  /** One text literal. */
  quote(s: string): string;
  /** The SELECT list and the literal rows (`(…)` each, `width` cells) → the query. */
  from(select: string, tuples: string[], width: number): string;
}

const cols = (width: number): string[] => Array.from({ length: width }, (_v, i) => `c${i}`);

/**
 * A literal with backslash escapes — Snowflake's and BigQuery's single-quoted
 * strings, Postgres's E'…': the backslash, the quote and the line controls.
 * Everything else (NBSP, U+FEFF, an astral emoji) travels as itself, in UTF-8.
 */
export function backslashQuoted(s: string): string {
  if (s.includes('\u0000')) throw new Error('a NUL cannot be a literal on every engine');
  const esc: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\t': '\\t', '\n': '\\n', '\r': '\\r' };
  return `'${s.replace(/[\\'\t\n\r]/g, (c) => esc[c])}'`;
}

/**
 * A cell's literal text: −0 kept as '-0'; a fixture timestamp (`…T…Z`) without
 * its zone for a store that has none, with `+00:00` for one that has.
 */
export function cellText(v: Cell, store: Store): string | null {
  if (v === null) return null;
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z$/.exec(v);
  if (m && store === 'timestamp') return `${m[1]} ${m[2]}`;
  if (m && store === 'timestamptz') return `${m[1]} ${m[2]}+00:00`;
  return v;
}

const valuesFrom = (select: string, tuples: string[], width: number): string =>
  `SELECT ${select}\nFROM (VALUES\n${tuples.join(',\n')}\n) AS v(${cols(width).join(', ')})`;

export const SNOWFLAKE: Spelling = {
  type: {
    text: 'VARCHAR', float: 'FLOAT', int: 'INTEGER', smallint: 'SMALLINT', decimal: 'NUMBER(38,0)', date: 'DATE',
    timestamp: 'TIMESTAMP_NTZ', timestamptz: 'TIMESTAMP_TZ',
  },
  // INFORMATION_SCHEMA.COLUMNS.DATA_TYPE.
  name: { text: 'TEXT', float: 'FLOAT', int: 'NUMBER', smallint: 'NUMBER', decimal: 'NUMBER', date: 'DATE', timestamp: 'TIMESTAMP_NTZ', timestamptz: 'TIMESTAMP_TZ' },
  quote: backslashQuoted,
  from: valuesFrom,
};

const BQ_TYPE: Record<Store, string> = {
  text: 'STRING', float: 'FLOAT64', int: 'INT64', smallint: 'INT64', decimal: 'NUMERIC', date: 'DATE', timestamp: 'DATETIME', timestamptz: 'TIMESTAMP',
};

export const BIGQUERY: Spelling = {
  type: BQ_TYPE,
  name: BQ_TYPE,
  quote: backslashQuoted,
  from: (select, tuples, width) =>
    `SELECT ${select}\nFROM UNNEST(ARRAY<STRUCT<${cols(width).map((c) => `${c} STRING`).join(', ')}>>[\n${tuples.join(',\n')}\n])`,
};

export const POSTGRES: Spelling = { type: eng.PG_DDL, name: eng.PG_NAME, quote: (s) => `E${backslashQuoted(s)}`, from: valuesFrom };

/** The defining query: `rows` typed per `columns`, in `spell`'s spelling, named by the dialect's identifiers. */
export function literalTwin(spell: Spelling, dialect: CompileDialectId, columns: StoredColumn[], rows: Cell[][]): string {
  const ident = dialects.dialectFor(dialect).ident;
  const select = columns.map((c, i) => `CAST(c${i} AS ${spell.type[c.store]}) AS ${ident(c.name)}`).join(', ');
  const tuples = rows.map((r) => `(${columns.map((c, i) => {
    const t = cellText(r[i], c.store);
    return t === null ? 'NULL' : spell.quote(t);
  }).join(', ')})`);
  return spell.from(select, tuples, columns.length);
}

/** An engine whose twins are literal defining queries, run by `run` (a connector's own runBound). */
export function literalEngine(name: string, dialect: CompileDialectId, spell: Spelling, run: ParityEngine['run']): ParityEngine {
  return {
    name,
    dialect,
    run,
    typeName: (s) => spell.name[s],
    load: async (_table: string, columns: StoredColumn[], rows: Cell[][]): Promise<LiveSource> =>
      ({ kind: 'sql', sql: literalTwin(spell, dialect, columns, rows) }),
  };
}
