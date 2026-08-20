// src/connectors/local.ts — the local/file connector family.
//
// Unlike the network connector families, this one can be tested FOR REAL: the
// engine it uses is the DuckDB the app already ships, sitting right here. So
// nothing below is a mock. Real Parquet, real CSV, a real DuckDB database file,
// real ATTACH, real Permission Errors.
//
// ── WHY THIS SCRIPT SPAWNS CHILD PROCESSES ──────────────────────────────────
// `src/ipc/mosaic.ts` hardens the shared DuckDB connection ONCE PER PROCESS and
// `lock_configuration=true` is irreversible for the life of that process
// (`resetHardeningForTests()` forgets the bookkeeping; the ENGINE stays locked).
// The two orderings that matter are therefore mutually exclusive within one
// process, so each runs in its own child of this same file, selected by
// ORD_SUB:
//
//   ORD_SUB=narrow   Mosaic hardens FIRST, to userData only. The connector must
//                    fail with an explanatory, actionable error — not a raw
//                    Permission Error, and not silently.
//   ORD_SUB=wide     The connector hardens first. Its folder is inside the lock,
//                    Mosaic's later call is a no-op, and BOTH work.
//   ORD_SUB=second   The module's KNOWN LIMITATION, pinned rather than hidden:
//                    query folder A, then folder B, in one session. B fails,
//                    loudly, with the restart message.
//   ORD_SUB=restart  The same userData directory, a NEW process, B first. It
//                    works — which is the proof that the persisted allow-list
//                    registry makes "restart Ordinate" a real fix and not a
//                    brush-off. `second` and `restart` share ORD_UD and ORD_FX.
//
// If `mosaic.ts` ever stops hardening, or hardens in a different order, or the
// allow-list stops being enforced, `narrow` starts passing where it should fail
// and this script goes red. That is the point of pinning it here.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const cp: typeof import('child_process') = require('child_process');
const Module: any = require('module');

// Electron stub, house style (scripts/test-wideTables.ts). `userData` is a temp
// dir so the allow-list registry and the hardening base are both disposable.
// ORD_UD lets a child inherit the PARENT's userData — that is what makes the
// `restart` scenario an honest simulation of relaunching the app.
const tmpUserData =
  process.env.ORD_UD || fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-conn-ud-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_n: string) => tmpUserData }, ipcMain: { handle: () => {} } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const mosaic: typeof import('../src/ipc/mosaic') = require('../src/ipc/mosaic');
const local: typeof import('../src/connectors/local') = require('../src/connectors/local');
type ConnectorContext = import('../src/connectors/types').ConnectorContext;
type ConnectorDef = import('../src/connectors/types').ConnectorDef;
type ConnectorRows = import('../src/connectors/types').ConnectorRows;

let failures = 0;
function ok(label: string, cond: boolean, extra?: string): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else {
    console.error('FAIL ' + label + (extra ? '  ' + extra : ''));
    failures++;
  }
}

function connector(id: string): ConnectorDef {
  const c = local.CONNECTORS.find((d) => d.id === id);
  if (!c) throw new Error('no connector ' + id);
  return c;
}

function ctx(values: Record<string, unknown>, rowLimit = 1000, timeoutMs = 30_000): ConnectorContext {
  return { values, secrets: {}, rowLimit, timeoutMs };
}

const strLit = local.strLit;

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Deliberately OUTSIDE userData — that is the whole conflict this family has to
// survive. And deliberately with a single quote in both the folder and the file
// name: the path is interpolated into SQL, so quote-doubling is load-bearing.

interface Fixtures {
  dir: string;
  parquetDir: string;
  csvDir: string;
  dbFile: string;
}

