// The test harness's FAKE dbt SEMANTIC LAYER (semantic layer part 7, d1; docs/live-data/dbt-semantic-layer.md). Not a
// suite itself.
//
//   parseTemplate  a reader of the `where` text Ordinate writes (src/engine/live/semantic/literals.ts): every predicate
//                  it can read, and whatever it cannot as a `raw` one, so a value that broke out of its quotes shows up
//                  as a second predicate (test-semanticLiterals' fuzz and its negative control).

/** A dimension as the template names it: `{{ Dimension('x') }}`, or `{{ TimeDimension('x', 'day') }}` (`day`). */
export type TemplateRef = { name: string; day: boolean };
export type TemplatePredicate =
  | { ref: TemplateRef; op: '=' | '<>' | '<' | '<=' | '>' | '>='; value: string }
  | { ref: TemplateRef; isNull: boolean }
  | { ref: TemplateRef; in: string[]; not: boolean }
  | { ref: TemplateRef; like: string }
  | { raw: string };
export type TemplateTree = TemplatePredicate | { and: TemplateTree[] } | { or: TemplateTree[] };

type Tok = { t: 'ref'; ref: TemplateRef } | { t: 'str'; v: string } | { t: 'num'; v: string } | { t: 'op'; v: string } | { t: 'kw'; v: string } | { t: 'p'; v: '(' | ')' | ',' } | { t: 'raw'; v: string };

const REF = /^\{\{ (?:Dimension\('([a-z0-9_]+)'\)|TimeDimension\('([a-z0-9_]+)', 'day'\)) \}\}/;
const KW = new Set(['IN', 'NOT', 'IS', 'NULL', 'LIKE', 'AND', 'OR']);

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    if (/^\s/.test(rest)) { i += 1; continue; }
    const ref = REF.exec(rest);
    if (ref) { out.push({ t: 'ref', ref: { name: ref[1] ?? ref[2], day: ref[2] !== undefined } }); i += ref[0].length; continue; }
    if (rest[0] === "'") {
      let v = '';
      let j = 1;
      for (; j < rest.length; j += 1) {
        if (rest[j] === "'" && rest[j + 1] === "'") { v += "'"; j += 1; } else if (rest[j] === "'") break; else v += rest[j];
      }
      if (j >= rest.length) { out.push({ t: 'raw', v: rest }); break; } // an unterminated quote
      out.push({ t: 'str', v });
      i += j + 1;
      continue;
    }
    const m = /^(<>|<=|>=|=|<|>)/.exec(rest) ?? /^-?\d+(?:\.\d+)?(?![\w.])/.exec(rest) ?? /^[A-Z]+(?![\w])/.exec(rest);
    if (m && /^[<>=]/.test(m[0])) out.push({ t: 'op', v: m[0] });
    else if (m && /^-?\d/.test(m[0])) out.push({ t: 'num', v: m[0] });
    else if (m && KW.has(m[0])) out.push({ t: 'kw', v: m[0] });
    else if ('(),'.includes(rest[0])) { out.push({ t: 'p', v: rest[0] as '(' | ')' | ',' }); i += 1; continue; }
    else { const r = /^\S+/.exec(rest)![0]; out.push({ t: 'raw', v: r }); i += r.length; continue; }
    i += m[0].length;
  }
  return out;
}

