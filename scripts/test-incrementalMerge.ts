// Incremental refresh, the pure half and the DuckDB merge.
//
//   • the cursor arithmetic and the settings whitelist (hand-written values)
//   • the predicate each SQL dialect is sent (hand-written expected strings)
//   • the merge: DuckDB (src/engine/incrementalDuck.ts) against the JS reference
//     (src/data/incremental.ts mergeJs), DIFFERENTIALLY — every cell compared
//     with Object.is, over hand-built cases and a seeded random sweep, in both
//     modes (upsert by key, append with overlap dedupe).
//
// The end-to-end runs (watermark persistence, the 7th-run full refresh, crash
// recovery) are scripts/test-incrementalRefresh.ts.

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const inc: typeof import('../src/data/incremental') = require('../src/data/incremental');
const sqlGen: typeof import('../src/connectors/incrementalSql') = require('../src/connectors/incrementalSql');
const duckMerge: typeof import('../src/engine/incrementalDuck') = require('../src/engine/incrementalDuck');
const pq: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
type Cell = import('../src/data/incremental').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-incr-'));

function same(a: Cell[][], b: Cell[][]): boolean {
  return a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, j) => Object.is(v, b[i][j])));
}

// ── 1. Cursor arithmetic ─────────────────────────────────────────────────────
ok('cursorKey: a number cell is itself', inc.cursorKey(42, 'number') === 42);
ok('cursorKey: a numeric string on a number column parses', inc.cursorKey('7.5', 'number') === 7.5);
ok('cursorKey: "007" is not a number cursor', inc.cursorKey('007', 'number') === null);
ok('cursorKey: a date is epoch ms', inc.cursorKey('2024-01-02', 'date') === Date.UTC(2024, 0, 2));
ok('cursorKey: an empty or unreadable cell has no key',
  inc.cursorKey(null, 'date') === null && inc.cursorKey('', 'number') === null && inc.cursorKey('soon', 'date') === null);
ok('lowerBound: a date lookback is seconds', inc.lowerBound(Date.UTC(2024, 0, 2), 86_400, 'date') === Date.UTC(2024, 0, 1));
ok('lowerBound: an id lookback is a count', inc.lowerBound(100, 5, 'number') === 95);
ok('maxCursor: greatest key, first on a tie',
  JSON.stringify(inc.maxCursor([[3], [9], [9], [null]], 0, 'number')) === JSON.stringify({ value: 9, key: 9 }));
const fb = inc.filterBatch([[1], [5], [null], [4], [6]], 0, 'number', 5);
ok('filterBatch keeps cursor >= the bound (and drops an empty cursor)',
  JSON.stringify(fb) === JSON.stringify({ rows: [[5], [6]], keys: [5, 6] }));

// ── 2. Typing a batch to the stored columns ─────────────────────────────────
const cols: ParsedColumn[] = [{ name: 'id', type: 'number' }, { name: 'at', type: 'date' }, { name: 'note', type: 'text' }];
const typed = inc.toBaseRows(['id', 'at', 'note'], [['1', '2024-01-01', ''], ['2', '', 'x']], cols);
ok('toBaseRows coerces like the importer (number, date string, empty → null)',
  typed.ok && JSON.stringify(typed.rows) === JSON.stringify([[1, '2024-01-01', null], [2, null, 'x']]));
const renamed = inc.toBaseRows(['id', 'when', 'note'], [], cols);
ok('toBaseRows refuses a batch whose columns changed', !renamed.ok && /columns changed/.test(renamed.reason));
const drift = inc.toBaseRows(['id', 'at', 'note'], [['n/a', '2024-01-01', '']], cols);
ok('toBaseRows refuses text in a number column (a full refresh re-types it)', !drift.ok && /numbers/.test(drift.reason));

// ── 3. The settings whitelist ────────────────────────────────────────────────
const clean = inc.sanitizeIncremental({
  enabled: true, cursorColumn: 'at', keyColumn: 'id', lookback: -5, highWater: { evil: 1 }, runsSinceFull: 3.5,
  fullNext: 'yes', log: [{ at: '2024-01-01T00:00:00Z', mode: 'incremental', fetched: 3, inserted: 1, updated: 2, highWater: 9, how: 'server' }, { at: 'bad' }],
}, 'connection');
ok('sanitize: kept the shape, dropped every bad field',
  !!clean && clean.enabled && clean.lookback === 0 && clean.highWater === null && clean.runsSinceFull === 0
  && clean.fullNext === undefined && clean.log.length === 1 && clean.log[0].how === 'server', JSON.stringify(clean));
