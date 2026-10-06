// Self-check for src/duckdb.ts + src/duckdbWorker.ts — the DuckDB bridge, BOTH
// paths. The synchronous one (worker thread + SharedArrayBuffer + Atomics.wait):
// lazy start, sync results, bound parameters, BIGINT precision, error + overflow
// recovery, honesty of isAvailable(), idempotent shutdown. The asynchronous one
// (same worker, same connection, replies over the message channel): parity with
// sync, interleaving of the two in every order, error/timeout/shutdown settling,
// and — the reason it exists — a direct proof that it does not block the event
// loop while the sync path does.
// No framework — plain asserts, same shape as the sibling test-*.ts scripts.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const duckdb: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const fsd = require('fs') as typeof import('fs');
const osd = require('os') as typeof import('os');
const pathd = require('path') as typeof import('path');

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

// ═══ ASYNCHRONOUS PATH ═══════════════════════════════════════════════════════
// Everything above ran at module top level. The async half needs `await`, and
// this file emits CommonJS (no top-level await), so it runs in an IIFE — which
// also guarantees it runs strictly after the sync checks. The final report moves
// inside it for the same reason.

/** Async twin of `throwsWith`: the promise must REJECT with the expected code. */
async function rejectsWith(label: string, code: string, p: Promise<unknown>): Promise<void> {
  try {
    await p;
    ok(label + ' (rejected)', false);
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    ok(label + ' → ' + code, e.name === 'DuckDBError' && e.code === code);
    if (e.code !== code) console.error('     got: ' + e.name + '/' + e.code + ' — ' + e.message);
  }
}

const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
// Heavy enough that a blocking call is unmistakably long. Pure computation, no
// I/O, so it cannot be short-circuited by DuckDB's statistics.
const SLOW_SQL = 'SELECT sum(i * i) AS c FROM range(120000000) t(i)';

