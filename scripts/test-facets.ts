'use strict';

// Small multiples — the pure half (src/analysis/facets.ts, facetCaption.ts):
// panel splitting with missing combinations, shared vs independent domains,
// the "Other" fold, panel order and titles, the filter steps a panel drills
// with, and the caption across panels. The resident twin is held to this file's
// reference in test-facetsResident.ts.
//
//   npm run build:ts && node scripts/test-facets.js

import { ok, finish } from './selfcheck';
import {
  buildFacetData, foldFacets, planFacetDim, rankGroups, sanitizeFacet, facetDims, panelDomain, unionDomain,
} from '../src/analysis/facets';
import type { FacetGrid } from '../src/analysis/facets';
import { facetCaption, pluralNoun } from '../src/analysis/facetCaption';
import { tileCaption } from '../src/analysis/captions';
import { sanitizeEncoding } from '../src/analysis/visuals';
import { applyPipeline } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell } from '../src/data/transforms';

const COLS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'cat', type: 'text' },
  { name: 'month', type: 'text' },
  { name: 'sales', type: 'number' },
];
// West has no Tech rows; East has no Office rows — two missing combinations.
const ROWS: Cell[][] = [
  ['West', 'Furniture', 'Jan', 10], ['West', 'Furniture', 'Feb', 30], ['West', 'Office', 'Jan', 5],
  ['East', 'Furniture', 'Jan', 4], ['East', 'Tech', 'Feb', 50], ['East', 'Tech', 'Jan', 6],
  ['North', 'Office', 'Feb', 7], ['North', 'Tech', 'Jan', 1], [null, 'Tech', 'Jan', 2], ['  ', 'Office', 'Feb', 3],
];
const sum = [{ column: 'sales', aggregation: 'sum' as const }];

// ── sanitize ────────────────────────────────────────────────────────────────
ok('sanitize: no dimension → undefined', sanitizeFacet({ scale: 'independent' }) === undefined);
ok('sanitize: same column twice keeps one', JSON.stringify(sanitizeFacet({ rows: 'a', cols: 'a' })) === '{"rows":"a"}');
ok('sanitize: max clamps to the set, out of range dropped', sanitizeFacet({ cols: 'a', max: 99 })!.max === undefined && sanitizeFacet({ cols: 'a', max: 5 })!.max === 5);
ok('sanitize: rides on the encoding', JSON.stringify(sanitizeEncoding({ category: 'x', values: [], facet: { cols: 'r', order: 'measure', junk: 1 } }).facet) === '{"cols":"r","order":"measure"}');
ok('dims: a 2-D grid caps each side at 6 (≤ 36 panels)', facetDims({ rows: 'a', cols: 'b', max: 20 }).every((d) => d.cap === 6));

// ── rank + fold ─────────────────────────────────────────────────────────────
const ranked = rankGroups([{ key: 'a', m: 1 }, { key: 'b', m: null }, { key: 'c', m: 5 }, { key: 'd', m: 1 }]);
ok('rank: value desc, nulls last, ties first-seen', ranked.map((r) => r.key).join() === 'c,a,d,b');
const folded = planFacetDim('x', ranked, 3, 'label');
ok('fold: beyond N keeps N−1 and folds the rest', folded.folded && folded.keep.join() === 'c,a');
ok('fold: Other is last in display order', folded.order.join() === '1,0,-1');
ok('fold: N or fewer keeps all', !planFacetDim('x', ranked, 4, 'measure').folded);

// ── 1-D: one panel per region, blank its own panel ──────────────────────────
{
  const r = buildFacetData(COLS, ROWS, { category: 'cat', values: sum, facet: { cols: 'region' } });
  const g = r.data.facets!;
  ok('1-D: one panel per value + blank', g.cols.join() === 'East,North,West,(blank)', g.cols.join());
  ok('1-D: wraps (no row headers)', g.rows.length === 0 && g.panels.every((p) => p.row === 0));
  ok('1-D: labels are global and first-seen', g.panels[0].labels.join() === 'Furniture,Office,Tech');
  const west = g.panels.find((p) => p.title === 'West')!;
  ok('1-D: a missing category is null, never 0', west.series[0].values.join() === '40,5,' && west.series[0].values[2] === null);
  ok('1-D: blank panel drills with is_empty', JSON.stringify(g.panels[3].steps) === '[{"type":"filter","column":"region","op":"is_empty"}]');
  ok('1-D: flattened series name the panel', r.data.series.map((s) => s.name).join() === 'East,North,West,(blank)');
  // Every panel's figures equal the same chart over its own rows.
  for (const p of g.panels) {
    const rows = applyPipeline({ columns: COLS, rows: ROWS }, p.steps).rows;
    const want = new Map<string, number>();
    for (const row of rows) want.set(String(row[1]), (want.get(String(row[1])) || 0) + (row[3] as number));
    ok(`1-D: panel ${p.title} == its own rows`, p.labels.every((l, i) => Object.is(p.series[0].values[i], want.has(String(l)) ? want.get(String(l))! : null)));
  }
}

