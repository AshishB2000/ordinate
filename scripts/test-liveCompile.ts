'use strict';

// Self-check for the live compiler (docs/live-data/00-plan.md L2.2, D4, threat
// model R-L1): what the SQL looks like per dialect, and — the security half —
// that a VALUE can never become SQL text.
//
//   1. Golden shapes per dialect: quoting, placeholders (and their numbering in
//      text order, never reused), the DOUBLE type, date truncation, the empty
//      test, LIKE escaping.
//   2. ADVERSARIAL LITERALS per dialect: every filter form compiled with a
//      hostile value and with a harmless one must produce the IDENTICAL
//      statement — the value lives only in `params`. Identifiers with quotes in
//      them decode back to themselves. A NEGATIVE CONTROL (a dialect that
//      inlines values) must be caught. On DuckDB the hostile values also RUN and
//      match exactly what the JS filter matches.
//   3. Refusals are typed and loud, in catalog sentences: sum over text, an
//      unknown column, within_km, and every feature live does not do yet.
//   4. The pure pieces: shaping (−0, sum + count, row width), the probes,
//      resolvePeriods, the step sequence of evaluateLive.
//
//   npm run build:ts && node scripts/test-liveCompile.js

import { ok, finish } from './selfcheck';
import type { FilterStep } from '../src/data/transforms';
import type { LiveColumn, LiveIR } from '../src/engine/live/liveSpec';
import type { CompileEnv, LiveKey, LiveSource } from '../src/engine/live/compile';
import type { CompileDialectId, SqlDialect } from '../src/engine/live/dialect';

const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const dl: typeof import('../src/engine/live/dialect') = require('../src/engine/live/dialect');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const shape: typeof import('../src/engine/live/shape') = require('../src/engine/live/shape');
const ev: typeof import('../src/engine/live/evaluate') = require('../src/engine/live/evaluate');
const params: typeof import('../src/engine/live/sqlParams') = require('../src/engine/live/sqlParams');
const i18n: typeof import('../src/app/i18n') = require('../src/app/i18n');
const filterOps: typeof import('../src/data/filterOps') = require('../src/data/filterOps');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const { duckdbDialect } = require('../src/engine/live/dialects/duckdb') as typeof import('../src/engine/live/dialects/duckdb');

const show = (v: unknown): string => JSON.stringify(v);
const COLS: LiveColumn[] = [
  { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'order_date', type: 'date' },
  { name: 'tier', type: 'number' }, { name: 'note', type: 'text' },
];
const TABLE: LiveSource = { kind: 'table', parts: ['db', 'sch', 'orders'] };
const env = (dialect: CompileDialectId | SqlDialect, source: LiveSource = TABLE, columns: LiveColumn[] = COLS): CompileEnv => ({ dialect, source, columns });
const F = (column: string, op: FilterStep['op'], value?: unknown, extra: Partial<FilterStep> = {}): FilterStep =>
  ({ type: 'filter', column, op, ...(value === undefined ? {} : { value }), ...extra } as FilterStep);

