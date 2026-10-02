// Differential self-check for multi-currency: engine/fxResident.ts (the ASOF
// join over Parquet) held to `Object.is` agreement with analysis/fx.ts (the JS
// reference) over the SAME bytes — converted sum/avg/min/max, the missing-row
// count and its pairs, under filters, for per-row and fixed currencies, four
// targets, a rate dataset and the bundled sample, and a grouped chart.
//
// EXACTNESS. The main fixture uses power-of-two rates on integer amounts, so
// every converted value — inverses and triangles included — is exact and a sum
// is order-independent: JS's left fold and DuckDB's parallel sum must agree to
// the bit, and they do. The bundled sample's realistic rates are run too, where
// the documented float-summation divergence (residentQuery.ts header) is pinned
// at relErr < 1e-12 for sum/avg and exact for min/max and every count.
//
//   npm run build:ts && node scripts/test-fxResident.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pq from '../src/engine/parquetStore';
import * as rq from '../src/engine/residentQuery';
import * as fr from '../src/engine/fxResident';
import * as fx from '../src/analysis/fx';
import { applyPipeline } from '../src/data/transforms';
import type { Cell, FilterStep, TableData } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';
import { computeMetric } from '../src/analysis/metricValue';
import type { MetricAggregation } from '../src/analysis/metricValue';
import { buildVizData } from '../src/analysis/vizData';
import type { VizEncoding } from '../src/analysis/visuals';
import { sampleRates } from '../src/app/fxStore';
import { ok, finish } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-fx-'));
let seq = 0;

function write(columns: ParsedColumn[], rows: Cell[][]): { file: string; table: TableData } {
  const file = path.join(dir, `t${seq++}.parquet`);
  pq.writeTable(file, columns, rows);
  const back = pq.readTable(file, columns);
  if (!back) throw new Error('read-back failed');
  return { file, table: { columns: back.columns, rows: back.rows } };
}

// Deterministic pseudo-random.
let seed = 7;
const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

// ── The rows ─────────────────────────────────────────────────────────────────
const COLS: ParsedColumn[] = [
  { name: 'amount', type: 'number' }, { name: 'cur', type: 'text' }, { name: 'day', type: 'date' },
  { name: 'region', type: 'text' }, { name: 'fee', type: 'number' },
];
const CURS = ['USD', 'EUR', 'eur', 'GBP', 'JPY', 'CHF', 'SEK', '', null, 'EURO'];
const DAYS = ['2023-12-15', '2024-01-01', '2024-01-20', '2024-02-01', '2024-02-29', '2024-03-15', '2024-04-02', '2024-06-30', '', '2024/05/05', '2024-02-31'];
const ROWS: Cell[][] = [];
for (let i = 0; i < 4000; i++) {
  // An empty NUMBER cell is null: ingest maps '' → null, and a stored '' in a
  // number column reads back as Number('') = 0 (parquetStore.toCell) — a shape
  // no import produces, so it is not one to differ on here.
  const amt = rnd() < 0.05 ? null : Math.floor(rnd() * 2000) - 300;
  ROWS.push([amt, pick(CURS), pick(DAYS), pick(['West', 'East', 'North']), Math.floor(rnd() * 50)]);
}
const data = write(COLS, ROWS);
const SRC: rq.ResidentSource = { parquetPath: data.file, columns: data.table.columns };

// ── The rates: powers of two, so every product and inverse is exact ──────────
const RCOLS: ParsedColumn[] = [{ name: 'on', type: 'date' }, { name: 'from', type: 'text' }, { name: 'to', type: 'text' }, { name: 'rate', type: 'number' }];
const RROWS: Cell[][] = [
  ['2024-01-01', 'EUR', 'USD', 2], ['2024-02-01', 'EUR', 'USD', 1], ['2024-02-01', 'EUR', 'USD', 4], // same day: LAST (4) wins
  ['2024-04-01', 'eur', 'usd', 0.5],
  ['2024-01-01', 'USD', 'JPY', 128], ['2024-03-01', 'USD', 'JPY', 256],
  ['2024-01-01', 'USD', 'GBP', 0.5], ['2024-05-01', 'USD', 'GBP', 0.25], // GBP→USD only as an inverse
  ['2024-01-01', 'CHF', 'EUR', 1], ['2024-03-01', 'EUR', 'CHF', 0.25], // direct beats the fresher inverse
  ['', 'EUR', 'USD', 8], ['2024-01-01', 'EUR', 'USD', 0], ['2024-01-01', 'EURO', 'USD', 2], ['2024-01-01', 'EUR', 'USD', null],
];
const rates = write(RCOLS, RROWS);
const MAP = { date: 'on', from: 'from', to: 'to', rate: 'rate' };
const DS_RATES: fr.FxRateSource = { kind: 'dataset', parquetPath: rates.file, columns: rates.table.columns, map: MAP };
const DS_TABLE = fx.buildRates(fx.rateRowsFromTable(rates.table, MAP));

