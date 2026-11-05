// Count distinct non-empty values (semantic layer part 5, D1–D3): one JS reference (src/analysis/countDistinct.ts)
// and its resident SQL twin (src/engine/countDistinctSql.ts), held together with Object.is on every case, then
// carried through the doors that compute a figure on an extract dataset.
//
//   pure       the rule, against hand-stated counts (the only non-differential section)
//   resident   computeMetric on the hydrated rows = computeMetricResident in place, ≥ 1,000-row datasets
//   prepare    the group step counts distinct per group
//
// NEGATIVE CONTROL: a plain count of the same column is a different figure.
//
//   npm run build:ts && node scripts/test-countDistinct.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-countd-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const metricValue: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const { countDistinct }: typeof import('../src/analysis/countDistinct') = require('../src/analysis/countDistinct');

type Cell = string | number | null;
type Kind = 'text' | 'number' | 'date';
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x)).slice(0, 400);
const eq = (column: string, value: string) => ({ type: 'filter' as const, column, op: '=' as const, value });

const CASES: Array<[string, Kind, Cell[], number]> = [
  ['text: case, padding, blanks', 'text', ['a', 'A', ' a', 'a ', '', '   ', null, 'a'], 4],
  ['number: 1 = 1.0, -0 = 0', 'number', [1, 1.0, -0, 0, 2.5, null, 'n/a'], 3],
  ['date: both shapes, with times, unreadable', 'date', ['2024-03-01', '03/01/2024', '2024-03-01T10:00:00', '2024-03-02', 'soon', '', null], 2],
  ['empty scope', 'text', [], 0],
];

void (async () => {
  // ── pure: the rule ──────────────────────────────────────────────────────────
  for (const [name, type, cells, want] of CASES) ok(`JS ${name}`, Object.is(countDistinct(cells, type), want), show(countDistinct(cells, type)));
  ok('JS: a non-number cell in a number column is not a value', countDistinct(['1', 1], 'number') === 1);
  ok('JS: NaN and ±Infinity are not values', countDistinct([NaN, Infinity, -Infinity, 1], 'number') === 1);
  ok('JS: an impossible date is not a day', countDistinct(['2024-02-30', '2024-02-29'], 'date') === 1);

  // ── resident: the twin, in place, on ≥ 1,000-row datasets ───────────────────
  await projects.init();
  const P = (await projects.createProject('Count distinct')).id;
  const FILLER: Record<Kind, (i: number) => Cell> = { text: (i) => `z${i}`, number: (i) => 1000 + i, date: (i) => `2025-01-${String((i % 28) + 1).padStart(2, '0')}` };
  const saved = async (type: Kind, cells: Cell[]): Promise<{ id: string; columns: any; rows: Cell[][] }> => { // any: the dataset column shape
    const rows: Cell[][] = [];
    for (let i = 0; rows.length < 600 && cells.length > 0; i += 1) rows.push(['a', cells[i % cells.length]]);
    for (let i = 0; rows.length < 1200; i += 1) rows.push(['b', FILLER[type](i)]);
    const columns = [{ name: 'grp', type: 'text' }, { name: 'v', type }];
    const id = (await datasets.saveDataset(P, { name: `countd ${type} ${rows.length}`, sourceKind: 'csv', columns, rows } as any))!.id; // any: the sibling suites' save shape
    const back = (await datasets.getDataset(P, id))!;
    return { id, columns: back.columns, rows: back.rows };
  };
  const SPEC = { column: 'v', aggregation: 'countd' as const };
  for (const [name, type, cells] of CASES) {
    const d = await saved(type, cells);
    const scope = [eq('grp', 'a')];
    const js = metricValue.computeMetric(d.columns, transforms.applyPipeline({ columns: d.columns, rows: d.rows }, scope).rows, SPEC);
    const src = (await datasets.residentSource(P, d.id))!;
    const got = await residentQuery.computeMetricResident(src, SPEC, scope);
    ok(`JS door = the reference: ${name}`, Object.is(js, countDistinct(cells, type)), show([js, cells]));
    ok(`resident = JS: ${name}`, got !== null && Object.is(got, js), show([got, js]));
    const whole = await residentQuery.computeMetricResident(src, SPEC);
    ok(`resident = JS, the whole table: ${name}`, Object.is(whole, metricValue.computeMetric(d.columns, d.rows, SPEC)), show([whole, metricValue.computeMetric(d.columns, d.rows, SPEC)]));
  }
  {
    // -0 never reaches storage (String(-0) is "0"), so the SQL twin's `+ 0.0` is pinned on DuckDB's own -0.0.
    const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
    const { countDistinctSql }: typeof import('../src/engine/countDistinctSql') = require('../src/engine/countDistinctSql');
    const out = await duck.queryAsync(`SELECT ${countDistinctSql('x', 'number')} AS n FROM (VALUES ('-0'), ('0'), ('-0.0'), ('1'), ('1.0'), (NULL), ('n/a')) t(x)`);
    ok('SQL: -0 and 0 are one value, 1 and 1.0 are one', Object.is(Number(out[0].n), 2), show(out));
  }
  const ROWS: Cell[][] = Array.from({ length: 30 }, (_, i) => [`g${i % 3}`, `c${i % 7}`]);
  const C = [{ name: 'grp', type: 'text' }, { name: 'v', type: 'text' }] as any; // any: the dataset column shape
  ok('NEGATIVE CONTROL: plain count is not countd', metricValue.computeMetric(C, ROWS, { column: 'v', aggregation: 'count' }) !== metricValue.computeMetric(C, ROWS, SPEC));

  // ── prepare: the group step ─────────────────────────────────────────────────
  const G = { type: 'group_aggregate', groupBy: ['grp'], aggregations: [{ column: 'v', fn: 'countd', as: 'n' }] };
  const want = ['g0', 'g1', 'g2'].map((g) => [g, countDistinct(ROWS.filter((r) => r[0] === g).map((r) => r[1]), 'text')]);
  const grouped = transforms.applyPipeline({ columns: C, rows: ROWS.map((r) => [...r]) }, [G as never]);
  ok('Prepare group step: countd per group', isDeepStrictEqual(grouped.rows, want) && grouped.warnings.length === 0, show(grouped));

  finish();
})();