function adapt(a: ReturnType<typeof spec.fromVizEncoding>): LiveIR {
  if (!a.ok) throw new Error(`refused: ${a.code}`);
  return a.ir;
}
function sqlOf(r: ReturnType<typeof comp.compileChart>): string {
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.message}`);
  return r.query.sql;
}

// ── The placeholder contract: params[i] is the (i+1)-th placeholder, named p<i> ──

const PLACEHOLDER: Record<CompileDialectId, RegExp> = {
  snowflake: /\?/g, bigquery: /@p(\d+)/g, databricks: /:p(\d+)/g, clickhouse: /\{p(\d+):/g, redshift: /\$(\d+)/g, duckdb: /\$(\d+)/g,
};
function placeholdersInOrder(id: CompileDialectId, q: import('../src/engine/live/compile').CompiledQuery): boolean {
  const found = [...q.sql.matchAll(PLACEHOLDER[id])];
  if (found.length !== q.params.length) return false;
  if (!q.params.every((p, i) => p.name === `p${i}`)) return false;
  if (id === 'snowflake') return true;
  const base = id === 'redshift' || id === 'duckdb' ? 1 : 0;
  return found.every((m, i) => Number(m[1]) === i + base);
}

function goldenShapes(): void {
  const text = adapt(spec.fromVizEncoding({ category: 'region', values: [{ column: 'amount', aggregation: 'avg' }, { column: 'note', aggregation: 'count' }] },
    [F('note', 'contains', '50%_off!'), F('amount', '>', 5), F('order_date', 'period', undefined, { period: { preset: 'custom', from: '2024-01-01', to: '2024-03-31' } })], COLS, { weekCal: null }));
  const answer = spec.fromAnswerSpec({ datasetId: 'x', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], series: 'tier', filters: [], chartType: 'column', title: 't', top: 5 }, COLS, { weekCal: null });
  const dated = adapt(spec.fromVizEncoding({ category: 'order_date', grain: 'quarter', values: [{ column: 'amount', aggregation: 'sum' }] }, [], COLS, { weekCal: null }));
  const want: Record<CompileDialectId, string[]> = {
    snowflake: ['"db"."sch"."orders" AS lv_src', 'CAST(sum(', 'AS DOUBLE)', "LIKE CAST(? AS VARCHAR) ESCAPE '!'", 'TRIM(', "DATE_TRUNC('QUARTER'", "DATEDIFF('day', DATE '1970-01-01'", 'CAST(? AS DATE)'],
    bigquery: ['`db`.`sch`.`orders` AS lv_src', 'AS FLOAT64)', 'LIKE CAST(@p1 AS STRING))', 'SAFE_CAST(', 'DATE_TRUNC(', ', QUARTER)', 'UNIX_DATE(', 'TRIM('],
    clickhouse: ['`db`.`sch`.`orders` AS lv_src', 'toFloat64(', "LIKE {p0:String})", 'accurateCastOrNull(', 'toStartOfQuarter(', 'match(', '{p2:Date32}'],
    databricks: ['`db`.`sch`.`orders` AS lv_src', 'AS DOUBLE)', "LIKE CAST(:p1 AS STRING) ESCAPE '!'", 'try_cast(', "'QUARTER')", 'btrim(', 'datediff('],
    redshift: ['"db"."sch"."orders" AS lv_src', 'DOUBLE PRECISION', "LIKE CAST($2 AS VARCHAR(65535)) ESCAPE '!'", "DATE_TRUNC('quarter'", "- DATE '1970-01-01')", 'BTRIM('],
    duckdb: ['"db"."sch"."orders" AS lv_src', 'AS DOUBLE)', "LIKE CAST($1 AS VARCHAR) ESCAPE '!'", 'regexp_full_match(', "date_trunc('quarter'", 'TRY_CAST('],
  };
  const week: Record<CompileDialectId, string> = {
    snowflake: "DATE_TRUNC('WEEK'", bigquery: 'ISOWEEK', clickhouse: 'toMonday(', databricks: "'WEEK')", redshift: "DATE_TRUNC('week'", duckdb: "date_trunc('week'",
  };
  for (const id of dialects.DIALECT_IDS) {
    const t = comp.compileChart(text, { kind: 'text' }, env(id));
    const sql = sqlOf(t) + '\n' + sqlOf(comp.compileChart(dated, { kind: 'date', grain: 'quarter' }, env(id)));
    const missing = want[id].filter((w) => !sql.includes(w));
    ok(`${id}: golden shape (${want[id].length} fragments)`, missing.length === 0, `missing ${show(missing)}\n${sql}`);
    ok(`${id}: placeholders numbered in text order, one per parameter, named p<i>`, t.ok && placeholdersInOrder(id, t.query), t.ok && show(t.query.params));
    // The needle `50%_off!`: % and _ always escaped; `!` too where it is the escape.
    const pattern = dialects.dialectFor(id).likeEscape === '!' ? '%50!%!_off!!%' : '%50\\%\\_off!%';
    ok(`${id}: the LIKE pattern escapes %, _ and the escape itself (${pattern})`,
      t.ok && t.query.params.some((p) => p.value === pattern), t.ok && show(t.query.params));
    const wk = comp.compileChart({ ...dated, category: { column: 'order_date', kind: 'date', grain: 'week' } }, { kind: 'date', grain: 'week' }, env(id));
    ok(`${id}: ISO weeks start Monday (${week[id]})`, sqlOf(wk).includes(week[id]));
    const top = answer.ok ? comp.compileChart(answer.ir, { kind: 'text' }, env(id)) : null;
    ok(`${id}: an answer's split + top N compiles, every value bound`, !!top && top.ok && placeholdersInOrder(id, top.query));
    const user = comp.compileMetric(adapt(spec.fromMetric({ column: 'amount', aggregation: 'sum' }, [], COLS)), env(id, { kind: 'sql', sql: 'select * from t -- a trailing comment;\n ;  ' }));
    ok(`${id}: a defining query sits on its own lines, trailing ; dropped (rule F3)`,
      user.ok && user.query.sql.includes('(\nselect * from t -- a trailing comment\n) AS lv_src'), user.ok && user.query.sql);
  }
  const sf = dialects.dialectFor('snowflake');
  ok('snowflake: a number stored as text goes through TRY_TO_DOUBLE, a typed one through CAST',
    sf.number('c', true).includes('TRY_TO_DOUBLE(TO_VARCHAR(c))') && sf.number('c', false).includes('CAST(c AS DOUBLE)'));
  ok('snowflake: a TIMESTAMP_TZ is moved to UTC before it becomes a day', sf.date('c', false, 'TIMESTAMP_TZ').includes("CONVERT_TIMEZONE('UTC', c)"));
  const rs = dialects.dialectFor('redshift');
  ok('redshift: a number stored as text is regex-gated before its CAST (no TRY_CAST)', rs.number('c', true).includes('~ ') && !rs.number('c', true).includes('TRY'));
  const pg = new params.ParamSink();
  const m = pg.bind('text', 'v');
  const twice = pg.finish(`a = ${m} OR b = ${m}`, duckdbDialect, []);
  ok('a fragment used twice binds twice: no placeholder is ever shared', show(twice.params.map((p) => p.name)) === '["p0","p1"]' && twice.sql === 'a = CAST($1 AS VARCHAR) OR b = CAST($2 AS VARCHAR)', twice.sql);
}