// ── 2-D: missing combinations, order by measure, Other ──────────────────────
{
  const r = buildFacetData(COLS, ROWS, { category: 'month', values: sum, facet: { rows: 'region', cols: 'cat', order: 'measure', max: 3 } });
  const g = r.data.facets!;
  ok('2-D: rows by measure, top 2 + Other', g.rows.join() === 'East,West,Other', g.rows.join());
  ok('2-D: cols by measure', g.cols.join() === 'Tech,Furniture,Office', g.cols.join());
  ok('2-D: rows × cols panels', g.panels.length === 9);
  const westTech = g.panels.find((p) => p.title === 'West · Tech')!;
  ok('2-D: a missing combination is an empty panel', westTech.empty && westTech.domain === null);
  ok('2-D: Other drills with not in', JSON.stringify(g.panels[6].steps[0]) === '{"type":"filter","column":"region","op":"not in","values":["East","West"]}');
  const otherOffice = g.panels.find((p) => p.title === 'Other · Office')!;
  ok('2-D: Other re-aggregates its rows (North 7 + blank 3)', otherOffice.series[0].values[otherOffice.labels.indexOf('Feb')] === 10);
}

// ── titles, split charts ────────────────────────────────────────────────────
{
  const r = buildFacetData(COLS, ROWS, { category: 'month', values: sum, series: 'cat', facet: { cols: 'region', title: '{field}: {value}' } });
  const g = r.data.facets!;
  ok('title template', g.panels[0].title === 'region: East');
  ok('split: one series per split value in every panel', g.panels.every((p) => p.series.map((s) => s.name).join() === 'Furniture,Office,Tech'));
  ok('split: flattened as panel · series', r.data.series[0].name === 'region: East · Furniture');
}

// ── domains ─────────────────────────────────────────────────────────────────
{
  const d = panelDomain(['a', 'b'], [{ values: [3, -2] }, { values: [4, -1] }]);
  ok('domain: plain min/max', !!d && d.min === -2 && d.max === 4);
  ok('domain: stacked sums each sign', !!d && d.stackMax === 7 && d.stackMin === -3);
  ok('domain: all-null panel has none', panelDomain(['a'], [{ values: [null] }]) === null);
  const u = unionDomain([d, null, { min: 0, max: 9, stackMin: 0, stackMax: 9 }]);
  ok('domain: shared = union', !!u && u.min === -2 && u.max === 9 && u.stackMax === 9 && u.stackMin === -3);
  const shared = buildFacetData(COLS, ROWS, { category: 'cat', values: sum, facet: { cols: 'region' } }).data.facets!;
  const indep = buildFacetData(COLS, ROWS, { category: 'cat', values: sum, facet: { cols: 'region', scale: 'independent' } }).data.facets!;
  ok('domain: shared grid carries the union', shared.scale === 'shared' && shared.domain!.max === 56);
  ok('domain: independent keeps each panel its own', indep.scale === 'independent' && indep.panels[0].domain!.max === 56 && indep.panels[1].domain!.max === 7);
}

// ── scatter (raw) panels and unknown columns ────────────────────────────────
{
  const raw = buildFacetData(COLS, ROWS, { category: 'cat', values: [{ column: 'sales', aggregation: 'none' }], facet: { cols: 'region' } });
  ok('raw: each panel is its own rows', raw.data.facets!.panels.find((p) => p.title === 'West')!.labels.length === 3);
  const bad = buildFacetData(COLS, ROWS, { category: 'cat', values: sum, facet: { cols: 'nope' } });
  ok('unknown facet column: plain chart + a warning', !bad.data.facets && bad.warnings.some((w) => /nope/.test(w)));
}

// ── captions ────────────────────────────────────────────────────────────────
{
  ok('plural', pluralNoun('Category') === 'categories' && pluralNoun('Region') === 'regions' && pluralNoun('Box') === 'boxes');
  const grid = (panels: number[][]): FacetGrid => foldFacets(
    panels.flatMap((vals, r) => vals.map((v, i) => ({ r, c: 0, key: String(i), label: ['West', 'East', 'North'][i], values: [v] }))),
    [planFacetDim('Category', panels.map((_, i) => ({ key: `P${i}` })), 12, 'measure')], ['sum of sales'], {},
  ).grid;
  ok('caption: leader in k of n', facetCaption(grid([[9, 1, 2], [8, 3, 1], [1, 9, 2]]), 'bar') === 'West leads in 2 of 3 categories');
  ok('caption: leader in all', facetCaption(grid([[9, 1, 2], [8, 3, 1]]), 'bar') === 'West leads in all 2 categories');
  ok('caption: line counts rises', facetCaption(grid([[1, 2, 3], [3, 2, 1], [1, 1, 5]]), 'line') === 'Sum of sales rose in 2 of 3 categories');
  const data = buildFacetData(COLS, ROWS, { category: 'cat', values: sum, facet: { cols: 'region' } }).data;
  ok('caption: tileCaption reads the facets', tileCaption({ chartType: 'column', data }) === 'Office leads in 2 of 4 regions', tileCaption({ chartType: 'column', data }));
}

finish();
