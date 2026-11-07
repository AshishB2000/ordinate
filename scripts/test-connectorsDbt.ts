// Self-check for the dbt Semantic Layer connector, BETA (semantic layer part 7, d1; src/connectors/dbt.ts,
// docs/live-data/dbt-semantic-layer.md). No network: every request goes to the fake API (scripts/semanticFakeDbt.ts,
// through `setTransport`), answered from the documented reply fixtures (scripts/fixtures/dbt-sl/) or, for questions,
// from a DuckDB table in the documented shapes.
//
//   § registry   one `dbt-semantic-layer` entry: family dbt, the Semantic layers group, labelled beta; fields region /
//                environment ID / service token (secret); the three hosts; the semantic capability
//   § catalog    off the documented fixtures: saved queries listed, one described (categorical → text, time → date at
//                its grains, an entity and a date part left out), additive only for a SIMPLE metric whose one measure
//                is SUM or COUNT with no non-additive dimension; and when the SDK's measures query is unknown, or the
//                API refuses nonAdditiveDimension (today's), nothing is additive
//   § questions  create, then poll (RUNNING twice, then SUCCESSFUL) off the fixtures, the saved query's own filter sent
//                verbatim beside Ordinate's; FAILED and GraphQL errors as errors; pages to the row cap; columns in any
//                case; a saved query changed in dbt refused before anything is asked
//   § abort      the caller's signal stops the polling at once (Cancelled, no further poll) and one cancelQuery goes
//                out; the timeout and a failed poll too
//   § network    a region, environment or host off the list refused before any request; the token only in the header
//
//   npm run build:ts && node scripts/test-connectorsDbt.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { ConnectorContext } from '../src/connectors/types';
import type { DbtBody } from '../src/connectors/dbtWire';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dbtconn-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(path.join(tmp, 'data'));

const registry: typeof import('../src/connectors') = require('../src/connectors');
const fakeDbt: typeof import('./semanticFakeDbt') = require('./semanticFakeDbt');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