// ── Adversarial literals ─────────────────────────────────────────────────────

const HOSTILE = [
  "'", "''", '\\', "\\'", '\u2018\u2019\u201c\u201d', '${x}', '\u0000', '?', '@p1', ':p0', '{p0:String}', '$1', '"', '`', '--',
  '/*', "'; DROP TABLE orders; --", '%', '_', '!', '\n', "Robert'); DROP TABLE students;--", 'a\u0000b', '\u202e', '\\x{0009}',
];
const SENTINEL = 'SENTINEL_VALUE';

function filtersFor(v: string): FilterStep[][] {
  return [
    [F('region', '=', v)], [F('region', '!=', v)], [F('region', '<', v)], [F('region', 'in', undefined, { values: [v] })],
    [F('region', 'not in', undefined, { values: [v] })], [F('note', 'contains', v)], [F('order_date', '>=', v)],
    [F('order_date', 'in', undefined, { values: [v] })], [F('amount', '=', v)], [F('amount', 'in', undefined, { values: [v] })],
  ];
}

/** Every filter form, compiled with `v` and with a harmless value: the TEXT must not move. */
function leaks(d: SqlDialect | CompileDialectId, v: string): string[] {
  const out: string[] = [];
  const hostile = filtersFor(v);
  const plain = filtersFor(SENTINEL);
  hostile.forEach((fs, i) => {
    const enc = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' as const }] };
    const a = comp.compileChart(adapt(spec.fromVizEncoding(enc, fs, COLS, { weekCal: null })), { kind: 'text' }, env(d));
    const b = comp.compileChart(adapt(spec.fromVizEncoding(enc, plain[i], COLS, { weekCal: null })), { kind: 'text' }, env(d));
    if (!a.ok || !b.ok) { out.push(`refused ${show(fs)}`); return; }
    if (a.query.sql !== b.query.sql || a.query.sql.includes(SENTINEL)) out.push(`the value reached the text: ${show(fs)}`);
    const isNumber = fs[0].column === 'amount';
    const carried = a.query.params.some((p) => p.value === v || p.value === dl.likePattern(v, dialects.dialectFor(typeof d === 'string' ? d : 'duckdb').likeEscape));
    if (!isNumber && !carried) out.push(`the value is not a parameter: ${show(fs)}`);
  });
  return out;
}

