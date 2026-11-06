// The test harness's fake SNOWFLAKE SEMANTIC VIEW (semantic layer part 7, c1;
// docs/live-data/snowflake-semantic-views.md). Not a suite itself.
//
// `decodeSnowflake` is a parser of EXACTLY the grammar src/engine/live/semantic/snowflake.ts writes, and nothing
// else: the statement back to b1's neutral question, so the fake layer (./semanticFake runFake, DuckDB over the
// parity fixture) can answer it. The structure (the view, the members, their aliases, the order, the limit, the
// "Other" exclusion) is parsed; each dimension reading and each predicate is matched by writing every candidate
// the IR allows with the compiler's own functions and keeping the one whose text AND bound values are the
// statement's — so a decoded question is one the encoder provably wrote. Anything else throws.
//
// This proves our encoder against our engine, per PR. That Snowflake answers the statement the same way is the
// warehouse nightly's to prove (scripts/warehouseLiveSnowflakeSemantic.ts).

import type { LiveParam } from '../src/connectors/types';
import type { DateGrain } from '../src/analysis/categoryKey';
import type { LiveColumn, LiveFilter } from '../src/engine/live/liveSpec';
import type { SemanticFilter, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const sf: typeof import('../src/engine/live/semantic/snowflake') = require('../src/engine/live/semantic/snowflake');
const cf: typeof import('../src/engine/live/compileFilter') = require('../src/engine/live/compileFilter');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const sqlMod: typeof import('../src/connectors/snowflakeSql') = require('../src/connectors/snowflakeSql');
const { snowflakeDialect }: typeof import('../src/engine/live/dialects/snowflake') = require('../src/engine/live/dialects/snowflake');

const bad = (why: string): never => {
  throw new Error(`not a statement the Snowflake encoder writes: ${why}`);
};

/** Split at `sep` where it is outside parentheses, quotes and identifiers. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(from, i));
      from = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

const NAME = '"([A-Za-z_][A-Za-z0-9_$]*)"(?:\\."([A-Za-z_][A-Za-z0-9_$]*)")?';
const nameOf = (m: RegExpExecArray, at: number): string => (m[at + 1] ? `${m[at]}.${m[at + 1]}` : m[at]);

/** Text and values of one fragment, as the encoder would bind it. */
function rendered(columns: LiveColumn[], write: (c: import('../src/engine/live/compileFilter').Ctx) => string | null): { sql: string; params: LiveParam[] } | null {
  const c = sf.memberCtx(columns);
  const text = write(c);
  if (text === null) return null;
  const done = c.b.finish(text, snowflakeDialect, []);
  return { sql: done.sql, params: done.params };
}
const sameValues = (a: LiveParam[], b: LiveParam[]): boolean =>
  a.length === b.length && a.every((p, i) => p.type === b[i].type && Object.is(p.value, b[i].value));

/** Every filter the IR could hold on `col` with these bound values. */
function candidates(col: LiveColumn, values: Array<string | number>): SemanticFilter[] {
  const column = col.name;
  const out: SemanticFilter[] = [
    { kind: 'empty', column, negate: false }, { kind: 'empty', column, negate: true },
    { kind: 'in', column, values: values.slice(), negate: false }, { kind: 'in', column, values: values.slice(), negate: true },
  ];
  if (values.length === 1) {
    for (const op of ['=', '!=', '>', '<', '>=', '<='] as const) out.push({ kind: 'compare', column, op, value: values[0] });
    if (typeof values[0] === 'string') {
      out.push({ kind: 'contains', column, value: values[0].slice(1, -1).replace(/!(.)/g, '$1') }); // the bound LIKE pattern, unescaped
      out.push({ kind: 'range', column, from: values[0] }, { kind: 'range', column, to: values[0] });
    }
  }
  if (values.length === 2 && values.every((v) => typeof v === 'string')) out.push({ kind: 'range', column, from: String(values[0]), to: String(values[1]) });
  if (values.length === 0) out.push({ kind: 'range', column });
  return out;
}

function decodeFilter(text: string, params: LiveParam[], columns: LiveColumn[]): SemanticFilter {
  for (const col of columns) {
    for (const f of candidates(col, params.map((p) => p.value as string | number))) {
      const r = rendered(columns, (c) => {
        const s = cf.predicate(c, f as LiveFilter);
        return typeof s === 'string' ? s : null;
      });
      if (r && r.sql === text && sameValues(r.params, params)) return f;
    }
  }
  return bad(`the predicate ${text}`);
}

function decodeDimension(text: string, columns: LiveColumn[]): { name: string; grain?: DateGrain } {
  for (const col of columns) {
    for (const grain of col.type === 'date' ? ck.DATE_GRAINS : [undefined]) {
      const r = rendered(columns, (c) => sf.dimensionReading(c, col, grain));
      if (r && r.sql === text && r.params.length === 0) return grain ? { name: col.name, grain } : { name: col.name };
    }
  }
  return bad(`the dimension ${text}`);
}

/** The statement `snowflakeAdapter.encode` wrote → the view it asks and the question. */
export function decodeSnowflake(sql: string, params: LiveParam[], columns: LiveColumn[]): { model: string; query: SemanticQuery } {
  const lines = sql.split('\n');
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = lines.length ? re.exec(lines[0]) : null;
    if (m) lines.shift();
    return m;
  };
  const select = take(/^SELECT (.+)$/) ?? bad('no SELECT');
  if (!take(/^FROM SEMANTIC_VIEW\($/)) bad('no SEMANTIC_VIEW');
  const view = take(/^ {2}"([A-Za-z_][A-Za-z0-9_$]*)"\."([A-Za-z_][A-Za-z0-9_$]*)"\."([A-Za-z_][A-Za-z0-9_$]*)"$/) ?? bad('no view');
  const dims = take(/^ {2}DIMENSIONS (.+)$/);
  const mets = take(/^ {2}METRICS (.+)$/);
  const where = take(/^ {2}WHERE (.+)$/);
  if (!take(/^\)$/)) bad('the clause does not close');
  const order = take(/^ORDER BY (.+)$/);
  const limit = take(/^LIMIT (\d+)$/);
  if (lines.length) bad(`left over: ${lines.join(' ')}`);

  // The outer SELECT names every column; the clause's aliases say which member each is.
  const named = new Map<string, string>(); // alias → stored name
  for (const item of splitTop(select[1], ', ')) {
    const m = new RegExp(`^(?:"(d\\d+)"|CAST\\("(m\\d+)" AS DOUBLE\\)) AS "([^"]+)"$`).exec(item) ?? bad(`the output ${item}`);
    named.set(m[1] ?? m[2], m[3]);
  }
  const dimensions = (dims ? splitTop(dims[1], ', ') : []).map((item, i) => {
    const m = /^(.+) AS "d(\d+)"$/.exec(item) ?? bad(`the dimension ${item}`);
    if (Number(m[2]) !== i) bad('dimensions out of order');
    const d = decodeDimension(m[1], columns);
    if (named.get(`d${i}`) !== d.name) bad(`d${i} is output as ${named.get(`d${i}`)}`);
    return d;
  });
  const metrics = (mets ? splitTop(mets[1], ', ') : []).map((item, j) => {
    const m = new RegExp(`^${NAME} AS "m(\\d+)"$`).exec(item) ?? bad(`the metric ${item}`);
    if (Number(m[3]) !== j) bad('metrics out of order');
    const name = nameOf(m, 1);
    if (named.get(`m${j}`) !== name) bad(`m${j} is output as ${named.get(`m${j}`)}`);
    return name;
  });
  if (named.size !== dimensions.length + metrics.length) bad('an output names no member');

  const q: SemanticQuery = { dimensions, metrics, where: [], order: [] };
  let at = 0;
  const preds = where ? splitTop(where[1], ' AND ') : [];
  preds.forEach((text, i) => {
    const n = sqlMod.countPlaceholders(text);
    const mine = params.slice(at, at + n);
    at += n;
    if (text.startsWith('NOT ')) {
      if (i !== preds.length - 1) bad('"Other" is not last');
      const f = decodeFilter(text.slice(4), mine, columns);
      if (f.kind !== 'in' || f.negate) bad('"Other" is not a kept list');
      q.exclude = { dimension: f.column, values: (f as Extract<SemanticFilter, { kind: 'in' }>).values };
    } else {
      q.where.push(decodeFilter(text, mine, columns));
    }
  });
  if (at !== params.length) bad(`${params.length - at} values bound to nothing`);
  const aliasName = (a: string): string => named.get(a) ?? bad(`orders by ${a}`);
  q.order = (order ? splitTop(order[1], ', ') : []).map((item) => {
    const m = /^"([dm]\d+)" (ASC|DESC) NULLS LAST$/.exec(item) ?? bad(`the order ${item}`);
    return { by: aliasName(m[1]), desc: m[2] === 'DESC' };
  });
  if (limit) q.limit = Number(limit[1]);
  return { model: `${view[1]}.${view[2]}.${view[3]}`, query: q };
}

