'use strict';

// Key drivers' per-member aggregates: the resident SQL (src/engine/
// driversResident.ts) against the JS reference (src/analysis/driversJs.ts),
// Object.is, member by member and operand by operand, over the SAME Parquet
// bytes — the house style for every resident module.
//
// The fixtures aim at the places the two could part ways: empty cells (null,
// '', whitespace, a tab) in one member; a key that starts with U+FEFF, which
// the bridge would otherwise eat; '007' that must stay text; operands with
// their own filters; `in`, `period`, number comparisons and `contains` in the
// scopes; counts over a TEXT column; and a sum with no numbers at all. Then the
// bundled sample, where cents make float sums order-dependent, so its sums are
// held to a relative 1e-9 and its counts to Object.is.
//
//   npm run build:ts && node scripts/test-driversResident.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pqSync from '../src/engine/parquetStoreSync';
import * as duck from '../src/engine/duckdb';
import { memberAggsJs, memberCountsJs } from '../src/analysis/driversJs';
import type { DriverQuery, MemberTable } from '../src/analysis/driversJs';
import { memberAggsResident, memberCountsResident } from '../src/engine/driversResident';
import { distinctAllJs, distinctAllResident } from '../src/engine/distinctAll';
import { parseCsv } from '../src/data/parse';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';

import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-drivers-res-'));
let seq = 0;

function fixture(columns: ParsedColumn[], rows: Cell[][]): { src: { parquetPath: string; columns: ParsedColumn[] }; rows: Cell[][]; columns: ParsedColumn[] } {
  const file = path.join(dir, `t${seq++}.parquet`);
  pqSync.writeTable(file, columns, rows);
  const back = pqSync.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { src: { parquetPath: file, columns }, rows: back.rows, columns: back.columns };
}

function sameNum(a: number | null, b: number | null, rel: number): boolean {
  if (rel === 0 || a === null || b === null) return Object.is(a, b);
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));
}

function sameTable(label: string, fast: MemberTable | null, ref: MemberTable, rel = 0): void {
  ok(`${label}: the resident path answered`, fast !== null);
  if (!fast) return;
  const tot = (p: 'a' | 'b') => fast.totals[p].every((v, i) => sameNum(v, ref.totals[p][i], rel));
  ok(`${label}: ungrouped totals agree`, tot('a') && tot('b'), JSON.stringify({ fast: fast.totals, ref: ref.totals }));
  ok(`${label}: the same dimensions`, fast.dims.map((d) => d.column).join() === ref.dims.map((d) => d.column).join());
  for (const d of ref.dims) {
    const f = fast.dims.find((x) => x.column === d.column);
    const keys = (t: typeof d | undefined) => (t ? t.members.map((m) => m.key) : []);
    ok(`${label} · ${d.column}: the same members, in the same order`, JSON.stringify(keys(f)) === JSON.stringify(keys(d)),
      JSON.stringify({ fast: keys(f), ref: keys(d) }));
    if (!f) continue;
    let all = true;
    d.members.forEach((m, i) => {
      const x = f.members[i];
      if (!x) { all = false; return; }
      const agree = (p: 'a' | 'b') => m[p].every((v, k) => sameNum(x[p][k], v, rel));
      if (!agree('a') || !agree('b')) all = false;
    });
    ok(`${label} · ${d.column}: every operand in both periods agrees`, all);
  }
}

async function run(label: string, fx: ReturnType<typeof fixture>, q: DriverQuery, dims: string[], rel = 0): Promise<void> {
  const ref = memberAggsJs(fx.columns, fx.rows, q, dims);
  const fast = await memberAggsResident(fx.src, q, dims);
  sameTable(label, fast, ref, rel);
  const cFast = await memberCountsResident(fx.src, q, dims);
  const cRef = memberCountsJs(fx.columns, fx.rows, q, dims);
  ok(`${label}: member counts agree`, !!cFast && dims.every((d) => cFast.get(d) === cRef.get(d)),
    JSON.stringify({ fast: cFast ? Array.from(cFast) : null, ref: Array.from(cRef) }));
}

const COLS: ParsedColumn[] = [
  { name: 'day', type: 'date' },
  { name: 'region', type: 'text' },
  { name: 'code', type: 'text' },
  { name: 'amount', type: 'number' },
  { name: 'qty', type: 'number' },
  { name: 'note', type: 'text' },
];

function rowsFor(): Cell[][] {
  const out: Cell[][] = [];
  const regions: Cell[] = ['East', 'West', '', null, '  ', '\t', '﻿North', 'East'];
  const codes: Cell[] = ['007', '7', 'A', 'a', 'B', null];
  for (let i = 0; i < 240; i += 1) {
    const day = i % 2 === 0 ? '2024-01-' + String((i % 28) + 1).padStart(2, '0') : '2024-02-' + String((i % 28) + 1).padStart(2, '0');
    const amount: Cell = i % 11 === 0 ? null : (i * 7) % 50 - 10; // integers, some negative, some empty
    const qty: Cell = i % 5 === 0 ? null : (i % 9) + 1;
    out.push([day, regions[i % regions.length], codes[i % codes.length], amount, qty, i % 3 === 0 ? 'refund' : 'ok']);
  }
  return out;
}

