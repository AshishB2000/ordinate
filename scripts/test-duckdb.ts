// Self-check for src/duckdb.ts + src/duckdbWorker.ts — the SYNCHRONOUS DuckDB
// bridge (worker thread + SharedArrayBuffer + Atomics.wait). Exercises the real
// native module: lazy start, sync results, bound parameters, BIGINT precision,
// error + overflow recovery, honesty of isAvailable(), idempotent shutdown.
// No framework — plain asserts, same shape as the sibling test-*.ts scripts.

export {}; // module scope — sibling test scripts share top-level names

const duckdb: typeof import('../src/duckdb') = require('../src/duckdb');
const fsd = require('fs') as typeof import('fs');
const osd = require('os') as typeof import('os');
const pathd = require('path') as typeof import('path');

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

// Assert that `fn` throws a DuckDBError carrying the expected code.
function throwsWith(label: string, code: string, fn: () => unknown): void {
  try {
    fn();
    ok(label + ' (threw)', false);
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    ok(label + ' → ' + code, e.name === 'DuckDBError' && e.code === code);
    if (e.code !== code) console.error('     got: ' + e.name + '/' + e.code + ' — ' + e.message);
  }
}

// ── Lazy start: importing must spawn nothing; the first use starts the worker ─
// Observable proof: point the bridge at a database FILE. DuckDB creates it on
// connect, so the file's existence tracks the worker's existence exactly.
{
  const tmpDb = pathd.join(osd.tmpdir(), 'sc-duckdb-test-' + process.pid + '.duckdb');
  try {
    fsd.rmSync(tmpDb, { force: true });
  } catch {
    /* best effort */
  }
  duckdb.configure({ dbPath: tmpDb });
  ok('lazy: nothing started by import/configure (db file absent)', !fsd.existsSync(tmpDb));

  const t0 = Date.now();
  const up = duckdb.isAvailable();
  const startupMs = Date.now() - t0;
  ok('lazy: isAvailable() starts the worker and reports true', up === true);
  ok('lazy: database file exists once started', fsd.existsSync(tmpDb));
  console.log('     (worker startup: ' + startupMs + ' ms)');

  duckdb.shutdown();
  for (const suffix of ['', '.wal']) {
    try {
      fsd.rmSync(tmpDb + suffix, { force: true });
    } catch {
      /* best effort */
    }
  }
  duckdb.configure({ dbPath: ':memory:' });
}

// ── Synchronous results ──────────────────────────────────────────────────────
{
  // PROOF the call is synchronous: the value is used on the very next line,
  // with no await and no callback.
  const rows = duckdb.query("SELECT 1 AS one, 'hi' AS greeting");
  ok('sync: one row returned', rows.length === 1);
  ok('sync: integer column is a JS number', rows[0].one === 1);
  ok('sync: varchar column is a JS string', rows[0].greeting === 'hi');
  ok('sync: empty result is an empty array', duckdb.query('SELECT 1 WHERE false').length === 0);
  ok('sync: NULL becomes null', duckdb.query('SELECT NULL AS n')[0].n === null);
}

// ── exec + a real aggregate over generated rows ──────────────────────────────
{
  duckdb.exec(
    "CREATE TABLE sales AS SELECT i AS id, ['north','south','east','west'][(i % 4) + 1] AS region, " +
      '(i % 7) * 1.5 AS revenue FROM range(1, 10001) t(i)'
  );
  const count = duckdb.query('SELECT count(*) AS c FROM sales');
  ok('exec: table created with 10000 rows', Number(count[0].c) === 10000);

  const agg = duckdb.query(
    'SELECT region, count(*) AS n, sum(revenue) AS rev FROM sales GROUP BY region ORDER BY region'
  );
  ok('aggregate: four groups', agg.length === 4);
  ok('aggregate: group sizes', agg.every((r) => Number(r.n) === 2500));
  const total = agg.reduce((sum, r) => sum + Number(r.rev), 0);
  // Same arithmetic done in JS: revenue = (i % 7) * 1.5 over i = 1…10000.
  let expected = 0;
  for (let i = 1; i <= 10000; i++) expected += (i % 7) * 1.5;
  ok('aggregate: revenue total matches the same sum computed in JS', Math.abs(total - expected) < 1e-6);
  ok('aggregate: numeric column stays a JS number', typeof agg[0].rev === 'number');
}

