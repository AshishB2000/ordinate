// Self-check for the key check (spec D2): analysis/keyCheck.ts (the JS reference) held to `Object.is`
// agreement by engine/keyCheckResident.ts (its DuckDB twin, over the SAME rows saved as a resident
// Parquet by `datasets.saveDataset`) and by compileKeyCheck (the Live statement, over a typed
// DuckDB table loaded as a warehouse would hold it).
//
//   npm run build:ts && node scripts/test-keyCheck.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { loadWarehouse, runDuck } from './liveParityFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-keycheck-'));

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const { keyCheckJs, keyCheckFromRow }: typeof import('../src/analysis/keyCheck') = require('../src/analysis/keyCheck');
const { keyCheckResident }: typeof import('../src/engine/keyCheckResident') = require('../src/engine/keyCheckResident');
const { compileKeyCheck }: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const { DIALECT_IDS }: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');

type Cell = import('../src/data/transforms').Cell;
type ColType = import('../src/data/parse').ParsedColumn['type'];

interface Case { name: string; type: ColType; cells: Cell[]; rows: number; empty: number; repeatedKeys: number }

// '\t', ' ' and '  ' are empty; '007' and '7' are two keys; a number column's null is empty.
const CASES: Case[] = [
  { name: 'text', type: 'text', cells: ['A', 'B', 'A', null, '', '  ', '\t', ' ', '007', '7', 'C', 'C', 'C'], rows: 13, empty: 5, repeatedKeys: 2 },
  { name: 'number', type: 'number', cells: [1, 2, 2, null, 3.5, 3.5, 3.5, 10], rows: 8, empty: 1, repeatedKeys: 2 },
  { name: 'date', type: 'date', cells: ['2024-01-01', '2024-01-01', '01/02/2024', null], rows: 4, empty: 1, repeatedKeys: 1 },
  { name: 'unique', type: 'text', cells: ['a', 'b', 'c'], rows: 3, empty: 0, repeatedKeys: 0 },
  { name: 'empty table', type: 'text', cells: [], rows: 0, empty: 0, repeatedKeys: 0 },
];

(async () => {
  const p = await projects.createProject('Key check');
  if (!p) throw new Error('createProject failed');
  const resident: Record<string, Awaited<ReturnType<typeof keyCheckResident>>> = {};

  for (const c of CASES) {
    const ds = await datasets.saveDataset(p.id, {
      name: c.name, sourceKind: 'csv', columns: [{ name: 'k', type: c.type }], rows: c.cells.map((v) => [v]),
    });
    if (!ds) throw new Error(`saveDataset(${c.name}) failed`);
    const src = await datasets.residentSource(p.id, ds.id);
    if (!src) throw new Error(`${c.name}: not resident`);
    const js = keyCheckJs(c.cells, c.type);
    const sql = await keyCheckResident({ parquetPath: src.parquetPath, index: 0, type: c.type });
    resident[c.name] = sql;
    ok(`${c.name}: the resident check ran`, sql !== null);
    for (const f of ['rows', 'empty', 'repeatedKeys'] as const) {
      ok(`${c.name}: ${f} agrees (Object.is)`, sql !== null && Object.is(js[f], sql[f]), `${js[f]} vs ${sql?.[f]}`);
      ok(`${c.name}: ${f} is ${c[f]}`, js[f] === c[f], js[f]);
    }
  }

  // Negative controls: a check that always says 0 fails here.
  ok('a repeated key is reported', keyCheckJs(['x', 'x'], 'text').repeatedKeys === 1);
  ok('resident: unique reports 0 repeats', resident['unique']?.repeatedKeys === 0);
  ok('resident: text reports 2 repeats', resident['text']?.repeatedKeys === 2);

  ok('keyCheckFromRow: NULL sums are 0',
    JSON.stringify(keyCheckFromRow([null, null, null])) === '{"rows":0,"empty":0,"repeatedKeys":0}');
  ok('keyCheckFromRow: a non-number is a failure', keyCheckFromRow(['x', 0, 0]) === null);
  ok('keyCheckFromRow: no row is a failure', keyCheckFromRow(undefined) === null);
  ok('keyCheckFromRow: a short row is a failure', keyCheckFromRow([1, 2]) === null);
  ok('resident: a query that fails is null',
    (await keyCheckResident({ parquetPath: path.join(os.tmpdir(), 'ordinate-keycheck-missing.parquet'), index: 0, type: 'text' })) === null);

  // ── Live: compileKeyCheck over a typed warehouse table, row for row against the JS reference. The
  // date case is ISO only (a warehouse DATE has no other spelling).
  const WAREHOUSE: Case[] = [
    ...CASES.filter((c) => c.name !== 'date'),
    { name: 'date', type: 'date', cells: ['2024-01-01', '2024-01-01', '2024-01-02', null], rows: 4, empty: 1, repeatedKeys: 1 },
  ];
  for (const c of WAREHOUSE) {
    const cols = [{ name: 'k', type: c.type }];
    const table = `kc_${c.name.replace(/\W/g, '_')}`;
    await loadWarehouse(table, cols, c.cells.map((v) => [v]));
    const q = compileKeyCheck('k', { dialect: 'duckdb', source: { kind: 'table', parts: [table] }, columns: cols });
    ok(`live ${c.name}: the statement compiled`, q.ok);
    if (!q.ok) continue;
    const live = keyCheckFromRow((await runDuck(q.query))[0]);
    const js = keyCheckJs(c.cells, c.type);
    ok(`live ${c.name}: the check ran`, live !== null);
    for (const f of ['rows', 'empty', 'repeatedKeys'] as const) {
      ok(`live ${c.name}: ${f} agrees (Object.is)`, live !== null && Object.is(js[f], live[f]), `${js[f]} vs ${live?.[f]}`);
      ok(`live ${c.name}: ${f} is ${c[f]}`, js[f] === c[f], js[f]);
    }
  }

  const env = { dialect: 'duckdb' as const, source: { kind: 'table' as const, parts: ['t'] }, columns: [{ name: 'region', type: 'text' as const }] };
  const unknown = compileKeyCheck('nope', env);
  ok('live: an undeclared column is refused, typed', !unknown.ok && unknown.code === 'unknownColumn');
  const hostile = compileKeyCheck('region', { ...env, source: { kind: 'table', parts: ['t"; DROP TABLE x; --'] } });
  ok('live: a hostile source part compiles to quoted identifiers only',
    hostile.ok && !/DROP TABLE x;/.test(hostile.query.sql.replace(/"[^"]*"/g, '')));
  for (const id of DIALECT_IDS) ok(`live ${id}: the statement compiles`, compileKeyCheck('region', { ...env, dialect: id }).ok);
  // The key holds a bound value, so it must appear ONCE: a `GROUP BY <key>` beside `SELECT <key>` makes two
  // placeholders (@p0, @p1) that BigQuery and the other bound-class dialects do not match. DuckDB inlines its
  // whitespace class and would not notice, so this is pinned on the compiled text.
  const bq = compileKeyCheck('region', { ...env, dialect: 'bigquery' });
  ok('live bigquery: the text key is bound once (one parameter, one @p0)',
    bq.ok && bq.query.params.length === 1 && (bq.query.sql.match(/@p\d+/g) ?? []).join() === '@p0', bq.ok ? bq.query.sql : '');
  ok('live: the columns are k_rows, k_empty, k_repeated',
    hostile.ok && JSON.stringify(hostile.query.columns) === '["k_rows","k_empty","k_repeated"]');

  finish();
})().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exitCode = 1;
  finish();
});
