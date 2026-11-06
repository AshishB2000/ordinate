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
