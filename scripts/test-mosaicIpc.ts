// Self-check for src/ipc/mosaic.ts — the Mosaic database connector over IPC.
//
// Mosaic's whole database contract is one method, so this file has two jobs:
// prove the two channels answer correctly, and prove the three things that are
// easy to get wrong and impossible to see afterwards.
//
//   1. THE ASYNC PATH. A sync bridge call freezes the Electron main thread, and a
//      Mosaic brush drag issues queries every frame (docs/phase-3 blocker B3).
//      Nothing about a sync call LOOKS wrong from the outside, so block 8
//      replaces `duckdb.query`/`duckdb.exec` with THROWING STUBS and runs the
//      entire surface against them. If a sync call ever creeps back in, this
//      fails loudly instead of shipping a per-frame freeze.
//
//   2. THE ENGINE LOCK. `SET allowed_directories=[…]` is accepted and enforces
//      NOTHING unless external access is disabled AFTERWARDS — measured. A
//      security control that looks applied and does nothing is worse than none,
//      so block 9 pins BOTH orders on a fresh connection.
//
//   3. MULTI-STATEMENT SQL EXECUTES through `@duckdb/node-api`. Block 4 proves
//      that against the real bridge (a sentinel view really is dropped by a
//      second statement) before asserting that the channel rejects it.
//
// The last block is DIFFERENTIAL: a GROUP BY + sum through the view must equal
// `residentQuery.aggregateResident` on the same file, compared with `Object.is`
// so `''` can never pass as `null`.
//
// The module is imported directly rather than mirrored: `register()` is the only
// thing that touches `ipcMain`, and it is never called here, so importing is
// inert and the handlers' real logic (`resolveView`/`runQuery`) is under test
// rather than a copy of it.
//
//   npm run build:ts && node scripts/test-mosaicIpc.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

// Everything DuckDB is allowed to touch has to live under ONE root, because the
// hardening this suite applies is real and irreversible for the process.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-mosaic-')));
// A sibling, deliberately OUTSIDE the allow-list, for the escape attempts.
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-mosaic-out-')));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => root } };
  return origLoad.apply(this, [request, ...rest]);
};

const mosaic: typeof import('../src/ipc/mosaic') = require('../src/ipc/mosaic');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');