ok('sanitize: only a connection origin may carry incremental settings',
  inc.sanitizeIncremental({ enabled: true, cursorColumn: 'at' }, 'file') === undefined);

// ── 4. The pushed predicate, per dialect ─────────────────────────────────────
const day = Date.UTC(2024, 4, 2, 12, 0, 0); // the literal is widened by a day
ok('postgres: table + ANSI timestamp',
  sqlGen.pushdownSql('postgres', { table: 'public.orders' }, 'updated_at', 'date', day)
  === `select * from "public"."orders" where "updated_at" >= TIMESTAMP '2024-05-01 12:00:00'`);
ok('mysql: backticks, query wrapped with an alias',
  sqlGen.pushdownSql('mysql', { query: 'select * from orders;' }, 'id', 'number', 41)
  === 'select * from ( select * from orders ) ord_inc where `id` >= 41');
ok('mssql: brackets and a DATETIME2 cast',
  sqlGen.pushdownSql('mssql', { table: 'dbo.orders' }, 'when]x', 'date', day)
  === `select * from [dbo].[orders] where [when]]x] >= CAST('2024-05-01T12:00:00' AS DATETIME2)`);
ok('mssql: a query with ORDER BY or a CTE is not pushed (filtered after fetch)',
  sqlGen.pushdownSql('mssql', { query: 'select * from t order by id' }, 'id', 'number', 1) === null
  && sqlGen.pushdownSql('mssql', { query: 'with x as (select 1 a) select * from x' }, 'a', 'number', 1) === null);
ok('oracle: quoted exact-case column, no AS on the alias',
  sqlGen.pushdownSql('oracle', { query: 'select * from orders' }, 'ID', 'number', 7)
  === 'select * from ( select * from orders ) ord_inc where "ID" >= 7');
ok('duckdb: a text cell is TRY_CAST and an uncastable one passes to JS',
  sqlGen.pushdownSql('duckdb', { table: 'sales' }, 'n', 'number', 2.5)
  === 'select * from "sales" where (TRY_CAST("n" AS DOUBLE) IS NULL OR TRY_CAST("n" AS DOUBLE) >= 2.5)');
ok('http / saas / url families are never pushed',
  ['http', 'saas', 'url'].every((f) => sqlGen.pushdownSql(f, { table: 't' }, 'id', 'number', 1) === null));
ok('an unsafe table name is not pushed', sqlGen.pushdownSql('postgres', { table: 'x; drop table y' }, 'id', 'number', 1) === null);

// ── 5. The merge: DuckDB against the JS reference ───────────────────────────
async function differential(label: string, columns: ParsedColumn[], base: Cell[][], batch: Cell[][], keys: number[], keyIndex: number | null): Promise<ReturnType<typeof inc.mergeJs>> {
  const basePath = path.join(dir, `${label.replace(/\W+/g, '_')}.parquet`);
  await pq.writeTableAsync(basePath, columns, base);
  const want = inc.mergeJs(base, batch, keys, keyIndex, columns.length);
  const got = await duckMerge.mergeInDuck({ basePath, columns, batch, keys, keyIndex, stem: path.join(dir, `${label.replace(/\W+/g, '_')}.incr-x`) });
  ok(`${label}: DuckDB rows === JS rows (Object.is)`, same(got.rows, want.rows), `\n duck ${JSON.stringify(got.rows)}\n js   ${JSON.stringify(want.rows)}`);
  ok(`${label}: inserted/updated agree (${want.inserted}/${want.updated})`, got.inserted === want.inserted && got.updated === want.updated,
    `duck ${got.inserted}/${got.updated}`);
  return want;
}