// ── Parameters are BOUND, never interpolated ─────────────────────────────────
{
  const injection = "'; DROP TABLE sales; --";
  const r = duckdb.query('SELECT ? AS v', [injection]);
  ok('params: string binds and round-trips verbatim', r[0].v === injection);
  ok('params: injection did not execute (table survives)', Number(duckdb.query('SELECT count(*) AS c FROM sales')[0].c) === 10000);

  const filtered = duckdb.query('SELECT count(*) AS c FROM sales WHERE region = ?', ['north']);
  ok('params: bound value filters correctly', Number(filtered[0].c) === 2500);

  const mixed = duckdb.query('SELECT ? AS a, ? AS b, ? AS c', [42, 'text', null]);
  ok('params: number binds as a number', mixed[0].a === 42);
  ok('params: string binds as a string', mixed[0].b === 'text');
  ok('params: null binds as NULL', mixed[0].c === null);

  // A parameter that is not a scalar is rejected at the boundary rather than
  // being stringified into SQL. Cast: deliberately passing a bad value that the
  // published type forbids, to prove the runtime guard exists for JS callers.
  const badParams = [{ evil: 1 }] as unknown as (string | number | null)[];
  throwsWith('params: non-scalar rejected', 'query', () => duckdb.query('SELECT ? AS v', badParams));
  ok('params: bridge still usable after a rejected parameter', duckdb.query('SELECT 2 AS two')[0].two === 2);
}

// ── BIGINT / HUGEINT precision ───────────────────────────────────────────────
// Decision: 64-bit-and-wider integers come back as decimal STRINGS. Anything
// that routes them through a JS number (the DuckDB CLI's -json, Number(bigint))
// silently rounds past 2^53 — 9007199254740993 becomes …992.
{
  const big = duckdb.query('SELECT 9007199254740993::BIGINT AS big');
  ok('bigint: returned as a string', typeof big[0].big === 'string');
  ok('bigint: 9007199254740993 survives exactly', big[0].big === '9007199254740993');
  // …and the JS-number path really would have lost it (this is the bug avoided).
  ok('bigint: the number path would have rounded it to …992', String(Number('9007199254740993')) === '9007199254740992');

  // SUM(INTEGER) is HUGEINT in DuckDB — the common way a dashboard metric ends
  // up over 2^53 without anyone asking for a big integer.
  duckdb.exec('CREATE TABLE bigs AS SELECT 9007199254740992::BIGINT AS v UNION ALL SELECT 1::BIGINT');
  const summed = duckdb.query('SELECT sum(v) AS s FROM bigs');
  ok('hugeint: SUM past 2^53 survives exactly', summed[0].s === '9007199254740993');

  const huge = duckdb.query('SELECT 170141183460469231731687303715884105727::HUGEINT AS h');
  ok('hugeint: full-width HUGEINT survives', huge[0].h === '170141183460469231731687303715884105727');

  // An explicit cast is the documented escape hatch when arithmetic matters.
  ok('bigint: ::DOUBLE cast opts into a JS number', typeof duckdb.query('SELECT sum(v)::DOUBLE AS s FROM bigs')[0].s === 'number');
}

// ── Value shapes for the other types callers will actually hit ───────────────
{
  const r = duckdb.query(
    "SELECT DATE '2024-01-15' AS d, TIMESTAMP '2024-01-15 10:30:00' AS ts, true AS flag, " +
      '1.25::DECIMAL(10,2) AS dec, 007::INTEGER AS i'
  );
  ok('types: DATE is text', r[0].d === '2024-01-15');
  ok('types: TIMESTAMP is text', r[0].ts === '2024-01-15 10:30:00');
  ok('types: BOOLEAN is "true"/"false"', r[0].flag === 'true');
  ok('types: DECIMAL is a number', r[0].dec === 1.25);
  ok('types: INTEGER is a number', r[0].i === 7);
}