/** The text Ordinate writes for one `where` entry, read back: its tree and every predicate in it (unreadable ones `raw`). */
export function parseTemplate(sql: string): { tree: TemplateTree; predicates: TemplatePredicate[] } {
  const ts = tokens(sql);
  let at = 0;
  const predicates: TemplatePredicate[] = [];
  const peek = (): Tok | undefined => ts[at];
  const is = (t: Tok['t'], v?: string): boolean => peek()?.t === t && (v === undefined || (peek() as { v?: string }).v === v);
  const raw = (): { raw: string } => {
    const parts: string[] = [];
    let depth = 0;
    while (at < ts.length && !(depth === 0 && (is('kw', 'AND') || is('kw', 'OR') || is('p', ')')))) {
      const tok = ts[at++];
      if (tok.t === 'p' && tok.v === '(') depth += 1;
      if (tok.t === 'p' && tok.v === ')') depth -= 1;
      parts.push(tok.t === 'ref' ? `{{${tok.ref.name}}}` : tok.v);
    }
    return { raw: parts.join(' ') };
  };
  const str = (): string | null => (is('str') ? (ts[at++] as { v: string }).v : null);
  const pred = (): TemplatePredicate => {
    const start = at;
    const tok = peek();
    if (tok?.t !== 'ref') return raw();
    at += 1;
    const ref = tok.ref;
    const back = (): TemplatePredicate => { at = start; return raw(); };
    if (is('op')) {
      const op = (ts[at++] as { v: string }).v as '=';
      const v = str();
      return v === null ? back() : { ref, op, value: v };
    }
    if (is('kw', 'IS')) {
      at += 1;
      const not = is('kw', 'NOT');
      if (not) at += 1;
      if (!is('kw', 'NULL')) return back();
      at += 1;
      return { ref, isNull: !not };
    }
    if (is('kw', 'LIKE')) {
      at += 1;
      const v = str();
      return v === null ? back() : { ref, like: v };
    }
    const not = is('kw', 'NOT');
    if (not) at += 1;
    if (!is('kw', 'IN')) return back();
    at += 1;
    if (!is('p', '(')) return back();
    at += 1;
    const values: string[] = [];
    for (;;) {
      const v = str();
      if (v === null) return back();
      values.push(v);
      if (is('p', ',')) { at += 1; continue; }
      if (is('p', ')')) { at += 1; break; }
      return back();
    }
    return { ref, in: values, not };
  };
  const term = (): TemplateTree => {
    if (is('p', '(')) {
      const start = at;
      at += 1;
      const inner = expr();
      if (is('p', ')')) { at += 1; return inner; }
      at = start;
    }
    const p = pred();
    predicates.push(p);
    return p;
  };
  const expr = (): TemplateTree => {
    const items = [term()];
    let joint: 'AND' | 'OR' | null = null;
    while (is('kw', 'AND') || is('kw', 'OR')) {
      const k = (ts[at++] as { v: string }).v as 'AND' | 'OR';
      if (joint && joint !== k) { const r: TemplatePredicate = { raw: `mixed ${joint} and ${k}` }; predicates.push(r); items.push(r); }
      joint = k;
      items.push(term());
    }
    return items.length === 1 ? items[0] : joint === 'OR' ? { or: items } : { and: items };
  };
  const tree = expr();
  while (at < ts.length) { // anything after the expression is a predicate nobody wrote
    const r = raw();
    if (!r.raw) at += 1;
    predicates.push(r.raw ? r : { raw: ')' });
  }
  return { tree, predicates };
}

// ── Decoding the encoder's body (the round trip test-semanticDbt holds the encoder to) ──────────────────────────────

