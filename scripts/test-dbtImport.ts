// The dbt import (semantic layer part 7, f1; docs/semantic-layer/07-portability.md D10), over scripts/fixtures/dbt/.
//
// § translate  translateDbt turns dbt's semantic manifest into a2's model files shape: the plain aggregations, a
//              distinct count, filters, a ratio and a derived metric, a balance as a snapshot, the time dimension as
//              the date, a primary entity as the key, dimensions as field docs. Every metric the manifest holds is
//              either translated or named in `skipped` with its reason; nothing is guessed.
// § filters    parseDbtWhere's closed grammar: each shape it reads, exactly; everything else refused (null).
// § datasets   a semantic model's dataset: the person's map, then the exact name, then a case- and underscore-blind
//              one (marked); none is ever made up.
// § upload     readDbtUpload: a file over the value budget or 32 MiB is refused with the sentence; content decides.
//
//   npm run build:ts && node scripts/test-dbtImport.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { ParsedColumn } from '../src/data/parse';
import type { ModelMetric } from '../src/app/modelFormat';
import type { ParsedModel } from '../src/app/modelRead';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');
const { translateDbt }: typeof import('../src/app/dbtImport') = require('../src/app/dbtImport');
const { parseDbtWhere }: typeof import('../src/app/dbtFilter') = require('../src/app/dbtFilter');
const { readDbtUpload }: typeof import('../src/app/dbtRead') = require('../src/app/dbtRead');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const { isValidId }: typeof import('../src/app/ids') = require('../src/app/ids');
const msg: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');
const { formatFor }: typeof import('../src/analysis/metricAuto') = require('../src/analysis/metricAuto');

type Json = Record<string, any>; // any: a dbt manifest, edited as a test would edit one

const DIR = path.join(__dirname, 'fixtures', 'dbt');
const MANIFEST: Json = JSON.parse(fs.readFileSync(path.join(DIR, 'semantic_manifest.json'), 'utf8'));
const copy = (): Json => JSON.parse(JSON.stringify(MANIFEST));