function cleanup(): void {
  for (const d of [root, outside]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Shorthand: run a query through the channel and return its rows, or throw. */
async function rows(sql: string): Promise<Record<string, string | number | null>[]> {
  const res = await mosaic.runQuery(sql);
  if (!res.ok) throw new Error(res.error);
  return res.rows;
}

async function main(): Promise<void> {
  // The allow-list is chosen BEFORE the first call, because the first call is
  // what hardens the engine — for the life of this process.
  mosaic.setAllowedDirsForTests([root]);

  await projects.init();
  const proj = await projects.createProject('Mosaic');
  if (!proj) throw new Error('project fixture failed');

  // The escape target for block 9, written NOW: once the first Mosaic call has
  // hardened the engine, DuckDB cannot write outside the allowed root either.
  const outsideParquet = path.join(outside, 'secret.parquet');
  parquetStore.writeTable(outsideParquet, [{ name: 'a', type: 'text' }], [['classified']]);

  // ───────────────────────────────────────────────────────────────────────────
  // 1. THE STATEMENT LEXER — pure, and cross-checked against THIS DuckDB build.
  //    Every quoting form it models is asserted twice: once as a count, and once
  //    by asking DuckDB what the same string means. If DuckDB's lexing ever
  //    diverges from the model, the pair disagrees.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const single = [
      'SELECT 1',
      'SELECT 1;',
      ';;SELECT 1;;',
      '  \n SELECT 1 \n ',
      "SELECT 'a;b' AS v;",
      "SELECT 'it''s a; test' AS v;",
      'SELECT 1 AS "a;b";',
      'SELECT 1 AS "he said ""hi"";" ;',
      "SELECT E'a\\'; DROP VIEW x;' AS v;",
      'SELECT $$a;b$$ AS v;',
      'SELECT $tag$a;b$tag$ AS v;',
      'SELECT 1 AS v -- ; DROP VIEW x;\n;',
      'SELECT 1 /* ; DROP VIEW x; */ AS v;',
      'SELECT 1 /* a /* ; */ b */ AS v;',
    ];
    for (const s of single) {
      ok(`lexer: one statement — ${JSON.stringify(s).slice(0, 46)}`, mosaic.statementCount(s) === 1);
    }

    const multi: [string, number][] = [
      ['SELECT 1; DROP VIEW x;', 2],
      ['SELECT 1; SELECT 2', 2],
      ["SELECT 'a'; SELECT 'b'; SELECT 'c';", 3],
      ['SELECT 1 /* c */ ; SELECT 2;', 2],
      ['SELECT 1 -- c\n; SELECT 2;', 2],
      ['SELECT 1 AS "x;y"; DROP VIEW x;', 2],
      ['SELECT $$a$$; DROP VIEW x;', 2],
    ];
    for (const [s, n] of multi) {
      ok(`lexer: ${n} statements — ${JSON.stringify(s).slice(0, 42)}`, mosaic.statementCount(s) === n);
    }

    // Fails CLOSED: unterminated quoting is -1 (rejected), never 1.
    const malformed = ["SELECT 'a", 'SELECT "a', 'SELECT $$a', 'SELECT 1 /* a', "SELECT E'a\\'"];
    for (const s of malformed) {
      ok(`lexer: unterminated → -1 (fails closed) — ${JSON.stringify(s)}`, mosaic.statementCount(s) === -1);
    }
    // The E-prefix must be a STANDALONE `e`, not the tail of an identifier or a
    // keyword — `LIKE'%a%'` ends in E and is emphatically not an escape string.
    ok("lexer: LIKE'…' is not mistaken for an E-string", mosaic.statementCount("SELECT 'a' LIKE'%a%' AS v;") === 1);
    ok(
      "lexer: …so a backslash after it stays literal and the next `;` still separates",
      mosaic.statementCount("SELECT 'a' LIKE'%a\\%' AS v; SELECT 2;") === 2,
    );
    ok('lexer: a trailing backslash in a PLAIN string does not swallow the separator', mosaic.statementCount("SELECT 'a\\'; SELECT 2;") === 2);
    ok('lexer: empty input is 0 statements', mosaic.statementCount('') === 0);
    ok('lexer: only comments/semicolons is 0 statements', mosaic.statementCount('-- hi\n;;/* x */') === 0);
    ok('lexer: a non-string is -1', mosaic.statementCount(null as unknown as string) === -1);
    ok('lexer: isSingleStatement agrees with the count', mosaic.isSingleStatement('SELECT 1;') && !mosaic.isSingleStatement('SELECT 1; SELECT 2;'));

    // The cross-check: DuckDB must agree that each `;` above really is INSIDE a
    // quoted region. A single row back means the engine lexed it the same way.
    ok("cross-check: DuckDB reads 'a;b' as one string", (await rows("SELECT 'a;b' AS v;"))[0].v === 'a;b');
    ok("cross-check: DuckDB reads '' doubling", (await rows("SELECT 'it''s a; test' AS v;"))[0].v === "it's a; test");
    ok('cross-check: DuckDB reads a `;` inside a quoted identifier', 'a;b' in (await rows('SELECT 1 AS "a;b";'))[0]);
    ok('cross-check: DuckDB honours $$ dollar quoting', (await rows('SELECT $$a;b$$ AS v;'))[0].v === 'a;b');
    ok('cross-check: DuckDB honours $tag$ dollar quoting', (await rows('SELECT $tag$a;b$tag$ AS v;'))[0].v === 'a;b');
    ok('cross-check: DuckDB honours E-string backslash escapes', (await rows("SELECT E'a\\'b' AS v;"))[0].v === "a'b");
    ok('cross-check: a backslash in a PLAIN string is literal', (await rows("SELECT 'a\\' AS v;"))[0].v === 'a\\');
    ok('cross-check: DuckDB NESTS block comments', (await rows('SELECT 1 /* a /* ; */ b */ AS v;'))[0].v === 1);
    ok("cross-check: DuckDB reads LIKE'…' as a plain string, backslash and all", (await rows("SELECT 'a\\%' LIKE'%a\\%' AS v;"))[0].v === 'true');
    ok('cross-check: DuckDB accepts leading/repeated semicolons', (await rows(';;SELECT 1 AS v;;'))[0].v === 1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. THE VIEW — a real dataset, never hydrated, typed by the DECLARED type.
  // ───────────────────────────────────────────────────────────────────────────
  const cols: { name: string; type: 'text' | 'number' | 'date' }[] = [
    { name: 'zip', type: 'text' },
    { name: 'region', type: 'text' },
    { name: 'revenue', type: 'number' },
    { name: 'units', type: 'number' },
    { name: 'day', type: 'date' },
  ];
  const tableRows: (string | number | null)[][] = [
    ['007', 'north', 100, 3, '2024-01-05'],
    ['00210', 'south', 250, 7, '2024-01-06'],
    ['007', 'north', 50.5, 1, '2024-01-07'],
    ['90210', 'east', null, 4, '2024-01-08'],
    ['00210', 'south', 0, 0, '2024-01-09'],
    ['007', '', 12, 2, '2024-01-10'],
    ['00001', null, 8, 1, '2024-01-11'],
    ['007', 'north', -20, 5, '2024-01-12'],
    ['90210', 'west', 1e9, 11, '2024-01-13'],
  ];
  const ds = await datasets.saveDataset(proj.id, { name: 'Sales', sourceKind: 'csv', columns: cols, rows: tableRows });
  if (!ds) throw new Error('dataset fixture failed');

  let viewName = '';
  {
    // A dataset load must never hydrate the table to answer this. Spy on the one
    // function that would, so a future rewrite that quietly starts hydrating
    // fails here instead of passing green and slow.
    const realGet = datasets.getDataset;
    let hydrated = 0;
    (datasets as any).getDataset = (...args: any[]) => {
      hydrated += 1;
      return (realGet as any)(...args);
    };

    const res = await mosaic.resolveView(proj.id, ds.id);
    (datasets as any).getDataset = realGet;

    ok('view: resolveView succeeded', res.ok === true, res.ok ? '' : (res as any).error);
    if (!res.ok) throw new Error('resolveView failed: ' + res.error);
    viewName = res.name;

    ok('view: the table was NEVER hydrated', hydrated === 0, `getDataset calls=${hydrated}`);
    ok('view: name is ds_ + the UUID with underscores', res.name === 'ds_' + ds.id.replace(/-/g, '_'));
    ok('view: viewNameFor is the same mapping', mosaic.viewNameFor(ds.id) === res.name);
    ok('view: viewNameFor rejects a non-UUID', mosaic.viewNameFor('../../etc') === null && mosaic.viewNameFor('') === null);
    ok('view: columns are the user-facing names, in order', res.columns.map((c) => c.name).join(',') === 'zip,region,revenue,units,day');
    ok(
      'view: declared types are reported (text/number/date)',
      res.columns.map((c) => c.type).join(',') === 'text,text,number,number,date',
    );
    ok(
      'view: sqlType is DOUBLE only for a DECLARED number, VARCHAR otherwise',
      res.columns.map((c) => c.sqlType).join(',') === 'VARCHAR,VARCHAR,DOUBLE,DOUBLE,VARCHAR',
    );

    // Typed results, straight through the channel.
    const agg = await rows(`SELECT sum("revenue") AS s, count(*) AS n FROM "${viewName}";`);
    ok('view: sum() over a DECLARED number works', agg[0].s === 1000000400.5, String(agg[0].s));
    ok('view: the aggregate is a JS number, not a HUGEINT string', typeof agg[0].s === 'number');

    const day = await rows(`SELECT "day" FROM "${viewName}" LIMIT 1;`);
    ok('view: a date column stays a verbatim string', day[0].day === '2024-01-05');

    ok('view: resolveView is idempotent (CREATE OR REPLACE)', (await mosaic.resolveView(proj.id, ds.id)).ok === true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. THE `007` GUARANTEE — the reason the store is all-VARCHAR in the first
  //    place. `TRY_CAST('007' AS DOUBLE)` is 7; a text column must never see one.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const zips = (await rows(`SELECT "zip" FROM "${viewName}";`)).map((r) => r.zip);
    ok("007: comes back as '007', NOT 7", zips[0] === '007' && typeof zips[0] === 'string');
    ok("007: '00210' and '00001' keep every leading zero", zips[1] === '00210' && zips[6] === '00001');
    ok('007: it groups as a string, so 007 and 7 are not one group', (await rows(`SELECT count(DISTINCT "zip") AS n FROM "${viewName}";`))[0].n === '4');

    const bad = await mosaic.runQuery(`SELECT sum("zip") AS s FROM "${viewName}";`);
    ok('007: sum() over a text column is a LOUD error, not a wrong number', bad.ok === false);
    ok(
      '007: and the error is a DuckDB BINDER error naming the failure',
      bad.ok === false && /Binder Error|No function matches/i.test(bad.error),
      bad.ok === false ? bad.error.split('\n')[0] : '',
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. MULTI-STATEMENT. First prove the bridge really does execute it — the fact
  //    the channel gate exists for — then prove the gate stops it.
  // ───────────────────────────────────────────────────────────────────────────
  {
    await duck.execAsync('CREATE OR REPLACE VIEW mosaic_sentinel AS SELECT 42 AS s;');
    ok('multi: the sentinel view exists', (await rows('SELECT s FROM mosaic_sentinel;'))[0].s === 42);

    // Straight at the bridge, bypassing the channel: this is the vulnerability.
    const two = await duck.queryAsync('SELECT 1 AS one; DROP VIEW mosaic_sentinel;');
    let sentinelGone = false;
    try {
      await duck.queryAsync('SELECT s FROM mosaic_sentinel;');
    } catch {
      sentinelGone = true;
    }
    ok('multi: @duckdb/node-api EXECUTES a second statement (verified, not assumed)', sentinelGone);
    ok('multi: …and only the last statement\'s rows come back, so it is invisible', two.length === 0, JSON.stringify(two));

    // Now through the channel.
    await duck.execAsync('CREATE OR REPLACE VIEW mosaic_sentinel2 AS SELECT 43 AS s;');
    const blocked = await mosaic.runQuery('SELECT 1 AS one; DROP VIEW mosaic_sentinel2;');
    ok('multi: the channel REJECTS it', blocked.ok === false && /exactly one SQL statement, found 2/.test((blocked as any).error));
    ok('multi: …and the sentinel SURVIVED', (await rows('SELECT s FROM mosaic_sentinel2;'))[0].s === 43);

    const smuggled = await mosaic.runQuery(`SELECT "zip" FROM "${viewName}"; DROP VIEW "${viewName}";`);
    ok('multi: a smuggled DROP of the dataset view is rejected', smuggled.ok === false);
    ok('multi: …and the dataset view still answers', (await rows(`SELECT count(*) AS n FROM "${viewName}";`))[0].n === '9');

    const unterminated = await mosaic.runQuery("SELECT 'a");
    ok('multi: unterminated quoting is rejected with its own message', unterminated.ok === false && /unterminated/.test((unterminated as any).error));

    // The gate does NOT stop a legitimate `;` inside a literal.
    ok('multi: a `;` inside a string literal is NOT rejected', (await rows("SELECT 'a;b' AS v;"))[0].v === 'a;b');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 5. TYPE HANDLING — arrow refused out loud, exec runs, junk refused.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const arrow = await mosaic.runQuery('SELECT 1 AS v;', 'arrow');
    ok('arrow: REJECTED, never silently downgraded', arrow.ok === false);
    ok(
      'arrow: the error names the cause and the fix (consolidate: false)',
      arrow.ok === false && /no Arrow support/.test(arrow.error) && /consolidate: false/.test(arrow.error),
      arrow.ok === false ? arrow.error.slice(0, 60) + '…' : '',
    );

    const ex = await mosaic.runQuery('CREATE OR REPLACE VIEW mosaic_exec_t AS SELECT 7 AS v;', 'exec');
    ok('exec: runs for side effects', ex.ok === true);
    ok('exec: returns no rows', ex.ok === true && ex.rows.length === 0 && ex.truncated === false);
    ok('exec: the side effect really happened', (await rows('SELECT v FROM mosaic_exec_t;'))[0].v === 7);
    ok('exec: multi-statement is refused on the exec path too', (await mosaic.runQuery('SELECT 1; DROP VIEW mosaic_exec_t;', 'exec')).ok === false);

    ok("type: 'json' is accepted explicitly", (await mosaic.runQuery('SELECT 1 AS v;', 'json')).ok === true);
    ok('type: undefined defaults to a query', (await mosaic.runQuery('SELECT 1 AS v;')).ok === true);
    const junk = await mosaic.runQuery('SELECT 1;', 'parquet');
    ok('type: an unknown type is refused, not guessed', junk.ok === false && /Unsupported query type/.test((junk as any).error));

    ok('sql: an empty string is refused', (await mosaic.runQuery('')).ok === false);
    ok('sql: a non-string is refused', (await mosaic.runQuery(42 as unknown as string)).ok === false);
    ok('sql: a broken query returns { ok:false }, never throws', (await mosaic.runQuery('SELECT * FROM nope_no_such;')).ok === false);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 6. THE ROW CAP — truncation is REPORTED, never silent.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const cap = mosaic.MAX_QUERY_ROWS;
    const exact = await mosaic.runQuery(`SELECT i FROM range(${cap}) t(i);`);
    ok(`cap: exactly ${cap} rows is NOT truncated`, exact.ok === true && exact.rows.length === cap && exact.truncated === false);
    ok('cap: rowCount is the real count', exact.ok === true && exact.rowCount === cap);

    const over = await mosaic.runQuery(`SELECT i FROM range(${cap + 5}) t(i);`);
    ok(`cap: ${cap + 5} rows IS truncated`, over.ok === true && over.truncated === true);
    ok(`cap: …to exactly ${cap} rows`, over.ok === true && over.rows.length === cap);
    ok('cap: …and rowCount reports what was really there', over.ok === true && over.rowCount === cap + 5);
    ok('cap: the kept rows are the FIRST ones, in order', over.ok === true && over.rows[0].i === '0' && over.rows[cap - 1].i === String(cap - 1));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 7. DIFFERENTIAL — GROUP BY + sum through the view must equal
  //    `residentQuery.aggregateResident` on the same file, value for value,
  //    compared with Object.is so '' can never pass as null.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const src = await datasets.residentSource(proj.id, ds.id);
    ok('differential: the dataset is Parquet-backed', src !== null);
    if (!src) throw new Error('no resident source');

    for (const measure of ['revenue', 'units']) {
      const viaChannel = await rows(
        `SELECT "region" AS g, sum("${measure}") AS m FROM "${viewName}" GROUP BY "region";`,
      );
      const viaResident = residentQuery.aggregateResident(src, 'region', [{ column: measure, aggregation: 'sum' }]);
      ok(`differential(${measure}): aggregateResident returned data`, viaResident !== null);
      if (!viaResident) continue;

      // `aggregateResident` maps a NULL label to '', which the view keeps
      // distinct — so compare as a sorted multiset of (label, value) pairs, which
      // stays faithful to two groups that share a label. Neither GROUP BY
      // promises an order.
      const pair = (l: string | number | null, v: number | null): string =>
        `${l == null ? '' : String(l)}\u0000${Object.is(v, null) ? 'null' : String(v)}`;
      const a = viaChannel.map((r) => pair(r.g as string | null, r.m == null ? null : Number(r.m))).sort();
      const b = viaResident.labels.map((l, i) => pair(l, viaResident.series[0].values[i])).sort();

      ok(`differential(${measure}): same group count`, a.length === b.length, `channel=${a.length} resident=${b.length}`);
      ok(`differential(${measure}): 6 groups — NULL and '' are NOT merged`, a.length === 6);
      let same = a.length === b.length;
      for (let i = 0; i < a.length && same; i++) if (!Object.is(a[i], b[i])) same = false;
      ok(`differential(${measure}): every group's sum matches, Object.is`, same, same ? '' : `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }

    // A null measure must stay null, not become 0 — the divergence residentQuery
    // exists to preserve.
    const east = await rows(`SELECT sum("revenue") AS m FROM "${viewName}" WHERE "region" = 'east';`);
    ok('differential: sum of an all-empty group is NULL, never 0', Object.is(east[0].m, null));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 8. THE ASYNC PROOF. Break the SYNC bridge entrypoints; the whole surface must
  //    still work. A sync call would now throw, and `resolveView`/`runQuery`
  //    convert a throw into `{ ok:false }` — so these assertions fail loudly.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const realQuery = duck.query;
    const realExec = duck.exec;
    let syncCalls = 0;
    (duck as any).query = (..._a: any[]) => {
      syncCalls += 1;
      throw new Error('SYNC duckdb.query() was called — this would freeze the main thread every frame');
    };
    (duck as any).exec = (..._a: any[]) => {
      syncCalls += 1;
      throw new Error('SYNC duckdb.exec() was called — this would freeze the main thread every frame');
    };
    try {
      const v = await mosaic.resolveView(proj.id, ds.id);
      ok('async: resolveView works with the SYNC bridge broken', v.ok === true, v.ok ? '' : (v as any).error);

      const q = await mosaic.runQuery(`SELECT sum("revenue") AS s FROM "${viewName}";`);
      ok('async: runQuery(json) works with the SYNC bridge broken', q.ok === true && q.rows[0].s === 1000000400.5);

      const e = await mosaic.runQuery('CREATE OR REPLACE VIEW mosaic_async_t AS SELECT 1 AS v;', 'exec');
      ok('async: runQuery(exec) works with the SYNC bridge broken', e.ok === true);

      ok('async: the sync entrypoints were never called ONCE', syncCalls === 0, `syncCalls=${syncCalls}`);
    } finally {
      (duck as any).query = realQuery;
      (duck as any).exec = realExec;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 9. THE ENGINE LOCK — what it blocks, and the ordering trap.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const st = mosaic.hardeningState();
    ok('lock: hardening was applied on the first Mosaic call', st.attempted === true && st.ok === true, st.error || '');
    ok(
      'lock: allowed_directories is set BEFORE external access is disabled (order is load-bearing)',
      /^SET allowed_directories=/.test(st.applied[0]) &&
        st.applied[1] === 'SET enable_external_access=false;' &&
        st.applied[2] === 'SET lock_configuration=true;',
      st.applied.join(' '),
    );

    ok('lock: our OWN Parquet under the allowed root still reads', (await rows(`SELECT count(*) AS n FROM "${viewName}";`))[0].n === '9');

    const escape = await mosaic.runQuery(`SELECT * FROM read_parquet('${outsideParquet}');`);
    ok('lock: a file OUTSIDE the allowed root is refused', escape.ok === false);
    ok(
      'lock: …with a Permission Error, not a "file not found"',
      escape.ok === false && /Permission Error/.test(escape.error),
      escape.ok === false ? escape.error.split('\n')[0] : '',
    );

    const copyOut = await mosaic.runQuery(`COPY (SELECT 1 AS a) TO '${path.join(outside, 'exfil.csv')}';`, 'exec');
    ok('lock: COPY … TO outside the allowed root is refused', copyOut.ok === false && /Permission Error/.test((copyOut as any).error));
    ok('lock: …and nothing was written', !fs.existsSync(path.join(outside, 'exfil.csv')));

    const load = await mosaic.runQuery('LOAD httpfs;', 'exec');
    ok('lock: LOAD (native code execution) is refused', load.ok === false && /Permission Error/.test((load as any).error));
    const install = await mosaic.runQuery('INSTALL httpfs;', 'exec');
    ok('lock: INSTALL is refused', install.ok === false && /Permission Error/.test((install as any).error));
    const attach = await mosaic.runQuery(`ATTACH '${path.join(outside, 'x.db')}' AS z;`, 'exec');
    ok('lock: ATTACH outside is refused', attach.ok === false && /Permission Error/.test((attach as any).error));

    const unlock = await mosaic.runQuery('SET enable_external_access=true;', 'exec');
    ok('lock: the configuration cannot be unlocked from SQL', unlock.ok === false && /locked/.test((unlock as any).error));
    const widen = await mosaic.runQuery("SET allowed_directories=['/'];", 'exec');
    ok('lock: the allow-list cannot be widened from SQL', widen.ok === false && /locked/.test((widen as any).error));

    ok('lock: hardenConnection is idempotent', (await mosaic.hardenConnection([root])).applied.length === 3);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 10. THE ORDERING TRAP, on a FRESH connection. `SET allowed_directories` +
  //     `SET lock_configuration` WITHOUT disabling external access is accepted
  //     and enforces NOTHING. This is the assertion that stops someone
  //     "simplifying" hardenConnection into a control that does nothing.
  // ───────────────────────────────────────────────────────────────────────────
  {
    duck.shutdown(); // a fresh worker means a fresh, unhardened connection
    mosaic.resetHardeningForTests();

    ok('order: on a fresh connection the outside file reads fine', (await duck.queryAsync(`SELECT * FROM read_parquet('${outsideParquet}');`))[0].c0 === 'classified');

    await duck.execAsync(`SET allowed_directories=['${root}'];`);
    // …and NOT `SET enable_external_access=false`. This is the wrong order.
    let stillReadable = false;
    try {
      await duck.queryAsync(`SELECT * FROM read_parquet('${outsideParquet}');`);
      stillReadable = true;
    } catch {
      /* would mean the allow-list bites on its own */
    }
    ok('order: allowed_directories ALONE enforces NOTHING (the trap)', stillReadable === true);

    await duck.execAsync('SET enable_external_access=false;');
    let nowBlocked = false;
    try {
      await duck.queryAsync(`SELECT * FROM read_parquet('${outsideParquet}');`);
    } catch (err) {
      nowBlocked = /Permission Error/.test(String((err as Error).message));
    }
    ok('order: disabling external access AFTERWARDS is what makes it bite', nowBlocked === true);

    let refusedLate = false;
    try {
      await duck.execAsync(`SET allowed_directories=['${outside}'];`);
    } catch (err) {
      refusedLate = /Cannot change allowed_directories when enable_external_access is disabled/.test(String((err as Error).message));
    }
    ok('order: and the allow-list can no longer be set once access is disabled', refusedLate === true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 11. FAILURE MODES — every one is a clean { ok:false }, none throws.
  // ───────────────────────────────────────────────────────────────────────────
  {
    ok('fail: a non-UUID projectId is refused before it touches a path', (await mosaic.resolveView('../../etc', ds.id)).ok === false);
    ok('fail: a non-UUID datasetId is refused', (await mosaic.resolveView(proj.id, 'x/../y')).ok === false);
    ok('fail: a missing dataset is refused cleanly', (await mosaic.resolveView(proj.id, '00000000-0000-4000-8000-000000000000')).ok === false);
    ok('fail: null ids do not throw', (await mosaic.resolveView(null, null)).ok === false);
  }

  duck.shutdown();
  cleanup();

  console.log('');
  if (failureCount()) {
    console.error(`${failureCount()} mosaic IPC check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All mosaic IPC checks passed.');
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
