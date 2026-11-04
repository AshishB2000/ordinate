// Shared fixture for the labelled-join suites (test-joinsVia, and the suites after it): Sales joined
// to ONE Dates table two ways (Order date, Ship date), plus Returns hanging off Sales. Parquet is
// written with pqSync.writeTable, as test-joins.ts does, so the resident SQL and the JS reference
// read the same bytes. Not a test; `scripts/test-*.js` does not match it.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pqSync from '../src/engine/parquetStoreSync';
import type * as jr from '../src/engine/joinResident';
import type { DsInfo } from '../src/analysis/joinPlan';
import type { Relationship } from '../src/analysis/relationships';
import { sanitizeRelationship } from '../src/analysis/relationships';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, TableData } from '../src/data/transforms';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-joinsvia-'));
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
const T0 = Date.UTC(2024, 0, 1);

// 40 orders over 2024, one every 9 days; an order ships (i % 3) * 20 days later. `year` is the SHIP
// year, so the last orders carry 2025: a filter wrongly applied to this column drops rows.
const saleRows: Cell[][] = [];
for (let i = 0; i < 40; i++) {
  const order = T0 + i * 9 * DAY;
  const ship = order + (i % 3) * 20 * DAY;
  saleRows.push([`s${i}`, ['East', 'West', 'North', 'South'][i % 4], 10 + ((i * 7) % 50), iso(order), iso(ship), Number(iso(ship).slice(0, 4))]);
}
export const SALES = fx(ID(1), 'Sales', [
  { name: 'sale_id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' },
  { name: 'order_date', type: 'date' }, { name: 'ship_date', type: 'date' }, { name: 'year', type: 'number' },
], saleRows);

// One row per day, 2024-01-01 .. 2025-02-28, then a SECOND 2024-03-01 row that differs everywhere
// (Rule 2: the first row per key wins, so Q4 / 2025 must never reach a chart).
const dateRows: Cell[][] = [];
for (let ms = T0; ms <= Date.UTC(2025, 1, 28); ms += DAY) {
  const d = iso(ms);
  dateRows.push([d, d.slice(0, 7), `Q${Math.floor((new Date(ms).getUTCMonth()) / 3) + 1}`, Number(d.slice(0, 4))]);
}
dateRows.push(['2024-03-01', '2024-03', 'Q4', 2025]);
export const DATES = fx(ID(2), 'Dates', [
  { name: 'date', type: 'date' }, { name: 'month', type: 'text' }, { name: 'quarter', type: 'text' }, { name: 'year', type: 'number' },
], dateRows);

export const RETURNS = fx(ID(3), 'Returns', [{ name: 'sale_id', type: 'text' }, { name: 'refund', type: 'number' }],
  [['s1', 5], ['s1', 6], ['s2', 7]]);

export const R_ORDER = ID(101);
export const R_SHIP = ID(102);
export const R_RET = ID(103);

const rel = (id: string, from: [Fx, string], to: [Fx, string], label?: string): Relationship =>
  sanitizeRelationship({ id, label, from: { datasetId: from[0].id, column: from[1] },
    to: { datasetId: to[0].id, column: to[1] }, cardinality: 'many_to_one' }) as Relationship;
/** In this order: the first relationship is the default one. */
export const RELS: Relationship[] = [
  rel(R_ORDER, [SALES, 'order_date'], [DATES, 'date'], 'Order date'),
  rel(R_SHIP, [SALES, 'ship_date'], [DATES, 'date'], 'Ship date'),
  rel(R_RET, [RETURNS, 'sale_id'], [SALES, 'sale_id']),
];

const ALL = [SALES, DATES, RETURNS];
export const infos = new Map<string, DsInfo>(ALL.map((f) => [f.id, { id: f.id, name: f.name, columns: f.columns }]));
export const tables = new Map<string, TableData>(ALL.map((f) => [f.id, { columns: f.columns, rows: f.rows }]));
export const sourceOf = (id: string): jr.JoinSource => {
  const f = ALL.find((x) => x.id === id) as Fx;
  return { datasetId: id, parquetPath: f.file, columns: f.columns };
};

export function removeFixture(): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
