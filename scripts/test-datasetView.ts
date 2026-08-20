'use strict';

// Self-check for src/datasetView.ts — the typed, user-named VIEW over a stored
// Parquet file.
//
// This suite is deliberately NOT a string-comparison suite. `viewSql` is pure
// and a few shape assertions are made against it directly (they are the cheapest
// way to state "a text column is never TRY_CAST"), but everything that matters
// is asserted by WRITING A REAL PARQUET FILE, creating the view, and QUERYING IT
// THROUGH `duckdb.query`. A view that generates valid-looking SQL and answers
// questions wrongly is worthless, and only execution can tell the two apart.
//
// The last block is a ROUND-TRIP PARITY test: a GROUP BY + sum through the view
// must equal `residentQuery.aggregateResident` over the same file. Two
// independent SQL paths agreeing is much stronger evidence than either alone.
//
//   npm run build:ts && node scripts/test-datasetView.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dv from '../src/engine/datasetView';
import * as pq from '../src/engine/parquetStore';
import * as rq from '../src/engine/residentQuery';
import * as duck from '../src/engine/duckdb';
import type { ParsedColumn } from '../src/parse';
import type { Cell } from '../src/transforms';

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dsview-'));
let seq = 0;
function tmpFile(): string {
  return path.join(dir, `t${seq++}.parquet`);
}
function cleanup(): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Write a real Parquet fixture and return the path. */
function write(columns: ParsedColumn[], rows: Cell[][]): string {
  const file = tmpFile();
  pq.writeTable(file, columns, rows);
  return file;
}

let viewSeq = 0;
function viewName(): string {
  return `ds_v${viewSeq++}`;
}

/** DESCRIBE the view, as the column names + types a charting layer would see. */
function describe(name: string): { name: string; type: string }[] {
  return duck
    .query(`DESCRIBE "${name.replace(/"/g, '""')}";`)
    .map((r) => ({ name: String(r.column_name ?? ''), type: String(r.column_type ?? '') }));
}

