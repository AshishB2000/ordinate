// Self-check for the Snowflake semantic-view backend (semantic layer part 7, c1;
// docs/live-data/snowflake-semantic-views.md). Pure: no account, no network, no DuckDB.
//
//   § encode   every question the plan asks (SHAPES) as ONE `SELECT … FROM SEMANTIC_VIEW(…)` statement: decoded back
//              to the same question by a parser of exactly that grammar (./semanticFakeSnowflake.ts), with no filter
//              value in its text (all bound), and pinned by a golden recorded once and never re-recorded; names
//              outside IDENT_RE refused; NEGATIVE CONTROL an inlining encoder fails the value check
//   § listing  the `snowflake` connector's `semantic` (src/connectors/snowflakeSemantic.ts) off SQL-API replies through
//              its transport seam: SHOW SEMANTIC VIEWS → DATABASE.SCHEMA.VIEW names, DESCRIBE SEMANTIC VIEW → typed
//              dimensions and metrics that say whether they add up (additiveExpression), the question through
//              runBound (capped, bound), the catalog flag; a Snowflake error carrying the PAT is redacted everywhere
//
//   npm run build:ts && node scripts/test-semanticSnowflake.js

export {}; // module scope — sibling test scripts share top-level names
import { isDeepStrictEqual } from 'util';
import { ok, finish } from './selfcheck';
import type { LiveColumn, LiveIR } from '../src/engine/live/liveSpec';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const sfSem: typeof import('../src/engine/live/semantic/snowflake') = require('../src/engine/live/semantic/snowflake');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const plan: typeof import('../src/engine/live/semantic/semanticPlan') = require('../src/engine/live/semantic/semanticPlan');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const qc: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const decoder: typeof import('./semanticFakeSnowflake') = require('./semanticFakeSnowflake');
const viewFixture: typeof import('./snowflakeSemanticFixture') = require('./snowflakeSemanticFixture');

const show = (v: unknown): string => JSON.stringify(v);
const GOLDEN = path.join(__dirname, 'fixtures', 'golden', 'semantic-snowflake.json');
const MODEL = 'DB.SALES.ORDERS_SV';

/** The layer's dimensions as a synced dataset declares them; one stored qualified (a name two logical tables share). */
const COLS: LiveColumn[] = [
  { name: 'region', type: 'text' }, { name: 'many', type: 'text' }, { name: 'amt', type: 'number' }, { name: 'tier', type: 'number' },
  { name: 'd', type: 'date' }, { name: 'ORDERS.STATUS', type: 'text' },
];
const METRICS = ['revenue', 'orders', 'avg_amount', 'ORDERS.REVENUE'];
const ENV: SemanticEnv = {
  dataset: 'Orders', layer: 'Snowflake', columns: COLS,
  metrics: new Map(METRICS.map((m) => [m, { additive: m !== 'avg_amount' }])),
  grains: new Map([['d', ck.DATE_GRAINS]]),
  caps: { lookups: true, binaryCompare: false },
};

const chartIr = (over: Partial<LiveIR> = {}): LiveIR =>
  ({ kind: 'chart', measures: [{ metric: 'revenue' }], category: { column: 'region', kind: 'text' }, filters: [], order: 'natural', weekCal: null, ...over });
const KEPT = ['Zanzibar', 'Quokka'];

function charted(ir: LiveIR, env = ENV): NonNullable<ReturnType<typeof plan.planChart>> & { ok: true } {
  const p = plan.planChart(ir, env);
  if (spec.isRefusal(p)) throw new Error(`the plan refused: ${p.code}`);
  return p;
}

