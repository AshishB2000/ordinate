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
// § route      model:importPlan and model:importApply over a JSON upload, through a2's plan and a3's apply: the skips with
//              their reasons, a loose match marked, `datasetMap` in the hash, `importedFrom` written, a re-import that
//              writes nothing, a rename here matched by `importedFrom`, and what Ordinate owns (format, direction, a
//              table's role, grain and guide, a field's other names) never cleared by a copy.
// § figures    every imported metric over the seed, by total, region and month, equals expected.json (Object.is), and a
//              group with no figure there has none here. NEGATIVE CONTROL: `!=` without its `not_empty` step differs.
//
//   npm run build:ts && node scripts/test-dbtImport.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post, type Reply } from './liveRouteHarness';
import type { ParsedColumn } from '../src/data/parse';
import type { ModelMetric } from '../src/app/modelFormat';
import { F1_MANIFEST, F1_DATASETS, F1_DIR as DIR, ORDERS_COLUMNS, VISITS_COLUMNS, ORDERS, VISITS, OTHER, copyOf, metricNamed, allMetricNames, uploadJson, type Json } from './dbtHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');
const { translateDbt: translate }: typeof import('../src/app/dbtImport') = require('../src/app/dbtImport');
const { parseDbtWhere }: typeof import('../src/app/dbtFilter') = require('../src/app/dbtFilter');
const { readDbtUpload }: typeof import('../src/app/dbtRead') = require('../src/app/dbtRead');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const { isValidId }: typeof import('../src/app/ids') = require('../src/app/ids');
const msg: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');
const { formatFor }: typeof import('../src/analysis/metricAuto') = require('../src/analysis/metricAuto');

const { DEFAULT_CALENDAR }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const MANIFEST = F1_MANIFEST;
const DATASETS = F1_DATASETS;
const copy = (): Json => copyOf(MANIFEST);
const translateDbt = (json: unknown, datasets: Parameters<typeof translate>[1], map: Parameters<typeof translate>[2]) => translate(json, datasets, map, DEFAULT_CALENDAR);

const eq = (column: string, value: unknown) => ({ type: 'filter', column, op: '=', value });
const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 600) ?? String(v);

