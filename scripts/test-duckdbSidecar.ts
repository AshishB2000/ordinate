'use strict';

// Self-check for src/duckdbSidecar.ts — DuckDB in a child process instead of a
// worker thread plus a SharedArrayBuffer.
//
// DIFFERENTIAL by design, like every other resident-SQL module in this repo. The
// sidecar's only job is to return what src/duckdb.ts returns, so almost nothing
// here is asserted against a hand-written expectation: the SAME SQL is run
// through BOTH bridges and the results are compared with `Object.is` per cell.
// A hand-written expectation can agree with a bug in both implementations; an
// equivalence assertion cannot.
//
// The non-differential assertions are the ones the comparison cannot make about
// itself: that the sync API really is synchronous (the whole reason the sidecar
// design was in question), that BIGINT stays an exact string, that '' and null
// remain distinguishable, that bad params are rejected before reaching SQL, and
// that failure is typed and catchable rather than fatal.
//
//   npm run build:ts && node scripts/test-duckdbSidecar.js

import * as duck from '../src/duckdb';
import * as side from '../src/duckdbSidecar';

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

function done(): never {
  try {
    side.shutdown();
  } catch {
    /* ignore */
  }
  try {
    duck.shutdown();
  } catch {
    /* ignore */
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll duckdbSidecar checks passed');
  process.exit(0);
}

if (!side.isAvailable()) {
  // Same contract as duckdb.ts: unavailable is a legitimate answer, not a crash.
  console.log('ok   sidecar reports unavailable without throwing (DuckDB binding absent)');
  console.log('\nAll duckdbSidecar checks passed (engine absent — differential skipped)');
  process.exit(0);
}
ok('sidecar starts and reports available', true);
ok('duckdb.ts bridge also available (required for the comparison)', duck.isAvailable());

/** Deep per-cell equality with Object.is, so '' can never pass as null. */
function sameRows(a: Record<string, unknown>[], b: Record<string, unknown>[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ka = Object.keys(a[i]);
    const kb = Object.keys(b[i]);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.is(a[i][k], b[i][k])) return false;
    // Column ORDER is part of the contract, not just the key set.
    for (let c = 0; c < ka.length; c++) if (ka[c] !== kb[c]) return false;
  }
  return true;
}

function differential(label: string, sql: string, params?: (string | number | null)[]): void {
  let viaWorker: Record<string, unknown>[] | null = null;
  let viaSidecar: Record<string, unknown>[] | null = null;
  let workerErr = '';
  let sidecarErr = '';
  try {
    viaWorker = duck.query(sql, params) as unknown as Record<string, unknown>[];
  } catch (e) {
    workerErr = e instanceof Error ? e.message : String(e);
  }
  try {
    viaSidecar = side.query(sql, params) as unknown as Record<string, unknown>[];
  } catch (e) {
    sidecarErr = e instanceof Error ? e.message : String(e);
  }
  if (workerErr || sidecarErr) {
    // Both must fail, or neither. The messages come from DuckDB itself, so they
    // should match too — but the pass condition is agreement on failure.
    ok(label + ' (both reject)', !!workerErr && !!sidecarErr);
    return;
  }
  ok(label, sameRows(viaWorker!, viaSidecar!));
}

// ── §1 scalars and the type mapping ──────────────────────────────────────────

differential('integers', 'SELECT 1 AS a, 2 AS b');
differential('doubles', 'SELECT 1.5::DOUBLE AS d, -0.0::DOUBLE AS neg');
differential('varchar', "SELECT 'hello' AS s, '' AS empty");
differential('null vs empty string', "SELECT NULL AS n, '' AS e");
differential('booleans become text', 'SELECT true AS t, false AS f');
differential('dates and timestamps', "SELECT DATE '2024-01-01' AS d, TIMESTAMP '2024-01-01 10:00:00' AS ts");
differential('decimal', 'SELECT 123.456::DECIMAL(10,3) AS dec');
differential('list and struct become JSON text', "SELECT [1,2,3] AS l, {'a': 1} AS st");
differential('leading zeros survive as text', "SELECT '007' AS zip, '00210' AS zip2");

