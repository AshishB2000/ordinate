'use strict';

// Differential: transforms.applyPipeline (the reference) vs
// pipelineDuck.runResidentPipeline (the SQL path reading Parquet in place).
//
// House style — assert the two AGREE with Object.is rather than against
// hand-written expectations, so neither can drift alone. Object.is and not ===
// because it separates 0 from -0 and makes NaN comparable, both of which a
// numeric path can produce.
//
// A null from the resident path is NOT a failure: an unexpressible pipeline is
// the designed exit. But a suite where everything returns null passes green and
// inert, so every case asserts which way it went.

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const transforms = require('../src/data/transforms');
const { runResidentPipeline } = require('../src/engine/pipelineDuck');
const parquetStore = require('../src/engine/parquetStore');
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const trace = require('../src/engine/residentTrace');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-resident-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

let n = 0;
function stage(columns: any[], rows: any[][]): string {
  const file = path.join(tmp, `t${n++}.source.parquet`);
  pqSync.writeTable(file, columns, rows);
  return file;
}

// Compare cell by cell so a mismatch names its own coordinates.
function assertSame(label: string, a: any, b: any): void {
  assert.ok(b !== null, `${label}: resident returned null — the fast path is inert here`);
  assert.deepStrictEqual(b.columns, a.columns, `${label}: columns`);
  assert.strictEqual(b.rowCount, a.rowCount, `${label}: rowCount`);
  assert.strictEqual(b.rows.length, a.rows.length, `${label}: row count`);
  for (let r = 0; r < a.rows.length; r++) {
    for (let c = 0; c < a.rows[r].length; c++) {
      assert.ok(
        Object.is(a.rows[r][c], b.rows[r][c]),
        `${label}: row ${r} col ${c} — fold ${JSON.stringify(a.rows[r][c])} ` +
          `vs resident ${JSON.stringify(b.rows[r][c])}`,
      );
    }
  }
}

async function differential(label: string, columns: any[], rows: any[][], steps: any[]): Promise<any> {
  const fold = transforms.applyPipeline({ columns, rows }, steps);
  const resident = await runResidentPipeline(stage(columns, rows), columns, steps);
  assertSame(label, fold, resident);
  return { fold, resident };
}

// ── the value classes that break naive casting ──────────────────────────────

test("leading-zero text survives: '007' is not 7", async () => {
  const columns = [{ name: 'sku', type: 'text' }, { name: 'qty', type: 'number' }];
  const rows = [['007', 1], ['0420', 2], ['00', 3], ['0', 4], ['007', 5]];
  const { resident } = await differential('leading zeros', columns, rows,
    [{ type: 'filter', column: 'qty', op: '>', value: 1 }]);
  // Pin the actual hazard, not just agreement: TRY_CAST('007' AS DOUBLE) is 7,
  // so a text column reaching a cast would show up here as a number.
  for (const row of resident.rows) assert.strictEqual(typeof row[0], 'string');
  assert.ok(resident.rows.some((r: any[]) => r[0] === '0420'));
});

test('ids beyond 15 digits keep every digit', async () => {
  const columns = [{ name: 'id', type: 'text' }, { name: 'n', type: 'number' }];
  const big = '9007199254740993';            // 2^53 + 1 — unrepresentable as a double
  const rows = [[big, 1], ['12345678901234567890', 2], ['0000000000000001', 3]];
  const { resident } = await differential('big ids', columns, rows, [{ type: 'trim' }]);
  assert.ok(resident.rows.some((r: any[]) => r[0] === big), 'the 2^53+1 id came back changed');
});

test("empty is null OR '' OR whitespace — and they stay distinct", async () => {
  const columns = [{ name: 'a', type: 'text' }, { name: 'n', type: 'number' }];
  //                     NBSP        tab      plain space   real null   empty
  const rows = [[' ', 1], ['\t', 2], ['   ', 3], [null, 4], ['', 5], ['x', 6]];
  await differential('empty class', columns, rows,
    [{ type: 'fill_empty', column: 'a', value: 'FILLED' }]);
});

test('a mixed-type column is folded and read back identically', async () => {
  // Declared number, but one non-numeric cell — the data-dependent retype pass
  // demotes the whole column to text. That pass is NOT expressible in SQL and
  // runs in TS over the returned rows; this proves both paths land in the same
  // place.
  const columns = [{ name: 'v', type: 'number' }, { name: 'k', type: 'text' }];
  const rows = [[1, 'a'], [2, 'b'], ['oops', 'c'], [4, 'd']];
  await differential('mixed types', columns, rows, [{ type: 'trim', column: 'k' }]);
});

test('a filter that removes every row', async () => {
  const columns = [{ name: 'n', type: 'number' }, { name: 's', type: 'text' }];
  const rows = [[1, 'a'], [2, 'b'], [3, 'c']];
  const { fold } = await differential('empty result', columns, rows,
    [{ type: 'filter', column: 'n', op: '>', value: 999 }]);
  assert.strictEqual(fold.rowCount, 0);
});

// ── order, which a bare GROUP BY does not preserve ──────────────────────────

test('first-seen group order is preserved, not the engine default', async () => {
  const columns = [{ name: 'g', type: 'text' }, { name: 'v', type: 'number' }];
  // Deliberately NOT alphabetical: 'zeta' is seen first. Without the carried
  // file_row_number ordinal the engine is free to return these sorted, and
  // whether it does is machine-dependent — the failure mode this pins.
  const rows: any[][] = [];
  for (let i = 0; i < 300; i++) rows.push([['zeta', 'alpha', 'mid'][i % 3], i]);
  const { resident } = await differential('group order', columns, rows,
    [{ type: 'group_aggregate', groupBy: ['g'],
       aggregations: [{ column: 'v', fn: 'sum', as: 'total' }] }]);
  assert.deepStrictEqual(resident.rows.map((r: any[]) => r[0]), ['zeta', 'alpha', 'mid']);
});

