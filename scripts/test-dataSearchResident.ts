'use strict';

// Self-check for search inside the data — the RESIDENT half
// (src/engine/dataSearchResident.ts): the value index and the bounded ILIKE scan,
// both off a real Parquet file.
//
// DIFFERENTIAL, the house style: every answer is compared with Object.is to the
// pure JS scan over the SAME rows read back from the file (data/dataSearch.ts's
// searchRowsJs / valueCountsJs) — never to a hand-written list that could agree
// with a bug in both. Also pinned: the index is invalidated by any rewrite of
// the table, and a stale or corrupt index is ignored rather than trusted.
//
//   npm run build:ts && node scripts/test-dataSearchResident.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pq from '../src/engine/parquetStore';
import * as res from '../src/engine/dataSearchResident';
import * as ds from '../src/data/dataSearch';
import * as duck from '../src/engine/duckdb';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell } from '../src/data/transforms';
import { ok, finish } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-datasearch-'));

/** Object.is over the column matches, field by field. */
function same(a: ds.ColumnMatches[], b: ds.ColumnMatches[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => Object.is(c.index, b[i].index) && Object.is(c.column, b[i].column)
    && c.matches.length === b[i].matches.length
    && c.matches.every((m, k) => Object.is(m.value, b[i].matches[k].value) && Object.is(m.rows, b[i].matches[k].rows)
      && Object.is(m.rank, b[i].matches[k].rank)));
}

async function main(): Promise<void> {
  if (!(await pq.isSupportedAsync())) {
    ok('DuckDB bridge down — resident search not exercised', true);
    finish();
    return;
  }
  const columns: ParsedColumn[] = [
    { name: 'State', type: 'text' }, { name: 'Invoice', type: 'text' }, { name: 'Amount', type: 'number' },
    { name: 'Product', type: 'text' }, { name: 'Note', type: 'text' },
  ];
  const states = ['California', 'california', 'Baja California', 'Texas', 'New York', '  ', '\t', ''];
  const products = ['Chairs', 'Office Chairs', 'chairs', 'Tables', '50% off_sale', 'back\\slash', '﻿BOM Chairs'];
  const rows: Cell[][] = [];
  for (let i = 0; i < 3000; i++) {
    rows.push([
      i % 11 === 0 ? null : states[i % states.length],
      'INV-' + (2000 + i), // 3000 distinct → past a cap of 1000 in the index test below
      i,
      products[i % products.length],
      i % 5 === 0 ? 'Shipped to California office' : 'note ' + (i % 37),
    ]);
  }
  const file = path.join(dir, 'd.parquet');
  await pq.writeTableAsync(file, columns, rows);
  const back = await pq.readTableAsync(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  const src = { parquetPath: file, columns };

  // ── Index build: per-column value counts agree with the JS reference ──
  for (const ci of [0, 1, 3, 4]) {
    const sql = await res.valueCountsResident(file, ci);
    const js = ds.valueCountsJs(back.rows, ci, ds.INDEX_MAX_DISTINCT);
    ok(`index values == JS for ${columns[ci].name}`, !!sql && !!js && sql.length === js.length
      && sql.every((p, k) => Object.is(p[0], js[k][0]) && Object.is(p[1], js[k][1])), JSON.stringify(sql && sql.slice(0, 5)));
  }
  ok('index: past the distinct cap a column is marked for scanning (null), as in JS',
    (await res.valueCountsResident(file, 1, 1000)) === null && ds.valueCountsJs(back.rows, 1, 1000) === null);

  // ── Scan: match counts and order agree with the JS reference, including LIKE syntax in the term ──
  for (const term of ['california', 'CHAIRS', 'INV-204', '% off', '_', '\\', 'bom', 'nothing-like-this', 'inv-2041']) {
    const scanned: ds.ColumnMatches[] = [];
    for (const ci of ds.searchableColumns(columns, new Set())) {
      const m = await res.scanColumn(file, ci, term);
      if (m && m.length) scanned.push({ index: ci, column: String(columns[ci].name), matches: m });
    }
    const js = ds.searchRowsJs(back.columns, back.rows, term);
    ok(`scan == JS reference for "${term}"`, same(scanned, js), JSON.stringify({ scanned: scanned.slice(0, 2), js: js.slice(0, 2) }));
  }

  // ── Index write / read / invalidation ──
  ok('no index before one is written', (await res.readIndex(file)) === null);
  ok('writeIndex writes beside the Parquet', (await res.writeIndex(src)) && fs.existsSync(res.indexPathFor(file)));
  const idx = await res.readIndex(file);
  ok('the fresh index reads back', !!idx && idx.columns.length === 4);
  ok('index: the 3000-invoice column is indexed whole (under 10k)', !!idx && Array.isArray(idx.columns[1].values) && idx.columns[1].values.length === 3000);
  for (const term of ['california', 'chairs', 'inv-2041']) {
    const viaIndex = await res.searchDataset(src, { term, index: idx });
    ok(`search via index == JS reference for "${term}"`, !!viaIndex && same(viaIndex.columns, ds.searchRowsJs(back.columns, back.rows, term)));
  }

  await pq.writeTableAsync(file, columns, rows.slice(0, 10)); // a refresh rewrote the table
  ok('a rewritten table invalidates the index', (await res.readIndex(file)) === null);
  fs.writeFileSync(res.indexPathFor(file), '{not json');
  ok('a corrupt index is ignored, not trusted', (await res.readIndex(file)) === null);
  await res.writeIndex(src);
  const fresh = await res.readIndex(file);
  ok('rebuilt index describes the new table', !!fresh && fresh.columns[1].values !== null && fresh.columns[1].values.length === 10);
  await res.removeIndex(file);
  ok('removeIndex deletes it', !fs.existsSync(res.indexPathFor(file)));

  // ── scheduleIndex coalesces a burst into one build ──
  res.scheduleIndex(src, 20);
  res.scheduleIndex(src, 20);
  await new Promise((r) => setTimeout(r, 400));
  ok('scheduleIndex builds after the burst', (await res.readIndex(file)) !== null);

  duck.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  finish();
}

void main().catch((err) => {
  ok('threw: ' + String(err && err.stack), false);
  finish();
});
