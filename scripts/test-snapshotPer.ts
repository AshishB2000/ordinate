// A snapshot per entity (semantic layer part 5, D11): MRR is each account's own last MRR, summed, even for accounts
// that last reported in different months. After every filter, the row lock and terms, each entity keeps its rows on
// its own latest (or earliest) day, per date bucket when charted by the snapshot's date, then the usual aggregate.
//
// DIFFERENTIAL throughout: the resident twin (engine/snapshotResident: a DuckDB temp table read in place) against the
// row-level JS reference (analysis/snapshot.snapshotRows with `per`), with Object.is. Whole-number figures, so
// DuckDB's parallel sum and a JS fold agree exactly.
//
//   twin   the reference's partitions and the twin held to it
//   doors  the KPI and chart doors: the store, the words, the notes, the cache, the refusals; old snapshots unchanged
//   (the row lock: scripts/test-snapshotPerRowLock.ts, on Postgres; Live: scripts/test-metricMeasures.ts section 10)
//
//   npm run build:ts && node scripts/test-snapshotPer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshot-per-'));

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const dashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const fxStore: typeof import('../src/app/fxStore') = require('../src/app/fxStore');
const { metrics: api }: typeof import('../src/api/metrics') = require('../src/api/metrics');
const { describeDefinition }: typeof import('../src/analysis/metricFormat') = require('../src/analysis/metricFormat');
const { buildVizData }: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const { createHash }: typeof import('crypto') = require('crypto');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');
const { metricLines }: typeof import('../src/ai/copilotFacts') = require('../src/ai/copilotFacts');
const { followedMeasureTexts }: typeof import('../src/ipc/copilotMeasures') = require('../src/ipc/copilotMeasures');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const snap: typeof import('../src/analysis/snapshot') = require('../src/analysis/snapshot');
const twin: typeof import('../src/engine/snapshotResident') = require('../src/engine/snapshotResident');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const { computeMetric }: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const { periodDay }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const { dateBucket, parseDateCell }: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
type FilterStep = import('../src/data/transforms').FilterStep;
type Cell = import('../src/data/transforms').Cell;
type MetricSnapshot = import('../src/analysis/snapshot').MetricSnapshot;
type DateGrain = import('../src/analysis/categoryKey').DateGrain;
type Agg = import('../src/analysis/metricValue').MetricAggregation;

type Any = any; // any: a fixture's loose shapes, read field by field below
const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 600);
const pad = (n: number): string => String(n).padStart(2, '0');