test('aggregates come back as JS numbers, never BigInt', async () => {
  // SUM(INTEGER) is HUGEINT in DuckDB and reaches JS as a BigInt, which would
  // survive JSON.stringify as a throw rather than a wrong number.
  const columns = [{ name: 'g', type: 'text' }, { name: 'v', type: 'number' }];
  const rows: any[][] = [];
  for (let i = 0; i < 500; i++) rows.push(['g', 1000000] as any[]);
  const { resident } = await differential('bigint', columns, rows,
    [{ type: 'group_aggregate', groupBy: ['g'],
       aggregations: [{ column: 'v', fn: 'sum', as: 't' }, { column: 'v', fn: 'count', as: 'c' }] }]);
  for (const cell of resident.rows[0]) assert.notStrictEqual(typeof cell, 'bigint');
  assert.strictEqual(typeof resident.rows[0][1], 'number');
});

test('a wide table stays correct (per-column FILTER was a 57s regression)', async () => {
  const W = 200;
  const columns: any[] = [{ name: 'g', type: 'text' }];
  for (let c = 0; c < W; c++) columns.push({ name: 'n' + c, type: 'number' });
  const rows: any[][] = [];
  for (let r = 0; r < 200; r++) {
    const row: any[] = ['g' + (r % 4)];
    for (let c = 0; c < W; c++) row.push(r * c);
    rows.push(row);
  }
  const aggregations: any[] = [];
  for (let c = 0; c < 25; c++) aggregations.push({ column: 'n' + c, fn: 'sum', as: 's' + c });
  await differential('wide', columns, rows, [{ type: 'group_aggregate', groupBy: ['g'], aggregations }]);
});

// ── the designed exits ──────────────────────────────────────────────────────

test('a formula.ts expression falls back, and both paths still agree', async () => {
  // sqlGen has no formula→SQL translation, so EVERY calculated_field bails.
  // The fold must still be correct, and the resident path must decline rather
  // than guess — this is the ceiling on the whole optimisation.
  const columns = [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }];
  const rows = [[2, 3], [4, 5], [6, 7]];
  const steps = [{ type: 'calculated_field', name: 'p', expression: 'a * b + 1' }];
  const fold = transforms.applyPipeline({ columns, rows }, steps);
  const resident = await runResidentPipeline(stage(columns, rows), columns, steps);
  assert.strictEqual(resident, null, 'a calculated field must decline, not guess');
  assert.deepStrictEqual(fold.rows.map((r: any[]) => r[2]), [7, 21, 43]);
});

test('a missing Parquet returns null and records a trace, never throws', async () => {
  trace.reset();
  const columns = [{ name: 'a', type: 'number' }];
  const out = await runResidentPipeline(path.join(tmp, 'does-not-exist.parquet'), columns,
    [{ type: 'filter', column: 'a', op: '>', value: 0 }]);
  assert.strictEqual(out, null);
  const snap = trace.snapshot()['preparePipeline'];
  assert.ok(snap && snap.failed >= 1, 'a broken read must be recorded as failed, not skipped');
});

test('the fast path is recorded as resident — proof it is still firing', async () => {
  // A suite that silently stopped exercising the SQL path would pass green and
  // inert. This asserts the trace, so "it stopped firing" fails loudly.
  trace.reset();
  const columns = [{ name: 'g', type: 'text' }, { name: 'v', type: 'number' }];
  const rows = [['a', 1], ['b', 2], ['a', 3]];
  const out = await runResidentPipeline(stage(columns, rows), columns,
    [{ type: 'group_aggregate', groupBy: ['g'],
       aggregations: [{ column: 'v', fn: 'sum', as: 't' }] }]);
  assert.ok(out !== null);
  const snap = trace.snapshot()['preparePipeline'];
  assert.strictEqual(snap.resident, 1);
  assert.strictEqual(snap.failed, 0);
});

test('the table is never hydrated: no rows are read into JS to run the pipeline', async () => {
  // The point of the change. If someone reintroduces a materialising step, the
  // resident path still returns the right answer and this is the only check
  // that notices — hence spying on the reader rather than trusting the shape.
  const columns = [{ name: 'g', type: 'text' }, { name: 'v', type: 'number' }];
  const rows: any[][] = [];
  for (let i = 0; i < 5000; i++) rows.push(['g' + (i % 3), i]);
  const file = stage(columns, rows);

  // The reader a request path would hydrate through is the async one; the sync
  // twin (parquetStoreSync) is unreachable from src/ (test-asyncReach).
  const realRead = parquetStore.readTableAsync;
  let reads = 0;
  parquetStore.readTableAsync = function spy(...args: any[]): any { reads++; return realRead.apply(this, args); };
  try {
    const out = await runResidentPipeline(file, columns,
      [{ type: 'filter', column: 'v', op: '>', value: 10 },
       { type: 'group_aggregate', groupBy: ['g'],
         aggregations: [{ column: 'v', fn: 'sum', as: 't' }] }]);
    assert.ok(out !== null, 'resident path declined — the spy proves nothing');
    assert.strictEqual(out.rowCount, 3);
    assert.strictEqual(reads, 0, `readTableAsync was called ${reads}x — the table was hydrated`);
  } finally {
    parquetStore.readTableAsync = realRead;
  }
});
