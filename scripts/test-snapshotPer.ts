// A snapshot per entity (semantic layer part 5, D11): MRR is each account's own last MRR, summed, even for accounts
// that last reported in different months. After every filter, the row lock and terms, each entity keeps its rows on
// its own latest (or earliest) day, per date bucket when charted by the snapshot's date, then the usual aggregate.
//
// DIFFERENTIAL throughout: the resident twin (engine/snapshotResident: a DuckDB temp table read in place) against the
// row-level JS reference (analysis/snapshot.snapshotRows with `per`), with Object.is. Whole-number figures, so
// DuckDB's parallel sum and a JS fold agree exactly.
//
//   twin   the reference's partitions and the twin held to it
//
//   npm run build:ts && node scripts/test-snapshotPer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-snapshot-per-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
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

  finish();
})().catch((err) => {
  ok('test-snapshotPer ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
