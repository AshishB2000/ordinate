'use strict';

// Measures search inside the data on 1M rows: the index build, its size on
// disk, an indexed lookup and an un-indexed (scan) lookup. Not a test — run by
// hand when a threshold in engine/dataSearchResident.ts is questioned.
//
//   npm run build:ts && node scripts/bench-dataSearch.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pq from '../src/engine/parquetStore';
import * as ds from '../src/engine/dataSearchResident';
import * as duck from '../src/engine/duckdb';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell } from '../src/data/transforms';

async function main(): Promise<void> {
  const N = 1_000_000;
  const columns: ParsedColumn[] = [
    { name: 'state', type: 'text' }, { name: 'category', type: 'text' }, { name: 'sku', type: 'text' },
    { name: 'invoice', type: 'text' }, { name: 'note', type: 'text' }, { name: 'amount', type: 'number' },
    { name: 'city', type: 'text' },
  ];
  const states = ['California', 'Texas', 'New York', 'Florida', 'Ohio', 'Nevada'];
  const cats = ['Chairs', 'Tables', 'Phones', 'Binders'];
  const rows: Cell[][] = [];
  for (let i = 0; i < N; i++) {
    rows.push([states[i % 6], cats[i % 4], 'SKU-' + (i % 5000), 'INV-' + i, 'note ' + (i % 20000), i, 'City' + (i % 800)]);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bench-search-')), 'd.parquet');
  await pq.writeTableAsync(file, columns, rows);
  const src = { parquetPath: file, columns };

  let t = performance.now();
  await ds.writeIndex(src);
  console.log(`index build+write: ${(performance.now() - t).toFixed(0)} ms, ${fs.statSync(ds.indexPathFor(file)).size} bytes`);
  t = performance.now();
  const idx = await ds.readIndex(file);
  console.log(`index read: ${(performance.now() - t).toFixed(1)} ms`);
  for (const term of ['california', 'chairs', 'INV-2041', 'note 1']) {
    t = performance.now();
    const r = await ds.searchDataset(src, { term, index: idx });
    console.log(`"${term}" indexed: ${(performance.now() - t).toFixed(1)} ms, ${r ? r.columns.length : 0} columns, skipped ${r ? r.skipped : '-'}`);
    t = performance.now();
    const s = await ds.searchDataset(src, { term, index: null, budgetMs: 1e9 });
    console.log(`"${term}" scan only: ${(performance.now() - t).toFixed(1)} ms, ${s ? s.columns.length : 0} columns`);
  }
  duck.shutdown();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

void main();
