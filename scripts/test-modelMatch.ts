// Matching model objects and mapping their references (semantic layer part 7, a2 Task 2; docs/semantic-layer/
// 07-portability.md D4). PURE: hand-built shapes, no store.
//
// 1. By id, then by EXACT name (case counts) on the same dataset; a project object is matched once; an id match wins.
// 2. Relationships: by id, then the same two columns in either direction.
// 3. mapRefs: dataset, ends, term steps, `via`, a step's dataset, a period's base, a target's metric; a reference to a
//    new object keeps its id; one to nothing is listed missing; the input is never touched.
//
//   npm run build:ts && node scripts/test-modelMatch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { ParsedModel } from '../src/app/modelRead';
import type { FilterStep } from '../src/data/transforms';
import type { ModelDataset, ModelMetric, ModelRelationship, ModelTerm } from '../src/app/modelFormat';

const { matchModel, mapRefs }: typeof import('../src/app/modelMatch') = require('../src/app/modelMatch');

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const B = 'x'.repeat(43);
const termStep = (n: number): FilterStep => ({ type: 'term', term: id(n) }) as unknown as FilterStep; // a term step is not a FilterStep's type
const ds = (n: number, name: string): ModelDataset => ({ id: id(n), name, base: B });
const metric = (n: number, name: string, dataset: number, more: Partial<ModelMetric> = {}): ModelMetric => ({
  id: id(n), name, dataset: id(dataset), base: B, definition: { column: 'amount', aggregation: 'sum' }, format: { kind: 'number', decimals: 0, compact: false }, ...more,
});
const term = (n: number, name: string, dataset: number): ModelTerm => ({ id: id(n), name, dataset: id(dataset), base: B, filters: [{ type: 'filter', column: 'region', op: '=', value: 'EU' }] });
const rel = (n: number, from: [number, string], to: [number, string]): ModelRelationship => ({
  id: id(n), base: B, from: { dataset: id(from[0]), column: from[1] }, to: { dataset: id(to[0]), column: to[1] }, cardinality: 'many_to_one',
});
const model = (p: Partial<ParsedModel>): ParsedModel => ({
  manifest: { format: 'ordinate-model', formatVersion: 1, appVersion: '0', project: { name: 'P' }, calendar: {} as ParsedModel['manifest']['calendar'] },
  datasets: [], guides: new Map(), metrics: [], terms: [], relationships: [], invalid: [], ...p,
});

// The project: Orders (1), Customers (2); a term EMEA (10), metrics Revenue (20) and Margin (21, on Customers); a relationship (30).
const here = model({
  datasets: [ds(1, 'Orders'), ds(2, 'Customers')],
  terms: [term(10, 'EMEA', 1)],
  metrics: [metric(20, 'Revenue', 1), metric(21, 'Margin', 2), metric(22, 'Rev', 1)],
  relationships: [rel(30, [1, 'customer_id'], [2, 'id'])],
});

// ── 1. By id, then by name ──────────────────────────────────────────────────
const sameIds = matchModel(here, here);
ok('same id: matched by id, to itself', sameIds.metrics.get(id(20)) === id(20) && sameIds.how.get(`metric:${id(20)}`) === 'id' && sameIds.datasets.get(id(1)) === id(1) && sameIds.terms.get(id(10)) === id(10));

