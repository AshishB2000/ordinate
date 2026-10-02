// Differential self-check: engine/lodResident.ts (the grouped subquery joined
// back on the dimensions) against formula/lod.ts and analysis/lodQuery.ts (the
// JS reference), `Object.is`, row by row, over the SAME Parquet bytes — on a
// fixture built to break the join (null, '', whitespace and tab keys, a null
// number key, missing measures) and on the bundled sample.
//
// Skipped, not failed, without a DuckDB bridge — the rule every resident suite
// follows.
//
//   npm run build:ts && node scripts/test-lod-resident.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ok, failureCount } from './selfcheck';
import * as pq from '../src/engine/parquetStore';
import * as duck from '../src/engine/duckdb';
import { lodMetricResident, lodValuesResident } from '../src/engine/lodResident';
import { compile } from '../src/formula/formula';
import { lodGroupDims, lodValues } from '../src/formula/lod';
import { lodMetricValue } from '../src/analysis/lodQuery';
import { applyPipeline } from '../src/data/transforms';
import { parseCsv } from '../src/data/parse';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';
import type { MetricAggregation } from '../src/analysis/metricValue';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-lod-'));
let seq = 0;

interface Fx {
  src: { parquetPath: string; columns: ParsedColumn[] };
  columns: ParsedColumn[];
  rows: Cell[][];
}

/** Write, read back, and compare against what was READ — the post-round-trip cells. */
function fixture(columns: ParsedColumn[], rows: Cell[][]): Fx {
  const file = path.join(dir, `t${seq++}.parquet`);
  pq.writeTable(file, columns, rows);
  const back = pq.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { src: { parquetPath: file, columns }, columns: back.columns, rows: back.rows };
}

function firstDiff(a: unknown[], b: unknown[]): string {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  const i = a.findIndex((v, k) => !Object.is(v, b[k]));
  return i < 0 ? '' : `row ${i}: js ${JSON.stringify(a[i])} vs sql ${JSON.stringify(b[i])}`;
}

/** One LOD, every context-filter set: JS reference vs SQL, row by row. */
function diffValues(label: string, f: Fx, expr: string, vizDims: string[], contexts: FilterStep[][]): void {
  const c = compile(expr);
  if (!c.ok || c.fn.lods.length !== 1 || !c.fn.lods[0].argCol) {
    ok(`${label}: ${expr} compiles to one bare-column LOD`, false, c.ok ? 'shape' : c.error);
    return;
  }
  const spec = c.fn.lods[0];
  for (const ctx of contexts) {
    const t = ctx.length ? applyPipeline({ columns: f.columns, rows: f.rows }, ctx) : { columns: f.columns, rows: f.rows };
    const js = lodValues([spec], t.columns, t.rows, { vizDims })[0];
    const sql = lodValuesResident(f.src, { groupDims: lodGroupDims(spec, vizDims), agg: spec.agg, argCol: spec.argCol as string }, ctx);
    const tag = `${label}: ${expr}${vizDims.length ? ` in [${vizDims.join(', ')}]` : ''}${ctx.length ? ` | ctx ${JSON.stringify(ctx.map((s) => [s.column, s.op, s.value ?? s.values]))}` : ''}`;
    ok(tag, sql !== null && firstDiff(js, sql) === '', sql === null ? 'resident returned null' : firstDiff(js, sql));
  }
}

function diffMetric(label: string, f: Fx, expr: string, agg: MetricAggregation, filters: FilterStep[]): void {
  const c = compile(expr);
  if (!c.ok) { ok(`${label}: compiles`, false, c.error); return; }
  const spec = c.fn.lods[0];
  const js = lodMetricValue(f.columns, f.rows, [], { column: expr, aggregation: agg }, filters);
  const sql = lodMetricResident(f.src, { groupDims: lodGroupDims(spec), agg: spec.agg, argCol: spec.argCol as string }, agg,
    filters.filter((s) => s.context), filters.filter((s) => !s.context));
  ok(`${label}: ${agg}(${expr}) under ${filters.map((s) => (s.context ? 'ctx ' : '') + s.column + s.op + String(s.value ?? s.values)).join(', ') || 'no filter'}`,
    Object.is(js, sql), `js ${js} vs sql ${sql}`);
}

// ── The adversarial fixture ──────────────────────────────────────────────────

const COLS: ParsedColumn[] = [
  { name: 'g', type: 'text' },
  { name: 'n', type: 'number' },
  { name: 'v', type: 'number' },
  { name: 't', type: 'text' },
  { name: 'code', type: 'text' },
];
const G = ['a', '', '  ', null, 'b', '\t', 'A'];
const T = ['x', '', ' ', null, 'y', 'z', 'x'];

function edgeFixture(): Fx {
  const rows: Cell[][] = [];
  for (let i = 0; i < 400; i++) {
    rows.push([
      G[i % G.length],
      i % 11 === 0 ? null : i % 4,
      i % 9 === 0 ? null : (i * 7) % 23 - 5, // integers, some negative, some missing
      T[(i * 3) % T.length],
      String(i % 13).padStart(3, '0'), // '007' must stay text
    ]);
  }
  return fixture(COLS, rows);
}