const QUOTED_NAMES = ['a"b', 'a`b', 'a\\b', "a'b", 'x y', '${x}', '?', '\u00e9', 'a]b', '"; DROP TABLE t; --'];

/** Read every `lv_src.<ident>` back out of the text with the dialect's own quoting rules. */
function decodeIdents(id: CompileDialectId, sql: string): string[] {
  const out: string[] = [];
  let at = 0;
  while ((at = sql.indexOf('lv_src.', at)) >= 0) {
    let i = at + 'lv_src.'.length;
    const open = sql[i];
    let name = '';
    for (i += 1; i < sql.length; i += 1) {
      const ch = sql[i];
      if ((id === 'bigquery' || id === 'clickhouse') && ch === '\\') { name += sql[++i]; continue; }
      if (ch === open) {
        if (sql[i + 1] === open && id !== 'bigquery' && id !== 'clickhouse') { name += ch; i += 1; continue; }
        break;
      }
      name += ch;
    }
    out.push(name);
    at = i;
  }
  return out;
}

async function adversarial(): Promise<void> {
  for (const id of dialects.DIALECT_IDS) {
    const bad: string[] = [];
    for (const v of HOSTILE) bad.push(...leaks(id, v));
    ok(`${id}: ${HOSTILE.length} hostile literals × ${filtersFor('').length} filter forms — values travel only as parameters`, bad.length === 0, bad.slice(0, 4).join(' | '));

    const cols: LiveColumn[] = QUOTED_NAMES.map((n, i) => ({ name: n, type: i % 2 ? 'number' : 'text' }));
    const enc = { category: QUOTED_NAMES[0], values: [{ column: QUOTED_NAMES[1], aggregation: 'sum' as const }] };
    const fs = QUOTED_NAMES.slice(2).map((n) => F(n, 'not_empty'));
    const q = comp.compileChart(adapt(spec.fromVizEncoding(enc, fs, cols, { weekCal: null })), { kind: 'text' }, env(id, TABLE, cols));
    const names = q.ok ? new Set(decodeIdents(id, q.query.sql)) : new Set<string>();
    ok(`${id}: identifiers carrying quotes, backslashes and backticks are escaped and decode back to themselves`,
      QUOTED_NAMES.every((n) => names.has(n)) && names.size === QUOTED_NAMES.length, show([...names]));
  }
  // NEGATIVE CONTROL: a dialect that splices values in as quoted literals.
  const inlining: SqlDialect = { ...duckdbDialect, placeholder: (_i, p) => `'${String(p.value).replace(/'/g, "''")}'` };
  const caught = HOSTILE.filter((v) => leaks(inlining, v).length > 0).length;
  ok('NEGATIVE CONTROL: an inlining dialect is caught for every hostile literal', caught === HOSTILE.length, `${caught}/${HOSTILE.length}`);

  for (const bad of [['re\u0000gion'], [''], []]) {
    const r = comp.compileMetric({ kind: 'metric', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null },
      env('duckdb', { kind: 'table', parts: bad }));
    ok(`a table name ${show(bad)} is refused, typed`, !r.ok && (r.code === 'badIdentifier' || r.code === 'badSource'));
  }
  const nulCol = comp.compileMetric({ kind: 'metric', measures: [{ column: 'a\u0000b', aggregation: 'count' }], filters: [], order: 'natural', weekCal: null },
    env('duckdb', TABLE, [{ name: 'a\u0000b', type: 'text' }]));
  ok('a column name carrying NUL is refused, typed', !nulCol.ok && nulCol.code === 'badIdentifier');
  const nulSql = comp.compileMetric({ kind: 'metric', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null },
    env('duckdb', { kind: 'sql', sql: 'select 1\u0000' }));
  ok('a defining query carrying NUL is refused, typed', !nulSql.ok && nulSql.code === 'badIdentifier');

  // On DuckDB the hostile values RUN: each filter matches exactly what the JS filter matches.
  const vals = HOSTILE.filter((v) => !v.includes('\u0000')).concat(['plain', 'a%b', 'a_b', 'a!b', '']);
  await duck.execAsync('CREATE OR REPLACE TABLE adv (region VARCHAR, amount DOUBLE, order_date DATE, tier DOUBLE, note VARCHAR)');
  const ps: (string | null)[] = [];
  await duck.queryAsync(`INSERT INTO adv VALUES ${vals.map((v) => { ps.push(v, v); return `(CAST($${ps.length - 1} AS VARCHAR), 1, NULL, 1, CAST($${ps.length} AS VARCHAR))`; }).join(', ')}`, ps);
  let wrong = 0;
  for (const v of vals) {
    for (const [f, want] of [
      [F('region', '=', v), vals.filter((x) => x === v).length],
      [F('note', 'contains', v), vals.filter((x) => x.includes(v)).length],
      [F('region', 'in', undefined, { values: [v] }), vals.filter((x) => x === v).length],
    ] as [FilterStep, number][]) {
      const a = spec.fromMetric({ column: 'amount', aggregation: 'count' }, [f], COLS);
      const out = a.ok ? await ev.evaluateLive(a.ir, env('duckdb', { kind: 'table', parts: ['adv'] }), async (q) => {
        const rows = await duck.queryAsync(q.sql, q.params.map((p) => p.value as string | number));
        return rows.map((r) => q.columns.map((c) => r[c]));
      }) : null;
      if (!out || !out.ok || out.kind !== 'metric' || out.value !== want) {
        wrong += 1;
        if (wrong <= 3) ok(`DuckDB runs ${show(f)}`, false, show(out));
      }
    }
  }
  ok(`DuckDB: ${vals.length} hostile values run as =, contains and in, matching the JS filter exactly`, wrong === 0);
}

