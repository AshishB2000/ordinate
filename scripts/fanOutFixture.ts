// Shared fixture for the fan-out suites (test-fanOut and the row access suite after it): Customers, its
// many sides Orders and Returns, and Regions reached TWO ways from Orders — directly by ship region, and
// through Customers by the customer's region. Parquet is written with pqSync.writeTable, as
// test-joins.ts does, so the resident SQL and the JS reference read the same bytes. Not a test.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pqSync from '../src/engine/parquetStoreSync';
import type * as jr from '../src/engine/joinResident';
import type { DsInfo } from '../src/analysis/joinPlan';
import type { VizAggregation, VizMeasure } from '../src/analysis/visuals';
import type { Relationship } from '../src/analysis/relationships';
import { sanitizeRelationship } from '../src/analysis/relationships';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep, TableData } from '../src/data/transforms';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-fanout-'));
let seq = 0;

export interface Fx { id: string; name: string; file: string; columns: ParsedColumn[]; rows: Cell[][] }

function fx(id: string, name: string, columns: ParsedColumn[], rows: Cell[][]): Fx {
  const file = path.join(dir, `t${seq++}.parquet`);
  pqSync.writeTable(file, columns, rows);
  const back = pqSync.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { id, name, file, columns: back.columns, rows: back.rows };
}

export const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// 70 customers, one signup every 9 days (70 days, over 60 weeks: the auto grain is month), plus a SECOND
// c1 row that differs everywhere: a join takes the first row per key (Rule 2), so 'Gov' and 'Z' never
// reach a many side's question. Every fifth customer has no region.
const custRows: Cell[][] = [];
for (let i = 0; i < 70; i++) {
  custRows.push([`c${i}`, ['Enterprise', 'SMB', 'Mid'][i % 3], ['West', 'East', 'North', 'South', null][i % 5], ['A', 'B'][i % 2], iso(Date.UTC(2024, 0, 1) + i * 9 * DAY)]);
}
custRows.push(['c1', 'Gov', 'South', 'Z', '2026-06-30']);
export const CUSTOMERS = fx(ID(1), 'Customers', [
  { name: 'id', type: 'text' }, { name: 'segment', type: 'text' }, { name: 'region', type: 'text' },
  { name: 'tier', type: 'text' }, { name: 'signup', type: 'date' },
], custRows);

// 40 orders over 13 customers (13 signup days: alone, an Orders chart by signup would pick the day grain),
// one in ten with no customer and one in ten with an unknown one. `region` is Orders' OWN column, unlike
// the customer's: a bare region filter applied to it narrows other rows. Amounts are multiples of 0.25.
const orderRows: Cell[][] = [];
for (let i = 0; i < 40; i++) {
  const cust = i % 10 === 8 ? null : i % 10 === 9 ? 'zz' : `c${(i * 3) % 13}`;
  orderRows.push([`o${i}`, cust, ['East', 'West', 'North', 'South'][(i + 1) % 4], ['West', 'East'][i % 2], 0.25 * (((i * 13) % 97) + 1), iso(Date.UTC(2023, 10, 1) + i * 11 * DAY)]);
}
export const ORDERS = fx(ID(2), 'Orders', [
  { name: 'order_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'ship_region', type: 'text' },
  { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'order_date', type: 'date' },
], orderRows);

export const RETURNS = fx(ID(3), 'Returns', [{ name: 'customer_id', type: 'text' }, { name: 'refund', type: 'number' }],
  [['c1', 5], ['c1', 2.5], ['c3', 1.25], ['zz', 4], [null, 3], ['c6', 0.75], ['c12', 2], ['c30', 1.5]]);

// West twice: the first row ('W') is the one every hop takes.
export const REGIONS = fx(ID(4), 'Regions', [{ name: 'region', type: 'text' }, { name: 'zone', type: 'text' }],
  [['East', 'E'], ['West', 'W'], ['North', 'N'], ['South', 'S'], ['West', 'DUP']]);

export const R_OC = ID(101);
export const R_OR = ID(102);
export const R_RC = ID(103);
export const R_CR = ID(104);

const rel = (id: string, from: [Fx, string], to: [Fx, string]): Relationship =>
  sanitizeRelationship({ id, from: { datasetId: from[0].id, column: from[1] }, to: { datasetId: to[0].id, column: to[1] }, cardinality: 'many_to_one' }) as Relationship;
/** In this order: from Orders, breadth-first reaches Regions by ship region (R_OR) before Customers' region. */
export const RELS: Relationship[] = [
  rel(R_OC, [ORDERS, 'customer_id'], [CUSTOMERS, 'id']),
  rel(R_OR, [ORDERS, 'ship_region'], [REGIONS, 'region']),
  rel(R_RC, [RETURNS, 'customer_id'], [CUSTOMERS, 'id']),
  rel(R_CR, [CUSTOMERS, 'region'], [REGIONS, 'region']),
];

export const ALL = [CUSTOMERS, ORDERS, RETURNS, REGIONS];
export const infos = new Map<string, DsInfo>(ALL.map((f) => [f.id, { id: f.id, name: f.name, columns: f.columns }]));
export const tables = new Map<string, TableData>(ALL.map((f) => [f.id, { columns: f.columns, rows: f.rows }]));
export const byId = (id: string): Fx => ALL.find((x) => x.id === id) as Fx;
export const sourceOf = (id: string): jr.JoinSource => ({ datasetId: id, parquetPath: byId(id).file, columns: byId(id).columns });

export const M = (column: string, aggregation: VizAggregation, datasetId?: string): VizMeasure => ({ column, aggregation, ...(datasetId && { datasetId }) });
export const F = (column: string, op: string, value: Cell): FilterStep => ({ type: 'filter', column, op, value } as FilterStep);

export function removeFixture(): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