// ── The fake as Snowflake's SQL API (c1 Tasks 3 and 4) ──────────────────────
//
// An answer for ./snowflakeFake `FakeSnowflake.answer`: the real `snowflake` connector (its execute, binds, row-cap
// wrapper and shaping) talks to it through `setTransport`. It answers SHOW SEMANTIC VIEWS and DESCRIBE SEMANTIC VIEW
// from the views it holds, and the encoder's statements by decoding them and asking ./semanticFake's runFake —
// DuckDB over a table the test loaded. Every value goes back as a string under its rowType, as Snowflake sends it.

import type { SfHttpRequest, SfHttpResponse } from '../src/connectors/snowflakeHttp';

/** A semantic view the fake holds: its dimensions (a table's columns, read by runFake) and its metrics' expressions. */
export interface FakeView {
  /** DATABASE.SCHEMA.VIEW */
  name: string;
  comment?: string;
  /** The DuckDB table runFake answers from. */
  table: string;
  columns: LiveColumn[];
  /** Metric name → its EXPRESSION, as DESCRIBE shows it. runFake must know the name (./semanticFake FAKE_METRICS). */
  metrics: Record<string, string>;
  /** DESCRIBE's rows instead of the ones built from `columns` and `metrics`: [kind, name, parent, property, value]. */
  describe?: Array<[string, string, string | null, string, string]>;
}

