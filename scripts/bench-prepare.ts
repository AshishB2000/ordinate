'use strict';

// Baseline harness for the Prepare hot path. NOT a test — named bench-* so
// `node --test "scripts/test-*.js"` never picks it up.
//
//   node scripts/bench-prepare.js [rows...]      default 10000 100000 1000000
//
// Measures three things over the SAME steps and the same generated table:
//
//   fold        transforms.applyPipeline — the reference implementation
//   duck+load   pipelineDuck with its CREATE TABLE + INSERT hydrate (force:true)
//   parquet     time to read <id>.source.parquet into JS, which is what
//               getDataset() pays BEFORE applyPipeline is ever called
//
// The third number is the one that matters and is easy to miss: the hydrate
// inside pipelineDuck is the SECOND load, not the first.

const path = require('path');
const os = require('os');
const fs = require('fs');

const transforms = require('../src/transforms');
const pipelineDuck = require('../src/engine/pipelineDuck');
const parquetStore = require('../src/engine/parquetStore');

// A representative pipeline: one of each shape that costs something — a
// row-wise expression, a predicate, and an aggregate.
// SQL-EXPRESSIBLE. Deliberately has no calculated_field: sqlGen bails on every
// one of them ("calculated_field requires formula→SQL translation"), so a
// pipeline containing one never reaches DuckDB at all and would measure the
// fold twice.
const STEPS = [
  { type: 'trim', column: 'name' },
  { type: 'fill_empty', column: 'region', value: 'unknown' },
  { type: 'filter', column: 'qty', op: '>', value: 2 },
  { type: 'group_aggregate', groupBy: ['region'], aggregations: [
    { column: 'price', fn: 'sum', as: 'revenue' },
    { column: 'qty', fn: 'avg', as: 'avg_qty' },
  ] },
];

// The same pipeline plus a calculated field — the shape that CANNOT go resident
// today. Measured so the ceiling on this whole change is visible, not implied.
const STEPS_CALC = [
  { type: 'calculated_field', name: 'total', expression: 'qty * price' },
  ...STEPS,
];

const COLUMNS = [
  { name: 'id', type: 'text' },       // '007…' — must never be cast
  { name: 'region', type: 'text' },
  { name: 'name', type: 'text' },
  { name: 'qty', type: 'number' },
  { name: 'price', type: 'number' },
];
const REGIONS = ['north', 'south', 'east', 'west', 'central'];

function buildRows(n: number): any[][] {
  const rows: any[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = [
      String(i).padStart(7, '0'),                 // leading zeros, stays text
      REGIONS[i % REGIONS.length],
      i % 17 === 0 ? '  padded  ' : 'name' + i,   // trim has real work
      (i % 9) + 1,
      ((i % 50) + 1) * 1.5,
    ];
  }
  return rows;
}

function time(label: string, fn: () => any): any {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms, out };
}

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const SIZES = sizes.length ? sizes : [10_000, 100_000, 1_000_000];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bench-'));
const results: any[] = [];

for (const n of SIZES) {
  const source = { columns: COLUMNS.map((c) => ({ ...c })), rows: buildRows(n) };

  const file = path.join(tmp, `bench-${n}.source.parquet`);
  parquetStore.writeTable(file, source.columns, source.rows);

  // Warm both paths once — first call pays module init and DuckDB attach.
  transforms.applyPipeline({ columns: source.columns, rows: source.rows.slice(0, 100) }, STEPS);

  const fold = time('fold', () => transforms.applyPipeline(source, STEPS));
  const duck = time('duck+load', () => pipelineDuck.runOnDuckDb(source, STEPS, { force: true }));
  const read = time('parquet read', () => parquetStore.readTable(file, source.columns));
  const resident = time('resident', () =>
    pipelineDuck.runResidentPipeline(file, source.columns, STEPS));
  // What updateSteps actually pays today: hydrate the source out of Parquet,
  // THEN fold. The resident number replaces both, which is the real comparison.
  const foldTotal = read.ms + fold.ms;
  const calc = time('fold+calc', () => transforms.applyPipeline(source, STEPS_CALC));
  const calcDuck = pipelineDuck.runOnDuckDb(source, STEPS_CALC, { force: true });

  const ok = duck.out !== null;
  results.push({ n, fold: fold.ms, duck: ok ? duck.ms : NaN, read: read.ms,
                 resident: resident.out === null ? NaN : resident.ms, foldTotal,
                 calc: calc.ms, calcResident: calcDuck !== null, rows: fold.out.rowCount });
  console.log(`${n.toLocaleString()} rows -> ${fold.out.rowCount} out | ` +
    `fold ${fold.ms.toFixed(0)}ms | duck+load ${ok ? duck.ms.toFixed(0) + 'ms' : 'NULL (fell back)'} | ` +
    `parquet read ${read.ms.toFixed(0)}ms | RESIDENT ${resident.out === null ? 'NULL' : resident.ms.toFixed(0) + 'ms'} ` +
    `(vs ${foldTotal.toFixed(0)}ms read+fold) | with calc field: fold ${calc.ms.toFixed(0)}ms, ` +
    `resident ${calcDuck === null ? 'NULL (sqlGen bails)' : 'ok'}`);
}

console.log('\n| rows | read+fold (today) | pipelineDuck w/ hydrate | RESIDENT | speedup vs today |');
console.log('|---|---|---|---|---|');
for (const r of results) {
  const gain = Number.isNaN(r.resident) ? 'n/a' : (r.foldTotal / r.resident).toFixed(1) + 'x';
  console.log(`| ${r.n.toLocaleString()} | ${r.foldTotal.toFixed(0)} ms ` +
    `(${r.read.toFixed(0)} read + ${r.fold.toFixed(0)} fold) | ` +
    `${Number.isNaN(r.duck) ? 'n/a' : r.duck.toFixed(0) + ' ms'} | ` +
    `${Number.isNaN(r.resident) ? 'NULL' : r.resident.toFixed(0) + ' ms'} | ${gain} |`);
}
fs.rmSync(tmp, { recursive: true, force: true });