const ORDERS_COLUMNS: ParsedColumn[] = [
  { name: 'id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' },
  { name: 'status', type: 'text' }, { name: 'order_date', type: 'date' }, { name: 'stock_date', type: 'date' }, { name: 'units', type: 'number' },
];
const VISITS_COLUMNS: ParsedColumn[] = [{ name: 'visit_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'visit_date', type: 'date' }];
const ORDERS = '0d000000-0000-4000-8000-000000000001';
const VISITS = '0d000000-0000-4000-8000-000000000002';
const OTHER = '0d000000-0000-4000-8000-000000000003';
const DATASETS = [
  { id: ORDERS, name: 'Orders', columns: ORDERS_COLUMNS },
  { id: VISITS, name: 'visits', columns: VISITS_COLUMNS },
  { id: OTHER, name: 'Orders archive', columns: ORDERS_COLUMNS },
];

const metricNamed = (model: ParsedModel, name: string): ModelMetric => model.metrics.find((m) => m.name === name) as ModelMetric;
const allMetricNames = (manifest: Json): string[] => (manifest.metrics as Json[]).map((m) => m.label ?? m.name);
const eq = (column: string, value: unknown) => ({ type: 'filter', column, op: '=', value });
const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 600) ?? String(v);

(async () => {
  // ── § translate ────────────────────────────────────────────────────────────
  const { model, skipped } = translateDbt(MANIFEST, DATASETS, {});
  const m = (n: string): ModelMetric => metricNamed(model, n);
  ok('a simple sum', isDeepStrictEqual(m('Revenue')?.definition, { column: 'amount', aggregation: 'sum' }), show(m('Revenue')));
  ok('count, min and max', m('Orders')?.definition && isDeepStrictEqual(m('Orders').definition, { column: 'id', aggregation: 'count' })
    && isDeepStrictEqual(m('Smallest order')?.definition, { column: 'amount', aggregation: 'min' }) && isDeepStrictEqual(m('Largest order')?.definition, { column: 'amount', aggregation: 'max' }));
  ok('average becomes avg', (m('Avg order')?.definition as { aggregation?: string })?.aggregation === 'avg');
  ok('count_distinct becomes countd', isDeepStrictEqual(m('Customers')?.definition, { column: 'customer_id', aggregation: 'countd' }));
  ok('agg_time_dimension becomes timeColumn (the model default)', m('Revenue')?.timeColumn === 'order_date');
  ok('a measure\'s own agg_time_dimension wins', m('Stock')?.timeColumn === 'stock_date');
  ok('a non-additive balance becomes a snapshot', isDeepStrictEqual((m('Stock')?.definition as { snapshot?: unknown })?.snapshot, { column: 'stock_date', take: 'last' }), show(m('Stock')));
  ok('a filtered metric gets filter steps', isDeepStrictEqual(m('EU revenue')?.filters, [eq('region', 'EU')]), show(m('EU revenue')?.filters));
  ok('!= keeps SQL\'s NULL rule: not empty, then !=', isDeepStrictEqual(m('Not refunded')?.filters, [{ type: 'filter', column: 'status', op: 'not_empty' }, { type: 'filter', column: 'status', op: '!=', value: 'refunded' }]), show(m('Not refunded')?.filters));
  ok('IN becomes in', isDeepStrictEqual(m('EU and US revenue')?.filters, [{ type: 'filter', column: 'region', op: 'in', values: ['EU', 'US'] }]), show(m('EU and US revenue')?.filters));
  ok('a number comparison and two filters joined by AND', isDeepStrictEqual(m('Bulk revenue')?.filters, [{ type: 'filter', column: 'units', op: '>=', value: 5 }, eq('status', 'paid')]), show(m('Bulk revenue')?.filters));
  ok('an unfiltered metric carries no filters key', m('Revenue') && !('filters' in m('Revenue')));
  ok('ratio and derived become formulas', (m('AOV')?.definition as { formula?: string })?.formula === '[Revenue] / [Orders]' && (m('Net')?.definition as { formula?: string })?.formula === '([Revenue] - [Refunds])', show([m('AOV'), m('Net')]));
  ok('a formula is on its inputs\' dataset and counts by their date', m('AOV')?.dataset === ORDERS && m('AOV')?.timeColumn === 'order_date' && m('Net')?.timeColumn === 'order_date');
  ok('a second semantic model\'s metric is on its dataset', m('Visits')?.dataset === VISITS && m('Visits')?.timeColumn === 'visit_date');
  ok('label is the name; the description travels', m('Revenue')?.description === 'Order amounts, refunds included' && !!m('Avg order') && !m('revenue'));
  ok('importedFrom carries the dbt name', isDeepStrictEqual(m('Revenue')?.importedFrom, { kind: 'dbt', name: 'revenue' }) && m('AOV')?.importedFrom?.name === 'aov');
  ok('the format is the editor\'s default for its column (formatFor), a formula\'s two decimals', isDeepStrictEqual(m('Orders')?.format, formatFor('id', 'count')) && isDeepStrictEqual(m('Avg order')?.format, formatFor('amount', 'avg')) && isDeepStrictEqual(m('AOV')?.format, { kind: 'number', decimals: 2, compact: false }), show([m('Orders')?.format, m('Avg order')?.format]));

  const SKIPS: Array<[string, string, string?]> = [
    ['Stock by customer', 'window_groupings'], ['Cumulative revenue', 'cumulative'], ['Visit to buy', 'conversion'],
    ['Revenue vs last year', 'time_offset'], ['Revenue per visit', 'cross_model'], ['Median order', 'unknown_aggregation'],
    ['Doubled revenue', 'not_a_column'], ['Revenue (filled)', 'fill_nulls'], ['EU or paid revenue', 'filter_shape'],
    ['Median gap', 'unknown_aggregation', 'median_order'],
  ];
  for (const [name, why, because] of SKIPS) {
    ok(`${name}: skipped, ${why}${because ? `, because of ${because}` : ''}`, skipped.some((s) => s.name === name && s.kind === 'metric' && s.reason === why && s.because === because) && !m(name), show(skipped.filter((s) => s.name === name)));
  }
  ok('every metric in the manifest is either translated or named in skipped', allMetricNames(MANIFEST).every((n) => !!m(n) || skipped.some((s) => s.name === n && s.kind === 'metric')));
  ok('… and never both', allMetricNames(MANIFEST).every((n) => !(m(n) && skipped.some((s) => s.name === n))));
  ok('fifteen translated, ten skipped', model.metrics.length === 15 && skipped.filter((s) => s.kind === 'metric').length === 10, show([model.metrics.map((x) => x.name), skipped]));

  const orders = model.datasets.find((d) => d.id === ORDERS);
  ok('the primary entity becomes the table key', orders?.key === 'id', show(orders));
  ok('a dimension becomes a field doc: description, label as display name', isDeepStrictEqual(orders?.fields?.find((f) => f.name === 'region'), { name: 'region', description: 'Where the order was placed', displayName: 'Region' }), show(orders?.fields));
  ok('a time dimension on a date column too', isDeepStrictEqual(orders?.fields?.find((f) => f.name === 'order_date'), { name: 'order_date', description: 'The day the order was placed', displayName: 'Order date' }));
  ok('a dimension with nothing to say is no field doc', !orders?.fields?.some((f) => f.name === 'units'));
  ok('a dimension whose expr is SQL is skipped, not_a_column', skipped.some((s) => s.kind === 'dimension' && s.dbt === 'orders.order_month' && s.reason === 'not_a_column'));
  ok('the dataset carries only what dbt says: no role, grain, description or guide', !!orders && !('role' in orders) && !('grain' in orders) && !('description' in orders) && model.guides.size === 0);
  ok('ids are UUIDs, the same on every run', model.metrics.every((x) => isValidId(x.id)) && stableStringify(translateDbt(MANIFEST, DATASETS, {})) === stableStringify({ model, skipped }));
  ok('no terms, relationships or invalid files', model.terms.length === 0 && model.relationships.length === 0 && model.invalid.length === 0);

  // Variants: one edit each, against the fixture.
  const timeOnText = copy();
  timeOnText.semantic_models[0].dimensions.find((d: Json) => d.name === 'stock_date').expr = 'status';
  const t1 = translateDbt(timeOnText, DATASETS, {});
  ok('a time dimension on a text column: skipped, and so is the balance that counts by it', t1.skipped.some((s) => s.dbt === 'orders.stock_date' && s.reason === 'not_a_column') && t1.skipped.some((s) => s.name === 'Stock' && s.reason === 'not_a_column') && !metricNamed(t1.model, 'Stock'));
  const sqlKey = copy();
  sqlKey.semantic_models[0].entities[0].expr = "id || '-' || region";
  const t2 = translateDbt(sqlKey, DATASETS, {});
  ok('a primary entity whose expr is SQL: no key, named', !('key' in (t2.model.datasets.find((d) => d.id === ORDERS) ?? {})) && t2.skipped.some((s) => s.kind === 'entity' && s.dbt === 'orders.order' && s.reason === 'not_a_column'));
  const sumText = copy();
  sumText.semantic_models[0].measures.find((x: Json) => x.name === 'order_total').expr = 'status';
  ok('sum over a text column: not_a_column (a number aggregation needs a number)', translateDbt(sumText, DATASETS, {}).skipped.some((s) => s.name === 'Revenue' && s.reason === 'not_a_column'));
  const live = translateDbt(MANIFEST, DATASETS.map((d) => (d.id === ORDERS ? { ...d, live: true } : d)), {});
  ok('a balance on a Live dataset: skipped live_refused, never imported dead', live.skipped.some((s) => s.name === 'Stock' && s.reason === 'live_refused') && !metricNamed(live.model, 'Stock'));
  ok('NEGATIVE CONTROL: the same balance on an extract is translated', !!m('Stock'));
  const unknown = copy();
  unknown.metrics.push({ name: 'future', label: 'Future', type: 'quantum', type_params: {} });
  ok('an unknown metric type: skipped unreadable', translateDbt(unknown, DATASETS, {}).skipped.some((s) => s.name === 'Future' && s.reason === 'unreadable'));
  const hostile = copy();
  hostile.metrics.push({ name: 'evil', label: 'Bad\u0000name', type: 'simple', type_params: { measure: { name: '__proto__' } } }, { name: 'x'.repeat(300), type: 'simple', type_params: { measure: 'order_total' } }, 7, null, ['a']);
  hostile.semantic_models.push({ name: { toString: 1 } }, null);
  const th = translateDbt(hostile, DATASETS, {});
  ok('hostile entries: no throw, nothing imported from them, each metric with a name named', !metricNamed(th.model, 'Bad\u0000name') && th.skipped.some((s) => s.name === 'evil' && s.reason === 'unreadable') && th.model.metrics.length === model.metrics.length, show(th.skipped.slice(-4)));
  const asDict = copy();
  asDict.semantic_models = Object.fromEntries(asDict.semantic_models.map((s: Json) => [`semantic_model.fixture.${s.name}`, s]));
  asDict.metrics = Object.fromEntries(asDict.metrics.map((x: Json) => [`metric.fixture.${x.name}`, x]));
  const twice = copy();
  const eu = twice.metrics.find((x: Json) => x.name === 'eu_revenue');
  eu.type_params.measure.filter = eu.filter;
  ok('one condition on both the measure input and the metric is read once', isDeepStrictEqual(metricNamed(translateDbt(twice, DATASETS, {}).model, 'EU revenue')?.filters, [eq('region', 'EU')]));
  ok('a manifest.json keys its nodes by unique id: the same translation', stableStringify(translateDbt(asDict, DATASETS, {})) === stableStringify({ model, skipped }));

  // ── § filters ──────────────────────────────────────────────────────────────
  const cols = new Map<string, ParsedColumn>([['region', { name: 'region', type: 'text' }], ['units', { name: 'units', type: 'number' }], ['day', { name: 'day', type: 'date' }]]);
  const col = (d: string): ParsedColumn | null => cols.get(d) ?? null;
  const W = (t: string) => parseDbtWhere(t, 'order', col);
  for (const t of [
    "{{ Dimension('order__region') }} = 'EU' OR 1=1", "{{ Dimension('order__region') }} LIKE 'E%'", "{{ TimeDimension('order__day', 'month') }} > '2024-01-01'",
    "lower({{ Dimension('order__region') }}) = 'eu'", "{{ Dimension('customer__region') }} = 'EU'", "{{ Dimension('order__nope') }} = 'EU'",
    "{{ Dimension('order__region') }} = 5", "{{ Dimension('order__units') }} = '5'", "{{ Dimension('order__region') }} > 'EU'", "{{ Dimension('order__day') }} = '2024-01-01'",
    "{{ Dimension('order__region') }} = ''", "{{ Dimension('order__region') }} = 'E\\U'", "{{ Dimension('order__region') }} = 'EU' AND", "({{ Dimension('order__region') }} = 'EU')",
    "{{ Dimension('order__region') }} IN ()", "{{ Dimension('order__region') }} = 'EU' -- x", "{{ Dimension('order__region') }} = 'EU'; drop table x", "{{ Entity('order') }} = 'o1'",
    "{{ Dimension('order__region').grain('month') }} = 'EU'", "{{ Dimension('order__units') }} = 1234567890123456", "{{ Dimension('order__region') }} = TRUE", '',
  ]) ok(`filter shape refused: ${t}`, W(t) === null, show(W(t)));
  const reads: Array<[string, unknown]> = [
    ["{{ Dimension('order__region') }} = 'EU'", [eq('region', 'EU')]],
    ['{{Dimension("order__region")}}=\'EU\'', [eq('region', 'EU')]],
    ["{{ Dimension('order__region') }} <> 'O''Brien'", [{ type: 'filter', column: 'region', op: 'not_empty' }, { type: 'filter', column: 'region', op: '!=', value: "O'Brien" }]],
    ["{{ Dimension('order__units') }} != 3", [{ type: 'filter', column: 'units', op: '!=', value: 3 }]],
    ["{{ Dimension('order__units') }} < -2.5 and {{ Dimension('order__units') }} <= 10", [{ type: 'filter', column: 'units', op: '<', value: -2.5 }, { type: 'filter', column: 'units', op: '<=', value: 10 }]],
    ["{{ Dimension('order__region') }} not in ('EU', 'US')", [{ type: 'filter', column: 'region', op: 'not_empty' }, { type: 'filter', column: 'region', op: 'not in', values: ['EU', 'US'] }]],
    ["{{ Dimension('order__units') }} IN (1, 2)", [{ type: 'filter', column: 'units', op: 'in', values: [1, 2] }]],
    ["{{ Dimension('order__region') }} IS NULL", [{ type: 'filter', column: 'region', op: 'is_empty' }]],
    ["{{ Dimension('order__day') }} IS NOT NULL", [{ type: 'filter', column: 'day', op: 'not_empty' }]],
  ];
  for (const [t, want] of reads) ok(`filter read exactly: ${t}`, isDeepStrictEqual(W(t), want), show(W(t)));

  // ── § datasets ─────────────────────────────────────────────────────────────
  const how = (t: ReturnType<typeof translateDbt>, name: string) => t.model.dbt?.models.find((x) => x.name === name);
  ok('a case- and underscore-blind name is marked for checking; an exact one is not', isDeepStrictEqual(how({ model, skipped }, 'orders'), { name: 'orders', datasetId: ORDERS, how: 'name' }) && isDeepStrictEqual(how({ model, skipped }, 'visits'), { name: 'visits', datasetId: VISITS, how: 'exact' }), show(model.dbt));
  const mapped = translateDbt(MANIFEST, DATASETS, { orders: OTHER });
  ok('datasetMap points a semantic model at another dataset', isDeepStrictEqual(how(mapped, 'orders'), { name: 'orders', datasetId: OTHER, how: 'map' }) && metricNamed(mapped.model, 'Revenue')?.dataset === OTHER);
  const gone = translateDbt(MANIFEST, DATASETS, { orders: '0d000000-0000-4000-8000-0000000000ff' });
  ok('a map to a dataset that is not here matches none: the model and its metrics are no_dataset', isDeepStrictEqual(how(gone, 'orders'), { name: 'orders' })
    && gone.skipped.some((s) => s.kind === 'semanticModel' && s.dbt === 'orders' && s.reason === 'no_dataset') && gone.skipped.some((s) => s.name === 'Revenue' && s.reason === 'no_dataset' && s.model === 'orders') && !metricNamed(gone.model, 'Revenue'));
  ok('… a ratio over them falls with them, named', gone.skipped.some((s) => s.name === 'AOV' && s.because === 'revenue'));
  ok('… and the dataset is in the files, with a fresh id, for a2 to skip as missing', gone.model.datasets.some((d) => d.name === 'orders' && !DATASETS.some((x) => x.id === d.id) && isValidId(d.id)));
  const two = translateDbt(MANIFEST, DATASETS, { visits: ORDERS });
  ok('two semantic models never land on one dataset: the map wins, the name match gives way', how(two, 'visits')?.datasetId === ORDERS && how(two, 'orders')?.datasetId === undefined);
  ok('no dataset is made up: a model with no match has none', isDeepStrictEqual(how(translateDbt(MANIFEST, [], {}), 'orders'), { name: 'orders' }));

  // ── § upload ───────────────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dbt-'));
  const at = (name: string, text: string | Buffer): string => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };
  const HUGE = at('huge.json', `{"semantic_models":[],"metrics":[${'0,'.repeat(1_000_001)}0]}`);
  ok('a manifest over the value budget is refused with the sentence', isDeepStrictEqual(await readDbtUpload(HUGE), { error: msg.dbtUseSemanticManifest() }));
  const BIG = at('big.json', '{}');
  fs.truncateSync(BIG, 32 * 1024 * 1024 + 1);
  ok('… and one over 32 MiB, before it is read', isDeepStrictEqual(await readDbtUpload(BIG), { error: msg.dbtUseSemanticManifest() }));
  ok('NEGATIVE CONTROL: the fixture reads', isDeepStrictEqual(await readDbtUpload(path.join(DIR, 'semantic_manifest.json')), { json: MANIFEST }));
  ok('JSON that is not a semantic manifest is refused', isDeepStrictEqual(await readDbtUpload(at('other.json', '{"nodes":{}}')), { error: msg.dbtNotAManifest() }));
  ok('… and so is a file that is not JSON', isDeepStrictEqual(await readDbtUpload(at('bad.json', '{"semantic_models": [}')), { error: msg.dbtNotAManifest() }));
  const many = { semantic_models: [], metrics: Array.from({ length: 2_001 }, (_, i) => ({ name: `m${i}` })) };
  ok('more metrics than one import takes is refused', isDeepStrictEqual(await readDbtUpload(at('many.json', JSON.stringify(many))), { error: msg.dbtTooMany() }));
  fs.rmSync(tmp, { recursive: true, force: true });

  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
