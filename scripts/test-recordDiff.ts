// Self-check for src/analysis/recordDiff.ts — the one-line "what changed"
// summary version history shows beside every save.
//
// The summary is app-generated from a structural diff, so it is asserted as
// exact text per record type: a sentence that drifted ("Changed 1 tile" for an
// added one) would be a history that lies about itself.
//
//   npm run build:ts && node scripts/test-recordDiff.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

// ponytail: compiled sibling of the real module.
const diff: typeof import('../src/analysis/recordDiff') = require('../src/analysis/recordDiff');

const P1 = '10000000-0000-4000-8000-000000000001';
const P2 = '10000000-0000-4000-8000-000000000002';
const C = (n: number): string => `20000000-0000-4000-8000-00000000000${n}`;
const f = (column: string, value: string) => ({ type: 'filter', column, op: 'eq', value });

// ── dashboard ────────────────────────────────────────────────────────────────
const dashA = {
  id: 'x', name: 'Sales', updatedAt: '2026-01-01',
  sheets: [
    { id: P1, name: 'Overview', cards: [
      { id: C(1), type: 'visual', visualId: C(9), layout: { x: 0, y: 0, w: 6, h: 4 } },
      { id: C(2), type: 'text', heading: 'Notes', layout: { x: 6, y: 0, w: 6, h: 2 } },
    ] },
    { id: P2, name: 'Detail', cards: [] },
  ],
  filters: [f('region', 'West'), f('year', '2025'), f('segment', 'Retail')],
  style: { theme: 'auto', density: 'comfortable', accent: 'blue' },
};
const dashB = JSON.parse(JSON.stringify(dashA));
dashB.sheets[0].cards.push({ id: C(3), type: 'text', heading: 'New', layout: { x: 0, y: 4, w: 12, h: 2 } });
dashB.sheets[1].name = 'Detail by region';
dashB.filters = [f('region', 'East'), f('year', '2026'), f('segment', 'Online')];
dashB.updatedAt = '2026-02-02';

ok('dashboard: the spec sentence, exactly',
  diff.summarize('dashboard', dashA, dashB) === 'Added 1 tile, renamed page 2, changed 3 filters',
  diff.summarize('dashboard', dashA, dashB));
ok('dashboard: nothing before it is the first version',
  diff.summarize('dashboard', null, dashA) === 'First saved version');
ok('dashboard: a timestamp alone is not a change',
  diff.sameContent('dashboard', dashA, { ...dashA, updatedAt: 'later' }));
ok('dashboard: … and says so if asked',
  diff.summarize('dashboard', dashA, { ...dashA, updatedAt: 'later' }) === 'No changes');

const dashMoved = JSON.parse(JSON.stringify(dashA));
dashMoved.sheets[0].cards[0].layout.x = 6;
dashMoved.sheets[0].cards[1].layout.w = 3;
ok('dashboard: a move and a resize are told apart',
  diff.summarize('dashboard', dashA, dashMoved) === 'Moved 1 tile, resized 1 tile',
  diff.summarize('dashboard', dashA, dashMoved));

const dashRemoved = JSON.parse(JSON.stringify(dashA));
dashRemoved.sheets[0].cards.shift();
dashRemoved.sheets.push({ id: C(7), name: 'Third', cards: [] });
dashRemoved.style = { theme: 'dark', density: 'comfortable', accent: 'blue' };
ok('dashboard: removed tile, added page, restyled',
  diff.summarize('dashboard', dashA, dashRemoved) === 'Removed 1 tile, added page 3, changed the style',
  diff.summarize('dashboard', dashA, dashRemoved));

// A tile dragged to another page is a move, not a remove plus an add.
const dashAcross = JSON.parse(JSON.stringify(dashA));
dashAcross.sheets[1].cards.push(dashAcross.sheets[0].cards.pop());
ok('dashboard: a tile moved across pages is ONE move',
  diff.summarize('dashboard', dashA, dashAcross) === 'Moved 1 tile', diff.summarize('dashboard', dashA, dashAcross));

// Many clauses fold into "and N more".
const dashMany = JSON.parse(JSON.stringify(dashRemoved));
dashMany.name = 'Renamed';
dashMany.filters = [];
dashMany.sheets[1].name = 'Other';
ok('dashboard: past four clauses the rest are counted, not listed',
  /^Renamed the dashboard, removed 1 tile, added page 3 and 3 more changes$/.test(diff.summarize('dashboard', dashA, dashMany)),
  diff.summarize('dashboard', dashA, dashMany));

// ── visual ───────────────────────────────────────────────────────────────────
const visA = {
  id: 'v', name: 'Revenue', chartType: 'column', favorite: false,
  encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
  overrides: {}, filters: [],
};
ok('visual: a favourite star is not a version',
  diff.sameContent('visual', visA, { ...visA, favorite: true }));