import type { DbtBody } from '../src/connectors/dbtWire';
import type { HttpRequestOptions, HttpResult } from '../src/connectors/httpShared';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { SemanticFilter, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const wire: typeof import('../src/connectors/dbtWire') = require('../src/connectors/dbtWire');
const cubeEnc: typeof import('../src/engine/live/semantic/cube') = require('../src/engine/live/semantic/cube');
const semFake: typeof import('./semanticFake') = require('./semanticFake');
const fakeCube: typeof import('./semanticFakeCube') = require('./semanticFakeCube');
const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');

const show = (v: unknown): string => JSON.stringify(v);
const bad = (what: string, f: unknown): never => {
  throw new Error(`fake dbt: ${what}: ${show(f)}`);
};

type Leaf = Exclude<TemplatePredicate, { raw: string }>;
const leafOf = (t: TemplateTree): Leaf | null => ('ref' in t ? t : null);
const kidsOf = (t: TemplateTree, k: 'and' | 'or'): Leaf[] | null => (k in t ? ((t as Record<string, TemplateTree[]>)[k].map(leafOf).every(Boolean) ? (t as Record<string, Leaf[]>)[k] : null) : null);
const opIs = (l: Leaf | null | undefined, op: string, value?: string): l is Extract<Leaf, { op: string }> => !!l && 'op' in l && l.op === op && (value === undefined || l.value === value);
const nullIs = (l: Leaf | null | undefined, isNull: boolean): boolean => !!l && 'isNull' in l && l.isNull === isNull;
const inIs = (l: Leaf | null | undefined, not: boolean): l is Extract<Leaf, { in: string[] }> => !!l && 'in' in l && l.not === not;
const day = (v: string): string => cubeEnc.isoDay(v) ?? bad('not an ISO day', v);

/** One `where` entry → the filter it means (as the encoder spells it), or throws. */
function decodeWhere(sql: string, columns: readonly LiveColumn[], nonBlank: readonly string[]): SemanticFilter {
  const { tree, predicates } = parseTemplate(sql);
  if (predicates.length === 0 || predicates.some((p) => 'raw' in p)) return bad('a where entry the encoder does not write', sql);
  const refs = (predicates as Leaf[]).map((p) => p.ref);
  if (refs.some((r) => r.name !== refs[0].name || r.day !== refs[0].day)) return bad('two dimensions in one entry', sql);
  const col = columns.find((c) => c.name === refs[0].name) ?? bad('a dimension the dataset does not declare', sql);
  if (refs[0].day !== (col.type === 'date')) return bad('a dimension at the wrong grain', sql);
  const at = { column: col.name };
  const one = leafOf(tree);
  const or = kidsOf(tree, 'or');
  const and = kidsOf(tree, 'and');
  if (col.type === 'text') {
    if (opIs(one, '=') && one.value !== '') return { kind: 'in', ...at, values: [one.value], negate: false };
    if (or?.length === 2 && opIs(or[0], '=', '') && nullIs(or[1], true)) return { kind: 'in', ...at, values: [''], negate: false };
    if (or?.length === 2 && opIs(or[0], '<>') && or[0].value !== '' && nullIs(or[1], true)) return { kind: 'in', ...at, values: [or[0].value], negate: true };
    if (opIs(one, '<>', '')) return nonBlank.includes(col.name) ? { kind: 'empty', ...at, negate: true } : { kind: 'in', ...at, values: [''], negate: true };
    if (inIs(one, false)) return { kind: 'in', ...at, values: one.in, negate: false };
    if (or?.length === 3 && inIs(or[0], false) && opIs(or[1], '=', '') && nullIs(or[2], true)) return { kind: 'in', ...at, values: [...or[0].in, ''], negate: false };
    if (or?.length === 2 && inIs(or[0], true) && nullIs(or[1], true)) return { kind: 'in', ...at, values: or[0].in, negate: true };
    if (and?.length === 2 && inIs(and[0], true) && opIs(and[1], '<>', '')) return { kind: 'in', ...at, values: [...and[0].in, ''], negate: true };
    if (one && 'like' in one && /^%.+%$/s.test(one.like)) return { kind: 'contains', ...at, value: one.like.slice(1, -1) };
  } else if (col.type === 'date') {
    if (one && 'op' in one && ['=', '>', '>='].includes(one.op)) return { kind: 'compare', ...at, op: one.op as '=', value: day(one.value) };
    if (opIs(one, '<=')) return { kind: 'range', ...at, to: day(one.value) };
    if (or?.length === 2 && or[0] && 'op' in or[0] && ['<>', '<', '<='].includes(or[0].op) && nullIs(or[1], true)) return { kind: 'compare', ...at, op: or[0].op === '<>' ? '!=' : or[0].op as '<', value: day(or[0].value) };
    if (one && 'isNull' in one) return { kind: 'empty', ...at, negate: !one.isNull };
    if (inIs(one, false)) return { kind: 'in', ...at, values: one.in.map(day), negate: false };
    if (or?.length === 2 && inIs(or[0], false) && nullIs(or[1], true)) return { kind: 'in', ...at, values: [...or[0].in.map(day), ''], negate: false };
    if (or?.length === 2 && inIs(or[0], true) && nullIs(or[1], true)) return { kind: 'in', ...at, values: or[0].in.map(day), negate: true };
    if (inIs(one, true)) return { kind: 'in', ...at, values: [...one.in.map(day), ''], negate: true };
    if (and?.length === 2 && opIs(and[0], '>=') && opIs(and[1], '<=')) return { kind: 'range', ...at, from: day(and[0].value), to: day(and[1].value) };
  }
  return bad(`a ${col.type} filter the encoder does not write`, sql);
}

/**
 * The encoder's body → the saved query and question it asks. `as: 'ours'` (the default) reads the connector's own
 * post-processing too (a value list's blanks dropped, then cut); `as: 'dbt'` reads only what dbt is sent.
 */
export function decodeDbt(body: unknown, columns: readonly LiveColumn[], as: 'ours' | 'dbt' = 'ours'): { savedQuery: string; query: SemanticQuery } {
  if (!wire.isDbtBody(body)) return bad('not a dbt body', body);
  const b: DbtBody = body;
  if (!wire.DBT_IDENT_RE.test(b.savedQuery)) bad('a saved query that is no name', b.savedQuery);
  if ((b.nonBlank?.length ?? 0) > 0 && b.limit !== undefined && b.limit <= 100_000) bad('a value list cut by dbt before its blanks are dropped', b);
  const GRAIN = Object.fromEntries(Object.entries(wire.GRAIN_OF).map(([k, v]) => [v, k])) as Record<string, import('../src/analysis/categoryKey').DateGrain>;
  const dimensions: SemanticQuery['dimensions'] = b.groupBy.map((g) => {
    const col = columns.find((c) => c.name === g.name) ?? bad('a group-by the dataset does not declare', g);
    if ((col.type === 'date') !== (g.grain !== undefined) || (g.grain !== undefined && !GRAIN[g.grain])) bad('a group-by at the wrong grain', g);
    return g.grain ? { name: g.name, grain: GRAIN[g.grain] } : { name: g.name };
  });
  const metrics = b.metrics.map((m) => (Object.keys(m).join() === 'name' && typeof m.name === 'string' ? m.name : bad('a metric input', m)));
  const nonBlank = as === 'ours' ? b.nonBlank ?? [] : [];
  const where = b.where.map((w) => (Object.keys(w).join() === 'sql' ? decodeWhere(w.sql, columns, nonBlank) : bad('a where input', w)));
  const order = b.orderBy.map((o) => {
    if ('metric' in o) return metrics.includes(o.metric.name) ? { by: o.metric.name, desc: o.descending } : bad('an order by a metric not asked', o);
    const g = b.groupBy.find((x) => x.name === o.groupBy.name);
    return g && g.grain === o.groupBy.grain ? { by: g.name, desc: o.descending } : bad('an order by a group-by not asked', o);
  });
  if (b.orderBy.some((o) => typeof o.descending !== 'boolean')) bad('an order without its direction', b.orderBy);
  const limit = as === 'ours' ? b.cut ?? b.limit : b.limit;
  return { savedQuery: b.savedQuery, query: { dimensions, metrics, where, order, ...(limit !== undefined ? { limit } : {}) } };
}

/** The plan's question as the decoder spells it (the same meaning). */
export function canonical(q: SemanticQuery, columns: readonly LiveColumn[]): SemanticQuery {
  const typeOf = (c: string): string => columns.find((x) => x.name === c)?.type ?? 'text';
  const text = (v: unknown): string => (v == null ? '' : String(v));
  const listed = (vs: readonly unknown[]): string[] => {
    const kept = [...new Set(vs.filter((v) => text(v) !== '').map(text))];
    return vs.some((v) => text(v) === '') ? [...kept, ''] : kept;
  };
  const one = (f: SemanticFilter): SemanticFilter => {
    const date = typeOf(f.column) === 'date';
    if (f.kind === 'compare' && !date) return { kind: 'in', column: f.column, values: [text(f.value)], negate: f.op === '!=' };
    if (f.kind === 'compare') return { kind: 'compare', column: f.column, op: f.op, value: text(f.value) };
    if (f.kind === 'in') {
      const values = listed(f.values);
      if (date && values.length === 1 && values[0] === '') return { kind: 'empty', column: f.column, negate: f.negate };
      return { kind: 'in', column: f.column, values, negate: f.negate };
    }
    if (f.kind === 'range' && !f.from && !f.to) return { kind: 'empty', column: f.column, negate: true };
    if (f.kind === 'range' && f.from && !f.to) return { kind: 'compare', column: f.column, op: '>=', value: f.from };
    return f;
  };
  const where = [...q.where, ...(q.exclude ? [{ kind: 'in' as const, column: q.exclude.dimension, values: q.exclude.values, negate: true }] : [])].map(one);
  const { exclude: _drop, ...rest } = q;
  return { ...rest, where };
}

/** The matrix filters dbt cannot express exactly: refused `layerFilter` at every door (docs/live-data/dbt-semantic-layer.md). */
export function dbtRefusedFilters(): ReadonlyMap<string, string> {
  return new Map([[show([mx.F('cat', 'is_empty')]), 'layerFilter'], [show([mx.F('cat', 'not_empty')]), 'layerFilter'], [show([mx.F('amt', '>', 0)]), 'layerFilter']]);
}

/** The matrix's chart cases dbt refuses whole: the kept categories of `cat` include an emoji, a tab, a no-break space and a BOM, which no literal holds. */
export function dbtRefusedCases(): ReadonlyMap<string, string> {
  return new Map([['split: cat × tier, a number split', 'layerFilter']]);
}

/** A dataset's dimensions as dbt types them: every categorical one text (the API reports no SQL type), a time one date. */
export const asDbtTypes = (columns: readonly LiveColumn[]): LiveColumn[] => columns.map((c) => (c.type === 'date' ? c : { ...c, type: 'text' }));

// ── dbt's answer ──────────────────────────────────────────────────────────────

/** A decoded question's rows (dimensions, then metrics) → the jsonResult pages dbt would send (pandas' table orient). */
export function jsonPages(body: DbtBody, q: SemanticQuery, rows: unknown[][], pageSize: number, upper = false): string[] {
  const at = (name: string): number => [...q.dimensions.map((d) => d.name), ...q.metrics].indexOf(name);
  const ordered = fakeCube.postgresOrder(rows, q.order.map((o) => ({ at: at(o.by), desc: o.desc }))).slice(0, body.limit ?? rows.length);
  const keys = wire.replyKeys(body).map((k) => ({ ...k, key: upper ? k.key.toUpperCase() : k.key }));
  const fields = [{ name: 'index', type: 'integer' }, ...keys.map((k, i) => ({ name: k.key, type: k.metric ? 'number' : body.groupBy[i]?.grain ? 'datetime' : 'string' }))];
  const data = ordered.map((r, i) => {
    const o: Record<string, unknown> = { index: i };
    keys.forEach((k, j) => {
      const v = r[j];
      o[k.key] = !k.metric && body.groupBy[j]?.grain && v != null ? `${String(v)}T00:00:00.000` : v;
    });
    return o;
  });
  const out: string[] = [];
  for (let p = 0; p === 0 || p * pageSize < data.length; p += 1) {
    out.push(JSON.stringify({ schema: { fields, primaryKey: ['index'], pandas_version: '1.4.0' }, data: data.slice(p * pageSize, (p + 1) * pageSize) }));
  }
  return out;
}

// ── The fake API, as a transport for src/connectors/dbt.ts setTransport ──────────────────────────────────────────

/** One saved query the fake lists: a DuckDB table answered with scripts/semanticFake.ts's metrics. */
export interface FakeSavedQuery {
  name: string;
  label?: string;
  description?: string;
  table: string;
  /** Its group-bys: dimensions as dbt names them (a date one TIME, every other CATEGORICAL). */
  columns: LiveColumn[];
  metrics?: string[];
  /** Its own filter, in the encoder's grammar (the fake applies it as dbt would). */
  where?: string;
}

const AGG: Record<string, string> = { revenue: 'SUM', orders: 'COUNT', avg_amount: 'AVERAGE', max_amount: 'MAX' };

export interface FakeDbt {
  transport: (opts: HttpRequestOptions) => Promise<HttpResult>;
  /** Every request: its operation, variables, Authorization header and URL. */
  requests: Array<{ op: string; variables: Record<string, unknown>; auth: string; url: string }>;
  /** Polls answered RUNNING before each answer; rows per page; the reply's column names upper-cased. */
  waits: number;
  pageSize: number;
  upper: boolean;
  /** false: the SDK's `measures` query is unknown (a newer API). */
  measures: boolean;
  /** A test's own answer to an operation (status + JSON), before the fake's. */
  hook: ((op: string, variables: Record<string, unknown>) => { status: number; json: unknown } | undefined) | null;
  ops(op: string): number;
}

export function startFakeDbt(opts: { models: FakeSavedQuery[]; token: string; environmentId: number; host?: string }): FakeDbt {
  const results = new Map<string, { body: DbtBody; pages: string[]; polls: number }>();
  let next = 1;
  const reply = (json: unknown, status = 200): HttpResult => ({ status, body: JSON.stringify(json), truncated: false });
  const self: FakeDbt = {
    requests: [], waits: 0, pageSize: 1024, upper: false, measures: true, hook: null,
    ops: (op) => self.requests.filter((r) => r.op === op).length,
    transport: async (req) => {
      if (req.signal?.aborted) throw new Error('Cancelled');
      const host = opts.host ?? 'semantic-layer.cloud.getdbt.com';
      if (req.url.hostname !== host || req.url.pathname !== '/api/graphql' || req.method !== 'POST') return reply({ errors: [{ message: 'Not found' }] }, 404);
      const parsed = JSON.parse(req.body ?? '{}') as { query?: string; variables?: Record<string, unknown> };
      const op = Object.entries(wire.DOCS).find(([, d]) => d === parsed.query)?.[0] ?? 'unknown';
      const v = parsed.variables ?? {};
      const auth = String(req.headers?.authorization ?? '');
      self.requests.push({ op, variables: v, auth, url: req.url.href });
      const own = self.hook?.(op, v);
      if (own) return reply(own.json, own.status);
      if (auth !== `Bearer ${opts.token}`) return reply({ errors: [{ message: 'User is not authorized' }], data: null }, 401);
      if (v.environmentId !== opts.environmentId) return reply({ errors: [{ message: 'Environment not found' }], data: null });
      const model = (name: unknown): FakeSavedQuery | undefined => opts.models.find((m) => m.name === name);
      const metricsOf = (m: FakeSavedQuery): string[] => m.metrics ?? Object.keys(semFake.FAKE_METRICS);
      switch (op) {
        case 'savedQueries':
          return reply({ data: { savedQueriesPaginated: { items: opts.models.map((m) => ({ name: m.name, label: m.label ?? null, description: m.description ?? null })), pageNum: v.pageNum, pageSize: 100, totalItems: opts.models.length, totalPages: 1 } } });
        case 'savedQuery': {
          const m = model(v.savedQueryName);
          if (!m) return reply({ data: { savedQuery: null } });
          return reply({ data: { savedQuery: { name: m.name, queryParams: {
            metrics: metricsOf(m).map((name) => ({ name })),
            groupBy: m.columns.map((c) => ({ name: c.name, grain: c.type === 'date' ? 'DAY' : null, datePart: null })),
            where: m.where ? { whereSqlTemplate: m.where } : null,
          } } } });
        }
        case 'dimensions': {
          const all = new Map(opts.models.flatMap((m) => m.columns).map((c) => [c.name, c]));
          return reply({ data: { dimensionsPaginated: { items: [...all.values()].map((c) => ({ name: c.name, description: null, type: c.type === 'date' ? 'TIME' : 'CATEGORICAL', queryableGranularities: c.type === 'date' ? ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'] : [] })), pageNum: v.pageNum, pageSize: 500, totalItems: all.size, totalPages: 1 } } });
        }
        case 'metrics':
          return reply({ data: { metricsPaginated: { items: Object.keys(semFake.FAKE_METRICS).map((name) => ({ name, description: `The ${name.replace('_', ' ')}`, type: 'SIMPLE' })), pageNum: v.pageNum, pageSize: 500, totalItems: 4, totalPages: 1 } } });
        case 'measures': {
          if (!self.measures) return reply({ errors: [{ message: "Cannot query field 'measures' on type 'Query'." }], data: null });
          const name = String((v.metrics as Array<{ name: string }> | undefined)?.[0]?.name ?? '');
          return reply({ data: { measures: AGG[name] ? [{ name, agg: AGG[name] }] : [] } });
        }
        case 'createQuery': {
          const groupBy = (v.groupBy ?? []) as DbtBody['groupBy'];
          const m = opts.models.find((x) => groupBy.every((g) => x.columns.some((c) => c.name === g.name)));
          if (!m) return reply({ errors: [{ message: 'No saved query has those group-bys' }], data: null });
          const body: DbtBody = { savedQuery: m.name, metrics: (v.metrics ?? []) as DbtBody['metrics'], groupBy, where: (v.where ?? []) as DbtBody['where'], orderBy: (v.orderBy ?? []) as DbtBody['orderBy'], ...(typeof v.limit === 'number' ? { limit: v.limit } : {}) };
          try {
            const { query } = decodeDbt(body, m.columns, 'dbt');
            const all = await semFake.runFake(m.table, m.columns, { ...query, limit: undefined });
            const queryId = `QueryID_${next++}`;
            results.set(queryId, { body, pages: jsonPages(body, query, all.rows, self.pageSize, self.upper), polls: 0 });
            return reply({ data: { createQuery: { queryId } } });
          } catch (err) {
            return reply({ errors: [{ message: err instanceof Error ? err.message : String(err) }], data: null });
          }
        }
        case 'query': {
          const r = results.get(String(v.queryId));
          if (!r) return reply({ errors: [{ message: 'Query not found' }], data: null });
          if (r.polls++ < self.waits) return reply({ data: { query: { status: 'RUNNING', error: null, totalPages: null, jsonResult: null } } });
          const page = Number(v.pageNum);
          return reply({ data: { query: { status: 'SUCCESSFUL', error: null, totalPages: r.pages.length, jsonResult: r.pages[page - 1] ?? null } } });
        }
        case 'cancelQuery':
          return reply({ data: { cancelQuery: { queryId: v.queryId } } });
        default:
          return reply({ errors: [{ message: 'Unknown document' }], data: null }, 400);
      }
    },
  };
  return self;
}