// ── Refusals ─────────────────────────────────────────────────────────────────

function refusals(): void {
  const t = (r: import('../src/engine/live/liveSpec').LiveRefusal): boolean =>
    r.message.length > 0 && r.message === i18n.t(r.key, r.params) && r.key.startsWith('liveRefusals.');
  const cases: [string, unknown, string][] = [
    ['sum over a text column', spec.fromVizEncoding({ category: 'region', values: [{ column: 'note', aggregation: 'sum' }] }, [], COLS), 'notNumeric'],
    ['avg over a date column (KPI)', spec.fromMetric({ column: 'order_date', aggregation: 'avg' }, [], COLS), 'notNumeric'],
    ['an unknown category', spec.fromVizEncoding({ category: 'nope', values: [{ column: 'amount', aggregation: 'sum' }] }, [], COLS), 'unknownColumn'],
    ['an unknown measure column', spec.fromMetric({ column: 'nope', aggregation: 'sum' }, [], COLS), 'unknownColumn'],
    ['an unknown aggregation', spec.fromMetric({ column: 'amount', aggregation: 'median' }, [], COLS), 'unknownAggregation'],
    ['within_km', spec.fromMetric({ column: 'amount', aggregation: 'sum' }, [F('amount', 'within_km', undefined, { radius: { lngColumn: 'tier', lat: 0, lng: 0, km: 1 } as never })], COLS), 'withinKm'],
    ['contains on a number', spec.fromMetric({ column: 'amount', aggregation: 'sum' }, [F('amount', 'contains', '1')], COLS), 'containsNumber'],
    ['a split by a date', spec.fromVizEncoding({ category: 'region', series: 'order_date', values: [{ column: 'amount', aggregation: 'sum' }] }, [], COLS), 'dateSeries'],
    ['a period on a number column', spec.fromMetric({ column: 'amount', aggregation: 'sum' }, [F('tier', 'period', undefined, { period: { preset: 'ytd' } })], COLS), 'periodNotDate'],
    ['an answer period on text', spec.fromAnswerSpec({ datasetId: 'x', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ column: 'note', period: 'last_year' }], chartType: 'column', title: 't' }, COLS), 'periodNotDate'],
    ['raw points (every measure none)', spec.fromVizEncoding({ category: 'region', values: [{ column: 'amount', aggregation: 'none' }] }, [], COLS), 'raw'],
    ['a pivot', spec.fromVizEncoding({ category: 'region', values: [], pivot: { rows: [], columns: [], values: [] } as never }, [], COLS), 'pivot'],
    ['a map', spec.fromVizEncoding({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }], geo: { level: 'country' } }, [], COLS), 'map'],
    ['a related field', spec.fromVizEncoding({ category: 'region', values: [{ column: 'amount', aggregation: 'sum', datasetId: 'other' }] }, [], COLS), 'related'],
    ['no measure', spec.fromVizEncoding({ category: 'region', values: [] }, [], COLS), 'noMeasure'],
    ['the compile-time gate: sum over text in a hand-built IR',
      comp.compileMetric({ kind: 'metric', measures: [{ column: 'note', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null }, env('duckdb')), 'notNumeric'],
    ['an IR naming an undeclared column',
      comp.compileMetric({ kind: 'metric', measures: [{ column: 'secret_col', aggregation: 'count' }], filters: [], order: 'natural', weekCal: null }, env('duckdb')), 'unknownColumn'],
    ['an unresolved data-relative period',
      comp.compileMetric({ kind: 'metric', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ kind: 'latest', column: 'order_date', period: 'last_month', yearsBack: 0 }], order: 'natural', weekCal: null }, env('duckdb')), 'unresolvedPeriod'],
    ['a top N over a date axis',
      comp.compileChart({ kind: 'chart', category: { column: 'order_date', kind: 'date' }, measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], order: 'value', top: 3, weekCal: null }, { kind: 'date', grain: 'month' }, env('duckdb')), 'rankOnDate'],
  ];
  for (const [label, r, code] of cases) {
    const x = r as import('../src/engine/live/liveSpec').LiveRefusal;
    ok(`refused, typed (${code}): ${label}`, !!x && x.ok === false && x.code === code && t(x), show(x));
  }
  const all: import('../src/engine/live/liveSpec').LiveRefusalCode[] = ['pivot', 'cohort', 'funnel', 'drivers', 'facet', 'map', 'related', 'raw', 'noCategory',
    'noMeasure', 'unknownColumn', 'notNumeric', 'unknownAggregation', 'withinKm', 'containsNumber', 'dateSeries', 'periodNotDate', 'unresolvedPeriod',
    'badIdentifier', 'badSource', 'categoryType', 'rankOnDate', 'rowShape', 'badQuery'];
  ok(`every refusal code (${all.length}) renders its catalog key with its parameters`, all.every((c) => t(spec.refuse(c, 'col'))));

  // What the extract SKIPS with a warning is skipped with the byte-identical warning.
  const w = spec.fromVizEncoding({ category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
    [F('gone', '=', 1), F('region', 'bogus' as FilterStep['op'], 1), F('region', 'in', undefined, { values: [] }), F('order_date', 'period')], COLS);
  ok('skipped filters warn exactly as transforms.stepFilter does', w.ok && show(w.warnings) === show([
    'Filter skipped: unknown column "gone"', 'Filter skipped: unknown operator "bogus"',
    filterOps.emptyListWarning('region', 'in'), filterOps.periodSkipWarning('order_date')]) && w.ir.filters.length === 0, show(w));
}