// Another project: the same names, other ids (the promotion case).
const other = model({
  datasets: [ds(101, 'Orders'), ds(102, 'Customers'), ds(103, 'Returns')],
  terms: [term(110, 'EMEA', 101), term(111, 'emea', 101)],
  metrics: [metric(120, 'Revenue', 101), metric(121, 'Margin', 101), metric(123, 'revenue', 101)],
  relationships: [rel(130, [102, 'id'], [101, 'customer_id']), rel(131, [101, 'region'], [102, 'region'])],
});
const m = matchModel(other, here);
ok('other id, same name: matched by name, to the target id', m.datasets.get(id(101)) === id(1) && m.how.get(`dataset:${id(101)}`) === 'name' && m.metrics.get(id(120)) === id(20) && m.how.get(`metric:${id(120)}`) === 'name' && m.terms.get(id(110)) === id(10));
ok('a dataset no project dataset is called: no match', m.datasets.get(id(103)) === null && !m.how.has(`dataset:${id(103)}`));
ok('a name differing only in case is NOT a match', m.metrics.get(id(123)) === null && m.terms.get(id(111)) === null);
ok('a name on another dataset is not a match', m.metrics.get(id(121)) === null, String(m.metrics.get(id(121))));
const twice = matchModel(model({ datasets: [ds(1, 'Orders')], metrics: [metric(140, 'Revenue', 1), metric(141, 'Revenue', 1)] }), here);
ok('a project object is matched once', [twice.metrics.get(id(140)), twice.metrics.get(id(141))].filter((v) => v === id(20)).length === 1);
const idFirst = matchModel(model({ datasets: [ds(1, 'Orders')], metrics: [metric(150, 'Rev', 1), metric(20, 'Rev', 1)] }), here);
ok('an id match wins over a name match', idFirst.metrics.get(id(20)) === id(20) && idFirst.metrics.get(id(150)) === id(22));

// ── 2. Relationships ────────────────────────────────────────────────────────
ok('a relationship: the same two columns, reversed, through the mapped datasets', m.relationships.get(id(130)) === id(30) && m.how.get(`relationship:${id(130)}`) === 'name');
ok('a relationship on other columns: no match', m.relationships.get(id(131)) === null);

// ── 3. mapRefs ──────────────────────────────────────────────────────────────
const src = metric(160, 'Revenue EMEA', 101, { filters: [termStep(110), { type: 'filter', column: 'name', op: '=', value: 'x', via: id(130), datasetId: id(102) }] });
const before = JSON.stringify(src);
const mapped = mapRefs(src, m);
ok('a term step maps to the project term, the dataset to the project dataset', mapped.value.dataset === id(1) && (mapped.value.filters?.[0] as unknown as { term?: string } | undefined)?.term === id(10) && mapped.missing.length === 0, JSON.stringify(mapped));
ok('a via and a step dataset map', mapped.value.filters?.[1].via === id(30) && mapped.value.filters?.[1].datasetId === id(2));
ok('the input is not touched', JSON.stringify(src) === before);
const dangling = mapRefs(metric(161, 'X', 101, { filters: [{ type: 'filter', column: 'name', op: '=', value: 'x', via: id(999) }] }), m);
ok('a via to a relationship in neither side is listed missing', dangling.missing.join() === `relationship:${id(999)}`, dangling.missing.join());
ok('a dataset with no match is listed missing', mapRefs(metric(162, 'Y', 103), m).missing.join() === `dataset:${id(103)}`);
ok('a reference to an object the files leave out but the project has is kept', mapRefs(metric(163, 'Z', 1, { filters: [termStep(10)] }), matchModel(model({}), here)).missing.length === 0);
const period = mapRefs(metric(164, 'Revenue MTD', 101, { definition: { base: id(120), window: { to_date: 'month' } } as ModelMetric['definition'], target: { source: { metricId: id(120) } } }), m);
ok('a period base and a target metric map to the project metric', (period.value.definition as { base: string }).base === id(20) && (period.value.target?.source as { metricId?: string } | undefined)?.metricId === id(20) && period.missing.length === 0);
const toNew = mapRefs(metric(165, 'Q', 101, { definition: { base: id(123) } as ModelMetric['definition'] }), m);
ok('a reference to a new object keeps its file id, and is not missing', (toNew.value.definition as { base: string }).base === id(123) && toNew.missing.length === 0);
const ends = mapRefs(rel(170, [101, 'a'], [103, 'b']), m);
ok('a relationship end maps, or is missing', ends.value.from.dataset === id(1) && ends.missing.join() === `dataset:${id(103)}`);

finish();