void (async () => {
  // ── Cold start: the async path must not block, not even for the handshake ──
  {
    duckdb.shutdown();
    duckdb.configure({ dbPath: ':memory:' });
    let ticks = 0;
    const iv = setInterval(() => ticks++, 1);
    const t0 = nowMs();
    const rows = await duckdb.queryAsync("SELECT 1 AS one, 'hi' AS greeting");
    const startupMs = nowMs() - t0;
    clearInterval(iv);
    ok('async cold start: first call returns rows', rows.length === 1 && rows[0].one === 1 && rows[0].greeting === 'hi');
    ok('async cold start: event loop kept turning through the ~115 ms handshake', ticks > 0);
    console.log('     (async cold start: ' + startupMs.toFixed(0) + ' ms, ' + ticks + ' event-loop ticks during it)');
  }

  // ── Parity: identical SQL must give identical rows on both paths ───────────
  {
    duckdb.exec(
      "CREATE TABLE sales AS SELECT i AS id, ['north','south','east','west'][(i % 4) + 1] AS region, " +
        '(i % 7) * 1.5 AS revenue FROM range(1, 10001) t(i)'
    );
    await duckdb.execAsync('CREATE TABLE from_async AS SELECT 1 AS v');
    ok('parity: execAsync ran the DDL on the same connection sync can see', duckdb.query('SELECT v FROM from_async')[0].v === 1);

    const cases = [
      'SELECT 1 AS one, 2.5 AS half, NULL AS n',
      'SELECT region, count(*) AS n, sum(revenue) AS rev FROM sales GROUP BY region ORDER BY region',
      'SELECT id, region, revenue FROM sales ORDER BY id LIMIT 500',
      'SELECT 1 WHERE false',
      "SELECT DATE '2024-01-15' AS d, TIMESTAMP '2024-01-15 10:30:00' AS ts, true AS flag, 1.25::DECIMAL(10,2) AS dec",
    ];
    let allMatch = true;
    for (const sql of cases) {
      const a = duckdb.query(sql);
      const b = await duckdb.queryAsync(sql);
      // Object.is-deep: '' must never compare equal to null, nor 1 to '1'.
      if (JSON.stringify(a) !== JSON.stringify(b) || a.length !== b.length) {
        allMatch = false;
        console.error('     mismatch for: ' + sql);
      }
    }
    ok('parity: async rows are byte-identical to sync rows for 5 shapes', allMatch);
    ok('parity: async empty result is an empty array', (await duckdb.queryAsync('SELECT 1 WHERE false')).length === 0);
    ok('parity: async NULL becomes null', (await duckdb.queryAsync('SELECT NULL AS n'))[0].n === null);
  }

  // ── Parameters are BOUND on the async path too ─────────────────────────────
  {
    const injection = "'; DROP TABLE sales; --";
    const r = await duckdb.queryAsync('SELECT ? AS v', [injection]);
    ok('async params: string binds and round-trips verbatim', r[0].v === injection);
    ok(
      'async params: injection did not execute (table survives)',
      Number(duckdb.query('SELECT count(*) AS c FROM sales')[0].c) === 10000
    );
    const filtered = await duckdb.queryAsync('SELECT count(*) AS c FROM sales WHERE region = ?', ['north']);
    ok('async params: bound value filters correctly', Number(filtered[0].c) === 2500);

    const mixed = await duckdb.queryAsync('SELECT ? AS a, ? AS b, ? AS c', [42, 'text', null]);
    ok('async params: number, string and null all bind', mixed[0].a === 42 && mixed[0].b === 'text' && mixed[0].c === null);

    const badParams = [{ evil: 1 }] as unknown as (string | number | null)[];
    await rejectsWith('async params: non-scalar rejected', 'query', duckdb.queryAsync('SELECT ? AS v', badParams));
    ok('async params: bridge still usable after a rejected parameter', (await duckdb.queryAsync('SELECT 2 AS two'))[0].two === 2);
    await rejectsWith('async: empty sql rejected', 'query', duckdb.queryAsync(''));
  }

  // ── BIGINT precision survives the message channel exactly as it does the SAB ─
  {
    const big = await duckdb.queryAsync('SELECT 9007199254740993::BIGINT AS big');
    ok('async bigint: returned as a string', typeof big[0].big === 'string');
    ok('async bigint: 9007199254740993 survives exactly', big[0].big === '9007199254740993');
    const huge = await duckdb.queryAsync('SELECT 170141183460469231731687303715884105727::HUGEINT AS h');
    ok('async hugeint: full-width HUGEINT survives', huge[0].h === '170141183460469231731687303715884105727');
    const summed = await duckdb.queryAsync('SELECT sum(v)::HUGEINT AS s FROM (SELECT 9007199254740992::BIGINT AS v UNION ALL SELECT 1::BIGINT)');
    ok('async hugeint: SUM past 2^53 survives exactly', summed[0].s === '9007199254740993');
    ok(
      'async bigint: identical to the sync path for the same value',
      duckdb.query('SELECT 9007199254740993::BIGINT AS big')[0].big === big[0].big
    );
  }

  // ── The BOM limitation is a property of the binding, not of the transport ──
  // Pinned on BOTH paths so the header's claim stays true (see src/duckdb.ts).
  {
    const sqlBom = "SELECT chr(65279) || 'x' AS v";
    const syncBom = duckdb.query(sqlBom)[0].v;
    const asyncBom = (await duckdb.queryAsync(sqlBom))[0].v;
    ok('bom: sync still loses a leading U+FEFF (unchanged)', syncBom === 'x');
    ok('bom: async loses it identically — the strip is below the transport', asyncBom === 'x');
    const mid = "SELECT 'a' || chr(65279) || 'b' AS v";
    ok('bom: a non-leading U+FEFF survives on both paths', duckdb.query(mid)[0].v === (await duckdb.queryAsync(mid))[0].v);
  }

  // ── INTERLEAVING ──────────────────────────────────────────────────────────
  // The scenario the design has to survive: an async call is in flight, the main
  // thread then parks in Atomics.wait for a sync call, and the worker's async
  // reply cannot be delivered until that park ends. Both orders, plus a sync
  // call issued from inside an async continuation.
  {
    // (1) async-then-sync. Two async calls are issued FIRST (the slow one first,
    // so the sync call genuinely has to wait behind ~200 ms of async work), then
    // a sync call parks the thread.
    const log: string[] = [];
    const t0 = nowMs();
    const a1 = duckdb.queryAsync(SLOW_SQL).then((r) => log.push('async1=' + r[0].c));
    const a2 = duckdb.queryAsync('SELECT 7 AS s').then((r) => log.push('async2=' + r[0].s));
    const syncRows = duckdb.query('SELECT 9 AS n');
    const syncAt = nowMs() - t0;
    log.push('sync=' + syncRows[0].n);
    await Promise.all([a1, a2]);
    ok('interleave: sync call issued behind async work still returns its own rows', syncRows[0].n === 9);
    ok('interleave: the sync call waited for the queued async work (FIFO, no jumping)', syncAt > 20);
    ok('interleave: both async replies were delivered after the block ended', log.length === 3);
    // sum(i²) for i in 0…119,999,999 — computed here in BigInt so the buffered
    // reply is checked against an independent exact value, not just "non-empty".
    const n = 119999999n;
    const expectedSquares = ((n * (n + 1n) * (2n * n + 1n)) / 6n).toString();
    ok('interleave: the buffered slow reply is exact, not truncated', log.includes('async1=' + expectedSquares));
    ok('interleave: the small async call queued behind the slow one still resolved', log.includes('async2=7'));
    console.log('     (interleave: sync returned at ' + syncAt.toFixed(0) + ' ms, having waited behind the async queue)');

    // (2) sync-then-async, same tick. A single-threaded main cannot issue an
    // async call WHILE parked, so this is the only meaning the order can have.
    const s1 = duckdb.query('SELECT 11 AS n')[0].n;
    const p = duckdb.queryAsync('SELECT 12 AS n');
    const s2 = duckdb.query('SELECT 13 AS n')[0].n;
    const a3 = (await p)[0].n;
    ok('interleave: sync → async → sync in one tick, all three correct', s1 === 11 && a3 === 12 && s2 === 13);

    // (3) several async in flight across a sync call, repeated, with the sync
    // call sandwiched in the middle of the batch.
    const mid: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) mid.push(duckdb.queryAsync('SELECT ? AS i', [i]));
    const midSync = duckdb.query('SELECT 99 AS n')[0].n;
    for (let i = 4; i < 8; i++) mid.push(duckdb.queryAsync('SELECT ? AS i', [i]));
    const midRows = (await Promise.all(mid)) as { i: number }[][];
    ok('interleave: 8 async calls straddling a sync call all resolve correctly', midRows.every((r, i) => r[0].i === i));
    ok('interleave: the straddled sync call is unaffected', midSync === 99);

    // (4) a sync call issued from INSIDE an async continuation, while siblings
    // are still in flight. This is the shape a real UI hits: a resolved query
    // handler that reaches for a synchronous helper.
    const order: string[] = [];
    const batch: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) batch.push(duckdb.queryAsync('SELECT ? AS i', [i]).then((r) => order.push('a' + r[0].i)));
    let nested = 0;
    await batch[0].then(() => {
      nested = Number(duckdb.query('SELECT 42 AS v')[0].v);
    });
    await Promise.all(batch);
    ok('interleave: a sync call inside an async continuation works', nested === 42);
    ok('interleave: the siblings still in flight all resolved afterwards', order.length === 5);
    ok('interleave: async results are delivered in issue order', order.join(',') === 'a0,a1,a2,a3,a4');

    // (5) many concurrent async calls: FIFO order, right value on every one.
    const N = 40;
    const seen: number[] = [];
    const conc = Array.from({ length: N }, (_, i) =>
      duckdb.queryAsync('SELECT ? AS i, ? AS tag', [i, 'row-' + i]).then((r) => {
        seen.push(Number(r[0].i));
        return r[0].tag;
      })
    );
    const tags = await Promise.all(conc);
    ok('concurrency: ' + N + ' async calls resolve in issue order', seen.join(',') === Array.from({ length: N }, (_, i) => i).join(','));
    ok('concurrency: every call got its OWN result, none crossed', tags.every((t, i) => t === 'row-' + i));
  }

  // ── EVENT-LOOP PROOF — the entire point of the async path ──────────────────
  // A timer is scheduled, then a slow query runs. On the sync path the timer
  // CANNOT fire until the call returns; on the async path it must fire *during*.
  {
    // Sync: nothing may run while Atomics.wait holds the thread.
    let syncTicks = 0;
    let syncFiredAt = -1;
    let syncImmediate = false;
    const t0 = nowMs();
    const iv = setInterval(() => syncTicks++, 1);
    const to = setTimeout(() => {
      syncFiredAt = nowMs() - t0;
    }, 2);
    setImmediate(() => {
      syncImmediate = true;
    });
    duckdb.query(SLOW_SQL);
    const syncMs = nowMs() - t0;
    const ticksDuringSync = syncTicks; // read before any await can let them run
    const firedDuringSync = syncFiredAt;
    const immediateDuringSync = syncImmediate;
    clearInterval(iv);
    clearTimeout(to);

    // Async: the loop must keep turning for the whole call.
    let asyncTicks = 0;
    let asyncFiredAt = -1;
    const t1 = nowMs();
    const iv2 = setInterval(() => asyncTicks++, 1);
    setTimeout(() => {
      asyncFiredAt = nowMs() - t1;
    }, 2);
    await duckdb.queryAsync(SLOW_SQL);
    const asyncMs = nowMs() - t1;
    clearInterval(iv2);

    ok('event loop: the probe query is slow enough for the test to mean anything', syncMs > 20 && asyncMs > 20);
    ok('event loop: a 2 ms timer did NOT fire during the ' + syncMs.toFixed(0) + ' ms SYNC call', firedDuringSync < 0);
    ok('event loop: setImmediate did NOT fire during the SYNC call', immediateDuringSync === false);
    ok('event loop: no interval tick at all during the SYNC call', ticksDuringSync === 0);
    ok('event loop: the 2 ms timer DID fire during the ' + asyncMs.toFixed(0) + ' ms ASYNC call', asyncFiredAt >= 0 && asyncFiredAt < asyncMs);
    ok('event loop: it fired near the START of the async call, not at the end', asyncFiredAt < asyncMs / 2);
    ok('event loop: the loop kept ticking throughout the async call', asyncTicks > 5);
    console.log(
      '     (event loop — sync: ' + syncMs.toFixed(0) + ' ms call, ' + ticksDuringSync + ' ticks, timer never fired' +
        '  |  async: ' + asyncMs.toFixed(0) + ' ms call, ' + asyncTicks + ' ticks, timer fired at ' + asyncFiredAt.toFixed(1) + ' ms)'
    );
  }

  // ── Latency, both paths (informational + one floor assertion) ──────────────
  {
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const timeSync = (fn: () => unknown, n: number): number => {
      for (let i = 0; i < 3; i++) fn();
      const ts: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = nowMs();
        fn();
        ts.push(nowMs() - t);
      }
      return median(ts);
    };
    const timeAsync = async (fn: () => Promise<unknown>, n: number): Promise<number> => {
      for (let i = 0; i < 3; i++) await fn();
      const ts: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = nowMs();
        await fn();
        ts.push(nowMs() - t);
      }
      return median(ts);
    };
    const GROUPED = 'SELECT region, sum(revenue) AS r FROM sales GROUP BY region';
    const WIDE = 'SELECT id, region, revenue FROM sales';
    const st = timeSync(() => duckdb.query('SELECT 1 AS one'), 50);
    const at = await timeAsync(() => duckdb.queryAsync('SELECT 1 AS one'), 50);
    const sg = timeSync(() => duckdb.query(GROUPED), 25);
    const ag = await timeAsync(() => duckdb.queryAsync(GROUPED), 25);
    const sw = timeSync(() => duckdb.query(WIDE), 10);
    const aw = await timeAsync(() => duckdb.queryAsync(WIDE), 10);
    console.log(
      '     latency (median, sync → async):' +
        '  trivial ' + st.toFixed(2) + ' → ' + at.toFixed(2) + ' ms' +
        '  |  10k group-by ' + sg.toFixed(2) + ' → ' + ag.toFixed(2) + ' ms' +
        '  |  10k full result ' + sw.toFixed(2) + ' → ' + aw.toFixed(2) + ' ms'
    );
    console.log(
      '     worker-side of the last call: sync ' + (duckdb.lastCallMicros() / 1000).toFixed(2) +
        ' ms, async ' + (duckdb.lastAsyncCallMicros() / 1000).toFixed(2) + ' ms (rest is transport + loop turn)'
    );
    ok('latency: a trivial async round-trip is under 10 ms', at < 10);
    ok('latency: async is within 5 ms of sync for a trivial query', Math.abs(at - st) < 5);
  }

  // ── Async errors carry the same typed codes, and never wedge the bridge ────
  {
    await rejectsWith('async error: unknown table', 'query', duckdb.queryAsync('SELECT * FROM does_not_exist'));
    await rejectsWith('async error: syntax error', 'query', duckdb.queryAsync('SELECT FROM WHERE'));
    await rejectsWith('async error: execAsync failure', 'query', duckdb.execAsync('CREATE TABLE bad AS SELECT * FROM nope'));
    ok('async error: bridge still usable afterwards', (await duckdb.queryAsync('SELECT 3 AS three'))[0].three === 3);
    ok('async error: the SYNC path is unaffected by an async failure', duckdb.query('SELECT 4 AS four')[0].four === 4);

    // A failing async call in the middle of a healthy batch must not take the
    // others down with it.
    const batch = [
      duckdb.queryAsync('SELECT 1 AS v'),
      duckdb.queryAsync('SELECT * FROM still_does_not_exist'),
      duckdb.queryAsync('SELECT 3 AS v'),
    ];
    const settled = await Promise.allSettled(batch);
    ok(
      'async error: one rejection in a batch leaves its siblings fulfilled',
      settled[0].status === 'fulfilled' && settled[1].status === 'rejected' && settled[2].status === 'fulfilled'
    );
  }

  // ── Async overflow uses the same ceiling and the same code as sync ─────────
  {
    duckdb.shutdown();
    duckdb.configure({ dbPath: ':memory:', initialBytes: 4096, maxBytes: 64 * 1024 });
    ok('async overflow: small result still fits', (await duckdb.queryAsync('SELECT 1 AS one'))[0].one === 1);
    await rejectsWith(
      'async overflow: oversized result',
      'overflow',
      duckdb.queryAsync("SELECT i, repeat('x', 40) AS pad FROM range(10000) t(i)")
    );
    ok('async overflow: bridge still usable afterwards', (await duckdb.queryAsync('SELECT 4 AS four'))[0].four === 4);
    ok('async overflow: the sync path still enforces the same ceiling', (() => {
      try {
        duckdb.query("SELECT i, repeat('x', 40) AS pad FROM range(10000) t(i)");
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'overflow';
      }
    })());
    duckdb.shutdown();
    duckdb.configure({ dbPath: ':memory:', initialBytes: 1 << 20, maxBytes: 512 << 20 });
  }

  // ── A bridge that cannot start rejects async calls, it does not hang them ──
  {
    const impossible = pathd.join(osd.tmpdir(), 'sc-duckdb-no-such-dir-async-' + process.pid, 'nested', 'db.duckdb');
    duckdb.shutdown();
    duckdb.configure({ dbPath: impossible });
    await rejectsWith('async honesty: queryAsync rejects when the worker cannot start', 'unavailable', duckdb.queryAsync('SELECT 1'));
    await rejectsWith('async honesty: execAsync too', 'unavailable', duckdb.execAsync('SELECT 1'));
    ok('async honesty: isAvailable() agrees the bridge is down', duckdb.isAvailable() === false);
    duckdb.shutdown();
    duckdb.configure({ dbPath: ':memory:' });
    ok('async honesty: recovers once pointed at a usable database', (await duckdb.queryAsync('SELECT 5 AS five'))[0].five === 5);
  }

  // ── shutdown() SETTLES in-flight async calls instead of abandoning them ────
  // A promise that can never settle is a leak the caller cannot see or recover
  // from, so this is the requirement, not a nicety.
  {
    const pending = [
      duckdb.queryAsync(SLOW_SQL),
      duckdb.queryAsync('SELECT 1 AS v'),
      duckdb.execAsync('CREATE TABLE never_created AS SELECT 1'),
    ];
    const tShut = nowMs();
    duckdb.shutdown(); // mid-flight, deliberately
    const shutMs = nowMs() - tShut;
    // A busy shutdown asks the worker to exit rather than terminating it (which
    // aborts the process — see closeWorker in src/duckdb.ts). Asking must not
    // mean waiting: shutdown() stays synchronous and instant.
    ok('shutdown: stays instant even with a ~200 ms query in flight', shutMs < 20);
    const settled = await Promise.allSettled(pending);
    ok('shutdown: every in-flight async call settled (none left pending)', settled.length === 3);
    ok('shutdown: all of them rejected', settled.every((s) => s.status === 'rejected'));
    ok(
      'shutdown: with the unavailable code',
      settled.every((s) => s.status === 'rejected' && (s.reason as { code?: string }).code === 'unavailable')
    );
    ok('shutdown: async restarts the bridge lazily on the next call', (await duckdb.queryAsync('SELECT 6 AS six'))[0].six === 6);
    ok('shutdown: the restarted in-memory catalog is fresh', await (async () => {
      try {
        await duckdb.queryAsync('SELECT * FROM sales');
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'query';
      }
    })());
    duckdb.shutdown();
    ok('shutdown: still idempotent with nothing in flight', true);
  }

  if (failureCount()) {
    console.error('\n' + failureCount() + ' duckdb check(s) FAILED');
    process.exit(1);
  }
  console.log('\nAll duckdb checks passed.');
})();