const sfType: Record<string, string> = { text: 'VARCHAR(16777216)', number: 'FLOAT', date: 'DATE' };
const HANDLE = '01b0e8a5-0002-3c8a-0000-0001234a5b6e';

/** One finished statement's response (HTTP 200, jsonv2), every value a string or null. */
export function sqlApiResult(cols: Array<[string, string]>, data: Array<Array<string | null>>): SfHttpResponse {
  const body = {
    resultSetMetaData: {
      numRows: data.length, format: 'jsonv2', partitionInfo: [{ rowCount: data.length, uncompressedSize: 1024 }],
      rowType: cols.map(([name, type]) => ({ name, type, nullable: true, scale: type === 'fixed' ? 0 : null, precision: type === 'fixed' ? 38 : null })),
    },
    data, code: '090001', sqlState: '00000', statementHandle: HANDLE, message: 'Statement executed successfully.',
  };
  return { status: 200, body: JSON.stringify(body), truncated: false };
}

/** A failed statement (HTTP 422) saying `message`. */
export function sqlApiFailure(message: string): SfHttpResponse {
  return { status: 422, body: JSON.stringify({ code: '002003', sqlState: '02000', message, statementHandle: HANDLE }), truncated: false };
}

function describeRows(v: FakeView): Array<Array<string | null>> {
  if (v.describe) return v.describe;
  const out: Array<Array<string | null>> = [['TABLE', 'PARITY', null, 'BASE_TABLE_NAME', v.table]];
  for (const c of v.columns) {
    out.push(['DIMENSION', c.name, 'PARITY', 'TABLE', 'PARITY'], ['DIMENSION', c.name, 'PARITY', 'EXPRESSION', `parity."${c.name}"`],
      ['DIMENSION', c.name, 'PARITY', 'DATA_TYPE', sfType[c.type]], ['DIMENSION', c.name, 'PARITY', 'ACCESS_MODIFIER', 'PUBLIC']);
  }
  for (const [m, expr] of Object.entries(v.metrics)) {
    out.push(['METRIC', m, 'PARITY', 'TABLE', 'PARITY'], ['METRIC', m, 'PARITY', 'EXPRESSION', expr],
      ['METRIC', m, 'PARITY', 'DATA_TYPE', 'NUMBER(38,6)'], ['METRIC', m, 'PARITY', 'ACCESS_MODIFIER', 'PUBLIC']);
  }
  return out;
}