async function main(): Promise<void> {
  const c3: ParsedColumn[] = [{ name: 'id', type: 'number' }, { name: 'at', type: 'number' }, { name: 'v', type: 'text' }];

  // Upsert: hand-written expectation, then the differential.
  const up = await differential('upsert', c3,
    [[1, 10, 'a'], [2, 11, 'b'], [3, 12, 'c'], [2, 9, 'b-old-dup']],
    [[2, 13, 'B'], [4, 14, 'd'], [2, 13, 'B2'], [3, 12, 'c'], [5, 15, null]],
    [13, 14, 13, 12, 15], 0);
  ok('upsert: new wins in place, a tie goes to the later row, a stored duplicate key is dropped, new keys append in order',
    JSON.stringify(up.rows) === JSON.stringify([[1, 10, 'a'], [2, 13, 'B2'], [3, 12, 'c'], [4, 14, 'd'], [5, 15, null]]));
  ok('upsert: an identical re-read is not counted as an update', up.updated === 1 && up.inserted === 2);

  // Append with a lookback overlap: rows already stored are not re-appended,
  // a genuine duplicate the source holds twice is.
  const ap = await differential('append overlap', c3,
    [[1, 10, 'a'], [2, 11, 'b'], [3, 12, 'c']],
    [[2, 11, 'b'], [3, 12, 'c'], [3, 12, 'c'], [4, 13, 'd'], [5, 14, '']],
    [11, 12, 12, 13, 14], null);
  ok('append: the overlap is deduped, a second real copy and the new rows are appended',
    JSON.stringify(ap.rows) === JSON.stringify([[1, 10, 'a'], [2, 11, 'b'], [3, 12, 'c'], [3, 12, 'c'], [4, 13, 'd'], [5, 14, '']]));
  const replay = await differential('append replay', c3, ap.rows, [[4, 13, 'd'], [5, 14, '']], [13, 14], null);
  ok('append: replaying a batch (a crash between write and mark) appends nothing', replay.inserted === 0);

  // null, '' and whitespace stay three different things in a key and a row.
  // An EMPTY key is no identity: those rows APPEND (multiset rule) instead of
  // collapsing onto one another as a single "null key".
  const ek = await differential('empty kinds as keys', [{ name: 'k', type: 'text' }, { name: 'at', type: 'number' }],
    [[null, 1], ['', 2], [' ', 3]], [[null, 5], ['', 6], ['x', 7]], [5, 6, 7], 0);
  ok('empty keys: every stored empty-key row stays, fetched ones append',
    JSON.stringify(ek.rows) === JSON.stringify([[null, 1], ['', 2], [' ', 3], [null, 5], ['', 6], ['x', 7]]) && ek.inserted === 3 && ek.updated === 0,
    JSON.stringify(ek.rows));
  const many = await differential('many empty keys', c3,
    [[null, 1, 'a'], [null, 2, 'b'], [null, 3, 'c'], [7, 4, 'x']],
    [[null, 2, 'b'], [null, 9, 'd'], [null, 9, 'd'], [7, 9, 'X']], [2, 9, 9, 9], 0);
  ok('empty keys: stored null-key rows are not collapsed; a lookback re-read is not re-appended; a real duplicate is',
    JSON.stringify(many.rows) === JSON.stringify([[null, 1, 'a'], [null, 2, 'b'], [null, 3, 'c'], [7, 9, 'X'], [null, 9, 'd'], [null, 9, 'd']])
    && many.inserted === 2 && many.updated === 1, JSON.stringify(many.rows));

  // A seeded sweep, both modes, with key collisions, nulls and ties.
  let seed = 7;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pickV = (): Cell => [null, '', 'x', 'y', 'z'][rnd(5)];
  for (let t = 0; t < 12; t++) {
    // A NUMBER key's empty cell is null ('' and ' ' are the text-key case above).
    const pickK = (n: number): Cell => (rnd(5) === 0 ? null : rnd(n));
    const base: Cell[][] = Array.from({ length: rnd(30) }, () => [pickK(8), rnd(20), pickV()]);
    const batch: Cell[][] = Array.from({ length: 1 + rnd(25) }, () => [pickK(10), 10 + rnd(15), pickV()]);
    const keys = batch.map((r) => r[1] as number);
    await differential(`random #${t} ${t % 2 ? 'append' : 'upsert'}`, c3, base, batch, keys, t % 2 ? null : 0);
  }

  ok('mergeInDuck leaves no temp file behind', fs.readdirSync(dir).every((n: string) => !/\.incr-x\./.test(n)), fs.readdirSync(dir).join(', '));
  fs.writeFileSync(path.join(dir, 'abc.incr-dead.batch.parquet'), 'x');
  ok('cleanupTemps removes a crashed run\'s leftovers for that id only',
    duckMerge.cleanupTemps(dir, 'abc') === 1 && !fs.existsSync(path.join(dir, 'abc.incr-dead.batch.parquet')));
}

main()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    finish();
  });