function q(sql: string): duck.DuckRow[] {
  return duck.query(sql);
}

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. The bridge has to be up, or nothing below means anything.
// ─────────────────────────────────────────────────────────────────────────────
if (!duck.isAvailable()) {
  console.error('FAIL datasetView: DuckDB bridge unavailable — cannot run this suite');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE TYPE GATE — the cast follows the DECLARED type, never inference.
//    `TRY_CAST('007' AS DOUBLE)` is 7; a text column must never see a cast.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'zip', type: 'text' },
    { name: 'revenue', type: 'number' },
    { name: 'day', type: 'date' },
  ];
  const rows: Cell[][] = [
    ['007', 10, '2024-01-05'],
    ['00123', 32.5, '2024-01-06'],
    ['90210', 7, '2024-01-07'],
  ];
  const file = write(cols, rows);
  const name = viewName();
  const sql = dv.viewSql({ name, parquetPath: file, columns: cols });

  ok('viewSql: pure — CREATE OR REPLACE VIEW statement', sql.startsWith(`CREATE OR REPLACE VIEW "${name}" AS SELECT `));
  ok('viewSql: text column is CAST AS VARCHAR, never TRY_CAST', sql.includes('CAST(c0 AS VARCHAR) AS "zip"'));
  ok('viewSql: date column is CAST AS VARCHAR, never TRY_CAST', sql.includes('CAST(c2 AS VARCHAR) AS "day"'));
  ok(
    'viewSql: TRY_CAST appears ONLY for the declared-number column',
    (sql.match(/TRY_CAST/g) || []).length === 2 && !/TRY_CAST\(c0/.test(sql) && !/TRY_CAST\(c2/.test(sql),
  );
  ok(
    'viewSql: number expression is sqlGen dialect (isfinite-guarded, CAST AS DOUBLE)',
    sql.includes('CAST(CASE WHEN isfinite(TRY_CAST(c1 AS DOUBLE)) THEN TRY_CAST(c1 AS DOUBLE) END AS DOUBLE) AS "revenue"'),
  );
  ok('viewSql: reads the parquet file through parquetStore.relationSql', sql.includes(`FROM read_parquet('${file}');`));

  ok('ensureView: creates the view', dv.ensureView({ name, parquetPath: file, columns: cols }) === true);

  // DESCRIBE — what a charting layer sees.
  const d = describe(name);
  ok('DESCRIBE: user-facing names', d.map((c) => c.name).join(',') === 'zip,revenue,day');
  ok('DESCRIBE: text → VARCHAR', d[0].type === 'VARCHAR');
  ok('DESCRIBE: number → DOUBLE', d[1].type === 'DOUBLE');
  ok('DESCRIBE: date → VARCHAR (Ordinate `date` is a stored string, not a parsed DATE)', d[2].type === 'VARCHAR');

  // The whole point: aggregate by user-facing name.
  const agg = q(`SELECT sum("revenue") AS s, count(*) AS n FROM ${quoted(name)};`);
  ok('number column: sum() works through the view', agg[0].s === 49.5);
  ok('number column: sum() returns a JS number, not a string', typeof agg[0].s === 'number');
  ok('number column: row count intact', Number(agg[0].n) === 3);

  // The bug this file exists to prevent.
  const zips = q(`SELECT "zip" FROM ${quoted(name)};`).map((r) => r.zip);
  ok("text column: '007' comes back as '007', NOT 7", zips[0] === '007' && typeof zips[0] === 'string');
  ok("text column: '00123' keeps every leading zero", zips[1] === '00123');
  ok(
    'text column: aggregating it is a LOUD binder error, not a plausible wrong total',
    threw(() => q(`SELECT sum("zip") FROM ${quoted(name)};`)),
  );
  ok('date column: stored string passes through verbatim', q(`SELECT "day" FROM ${quoted(name)};`)[0].day === '2024-01-05');

  // sqlGen's isfinite guard: 'inf'/'nan'/''/null in a declared-number column all
  // become NULL, exactly as the JS fold and residentQuery produce.
  const weird = write([{ name: 'n', type: 'number' }], [['inf'], ['nan'], ['3'], [null], ['']]);
  const wname = viewName();
  ok('ensureView: number column with junk cells', dv.ensureView({ name: wname, parquetPath: weird, columns: [{ name: 'n', type: 'number' }] }));
  const wvals = q(`SELECT "n" FROM ${quoted(wname)};`).map((r) => r.n);
  ok("number column: 'inf'/'nan'/''/null → NULL, only 3 survives", JSON.stringify(wvals) === JSON.stringify([null, null, 3, null, null]));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AN UNRECOGNISED DECLARED TYPE degrades to text — never to a cast.
// ─────────────────────────────────────────────────────────────────────────────
{
  const bogus = [{ name: 'a', type: 'integer' as unknown as ParsedColumn['type'] }];
  const vc = dv.viewColumns(bogus);
  ok('unknown ColumnType → text (never a cast)', vc[0].type === 'text');
  const file = write([{ name: 'a', type: 'text' }], [['007']]);
  const name = viewName();
  ok('unknown ColumnType: view still creates', dv.ensureView({ name, parquetPath: file, columns: bogus }));
  ok("unknown ColumnType: '007' preserved", q(`SELECT "a" FROM ${quoted(name)};`)[0].a === '007');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. DUPLICATE NAMES — first-wins, `_N` suffix, ASCII-case-INSENSITIVE.
//    `viewColumns()` must equal what DESCRIBE reports: if DuckDB's own silent
//    rename ever fired instead, these two would disagree.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'a', type: 'text' },
    { name: 'a', type: 'text' },
    { name: 'A', type: 'text' },
    { name: 'a_1', type: 'text' },
    { name: 'b', type: 'text' },
  ];
  const vc = dv.viewColumns(cols);
  ok('dedupe: predictable a, a_1, A_2, a_1_1, b', vc.map((c) => c.name).join(',') === 'a,a_1,A_2,a_1_1,b');
  ok('dedupe: physical names stay positional c0..c4', vc.map((c) => c.physical).join(',') === 'c0,c1,c2,c3,c4');
  ok('dedupe: pure — same input, same output', JSON.stringify(dv.viewColumns(cols)) === JSON.stringify(vc));

  const file = write(cols, [['p', 'q', 'r', 's', 't']]);
  const name = viewName();
  ok('dedupe: view creates', dv.ensureView({ name, parquetPath: file, columns: cols }));
  ok('dedupe: DESCRIBE agrees with viewColumns (no silent DuckDB rename)', describe(name).map((c) => c.name).join(',') === vc.map((c) => c.name).join(','));
  const row = q(`SELECT ${vc.map((c) => quoted(c.name)).join(', ')} FROM ${quoted(name)};`)[0];
  ok('dedupe: each exposed name reads its OWN physical column', vc.map((c) => row[c.name]).join(',') === 'p,q,r,s,t');

  // Non-ASCII case is NOT folded — DuckDB folds ASCII only, so neither do we.
  const uni = dv.viewColumns([
    { name: 'É', type: 'text' },
    { name: 'é', type: 'text' },
    { name: 'İ', type: 'text' },
    { name: 'i', type: 'text' },
  ]);
  ok('dedupe: non-ASCII case is not folded (matches DuckDB)', uni.map((c) => c.name).join(',') === 'É,é,İ,i');
  const ufile = write([{ name: 'x', type: 'text' }, { name: 'x', type: 'text' }, { name: 'x', type: 'text' }, { name: 'x', type: 'text' }], [['1', '2', '3', '4']]);
  const uname = viewName();
  ok('dedupe: non-ASCII names create a real view', dv.ensureView({ name: uname, parquetPath: ufile, columns: [{ name: 'É', type: 'text' }, { name: 'é', type: 'text' }, { name: 'İ', type: 'text' }, { name: 'i', type: 'text' }] }));
  ok('dedupe: DESCRIBE keeps all four distinct', describe(uname).map((c) => c.name).join(',') === 'É,é,İ,i');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. UNREPRESENTABLE NAMES — replaced wholesale, positionally, 1-based.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cols = [
    { name: '', type: 'text' },
    { name: 'ok', type: 'text' },
    { name: 'has\0nul', type: 'text' },
    { name: undefined as unknown as string, type: 'text' },
    { name: '   ', type: 'text' },
  ] as ParsedColumn[];
  const vc = dv.viewColumns(cols);
  ok('hostile: empty name → column_1', vc[0].name === 'column_1');
  ok('hostile: good name untouched', vc[1].name === 'ok');
  ok('hostile: NUL-bearing name → column_3 (wholesale, never half-rewritten)', vc[2].name === 'column_3');
  ok('hostile: non-string name → column_4', vc[3].name === 'column_4');
  ok('hostile: whitespace-only name is LEGAL and kept verbatim', vc[4].name === '   ');

  const file = write(cols, [['a', 'b', 'c', 'd', 'e']]);
  const name = viewName();
  ok('hostile: view creates over the fallback names', dv.ensureView({ name, parquetPath: file, columns: cols }));
  ok('hostile: DESCRIBE matches viewColumns', describe(name).map((c) => c.name).join('|') === 'column_1|ok|column_3|column_4|   ');
  ok('hostile: whitespace-only column is queryable', q(`SELECT "   " AS w FROM ${quoted(name)};`)[0].w === 'e');

  // A generated fallback is POSITIONAL (1-based), so a blank name at index 1
  // wants `column_2` — and if a real column already took that, the same
  // de-duplication loop resolves it.
  const clash = dv.viewColumns([{ name: 'column_2', type: 'text' }, { name: '', type: 'text' }]);
  ok('hostile: fallback colliding with a real column_2 → column_2_1', clash.map((c) => c.name).join(',') === 'column_2,column_2_1');
  const noClash = dv.viewColumns([{ name: 'column_1', type: 'text' }, { name: '', type: 'text' }]);
  ok('hostile: fallback name is positional, not sequential', noClash.map((c) => c.name).join(',') === 'column_1,column_2');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. INJECTION — a `"` or `;` in a column name cannot break out of the
//    identifier. The name below is crafted to drop a sentinel view.
// ─────────────────────────────────────────────────────────────────────────────
{
  const sentinel = viewName();
  const base = write([{ name: 'x', type: 'text' }], [['keep-me']]);
  ok('injection: sentinel view exists first', dv.ensureView({ name: sentinel, parquetPath: base, columns: [{ name: 'x', type: 'text' }] }));

  const evil = `evil"; DROP VIEW ${sentinel}; SELECT ' --`;
  const alsoEvil = "o'brien'); DELETE FROM x; --";
  const newlined = 'two\nlines';
  const cols: ParsedColumn[] = [
    { name: evil, type: 'text' },
    { name: alsoEvil, type: 'text' },
    { name: newlined, type: 'text' },
    { name: 'select', type: 'number' }, // a bare SQL keyword
  ];
  const file = write(cols, [['A', 'B', 'C', 5]]);
  const name = viewName();

  const sql = dv.viewSql({ name, parquetPath: file, columns: cols });
  ok('injection: embedded `"` is doubled inside the identifier', sql.includes('"evil""; DROP VIEW '));
  ok('injection: view creates', dv.ensureView({ name, parquetPath: file, columns: cols }));

  ok(
    'injection: the sentinel view SURVIVED — nothing broke out',
    q(`SELECT "x" FROM ${quoted(sentinel)};`)[0].x === 'keep-me',
  );
  const d = describe(name);
  ok('injection: hostile name is stored VERBATIM as one identifier', d[0].name === evil);
  ok('injection: single quotes in a name are inert', d[1].name === alsoEvil);
  ok('injection: a newline inside an identifier is legal and preserved', d[2].name === newlined);
  ok('injection: a SQL keyword is a fine quoted identifier', d[3].name === 'select' && d[3].type === 'DOUBLE');
  ok('injection: the hostile column is queryable by its quoted name', q(`SELECT ${quoted(evil)} AS v FROM ${quoted(name)};`)[0].v === 'A');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. NULL vs '' STAY DISTINCT through the view (text passes through untouched).
// ─────────────────────────────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [{ name: 'note', type: 'text' }];
  const rows: Cell[][] = [[null], [''], ['  '], ['x']];
  const file = write(cols, rows);
  const name = viewName();
  ok('null/empty: view creates', dv.ensureView({ name, parquetPath: file, columns: cols }));

  const counts = q(
    `SELECT count(*) FILTER (WHERE "note" IS NULL) AS nulls, ` +
      `count(*) FILTER (WHERE "note" = '') AS empties, ` +
      `count(*) FILTER (WHERE "note" = '  ') AS spaces FROM ${quoted(name)};`,
  )[0];
  ok('null/empty: NULL stays NULL (1 row)', Number(counts.nulls) === 1);
  ok("null/empty: '' stays '' and is NOT NULL (1 row)", Number(counts.empties) === 1);
  ok('null/empty: whitespace is not trimmed (1 row)', Number(counts.spaces) === 1);
  const vals = q(`SELECT "note" FROM ${quoted(name)};`).map((r) => r.note);
  ok('null/empty: values round-trip verbatim', JSON.stringify(vals) === JSON.stringify([null, '', '  ', 'x']));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. EMPTY COLUMN LIST — a SELECT with an empty select list is a DuckDB PARSER
//    error (phase-0/06 §4 G7). The row count must still survive.
// ─────────────────────────────────────────────────────────────────────────────
{
  ok('empty: viewColumns([]) is []', dv.viewColumns([]).length === 0);
  ok('empty: viewColumns(garbage) is []', dv.viewColumns(null as unknown as ParsedColumn[]).length === 0);

  const file = write([], [[], [], []]);
  const name = viewName();
  const sql = dv.viewSql({ name, parquetPath: file, columns: [] });
  ok('empty: SQL has a non-empty select list', /SELECT CAST\(NULL AS VARCHAR\) AS "__empty" FROM/.test(sql));
  ok('empty: ensureView succeeds', dv.ensureView({ name, parquetPath: file, columns: [] }));
  ok('empty: the 3 stored rows survive', Number(q(`SELECT count(*) AS n FROM ${quoted(name)};`)[0].n) === 3);
  ok('empty: exactly one sentinel column, not a user column', describe(name).length === 1 && describe(name)[0].name === '__empty');

  // Zero rows AND zero columns.
  const none = write([], []);
  const nname = viewName();
  ok('empty: 0 rows × 0 columns creates', dv.ensureView({ name: nname, parquetPath: none, columns: [] }));
  ok('empty: 0 rows × 0 columns counts 0', Number(q(`SELECT count(*) AS n FROM ${quoted(nname)};`)[0].n) === 0);

  // Zero rows, real columns — DESCRIBE must still report the types.
  const cols: ParsedColumn[] = [{ name: 'a', type: 'number' }, { name: 'b', type: 'text' }];
  const empty = write(cols, []);
  const ename = viewName();
  ok('empty: 0-row table with columns creates', dv.ensureView({ name: ename, parquetPath: empty, columns: cols }));
  ok('empty: 0-row table still DESCRIBEs as DOUBLE,VARCHAR', describe(ename).map((c) => c.type).join(',') === 'DOUBLE,VARCHAR');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. LIFECYCLE — idempotent ensureView, dropView, and clean failures.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [{ name: 'a', type: 'number' }];
  const file = write(cols, [[1], [2]]);
  const name = viewName();
  const spec = { name, parquetPath: file, columns: cols };

  ok('lifecycle: ensureView once', dv.ensureView(spec) === true);
  ok('lifecycle: ensureView twice (idempotent)', dv.ensureView(spec) === true);
  ok('lifecycle: still one usable view after two creates', Number(q(`SELECT count(*) AS n FROM ${quoted(name)};`)[0].n) === 2);

  // A replace picks up NEW metadata without touching the file.
  const renamed: ParsedColumn[] = [{ name: 'renamed', type: 'text' }];
  ok('lifecycle: CREATE OR REPLACE re-types and renames in place', dv.ensureView({ name, parquetPath: file, columns: renamed }));
  const d = describe(name);
  ok('lifecycle: replaced view exposes the new name/type', d[0].name === 'renamed' && d[0].type === 'VARCHAR');
  ok('lifecycle: retyped to text, the number is now its string form', q(`SELECT "renamed" FROM ${quoted(name)};`)[0].renamed === '1');

  ok('lifecycle: dropView returns true', dv.dropView(name) === true);
  ok('lifecycle: the dropped view is GONE', threw(() => q(`SELECT * FROM ${quoted(name)};`)));
  ok('lifecycle: dropView is idempotent (IF EXISTS)', dv.dropView(name) === true);
  ok('lifecycle: dropView of a never-created name', dv.dropView('ds_never_created_at_all') === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. FAILURE MODES — every one returns false, none throws.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [{ name: 'a', type: 'number' }];

  const missing = path.join(dir, 'does-not-exist.parquet');
  ok('fail: missing parquet → false, no throw', dv.ensureView({ name: viewName(), parquetPath: missing, columns: cols }) === false);

  const junk = path.join(dir, 'junk.parquet');
  fs.writeFileSync(junk, 'not parquet at all');
  ok('fail: corrupt parquet → false', dv.ensureView({ name: viewName(), parquetPath: junk, columns: cols }) === false);

  const narrow = write([{ name: 'a', type: 'text' }], [['x']]);
  ok(
    'fail: spec wider than the file → false (c1 does not bind)',
    dv.ensureView({ name: viewName(), parquetPath: narrow, columns: [{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }] }) === false,
  );

  ok('fail: non-.parquet path → false', dv.ensureView({ name: viewName(), parquetPath: '/tmp/x.csv', columns: cols }) === false);
  ok('fail: viewSql throws on a non-.parquet path', threw(() => dv.viewSql({ name: viewName(), parquetPath: '/tmp/x.csv', columns: cols })));

  // View names: validated, never built from a raw id here.
  const bad = ['', '0abc', 'has space', 'has-dash', 'a"; DROP VIEW x; --', 'a;b', 'ünïcode', 'x'.repeat(129), null, undefined, 42];
  let allRejected = true;
  for (const n of bad) {
    if (dv.isViewName(n)) allRejected = false;
    if (dv.ensureView({ name: n as string, parquetPath: narrow, columns: [{ name: 'a', type: 'text' }] }) !== false) allRejected = false;
    if (!threw(() => dv.viewSql({ name: n as string, parquetPath: narrow, columns: [{ name: 'a', type: 'text' }] }))) allRejected = false;
    if (dv.dropView(n as string) !== false) allRejected = false;
  }
  ok('fail: every unsafe view name is rejected by isViewName/viewSql/ensureView/dropView', allRejected);
  ok('ok: a UUID-derived name is accepted', dv.isViewName('ds_550e8400_e29b_41d4_a716_446655440000'));
  ok('ok: a raw UUID (with hyphens) is NOT — the caller must map it', !dv.isViewName('550e8400-e29b-41d4-a716-446655440000'));
  ok('ok: 128 chars accepted, 129 rejected', dv.isViewName('a'.repeat(128)) && !dv.isViewName('a'.repeat(129)));

  ok('fail: malformed spec → false, no throw', dv.ensureView(null as unknown as dv.ViewSpec) === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. PINNED LIMITATION — a LEADING U+FEFF in a column NAME.
//     The view carries it; `src/duckdb.ts`'s transport loses it on read-back, so
//     DESCRIBE cannot report it. Documented in datasetView.ts; pinned here so it
//     stays visible rather than being discovered by a user.
// ─────────────────────────────────────────────────────────────────────────────
{
  const bomName = '﻿region'; // exactly what a UTF-8-BOM CSV header produces
  const cols: ParsedColumn[] = [{ name: bomName, type: 'text' }];
  const file = write(cols, [['north']]);
  const name = viewName();

  ok('BOM: viewColumns reports the name FAITHFULLY', dv.viewColumns(cols)[0].name === bomName);
  ok('BOM: the view creates', dv.ensureView({ name, parquetPath: file, columns: cols }));
  ok('BOM: the faithful identifier binds — the view really holds it', q(`SELECT ${quoted(bomName)} AS v FROM ${quoted(name)};`)[0].v === 'north');
  ok('BOM: DESCRIBE read-back LOSES the leading BOM (duckdb.ts transport, not this module)', describe(name)[0].name === 'region');
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. ROUND-TRIP PARITY — the view's GROUP BY + sum must equal
//     `residentQuery.aggregateResident` over the SAME Parquet file.
//     Two independent paths agreeing is much stronger than either alone.
// ─────────────────────────────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'region', type: 'text' },
    { name: 'revenue', type: 'number' },
    { name: 'units', type: 'number' },
  ];
  const rows: Cell[][] = [
    ['north', 100, 3],
    ['south', 250, 7],
    ['north', 50.5, 1],
    ['east', null, 4],
    ['south', 0, 0],
    ['', 12, 2], // an empty label is its own group
    [null, 8, 1], // NULL is a different group again
    ['north', -20, 5],
    ['west', 1e9, 11],
  ];
  const file = write(cols, rows);
  const name = viewName();
  ok('parity: view creates', dv.ensureView({ name, parquetPath: file, columns: cols }));

  // The view keeps NULL and '' as two distinct groups, so `aggregateResident`'s
  // label transform (NULL → '') would collapse them in a Map. Compare as a
  // sorted MULTISET of (label, value) pairs instead, which stays faithful to two
  // groups that share a label — and neither GROUP BY promises an order.
  const pairs = (labels: (string | number | null)[], values: (number | null)[]): string =>
    JSON.stringify(labels.map((l, i) => `${l == null ? '' : String(l)} ${values[i]}`).sort());

  for (const measure of ['revenue', 'units']) {
    // Path A — through the view, exactly what a chart layer would generate.
    const viaView = q(
      `SELECT "region" AS g, sum(${quoted(measure)}) AS m FROM ${quoted(name)} GROUP BY "region";`,
    );
    const a = pairs(
      viaView.map((r) => (r.g == null ? null : String(r.g))),
      viaView.map((r) => (r.m == null ? null : Number(r.m))),
    );

    // Path B — residentQuery, straight off the same file, no view involved.
    const out = rq.aggregateResident(
      { parquetPath: file, columns: cols },
      'region',
      [{ column: measure, aggregation: 'sum' }],
    );
    ok(`parity(${measure}): aggregateResident returned data`, out !== null);
    if (!out) continue;
    const b = pairs(out.labels, out.series[0].values);

    ok(`parity(${measure}): same group count (${out.labels.length})`, viaView.length === out.labels.length);
    ok(`parity(${measure}): 6 groups — NULL and '' are NOT merged`, viaView.length === 6);
    ok(`parity(${measure}): every group's sum matches residentQuery exactly`, a === b);
  }

  // …and the view keeps NULL distinguishable from '' where the label transform
  // cannot: at the value level, which is what a filter or a join would see.
  const split = q(
    `SELECT count(*) FILTER (WHERE "region" IS NULL) AS nulls, ` +
      `count(*) FILTER (WHERE "region" = '') AS empties FROM ${quoted(name)};`,
  )[0];
  ok("parity: through the view, NULL and '' are still one row each", Number(split.nulls) === 1 && Number(split.empties) === 1);

  // And the case the view exists to make possible at all: a multi-measure query
  // in ONE statement, by user-facing name.
  const multi = q(
    `SELECT "region" AS g, sum("revenue") AS r, sum("units") AS u FROM ${quoted(name)} ` +
      `WHERE "region" = 'north' GROUP BY "region";`,
  );
  ok('parity: multi-measure + WHERE by user-facing name', multi.length === 1 && multi[0].r === 130.5 && multi[0].u === 9);
}

// ─────────────────────────────────────────────────────────────────────────────

cleanup();
duck.shutdown();
if (failures > 0) {
  console.error(`\n${failures} datasetView check(s) failed`);
  process.exit(1);
}
console.log('\nAll datasetView checks passed.');
