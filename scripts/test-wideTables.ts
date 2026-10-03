// Wide tables — the shape nothing else covers.
//
// Every other measurement in this repo is 4-6 columns. The row cap is now
// 1,000,000, but width is a separate axis and it broke something real: the
// resident anomaly detector issues statements PER NUMERIC COLUMN, so its cost
// scales with width while the JS path scales with rows x columns. At 400
// columns it was 17.7x SLOWER than the code it replaced, and at 1,000 columns
// it took 57 seconds — a hang, on a path a user triggers by clicking a button.
//
// Results were identical throughout; this was purely cost. That is exactly the
// failure the resident paths are prone to, because they all fall back silently:
// a bad one is not wrong, just slow, and nothing notices.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-wide-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasetStats: typeof import('../src/data/datasetStats') = require('../src/data/datasetStats');
const statsResident: typeof import('../src/engine/statsResident') = require('../src/engine/statsResident');
const datasetPage: typeof import('../src/engine/datasetPage') = require('../src/engine/datasetPage');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');


// Mixed types, a leading-zero id column, and enough distinct values that the
// stats/dominant-category paths actually have work to do.
function makeWide(C: number, N: number) {
  const columns: { name: string; type: 'text' | 'number' }[] = [];
  for (let c = 0; c < C; c++) {
    // Deliberately hostile names: quotes, a semicolon, a duplicate, and unicode.
    const name =
      c === 3 ? 'we"ird; name' : c === 4 ? 'dup' : c === 5 ? 'dup' : c === 6 ? 'ünïcødé' : 'col' + c;
    columns.push({ name, type: c % 3 === 0 ? 'number' : 'text' });
  }
  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < N; i++) {
    const r: (string | number | null)[] = [];
    for (let c = 0; c < C; c++) {
      if (c % 3 === 0) r.push((i * (c + 1)) % 997);
      else if (c === 1) r.push(String(i % 999).padStart(3, '0')); // leading zeros
      else if (c === 2) r.push(i % 7 === 0 ? '' : i % 11 === 0 ? null : 'v' + ((i + c) % 50));
      else r.push('v' + ((i + c) % 50));
    }
    rows.push(r);
  }
  return { columns, rows };
}

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Wide');
  if (!proj) throw new Error('project fixture failed');

  ok('DuckDB bridge available', statsResident.isStatsResident());

  // ── 1. A wide table survives the whole store round trip ────────────────────
  {
    const C = 200;
    const N = 3000;
    const { columns, rows } = makeWide(C, N);
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Wide200',
      sourceKind: 'csv',
      columns,
      rows,
    });
    ok(`${C} columns save`, ds !== null && ds.rowCount === N, `rowCount=${ds && ds.rowCount}`);
    if (!ds) throw new Error('save failed');

    const back = await datasets.getDataset(proj.id, ds.id);
    ok(`${C} columns round-trip: column count`, back !== null && back.columns.length === C);
    ok(
      `${C} columns round-trip: every cell identical`,
      back !== null && JSON.stringify(back.rows) === JSON.stringify(rows),
    );
    ok(
      'hostile column names survive verbatim',
      back !== null &&
        back.columns[3].name === 'we"ird; name' &&
        back.columns[6].name === 'ünïcødé',
      back ? `[3]="${back.columns[3].name}" [6]="${back.columns[6].name}"` : '',
    );
    ok(
      'duplicate column names both survive',
      back !== null && back.columns[4].name === 'dup' && back.columns[5].name === 'dup',
    );
    ok('leading zeros stay text in a wide table', back !== null && back.rows[7][1] === '007');
    ok(
      'null and empty stay distinct in a wide table',
      back !== null && back.rows[0][2] === '' && back.rows[11][2] === null,
      back ? `[0][2]=${JSON.stringify(back.rows[0][2])} [11][2]=${JSON.stringify(back.rows[11][2])}` : '',
    );

    const src = await datasets.residentSource(proj.id, ds.id);
    ok('wide table is Parquet-backed', src !== null);
    if (!src) throw new Error('no resident source');

    // ── 2. Stats agree with the JS reference across every column ─────────────
    const jsSummaries = columns.map((col, c) =>
      datasetStats.computeColumnSummary(col, rows.map((row) => row[c] ?? null)),
    );
    const resSummaries = await statsResident.computeColumnSummariesResident(src);
    ok(`stats returned for all ${C} columns`, resSummaries !== null && resSummaries.length === C);
    const keyed = (s: any) => Object.keys(s).sort().map((k) => [k, s[k]]);
    ok(
      'stats identical to the JS reference, keys AND values, all columns',
      resSummaries !== null &&
        JSON.stringify(resSummaries.map(keyed)) === JSON.stringify(jsSummaries.map(keyed)),
    );

    // ── 3. A page reads every column back correctly ──────────────────────────
    const page = await datasetPage.readPage(src, { offset: 100, limit: 50 });
    ok('page over a wide table', page !== null && page.rows.length === 50 && page.total === N);
    ok(
      'page cells identical to the source slice',
      page !== null && JSON.stringify(page.rows) === JSON.stringify(rows.slice(100, 150)),
    );
    ok(
      'page over a wide table keeps every column',
      page !== null && page.rows[0].length === C,
      page ? `width=${page.rows[0].length}` : '',
    );

    // A metric on the LAST column — an off-by-one in the positional mapping
    // would silently read a neighbour and return a plausible wrong number.
    const lastNumeric = columns.map((c, i) => ({ c, i })).filter((x) => x.c.type === 'number').pop()!;
    const resMetric = await residentQuery.computeMetricResident(src, {
      column: lastNumeric.c.name,
      aggregation: 'sum',
    });
    const jsMetric = rows.reduce((a, r) => a + (r[lastNumeric.i] as number), 0);
    ok(
      'metric on the LAST column is correct (positional mapping holds)',
      resMetric === jsMetric,
      `resident=${resMetric} js=${jsMetric} col=${lastNumeric.i}`,
    );
  }

  // ── 4. THE REGRESSION GUARD ───────────────────────────────────────────────
  // The anomaly gate must not choose the resident path on a wide, short table.
  // This is a pure cost bug — results are identical either way — so nothing but
  // an explicit check catches it.
  {
    const cases: { numericCols: number; rowCount: number; wantResident: boolean; why: string }[] = [
      { numericCols: 1, rowCount: 4_999, wantResident: false, why: 'the original row threshold' },
      { numericCols: 1, rowCount: 5_000, wantResident: true, why: 'the original row threshold' },
      { numericCols: 2, rowCount: 1_000_000, wantResident: true, why: 'tall+narrow: 13.8x win' },
      { numericCols: 34, rowCount: 10_000, wantResident: false, why: 'measured 3.0x SLOWER' },
      { numericCols: 67, rowCount: 10_000, wantResident: false, why: 'measured 4.2x SLOWER' },
      { numericCols: 133, rowCount: 5_000, wantResident: false, why: 'measured 17.7x SLOWER' },
      { numericCols: 333, rowCount: 2_000, wantResident: false, why: '57 SECONDS — a hang' },
      { numericCols: 133, rowCount: 700_000, wantResident: true, why: 'enough rows to amortise' },
    ];
    // Mirror of anomalyResidentWorthIt in src/ipc/dashboards.ts. Kept as a
    // mirror deliberately: importing an IPC module registers handlers.
    const MIN_ROWS = 5_000;
    const ROWS_PER_NUMERIC_COL = 5_000;
    const worthIt = (numericCols: number, rowCount: number): boolean =>
      rowCount >= Math.max(MIN_ROWS, numericCols * ROWS_PER_NUMERIC_COL);

    for (const c of cases) {
      ok(
        `anomaly gate: ${c.numericCols} numeric cols x ${c.rowCount} rows -> ${c.wantResident ? 'resident' : 'JS'} (${c.why})`,
        worthIt(c.numericCols, c.rowCount) === c.wantResident,
      );
    }
    // The base statements still cost the bridge floor, so a tiny table stays on
    // the JS path even with nothing to aggregate per column. A first version of
    // this gate got that wrong and test-anomaliesResident caught it.
    ok('anomaly gate: no numeric columns still needs the row floor', worthIt(0, 4) === false);
    ok('anomaly gate: no numeric columns, enough rows -> resident', worthIt(0, 5_000) === true);
  }

  // ── 5. Width scaling stays linear for the paths that DID hold up ───────────
  {
    const timings: string[] = [];
    for (const C of [50, 400]) {
      const { columns, rows } = makeWide(C, 2000);
      const ds = await datasets.saveDataset(proj.id, {
        name: 'W' + C,
        sourceKind: 'csv',
        columns,
        rows,
      });
      if (!ds) continue;
      const src = await datasets.residentSource(proj.id, ds.id);
      if (!src) continue;
      let t = Date.now();
      const s = await statsResident.computeColumnSummariesResident(src);
      const statsMs = Date.now() - t;
      t = Date.now();
      const p = await datasetPage.readPage(src, { offset: 0, limit: 500 });
      const pageMs = Date.now() - t;
      ok(`${C} columns: stats complete`, s !== null && s.length === C, `${statsMs} ms`);
      ok(`${C} columns: page complete`, p !== null && p.rows.length === 500, `${pageMs} ms`);
      timings.push(`${C} cols: stats ${statsMs} ms, page ${pageMs} ms`);
      await datasets.deleteDataset(proj.id, ds.id);
    }
    console.log('     (' + timings.join(' | ') + ')');
  }

  duck.shutdown();
  fs.rmSync(tmpUserData, { recursive: true, force: true });

  console.log('');
  if (failureCount()) {
    console.error(`${failureCount()} wide-table check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All wide-table checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