/** The SQL API's bindings back to the encoder's parameters. */
export function paramsOf(bindings: unknown): LiveParam[] {
  const b = (bindings ?? {}) as Record<string, { type: string; value: string | null }>;
  return Object.keys(b).sort((x, y) => Number(x) - Number(y)).map((k, i) => {
    const { type, value } = b[k];
    const v = value ?? '';
    if (type === 'TEXT') return { name: `p${i}`, type: 'text', value: v };
    if (type === 'FIXED' || type === 'REAL') return { name: `p${i}`, type: 'number', value: Number(v) };
    if (type === 'DATE') return { name: `p${i}`, type: 'date', value: new Date(Number(v)).toISOString().slice(0, 10) };
    return bad(`a ${type} binding`);
  });
}

const CAPPED = /^select \* from \(\n([\s\S]*)\n\) limit (\d+)$/;
const epochDay = (iso: string): string => String(Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000));

/** Every statement `FakeSnowflake` saw that asked a view a question, decoded: the view and the question. */
export const asked: Array<{ model: string; query: SemanticQuery }> = [];

/**
 * The answer function: the views' catalog, and their questions answered by runFake. `hook` may answer a statement
 * first (a failure, a planted error) — return undefined to let the fake answer.
 */
export function semanticAnswer(views: FakeView[], hook?: (statement: string) => SfHttpResponse | undefined): (req: SfHttpRequest, kind: string) => Promise<SfHttpResponse> {
  return async (req, kind) => {
    if (kind === 'cancel') return sqlApiResult([], []);
    const json = JSON.parse(req.body ?? '{}') as { statement?: string; bindings?: unknown };
    const statement = String(json.statement ?? '');
    const held = hook?.(statement);
    if (held) return held;
    if (/^SHOW SEMANTIC VIEWS IN (DATABASE|ACCOUNT) LIMIT 1000$/.test(statement)) {
      const cols: Array<[string, string]> = [['created_on', 'timestamp_ltz'], ['name', 'text'], ['database_name', 'text'], ['schema_name', 'text'], ['comment', 'text'], ['owner', 'text']];
      return sqlApiResult(cols, views.map((v) => {
        const [db, schema, name] = v.name.split('.');
        return ['1700000000.000000000', name, db, schema, v.comment ?? '', 'SYSADMIN'];
      }));
    }
    const d = /^DESCRIBE SEMANTIC VIEW "([^"]+)"\."([^"]+)"\."([^"]+)"$/.exec(statement);
    if (d) {
      const v = views.find((x) => x.name === `${d[1]}.${d[2]}.${d[3]}`);
      if (!v) return sqlApiFailure(`Semantic view '${d[3]}' does not exist or not authorized.`);
      return sqlApiResult([['object_kind', 'text'], ['object_name', 'text'], ['parent_entity', 'text'], ['property', 'text'], ['property_value', 'text']], describeRows(v));
    }
    const capped = CAPPED.exec(statement) ?? bad('a statement that is not capped');
    const { model, query } = (() => {
      const v0 = views.find((x) => capped[1].includes(`"${x.name.split('.').join('"."')}"`));
      if (!v0) return bad('a view the fake does not hold');
      return decodeSnowflake(capped[1], paramsOf(json.bindings), v0.columns);
    })();
    const view = views.find((x) => x.name === model)!;
    asked.push({ model, query });
    const fake: typeof import('./semanticFake') = require('./semanticFake');
    const a = await fake.runFake(view.table, view.columns, query);
    const kinds = [...query.dimensions.map((x) => view.columns.find((c) => c.name === x.name)!.type), ...query.metrics.map(() => 'number' as const)];
    const cols = a.columns.map((name, i): [string, string] => [name, kinds[i] === 'text' ? 'text' : kinds[i] === 'date' ? 'date' : 'real']);
    const data = a.rows.slice(0, Number(capped[2])).map((r) => r.map((v, i) => {
      if (v === null || v === undefined) return null;
      if (kinds[i] === 'date') return epochDay(String(v));
      return Object.is(v, -0) ? '-0' : String(v);
    }));
    return sqlApiResult(cols, data);
  };
}