// ── The harness ──────────────────────────────────────────────────────────────
interface Answer { value: number | null; missing: number; pairs: string[] }

function jsAnswer(plan: fx.FxPlan, table: fx.RateTable, spec: { column: string; aggregation: MetricAggregation }, filters: FilterStep[]): Answer {
  const conv = fx.convertTable(data.table, plan, table);
  const t = filters.length ? applyPipeline(conv, filters) : conv;
  return { value: computeMetric(t.columns, t.rows, spec), ...fx.missingOf(t) };
}

function withFx<T>(plan: fx.FxPlan, src: fr.FxRateSource, run: (s: rq.ResidentSource) => T): T | null {
  const rel = fr.fxRelationSql(SRC, src, plan);
  if (!rel) return null;
  const key = 'fx:test' + seq++;
  return rq.withRelation(key, rel, () => run({ parquetPath: key, columns: fr.fxColumns(SRC.columns) }));
}

const AGGS: MetricAggregation[] = ['sum', 'avg', 'min', 'max'];
const FILTERS: Array<[string, FilterStep[]]> = [
  ['no filter', []],
  ['region = West', [{ type: 'filter', column: 'region', op: '=', value: 'West' } as FilterStep]],
  ['converted amount > 500', [{ type: 'filter', column: 'amount', op: '>', value: 500 } as FilterStep]],
  ['cur in (GBP, SEK)', [{ type: 'filter', column: 'cur', op: 'in', values: ['GBP', 'SEK'] } as FilterStep]],
];
const DECLS: Array<[string, Record<string, fx.CurrencyDecl>]> = [
  ['per-row currency', { amount: { kind: 'column', column: 'cur' } }],
  ['fixed EUR', { amount: { kind: 'fixed', code: 'EUR' } }],
  ['fixed GBP, two columns', { amount: { kind: 'fixed', code: 'GBP' }, fee: { kind: 'column', column: 'cur', date: 'day' } }],
];

let compared = 0;
let missingSeen = 0;
for (const target of ['USD', 'EUR', 'JPY', 'GBP']) {
  for (const [dl, decls] of DECLS) {
    const plan = fx.resolvePlan(COLS, decls, Object.keys(decls), target) as fx.FxPlan;
    for (const [fl, filters] of FILTERS) {
      for (const agg of AGGS) {
        for (const column of Object.keys(decls)) {
          const spec = { column, aggregation: agg };
          const js = jsAnswer(plan, DS_TABLE, spec, filters);
          const res = withFx(plan, DS_RATES, (s) => fr.fxMetricOn(s, spec, filters));
          const same = !!res && Object.is(res.value, js.value) && res.missing === js.missing && JSON.stringify(res.pairs) === JSON.stringify(js.pairs);
          ok(`differential: ${target} · ${dl} · ${fl} · ${agg}(${column})`, same, JSON.stringify({ js, res }));
          compared += 1;
          missingSeen += js.missing > 0 ? 1 : 0;
        }
      }
    }
  }
}
ok(`differential: ${compared} comparisons, most with missing rows (${missingSeen})`, compared === 4 * 3 * 4 * 4 + 4 * 4 * 4 && missingSeen > compared / 2);

// The differential SUM, spelled out: per-row EUR/GBP/JPY… → USD.
{
  const plan = fx.resolvePlan(COLS, DECLS[0][1], ['amount'], 'USD') as fx.FxPlan;
  const js = jsAnswer(plan, DS_TABLE, { column: 'amount', aggregation: 'sum' }, []);
  const res = withFx(plan, DS_RATES, (s) => fr.fxMetricOn(s, { column: 'amount', aggregation: 'sum' }, []));
  ok('differential sum: per-row currencies to USD, bit for bit', !!res && Object.is(res.value, js.value) && typeof js.value === 'number', JSON.stringify({ js, res }));
  ok('differential sum: missing rows are counted, not converted at 1', !!res && res.missing === js.missing && js.missing > 0
    && js.pairs.includes('SEK→USD') && js.pairs.includes('?→USD'), JSON.stringify(js));
}