const show = (v: unknown): string => JSON.stringify(v);
const TOKEN = `dbtc_${Date.now().toString(36)}_service_token_canary`;
const ENV = 918273;
const fixture = (name: string): unknown => (JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dbt-sl', `${name}.json`), 'utf8')) as { reply: unknown }).reply;
const COLUMNS = fakeDbt.asDbtTypes(fx.COLUMNS);
const ctxOf = (over: Partial<ConnectorContext> = {}, values: Record<string, unknown> = {}, token = TOKEN): ConnectorContext =>
  ({ values: { region: 'north-america', environmentId: String(ENV), ...values }, secrets: { token }, rowLimit: 100_000, timeoutMs: 5_000, ...over });

async function main(): Promise<void> {
  const def = registry.getConnector('dbt-semantic-layer');
  ok('the registry has one dbt Semantic Layer connector', !!def && registry.listConnectors().filter((d) => d.family === 'dbt').length === 1);
  if (!def) return;
  const dbt: typeof import('../src/connectors/dbt') = require('../src/connectors/dbt');
  const layer = def.semantic!;

  // ── § registry ──
  ok('…in the Semantic layers group, labelled beta in its name and its blurb', def.category === 'Semantic layers' && def.label === 'dbt Semantic Layer (beta)'
    && def.blurb === 'Beta: not yet checked against a live dbt Cloud account.');
  ok('…its fields: the region, the environment ID, and one secret (the service token)', show(def.fields.map((f) => [f.key, f.type, f.secret === true])) === show([['region', 'select', false], ['environmentId', 'text', false], ['token', 'password', true]]));
  ok('…the region offers the three documented multi-tenant hosts, and `hosts` declares exactly them',
    show(def.fields[0].options?.map((o) => o.value)) === '["north-america","emea","apac"]'
      && show(def.hosts) === show(['semantic-layer.cloud.getdbt.com', 'semantic-layer.emea.dbt.com', 'semantic-layer.au.dbt.com']));
  ok('…the semantic capability: backend dbt, lookups, no byte-exact compare (restricted viewers refused)', layer.backend === 'dbt' && layer.caps.lookups && !layer.caps.binaryCompare);
  const entry = registry.connectorCatalog().find((c) => c.id === 'dbt-semantic-layer');
  ok('…and the catalog says so, with the hosts and no secret', entry?.semantic === true && show(entry?.hosts) === show(def.hosts) && !show(entry).includes(TOKEN));

  await fx.loadWarehouse('dbt_conn_fixture', fx.COLUMNS, fx.fixtureRows());
  const fake = fakeDbt.startFakeDbt({ token: TOKEN, environmentId: ENV, models: [{ name: 'orders', label: 'Orders', description: 'Every order', table: 'dbt_conn_fixture', columns: COLUMNS }] });
  dbt.setTransport(fake.transport);
  const ctx = ctxOf();

  // ── § catalog, off the documented fixtures ──
  const answers: Record<string, unknown> = { savedQueries: fixture('savedQueriesPaginated'), savedQuery: fixture('savedQuery'), dimensions: fixture('dimensionsPaginated'), metrics: fixture('metricsPaginated') };
  const measure = fixture('measures') as { data: { measures: Array<{ name: string; agg: string }> } };
  fake.hook = (op, v) => {
    if (op === 'measures') {
      const name = (v.metrics as Array<{ name: string }>)[0].name;
      return { status: 200, json: name === 'order_total' ? measure : { data: { measures: [{ ...measure.data.measures[0], name, agg: 'COUNT_DISTINCT' }] } } };
    }
    return answers[op] ? { status: 200, json: answers[op] } : undefined;
  };
  const listed = await layer.listModels(ctx);
  ok('savedQueriesPaginated → models: each saved query, labelled and described', listed.ok && show(listed.models) === show([{ name: 'new_customer_orders', label: 'New customer orders', description: 'Orders from new customers, by day' }, { name: 'order_metrics' }]), show(listed));
  ok('…asked with the environment as a number, the token as Bearer, one fixed document', fake.requests.at(-1)?.op === 'savedQueries' && fake.requests.at(-1)?.variables.environmentId === ENV && fake.requests.at(-1)?.auth === `Bearer ${TOKEN}`);
  const n0 = fake.requests.length;
  const d = await layer.describeModel(ctx, 'new_customer_orders');
  ok('describe: categorical → text, time → date at its grains; an entity and a date part left out',
    d.ok && show(d.dimensions) === show([{ name: 'metric_time', type: 'date', grains: ['day', 'week', 'month', 'quarter', 'year'] }, { name: 'customer__customer_type', type: 'text' }]), show(d));
  ok('describe: additive only for a SIMPLE metric whose one measure is SUM (order_total); a COUNT_DISTINCT and a DERIVED metric are not',
    d.ok && show(d.metrics) === show([{ name: 'order_total', additive: true, description: 'Sum of the order total' }, { name: 'food_order_amount', additive: false, description: 'Sum of the food in an order' }, { name: 'order_gross_profit', additive: false, description: 'Revenue less cost' }]), show(d));
  ok('…the measures (with their non-additive dimension) asked only for the simple metrics',
    show(fake.requests.slice(n0).map((r) => r.op)) === show(['savedQuery', 'dimensions', 'metrics', 'measures', 'measures']), show(fake.requests.slice(n0).map((r) => r.op)));
  // A semi-additive measure (MetricFlow's non_additive_dimension: a balance) adds up over no time: not additive.
  const semi = (nad: unknown, error?: string) => async () => {
    fake.hook = (op, v) => {
      if (op !== 'measures') return answers[op] ? { status: 200, json: answers[op] } : undefined;
      if (error === 'the fake') return undefined; // the fake's own answer: today's API, refusing the field
      if (error) return { status: 200, json: { errors: [{ message: error }], data: null } };
      const name = (v.metrics as Array<{ name: string }>)[0].name;
      return { status: 200, json: { data: { measures: [{ ...measure.data.measures[0], name, agg: name === 'order_total' ? 'SUM' : 'COUNT_DISTINCT', nonAdditiveDimension: nad }] } } };
    };
    const r = await layer.describeModel(ctx, 'new_customer_orders');
    return r.ok ? r.metrics.find((m) => m.name === 'order_total')?.additive : undefined;
  };
  ok('a SUM measure with a non-additive dimension is not additive', (await semi({ name: 'metric_time' })()) === false);
  ok('NEGATIVE CONTROL: …one whose non-additive dimension is null is', (await semi(null)()) === true);
  ok('…and when dbt fails for another reason, not additive', (await semi(undefined, 'Internal server error')()) === false);
  ok('an API that refuses nonAdditiveDimension (today\'s, per the SDK) cannot say a balance is one: not additive (fail safe)', (await semi(undefined, 'the fake')()) === false);
  fake.hook = null;
  fake.measures = false;
  const noMeasures = await layer.describeModel(ctx, 'orders');
  ok('when the SDK\'s measures query is unknown (a newer API), no metric is additive, and describe still answers', noMeasures.ok && noMeasures.metrics.length === 4 && noMeasures.metrics.every((m) => !m.additive), show(noMeasures));
  fake.measures = true;
  const today = await layer.describeModel(ctx, 'orders');
  ok('the fake saved query on today\'s API (nonAdditiveDimension refused): no metric is additive', today.ok && today.metrics.length === 4 && today.metrics.every((m) => !m.additive), show(today));
  fake.nonAdditive = true;
  const fakeDescribed = await layer.describeModel(ctx, 'orders');
  ok('NEGATIVE CONTROL: …on an API with the field (null): its dimensions as dbt types them, sum and count additive', fakeDescribed.ok && show(fakeDescribed.dimensions.map((x) => [x.name, x.type])) === show(COLUMNS.map((c) => [c.name, c.type]))
    && show(fakeDescribed.metrics.map((m) => [m.name, m.additive])) === show([['revenue', true], ['orders', true], ['avg_amount', false], ['max_amount', false]]), show(fakeDescribed));
  fake.nonAdditive = false;
  ok('describe: a saved query dbt does not list is an error; a name that is no dbt name is refused before any request',
    !(await layer.describeModel(ctx, 'nope')).ok && await (async () => { const n = fake.requests.length; const r = await layer.describeModel(ctx, "x') }}"); return !r.ok && fake.requests.length === n; })());
  const tables = await def.listTables(ctx);
  ok('listTables lists the saved queries (the connection test); the copy path refuses', tables.ok && show(tables.tables) === '[{"name":"orders"}]' && !(await def.run(ctx, 'select 1')).ok);

  // ── § questions, off the documented fixtures ──
  const q: DbtBody = { savedQuery: 'new_customer_orders', metrics: [{ name: 'order_total' }], groupBy: [{ name: 'metric_time', grain: 'DAY' }], where: [{ sql: "{{ TimeDimension('metric_time', 'day') }} >= '2023-08-01'" }], orderBy: [{ groupBy: { name: 'metric_time', grain: 'DAY' }, descending: false }] };
  let polls = 0;
  fake.hook = (op) => {
    if (op === 'savedQuery') return { status: 200, json: fixture('savedQuery') };
    if (op === 'createQuery') return { status: 200, json: fixture('createQuery') };
    if (op === 'query') return { status: 200, json: fixture(polls++ < 2 ? 'query-pending' : 'query-successful') };
    return undefined;
  };
  const n1 = fake.requests.length;
  const answered = await layer.run(ctx, q);
  const sent = fake.requests.slice(n1);
  ok('run: the saved query read, created, polled (RUNNING twice), answered: the documented rows, numbers as numbers',
    answered.ok && show(answered.columns.map((c) => c.name)) === '["metric_time","order_total"]' && show(answered.rows.map((r) => r[1])) === '[3,112,12,5123]'
      && show(sent.map((r) => r.op)) === show(['savedQuery', 'createQuery', 'query', 'query', 'query']), show([answered, sent.map((r) => r.op)]));
  const created = sent.find((r) => r.op === 'createQuery')!.variables;
  ok('…the saved query\'s own filter went verbatim, after Ordinate\'s; the limit is the row cap + 1; every poll the created query',
    show(created.where) === show([...q.where, { sql: "{{ Dimension('customer__customer_type') }} = 'new'" }]) && created.limit === 100_001 && created.environmentId === ENV
      && sent.filter((r) => r.op === 'query').every((r) => r.variables.queryId === 'QueryID_12345678' && r.variables.pageNum === 1), show(created));
  fake.hook = (op) => (op === 'savedQuery' ? { status: 200, json: fixture('savedQuery') } : op === 'createQuery' ? { status: 200, json: fixture('createQuery') } : op === 'query' ? { status: 200, json: fixture('query-failed') } : undefined);
  const failed = await layer.run(ctx, q);
  ok('a FAILED query is an error with dbt\'s words', !failed.ok && /Unable to compile the query/.test(failed.error), show(failed));
  fake.hook = (op) => (op === 'savedQuery' ? { status: 200, json: { data: { savedQuery: { name: 'new_customer_orders', queryParams: { metrics: [{ name: 'food_order_amount' }], groupBy: [{ name: 'metric_time', grain: 'DAY' }], where: null } } } } } : undefined);
  const n2 = fake.requests.length;
  const changed = await layer.run(ctx, q);
  ok('a saved query changed in dbt (order_total gone) is refused before anything is created', !changed.ok && /no longer has order_total/.test(changed.error) && fake.requests.slice(n2).every((r) => r.op === 'savedQuery'), show(changed));
  fake.hook = (op) => (op === 'savedQueries' ? { status: 200, json: { ...(fixture('errors') as object), errors: [{ message: `User is not authorized (token ${TOKEN})` }] } } : undefined);
  const refused = await layer.listModels(ctx);
  ok('a GraphQL error is an error with its words, the token redacted', !refused.ok && /not authorized/.test(refused.error) && !refused.error.includes(TOKEN), show(refused));
  fake.hook = null;

  // Questions on the fake's table: pages, the cap, column case.
  const cat: DbtBody = { savedQuery: 'orders', metrics: [{ name: 'revenue' }], groupBy: [{ name: 'many' }], where: [], orderBy: [{ groupBy: { name: 'many' }, descending: false }] };
  fake.pageSize = 7;
  const paged = await layer.run(ctx, cat);
  ok('pages 2…totalPages are fetched in order: 60 categories in 9 pages of 7', paged.ok && paged.rows.length === 60 && !paged.truncated && fake.requests.filter((r) => r.op === 'query').slice(-9).map((r) => r.variables.pageNum).join() === '1,2,3,4,5,6,7,8,9', show(paged.ok ? paged.rows.length : paged));
  const capped = await layer.run(ctxOf({ rowLimit: 20 }), cat);
  ok('…and stop past the row cap: truncated (the door\'s tooManyGroups)', capped.ok && capped.truncated === true && capped.rows.length === 20);
  fake.pageSize = 1024;
  fake.upper = true;
  const upper = await layer.run(ctx, cat);
  ok('a reply whose columns come back upper-cased is read by name', upper.ok && show(upper) === show(paged));
  fake.upper = false;

  // ── § abort and timeout ──
  fake.waits = 1_000;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  const aborted = await layer.run(ctxOf({ signal: ac.signal, timeoutMs: 20_000 }), cat);
  const pollsAtAbort = fake.ops('query');
  await new Promise((r) => setTimeout(r, 600));
  ok('the signal stops the polling: Cancelled, promptly, and no poll after it', !aborted.ok && aborted.error === 'Cancelled' && Date.now() - t0 < 2_000 && fake.ops('query') === pollsAtAbort, show(aborted));
  ok('…and one cancelQuery goes out for the created query', fake.ops('cancelQuery') === 1 && /^QueryID_/.test(String(fake.requests.find((r) => r.op === 'cancelQuery')?.variables.queryId)));
  const t1 = Date.now();
  const timedOut = await layer.run(ctxOf({ timeoutMs: 700 }), cat);
  await new Promise((r) => setTimeout(r, 50));
  ok('…the timeout does too, across polls, and cancels', !timedOut.ok && /timed out/i.test(timedOut.error) && Date.now() - t1 < 3_000 && fake.ops('cancelQuery') === 2, show(timedOut));
  fake.waits = 0;
  fake.hook = (op) => (op === 'query' ? { status: 502, json: { errors: [{ message: 'Bad gateway' }] } } : undefined);
  const badPoll = await layer.run(ctx, cat);
  await new Promise((r) => setTimeout(r, 50));
  fake.hook = null;
  ok('…a poll that fails (HTTP 502) is an error, and the created query is cancelled too', !badPoll.ok && /502/.test(badPoll.error) && fake.ops('cancelQuery') === 3, show([badPoll, fake.ops('cancelQuery')]));

  // ── § network ──
  const n3 = fake.requests.length;
  const offList = await Promise.all([layer.listModels(ctxOf({}, { region: 'mars' })), layer.listModels(ctxOf({}, { region: '__proto__' })), layer.listModels(ctxOf({}, { environmentId: '12a' })), layer.listModels(ctxOf({}, { environmentId: '' })), layer.listModels(ctxOf({}, {}, ''))]);
  ok('an unknown region, an environment ID that is no number, no token: each refused before any request', offList.every((r) => !r.ok) && fake.requests.length === n3, show(offList));
  const sendRefused = async (url: string): Promise<boolean> => {
    try {
      await dbt.send({ url: new URL(url), method: 'POST', timeoutMs: 1_000 });
      return false;
    } catch (err) {
      return /not a host this source declares/.test(String(err));
    }
  };
  ok('the request door refuses a host off the list, and plain http to one on it, before the transport',
    await sendRefused('https://evil.example.com/api/graphql') && await sendRefused('https://semantic-layer.cloud.getdbt.com.evil.example/api/graphql') && await sendRefused('http://semantic-layer.cloud.getdbt.com/api/graphql') && fake.requests.length === n3);
  ok('NEGATIVE CONTROL: a declared host reaches the transport', (await dbt.send({ url: new URL('https://semantic-layer.cloud.getdbt.com/api/graphql'), method: 'POST', body: '{}', timeoutMs: 1_000 })).status === 401 && fake.requests.length === n3 + 1);
  const emea = fakeDbt.startFakeDbt({ token: TOKEN, environmentId: ENV, host: 'semantic-layer.emea.dbt.com', models: [] });
  dbt.setTransport(emea.transport);
  ok('the EMEA region asks its own host', (await layer.listModels(ctxOf({}, { region: 'emea' }))).ok && emea.requests[0]?.url === 'https://semantic-layer.emea.dbt.com/api/graphql');
  dbt.setTransport(null);
  const env = process.env.ORDINATE_ENV;
  process.env.ORDINATE_ENV = 'prod';
  let refusedInProd = false;
  try { dbt.setTransport(fake.transport); } catch { refusedInProd = true; }
  if (env === undefined) delete process.env.ORDINATE_ENV; else process.env.ORDINATE_ENV = env;
  dbt.setTransport(null);
  ok('a test transport cannot be set under ORDINATE_ENV=prod', refusedInProd);
  ok('the token went only in the Authorization header: in no URL and no variable of any request', fake.requests.every((r) => !r.url.includes(TOKEN) && !show(r.variables).includes(TOKEN)) && fake.requests.some((r) => r.auth === `Bearer ${TOKEN}`));
}

void context.runInContext({ user: { email: 'dbt@ordinate.invalid', role: 'admin' as const }, org: { id: 'dbtconn' } }, `dbt-conn-${process.pid}`, main)
  .catch((err: unknown) => ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err)))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
