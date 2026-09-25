'use strict';

// Self-check for SQL over the project's own datasets: src/engine/sqlDatasets.ts,
// analysis/params.ts (bindSqlParams), sqlLex.ts, the `sql` origin, and push refresh
// (src/data/datasetDependents.ts).
//
// The pure parts (names, dependency extraction, parameter binding, the
// read-only gate) are asserted directly. Everything else runs a REAL query over
// REAL Parquet written by the ordinary save path, under the real engine lock —
// 'electron' is stubbed only to point userData at a temp dir, exactly as
// test-dataset-refresh.ts does. The headline check is a DIFFERENTIAL: a
// GROUP BY + sum written by a user must equal residentQuery.aggregateResident
// over the same file, compared with Object.is.
//
//   npm run build:ts && node scripts/test-sqlDatasets.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sql-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData }, ipcMain: {}, dialog: {} };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const sq: typeof import('../src/engine/sqlDatasets') = require('../src/engine/sqlDatasets');
const sp: typeof import('../src/analysis/params') = require('../src/analysis/params');
const origin: typeof import('../src/data/datasetOrigin') = require('../src/data/datasetOrigin');
const rq: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const refresh: typeof import('../src/data/datasetRefresh') = require('../src/data/datasetRefresh');
const deps: typeof import('../src/data/datasetDependents') = require('../src/data/datasetDependents');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const ipc: typeof import('../src/ipc/sqlQuery') = require('../src/ipc/sqlQuery');

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Names: exact (quoted) + slug, collisions, quoting
// ─────────────────────────────────────────────────────────────────────────────
{
  ok('slug: spaces and case', sq.slugify('Retail orders') === 'retail_orders');
  ok('slug: runs of punctuation collapse, ends trim', sq.slugify('  Q3 -- "Sales" (EU)!! ') === 'q3_sales_eu');
  ok('slug: leading digit gets a _', sq.slugify('2024 sales') === '_2024_sales');
  ok('slug: unicode letters fall away, never empty', sq.slugify('Café') === 'caf' && sq.slugify('日本') === 'dataset');
  ok('slug: a reserved word is suffixed so it works unquoted', sq.slugify('Order') === 'order_');

  const names = sq.assignViewNames([
    { id: U(3), name: 'sales', createdAt: '2024-01-03' },
    { id: U(1), name: 'Sales', createdAt: '2024-01-01' },
    { id: U(2), name: 'He said "hi"', createdAt: '2024-01-02' },
    { id: U(4), name: 'sales_2', createdAt: '2024-01-04' },
  ]);
  const n1 = names.get(U(1))!;
  const n3 = names.get(U(3))!;
  const n4 = names.get(U(4))!;
  ok('names: the OLDER of "Sales"/"sales" keeps the exact name', n1.alias === 'Sales' && n3.alias === null);
  ok('names: its slug is the same identifier, not a second claim', n1.slug === 'sales');
  ok('names: the younger namesake gets a deduplicated slug past a real "sales_2"',
    n4.alias === 'sales_2' && n3.slug === 'sales_3', JSON.stringify([...names]));
  ok('names: a name with a double quote is kept verbatim as the alias', names.get(U(2))!.alias === 'He said "hi"');
  const again = sq.assignViewNames([
    { id: U(4), name: 'sales_2', createdAt: '2024-01-04' },
    { id: U(2), name: 'He said "hi"', createdAt: '2024-01-02' },
    { id: U(3), name: 'sales', createdAt: '2024-01-03' },
    { id: U(1), name: 'Sales', createdAt: '2024-01-01' },
  ]);
  ok('names: deterministic regardless of input order', JSON.stringify([...again].sort()) === JSON.stringify([...names].sort()));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Dependency extraction
// ─────────────────────────────────────────────────────────────────────────────
{
  const cat = [
    { id: U(1), alias: 'Retail orders', slug: 'retail_orders' },
    { id: U(2), alias: 'Regions', slug: 'regions' },
    { id: U(3), alias: 'targets', slug: 'targets' },
  ];
  const d = (sql: string): string => sq.extractDeps(sql, cat).join(',');
  ok('deps: quoted exact name', d('select * from "Retail orders"') === U(1));
  ok('deps: bare slug, any case', d('select * from RETAIL_Orders') === U(1));
  ok('deps: quoted name matched case-insensitively (DuckDB folds ASCII)', d('select * from "retail ORDERS"') === U(1));
  ok('deps: first-reference order, de-duplicated',
    d('select * from regions r join retail_orders o on 1=1 join "Regions" x on 1=1') === `${U(2)},${U(1)}`);
  ok('deps: names inside strings and comments are ignored',
    d("select 'regions', \"x\" from t -- targets\n/* retail_orders /* nested */ regions */") === '');
  ok("deps: a '' escape does not end the string early", d("select 'it''s regions' from t") === '');
  ok('deps: a CTE named like nothing is not a dataset', d('with recent as (select 1) select * from recent') === '');
  ok('deps: a CTE that shadows a dataset name still counts (one unused CTE, harmless)',
    d('with targets as (select 1) select * from targets') === U(3));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Parameter binding — values are bound, never spliced
// ─────────────────────────────────────────────────────────────────────────────
{
  const P = (name: string, kind: any, value: unknown): any => ({ name, kind, value });
  const b = sp.bindSqlParams(
    "select * from t where n > [[min]] and s = [[who]] and d >= [[from]] and r in [[regions]]",
    [P('min', 'number', 10), P('who', 'text', 'ann'), P('from', 'date', '2024-02-29'), P('regions', 'list', ['n', 's'])],
  );
  ok('bind: each kind becomes ?, a list (?, ?)',
    'sql' in b && b.sql === 'select * from t where n > ? and s = ? and d >= ? and r in (?, ?)', JSON.stringify(b));
  ok('bind: binds in placeholder order', 'binds' in b && JSON.stringify(b.binds) === JSON.stringify([10, 'ann', '2024-02-29', 'n', 's']));
  const empty = sp.bindSqlParams('select 1 where x in [[ids]]', [P('ids', 'list', [])]);
  ok('bind: an empty list is (NULL) — matches nothing', 'sql' in empty && empty.sql === 'select 1 where x in (NULL)' && empty.binds.length === 0);
  const lit = sp.bindSqlParams("select '[[a]]', \"[[a]]\" -- [[a]]\n/* [[a]] */ , [[a]]", [P('a', 'number', 1)]);
  ok('bind: placeholders in strings, identifiers and comments are untouched',
    'sql' in lit && lit.sql === "select '[[a]]', \"[[a]]\" -- [[a]]\n/* [[a]] */ , ?" && lit.binds.length === 1, JSON.stringify(lit));
  const unknown = sp.bindSqlParams('select [[nope]]', []);
  ok('bind: an unknown name is an error naming it', 'error' in unknown && unknown.error.includes('[[nope]]'));
  const wrong = sp.bindSqlParams('select [[n]]', [P('n', 'number', '12')]);
  ok('bind: a string for a number is an error naming it', 'error' in wrong && wrong.error.includes('[[n]]'));
  const badDate = sp.bindSqlParams('select [[d]]', [P('d', 'date', '2023-02-29')]);
  ok('bind: a date that is not a real day is refused', 'error' in badDate);
  const evil = "x'); DROP TABLE t; --";
  const inj = sp.bindSqlParams('select * from t where s = [[s]]', [P('s', 'text', evil)]);
  ok('bind: a hostile text value never reaches the SQL text',
    'sql' in inj && !inj.sql.includes('DROP') && inj.binds[0] === evil);
  ok('bind: a list may only hold text and numbers', 'error' in sp.bindSqlParams('select [[l]]', [P('l', 'list', [{}])]));
  ok('params: sanitize drops the WHOLE list on one bad entry',
    sp.sanitizeSqlParams([P('a', 'number', 1), P('b', 'date', 'soon')]) === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The read-only gate
// ─────────────────────────────────────────────────────────────────────────────
{
  const refused = (sql: string): boolean => sq.readOnlyError(sql) !== null;
  ok('gate: a plain select passes', !refused('select 1'));
  ok('gate: WITH, FROM-first, VALUES and ( all pass',
    !refused('with x as (select 1) select * from x') && !refused('from t') && !refused('values (1)') && !refused('(select 1)'));
  ok('gate: trailing semicolon is fine', !refused('select 1;'));
  ok('gate: DDL is refused', refused('drop table t') && refused('create table t as select 1'));
  ok('gate: two statements are refused', refused('select 1; select 2') && refused('select 1; drop table t'));
  ok('gate: COPY / ATTACH / SET / PRAGMA are refused',
    refused("copy (select 1) to 'x.csv'") && refused("attach 'x.db'") && refused('set threads=1') && refused('pragma version'));
  ok('gate: read_csv(...) is refused', refused("select * from read_csv('/etc/hosts')"));
  ok('gate: even quoted, or with a space before (', refused("select * from \"read_text\" ('x')") && refused('select * from read_parquet (\'x\')'));
  ok('gate: query() cannot smuggle a read inside a string', refused("select * from query('select * from read_text(''x'')')"));
  ok("gate: FROM 'file.csv' (a replacement scan) is refused", refused("select * from 'data.csv'"));
  ok('gate: …after a comma or a JOIN too', refused("select * from t, 'x.parquet'") && refused("select * from t join 'x.json' on true"));
  ok('gate: …and as a path-shaped quoted name', refused('select * from "/tmp/x.csv"'));
  ok('gate: a dataset literally named "sales.csv" is still a dataset', sq.readOnlyError('select * from "sales.csv"', new Set(['sales.csv'])) === null);
  ok('gate: a string VALUE after a comma in a select list is fine', !refused("select 'a/b.csv', x from t"));
  ok("gate: the shared catalog's Mosaic views are off limits",
    refused('select * from ds_00000000_0000_4000_8000_000000000001'));
  ok("gate: E'…' escapes cannot hide a call from the lexer", refused("select E'\\'' || read_text('x') --'"));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Origins
// ─────────────────────────────────────────────────────────────────────────────
{
  const good = origin.sanitizeOrigin({ kind: 'sql', sql: 'select 1', deps: [U(1), U(1)], params: [{ name: 'a', kind: 'number', value: 2 }] });
  ok('origin: a sql origin survives, deps de-duplicated',
    !!good && good.kind === 'sql' && good.deps.length === 1 && good.params!.length === 1, JSON.stringify(good));
  ok('origin: a non-UUID dep drops it', origin.sanitizeOrigin({ kind: 'sql', sql: 'select 1', deps: ['../x'] }) === undefined);
  ok('origin: a bad param drops it',
    origin.sanitizeOrigin({ kind: 'sql', sql: 'select 1', deps: [], params: [{ name: 'a', kind: 'number', value: 'x' }] }) === undefined);
  ok('origin: an over-long statement is dropped, never truncated',
    origin.sanitizeOrigin({ kind: 'sql', sql: 'select 1 ' + 'x'.repeat(origin.MAX_ORIGIN_SQL), deps: [] }) === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6+. Real queries over real Parquet
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('SQL project');
  const pid = proj!.id;
  const other = await projects.createProject('Another project');

  const orders = await datasets.saveDataset(pid, {
    name: 'Retail orders',
    sourceKind: 'csv',
    columns: [
      { name: 'region', type: 'text' },
      { name: 'revenue', type: 'number' },
      { name: 'code', type: 'text' },
    ],
    rows: [
      ['north', 100, '007'],
      ['south', 250, '010'],
      ['north', 50.5, '007'],
      ['east', null, '1'],
      ['south', 0, '2'],
      ['', 12, '3'],
      [null, 8, '4'],
      ['north', -20, '5'],
      ['west', 1e9, '6'],
    ],
  });
  const quoted = await datasets.saveDataset(pid, {
    name: 'He said "hi"', sourceKind: 'paste', columns: [{ name: 'x', type: 'number' }], rows: [[1], [2]],
  });
  const digits = await datasets.saveDataset(pid, {
    name: '2024 sales', sourceKind: 'csv', columns: [{ name: 'amount', type: 'number' }], rows: [[5], [6]],
  });
  const cafe = await datasets.saveDataset(pid, {
    name: 'Café ☕', sourceKind: 'csv', columns: [{ name: 'cups', type: 'number' }], rows: [[3]],
  });
  const foreign = await datasets.saveDataset(other!.id, {
    name: 'Retail orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }], rows: [['mars']],
  });
  ok('fixtures saved as Parquet', !!orders && !!quoted && !!digits && !!cafe && !!foreign
    && (await datasets.getDatasetMeta(pid, orders!.id))!.resident === true);

  // ── The DIFFERENTIAL ──
  const run = await sq.runSql(pid, 'select region, sum(revenue) as revenue from retail_orders group by region');
  ok('run: GROUP BY + sum over a dataset runs', run.ok === true, run.ok ? '' : run.error);
  const src = await datasets.residentSource(pid, orders!.id);
  const ref = rq.aggregateResident(src!, 'region', [{ column: 'revenue', aggregation: 'sum' }]);
  ok('differential: aggregateResident answered', ref !== null);
  if (run.ok && ref) {
    // NULL and '' are two groups in both; compare as a sorted multiset.
    const key = (l: unknown, v: unknown): string => `${l == null ? '' : String(l)}\u0000${typeof v}`;
    const a = run.rows.map((r) => ({ k: key(r[0], r[1]), v: r[1] })).sort((x, y) => (x.k + x.v < y.k + y.v ? -1 : 1));
    const b = ref.labels.map((l, i) => ({ k: key(l, ref.series[0].values[i]), v: ref.series[0].values[i] }))
      .sort((x, y) => (x.k + x.v < y.k + y.v ? -1 : 1));
    ok('differential: same group count', a.length === b.length && a.length === 6, `${a.length} vs ${b.length}`);
    ok('differential: every sum is Object.is-equal to residentQuery',
      a.length === b.length && a.every((x, i) => x.k === b[i].k && Object.is(x.v, b[i].v)),
      JSON.stringify({ a, b }));
    ok('run: declared number → number column, text → text', run.columns[0].type === 'text' && run.columns[1].type === 'number');
  }

  // ── Names reach DuckDB as written ──
  const exact = await sq.runSql(pid, 'select count(*) as n from "Retail orders"');
  ok('run: the exact quoted name works', exact.ok && exact.rows[0][0] === 9, JSON.stringify(exact));
  const q2 = await sq.runSql(pid, 'select sum(x) as s from "He said ""hi"""');
  ok('run: a name with a double quote works (doubled)', q2.ok && q2.rows[0][0] === 3, JSON.stringify(q2));
  const q3 = await sq.runSql(pid, 'select sum(amount) from _2024_sales');
  ok('run: a leading-digit name works as its _slug', q3.ok && q3.rows[0][0] === 11, JSON.stringify(q3));
  const q4 = await sq.runSql(pid, 'select cups from "Café ☕"');
  ok('run: a unicode name works quoted', q4.ok && q4.rows[0][0] === 3, JSON.stringify(q4));
  const iso = await sq.runSql(pid, "select count(*) from retail_orders where region = 'mars'");
  ok("run: another project's same-named dataset is NOT visible", iso.ok && iso.rows[0][0] === 0, JSON.stringify(iso));

  // ── Cast rules ──
  const textSum = await sq.runSql(pid, 'select sum(region) from retail_orders');
  ok('cast: sum() over a TEXT column is an error, not a number',
    textSum.ok === false && /sum\(VARCHAR\)/.test(textSum.error), JSON.stringify(textSum));
  ok('cast: the error is cleaned (no LINE/caret, no candidate list)',
    textSum.ok === false && !/LINE \d/.test(textSum.error) && !/Candidate/.test(textSum.error));
  const codes = await sq.runSql(pid, "select code from retail_orders where code = '007' limit 1");
  ok("cast: '007' stays text '007'", codes.ok && codes.rows[0][0] === '007' && codes.columns[0].type === 'text');
  const big = await sq.runSql(pid, 'select 12345678901234567890::HUGEINT as big, count(*) as n, 1.5::DECIMAL(4,1) as d, current_date as t from retail_orders');
  ok('cast: an exact-in-JS BIGINT (count) arrives as a number', big.ok && big.rows[0][1] === 9 && big.columns[1].type === 'number');
  ok('cast: a HUGEINT past 2^53 demotes to TEXT with every digit',
    big.ok && big.columns[0].type === 'text' && big.rows[0][0] === '12345678901234567890', JSON.stringify(big));
  ok('cast: DECIMAL is a number, DATE a date', big.ok && big.columns[2].type === 'number' && big.columns[3].type === 'date');
  const names2 = await sq.runSql(pid, 'select 1 as "2", 2 as a, 3 as a');
  // DuckDB's own star expansion renames a repeat to `a_1` — a dataset wants unique names anyway.
  ok('run: integer-like and repeated column names keep their order and values',
    names2.ok && names2.columns.map((c) => c.name).join() === '2,a,a_1' && names2.rows[0].join() === '1,2,3', JSON.stringify(names2));

  // ── The user's own WITH / WITH RECURSIVE ──
  const w = await sq.runSql(pid, 'with n as (select region from retail_orders where revenue > 60) select count(*) from n');
  ok('run: a user WITH over a dataset', w.ok && w.rows[0][0] === 3, JSON.stringify(w));
  const wr = await sq.runSql(pid, 'with recursive t(n) as (select 1 union all select n + 1 from t where n < 4) select sum(n) from t;');
  ok('run: WITH RECURSIVE and a trailing semicolon', wr.ok && wr.rows[0][0] === 10, JSON.stringify(wr));
  const tail = await sq.runSql(pid, 'select 1 as one -- a trailing comment');
  ok('run: a trailing line comment does not eat the wrapper', tail.ok && tail.rows[0][0] === 1, JSON.stringify(tail));

  // ── Parameters end to end ──
  const pr = await sq.runSql(pid, 'select count(*) from retail_orders where revenue > [[min]] and region in [[rs]]', [
    { name: 'min', kind: 'number', value: 10 }, { name: 'rs', kind: 'list', value: ['north', 'south'] },
  ]);
  ok('params: bound values filter', pr.ok && pr.rows[0][0] === 3, JSON.stringify(pr));

  // ── Read-only, through the real runner ──
  for (const [label, sql] of [
    ['DDL', 'drop table x'],
    ['multi-statement', 'select 1; select 2'],
    ['read_csv', "select * from read_csv('/etc/hosts')"],
    ['COPY', "copy (select 1) to 'x.csv'"],
    ['replacement scan', `select * from '${path.join(tmpUserData, 'config.json')}'`],
  ]) {
    const r = await sq.runSql(pid, sql);
    ok(`read-only: ${label} is refused`, r.ok === false, JSON.stringify(r));
  }
  const inSub = await sq.runSql(pid, 'with x as (select 1) insert into t select * from x');
  ok('read-only: DML hidden behind a WITH is a syntax error in the wrapper', inSub.ok === false);

  // ── Preview and cap ──
  const pv = await sq.runSql(pid, 'select * from range(600)');
  ok('preview: truncates at 500 and says so', pv.ok && pv.rowCount === 500 && pv.truncated === true, JSON.stringify({ ...pv, rows: undefined }));
  const exactly = await sq.runSql(pid, 'select * from range(500)');
  ok('preview: exactly 500 is NOT "500+"', exactly.ok && exactly.rowCount === 500 && exactly.truncated === false);
  const over = await sq.runForDataset(pid, 'select * from range(11)', [], 10);
  ok('cap: a result over the cap is an error on save', over.ok === false && /more than 10 rows/.test(over.error), JSON.stringify(over));
  const at = await sq.runForDataset(pid, 'select * from range(10)', [], 10);
  ok('cap: exactly the cap saves', at.ok && at.rows.length === 10);

  // ── Explain ──
  const ex = await sq.explainSql(pid, 'select region, sum(revenue) as r from "Retail orders" group by 1', []);
  ok('explain: columns + types, no rows',
    ex.ok && ex.columns.map((c) => `${c.name}:${c.sqlType}:${c.kind}`).join() === 'region:VARCHAR:text,r:DOUBLE:number', JSON.stringify(ex));
  const exBad = await sq.explainSql(pid, 'select nope from retail_orders', []);
  ok('explain: a binder error comes back as {ok:false}', exBad.ok === false && /nope/.test(exBad.error));

  // ── A legacy inline record is reported, not guessed at ──
  const legacyId = U(99);
  fs.writeFileSync(path.join(tmpUserData, 'projects', pid, 'datasets', legacyId + '.json'), JSON.stringify({
    id: legacyId, name: 'Old one', sourceKind: 'csv', columns: [{ name: 'a', type: 'text' }], rows: [['x']],
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 2,
  }));
  const legacy = await sq.runSql(pid, 'select * from old_one');
  ok('legacy: an inline record is "not queryable, re-save it"', legacy.ok === false && /re-save/.test(legacy.error), JSON.stringify(legacy));
  const schema: any = await ipc.schemaFor(pid);
  const legacyRow = schema.ok && schema.datasets.find((d: any) => d.id === legacyId);
  ok('schema: lists every dataset with names, slug, columns; legacy flagged',
    schema.ok && schema.datasets.length === 5 && legacyRow && legacyRow.queryable === false
      && schema.datasets.some((d: any) => d.alias === 'Retail orders' && d.slug === 'retail_orders' && d.columns.length === 3));
  ok('schema: an invalid project id is refused', (await ipc.schemaFor('../x') as any).ok === false);
  fs.rmSync(path.join(tmpUserData, 'projects', pid, 'datasets', legacyId + '.json'));

  // ── Save → refresh → push refresh ──
  const saveRun = await sq.runForDataset(pid, 'select region, sum(revenue) as total from retail_orders where revenue > [[min]] group by region', [
    { name: 'min', kind: 'number', value: 0 }, { name: 'unused', kind: 'text', value: 'x' },
  ]);
  ok('save: origin carries the text, the USED params and the deps',
    saveRun.ok && saveRun.origin.sql.includes('[[min]]') && saveRun.origin.params!.length === 1
      && saveRun.origin.deps.join() === orders!.id, JSON.stringify(saveRun.ok ? saveRun.origin : saveRun));
  if (!saveRun.ok) return;
  const derived = await datasets.saveDataset(pid, {
    name: 'Totals', sourceKind: 'sql', columns: saveRun.columns, rows: saveRun.rows, origin: saveRun.origin,
  });
  const second = await sq.runForDataset(pid, 'select count(*) as n_groups from totals', []);
  const derived2 = second.ok ? await datasets.saveDataset(pid, {
    name: 'Group count', sourceKind: 'sql', columns: second.columns, rows: second.rows, origin: second.origin,
  }) : null;
  const summaries = await datasets.listDatasets(pid);
  const tot = summaries.find((s) => s.id === derived!.id);
  ok('summary: sourceKind sql, originKind sql, originDeps', !!tot && tot.sourceKind === 'sql' && tot.originKind === 'sql'
    && (tot.originDeps || []).join() === orders!.id);
  ok('chain: a query over a SQL dataset records it as its dep',
    !!derived2 && (summaries.find((s) => s.id === derived2.id)!.originDeps || []).join() === derived!.id);

  const before = (await datasets.getDataset(pid, derived!.id))!.rows.length;
  await datasets.updateSteps(pid, orders!.id, [{ type: 'filter', column: 'region', op: '=', value: 'north' } as any]);
  await deps.refreshDependents(pid, orders!.id);
  const afterTot = await datasets.getDataset(pid, derived!.id);
  const afterCount = await datasets.getDataset(pid, derived2!.id);
  ok('push: a prepare step on the input re-runs its SQL dataset', before === 5 && afterTot!.rows.length === 1,
    `${before} → ${afterTot!.rows.length}`);
  ok('push: …recursively, in order (the count saw the NEW totals)', afterCount!.rows[0][0] === 1, JSON.stringify(afterCount!.rows));
  ok('push: …and stamped them fresh', afterTot!.lastRefreshStatus === 'ok' && afterCount!.lastRefreshStatus === 'ok');

  const manual = await refresh.refreshDataset(pid, derived!.id);
  ok('refresh: a sql dataset refreshes on its own', manual.ok === true, manual.ok ? '' : manual.error);

  await datasets.deleteDataset(pid, orders!.id);
  await deps.refreshDependents(pid, derived!.id); // nothing changed, but its input is gone
  const broken = await refresh.refreshDataset(pid, derived!.id);
  const afterBroken = await datasets.getDataset(pid, derived!.id);
  ok('refresh: a missing input fails cleanly and keeps the rows',
    broken.ok === false && afterBroken!.lastRefreshStatus === 'error' && afterBroken!.rows.length === 1);
}

main()
  .then(() => {
    duck.shutdown();
    Module._load = origLoad;
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    if (failureCount()) console.error('\n' + failureCount() + ' sqlDatasets check(s) FAILED');
    else console.log('\nAll sqlDatasets checks passed.');
    finish();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