async function makeFixtures(tag: string): Promise<Fixtures> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-conn-' + tag + '-'));
  const parquetDir = path.join(dir, "o'brien data"); // hostile: a single quote
  const csvDir = path.join(dir, 'csv');
  fs.mkdirSync(parquetDir);
  fs.mkdirSync(csvDir);
  fs.mkdirSync(path.join(parquetDir, 'nested'));

  // Real Parquet, written by the same engine that will read it back. Every value
  // is chosen to catch a coercion: '007' must not become 7, '' must stay
  // distinct from NULL, and the id must survive past 2^53.
  const rows = `SELECT * FROM (VALUES
      ('007', 'north', 10.5, 9007199254740993),
      ('042', '',      20.0, 2),
      ('7',   NULL,    30.25, 3),
      ('x',   'south', 40.0, 4),
      ('y',   'south', 50.0, 5)
    ) AS t(id, region, amount, big)`;
  await duck.execAsync(
    `COPY (SELECT id::VARCHAR AS id, region::VARCHAR AS region, amount::DOUBLE AS amount, big::BIGINT AS big FROM (${rows})) ` +
      `TO ${strLit(path.join(parquetDir, "sa'les.parquet"))} (FORMAT PARQUET)`
  );
  await duck.execAsync(
    `COPY (SELECT 1 AS a) TO ${strLit(path.join(parquetDir, 'nested', 'inner.parquet'))} (FORMAT PARQUET)`
  );

  // Real CSV, written by Node so nothing about it is DuckDB's idea of a CSV.
  fs.writeFileSync(
    path.join(csvDir, "sa'les.csv"),
    'id,region,amount\n007,north,10.5\n042,,20\n7,south,30\n',
    'utf8'
  );

  // A real DuckDB database file, with a table in `main` and one in another
  // schema, so the flat-name mapping is exercised in both directions.
  const dbFile = path.join(dir, "o'brien.duckdb");
  await duck.execAsync(`ATTACH ${strLit(dbFile)} AS w`);
  await duck.execAsync(`CREATE TABLE w.t AS SELECT '007' AS code, 3 AS n`);
  await duck.execAsync(`CREATE SCHEMA w.reporting`);
  await duck.execAsync(`CREATE TABLE w.reporting.monthly AS SELECT 'jan' AS m`);
  await duck.execAsync(`DETACH w`);

  return { dir, parquetDir, csvDir, dbFile };
}

function rowsOf(res: ConnectorRows | { ok: false; error: string }): ConnectorRows {
  if (!res.ok) throw new Error('expected rows, got error: ' + res.error);
  return res;
}

/**
 * Two sibling CSV folders under ORD_FX, `fs` only so no engine is touched while
 * making them. Shared by the `second` and `restart` children, which is the whole
 * point: `restart` must see the SAME paths a previous process recorded.
 */
function sharedFolders(): { a: string; b: string } {
  const root = process.env.ORD_FX as string;
  const a = path.join(root, 'folder-a');
  const b = path.join(root, 'folder-b');
  for (const d of [a, b]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'rows.csv'), 'id\n007\n', 'utf8');
  }
  return { a, b };
}

// ═════════════════════════════════════════════════════════════════════════════
// Child scenario: Mosaic hardens FIRST, narrowly. The connector must explain.
// ═════════════════════════════════════════════════════════════════════════════

async function scenarioNarrow(): Promise<void> {
  const fx = await makeFixtures('narrow');

  // Mosaic's own behaviour, verbatim: userData and nothing else.
  const state = await mosaic.hardenConnection([tmpUserData]);
  ok('narrow: hardening applied', state.ok === true, JSON.stringify(state.applied));

  const csv = connector('csv-folder');
  const res = await csv.run(ctx({ path: fx.csvDir }), 'SELECT * FROM "sa\'les"');
  ok('narrow: a locked-out folder FAILS', res.ok === false);
  const msg = res.ok ? '' : res.error;
  ok('narrow: the error names the session lock', /locked to a fixed set of folders/.test(msg), msg.slice(0, 120));
  ok('narrow: the error tells the user to restart', /[Rr]estart Ordinate/.test(msg));
  ok('narrow: the raw DuckDB wording is not what the user sees', !/^Permission Error/.test(msg));

  // The folder was recorded on the way in, which is what makes "restart" true.
  const registry = JSON.parse(
    fs.readFileSync(path.join(tmpUserData, 'connectors', 'duckdb-dirs.json'), 'utf8')
  ) as string[];
  ok('narrow: the folder was remembered for next launch', registry.includes(fx.csvDir), registry.join(','));

  // Not a broken connector — a folder INSIDE the allow-list still works, which
  // proves the failure above is the allow-list and nothing else.
  const insideDir = path.join(tmpUserData, 'inside');
  fs.mkdirSync(insideDir, { recursive: true });
  fs.writeFileSync(path.join(insideDir, 'ok.csv'), 'a\n1\n', 'utf8');
  const inside = await csv.run(ctx({ path: insideDir }), 'SELECT * FROM "ok"');
  ok('narrow: a folder inside userData still reads', inside.ok === true, inside.ok ? '' : inside.error);
}