const visB = {
  ...visA, chartType: 'line',
  encoding: { category: 'month', values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'profit', aggregation: 'sum' }] },
  filters: [f('region', 'West')],
};
ok('visual: type, category, measure and filter',
  diff.summarize('visual', visA, visB) === 'Changed to a line chart, changed the category to month, added 1 measure, added 1 filter',
  diff.summarize('visual', visA, visB));
ok('visual: styling only',
  diff.summarize('visual', visA, { ...visA, overrides: { showLegend: false } }) === 'Changed the styling');
ok('visual: map type reads as words',
  diff.summarize('visual', visA, { ...visA, chartType: 'map_choropleth' }) === 'Changed to a map choropleth chart');

// ── metric ───────────────────────────────────────────────────────────────────
const metA = {
  id: 'm', name: 'Revenue', datasetId: 'd', definition: { column: 'revenue', aggregation: 'sum' },
  filters: [], format: { kind: 'currency', decimals: 0, compact: true },
};
ok('metric: definition and format',
  diff.summarize('metric', metA, { ...metA, definition: { formula: '[A] / [B]' }, format: { kind: 'percent', decimals: 1, compact: false } })
    === 'Changed the definition, changed the format');
ok('metric: a description added then cleared are both changes',
  diff.summarize('metric', metA, { ...metA, description: 'x' }) === 'Edited the description'
  && diff.summarize('metric', { ...metA, description: 'x' }, metA) === 'Edited the description');
ok('metric: rename + one filter',
  diff.summarize('metric', metA, { ...metA, name: 'Sales', filters: [f('refund', 'no')] }) === 'Renamed the metric, added 1 filter');

// ── report ───────────────────────────────────────────────────────────────────
const pg = (id: string, kind: string, include = true) => ({ id, kind, include, layout: 'full' });
const repA = {
  id: 'r', name: 'Weekly', analysisId: 'a', format: 'pdf',
  pages: [pg(C(1), 'cover'), pg(C(2), 'summary'), pg(C(3), 'sheet')],
  cover: { title: 'Weekly' }, paper: { size: 'letter', orientation: 'portrait' },
  includeFilters: true, narrative: false, lastRunAt: 'x', lastFile: 'y',
};
ok('report: run bookkeeping is not content',
  diff.sameContent('report', repA, { ...repA, lastRunAt: 'z', lastFile: 'w' }));
ok('report: format, excluded page, schedule',
  diff.summarize('report', repA, {
    ...repA, format: 'pptx',
    pages: [pg(C(1), 'cover'), pg(C(2), 'summary', false), pg(C(3), 'sheet')],
    schedule: { cadence: 'weekly', at: '09:00', folder: '/tmp' },
  }) === 'Changed the format to PPTX, excluded 1 page, changed the schedule');
ok('report: pages added and reordered',
  diff.summarize('report', repA, { ...repA, pages: [...repA.pages, pg(C(4), 'notes')] }) === 'Added 1 page'
  && diff.summarize('report', repA, { ...repA, pages: [repA.pages[1], repA.pages[0], repA.pages[2]] }) === 'Reordered pages');

// ── dataset pipeline ─────────────────────────────────────────────────────────
const calc = (name: string, expression: string) => ({ type: 'calculated_field', name, expression });
const dsA = { id: 'd', steps: [calc('Month', "datetrunc('month', [order_date])")] };
ok('dataset: the first pipeline has its own words',
  diff.summarize('dataset', null, dsA) === 'First saved pipeline');
ok('dataset: a new calculated field is NAMED',
  diff.summarize('dataset', dsA, { id: 'd', steps: [...dsA.steps, calc('Margin', '[profit] / [revenue]')] })
    === 'Added calculated field Margin');
ok('dataset: an edited expression is an edit of that field, not add+remove',
  diff.summarize('dataset', dsA, { id: 'd', steps: [calc('Month', "datetrunc('year', [order_date])")] })
    === 'Edited calculated field Month');
ok('dataset: other steps are counted',
  diff.summarize('dataset', dsA, { id: 'd', steps: [...dsA.steps, f('region', 'West'), { type: 'dedupe' }] })
    === 'Added 2 steps');
ok('dataset: reorder only',
  diff.summarize('dataset', { id: 'd', steps: [f('a', '1'), f('b', '2')] }, { id: 'd', steps: [f('b', '2'), f('a', '1')] })
    === 'Reordered steps');
ok('dataset: a dataset with no steps field reads as an empty pipeline',
  diff.sameContent('dataset', { id: 'd' }, { id: 'd', steps: [] }));

// canonical(): key order never produces a phantom change.
ok('canonical: key order is irrelevant',
  diff.canonical({ a: 1, b: { c: 2, d: 3 } }) === diff.canonical({ b: { d: 3, c: 2 }, a: 1 }));

finish();
