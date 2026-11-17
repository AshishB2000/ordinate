// Self-check for the key check (spec D2): analysis/keyCheck.ts (the JS reference) held to `Object.is`
// agreement by engine/keyCheckResident.ts (its DuckDB twin, over the SAME rows saved as a resident
// Parquet by `datasets.saveDataset`) and by compileKeyCheck (the Live statement, over a typed
// DuckDB table loaded as a warehouse would hold it). A link's counts across two such tables (compileKeyMatch) are
// held to `joinJs.keyStatsJs` the same way.
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
const { compileKeyMatch, keyStatsFromRow }: typeof import('../src/engine/live/compileKeyMatch') = require('../src/engine/live/compileKeyMatch');
const { keyStatsJs }: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');

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

  // ── Live: compileKeyMatch, a link's counts over two Live datasets on one connection (relationship:save, ipc/linkLive),
  // against `keyStatsJs` (the extract's reference, `relationships.keyStats`) over the same rows: every field Object.is.
  // A lock on each side narrows its rows first, as `lockedTable` narrows a copy's.
  type Side = [ColType, Cell[]];
  const PAIRS: { name: string; from: Side; to: Side }[] = [
    { name: 'text', from: ['text', ['s1', 's2', 's1', 's9', null, '  ', '007', '\t']], to: ['text', ['s1', 's2', 's3', null, '7', 's2', '']] },
    { name: 'number', from: ['number', [1, 2, 2, null, 3.5, 10]], to: ['number', [1, 2, 3.5, null, 4, 4]] },
    { name: 'date', from: ['date', ['2024-01-01', '2024-01-02', null, '2024-01-01']], to: ['date', ['2024-01-01', '2024-03-01']] },
    { name: 'number to text', from: ['number', [1, 2, 3, null]], to: ['text', ['1', '2', 'x', null, '2']] },
    { name: 'text to number', from: ['text', ['1', '2', 'x', '']], to: ['number', [1, 2, 7]] },
    { name: 'no FROM rows', from: ['text', []], to: ['text', ['a']] },
    { name: 'no TO rows', from: ['text', ['a', null]], to: ['text', []] },
  ];
  const group = (i: number): string => (i % 2 ? 'b' : 'a');
  const LOCK = [{ kind: 'in' as const, column: 'g', values: ['a'], negate: false }];
  for (const [i, c] of PAIRS.entries()) {
    const side = async (end: 'f' | 't', [type, cells]: Side) => {
      const cols = [{ name: 'k', type }, { name: 'g', type: 'text' as const }];
      const table = `km_${i}_${end}`;
      await loadWarehouse(table, cols, cells.map((v, r) => [v, group(r)]));
      return { cols, table, type, cells };
    };
    const [f, t] = [await side('f', c.from), await side('t', c.to)];
    for (const lockedToo of [false, true]) {
      const label = `live key match ${c.name}${lockedToo ? ', locked' : ''}`;
      const lock = lockedToo ? LOCK : [];
      const q = compileKeyMatch(
        { column: 'k', env: { dialect: 'duckdb', source: { kind: 'table', parts: [f.table] }, columns: f.cols }, lock },
        { column: 'k', env: { dialect: 'duckdb', source: { kind: 'table', parts: [t.table] }, columns: t.cols }, lock },
      );
      ok(`${label}: the statement compiled`, q.ok);
      if (!q.ok) continue;
      const live = keyStatsFromRow((await runDuck(q.query))[0]);
      const kept = (cells: Cell[]): Cell[] => (lockedToo ? cells.filter((_, r) => group(r) === 'a') : cells);
      const js = keyStatsJs(kept(f.cells), f.type, kept(t.cells), t.type);
      const fields = ['matched', 'unmatchedFrom', 'fromKeys', 'fromKeyed', 'toKeys', 'toKeyed'] as const;
      ok(`${label}: every count Object.is the extract's`, live !== null && fields.every((k) => Object.is(live[k], js[k])), JSON.stringify({ live, js }));
    }
  }
  ok('live key match NEGATIVE CONTROL: the text pair matches some keys and misses some, and TO repeats one',
    (() => { const js = keyStatsJs(PAIRS[0].from[1], 'text', PAIRS[0].to[1], 'text'); return js.matched === 3 && js.unmatchedFrom === 5 && js.toKeys < js.toKeyed; })());
  const pairEnv = (dialect: (typeof DIALECT_IDS)[number]) => ({ column: 'region', env: { ...env, dialect }, lock: [] });
  for (const id of DIALECT_IDS) ok(`live key match ${id}: the statement compiles`, compileKeyMatch(pairEnv(id), pairEnv(id)).ok);
  const bqPair = compileKeyMatch(pairEnv('bigquery'), pairEnv('bigquery'));
  ok('live key match bigquery: every parameter has its own placeholder, each once',
    bqPair.ok && (bqPair.query.sql.match(/@p\d+/g) ?? []).join() === bqPair.query.params.map((_, n) => `@p${n}`).join(), bqPair.ok ? bqPair.query.sql : '');
  const twoWarehouses = compileKeyMatch(pairEnv('duckdb'), pairEnv('snowflake'));
  ok('live key match: two dialects are refused (one statement is one warehouse\'s)', !twoWarehouses.ok && twoWarehouses.code === 'badQuery');
  const gone = compileKeyMatch(pairEnv('duckdb'), { ...pairEnv('duckdb'), column: 'nope' });
  ok('live key match: an undeclared TO column is refused, typed', !gone.ok && gone.code === 'unknownColumn');
  ok('keyStatsFromRow: NULL sums are 0, a non-number or more matches than rows is a failure',
    JSON.stringify(keyStatsFromRow([0, null, 0, 0, null, null])) === '{"matched":0,"unmatchedFrom":0,"fromKeys":0,"fromKeyed":0,"toKeys":0,"toKeyed":0}'
      && keyStatsFromRow(['x', 0, 0, 0, 0, 0]) === null && keyStatsFromRow([1, 2, 1, 1, 1, 1]) === null && keyStatsFromRow([1, 1]) === null);

  finish();
})().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exitCode = 1;
  finish();
});
