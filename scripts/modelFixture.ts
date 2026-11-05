// The model files' fixture (semantic layer part 7, a1) — helper for scripts/test-modelExport.ts; not a suite.
//
// One project in acme, built through the real RPC route as its admin (./liveRouteHarness): two extract
// datasets (Orders, filled in; Customers, bare) and one Live dataset over the fake warehouse with base
// filters. Every kind part 1 and part 5 store is filled in: table and field docs, value labels, a term, a
// simple metric with a term filter, a time column and a target, a snapshot metric with its per-entity
// column, a distinct count, a period metric, a formula metric, a metric tree and a labelled relationship.
// Planted where an export must never look: the connection's password, the Live origin's table name, the
// SQL that defined Orders, a row access rule's value and the privacy salt. The guide carries a canary
// the same grep must find (the negative control).

import type { FilterStep } from '../src/data/transforms';
import { H, post, type Reply } from './liveRouteHarness';

const path: typeof import('path') = require('path');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const kinds: typeof import('../src/app/recordKinds') = require('../src/app/recordKinds');
const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');

export const GUIDE_CANARY = 'GUIDE_CANARY_3b81';
export const GUIDE = `# Orders\n\nOne row per order line, net of refunds. ${GUIDE_CANARY}`; // as stored: the doc trims its ends
export const SOURCE_TABLE = 'live_fake_orders';
export const SOURCE_SQL = 'SELECT secret_col FROM vault_orders';
export const POLICY_CANARY = 'POLICY_CANARY_9e04';
export const BASE: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'EU' }];
export const TARGET = { source: { value: 1200 }, per: 'month' };

export interface ModelFixture {
  P: string;
  orders: string;
  customers: string;
  live: string;
  connId: string;
  emea: string;
  revenue: string;
  stock: string;
  mtd: string;
  /** [what, needle]: none may appear in any exported byte. */
  planted: [string, string][];
}

async function ok(r: { status: number; value: Reply; body: string }, what: string): Promise<Reply> {
  if (r.status !== 200 || r.value?.ok === false) throw new Error(`fixture: ${what} failed: ${r.status} ${r.body.slice(0, 300)}`);
  return r.value;
}

/** A newer release's write, made the way it would land: on the stored record, beside what this one writes. */
function plantOnMetric(P: string, id: string, apply: (raw: Record<string, any>) => void): Promise<unknown> { // any: a raw stored record
  return H.as(H.ORG_A, () => record.serialized(path.join(kinds.projectDir(P), 'metrics', `${id}.json`), apply));
}

export async function buildModelFixture(): Promise<ModelFixture> {
  const { P, connId, live, orders, customers } = await H.as(H.ORG_A, async () => {
    await H.projects.init();
    const P = (await H.projects.createProject('Retail model')).id;
    const { connId, liveId } = await H.liveOver(P, { table: SOURCE_TABLE }, [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }]);
    const columns = [
      { name: 'order_id', type: 'text' as const }, { name: 'customer_id', type: 'text' as const }, { name: 'region', type: 'text' as const },
      { name: 'amount', type: 'number' as const }, { name: 'day', type: 'date' as const }, { name: 'units', type: 'number' as const },
    ];
    const rows = [['o1', 'c1', 'EU', 10, '2025-03-01', 4], ['o2', 'c2', 'ME', 20, '2025-03-02', 3], ['o3', 'c1', 'US', 30, '2025-03-02', 5]];
    const o = await H.datasets.saveDataset(P, { name: 'Orders', sourceKind: 'sql', columns, rows, origin: { kind: 'connection', connId, sql: SOURCE_SQL } });
    const c = await H.datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv', columns: [{ name: 'id', type: 'text' }, { name: 'name', type: 'text' }], rows: [['c1', 'Ada'], ['c2', 'Bo']] });
    if (!o || !c) throw new Error('fixture: datasets not saved');
    if (!(await H.liveDataset.setBaseFilters(P, liveId, BASE))) throw new Error('fixture: base filters not saved');
    return { P, connId, live: liveId, orders: o.id, customers: c.id };
  });

  await ok(await post('catalog:setTable', { projectId: P, datasetId: orders, patch: { role: 'fact', key: 'order_id', grain: 'One row per order line', guide: GUIDE } }), 'table doc');
  await ok(await post('catalog:set', { projectId: P, ref: `dataset:${orders}`, patch: { description: 'Every order line' } }), 'description');
  await ok(await post('catalog:setColumn', { projectId: P, datasetId: orders, column: 'amount', patch: { description: 'Net amount', displayName: 'Amount', aliases: ['net'], sensitivity: 'financial' } }), 'amount doc');
  await ok(await post('catalog:setColumn', { projectId: P, datasetId: orders, column: 'region', patch: { example: 'EU', values: [{ value: 'EU', label: 'Europe' }, { value: 'ME', label: 'Middle East' }] } }), 'region labels');
  const emea = (await ok(await post('term:save', { projectId: P, input: { name: 'EMEA', aliases: ['Europe and ME'], description: 'Europe and the Middle East', datasetId: orders, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME'] }] } }), 'term')).term?.id ?? '';
  const save = async (input: Record<string, unknown>): Promise<string> => {
    const v = await ok(await post('metric:save', { projectId: P, input: { datasetId: orders, ...input } }), `metric ${String(input.name)}`);
    return (v.metric?.id ?? v.id) as string;
  };
  const revenue = await save({ name: 'Revenue', definition: { column: 'amount', aggregation: 'sum' }, filters: [{ type: 'term', term: emea }], format: { kind: 'currency', decimals: 0, prefix: '$' }, description: 'Net revenue in EMEA', direction: 'up_good', timeColumn: 'day' });
  const stock = await save({ name: 'Stock on hand', definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } } });
  await save({ name: 'Orders', definition: { column: 'order_id', aggregation: 'countd' }, timeColumn: 'day' });
  const mtd = await save({ name: 'Revenue MTD', definition: { base: revenue, window: { to_date: 'month' } } });
  await save({ name: 'Avg basket', definition: { formula: '[Revenue] / [Orders]' } });
  await ok(await post('metricTree:save', { projectId: P, id: revenue, tree: { id: '8a000000-0000-4000-8000-000000000008', metricId: revenue, split: 'region' } }), 'tree');
  await plantOnMetric(P, revenue, (raw) => { raw.target = TARGET; });
  await plantOnMetric(P, stock, (raw) => { raw.definition.snapshot.per = 'region'; });
  await ok(await post('relationship:save', { projectId: P, relationship: { from: { datasetId: orders, column: 'customer_id' }, to: { datasetId: customers, column: 'id' }, cardinality: 'many_to_one', label: 'Customer' } }), 'relationship');

  // Planted last, as stored: a row access rule (an admin is not restricted by it) and the masking key.
  await H.as(H.ORG_A, () => record.serialized(record.datasetFilePath(P, orders), (raw) => {
    raw.rowPolicy = { column: 'region', rules: [{ userId: '9f000000-0000-4000-8000-000000000009', values: [POLICY_CANARY] }] };
  }));
  const salt = (await H.as(H.ORG_A, () => privacy.getSalt(P))) ?? '';
  if (!salt) throw new Error('fixture: no salt');
  return {
    P, orders, customers, live, connId, emea, revenue, stock, mtd,
    planted: [['connection secret', H.SECRET_CANARY], ['source table name', SOURCE_TABLE], ['defining SQL', 'SELECT secret_col'],
      ['row-policy value', POLICY_CANARY], ['privacy salt', salt], ['connection id', connId]],
  };
}
