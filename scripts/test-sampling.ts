// The builder's preview sample (src/analysis/sampling.ts, and its SQL twin
// src/engine/sampleResident.ts): deterministic, stratified by the category
// column, rare categories never sampled away, and the two engines selecting
// the SAME rows in the same order.
//
//   npm run build:ts && node scripts/test-sampling.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sampling from '../src/analysis/sampling';
import { sampleRowsResident } from '../src/engine/sampleResident';
import * as parquetStore from '../src/engine/parquetStore';
import type { Cell } from '../src/data/transforms';

// A skewed table: 'big' has most rows, 'rare' has 3, one null-category run.
function table(n: number): Cell[][] {
  const rows: Cell[][] = [];
  for (let i = 0; i < n; i++) {
    const cat = i % 1000 === 0 ? 'rare' + (i % 3000 === 0 ? '' : '') : i % 10 < 7 ? 'big' : i % 10 < 9 ? 'mid' : null;
    rows.push([cat, i, 'n' + (i % 13)]);
  }
  return rows;
}

void (async () => {
  // ── The keep rule ─────────────────────────────────────────────────────────
  ok('keepRank: everything is kept when the table is under the target',
    [1, 2, 3].every((i) => sampling.keepRank(i, 10, 5, false)));
  let kept = 0;
  for (let i = 1; i <= 1000; i++) if (sampling.keepRank(i, 250, 1000, false)) kept++;
  ok('keepRank: exactly T/N of a stratum at an exact rate', kept === 250, kept);
  ok('keepRank: the first row is kept when guaranteed', sampling.keepRank(1, 1, 1_000_000, true) && !sampling.keepRank(1, 1, 1_000_000, false));

  // ── Stratified, deterministic ─────────────────────────────────────────────
  const rows = table(40_000);
  const a = sampling.stratifiedIndexes(rows, 0, 10_000);
  const b = sampling.stratifiedIndexes(rows, 0, 10_000);
  ok('determinism: the same table gives the same sample', JSON.stringify(a) === JSON.stringify(b));
  ok('size: about the target (within the number of strata)', Math.abs(a.length - 10_000) <= 5, a.length);
  ok('order: kept rows stay in file order', a.every((v, i) => i === 0 || v > a[i - 1]));
  const share = (sample: number[], cat: Cell) =>
    sample.filter((i) => rows[i][0] === cat).length / rows.filter((r) => r[0] === cat).length;
  ok('stratified: every category keeps its share (±1 row)',
    ['big', 'mid', null].every((c) => Math.abs(share(a, c) - 0.25) < 0.001), ['big', 'mid', null].map((c) => share(a, c)).join(','));
  const rare = a.filter((i) => rows[i][0] === 'rare');
  ok('stratified: a rare category is never sampled away', rare.length >= 1);
  const flat = sampling.stratifiedIndexes(rows, -1, 10_000);
  ok('no category: plain systematic sampling of exactly T rows', flat.length === 10_000);
  ok('small table: returned whole', sampling.stratifiedIndexes(table(100), 0, 10_000).length === 100);

  // A near-unique category must not turn the guarantee into "keep everything".
  const unique: Cell[][] = Array.from({ length: 20_000 }, (_, i) => ['u' + i, i]);
  ok('many strata: the first-row guarantee is off above MAX_STRATA',
    sampling.stratifiedIndexes(unique, 0, 5_000).length <= 5_000 + 1);

  ok('note: "Preview computed on 250k of 1M rows"',
    sampling.sampleNote({ rows: 250_000, of: 1_000_000, by: 'region' }) === 'Preview computed on 250k of 1M rows',
    sampling.sampleNote({ rows: 250_000, of: 1_000_000, by: 'region' }));
  ok('note: odd sizes read naturally', sampling.sampleNote({ rows: 250_004, of: 1_250_000, by: null }) === 'Preview computed on 250k of 1.3M rows'
    || sampling.sampleNote({ rows: 250_004, of: 1_250_000, by: null }) === 'Preview computed on 250k of 1.2M rows');

  // ── The SQL twin selects the same rows ────────────────────────────────────
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sampling-'));
  const file = path.join(dir, 's.parquet');
  const columns = [{ name: 'cat', type: 'text' as const }, { name: 'i', type: 'number' as const }, { name: 'note', type: 'text' as const }];
  parquetStore.writeTable(file, columns, rows);
  const sql = await sampleRowsResident({ parquetPath: file, columns }, 0, 10_000);
  const js = a.map((i) => rows[i]);
  ok('resident: the SQL sample answered', !!sql && sql.total === rows.length);
  ok('resident: SQL and JS select the SAME rows in the same order',
    !!sql && sql.rows.length === js.length && sql.rows.every((r, k) => r.every((c, j) => Object.is(c, js[k][j]))),
    sql ? `${sql.rows.length} vs ${js.length}` : 'null');
  const sqlFlat = await sampleRowsResident({ parquetPath: file, columns }, -1, 10_000);
  ok('resident: no-category sampling matches too',
    !!sqlFlat && JSON.stringify(sqlFlat.rows.map((r) => r[1])) === JSON.stringify(flat.map((i) => rows[i][1])));
  const again = await sampleRowsResident({ parquetPath: file, columns }, 0, 10_000);
  ok('resident: deterministic across runs', !!again && JSON.stringify(again.rows) === JSON.stringify(sql && sql.rows));

  fs.rmSync(dir, { recursive: true, force: true });
  finish();
})().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