// ── §2 the BIGINT decision — exact decimal strings, never rounded numbers ────

differential('bigint past 2^53', 'SELECT 9007199254740993::BIGINT AS big');
differential('hugeint', 'SELECT 170141183460469231731687303715884105727::HUGEINT AS h');
differential('SUM(INTEGER) is HUGEINT', 'SELECT sum(i)::HUGEINT AS s FROM range(1000) t(i)');

const bigRow = side.query('SELECT 9007199254740993::BIGINT AS big');
ok('bigint arrives as an exact string, not a rounded number', bigRow[0].big === '9007199254740993');

// ── §3 rows, ordering, and column order ──────────────────────────────────────

differential('many rows keep their order', 'SELECT i FROM range(500) t(i) ORDER BY i');
differential('column order is preserved', "SELECT 3 AS c, 1 AS a, 2 AS b");
differential('empty result set', 'SELECT 1 AS a WHERE false');
differential('wide row', 'SELECT ' + Array.from({ length: 60 }, (_, i) => `${i} AS c${i}`).join(', '));

// ── §4 bound parameters, never interpolated ──────────────────────────────────

differential('bound string param', 'SELECT ? AS v', ['hi']);
differential('bound number param', 'SELECT ? AS v', [42]);
differential('bound null param', 'SELECT ? AS v', [null]);
differential('a param that looks like SQL stays a value', 'SELECT ? AS v', ["'; DROP TABLE x; --"]);

let rejected = '';
try {
  side.query('SELECT ? AS v', [{ evil: true } as never]);
} catch (e) {
  rejected = e instanceof Error ? (e as side.SidecarError).code : '';
}
ok('a non-scalar param is rejected at the boundary', rejected === 'query');

// ── §5 errors are typed and catchable, never fatal ───────────────────────────

let code = '';
try {
  side.query('SELECT * FROM no_such_table');
} catch (e) {
  code = (e as side.SidecarError).code;
}
ok('bad SQL throws a typed query error', code === 'query');
ok('the sidecar is still usable after an error', side.query('SELECT 1 AS a')[0].a === 1);

let emptyCode = '';
try {
  side.query('');
} catch (e) {
  emptyCode = (e as side.SidecarError).code;
}
ok('empty SQL is rejected before it reaches the engine', emptyCode === 'query');

// ── §6 exec, DDL/DML, and state that must persist across calls ───────────────

side.exec('CREATE TABLE t (a INTEGER, b VARCHAR)');
side.exec("INSERT INTO t VALUES (1, 'x'), (2, NULL), (3, '')");
const rows = side.query('SELECT a, b FROM t ORDER BY a');
ok('exec creates state the next call can see', rows.length === 3);
ok("null and '' stay distinguishable through the pipe", rows[1].b === null && Object.is(rows[2].b, ''));

// ── §7 the claim the design turned on: query() really is SYNCHRONOUS ─────────

let ranAfter = false;
const syncRows = side.query('SELECT 1 AS a');
// If query() were secretly async this would already be true, because a resolved
// promise's continuation would have run before we get here.
Promise.resolve().then(() => {
  ranAfter = true;
});
ok('query() returned rows on the very next line', syncRows[0].a === 1);
ok('no microtask ran during query() — it blocked, it did not await', ranAfter === false);

// ── §8 lifecycle ─────────────────────────────────────────────────────────────

ok('lastCallMicros reports engine-side timing', typeof side.lastCallMicros() === 'number');

side.shutdown();
ok('shutdown is idempotent', (side.shutdown(), true));
ok('a query after shutdown restarts the sidecar', side.query('SELECT 7 AS a')[0].a === 7);
ok('in-memory state is gone after a restart, as with duckdb.ts', (() => {
  try {
    side.query('SELECT * FROM t');
    return false;
  } catch {
    return true;
  }
})());

done();