/** Every shape of question the plan asks a layer, each from the plan itself. */
function shapes(): Array<[string, SemanticQuery]> {
  const out: Array<[string, SemanticQuery]> = [];
  const text = charted(chartIr());
  out.push(['text axis, top 51', text.ranks], ['"Other", the 50 kept excluded', text.other!(KEPT)]);
  out.push(['text axis, every metric', charted(chartIr({ measures: METRICS.map((metric) => ({ metric })) })).ranks]);
  for (const g of ck.DATE_GRAINS) out.push([`date axis by ${g}`, charted(chartIr({ category: { column: 'd', kind: 'date', grain: g } })).ranks]);
  const split = charted(chartIr({ category: { column: 'many', kind: 'text' }, series: 'region' }));
  out.push(['split: category ranks', split.ranks], ['split: series ranks', split.seriesRanks!], ['split: the kept cells', split.cells!(KEPT)], ['split: "Other" by series', split.other!(KEPT)]);
  out.push(['split by a number', charted(chartIr({ series: 'tier' })).cells!(KEPT)]);
  out.push(['date split', charted(chartIr({ category: { column: 'd', kind: 'date', grain: 'month' }, series: 'region' })).ranks]);
  const kpi = (filters: LiveIR['filters']): SemanticQuery => {
    const p = plan.planMetric({ kind: 'metric', measures: [{ metric: 'avg_amount' }], filters, order: 'natural', weekCal: null }, ENV);
    if (spec.isRefusal(p)) throw new Error(p.code);
    return p.query;
  };
  out.push(['KPI', kpi([])]);
  const FILTERS: Array<[string, LiveIR['filters'][number]]> = [
    ['text =', { kind: 'compare', column: 'region', op: '=', value: 'Zanzibar' }],
    ['text !=', { kind: 'compare', column: 'region', op: '!=', value: 'Zanzibar' }],
    ['text <', { kind: 'compare', column: 'region', op: '<', value: 'Quokka' }],
    ['number >', { kind: 'compare', column: 'amt', op: '>', value: 1234.5 }],
    ['number <=', { kind: 'compare', column: 'amt', op: '<=', value: 77.25 }],
    ['number >=', { kind: 'compare', column: 'tier', op: '>=', value: 3 }],
    ['date >', { kind: 'compare', column: 'd', op: '>', value: '2024-06-30' }],
    ['text in', { kind: 'in', column: 'region', values: ['Zanzibar', 'Quokka'], negate: false }],
    ['text not in', { kind: 'in', column: 'region', values: ['Zanzibar'], negate: true }],
    ['number in', { kind: 'in', column: 'amt', values: [1234.5, 77.25], negate: false }],
    ['contains', { kind: 'contains', column: 'many', value: 'wombat%_!' }],
    ['empty', { kind: 'empty', column: 'region', negate: false }],
    ['not empty', { kind: 'empty', column: 'amt', negate: true }],
    ['range', { kind: 'range', column: 'd', from: '2024-03-31', to: '2024-12-31' }],
    ['range from only', { kind: 'range', column: 'd', from: '2023-02-14' }],
    ['qualified name =', { kind: 'compare', column: 'ORDERS.STATUS', op: '=', value: 'Shipped' }],
  ];
  for (const [name, f] of FILTERS) out.push([`filter ${name}`, kpi([f])]);
  out.push(['two filters, a chart', charted(chartIr({ filters: FILTERS.slice(0, 2).map(([, f]) => f) })).ranks]);
  out.push(['an answer: top 5 by value', charted(chartIr({ order: 'value', top: 5 })).ranks]);
  out.push(['base filters lead the question', charted(chartIr(), { ...ENV, base: [{ kind: 'compare', column: 'tier', op: '=', value: 2 }] }).ranks]);
  out.push(['qualified names: a dimension and a metric', charted(chartIr({ category: { column: 'ORDERS.STATUS', kind: 'text' }, measures: [{ metric: 'ORDERS.REVENUE' }] })).ranks]);
  const latest = plan.planLatest({ ...chartIr(), filters: [{ kind: 'latest', column: 'd', period: 'last_quarter', yearsBack: 0 } as LiveIR['filters'][number]] }, ENV);
  if (spec.isRefusal(latest)) throw new Error(latest.code);
  out.push(['lookup: the latest day', latest.queries[0].query]);
  const values = plan.planValues('many', [], ENV, { limit: 200 });
  const days = plan.planValues('d', [], ENV, { desc: true, limit: 1 });
  if (spec.isRefusal(values) || spec.isRefusal(days)) throw new Error('values refused');
  out.push(['lookup: a dimension\'s values', values], ['lookup: a date\'s values, latest first', days]);
  return out;
}