// ═════════════════════════════════════════════════════════════════════════════
// Child scenario: the connector hardens first. Both features coexist.
// ═════════════════════════════════════════════════════════════════════════════

async function scenarioWide(): Promise<void> {
  const fx = await makeFixtures('wide');

  ok('wide: nothing hardened yet', mosaic.hardeningState().attempted === false);

  const csv = connector('csv-folder');
  const first = await csv.run(ctx({ path: fx.csvDir }), 'SELECT * FROM "sa\'les"');
  ok('wide: the connector reads its folder', first.ok === true, first.ok ? '' : first.error);

  const state = mosaic.hardeningState();
  ok('wide: the connector hardened the engine', state.attempted === true && state.ok === true);
  ok(
    'wide: userData is in the lock (Mosaic’s guarantee is preserved)',
    state.applied[0].includes(fs.realpathSync(tmpUserData))
  );
  ok('wide: the picked folder is in the lock', state.applied[0].includes(fs.realpathSync(fx.csvDir)));
  ok('wide: external access was disabled', state.applied.includes('SET enable_external_access=false;'));

  // Mosaic opening now must be a no-op, and must not lock the connector out.
  const again = await mosaic.hardenConnection([tmpUserData]);
  ok('wide: Mosaic’s later harden is the same memoised result', again.applied[0] === state.applied[0]);
  const second = await csv.run(ctx({ path: fx.csvDir }), 'SELECT * FROM "sa\'les"');
  ok('wide: the connector still reads after Mosaic hardens', second.ok === true, second.ok ? '' : second.error);

  // And the engine really is locked — this is the control still doing its job.
  let escaped = false;
  try {
    await duck.queryAsync(`SELECT * FROM read_csv_auto('/etc/hosts')`);
    escaped = true;
  } catch {
    /* expected */
  }
  ok('wide: the lock still blocks an unregistered path', escaped === false);
}

// ═════════════════════════════════════════════════════════════════════════════
// Child scenario: the KNOWN LIMITATION, pinned. Folder A then folder B, one
// session. B fails — loudly, with an actionable message, never silently.
// ═════════════════════════════════════════════════════════════════════════════

async function scenarioSecond(): Promise<void> {
  const { a, b } = sharedFolders();
  const csv = connector('csv-folder');

  const first = await csv.run(ctx({ path: a }), 'SELECT * FROM "rows"');
  ok('second: folder A reads', first.ok === true, first.ok ? '' : first.error);
  ok('second: querying A applied the lock', mosaic.hardeningState().ok === true);

  const later = await csv.run(ctx({ path: b }), 'SELECT * FROM "rows"');
  ok('second: folder B, first queried after the lock, FAILS', later.ok === false);
  const msg = later.ok ? '' : later.error;
  ok('second: and it says why, and what to do', /locked to a fixed set of folders/.test(msg) && /[Rr]estart Ordinate/.test(msg), msg.slice(0, 100));

  const registry = JSON.parse(
    fs.readFileSync(path.join(tmpUserData, 'connectors', 'duckdb-dirs.json'), 'utf8')
  ) as string[];
  ok('second: B was recorded anyway, so the next launch covers it',
    registry.includes(b) && registry.includes(a), registry.join(','));
}

// ═════════════════════════════════════════════════════════════════════════════
// Child scenario: the restart the message promises. Same userData, new process.
// ═════════════════════════════════════════════════════════════════════════════