// ── A grouped chart over the converted relation ──────────────────────────────
for (const [label, enc] of [
  ['by region', { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }, { column: 'amount', aggregation: 'max' }] }],
  ['by fee (number bins)', { category: 'fee', values: [{ column: 'amount', aggregation: 'avg' }] }],
  ['by currency', { category: 'cur', values: [{ column: 'amount', aggregation: 'min' }] }],
] as Array<[string, VizEncoding]>) {
  const plan = fx.resolvePlan(COLS, DECLS[0][1], ['amount'], 'EUR') as fx.FxPlan;
  const conv = fx.convertTable(data.table, plan, DS_TABLE);
  const js = buildVizData(conv.columns, conv.rows, enc, []);
  const res = withFx(plan, DS_RATES, (s) => {
    const measures = enc.values.map((v) => ({ column: v.column, aggregation: v.aggregation === 'none' ? 'sum' as const : v.aggregation }));
    const k = rq.resolveCatKey(s, enc.category, measures, [], enc.grain);
    return k ? rq.aggregateResident(s, enc.category, measures, [], k.key) : null;
  });
  const same = !!res && JSON.stringify(res.labels) === JSON.stringify(js.data.labels)
    && res.series.every((sr, i) => sr.values.length === js.data.series[i].values.length && sr.values.every((v, j) => Object.is(v, js.data.series[i].values[j])));
  ok(`chart: EUR, ${label} — labels and every value agree`, same && js.warnings.length === 0, JSON.stringify({ js: js.data, res }));
}

// A date-grain chart needs a date column the category key accepts (no
// impossible dates), so it runs over the rows with a real date.
{
  const clean = write(COLS, ROWS.filter((r) => ['2024-01-01', '2024-01-20', '2024-02-29', '2024-03-15', '2024-06-30'].includes(String(r[2]))));
  const cleanSrc: rq.ResidentSource = { parquetPath: clean.file, columns: clean.table.columns };
  const enc: VizEncoding = { category: 'day', values: [{ column: 'amount', aggregation: 'sum' }], grain: 'month' };
  const plan = fx.resolvePlan(COLS, DECLS[0][1], ['amount'], 'JPY') as fx.FxPlan;
  const conv = fx.convertTable(clean.table, plan, DS_TABLE);
  const js = buildVizData(conv.columns, conv.rows, enc, []);
  const rel = fr.fxRelationSql(cleanSrc, DS_RATES, plan);
  const res = rel ? rq.withRelation('fx:clean', rel, () => {
    const s = { parquetPath: 'fx:clean', columns: fr.fxColumns(cleanSrc.columns) };
    const m = [{ column: 'amount', aggregation: 'sum' as const }];
    const k = rq.resolveCatKey(s, 'day', m, [], 'month');
    return k ? rq.aggregateResident(s, 'day', m, [], k.key) : null;
  }) : null;
  ok('chart: JPY by month — labels and every value agree', !!res && JSON.stringify(res.labels) === JSON.stringify(js.data.labels)
    && res.series[0].values.every((v, j) => Object.is(v, js.data.series[0].values[j])), JSON.stringify({ js: js.data, res }));
}

// ── The bundled sample: realistic rates, pinned divergence ───────────────────
{
  const sample = sampleRates();
  const sampleSrc: fr.FxRateSource = { kind: 'sample', rows: sample.rows };
  for (const target of ['USD', 'GBP', 'JPY']) {
    const plan = fx.resolvePlan(COLS, DECLS[0][1], ['amount'], target) as fx.FxPlan;
    for (const agg of AGGS) {
      const spec = { column: 'amount', aggregation: agg };
      const js = jsAnswer(plan, sample.table, spec, []);
      const res = withFx(plan, sampleSrc, (s) => fr.fxMetricOn(s, spec, []));
      const exact = agg === 'min' || agg === 'max';
      const close = !!res && js.value !== null && res.value !== null
        && (exact ? Object.is(res.value, js.value) : Math.abs(res.value - js.value) / Math.abs(js.value) < 1e-12);
      ok(`sample rates: ${target} ${agg} — ${exact ? 'exact' : 'relErr < 1e-12'}, same missing rows`, close && !!res && res.missing === js.missing
        && JSON.stringify(res.pairs) === JSON.stringify(js.pairs), JSON.stringify({ js, res }));
    }
  }
}

// ── Declined, not guessed ────────────────────────────────────────────────────
{
  const odd = write(COLS, [[10, 'EUR', 'Jan 5, 2024', 'West', 1]]);
  const plan = fx.resolvePlan(COLS, DECLS[0][1], ['amount'], 'USD') as fx.FxPlan;
  ok('declined: a date SQL does not read sends the answer to JS', fr.fxRelationSql({ parquetPath: odd.file, columns: odd.table.columns }, DS_RATES, plan) === null);
  const oddRates = write(RCOLS, [['March 1, 2024', 'EUR', 'USD', 2]]);
  ok('declined: …in the rate table too', fr.fxRelationSql(SRC, { ...DS_RATES, parquetPath: oddRates.file }, plan) === null);
  ok('a bad code never reaches SQL', (() => {
    try { fr.fxRelationSql(SRC, DS_RATES, { target: "US'; --", cols: plan.cols }); return false; } catch (_) { return true; }
  })());
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
finish();
