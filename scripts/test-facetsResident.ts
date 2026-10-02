'use strict';

// DIFFERENTIAL self-check for small multiples: the resident path
// (engine/facetResident — rank probes + ONE grouped query with the facet dims
// added, over the stored Parquet) against the JS reference
// (analysis/facets.buildFacetData over the same file read back), compared with
// Object.is on every figure and exactly on every label, title, step and order.
//
// The fixture is adversarial where the two paths could split: empty cells as
// null / '' / whitespace / NBSP / tab (one "(blank)" panel), a real value
// spelled "Other" next to the fold, a leading BOM, a category over the top-50
// cap, a number category (bins) and a date category (a grain).
//
//   npm run build:ts && node scripts/test-facetsResident.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as rq from '../src/engine/residentQuery';
import * as pq from '../src/engine/parquetStore';
import * as duck from '../src/engine/duckdb';
import { facetDataResident } from '../src/engine/facetResident';
import { buildFacetData } from '../src/analysis/facets';
import type { VizEncoding } from '../src/analysis/visuals';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';
import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-facets-'));
const COLS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'seg', type: 'text' },
  { name: 'sku', type: 'text' },
  { name: 'qty', type: 'number' },
  { name: 'd', type: 'date' },
  { name: 'v', type: 'number' },
];
const REGIONS: Cell[] = ['West', 'East', 'Other', '﻿North', 'South', null, '', ' ', ' ', '\t', 'Central', 'Mid'];
const SEGS: Cell[] = ['Consumer', 'Corporate', 'Home', null];
const ROWS: Cell[][] = [];
for (let i = 0; i < 1500; i++) {
  const m = String((i % 12) + 1).padStart(2, '0');
  ROWS.push([
    REGIONS[(i * 7) % REGIONS.length],
    SEGS[(i * 3) % SEGS.length],
    `sku-${(i * 13) % 70}`,
    (i * 37) % 101,
    `2024-${m}-${String((i % 27) + 1).padStart(2, '0')}`,
    i % 9 === 0 ? null : ((i * 53) % 997) + 0.5,
  ]);
}
const file = path.join(dir, 'fixture.parquet');
pq.writeTable(file, COLS, ROWS);
const back = pq.readTable(file, COLS);
if (!back) throw new Error('fixture read-back failed');
const src: rq.ResidentSource = { parquetPath: file, columns: COLS };

function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number' || a === null || b === null) return Object.is(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as any)[k] !== undefined).sort(); // any: structural walk
    const kb = Object.keys(b).filter((k) => (b as any)[k] !== undefined).sort(); // any: structural walk
    return same(ka, kb) && ka.every((k) => same((a as any)[k], (b as any)[k])); // any: structural walk
  }
  return a === b;
}

function diff(label: string, enc: VizEncoding, filters: FilterStep[] = []): void {
  const want = buildFacetData(back!.columns, back!.rows, enc, filters);
  const got = facetDataResident(src, enc, filters);
  ok(`${label}: resident answered`, !!got);
  if (!got) return;
  ok(`${label}: JS raised no warning (the fast path's precondition)`, want.warnings.length === 0, want.warnings.join('; '));
  ok(`${label}: grid identical (Object.is on figures)`, same(got.data.facets, want.data.facets),
    JSON.stringify(got.data.facets).slice(0, 400) + '\n     js ' + JSON.stringify(want.data.facets).slice(0, 400));
  ok(`${label}: flattened series identical`, same(got.data.series, want.data.series) && same(got.data.labels, want.data.labels));
  ok(`${label}: category info identical`, same(got.category, want.category));
}

if (!rq.isResident()) {
  console.error('FAIL facetsResident: DuckDB bridge unavailable — nothing was verified');
  process.exit(1);
}

const sum = [{ column: 'v', aggregation: 'sum' as const }];
diff('1-D by label, blanks + "Other" value + BOM', { category: 'seg', values: sum, facet: { cols: 'region' } });
diff('1-D folded at 5 by measure', { category: 'seg', values: sum, facet: { cols: 'region', max: 5, order: 'measure' } });
diff('2-D rows × cols, folded', { category: 'seg', values: sum, facet: { rows: 'region', cols: 'seg', max: 4 } });
diff('multi-measure avg/count/min/max', {
  category: 'seg',
  values: [{ column: 'v', aggregation: 'avg' }, { column: 'region', aggregation: 'count' }, { column: 'qty', aggregation: 'min' }, { column: 'v', aggregation: 'none' }],
  facet: { cols: 'region', title: '{field} = {value}' },
});
diff('text category over the top-50 cap', { category: 'sku', values: sum, facet: { cols: 'seg' } });
diff('number category (bins)', { category: 'qty', values: sum, bins: 6, facet: { cols: 'seg' } });
diff('date category (auto grain)', { category: 'd', values: sum, facet: { cols: 'seg', order: 'measure' } });
diff('date category (quarter)', { category: 'd', values: sum, grain: 'quarter', facet: { rows: 'seg', cols: 'region', max: 3 } });
diff('split by a text column', { category: 'd', grain: 'month', values: sum, series: 'seg', facet: { cols: 'region', max: 4 } });
diff('under filters', { category: 'seg', values: sum, facet: { cols: 'region' } }, [
  { type: 'filter', column: 'qty', op: '>', value: 20 },
  { type: 'filter', column: 'region', op: 'not in', values: ['East'] },
]);
ok('a number facet column declines (JS answers)', facetDataResident(src, { category: 'seg', values: sum, facet: { cols: 'qty' } }, []) === null);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
duck.shutdown();
if (failureCount() > 0) {
  console.error(`\n${failureCount()} facet differential check(s) failed`);
  process.exit(1);
}
console.log('\nAll facet differential checks passed.');
