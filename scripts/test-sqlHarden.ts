// Self-check for src/engine/sqlHarden.ts — the DuckDB lock every user-SQL path
// relies on (src/engine/sqlDatasets.ts, sqlGate.ts, src/connectors/duckdbDirs.ts).
// It proves the three things that are easy to get wrong and impossible to see
// afterwards:
//
//   1. THE STATEMENT LEXER counts statements the way THIS DuckDB build lexes
//      them — each quoting form asserted as a count AND cross-checked against
//      the engine — and fails closed.
//
//   2. MULTI-STATEMENT SQL EXECUTES through `@duckdb/node-api`: a sentinel view
//      really is dropped by a second statement, which is why the gate exists.
//
//   3. THE ENGINE LOCK. `SET allowed_directories=[…]` is accepted and enforces
//      NOTHING unless external access is disabled AFTERWARDS — measured. A
//      security control that looks applied and does nothing is worse than none,
//      so both orders are pinned on a fresh connection.
//
// (This file began as test-mosaicIpc.ts. The Mosaic channels it also covered —
// the typed dataset view, the row cap, Arrow refusal, the async-only proof —
// went with the Mosaic chart stack at the T8.1 cutover.)
//
//   npm run build:ts && node scripts/test-sqlHarden.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

// Everything DuckDB is allowed to touch has to live under ONE root, because the
// hardening this suite applies is real and irreversible for the process.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sqlharden-')));
// A sibling, deliberately OUTSIDE the allow-list, for the escape attempts.
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sqlharden-out-')));

process.env.ORDINATE_LOCAL_DIR = root;

const h: typeof import('../src/engine/sqlHarden') = require('../src/engine/sqlHarden');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
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

/** One gated statement on the hardened engine, as every user-SQL path runs it: its rows, or a throw. */
async function rows(sql: string): Promise<Record<string, string | number | null>[]> {
  if (!h.isSingleStatement(sql)) throw new Error(`Rejected: expected exactly one SQL statement, found ${h.statementCount(sql)}`);
  await h.hardenConnection([root]);
  return duck.queryAsync(sql);
}