/** Every filter value a question carries (the empty string and null are in every text, so they say nothing). */
function valuesOf(q: SemanticQuery): Array<string | number> {
  const out: Array<string | number> = [];
  const add = (v: unknown): void => { if ((typeof v === 'string' && v !== '') || typeof v === 'number') out.push(v); };
  for (const f of q.where) {
    if (f.kind === 'compare' || f.kind === 'contains') add(f.value);
    if (f.kind === 'in') f.values.forEach(add);
    if (f.kind === 'range') { add(f.from); add(f.to); }
  }
  q.exclude?.values.forEach(add);
  return out;
}
const unbound = (q: SemanticQuery, sql: string): Array<string | number> => valuesOf(q).filter((v) => sql.includes(String(v)));

const throwsWith = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (err) {
    return re.test(err instanceof Error ? err.message : String(err));
  }
};

function encodeSection(): void {
  const SHAPES = shapes();
  const enc = (q: SemanticQuery, model = MODEL) => sfSem.snowflakeAdapter.encode(q, model, COLS);
  for (const [name, q] of SHAPES) {
    const req = enc(q);
    const body = req.body as { sql: string; params: import('../src/connectors/types').LiveParam[] };
    let back: ReturnType<typeof decoder.decodeSnowflake> | null = null;
    try {
      back = decoder.decodeSnowflake(body.sql, body.params, COLS);
    } catch (err) {
      ok(`${name}: decodes`, false, `${err instanceof Error ? err.message : String(err)}\n${body.sql}`);
      continue;
    }
    ok(`${name}: decodes back to the same question, on the same view`, back.model === MODEL && isDeepStrictEqual(back.query, q), show({ back, q }));
    ok(`${name}: no filter value in the SQL text`, unbound(q, body.sql).length === 0, show(unbound(q, body.sql)));
    ok(`${name}: one kind 'semantic' request, its rows named as the plan reads them`, req.kind === 'semantic' && show(req.columns) === show([...q.dimensions.map((x) => x.name), ...q.metrics]));
  }
  // Recorded once (2026-11-05) and read by hand; never re-recorded to make this pass.
  ok('the golden requests are unchanged (never re-recorded)', qc.stableStringify(SHAPES.map(([n, q]) => [n, enc(q).body])) === fs.readFileSync(GOLDEN, 'utf8'));

  const [, q] = SHAPES[0];
  ok('a view name part outside IDENT_RE is refused', throwsWith(() => enc(q, 'DB.SALES."x";drop'), /semantic view/));
  ok('…a view name that is not DATABASE.SCHEMA.VIEW is refused', throwsWith(() => enc(q, 'ORDERS_SV'), /semantic view/) && throwsWith(() => enc(q, 'A.B.C.D'), /semantic view/));
  ok('a dimension name outside IDENT_RE is refused', throwsWith(() => sfSem.snowflakeAdapter.encode({ ...q, dimensions: [{ name: 'x"y' }] }, MODEL, [...COLS, { name: 'x"y', type: 'text' }]), /name/));
  ok('a metric name outside IDENT_RE is refused', throwsWith(() => enc({ ...q, metrics: ['rev enue'] }), /name/));
  ok('a dimension the dataset does not declare is refused', throwsWith(() => enc({ ...q, dimensions: [{ name: 'nope' }] }), /nope/));
  ok('a member asked twice is refused (its rows could not be told apart)', throwsWith(() => enc({ ...q, metrics: ['revenue', 'revenue'] }), /twice/));
  ok('a date dimension with no grain is refused', throwsWith(() => enc({ ...q, dimensions: [{ name: 'd' }] }), /grain/));
  ok('a limit that is not a whole number is refused', throwsWith(() => enc({ ...q, limit: 1.5 }), /limit/));

  // An encoder that writes a value into the text instead of binding it: the value check finds it.
  const Q = SHAPES.find(([n]) => n === 'filter text =')![1];
  const inlining = (x: SemanticQuery): string => {
    const r = enc(x).body as { sql: string; params: Array<{ value: unknown }> };
    let i = 0;
    return r.sql.replace(/\?/g, () => `'${String(r.params[i++]?.value)}'`);
  };
  ok('NEGATIVE CONTROL: an encoder that inlines a value fails the value check', unbound(Q, inlining(Q)).length > 0);

  ok('the Snowflake encoder is a shipped backend', adapters.adapterFor('snowflake') === sfSem.snowflakeAdapter);
  ok('…so no test may register another for it', throwsWith(() => adapters.registerTestSemanticAdapter('snowflake', sfSem.snowflakeAdapter), /shipped/));
  ok('the owner\'s view script is what the fixture writes (scripts/fixtures/snowflake-semantic-view.sql)',
    fs.readFileSync(path.join(__dirname, 'fixtures', 'snowflake-semantic-view.sql'), 'utf8') === viewFixture.semanticViewSql());
}