function testEdges(): void {
  const f = edgeFixture();
  const ctxs: FilterStep[][] = [
    [],
    [{ type: 'filter', column: 'g', op: 'in', values: ['a', '', '  '], context: true }],
    [{ type: 'filter', column: 'v', op: '>=', value: 3, context: true }],
    [{ type: 'filter', column: 't', op: 'not_empty', context: true }],
  ];
  diffValues('edge', f, '{FIXED [g] : SUM([v])}', [], ctxs);
  diffValues('edge', f, '{FIXED [g], [n] : AVG([v])}', [], ctxs);
  diffValues('edge', f, '{FIXED : COUNT([t])}', [], ctxs);
  diffValues('edge', f, '{FIXED [n] : COUNTD([t])}', [], ctxs);
  diffValues('edge', f, '{FIXED [g] : COUNTD([n])}', [], ctxs);
  diffValues('edge', f, '{FIXED [t] : COUNTD([code])}', [], ctxs);
  diffValues('edge', f, '{FIXED [g] : MIN([v])}', [], ctxs);
  diffValues('edge', f, '{FIXED [code] : MAX([v])}', [], ctxs);
  diffValues('edge', f, '{FIXED [g] : SUM([t])}', [], ctxs.slice(0, 1)); // text: null on both sides
  diffValues('edge', f, '{INCLUDE [n] : SUM([v])}', ['g'], ctxs);
  diffValues('edge', f, '{EXCLUDE [g] : SUM([v])}', ['g', 'n'], ctxs);
  diffValues('edge', f, '{EXCLUDE [g] : COUNT([v])}', ['g'], ctxs.slice(0, 2));

  // The preview reads the first rows only — the same values, in order.
  const c = compile('{FIXED [g] : SUM([v])}');
  if (c.ok) {
    const s = c.fn.lods[0];
    const head = lodValuesResident(f.src, { groupDims: lodGroupDims(s), agg: s.agg, argCol: 'v' }, [], 8);
    const js = lodValues([s], f.columns, f.rows)[0].slice(0, 8);
    ok('edge: LIMIT 8 is the first eight rows of the whole-table answer', head !== null && firstDiff(js, head) === '', head ? firstDiff(js, head) : 'null');
  }

  // Declines — the caller then runs the reference.
  const decline = (label: string, lod: Parameters<typeof lodValuesResident>[1]): void =>
    ok(`edge: declines ${label}`, lodValuesResident(f.src, lod, []) === null);
  decline('MIN of a text column (the date rule is JS-only)', { groupDims: ['g'], agg: 'min', argCol: 't' });
  decline('an unknown argument column', { groupDims: ['g'], agg: 'sum', argCol: 'nope' });
  decline('an unknown dimension', { groupDims: ['nope'], agg: 'sum', argCol: 'v' });

  // Metrics over an LOD: context inside, ordinary after.
  const ctxA: FilterStep = { type: 'filter', column: 'g', op: '=', value: 'a', context: true };
  const normA: FilterStep = { type: 'filter', column: 'g', op: '=', value: 'a' };
  const big: FilterStep = { type: 'filter', column: 'v', op: '>=', value: 0 };
  for (const agg of ['sum', 'avg', 'min', 'max', 'count'] as MetricAggregation[]) {
    diffMetric('edge metric', f, '{FIXED [g] : SUM([v])}', agg, []);
    diffMetric('edge metric', f, '{FIXED : SUM([v])}', agg, [normA]);
    diffMetric('edge metric', f, '{FIXED : SUM([v])}', agg, [ctxA]);
    diffMetric('edge metric', f, '{FIXED [n] : COUNTD([t])}', agg, [ctxA, big]);
  }
}

// ── The bundled sample ───────────────────────────────────────────────────────

function testSample(): void {
  const csv = path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv');
  if (!fs.existsSync(csv)) { ok('sample: assets/samples/retail-orders.csv exists', false, csv); return; }
  const parsed = parseCsv(fs.readFileSync(csv, 'utf8'), ',');
  const f = fixture(parsed.columns, parsed.rows);
  const east: FilterStep[][] = [[], [{ type: 'filter', column: 'region', op: '=', value: 'East', context: true }]];
  diffValues('sample', f, '{FIXED [region] : SUM([revenue])}', [], east);
  diffValues('sample', f, '{FIXED [category], [region] : AVG([profit])}', [], east);
  diffValues('sample', f, '{FIXED [state] : MAX([ship_days])}', [], east);
  diffValues('sample', f, '{FIXED : COUNTD([state])}', [], east);
  diffValues('sample', f, '{INCLUDE [customer_segment] : COUNT([units])}', ['region'], east);
  diffValues('sample', f, '{EXCLUDE [region] : SUM([units])}', ['region', 'category'], east);
  diffValues('sample', f, '{FIXED [order_date] : MIN([discount])}', [], east);
  diffMetric('sample metric', f, '{FIXED [region] : SUM([units])}', 'max', east[1]);
  diffMetric('sample metric', f, '{FIXED [customer_segment] : COUNT([units])}', 'avg', [{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
}

function main(): void {
  let bridge = false;
  try { bridge = duck.isAvailable(); } catch { bridge = false; }
  if (!bridge) {
    console.log('ok   (skipped) the DuckDB bridge is unavailable — differential not run');
  } else {
    testEdges();
    testSample();
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failureCount() ? 1 : 0);
}

main();
