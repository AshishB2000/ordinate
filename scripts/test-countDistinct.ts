// Count distinct non-empty values (semantic layer part 5, D1–D3): one JS reference (src/analysis/countDistinct.ts)
// and its resident SQL twin (src/engine/countDistinctSql.ts), held together with Object.is on every case, then
// carried through the doors that compute a figure on an extract dataset.
//
//   pure       the rule, against hand-stated counts (the only non-differential section)
//   resident   computeMetric on the hydrated rows = computeMetricResident in place, ≥ 1,000-row datasets
//   prepare    the group step counts distinct per group
//   doors      charts ("Other" folded before counting), pivots and their totals, KPIs, a related filter: each cell is
//              countDistinct over that cell's rows, and resident = the JS reference, byte for byte
//
// NEGATIVE CONTROLS: a plain count of the same column is a different figure; the per-region bars do not add up to the
// KPI when customers cross regions; "Other" is not the sum of its cities.
//
//   npm run build:ts && node scripts/test-countDistinct.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');
const crypto: typeof import('crypto') = require('crypto');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-countd-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const metricValue: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const queryCache: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each handler's reply is narrowed where it is read
const { countDistinct }: typeof import('../src/analysis/countDistinct') = require('../src/analysis/countDistinct');

type Cell = string | number | null;
type Kind = 'text' | 'number' | 'date';
const show = (v: unknown): string => String(JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x))).slice(0, 400);
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

  // ── doors: charts, pivots, KPIs and a related filter on an extract ──────────
  // ORDERS: 1,200 rows; customer k = i % 300 orders 4 times. Its region is fixed (k % 4), its city is not: 3 of its
  // orders land in cities k, k+1, k+2 (mod 60), the 4th in city k % 7, so 60 cities (> 50: "Other" folds) of
  // uneven distinct counts, and a customer crosses neighbouring cities, the folded ones too. CROSS: the same, but 40 customers also order in a 2nd region.
  ipcVisuals.register();
  const viz = handlers.get('visual:data')!;
  const OCOLS = [{ name: 'customer_id', type: 'text' }, { name: 'city', type: 'text' }, { name: 'region', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }];
  const orders = (cross: boolean): Cell[][] => Array.from({ length: 1200 }, (_, i) => {
    const k = i % 300, j = Math.floor(i / 300);
    const d = new Date(Date.UTC(2024, 0, 1 + ((i * 37) % 366)));
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const day = i % 2 ? `${m}/${dd}/${y}` : `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    return [`c${k}`, `city${j < 3 ? (k + j) % 60 : k % 7}`, `R${(cross && k < 40 && j === 1 ? k + 1 : k) % 4}`, day, (i % 97) + 0.5];
  });
  const ROWS_O = orders(false), ROWS_X = orders(true);
  const save = async (name: string, columns: object[], rows: Cell[][]): Promise<string> => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows } as any))!.id; // any: as above
  const D = await save('orders', OCOLS, ROWS_O);
  const DX = await save('orders across regions', OCOLS, ROWS_X);
  const CUST = await save('customers', [{ name: 'customer_id', type: 'text' }, { name: 'segment', type: 'text' }], Array.from({ length: 350 }, (_, k) => [`c${k}`, k % 3 === 0 ? 'Pro' : 'Free'])); // c300–c349 never ordered
  await rels.saveRelationship(P, { from: { datasetId: D, column: 'customer_id' }, to: { datasetId: CUST, column: 'customer_id' }, cardinality: 'many_to_one' });
  const M = { column: 'customer_id', aggregation: 'countd' };
  const ref = (rows: Cell[][], keep: (r: Cell[]) => boolean): number => countDistinct(rows.filter(keep).map((r) => r[0]), 'text');
  const chartOn = async (datasetId: string, encoding: object): Promise<any> => viz(null, { projectId: P, datasetId, encoding }); // any: the visual:data reply
  const chart = (encoding: object): Promise<any> => chartOn(D, encoding); // any: as above
  const hydrated: string[] = [];
  const realGet = datasets.getDataset;
  (datasets as { getDataset: typeof realGet }).getDataset = (projectId: string, id: string) => {
    hydrated.push(id);
    return realGet(projectId, id);
  };
  const withoutResident = async <T>(fn: () => Promise<T>): Promise<T> => {
    const real = datasets.residentSource;
    (datasets as { residentSource: typeof real }).residentSource = async () => null; // the chart door's fast path asks it: withheld, it hydrates
    try {
      queryCache.invalidateDataset(D, P);
      return await fn();
    } finally {
      (datasets as { residentSource: typeof real }).residentSource = real;
      queryCache.invalidateDataset(D, P);
    }
  };
  const fastSlow = async (enc: object): Promise<[any, any, boolean]> => { // any: the visual:data reply
    queryCache.invalidateDataset(D, P);
    const from = hydrated.length;
    const fast = await chart(enc);
    const inPlace = !hydrated.slice(from).includes(D);
    return [fast, await withoutResident(() => chart(enc)), inPlace];
  };

  const byCity = await chart({ category: 'city', values: [M] });
  const kept = new Set<string>((byCity.data?.labels ?? []).filter((l: string) => l !== 'Other'));
  const otherAt = byCity.data?.labels.indexOf('Other') ?? -1;
  const otherCities = [...new Set(ROWS_O.map((r) => r[1] as string))].filter((c) => !kept.has(c));
  const refOther = ref(ROWS_O, (r) => !kept.has(r[1] as string));
  ok('a chart by city draws a distinct count and folds 10 cities into "Other"', byCity.ok === true && kept.size === 50 && otherAt === 50 && otherCities.length === 10, show(byCity).slice(0, 300));
  ok('"Other" is the distinct count of its rows', Object.is(byCity.data?.series[0].values[otherAt], refOther), show([byCity.data?.series[0].values[otherAt], refOther]));
  ok('NEGATIVE CONTROL: … not a sum of its cities', otherCities.reduce((a, c) => a + ref(ROWS_O, (r) => r[1] === c), 0) !== refOther);
  ok('every kept city is the distinct count of its rows', [...kept].every((c) => Object.is(byCity.data.series[0].values[byCity.data.labels.indexOf(c)], ref(ROWS_O, (r) => r[1] === c))));
  for (const enc of [{ category: 'city', values: [M] }, { category: 'region', values: [M] }, { category: 'day', grain: 'month', values: [M] }, { category: 'day', grain: 'month', series: 'region', values: [M] }]) {
    const [fast, slow, inPlace] = await fastSlow(enc);
    ok(`resident = JS, byte for byte: ${JSON.stringify(enc)}`, fast.ok === true && JSON.stringify(fast.data) === JSON.stringify(slow.data) && JSON.stringify(fast.category) === JSON.stringify(slow.category), show([fast.data, slow.data]));
    if (!('series' in enc)) ok(`… and the fast draw ran in place: ${JSON.stringify(enc)}`, inPlace); // a split is drawn by the JS reference today
  }
  const month = (day: string): number => Number(day.includes('/') ? day.split('/')[0] : day.slice(5, 7));
  const quarter = (r: Cell[]): number => Math.floor((month(r[3] as string) - 1) / 3);
  const pivotEnc = { category: 'region', values: [M], pivot: { rows: [{ column: 'region' }], columns: [{ column: 'day', grain: 'quarter' }], values: [M], totals: { rows: true, columns: true, grand: true } } };
  const [pv, pvSlow, pvInPlace] = await fastSlow(pivotEnc);
  const grid = pv.data?.pivot;
  const regions = (grid?.rowHeaders ?? []).map((h: string[]) => h[h.length - 1]);
  ok('a pivot of a distinct count draws', pv.ok === true && !!grid && regions.length === 4, show(pv).slice(0, 400));
  ok('pivot: each cell is the distinct count of its rows', regions.every((g: string, ri: number) => grid.cells[ri].every((v: number | null, ci: number) => Object.is(v, ref(ROWS_O, (r) => r[2] === g && quarter(r) === ci)))), show(grid?.cells));
  ok('pivot: each row total is the distinct count of its rows, never a sum of its quarters', regions.every((g: string, ri: number) => Object.is(grid.rowTotals[ri][0], ref(ROWS_O, (r) => r[2] === g)) && grid.rowTotals[ri][0] !== grid.cells[ri].reduce((a: number, b: number) => a + b, 0)), show(grid?.rowTotals));
  ok('pivot: each column total is the distinct count of its rows', grid?.colTotals?.every((v: number | null, ci: number) => Object.is(v, ref(ROWS_O, (r) => quarter(r) === ci))), show(grid?.colTotals));
  ok('pivot: the grand total is 300', Object.is(grid?.grand?.[0], 300), show(grid?.grand));
  ok('pivot: resident = JS, byte for byte, and the fast draw ran in place', JSON.stringify(pv.data) === JSON.stringify(pvSlow.data) && pvInPlace, show([pv.data?.pivot?.colTotals, pvSlow.data?.pivot?.colTotals]));

  const kpiOn = async (datasetId: string, filters: object[] = []): Promise<number | null> => (await dashboards.computeCardMetric(P, datasetId, M as never, filters as never)).value;
  const residentBefore = trace.snapshot().metric?.resident ?? 0;
  ok('the KPI is the distinct count of the table (300)', Object.is(await kpiOn(D), 300));
  ok('… computed in place', (trace.snapshot().metric?.resident ?? 0) > residentBefore, show(trace.snapshot().metric));
  ok('KPI = the sum of the bars by region, where regions share no customer', (await chart({ category: 'region', values: [M] })).data.series[0].values.reduce((a: number, b: number) => a + b, 0) === 300);
  const refPro = ref(ROWS_O, (r) => Number((r[0] as string).slice(1)) % 3 === 0);
  ok('a related filter counts over the orders in scope ("customers who ordered")', Object.is(await kpiOn(D, [eq('segment', 'Pro')]), refPro) && refPro === 100, show([await kpiOn(D, [eq('segment', 'Pro')]), refPro]));
  const xBars = (await chartOn(DX, { category: 'region', values: [M] })).data.series[0].values.reduce((a: number, b: number) => a + b, 0);
  ok('NEGATIVE CONTROL: the sum of the bars by region is not the KPI when customers cross regions', xBars !== (await kpiOn(DX)) && (await kpiOn(DX)) === 300, show([xBars, await kpiOn(DX)]));

  // Old content draws byte-identically: every plain aggregation's chart, split, pivot and KPI (a related filter too) on
  // ORDERS, hashed. The hash was taken on p5-01's tip (db42ab5b) and on this branch, and they agreed; never re-record it.
  const plain: unknown[] = [];
  for (const agg of ['sum', 'avg', 'count', 'min', 'max']) {
    const v = { column: agg === 'count' ? 'customer_id' : 'amount', aggregation: agg };
    for (const enc of [{ category: 'city', values: [v] }, { category: 'region', values: [v] }, { category: 'day', grain: 'month', series: 'region', values: [v] },
      { category: 'region', values: [v], pivot: { rows: [{ column: 'region' }], columns: [{ column: 'day', grain: 'quarter' }], values: [v], totals: { rows: true, columns: true, grand: true } } }]) {
      const rep = await chart(enc);
      plain.push([rep.ok, rep.data, rep.warnings, rep.category]);
    }
    for (const f of [[], [eq('segment', 'Pro')], [eq('region', 'R1')]]) plain.push(await dashboards.computeCardMetric(P, D, v as never, f));
  }
  const pinned = JSON.stringify(plain, (_k, x) => (Object.is(x, -0) ? '-0' : x));
  ok('plain measures draw byte-identically (sha256 pinned at p5-01\'s tip)', crypto.createHash('sha256').update(pinned).digest('hex') === '5fe5196f0802683ac73f094491516475380dd882f45d450faf7b6f8f13996033', pinned.slice(0, 300));

  finish();
})();