// ── § listing ──

const PAT = `ver:1-hint:777-${'k'.repeat(8)}${Date.now().toString(36)}SECRETPAT`;
const CTX = (values: Record<string, unknown> = {}): import('../src/connectors/types').ConnectorContext => ({
  values: { account: 'myorg-acct', user: 'ORDINATE', auth: 'pat', warehouse: 'WH', role: 'ORDINATE_READER', database: 'SALES', ...values },
  secrets: { token: PAT }, rowLimit: 100_000, timeoutMs: 5_000,
});

async function listingSection(): Promise<void> {
  const sf: typeof import('../src/connectors/snowflake') = require('../src/connectors/snowflake');
  const sem: typeof import('../src/connectors/snowflakeSemantic') = require('../src/connectors/snowflakeSemantic');
  const registry: typeof import('../src/connectors') = require('../src/connectors');
  const { FakeSnowflake }: typeof import('./snowflakeFake') = require('./snowflakeFake');
  const def = registry.getConnector('snowflake')!;
  const layer = def.semantic!;
  ok('the Snowflake connector has the semantic capability, on its own entry: backend snowflake, lookups, no byte-exact compare yet',
    !!layer && layer.backend === 'snowflake' && layer.caps.lookups === true && layer.caps.binaryCompare === false && registry.listConnectors().filter((d) => d.family === 'snowflake').length === 1);
  ok('connectorCatalog() marks Snowflake semantic: true', registry.connectorCatalog().find((c) => c.id === 'snowflake')?.semantic === true);

  const fake = new FakeSnowflake();
  sf.setTransport(fake.transport);
  const views: import('./semanticFakeSnowflake').FakeView[] = [
    { name: 'SALES.PUBLIC.ORDERS_SV', comment: 'Every order', table: 't', columns: [], metrics: {}, describe: [
      ['TABLE', 'ORDERS', null, 'BASE_TABLE_NAME', 'ORDERS'],
      ['DIMENSION', 'REGION', 'ORDERS', 'DATA_TYPE', 'VARCHAR(25)'],
      ['DIMENSION', 'AMOUNT', 'ORDERS', 'DATA_TYPE', 'NUMBER(12,2)'],
      ['DIMENSION', 'ORDER_DATE', 'ORDERS', 'DATA_TYPE', 'DATE'],
      ['DIMENSION', 'SHIPPED_AT', 'ORDERS', 'DATA_TYPE', 'TIMESTAMP_NTZ(9)'],
      ['DIMENSION', 'NAME', 'ORDERS', 'DATA_TYPE', 'VARCHAR'],
      ['DIMENSION', 'NAME', 'CUSTOMERS', 'DATA_TYPE', 'VARCHAR'],
      ['DIMENSION', 'secret note', 'ORDERS', 'DATA_TYPE', 'VARCHAR'],
      ['METRIC', 'REVENUE', 'ORDERS', 'EXPRESSION', 'SUM(orders.amount)'],
      ['METRIC', 'REVENUE', 'ORDERS', 'DATA_TYPE', 'NUMBER(38,2)'],
      ['METRIC', 'REVENUE', 'ORDERS', 'COMMENT', 'Gross sales'],
      ['METRIC', 'ORDER_COUNT', 'ORDERS', 'EXPRESSION', 'count(orders.order_id)'],
      ['METRIC', 'AVG_ORDER', 'ORDERS', 'EXPRESSION', 'AVG(orders.amount)'],
      ['METRIC', 'MARGIN', 'ORDERS', 'EXPRESSION', 'SUM(orders.profit) / SUM(orders.amount)'],
      ['METRIC', 'HIDDEN', 'ORDERS', 'EXPRESSION', 'SUM(orders.cost)'],
      ['METRIC', 'HIDDEN', 'ORDERS', 'ACCESS_MODIFIER', 'PRIVATE'],
      ['DERIVED_METRIC', 'REVENUE_PER_ORDER', null, 'EXPRESSION', 'orders.revenue / orders.order_count'],
    ] },
    { name: 'SALES.PUBLIC.CUSTOMERS_SV', table: 't', columns: [], metrics: {} },
    { name: 'SALES.PUBLIC.bad name', table: 't', columns: [], metrics: {} },
  ];
  fake.answer = semAnswer(views);
  const listed = await layer.listModels(CTX());
  ok('SHOW SEMANTIC VIEWS IN DATABASE (the session\'s: no name interpolated) lists DATABASE.SCHEMA.VIEW names, labelled by the view',
    listed.ok && show(listed.models) === show([{ name: 'SALES.PUBLIC.ORDERS_SV', label: 'ORDERS_SV', description: 'Every order' }, { name: 'SALES.PUBLIC.CUSTOMERS_SV', label: 'CUSTOMERS_SV' }])
      && fake.statements().at(-1) === 'SHOW SEMANTIC VIEWS IN DATABASE LIMIT 1000', show([listed, fake.statements()]));
  ok('…a view whose name is not plain identifiers is not listed (it could not be quoted safely)', listed.ok && !listed.models.some((m) => m.name.includes('bad')));
  await layer.listModels(CTX({ database: '' }));
  ok('…without a database on the connection, the account\'s', fake.statements().at(-1) === 'SHOW SEMANTIC VIEWS IN ACCOUNT LIMIT 1000');

  const d = await layer.describeModel(CTX(), 'SALES.PUBLIC.ORDERS_SV');
  ok('DESCRIBE SEMANTIC VIEW, the name quoted part by part', fake.statements().at(-1) === 'DESCRIBE SEMANTIC VIEW "SALES"."PUBLIC"."ORDERS_SV"', fake.statements().at(-1));
  const all: string[] = ['day', 'week', 'month', 'quarter', 'year'];
  ok('…dimensions typed through the Live mapping, a date or timestamp at every grain, a shared name qualified by its table, a name that is no identifier left out',
    d.ok && show(d.dimensions) === show([
      { name: 'REGION', type: 'text' }, { name: 'AMOUNT', type: 'number' }, { name: 'ORDER_DATE', type: 'date', grains: all },
      { name: 'SHIPPED_AT', type: 'date', grains: all }, { name: 'ORDERS.NAME', type: 'text' }, { name: 'CUSTOMERS.NAME', type: 'text' },
    ]), show(d));
  ok('…metrics say whether they add up (SUM, COUNT yes; AVG, a ratio, a derived metric no), a private one is left out, a comment is the description',
    d.ok && show(d.metrics) === show([
      { name: 'REVENUE', additive: true, description: 'Gross sales' }, { name: 'ORDER_COUNT', additive: true }, { name: 'AVG_ORDER', additive: false },
      { name: 'MARGIN', additive: false }, { name: 'REVENUE_PER_ORDER', additive: false },
    ]), show(d));
  const n = fake.statements().length;
  const badName = await layer.describeModel(CTX(), 'SALES.PUBLIC."x"');
  ok('a model name that is not DATABASE.SCHEMA.VIEW is refused before any statement', !badName.ok && fake.statements().length === n, show(badName));

  // D16 fails safe: only one SUM or COUNT around an argument, nothing outside it, no DISTINCT, no nested aggregate.
  const ADDS: Array<[string, boolean]> = [
    ['SUM(amount)', true], ['count(order_id)', true], ['COUNT(*)', true], ['sum( orders.amount * orders.qty )', true], ['SUM(IFF(x > 0, x, 0))', true],
    ['SUM(a)/SUM(b)', false], ['AVG(a)', false], ['COUNT(DISTINCT a)', false], ['count( distinct a)', false], ['SUM(a) + 1', false], ['MAX(a)', false],
    ['SUM(AVG(a))', false], ['SUM(a) OVER (PARTITION BY b)', false], ['1 + SUM(a)', false], ['', false], ['SUM(a', false], ['SUM(\'(\')', true],
  ];
  const wrong = ADDS.filter(([e, want]) => sem.additiveExpression(e) !== want);
  ok(`additiveExpression: ${ADDS.length} expressions read as the rule says`, wrong.length === 0, show(wrong));

  // The question goes out through runBound: capped, bound, one statement.
  fake.answer = () => sqlApiResult([['region', 'text'], ['revenue', 'real']], [['East', '12.5']]);
  const q = shapes().find(([name]) => name === 'filter text =')![1];
  const req = sfSem.snowflakeAdapter.encode(q, 'SALES.PUBLIC.ORDERS_SV', COLS);
  const ran = await layer.run(CTX(), req.body);
  const sent = fake.of('submit').at(-1)?.json as { statement?: string; bindings?: Record<string, { type: string; value: string }> } | undefined;
  ok('run: the encoder\'s statement inside the row cap, its value a TEXT binding, never text',
    ran.ok && String(sent?.statement).startsWith('select * from (\nSELECT ') && String(sent?.statement).endsWith('\n) limit 100001')
      && show(sent?.bindings) === show({ 1: { type: 'TEXT', value: 'Zanzibar' } }) && !String(sent?.statement).includes('Zanzibar'), show(sent));
  const notOurs = await layer.run(CTX(), { sql: 'select 1' });
  ok('run: a body that is not { sql, params } is refused before any statement', !notOurs.ok);

  // The secret canary: Snowflake's error text carrying the PAT never comes back with it.
  fake.answer = semAnswer(views, () => sqlApiFailure(`Insufficient privileges for token ${PAT} on semantic view`));
  const errors = [await layer.listModels(CTX()), await layer.describeModel(CTX(), 'SALES.PUBLIC.ORDERS_SV'), await layer.run(CTX(), req.body)];
  ok('a Snowflake error carrying the PAT: listing, describing and asking each fail, the token redacted',
    errors.every((e) => !e.ok && e.error.includes('Insufficient privileges') && !e.error.includes(PAT)), show(errors));
  const sentBack = (await fake.answer({ body: '{}' } as never, 'submit')).body;
  ok('NEGATIVE CONTROL: the planted token is in the reply Snowflake sent, so the check above can fail', sentBack.includes(PAT));
  sf.setTransport(null);
}

const { semanticAnswer: semAnswer, sqlApiResult, sqlApiFailure } = decoder;

void (async () => {
  try {
    encodeSection();
    await listingSection();
  } catch (err) {
    ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err));
  }
  finish();
})();