async function scenarioRestart(): Promise<void> {
  const { a, b } = sharedFolders();
  const csv = connector('csv-folder');

  // B first this time — the folder that failed a moment ago in another process.
  const res = await csv.run(ctx({ path: b }), 'SELECT * FROM "rows"');
  ok('restart: folder B now reads, with no code change', res.ok === true, res.ok ? '' : res.error);
  ok('restart: and the value is intact', res.ok && res.rows[0][0] === '007');

  const applied = mosaic.hardeningState().applied[0] || '';
  ok('restart: BOTH folders are inside the lock, from the persisted registry',
    applied.includes(fs.realpathSync(a)) && applied.includes(fs.realpathSync(b)), applied.slice(0, 160));

  const after = await csv.run(ctx({ path: a }), 'SELECT * FROM "rows"');
  ok('restart: folder A still reads too', after.ok === true, after.ok ? '' : after.error);
}

// ═════════════════════════════════════════════════════════════════════════════
// Main suite
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── The export surface, and the two connectors that were dropped ──────────
  const ids = local.CONNECTORS.map((c) => c.id).sort();
  ok('CONNECTORS ships three ids', ids.join(',') === 'csv-folder,duckdb-file,parquet-folder', ids.join(','));
  ok('every connector is read-only', local.CONNECTORS.every((c) => c.readOnly === true));
  ok(
    'every connector is categorised and has a path field',
    local.CONNECTORS.every((c) => c.category === 'Files & local' && c.fields.some((f) => f.key === 'path' && f.required))
  );
  ok('no sqlite connector is exported', !ids.includes('sqlite-file'));
  ok('no motherduck connector is exported', !ids.includes('motherduck'));

  // The reason sqlite was dropped, pinned against the engine rather than against
  // a comment: sqlite_scanner is NOT statically linked, so using it would mean
  // downloading native code at runtime. If a future DuckDB build links it in,
  // this assertion fails and the decision gets revisited on evidence.
  const linked = await duck.queryAsync(
    "SELECT extension_name FROM duckdb_extensions() WHERE install_mode = 'STATICALLY_LINKED' ORDER BY 1"
  );
  const linkedNames = linked.map((r) => String(r.extension_name));
  ok('parquet + json are statically linked (what this family relies on)',
    linkedNames.includes('parquet') && linkedNames.includes('json'), linkedNames.join(','));
  ok('sqlite_scanner is NOT statically linked (why sqlite-file was dropped)',
    !linkedNames.includes('sqlite_scanner'), linkedNames.join(','));
  ok('motherduck is NOT statically linked (one of three reasons it was dropped)',
    !linkedNames.includes('motherduck'));

  // ATTACH pins the format explicitly, which is what stops DuckDB guessing the
  // file type and DOWNLOADING the matching extension.
  const attach = local.attachSql('/tmp/x.duckdb', 'a1');
  ok('attachSql pins TYPE DUCKDB', attach.includes('TYPE DUCKDB'), attach);
  ok('attachSql is READ_ONLY', attach.includes('READ_ONLY'), attach);

  // ── Path escaping ────────────────────────────────────────────────────────
  ok('strLit doubles a single quote', local.strLit("o'brien") === "'o''brien'", local.strLit("o'brien"));
  ok('ident doubles a double quote', local.ident('we"ird') === '"we""ird"', local.ident('we"ird'));

  const fx = await makeFixtures('main');
  const pq = connector('parquet-folder');
  const csv = connector('csv-folder');
  const db = connector('duckdb-file');

  // ── Register all three folders BEFORE the first query ────────────────────
  // Not incidental ordering — it is how this family is meant to be used, and the
  // module header says why: the `allowed_directories` lock lands on the FIRST
  // QUERY and cannot be widened afterwards. `listTables` on a folder is `fs`-only
  // and applies no lock, so it registers a folder without narrowing anything.
  // The `second` child scenario below pins what happens when a folder is NOT
  // registered in time.
  ok('folder listTables applies no lock', mosaic.hardeningState().attempted === false);

  const pqTables = await pq.listTables(ctx({ path: fx.parquetDir }));
  ok('parquet listTables ok', pqTables.ok === true, pqTables.ok ? '' : pqTables.error);
  if (pqTables.ok) {
    const names = pqTables.tables.map((t) => t.name);
    ok('parquet listTables finds the file we wrote', names.join(',') === "sa'les", names.join(','));
    ok('parquet listTables reports no schema (see the CONTRACT NOTE)',
      pqTables.tables.every((t) => t.schema === undefined));
  }
  const pqRec = await pq.listTables(ctx({ path: fx.parquetDir, recursive: true }));
  ok('parquet listTables recurses when asked',
    pqRec.ok === true && pqRec.tables.map((t) => t.name).sort().join(',') === "nested/inner,sa'les",
    pqRec.ok ? pqRec.tables.map((t) => t.name).join(',') : pqRec.error);

  const csvTables = await csv.listTables(ctx({ path: fx.csvDir }));
  ok('csv listTables ok', csvTables.ok === true, csvTables.ok ? '' : csvTables.error);
  ok('csv listTables still applied no lock', mosaic.hardeningState().attempted === false);

  // duckdb-file's listTables DOES need the engine (it ATTACHes), so this is the
  // call that applies the lock — with all three folders already registered.
  const dbTables = await db.listTables(ctx({ path: fx.dbFile }));
  ok('duckdb listTables ok', dbTables.ok === true, dbTables.ok ? '' : dbTables.error);
  if (dbTables.ok) {
    const names = dbTables.tables.map((t) => t.name).sort();
    ok('duckdb listTables returns flat, bindable names',
      names.join(',') === 'reporting.monthly,t', names.join(','));
  }
  ok('the first engine call applied the lock', mosaic.hardeningState().ok === true);

  const pqRows = rowsOf(await pq.run(ctx({ path: fx.parquetDir }), `SELECT * FROM "sa'les"`));
  ok('parquet: a quote in the folder AND file name reads fine', pqRows.rows.length === 5);
  ok('parquet: column names verbatim',
    pqRows.columns.map((c) => c.name).join(',') === 'id,region,amount,big',
    pqRows.columns.map((c) => c.name).join(','));
  ok('parquet: source types verbatim, not Ordinate types',
    pqRows.columns.map((c) => c.type).join(',') === 'VARCHAR,VARCHAR,DOUBLE,BIGINT',
    pqRows.columns.map((c) => c.type).join(','));
  ok("parquet: '007' stays text, it does not become 7", pqRows.rows[0][0] === '007', JSON.stringify(pqRows.rows[0]));
  ok('parquet: empty string stays distinct from NULL',
    pqRows.rows[1][1] === '' && pqRows.rows[2][1] === null, JSON.stringify([pqRows.rows[1][1], pqRows.rows[2][1]]));
  ok('parquet: DOUBLE arrives as a number', pqRows.rows[0][2] === 10.5);
  ok('parquet: BIGINT arrives exact, as a decimal string (no 2^53 rounding)',
    pqRows.rows[0][3] === '9007199254740993', String(pqRows.rows[0][3]));
  ok('parquet: not truncated under the cap', pqRows.truncated === false);

  // ── The row cap ──────────────────────────────────────────────────────────
  const clipped = rowsOf(await pq.run(ctx({ path: fx.parquetDir }, 2), `SELECT * FROM "sa'les"`));
  ok('rowLimit clips to exactly the cap', clipped.rows.length === 2, String(clipped.rows.length));
  ok('rowLimit reports truncated', clipped.truncated === true);
  const exact = rowsOf(await pq.run(ctx({ path: fx.parquetDir }, 5), `SELECT * FROM "sa'les"`));
  ok('a result exactly at the cap is NOT reported truncated',
    exact.rows.length === 5 && exact.truncated === false, `${exact.rows.length}/${exact.truncated}`);

  // ── csv-folder ───────────────────────────────────────────────────────────
  const csvRows = rowsOf(await csv.run(ctx({ path: fx.csvDir }), `SELECT * FROM "sa'les"`));
  ok('csv: reads the file Node wrote', csvRows.rows.length === 3);
  ok("csv: '007' stays text (all_varchar, no sniffed coercion)",
    csvRows.rows[0][0] === '007' && csvRows.rows[1][0] === '042', JSON.stringify(csvRows.rows.map((r) => r[0])));
  ok('csv: every column reports VARCHAR, because CSV has no types',
    csvRows.columns.every((c) => c.type === 'VARCHAR'), csvRows.columns.map((c) => c.type).join(','));
  // DuckDB's CSV reader calls an empty field NULL; Ordinate's own tokenizer calls
  // it ''. Pinned as a KNOWN DIVERGENCE rather than papered over with a sentinel
  // `nullstr` — see the type bullet in the module header.
  ok('csv: an empty field arrives as NULL (DuckDB CSV semantics, documented)',
    csvRows.rows[1][1] === null, JSON.stringify(csvRows.rows[1]));

  // Aggregation over the CTE-bound name works — the prelude is a real relation.
  const agg = rowsOf(await csv.run(ctx({ path: fx.csvDir }), `SELECT count(*) AS n FROM "sa'les"`));
  ok('csv: aggregate over a bound name', agg.rows[0][0] === '3' || agg.rows[0][0] === 3, JSON.stringify(agg.rows[0]));

  // ── duckdb-file ──────────────────────────────────────────────────────────
  const dbRows = rowsOf(await db.run(ctx({ path: fx.dbFile }), 'SELECT * FROM "t"'));
  ok('duckdb: a main-schema table binds by its bare name',
    dbRows.rows.length === 1 && dbRows.rows[0][0] === '007', JSON.stringify(dbRows.rows));
  ok('duckdb: source types verbatim',
    dbRows.columns.map((c) => c.type).join(',') === 'VARCHAR,INTEGER',
    dbRows.columns.map((c) => c.type).join(','));
  const dbRows2 = rowsOf(await db.run(ctx({ path: fx.dbFile }), 'SELECT * FROM "reporting.monthly"'));
  ok('duckdb: a non-main schema binds by its flat name', dbRows2.rows[0][0] === 'jan', JSON.stringify(dbRows2.rows));

  // The attached catalog must leave nothing behind in the shared connection.
  const leftovers = await duck.queryAsync("SELECT database_name FROM duckdb_databases() WHERE database_name LIKE 'ord_src_%'");
  ok('duckdb: every ATTACH was detached', leftovers.length === 0, JSON.stringify(leftovers));

  // ── READ-ONLY, proven against the engine ─────────────────────────────────
  const before = fs.statSync(fx.dbFile);
  const alias = 'ord_test_ro';
  await duck.execAsync(local.attachSql(fx.dbFile, alias));
  let wrote: string | null = null;
  try {
    await duck.execAsync(`INSERT INTO ${local.ident(alias)}.main.t VALUES ('x', 1)`);
    wrote = 'INSERT SUCCEEDED';
  } catch (e) {
    wrote = e instanceof Error ? e.message : String(e);
  }
  ok('ATTACH is read-only: INSERT is refused by the engine',
    /read-only mode/.test(wrote || ''), (wrote || '').slice(0, 110));
  let created: string | null = null;
  try {
    await duck.execAsync(`CREATE TABLE ${local.ident(alias)}.main.zz AS SELECT 1`);
    created = 'CREATE SUCCEEDED';
  } catch (e) {
    created = e instanceof Error ? e.message : String(e);
  }
  ok('ATTACH is read-only: CREATE is refused by the engine',
    /read-only mode/.test(created || ''), (created || '').slice(0, 110));
  await duck.execAsync(`DETACH ${local.ident(alias)}`);
  const after = fs.statSync(fx.dbFile);
  ok('the user’s database file is byte-identical after all of that',
    after.size === before.size && after.mtimeMs === before.mtimeMs);

  // ── Bad input ────────────────────────────────────────────────────────────
  const missing = await pq.run(ctx({ path: path.join(fx.dir, 'nope') }), 'SELECT 1');
  ok('a missing folder is a clean error', missing.ok === false && /Not found/.test(missing.error));
  const relative = await pq.run(ctx({ path: 'data' }), 'SELECT 1');
  ok('a relative path is refused', relative.ok === false && /absolute/.test(relative.error), relative.ok ? '' : relative.error);
  const notDir = await pq.run(ctx({ path: fx.dbFile }), 'SELECT 1');
  ok('a file where a folder is expected is refused', notDir.ok === false && /Not a folder/.test(notDir.error));
  const noSql = await pq.run(ctx({ path: fx.parquetDir }), '   ');
  ok('empty SQL is refused', noSql.ok === false && /No SQL/.test(noSql.error));
  const badSql = await pq.run(ctx({ path: fx.parquetDir }), 'SELECT * FROM "no_such_file"');
  ok('an unknown table is a clean error, not a crash',
    badSql.ok === false && /no_such_file/.test(badSql.error), badSql.ok ? '' : badSql.error.slice(0, 90));
  const emptyDir = path.join(fx.dir, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  const none = await pq.run(ctx({ path: emptyDir }), 'SELECT 1');
  ok('an empty folder says so', none.ok === false && /No \.parquet files/.test(none.error), none.ok ? '' : none.error);

  // ── The timeout bound ────────────────────────────────────────────────────
  // ~1.6 s of real work against a 100 ms budget. The CALLER is released at the
  // budget; the statement itself keeps running in the worker, which the module
  // header says out loud rather than pretending otherwise.
  const t0 = Date.now();
  const slow = await pq.run(
    ctx({ path: fx.parquetDir }, 1000, 100),
    "SELECT count(*) AS c FROM range(60000000) WHERE hash(range::VARCHAR || 'x') % 7 = 0"
  );
  const elapsed = Date.now() - t0;
  ok('timeoutMs releases the caller', slow.ok === false && /timed out after 100ms/.test(slow.error),
    slow.ok ? 'no error' : slow.error);
  ok('timeoutMs releases the caller QUICKLY', elapsed < 1000, elapsed + 'ms');

  // ── The registry ─────────────────────────────────────────────────────────
  const registry = JSON.parse(
    fs.readFileSync(path.join(tmpUserData, 'connectors', 'duckdb-dirs.json'), 'utf8')
  ) as string[];
  ok('every folder used was remembered for the next launch',
    registry.includes(fx.parquetDir) && registry.includes(fx.csvDir) && registry.includes(fx.dir),
    registry.length + ' entries');
  ok('the registry is newest-first', registry[0] === fx.parquetDir || registry[0] === fx.dir, registry[0]);

  // ── The orderings, each in its own process ───────────────────────────────
  // `second` and `restart` share one userData and one fixture root, in that
  // order: the second child is literally the app being relaunched.
  const sharedUd = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-conn-shared-ud-'));
  const sharedFx = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-conn-shared-fx-'));
  const scenarios: { sub: string; env: Record<string, string> }[] = [
    { sub: 'narrow', env: {} },
    { sub: 'wide', env: {} },
    { sub: 'second', env: { ORD_UD: sharedUd, ORD_FX: sharedFx } },
    { sub: 'restart', env: { ORD_UD: sharedUd, ORD_FX: sharedFx } },
  ];
  for (const s of scenarios) {
    const r = cp.spawnSync(process.execPath, [__filename], {
      env: { ...process.env, ORD_SUB: s.sub, ...s.env },
      encoding: 'utf8',
    });
    const out = (r.stdout || '') + (r.stderr || '');
    for (const line of out.split('\n')) {
      if (line.startsWith('ok   ') || line.startsWith('FAIL ')) console.log('     ' + line);
    }
    ok('scenario ' + s.sub + ' passed (child process)', r.status === 0, 'exit=' + r.status);
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────

const sub = process.env.ORD_SUB;
const scenarioByName: Record<string, () => Promise<void>> = {
  narrow: scenarioNarrow,
  wide: scenarioWide,
  second: scenarioSecond,
  restart: scenarioRestart,
};
const run = (sub && scenarioByName[sub]) || main;

run()
  .then(() => {
    duck.shutdown();
    const label = sub ? `test-connectorsLocal[${sub}]` : 'test-connectorsLocal';
    if (failures) {
      console.error(`\n${label}: ${failures} FAILED`);
      process.exitCode = 1;
    } else {
      console.log(`\n${label}: all assertions passed`);
    }
  })
  .catch((err) => {
    console.error('test-connectorsLocal threw:', err);
    duck.shutdown();
    process.exitCode = 1;
  });