/** `rows`, as an outcome: { ok } or { ok:false, error } — never a throw. */
async function attempt(sql: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await rows(sql);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  // The escape target, written NOW: once the engine is hardened, DuckDB cannot
  // write outside the allowed root either. And one table of our own, inside it.
  const outsideParquet = path.join(outside, 'secret.parquet');
  pqSync.writeTable(outsideParquet, [{ name: 'a', type: 'text' }], [['classified']]);
  const insideParquet = path.join(root, 'ours.parquet');
  pqSync.writeTable(insideParquet, [{ name: 'a', type: 'text' }], [['x'], ['y']]);

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
      ok(`lexer: one statement — ${JSON.stringify(s).slice(0, 46)}`, h.statementCount(s) === 1);
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
      ok(`lexer: ${n} statements — ${JSON.stringify(s).slice(0, 42)}`, h.statementCount(s) === n);
    }

    // Fails CLOSED: unterminated quoting is -1 (rejected), never 1.
    const malformed = ["SELECT 'a", 'SELECT "a', 'SELECT $$a', 'SELECT 1 /* a', "SELECT E'a\\'"];
    for (const s of malformed) {
      ok(`lexer: unterminated → -1 (fails closed) — ${JSON.stringify(s)}`, h.statementCount(s) === -1);
    }
    // The E-prefix must be a STANDALONE `e`, not the tail of an identifier or a
    // keyword — `LIKE'%a%'` ends in E and is emphatically not an escape string.
    ok("lexer: LIKE'…' is not mistaken for an E-string", h.statementCount("SELECT 'a' LIKE'%a%' AS v;") === 1);
    ok(
      "lexer: …so a backslash after it stays literal and the next `;` still separates",
      h.statementCount("SELECT 'a' LIKE'%a\\%' AS v; SELECT 2;") === 2,
    );
    ok('lexer: a trailing backslash in a PLAIN string does not swallow the separator', h.statementCount("SELECT 'a\\'; SELECT 2;") === 2);
    ok('lexer: empty input is 0 statements', h.statementCount('') === 0);
    ok('lexer: only comments/semicolons is 0 statements', h.statementCount('-- hi\n;;/* x */') === 0);
    ok('lexer: a non-string is -1', h.statementCount(null as unknown as string) === -1);
    ok('lexer: isSingleStatement agrees with the count', h.isSingleStatement('SELECT 1;') && !h.isSingleStatement('SELECT 1; SELECT 2;'));

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

  // ── viewNameFor: the only way a dataset id becomes a SQL identifier ───────
  {
    const id = '0b6f3b9e-2c1a-4f7e-9a51-3d2c1b0a9e8f';
    ok('view: viewNameFor maps a UUID to ds_ + hex and underscores', h.viewNameFor(id) === 'ds_0b6f3b9e_2c1a_4f7e_9a51_3d2c1b0a9e8f');
    ok('view: viewNameFor rejects a non-UUID', h.viewNameFor('../../etc') === null && h.viewNameFor(null) === null && h.viewNameFor('x;DROP') === null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. MULTI-STATEMENT. Prove the bridge really does execute it — the fact the
  //    one-statement gate exists for — and that the lexer counts it.
  // ───────────────────────────────────────────────────────────────────────────
  {
    await duck.execAsync('CREATE OR REPLACE VIEW sql_sentinel AS SELECT 42 AS s;');
    ok('multi: the sentinel view exists', (await rows('SELECT s FROM sql_sentinel;'))[0].s === 42);

    // Straight at the bridge: this is the vulnerability.
    const two = await duck.queryAsync('SELECT 1 AS one; DROP VIEW sql_sentinel;');
    let sentinelGone = false;
    try {
      await duck.queryAsync('SELECT s FROM sql_sentinel;');
    } catch {
      sentinelGone = true;
    }
    ok('multi: @duckdb/node-api EXECUTES a second statement (verified, not assumed)', sentinelGone);
    ok('multi: …and only the last statement\'s rows come back, so it is invisible', two.length === 0, JSON.stringify(two));

    // What every user-SQL path asks (sqlGate, sqlDatasets): it counts two.
    ok('multi: the lexer counts the smuggled DROP as a second statement', h.statementCount('SELECT 1 AS one; DROP VIEW sql_sentinel2;') === 2);
    ok('multi: unterminated quoting fails closed', h.statementCount("SELECT 'a") === -1);
    // The gate does NOT stop a legitimate `;` inside a literal.
    ok('multi: a `;` inside a string literal is NOT rejected', (await rows("SELECT 'a;b' AS v;"))[0].v === 'a;b');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 9. THE ENGINE LOCK — what it blocks, and the ordering trap.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const st = h.hardeningState();
    ok('lock: hardening was applied', st.attempted === true && st.ok === true, st.error || '');
    ok(
      'lock: allowed_directories is set BEFORE external access is disabled (order is load-bearing)',
      /^SET allowed_directories=/.test(st.applied[0]) &&
        st.applied[1] === 'SET enable_external_access=false;' &&
        st.applied[2] === 'SET lock_configuration=true;',
      st.applied.join(' '),
    );

    ok('lock: our OWN Parquet under the allowed root still reads', (await rows(`SELECT count(*) AS n FROM read_parquet('${insideParquet}');`))[0].n === '2');

    const escape = await attempt(`SELECT * FROM read_parquet('${outsideParquet}');`);
    ok('lock: a file OUTSIDE the allowed root is refused', escape.ok === false);
    ok(
      'lock: …with a Permission Error, not a "file not found"',
      escape.ok === false && /Permission Error/.test(escape.error),
      escape.ok === false ? escape.error.split('\n')[0] : '',
    );

    const copyOut = await attempt(`COPY (SELECT 1 AS a) TO '${path.join(outside, 'exfil.csv')}';`);
    ok('lock: COPY … TO outside the allowed root is refused', copyOut.ok === false && /Permission Error/.test((copyOut).error));
    ok('lock: …and nothing was written', !fs.existsSync(path.join(outside, 'exfil.csv')));

    const load = await attempt('LOAD httpfs;');
    ok('lock: LOAD (native code execution) is refused', load.ok === false && /Permission Error/.test((load).error));
    const install = await attempt('INSTALL httpfs;');
    ok('lock: INSTALL is refused', install.ok === false && /Permission Error/.test((install).error));
    const attach = await attempt(`ATTACH '${path.join(outside, 'x.db')}' AS z;`);
    ok('lock: ATTACH outside is refused', attach.ok === false && /Permission Error/.test((attach).error));

    const unlock = await attempt('SET enable_external_access=true;');
    ok('lock: the configuration cannot be unlocked from SQL', unlock.ok === false && /locked/.test((unlock).error));
    const widen = await attempt("SET allowed_directories=['/'];");
    ok('lock: the allow-list cannot be widened from SQL', widen.ok === false && /locked/.test((widen).error));

    ok('lock: hardenConnection is idempotent', (await h.hardenConnection([root])).applied.length === 3);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 10. THE ORDERING TRAP, on a FRESH connection. `SET allowed_directories` +
  //     `SET lock_configuration` WITHOUT disabling external access is accepted
  //     and enforces NOTHING. This is the assertion that stops someone
  //     "simplifying" hardenConnection into a control that does nothing.
  // ───────────────────────────────────────────────────────────────────────────
  {
    duck.shutdown(); // a fresh worker means a fresh, unhardened connection
    h.resetHardeningForTests();

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

  duck.shutdown();
  cleanup();

  console.log('');
  if (failureCount()) {
    console.error(`${failureCount()} SQL hardening check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All SQL hardening checks passed.');
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