// ── The pure pieces ──────────────────────────────────────────────────────────

async function pure(): Promise<void> {
  const metricIr = (aggregation: 'sum' | 'avg' | 'min'): LiveIR => ({ kind: 'metric', measures: [{ column: 'amount', aggregation }], filters: [], order: 'natural', weekCal: null });
  const q = (cols: string[]): import('../src/engine/live/compile').CompiledQuery => ({ sql: '', params: [], columns: cols });
  ok('−0 from a warehouse is reported as +0 (an extract stores String(-0) = "0")',
    Object.is(shape.shapeMetric([[-0]], q(['o_m0s']), metricIr('sum')), 0) && Object.is(shape.shapeMetric([[-0]], q(['o_m0n']), metricIr('min')), 0));
  ok('avg is sum ÷ count, divided in our code', shape.shapeMetric([[1, 3]], q(['o_m0s', 'o_m0c']), metricIr('avg')) === 1 / 3);
  ok('avg over no numbers is null, never NaN', shape.shapeMetric([[null, 0]], q(['o_m0s', 'o_m0c']), metricIr('avg')) === null);
  const wide = shape.shapeMetric([[1, 2]], q(['o_m0s']), metricIr('sum'));
  ok('a reply of the wrong width is refused, not guessed at', !!wide && typeof wide === 'object' && wide.code === 'rowShape');
  ok('numbers arrive as numbers, strings or bigints', shape.toNumber('12') === 12 && shape.toNumber(BigInt(7)) === 7 && shape.toNumber('') === null && shape.toNumber('x') === null);
  const chart = shape.shapeChart([['b', -0, 1, null], ['a', 2, 2, null]], q(['o_g', 'o_m0s', 'o_cr', 'o_nc']),
    { kind: 'chart', category: { column: 'region', kind: 'text' }, measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null }, { kind: 'text' }, COLS);
  ok('a chart keeps the statement order and names the series like vizData.measureLabel', !('code' in chart) && show(chart.data) === '{"labels":["b","a"],"series":[{"name":"sum of amount","values":[0,2]}]}', show(chart));
  const bins = shape.readBinRange([[-0, 10]], q(['o_lo', 'o_hi']), 5);
  ok('the bin probe goes through binPlan (−0 read as 0)', show(bins) === '{"kind":"bins","lo":0,"hi":10,"width":2,"bins":5}', show(bins));
  ok('the grain probe goes through chooseGrain (an unreadable count coarsens)', shape.readGrain([[400, null, 30, 10, 3]], q(['a', 'b', 'c', 'd', 'e'])) === 'month');

  const ir: LiveIR = { kind: 'chart', category: { column: 'region', kind: 'text' }, measures: [{ column: 'amount', aggregation: 'sum' }],
    filters: [{ kind: 'latest', column: 'order_date', period: 'last_quarter', yearsBack: 0 }, { kind: 'latest', column: 'order_date', period: 'last_year', yearsBack: 1 }], order: 'value', weekCal: null };
  const r = ev.resolvePeriods(ir, { order_date: { y: 2024, m: 11, d: 15 } });
  ok('resolvePeriods: the period the DATA\'s latest date falls in, as inclusive ISO days', show(r.ir.filters) === show([
    { kind: 'range', column: 'order_date', from: '2024-10-01', to: '2024-12-31' }, { kind: 'range', column: 'order_date', from: '2023-01-01', to: '2023-12-31' }])
    && show(r.periodLabels) === '["order_date: 2024-Q4","order_date: 2023"]', show(r));
  const none = ev.resolvePeriods(ir, { order_date: null });
  ok('resolvePeriods: no date at all skips the filter with the extract\'s warning', none.ir.filters.length === 0 && none.warnings[0] === filterOps.emptyListWarning('order_date', 'in'));

  const steps = async (i: LiveIR): Promise<string[]> => {
    const seen: string[] = [];
    await ev.evaluateLive(i, env('duckdb'), async (cq, step) => {
      seen.push(step);
      return [cq.columns.map((c) => (c === 'o_l0' ? 20000 : c.startsWith('o_m') || c === 'o_cr' ? 1 : c === 'o_g' ? null : 3))];
    });
    return seen;
  };
  const base: LiveIR = { kind: 'chart', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], order: 'natural', weekCal: null };
  ok('evaluateLive: a text axis is ONE statement', show(await steps({ ...base, category: { column: 'region', kind: 'text' } })) === '["chart"]');
  ok('evaluateLive: bins probe min/max first', show(await steps({ ...base, category: { column: 'amount', kind: 'bins' } })) === '["binRange","chart"]');
  ok('evaluateLive: a date axis with no grain probes the grain', show(await steps({ ...base, category: { column: 'order_date', kind: 'date' } })) === '["grain","chart"]');
  ok('evaluateLive: under a week calendar the warehouse groups by day — no probe',
    show(await steps({ ...base, category: { column: 'order_date', kind: 'date' }, weekCal: { type: '445', yearEnd: 'nearest' } })) === '["chart"]');
  ok('evaluateLive: a data-relative period asks for the latest date first',
    show(await steps({ ...ir })) === '["latest","chart"]');
  const key: LiveKey = { kind: 'bins', lo: 0, hi: 1, width: 0.1, bins: 10 };
  const binned = comp.compileChart({ ...base, category: { column: 'amount', kind: 'bins' } }, key, env('duckdb'));
  ok('bin edges are bound parameters, never text', binned.ok && binned.query.params.some((p) => p.value === 0.1) && !binned.query.sql.includes('0.1'));
}

async function main(): Promise<void> {
  goldenShapes();
  await adversarial();
  refusals();
  await pure();
}

main().catch((e) => ok('live compile suite threw', false, e && (e as Error).stack)).finally(finish);