(async () => {
  // ── § translate ────────────────────────────────────────────────────────────
  const { model, skipped, notes } = translateDbt(MANIFEST, DATASETS, {});
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
    ['Stock by customer', 'window_groupings'], ['Cumulative revenue', 'window_unit'], ['Visit to buy', 'conversion'], // f2: Cumulative revenue's window is 1 month
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
  ok('ids are UUIDs, the same on every run', model.metrics.every((x) => isValidId(x.id)) && stableStringify(translateDbt(MANIFEST, DATASETS, {})) === stableStringify({ model, skipped, notes }));
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
  ok('a manifest.json keys its nodes by unique id: the same translation', stableStringify(translateDbt(asDict, DATASETS, {})) === stableStringify({ model, skipped, notes }));

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
  ok('a case- and underscore-blind name is marked for checking; an exact one is not', isDeepStrictEqual(how({ model, skipped, notes }, 'orders'), { name: 'orders', datasetId: ORDERS, how: 'name' }) && isDeepStrictEqual(how({ model, skipped, notes }, 'visits'), { name: 'visits', datasetId: VISITS, how: 'exact' }), show(model.dbt));
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

  // ── § route ────────────────────────────────────────────────────────────────
  const csv = (file: string, columns: ParsedColumn[]): (string | number | null)[][] =>
    fs.readFileSync(path.join(DIR, file), 'utf8').trim().split('\n').slice(1).map((line) => line.split(',').map((cell, i) => (cell === '' ? null : columns[i].type === 'number' ? Number(cell) : cell)));
  const seedProject = async (name: string): Promise<{ P: string; orders: string; visits: string; other: string }> => H.as(H.ORG_A, async () => {
    await H.projects.init();
    const P = (await H.projects.createProject(name)).id;
    const save = async (n: string, file: string, columns: ParsedColumn[]): Promise<string> => {
      const d = await H.datasets.saveDataset(P, { name: n, sourceKind: 'csv', columns, rows: csv(file, columns) });
      if (!d) throw new Error(`dataset ${n} not saved`);
      return d.id;
    };
    return { P, orders: await save('Orders', 'seed.csv', ORDERS_COLUMNS), visits: await save('visits', 'visits.csv', VISITS_COLUMNS), other: await save('Orders archive', 'seed.csv', ORDERS_COLUMNS) };
  });
  const planOf = async (P: string, json: unknown = MANIFEST, datasetMap?: Record<string, string>): Promise<Reply> =>
    (await post('model:importPlan', { projectId: P, fileToken: await uploadJson(json), ...(datasetMap && { datasetMap }) })).value;
  const applyOf = async (P: string, planHash: string, json: unknown = MANIFEST, datasetMap?: Record<string, string>): Promise<Reply> =>
    (await post('model:importApply', { projectId: P, fileToken: await uploadJson(json), planHash, ...(datasetMap && { datasetMap }) })).value;
  const fileId = (dbt: string): string => (model.metrics.find((x) => x.importedFrom?.name === dbt) as ModelMetric).id;
  const itemFor = (plan: Reply, dbt: string): Reply => plan.plan.items.find((i: Reply) => i.key === `metric:${fileId(dbt)}`);
  const stored = async (P: string) => H.as(H.ORG_A, async () => {
    const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
    return Promise.all((await metricsMod.listMetrics(P)).map((x) => metricsMod.getMetric(P, x.id)));
  });
  const idOf = async (P: string, name: string): Promise<string> => ((await stored(P)).find((x) => x?.name === name) as { id: string }).id;

  const S = await seedProject('dbt import');
  const plan = await planOf(S.P);
  ok('the dry run answers', plan.ok === true, show(plan));
  const items: Reply[] = plan.plan?.items ?? [];
  const translatorSkips = skipped.filter((x) => x.kind !== 'semanticModel').length;
  ok('the dry run lists every skipped dbt object with its reason', items.filter((i) => i.status === 'skipped').length === translatorSkips, show(items.filter((i) => i.status === 'skipped')));
  ok('… a skipped metric under its own reason', items.some((i) => i.kind === 'metric' && i.name === 'Visit to buy' && i.status === 'skipped' && i.reason === 'conversion'));
  ok('… one that needs a skipped input, under it', items.some((i) => i.name === 'Median gap' && i.reason === 'depends_on_skipped' && i.because === 'metric:dbt:median_order') && items.some((i) => i.key === 'metric:dbt:median_order' && i.reason === 'unknown_aggregation'));
  ok('… a dimension whose expr is SQL', items.some((i) => i.kind === 'field' && i.status === 'skipped' && i.reason === 'not_a_column' && i.name === 'orders · order_month'));
  ok('a semantic model matched loosely is marked for checking', isDeepStrictEqual(items.find((i) => i.kind === 'dataset' && i.name === 'orders')?.changes?.[0], { field: 'matchedByName', here: 'Orders' }), show(items.filter((i) => i.kind === 'dataset')));
  ok('… one matched exactly is not', items.some((i) => i.kind === 'dataset' && i.name === 'visits' && i.targetId === S.visits && !i.changes));
  ok('every translated metric is new', model.metrics.every((x) => itemFor(plan, x.importedFrom?.name as string)?.status === 'new'), show(items.filter((i) => i.kind === 'metric' && i.status !== 'skipped' && i.status !== 'new')));
  ok('the key and the field docs are updates', items.some((i) => i.kind === 'table' && i.status === 'updated' && i.changes?.[0]?.field === 'key') && items.some((i) => i.kind === 'field' && i.name === 'Orders · region' && i.status === 'updated'));
  ok('the source says dbt; nothing only here a dbt file never names', plan.plan?.source?.kind === 'dbt' && !items.some((i) => i.status === 'onlyHere'));
  ok('the reply names no path or token', !/staging|fileToken|semantic_manifest/.test(JSON.stringify(plan)));

  const done = await applyOf(S.P, plan.plan.hash);
  ok('the apply writes every new object and fails none', done.ok === true && done.failed.length === 0 && done.written.length === plan.plan.counts.new + plan.plan.counts.updated, show(done));
  const after = await stored(S.P);
  ok('importedFrom is written', after.find((x) => x?.name === 'Revenue')?.importedFrom?.name === 'revenue' && after.filter((x) => x?.importedFrom).length === model.metrics.length);
  const again = await planOf(S.P);
  ok('a re-import writes nothing', again.plan.counts.updated + again.plan.counts.new + again.plan.counts.renamed + again.plan.counts.conflict === 0, show(again.plan.items.filter((i: Reply) => i.status !== 'unchanged' && i.status !== 'skipped')));

  await post('metric:update', { projectId: S.P, id: await idOf(S.P, 'Revenue'), patch: { name: 'Revenue (net)' } });
  const renamed = await planOf(S.P);
  ok('a re-import matches by importedFrom after a rename', itemFor(renamed, 'revenue')?.targetId === await idOf(S.P, 'Revenue (net)') && itemFor(renamed, 'revenue')?.status === 'renamed', show(itemFor(renamed, 'revenue')));
  const back = await applyOf(S.P, renamed.plan.hash);
  ok('applying it renames it back to dbt\'s name, the same record', back.ok === true && back.written.length === 1 && (await stored(S.P)).some((x) => x?.name === 'Revenue' && x.importedFrom?.name === 'revenue'), show(back));
  const otherPlan = await planOf(S.P, MANIFEST, { orders: S.other });
  ok('datasetMap points a model at another dataset, and moves the hash', otherPlan.ok === true && otherPlan.plan.hash !== renamed.plan.hash && items.length > 0 && otherPlan.plan.items.some((i: Reply) => i.kind === 'dataset' && i.name === 'orders' && i.targetId === S.other));
  ok('… and the apply takes it too: the dry run\'s hash without the map is refused', (await applyOf(S.P, otherPlan.plan.hash)).code === 'plan_changed');
  ok('a map to a dataset of no project here is refused by the contract', (await post('model:importPlan', { projectId: S.P, fileToken: await uploadJson(MANIFEST), datasetMap: { orders: 'nope' } })).status === 400);
  ok('JSON that is not a manifest is refused with the sentence', (await planOf(S.P, { nodes: {} })).error === msg.dbtNotAManifest());

  // A project with its own Revenue and docs: the copy updates what dbt says and keeps what Ordinate owns.
  const K = await seedProject('dbt over a model');
  await post('catalog:setTable', { projectId: K.P, datasetId: K.orders, patch: { role: 'fact', grain: 'One row per order', guide: 'Read me first.' } });
  await post('catalog:setColumn', { projectId: K.P, datasetId: K.orders, column: 'region', patch: { aliases: ['area'] } });
  const own = (await post('metric:save', { projectId: K.P, input: { name: 'Revenue', datasetId: K.orders, definition: { column: 'amount', aggregation: 'sum' }, format: { kind: 'currency', decimals: 0, compact: true }, direction: 'up_good', timeColumn: 'order_date' } })).value;
  ok('(setup) the project\'s own Revenue', own.ok === true, show(own));
  const ownOrders = (await post('metric:save', { projectId: K.P, input: { name: 'Orders', datasetId: K.orders, definition: { column: 'id', aggregation: 'count' } } })).value;
  ok('(setup) the project\'s own Orders, with no date of its own', ownOrders.ok === true && !ownOrders.metric?.timeColumn, show(ownOrders));
  const kPlan = await planOf(K.P);
  ok('a ratio over a metric this import gives its date is not refused for the date it has now', itemFor(kPlan, 'aov')?.status === 'new' && itemFor(kPlan, 'orders')?.status === 'updated', show([itemFor(kPlan, 'aov'), itemFor(kPlan, 'orders')]));
  const kRev = itemFor(kPlan, 'revenue');
  ok('an exact name on the same dataset is an update, of what dbt says only', kRev?.status === 'updated' && kRev?.targetId === own.metric?.id && isDeepStrictEqual(kRev?.changes?.map((c: Reply) => c.field), ['description', 'importedFrom']), show(kRev));
  ok('(setup) the table doc and the field\'s other name were saved', kPlan.ok === true);
  ok('… and the table doc changes only its key', isDeepStrictEqual(kPlan.plan.items.find((i: Reply) => i.kind === 'table')?.changes?.map((c: Reply) => c.field), ['key']));
  const kDone = await applyOf(K.P, kPlan.plan.hash);
  ok('… and the apply writes the input first, then the ratio with dbt\'s date', kDone.failed?.length === 0 && (await stored(K.P)).find((x) => x?.name === 'AOV')?.timeColumn === 'order_date' && (await stored(K.P)).find((x) => x?.name === 'Orders')?.timeColumn === 'order_date', show(kDone));
  const kRevNow = (await stored(K.P)).find((x) => x?.id === own.metric?.id);
  ok('the update tags it and keeps its format and direction', kRevNow?.importedFrom?.name === 'revenue' && kRevNow?.direction === 'up_good' && kRevNow?.format.kind === 'currency', show(kRevNow));
  const docReply = (await post('catalog:getTable', { projectId: K.P, datasetId: K.orders })).value;
  const doc = docReply?.table ?? docReply;
  ok('the table keeps its role, grain and guide, and gains the key', doc?.role === 'fact' && doc?.grain === 'One row per order' && doc?.guide === 'Read me first.' && doc?.key === 'id', show(docReply));
  const colsReply = (await post('catalog:columns', { projectId: K.P, datasetId: K.orders })).value;
  const region = (colsReply?.columns ?? colsReply)?.region;
  ok('the field keeps its other names and gains dbt\'s words', isDeepStrictEqual(region?.aliases, ['area']) && region?.description === 'Where the order was placed' && region?.displayName === 'Region', show(region));
  ok('… and then a re-import is unchanged', (await planOf(K.P)).plan.counts.updated === 0);

  // ── § figures ──────────────────────────────────────────────────────────────
  const EXPECTED: Array<[string, string, string, number | null]> = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8')).figures;
  const PINNED = new Set<string>(); // float differences in the last bits, each by name: none on this seed
  const byName = new Map((await stored(S.P)).map((x) => [x?.name as string, x]));
  const figures = new Map<string, Map<string, number | null>>(); // metric:group → key → value
  const figureOf = async (metric: string, group: string): Promise<Map<string, number | null>> => {
    const k = `${metric}:${group}`;
    if (figures.has(k)) return figures.get(k) as Map<string, number | null>;
    const x = byName.get(metric) as NonNullable<Awaited<ReturnType<typeof stored>>[number]>;
    const out = new Map<string, number | null>();
    if (!group) out.set('', ((await post('metric:values', { projectId: S.P, ids: [x.id] })).value as unknown as Reply[])[0]?.value ?? null);
    else {
      const def = x.definition as { column?: string; aggregation?: string };
      // As the chart picker writes a metric measure: a formula's name with `count` (web/src/features/visuals).
      const measure = def.column ? { column: def.column, aggregation: def.aggregation, metricId: x.id } : { column: x.name, aggregation: 'count', metricId: x.id };
      const encoding = { category: group === 'region' ? 'region' : x.timeColumn, ...(group === 'month' && { grain: 'month' }), values: [measure] };
      const c = (await post('visual:data', { projectId: S.P, datasetId: x.datasetId, encoding })).value;
      if (c.ok !== true) throw new Error(`${metric} by ${group}: ${show(c)}`);
      (c.data.labels as string[]).forEach((label, i) => out.set(group === 'month' ? monthKey(label) : label, c.data.series[0].values[i]));
    }
    figures.set(k, out);
    return out;
  };
  const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04' };
  const monthKey = (label: string): string => (/^\d{4}-\d{2}/.test(label) ? label.slice(0, 7) : `${label.slice(-4)}-${MONTHS[label.slice(0, 3)] ?? '??'}`);
  for (const [metric, group, key, want] of EXPECTED) {
    const got = (await figureOf(metric, group)).get(key);
    ok(`${metric} by ${group || 'total'}${key ? ` ${key}` : ''}: equals MetricFlow (Object.is)`, Object.is(got ?? null, want) || PINNED.has(`${metric}:${group}:${key}`), show([got, want]));
  }
  for (const [k, got] of figures) {
    const [metric, group] = k.split(':');
    for (const [key, value] of got) {
      if (!EXPECTED.some((e) => e[0] === metric && e[1] === group && e[2] === key)) ok(`${metric} by ${group} ${key}: no figure where MetricFlow has none`, value === null, show(value));
    }
  }
  ok('every imported metric is held to a figure', model.metrics.every((x) => EXPECTED.some((e) => e[0] === x.name)));
  const bare = (await post('metric:save', { projectId: S.P, input: { name: 'Bare !=', datasetId: S.orders, definition: { column: 'amount', aggregation: 'sum' }, filters: [{ type: 'filter', column: 'status', op: '!=', value: 'refunded' }] } })).value;
  const bareTotal = ((await post('metric:values', { projectId: S.P, ids: [bare.metric?.id] })).value as unknown as Reply[])[0]?.value;
  ok('NEGATIVE CONTROL: != without its not_empty step is a different figure from MetricFlow\'s', !Object.is(bareTotal, EXPECTED.find((e) => e[0] === 'Not refunded' && e[1] === '')?.[3]), show(bareTotal));

  await close();
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