// ── The MRR fixture ──────────────────────────────────────────────────────────
// The 1st of each month 2023-01..2024-10, ISO on even rows and US on odd ones. 60 accounts, three of them empty
// ('' and '  ' report to the end, null stops in 2024-05). A7 stops reporting after 2024-03; A9 moves from East to West
// in 2024-06; A3 has two rows on its last day (a tie). Twelve rows have no month at all.
const COLS = [{ name: 'month', type: 'date' }, { name: 'account', type: 'text' }, { name: 'region', type: 'text' }, { name: 'mrr', type: 'number' }] as Any;
const MONTHS: string[] = [];
for (let y = 2023; y <= 2024; y += 1) for (let m = 1; m <= 12; m += 1) if (y === 2023 || m <= 10) MONTHS.push(`${y}-${pad(m)}-01`);
const ACCOUNTS: Cell[] = [...Array.from({ length: 57 }, (_, i) => `A${i}`), '', '  ', null];
const isEmptyEntity = (c: Cell): boolean => c === null || String(c).trim() === '';
const spell = (iso: string, i: number): string => (i % 2 ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}` : iso);
const ROWS: Cell[][] = [];
MONTHS.forEach((iso, m) => {
  ACCOUNTS.forEach((account, a) => {
    if (account === 'A7' && iso > '2024-03-01') return;
    if (account === null && iso > '2024-05-01') return;
    const region = account === 'A9' ? (iso >= '2024-06-01' ? 'West' : 'East') : ['East', 'West', 'North'][a % 3];
    ROWS.push([spell(iso, ROWS.length), account, region, ((a * 7 + m * 3) % 200) + 10]);
  });
});
ROWS.push([spell(MONTHS[MONTHS.length - 1], ROWS.length), 'A3', 'North', 5]); // A3's tie on its last day
for (let i = 0; i < 12; i += 1) ROWS.push(['', `A${i}`, 'East', 999]);
const LAST_DAY = new Map<string, number>(); // account → its own last day (empties as one)
for (const r of ROWS) {
  const d = periodDay(r[0]);
  const k = isEmptyEntity(r[1]) ? '' : String(r[1]);
  if (d !== null && d > (LAST_DAY.get(k) ?? -Infinity)) LAST_DAY.set(k, d);
}

void (async () => {
  await projects.init();
  ipcVisuals.register();
  ipcMetrics.register();
  const pid = (await projects.createProject('Snapshot per')).id;
  const ds = (await datasets.saveDataset(pid, { name: 'MRR', sourceKind: 'csv', columns: COLS, rows: ROWS } as Any))!.id;
  // The number-keyed copy: `1` and `1.0` (as stored text) are one account, by value. An empty number cell is null (parse.ts).
  const NCOLS = [{ name: 'month', type: 'date' }, { name: 'account', type: 'number' }, { name: 'region', type: 'text' }, { name: 'mrr', type: 'number' }] as Any;
  const NROWS = ROWS.map((r, i) => [r[0], typeof r[1] === 'string' && /^A\d+$/.test(r[1]) ? (r[1] === 'A1' && i % 2 ? '1.0' : Number(r[1].slice(1))) : null, r[2], r[3]]);
  const dsN = (await datasets.saveDataset(pid, { name: 'MRRN', sourceKind: 'csv', columns: NCOLS, rows: NROWS } as Any))!.id;
  const src = (await datasets.residentSource(pid, ds))!;
  const srcN = (await datasets.residentSource(pid, dsN))!;
  const TABLE = (await datasets.getDataset(pid, ds))!;
  const TABLE_N = (await datasets.getDataset(pid, dsN))!;

  // ── twin ───────────────────────────────────────────────────────────────────
  const S = { column: 'month', take: 'last', per: 'account' } as const;
  const bucketOf = (grain: DateGrain | null) => (grain ? (row: Cell[]) => { const c = parseDateCell(row[0]); return c ? String(dateBucket(c, grain)) : null; } : undefined);
  const ref = (rows: Cell[][], part?: (r: Cell[]) => string | null) => snap.snapshotRows(COLS, rows, S, part);
  const kept = ref(TABLE.rows);
  ok('fixture: above the resident threshold, a resident source for both tables', ROWS.length > 1_000 && !!src && !!srcN, show([ROWS.length, !!src, !!srcN]));
  ok('each account keeps its own last month', kept.length > 0 && kept.every((r) => periodDay(r[0]) === LAST_DAY.get(isEmptyEntity(r[1]) ? '' : String(r[1]))), show(kept.slice(0, 4)));
  ok('every account is there', new Set(kept.map((r) => (isEmptyEntity(r[1]) ? '' : r[1]))).size === 58);
  ok('a stopped account still counts its last value', kept.some((r) => r[1] === 'A7' && periodDay(r[0]) === periodDay('2024-03-01')));
  ok('a tie keeps both rows', kept.filter((r) => r[1] === 'A3').length === 2);
  ok('empty accounts are one partition, not dropped: the null account\'s older month is not kept', kept.filter((r) => isEmptyEntity(r[1])).length === 2 && !kept.some((r) => r[1] === null), show(kept.filter((r) => isEmptyEntity(r[1]))));
  ok('A9 counts once, in West', kept.filter((r) => r[1] === 'A9').length === 1 && kept.filter((r) => r[1] === 'A9').every((r) => r[2] === 'West'));
  ok('an undated row is never kept', !kept.some((r) => r[0] === ''));
  const plainS = { column: 'month', take: 'last' } as const;
  const PART1 = TABLE.rows.filter((r) => periodDay(r[0]) === Math.max(...TABLE.rows.map((x) => periodDay(x[0]) ?? -Infinity)));
  ok('without per: part 1\'s rows exactly', isDeepStrictEqual(snap.snapshotRows(COLS, TABLE.rows, plainS), PART1) && isDeepStrictEqual(snap.snapshotRows(COLS, TABLE.rows, plainS, bucketOf('month')), TABLE.rows.filter((r) => r[0] !== '')));
  ok('a per column the table lacks keeps no row', snap.snapshotRows(COLS, TABLE.rows, { ...S, per: 'gone' }).length === 0);
  ok('by month: each account\'s own last row in each month (every dated row here: one row a month, the tie both)', ref(TABLE.rows, bucketOf('month')).length === TABLE.rows.filter((r) => r[0] !== '').length);

  const EAST = { type: 'filter', column: 'region', op: '=', value: 'East' } as FilterStep;
  const Y2024 = { type: 'filter', column: 'month', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-12-31' } } as FilterStep;
  const Y1999 = { type: 'filter', column: 'month', op: 'period', period: { preset: 'custom', from: '1999-01-01', to: '1999-12-31' } } as FilterStep;
  const FIRST = { column: 'month', take: 'first', per: 'account' } as const;
  let ran = 0;
  const residentKpiOn = (source: typeof src, s: MetricSnapshot & { per: string }, agg: Agg, filters: FilterStep[], bucket: DateGrain | null = null) =>
    twin.withSnapshotRows(source, filters, s, bucket, async (k) => { ran += 1; return residentQuery.computeMetricResident(k, { column: 'mrr', aggregation: agg }, []); });
  const jsKpiOn = (t: { columns: Any; rows: Cell[][] }, s: MetricSnapshot, agg: Agg, filters: FilterStep[], bucket: DateGrain | null = null) => {
    const f = transforms.applyPipeline({ columns: t.columns, rows: t.rows }, filters);
    return computeMetric(f.columns, snap.snapshotRows(f.columns, f.rows, s, bucketOf(bucket)), { column: 'mrr', aggregation: agg });
  };
  for (const [name, s, filters, bucket] of [
    ['no scope', S, [], null], ['East, 2024', S, [EAST, Y2024], null], ['by month', S, [], 'month'],
    ['by quarter, earliest', FIRST, [], 'quarter'], ['nothing in scope', S, [Y1999], null],
  ] as Array<[string, MetricSnapshot & { per: string }, FilterStep[], DateGrain | null]>) {
    for (const agg of ['sum', 'count', 'avg', 'max'] as const) {
      const before = ran;
      const got = await residentKpiOn(src, s, agg, filters, bucket);
      const want = jsKpiOn(TABLE, s, agg, filters, bucket);
      ok(`resident = JS: ${name}, ${agg}`, ran === before + 1 && Object.is(got, want), show([got, want]));
    }
  }
  ok('a real figure, not an empty one', typeof jsKpiOn(TABLE, S, 'sum', []) === 'number' && jsKpiOn(TABLE, S, 'count', [Y1999]) === 0);
  const before = ran;
  const gotN = await residentKpiOn(srcN, S, 'count', []);
  ok('number accounts by value: resident = JS', ran === before + 1 && Object.is(gotN, jsKpiOn(TABLE_N, S, 'count', [])), show([gotN, jsKpiOn(TABLE_N, S, 'count', [])]));
  ok('…and 1 and 1.0 are one account (57 named accounts, the empties one more)', new Set(snap.snapshotRows(NCOLS, TABLE_N.rows, S).map((r) => r[1])).size === 58);
  const tables = await duck.queryAsync("SELECT CAST(count(*) AS DOUBLE) AS n FROM duckdb_tables() WHERE table_name LIKE 'snap_%'", []);
  ok('the temp table is gone afterwards', tables[0].n === 0, show(tables));
  const failing = await twin.withSnapshotRows(src, [], S, null, async () => { throw new Error('boom'); }).catch(() => 'threw');
  const after = await duck.queryAsync("SELECT CAST(count(*) AS DOUBLE) AS n FROM duckdb_tables() WHERE table_name LIKE 'snap_%'", []);
  ok('…even when the run throws', failing === 'threw' && after[0].n === 0, show([failing, after]));
  ok('a source it cannot read: null, so the JS reference answers', (await twin.withSnapshotRows({ parquetPath: src.parquetPath, columns: COLS.slice(0, 1) }, [], S, null, async () => 1)) === null);
  ok('NEGATIVE CONTROL: per account is not the whole scope\'s last month', jsKpiOn(TABLE, S, 'sum', []) !== jsKpiOn(TABLE, plainS, 'sum', []), show([jsKpiOn(TABLE, S, 'sum', []), jsKpiOn(TABLE, plainS, 'sum', [])]));

  // ── doors ──────────────────────────────────────────────────────────────────
  type Metric = import('../src/analysis/metrics').Metric;
  const save = (input: object) => handlers.get('metric:save')!(null, { projectId: pid, input: { datasetId: ds, format: { kind: 'number' }, ...input } });
  const update = (id: string, patch: object) => handlers.get('metric:update')!(null, { projectId: pid, id, patch });
  const saved = async (name: string, definition: object, datasetId = ds, filters: object[] = []): Promise<Metric> => {
    const res = await save({ name, definition, datasetId, filters });
    if (!res.ok) throw new Error(`"${name}" not saved: ${show(res)}`);
    return res.metric as Metric;
  };
  const resolved = async (m: Metric, scope: FilterStep[]) => (await ipcMetrics.resolveMetric(pid, m.id, { filters: scope }))!;
  const kpi = async (m: Metric, scope: FilterStep[]) => (await resolved(m, scope)).value;
  const viz = handlers.get('visual:data')!;
  const chart = (encoding: object, filters: object[] = [], datasetId = ds): Promise<Any> => viz(null, { projectId: pid, datasetId, encoding, filters });
  const M = (m: Metric) => ({ column: m.name, aggregation: (m.definition as { aggregation: string }).aggregation, metricId: m.id });
  const blank = (r: Any) => (r && r.asOf ? { ...r, asOf: { ...r.asOf, at: '' } } : r);

  // Old content first: plain snapshot metrics reply as they did before this step (hash taken on 9d6edf79).
  const stock = await saved('Stock', { column: 'mrr', aggregation: 'sum', snapshot: { column: 'month', take: 'last' } });
  const opening = await saved('Opening', { column: 'mrr', aggregation: 'count', snapshot: { column: 'month', take: 'first' } });
  const eastStock = await saved('East stock', { column: 'mrr', aggregation: 'avg', snapshot: { column: 'month', take: 'last' } }, ds, [EAST]);
  const oldReplies: unknown[] = [];
  for (const m of [stock, opening, eastStock]) {
    for (const scope of [[], [Y2024], [EAST], [Y1999]]) {
      const { id: _id, ...rest } = await resolved(m, scope);
      oldReplies.push(rest);
    }
    for (const enc of [{ category: 'region', values: [M(m)] }, { category: 'month', grain: 'quarter', values: [M(m)] }, { category: 'month', grain: 'month', series: 'region', values: [M(m)] }, { category: 'month', values: [M(m)] }]) {
      oldReplies.push(blank(await chart(enc)), blank(await chart(enc, [Y2024])));
    }
  }
  const OLD_PIN = createHash('sha256').update(JSON.stringify(oldReplies)).digest('hex');
  ok('old content: plain snapshot metrics reply byte for byte as before (KPIs and charts)', OLD_PIN === '5752caa780b4a964ef0c91ef4040f2961d44af365ec02c89a69e4d54f4ea463d', OLD_PIN);

  ok('contract: save takes per', api['metric:save'].input.safeParse({ projectId: pid, input: { name: 'S', datasetId: ds, definition: { column: 'mrr', aggregation: 'sum', snapshot: S } } }).success);
  ok('contract: update takes per: null', api['metric:update'].input.safeParse({ projectId: pid, id: ds, patch: { definition: { column: 'mrr', aggregation: 'sum', snapshot: { column: 'month', take: 'last', per: null } } } }).success);
  ok('NEGATIVE CONTROL: contract: per is a name, not an empty one', !api['metric:save'].input.safeParse({ projectId: pid, input: { name: 'S', datasetId: ds, definition: { column: 'mrr', aggregation: 'sum', snapshot: { ...S, per: '' } } } }).success);
  const mrr = await saved('MRR', { column: 'mrr', aggregation: 'sum', snapshot: S });
  ok('saved with its per', isDeepStrictEqual((mrr.definition as Any).snapshot, S), show(mrr));
  ok('words', describeDefinition(mrr) === "sum of mrr, on each account's latest month", describeDefinition(mrr));
  const said: string[] = [];
  metricLines(said, [], [{ name: 'MRR', definitionText: 'sum of mrr', value: 5, display: '5', snapshot: S }]);
  ok('the Assistant is told it is each account\'s own latest value', said.join('\n').includes("Snapshot: each account's own value on its latest month in the period, not a sum over dates."), said.join('\n'));
  ok('…and a chart\'s facts say so', (await followedMeasureTexts(pid, ds, { category: 'region', values: [M(mrr)] } as Any, {}))[0] === '"MRR" = sum(mrr) on each account\'s latest month', show(await followedMeasureTexts(pid, ds, { category: 'region', values: [M(mrr)] } as Any, {})));
  const jsKpi = (s: MetricSnapshot, agg: Agg, scope: FilterStep[]) => jsKpiOn(TABLE, s, agg, scope);
  const t0 = trace.snapshot();
  ok('KPI = the reference', Object.is(await kpi(mrr, []), jsKpi(S, 'sum', [])), show([await kpi(mrr, []), jsKpi(S, 'sum', [])]));
  ok('KPI under a scope = the reference', Object.is(await kpi(mrr, [EAST, Y2024]), jsKpi(S, 'sum', [EAST, Y2024])), show([await kpi(mrr, [EAST, Y2024]), jsKpi(S, 'sum', [EAST, Y2024])]));
  ok('KPI over nothing: no figure', (await kpi(mrr, [Y1999])) === null && jsKpi(S, 'sum', [Y1999]) === null);
  ok('a KPI with no period says stopped accounts still count', (await resolved(mrr, [])).notes?.includes(msg.snapshotPerStale('account')) === true, show(await resolved(mrr, [])));
  ok('NEGATIVE CONTROL: with a period, no such note', !(await resolved(mrr, [Y2024])).notes?.includes(msg.snapshotPerStale('account')), show(await resolved(mrr, [Y2024])));
  ok('NEGATIVE CONTROL: a plain snapshot has no such note', !(await resolved(stock, [])).notes, show(await resolved(stock, [])));
  ok('the KPI door itself', Object.is((await dashboards.computeCardMetric(pid, ds, { column: 'mrr', aggregation: 'count', snapshot: S })).value, jsKpi(S, 'count', [])));
  const double = await saved('Double MRR', { formula: '[MRR] * 2' });
  ok('a formula over it: [MRR] * 2', Object.is(await kpi(double, []), 2 * jsKpi(S, 'sum', [])!));
  ok('the editor\'s preview of an unsaved per-entity snapshot is its figure', Object.is((await ipcMetrics.previewDefinition(pid, ds, { column: 'mrr', aggregation: 'sum', snapshot: S }, [], { kind: 'number' })).value, jsKpi(S, 'sum', [])));

  const sameItems = (a: unknown[], b: unknown[]): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const refChart = (enc: Any, scope: FilterStep[] = []) => {
    const t = transforms.applyPipeline({ columns: TABLE.columns, rows: TABLE.rows }, scope);
    return buildVizData(t.columns, snap.snapshotRows(t.columns, t.rows, S, enc.category === 'month' ? bucketOf(enc.grain) : undefined), { ...enc, values: [{ column: 'mrr', aggregation: 'sum' }] }, []);
  };
  for (const enc of [{ category: 'region', values: [M(mrr)] }, { category: 'month', grain: 'quarter', values: [M(mrr)] }, { category: 'month', grain: 'month', series: 'region', values: [M(mrr)] }, { category: 'region', series: 'month', values: [M(mrr)] }] as Any[]) {
    for (const scope of [[], [Y2024]]) {
      const got = await chart(enc, scope);
      const want = refChart(enc, scope);
      ok(`chart = reference, cell by cell: ${JSON.stringify(enc).replace(/"metricId":"[^"]+"/, 'MRR')}${scope.length ? ', 2024' : ''}`, got.ok && sameItems(got.data.labels, want.data.labels)
        && got.data.series.length === want.data.series.length && want.data.series.every((sr, i) => got.data.series[i].name === sr.name && sameItems(got.data.series[i].values, sr.values)), show([got, want.data]));
    }
  }
  const t1 = trace.snapshot();
  ok('resident: the KPIs and the charts ran in place', (t1.snapshotPer?.resident ?? 0) > (t0.snapshotPer?.resident ?? 0) && (t1.vizAggregate?.resident ?? 0) > (t0.vizAggregate?.resident ?? 0), show([t0.snapshotPer, t1.snapshotPer, t0.vizAggregate, t1.vizAggregate]));
  const byRegion = await chart({ category: 'region', values: [M(mrr)] });
  ok('the region bars add up to the KPI (one partition per account)', byRegion.ok && Object.is(byRegion.data.series[0].values.reduce((a: number, v: number | null) => a + (v ?? 0), 0), await kpi(mrr, [])), show(byRegion));
  const auto = await chart({ category: 'month', values: [M(mrr)] });
  const plainAuto = await chart({ category: 'month', values: [{ column: 'mrr', aggregation: 'sum' }] });
  ok('auto grain is the plain chart\'s, then each account\'s latest per bucket', auto.ok && !!plainAuto.category?.grain && auto.category?.grain === plainAuto.category?.grain
    && sameItems(auto.data.series[0].values, (await chart({ category: 'month', grain: plainAuto.category.grain, values: [M(mrr)] })).data.series[0].values), show([auto.category, plainAuto.category]));
  ok('a formula over it per cell: [MRR] * 2', (await chart({ category: 'region', values: [M(double)] })).data.series[0].values.every((v: number, i: number) => Object.is(v, 2 * byRegion.data.series[0].values[i])));
  ok('NEGATIVE CONTROL: the plain snapshot by region is another chart (West: none on the latest day? no — A9 and the stopped ones)', !sameItems((await chart({ category: 'region', values: [M(stock)] })).data.series[0].values, byRegion.data.series[0].values));
  const otherDate = await chart({ category: 'month', grain: 'month', values: [M(mrr)] }, [], dsN);
  ok('a metric of another dataset: the stored copy, as before (not this step\'s)', otherDate.ok === true);

  ok('the cache never serves the plain snapshot for per (same filters)', (await kpi(mrr, [])) !== (await kpi(stock, [])) && (await kpi(mrr, [])) !== (await kpi(stock, [])));
  ok('…nor the plain snapshot for per, from the KPI door', (await dashboards.computeCardMetric(pid, ds, { column: 'mrr', aggregation: 'sum', snapshot: { column: 'month', take: 'last' } })).value !== (await dashboards.computeCardMetric(pid, ds, { column: 'mrr', aggregation: 'sum', snapshot: S })).value);
  await update(mrr.id, { definition: { column: 'mrr', aggregation: 'sum', snapshot: { column: 'month', take: 'last' } } });
  ok('an old editor\'s save keeps per', (await metrics.getMetric(pid, mrr.id))!.definition && (((await metrics.getMetric(pid, mrr.id))!.definition as Any).snapshot.per === 'account'));
  await update(mrr.id, { definition: { column: 'mrr', aggregation: 'sum', snapshot: { column: 'month', take: 'last', per: null } } });
  ok('per: null clears it', !('per' in ((await metrics.getMetric(pid, mrr.id))!.definition as Any).snapshot), show((await metrics.getMetric(pid, mrr.id))!.definition));
  ok('…and the figure is the plain snapshot\'s again', Object.is(await kpi(mrr, []), await kpi(stock, [])));
  await update(mrr.id, { definition: { column: 'mrr', aggregation: 'sum', snapshot: S } });
  ok('…and per again', Object.is(await kpi(mrr, []), jsKpi(S, 'sum', [])));
  const nope = await save({ name: 'Nope', definition: { column: 'mrr', aggregation: 'sum', snapshot: { ...S, per: 'nope' } } });
  ok('per must be a column', nope.ok === false && nope.field === 'snapshot' && nope.error === msg.snapshotPerNotColumn('nope'), show(nope));
  const itself = await update(mrr.id, { definition: { column: 'mrr', aggregation: 'sum', snapshot: { ...S, per: 'month' } } });
  ok('…and not the snapshot\'s own date', itself.ok === false && itself.field === 'snapshot' && itself.error === msg.snapshotPerIsDate('month'), show(itself));
  ok('NEGATIVE CONTROL: nothing was saved', (((await metrics.getMetric(pid, mrr.id))!.definition as Any).snapshot.per === 'account'));

  const dsFx = (await datasets.saveDataset(pid, { name: 'MRR fx', sourceKind: 'csv', columns: COLS, rows: ROWS } as Any))!.id;
  await fxStore.setProjectFx(pid, { target: 'USD' });
  await fxStore.setColumnCurrency(pid, dsFx, 'mrr', { kind: 'fixed', code: 'EUR', date: 'month' });
  const mrrUsd = await saved('MRR (USD)', { column: 'mrr', aggregation: 'sum', snapshot: S }, dsFx);
  const fxKpi = await resolved(mrrUsd, []);
  ok('FX is refused with a sentence, not computed', fxKpi.value === null && fxKpi.notes?.[0] === msg.snapshotPerUnsupported('account'), show(fxKpi));
  const fxChart = await chart({ category: 'region', values: [M(mrrUsd)] }, [], dsFx);
  ok('…and on a chart', fxChart.ok === false && fxChart.error === msg.snapshotPerUnsupported('account'), show(fxChart));
  const linesUsd = await saved('Accounts (USD)', { column: 'mrr', aggregation: 'count', snapshot: S }, dsFx);
  ok('NEGATIVE CONTROL: a count is never converted, so it is computed', Object.is(await kpi(linesUsd, []), jsKpi(S, 'count', [])));

  finish();
})().catch((err) => {
  ok('test-snapshotPer ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