// ── SQL errors are typed, synchronous, and non-fatal ─────────────────────────
{
  throwsWith('error: unknown table', 'query', () => duckdb.query('SELECT * FROM does_not_exist'));
  throwsWith('error: syntax error', 'query', () => duckdb.query('SELECT FROM WHERE'));
  ok('error: bridge still usable afterwards', duckdb.query('SELECT 3 AS three')[0].three === 3);
}

// ── Latency (informational, not an assertion) ────────────────────────────────
{
  const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const time = (fn: () => unknown, n: number): number => {
    for (let i = 0; i < 3; i++) fn();
    const ts: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = process.hrtime.bigint();
      fn();
      ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return median(ts);
  };
  const trivial = time(() => duckdb.query('SELECT 1 AS one'), 50);
  const grouped = time(() => duckdb.query('SELECT region, sum(revenue) AS r FROM sales GROUP BY region'), 25);
  const wide = time(() => duckdb.query('SELECT id, region, revenue FROM sales'), 10);
  console.log(
    '     latency (median): trivial=' + trivial.toFixed(2) + ' ms  10k-row group-by=' + grouped.toFixed(2) +
      ' ms  10k-row full result=' + wide.toFixed(2) + ' ms'
  );
  ok('latency: a trivial query round-trips in under 5 ms', trivial < 5);
}

// ── Buffer overflow degrades cleanly and the bridge survives ─────────────────
{
  duckdb.shutdown();
  duckdb.configure({ dbPath: ':memory:', initialBytes: 4096, maxBytes: 64 * 1024 });
  ok('overflow: small result still fits', duckdb.query('SELECT 1 AS one')[0].one === 1);
  // ~10k rows of text is far past the 64 KiB ceiling.
  throwsWith('overflow: oversized result', 'overflow', () =>
    duckdb.query("SELECT i, repeat('x', 40) AS pad FROM range(10000) t(i)")
  );
  ok('overflow: bridge still usable after an overflow', duckdb.query('SELECT 4 AS four')[0].four === 4);
  ok('overflow: buffer grew for a fitting result, not wedged', duckdb.query('SELECT i FROM range(500) t(i)').length === 500);

  duckdb.shutdown();
  duckdb.configure({ dbPath: ':memory:', initialBytes: 1 << 20, maxBytes: 512 << 20 });
}

// ── isAvailable() is honest about a bridge that cannot start ────────────────
{
  const impossible = pathd.join(osd.tmpdir(), 'sc-duckdb-no-such-dir-' + process.pid, 'nested', 'db.duckdb');
  duckdb.shutdown();
  duckdb.configure({ dbPath: impossible });
  ok('honesty: isAvailable() false when the worker cannot open the database', duckdb.isAvailable() === false);
  ok('honesty: repeated isAvailable() stays false (no retry storm)', duckdb.isAvailable() === false);
  throwsWith('honesty: query throws unavailable, not a crash', 'unavailable', () => duckdb.query('SELECT 1'));
  throwsWith('honesty: exec throws unavailable too', 'unavailable', () => duckdb.exec('SELECT 1'));

  duckdb.shutdown();
  duckdb.configure({ dbPath: ':memory:' });
  ok('honesty: recovers once pointed at a usable database', duckdb.isAvailable() === true);
}

// ── shutdown() is idempotent, and a later call restarts the bridge ───────────
{
  duckdb.shutdown();
  duckdb.shutdown();
  duckdb.shutdown();
  ok('shutdown: idempotent (three calls, no throw)', true);
  ok('shutdown: bridge restarts lazily on the next query', duckdb.query('SELECT 5 AS five')[0].five === 5);
  ok('shutdown: in-memory catalog is fresh after a restart', (() => {
    try {
      duckdb.query('SELECT * FROM sales');
      return false; // table from before the shutdown must be gone
    } catch (err) {
      return (err as { code?: string }).code === 'query';
    }
  })());
  duckdb.shutdown();
  ok('shutdown: still idempotent after a restart', true);
}

if (failures) {
  console.error('\n' + failures + ' duckdb check(s) FAILED');
  process.exit(1);
}
console.log('\nAll duckdb checks passed.');