async function main(): Promise<void> {
  let bridge = false;
  try { bridge = duck.isAvailable(); } catch { bridge = false; }
  if (!bridge) {
    console.log('skip: the DuckDB bridge is not available here; nothing to compare the JS reference with');
    return;
  }
  const fx = fixture(COLS, rowsFor());
  const jan: FilterStep = { type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-01-31' } };
  const febStep: FilterStep = { type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-02-01', to: '2024-02-29' } };
  const q: DriverQuery = {
    operands: [
      { column: 'amount', agg: 'sum', filters: [] },
      { column: 'amount', agg: 'ncount', filters: [] },
      { column: 'region', agg: 'count', filters: [] },
      { column: 'qty', agg: 'sum', filters: [{ type: 'filter', column: 'note', op: '!=', value: 'refund' }] },
    ],
    a: [febStep],
    b: [jan],
  };
  await run('two months, four operands', fx, q, ['region', 'code', 'note']);

  await run('scopes with in / number / contains', fx, {
    ...q,
    a: [febStep, { type: 'filter', column: 'code', op: 'in', values: ['007', 'A'] }, { type: 'filter', column: 'amount', op: '>', value: 0 }],
    b: [jan, { type: 'filter', column: 'note', op: 'contains', value: 'ok' }],
  }, ['region', 'code']);

  await run('a drill path: one region, both periods', fx, {
    ...q,
    a: [febStep, { type: 'filter', column: 'region', op: '=', value: 'East' }],
    b: [jan, { type: 'filter', column: 'region', op: '=', value: 'East' }],
  }, ['code', 'note']);

  await run('the blank member (is_empty) as a drill path', fx, {
    ...q,
    a: [febStep, { type: 'filter', column: 'region', op: 'is_empty' }],
    b: [jan, { type: 'filter', column: 'region', op: 'is_empty' }],
  }, ['code']);

  await run('overlapping periods (a row in both)', fx, { ...q, a: [], b: [febStep] }, ['region']);
  await run('no dimensions: totals only', fx, q, []);
  await run('nothing in scope', fx, { ...q, a: [{ type: 'filter', column: 'note', op: '=', value: 'nope' }], b: [{ type: 'filter', column: 'note', op: '=', value: 'nope' }] }, ['region']);

  const blank = fixture(COLS, rowsFor());
  const ref = memberAggsJs(blank.columns, blank.rows, q, ['region']);
  ok('members: every empty cell (null, \'\', spaces, a tab) is the one \'\' member',
    ref.dims[0].members.filter((m) => m.key === '').length === 1 && !ref.dims[0].members.some((m) => m.key.trim() === '' && m.key !== ''));
  ok('members: a leading U+FEFF survives the bridge', (await memberAggsResident(blank.src, q, ['region']))!.dims[0].members.some((m) => m.key === '﻿North'));
  ok('members: \'007\' and \'7\' stay two members', ref.dims.length === 1 && memberAggsJs(blank.columns, blank.rows, q, ['code']).dims[0].members.some((m) => m.key === '007'));

  // The bundled sample: cents, so sums are order-dependent in the last bits.
  const csv = fs.readFileSync(path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  const parsed = parseCsv(csv);
  const sample = fixture(parsed.columns, parsed.rows as Cell[][]);
  const sq: DriverQuery = {
    operands: [
      { column: 'revenue', agg: 'sum', filters: [] },
      { column: 'profit', agg: 'sum', filters: [] },
      { column: 'units', agg: 'sum', filters: [] },
      { column: 'order_date', agg: 'count', filters: [] },
    ],
    a: [{ type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-06-30' } }],
    b: [{ type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2023-07-01', to: '2023-12-31' } }],
  };
  const dims = ['region', 'state', 'category', 'sub_category', 'customer_segment'];
  await run('the bundled sample (sums to 1e-9)', sample, sq, dims, 1e-9);
  const intOnly: DriverQuery = { ...sq, operands: [sq.operands[2], sq.operands[3]] };
  await run('the bundled sample, integer operands (exact)', sample, intOnly, dims);

  // Every distinct value (alertStore.recentPeriods' read): not the picker's
  // 200-value page, so the latest dates are in it.
  for (const col of ['order_date', 'state', 'region']) {
    const fast = await distinctAllResident(sample.src, col);
    const ref = distinctAllJs(sample.columns, sample.rows, col);
    ok(`distinct: every ${col} value, resident ≡ JS`, !!fast && !!ref && fast.length === ref.length && fast.every((v, i) => Object.is(v, ref[i])),
      JSON.stringify({ fast: fast && fast.length, ref: ref && ref.length }));
  }
  const dates = distinctAllJs(sample.columns, sample.rows, 'order_date') || [];
  ok('distinct: the sample\'s dates run past the picker\'s 200 to December 2024', dates.length > 200 && dates[dates.length - 1].startsWith('2024-12'));
  ok('distinct: past the cap is null, on both paths',
    (await distinctAllResident(sample.src, 'order_date', 10)) === null && distinctAllJs(sample.columns, sample.rows, 'order_date', 10) === null);
  const bomFx = fixture(COLS, rowsFor());
  const regions = await distinctAllResident(bomFx.src, 'region');
  ok('distinct: a leading U+FEFF survives, and only null and \'\' are dropped',
    !!regions && regions.includes('﻿North') && regions.includes('  ') && !regions.includes(''),
    JSON.stringify(regions));
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(failureCount() ? 1 : 0);
  });
