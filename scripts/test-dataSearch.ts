'use strict';

// Self-check for search inside the data — the PURE half (src/data/dataSearch.ts)
// and the per-dataset orchestration (engine/dataSearchResident.searchDataset)
// with its scan injected, so the ranking, the sensitivity exclusion and the
// time budget are pinned without DuckDB. The resident paths are pinned against
// the JS reference in test-dataSearchResident.ts.
//
//   npm run build:ts && node scripts/test-dataSearch.js

import * as ds from '../src/data/dataSearch';
import { searchDataset } from '../src/engine/dataSearchResident';
import type { SearchIndex } from '../src/engine/dataSearchResident';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell } from '../src/data/transforms';
import { ok, finish } from './selfcheck';

async function main(): Promise<void> {
  // ── Ranking: exact, then prefix, then contains; ties by rows desc, then value ──
  ok('rank: exact ignores case', ds.rankOf('California', 'california') === 0);
  ok('rank: prefix', ds.rankOf('Californian', 'california') === 1);
  ok('rank: contains', ds.rankOf('Baja California', 'california') === 2);
  ok('rank: no match', ds.rankOf('Texas', 'california') === -1);
  ok('rank: empty needle never matches', ds.rankOf('x', '') === -1);
  ok('needle is trimmed and lower-cased', ds.needleOf('  CHAIRS ') === 'chairs');

  const ranked = ds.matchPairs([
    ['Office chairs', 900], ['Chairs', 3], ['chairs and tables', 50], ['Chairside', 50], ['Armchairs', 900], ['CHAIRS', 3],
  ], 'chairs');
  ok('order: exact (tie on rows → code-unit value), then prefix, then contains by rows desc then value',
    JSON.stringify(ranked.map((m) => m.value)) ===
      JSON.stringify(['CHAIRS', 'Chairs', 'Chairside', 'chairs and tables', 'Armchairs', 'Office chairs']),
    JSON.stringify(ranked));
  ok('order: each match carries its rank and row count', ranked[0].rank === 0 && ranked[2].rank === 1 && ranked[5].rank === 2 && ranked[4].rows === 900);

  const many: Array<[string, number]> = Array.from({ length: 50 }, (_, i) => ['v' + i, i]);
  ok('cap: 20 per column, the highest-ranked kept', ds.matchPairs(many, 'v').length === ds.PER_COLUMN_CAP
    && ds.matchPairs(many, 'v')[0].value === 'v49');

  // ── LIKE escaping ──
  ok('escape: % _ and \\ are literal', ds.escapeLike('50%_off\\x') === '50\\%\\_off\\\\x');

  // ── The JS reference ──
  const columns: ParsedColumn[] = [
    { name: 'State', type: 'text' }, { name: 'Amount', type: 'number' }, { name: 'Email', type: 'text' }, { name: 'When', type: 'date' },
  ];
  const rows: Cell[][] = [
    ['California', 12, 'cal@example.com', '2024-01-01'],
    ['california', 7, 'x@example.com', '2024-01-02'],
    ['Baja California', 1, 'y@example.com', '2024-01-03'],
    ['  ', 3, null, null],
    [null, 4, '', null],
  ];
  const js = ds.searchRowsJs(columns, rows, 'Cal');
  ok('reference: only text columns are searched (never number or date)',
    js.map((c) => c.column).join(',') === 'State,Email', JSON.stringify(js));
  ok('reference: values counted per exact value',
    JSON.stringify(js[0].matches) === JSON.stringify([
      { value: 'California', rows: 1, rank: 1 }, { value: 'california', rows: 1, rank: 1 }, { value: 'Baja California', rows: 1, rank: 2 },
    ]), JSON.stringify(js[0].matches));
  ok('reference: whitespace-only and null are empty, never matched', ds.searchRowsJs(columns, rows, ' ').length === 0);
  ok('reference: an excluded column is not read', ds.searchRowsJs(columns, rows, 'example', new Set(['Email'])).length === 0);
  ok('valueCountsJs: null past its cap', ds.valueCountsJs(rows, 0, 2) === null && (ds.valueCountsJs(rows, 0, 3) || []).length === 3);

  // ── Sensitivity: marked columns are out unless the policy includes them ──
  const marked = new Set(['Email']);
  ok('policy mask → marked columns excluded', ds.excludedColumns('mask', marked).has('Email'));
  ok('policy drop → marked columns excluded', ds.excludedColumns('drop', marked).has('Email'));
  ok('policy include → nothing excluded', ds.excludedColumns('include', marked).size === 0);

  const src = { parquetPath: '/nowhere.parquet', columns };
  const scanned: number[] = [];
  const fakeScan = async (_p: string, ci: number, term: string): Promise<ds.ValueMatch[] | null> => {
    scanned.push(ci);
    const pairs = ds.valueCountsJs(rows, ci) || [];
    return ds.matchPairs(pairs, ds.needleOf(term));
  };
  const excl = await searchDataset(src, { term: 'example', exclude: ds.excludedColumns('mask', marked), scan: fakeScan });
  ok('searchDataset: a sensitive column is never scanned', !!excl && excl.columns.length === 0 && !scanned.includes(2), JSON.stringify(scanned));

  // ── The index answers its columns; the rest are scanned ──
  scanned.length = 0;
  const index: SearchIndex = { v: 1, stamp: 'x', columns: [
    { index: 0, name: 'State', values: ds.valueCountsJs(rows, 0) },
    { index: 2, name: 'Email', values: null }, // past the distinct cap → scan
  ] };
  const mixed = await searchDataset(src, { term: 'cal', index, scan: fakeScan });
  ok('index: an indexed column is not scanned, a high-cardinality one is', scanned.join(',') === '2', scanned.join(','));
  ok('index: answers agree with the reference', JSON.stringify(mixed && mixed.columns) === JSON.stringify(ds.searchRowsJs(columns, rows, 'cal')));

  // ── The budget: an injected clock, 200 ms per scan, 300 ms per dataset ──
  const wide: ParsedColumn[] = Array.from({ length: 6 }, (_, i) => ({ name: 't' + i, type: 'text' as const }));
  let clock = 0;
  scanned.length = 0;
  const slowScan = async (_p: string, ci: number): Promise<ds.ValueMatch[] | null> => {
    scanned.push(ci);
    clock += 200;
    return [{ value: 'hit' + ci, rows: 1, rank: 2 }];
  };
  const budgeted = await searchDataset({ parquetPath: '/nowhere.parquet', columns: wide }, { term: 'hit', now: () => clock, scan: slowScan });
  ok('budget: scanning stops once 300 ms are spent (2 of 6 columns)', scanned.length === 2 && !!budgeted && budgeted.skipped === 4,
    JSON.stringify({ scanned, budgeted }));
  ok('budget: what was found before the cutoff is kept', !!budgeted && budgeted.columns.length === 2);

  // ── Cancellation: a newer search stops this one before its next query ──
  let calls = 0;
  const cancelled = await searchDataset({ parquetPath: '/nowhere.parquet', columns: wide }, {
    term: 'hit', scan: async () => { calls++; return []; }, cancelled: () => calls >= 1,
  });
  ok('cancel: null, and no further scan issued', cancelled === null && calls === 1);

  // ── A failed scan is skipped, not fatal ──
  const failed = await searchDataset(src, { term: 'cal', scan: async () => null });
  ok('failure: counted, the dataset still answers', !!failed && failed.failed === 2 && failed.columns.length === 0);

  finish();
}

void main();
