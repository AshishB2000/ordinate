// Self-check for src/analysis/dashboardDelta.ts — the EDIT-DELTA validator.
//
// The gate this suite holds is the one the feature rests on: an untrusted model
// envelope must never mutate an existing dashboard in a way the app did not
// re-decide from the real records. So every check below is one of three shapes:
//
//   1. A VALID op survives with the exact normalised shape the IPC layer will
//      apply (title → cardId, page name → 0-based index, position → the
//      {position, anchorCardId} pair — never coordinates).
//   2. A BAD op is DROPPED, REPORTED with a message naming the offender, and
//      takes none of its siblings with it.
//   3. NOTHING THROWS. Null, arrays, strings, numbers and `{ops: 7}` all yield
//      a well-formed `{ops: [], dropped: [...]}`, because the caller is an IPC
//      handler holding a user's dashboard, not a try/catch.
//
// The validator is PURE and touches no disk, so the context is a hand-written
// literal. `electron` is still stubbed, because requiring the module pulls
// visuals.ts/analysisPlan.ts (for sanitizeEncoding and the closed chart-type
// list — reused rather than re-copied) which reach `app.getPath` at load.
//
//   npm run build:ts && node scripts/test-dashboardDelta.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-delta-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData },
      ipcMain: { handle: () => {} },
      net: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const dd: typeof import('../src/analysis/dashboardDelta') = require('../src/analysis/dashboardDelta');

type DeltaContext = import('../src/analysis/dashboardDelta').DeltaContext;

// ── Fixture ─────────────────────────────────────────────────────────────────
// Real UUIDs: dashboards.sanitizeCard UUID-checks a control card's datasetId,
// so an addControl op carrying anything else would be dropped downstream.
const SALES = '11111111-2222-4333-8444-555555555555';
const HR = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const ctx: DeltaContext = {
  pages: [{ name: 'Overview', tileCount: 2 }, { name: 'Detail', tileCount: 1 }],
  tiles: [
    { cardId: 'card-rev', pageIndex: 0, type: 'visual', title: 'Revenue by region',
      visualId: 'vis-1', datasetId: SALES, chartType: 'bar' },
    { cardId: 'card-cost', pageIndex: 0, type: 'visual', title: 'Cost over time',
      visualId: 'vis-2', datasetId: SALES, chartType: 'line' },
    { cardId: 'card-total', pageIndex: 1, type: 'metric', title: 'Total revenue', datasetId: SALES },
    { cardId: 'card-note', pageIndex: 1, type: 'text', title: 'Notes' },
  ],
  datasets: [
    { id: SALES, name: 'Sales', rowCount: 100, resident: true, columns: [
      { name: 'region', type: 'text' },
      { name: 'revenue', type: 'number' },
      { name: 'cost', type: 'number' },
      { name: 'code', type: 'text' }, // leading-zero id — must stay text
    ] },
    { id: HR, name: 'Headcount', rowCount: 10, resident: false, columns: [
      { name: 'team', type: 'text' },
      { name: 'people', type: 'number' },
    ] },
  ],
};

// A context with two similarly-named tiles, for the ambiguity ladder.
const twinCtx: DeltaContext = {
  ...ctx,
  tiles: [
    { cardId: 'a', pageIndex: 0, type: 'visual', title: 'Revenue by region', datasetId: SALES },
    { cardId: 'b', pageIndex: 0, type: 'visual', title: 'Revenue by region and month', datasetId: SALES },
  ],
};

const enc = (category: string, column: string, aggregation = 'sum'): unknown =>
  ({ category, values: [{ column, aggregation }] });

function one(raw: unknown, c: DeltaContext = ctx): any {
  return dd.validateDelta({ ops: [raw] }, c);
}

// ── §1 Every op kind, valid → the right normalised shape ───────────────────
function checkHappyPath(): void {
  const add = one({ op: 'addTile', dataset: 'Sales', chartType: 'bar', encoding: enc('region', 'revenue') });
  ok('addTile survives', add.ops.length === 1 && add.dropped.length === 0, JSON.stringify(add.dropped));
  ok('addTile normalises to the dataset id and defaults to page 0',
     add.ops[0].datasetId === SALES && add.ops[0].pageIndex === 0 && add.ops[0].name === 'Sales chart');
  ok('addTile keeps the sanitized encoding',
     add.ops[0].encoding.category === 'region' && add.ops[0].encoding.values[0].aggregation === 'sum');

  const onPage = one({ op: 'addTile', datasetId: SALES, chartType: 'pie', page: 'Detail',
    name: 'Mix', encoding: enc('region', 'revenue') });
  ok('addTile resolves a page NAME to a 0-based index', onPage.ops[0].pageIndex === 1);
  const clamped = one({ op: 'addTile', datasetId: SALES, chartType: 'pie', pageIndex: 99,
    encoding: enc('region', 'revenue') });
  ok('a numeric page index past the end is clamped to the last page', clamped.ops[0].pageIndex === 1);

  // ── addMetric ─────────────────────────────────────────────────────────────
  // The vocabulary could add a chart, a control, a page and a title but not a
  // KPI, so "add a KPI for average discount" came back as "not one of
  // Ordinate's edit operations" — while buildPlan could create that very tile.
  const kpi = one({ op: 'addMetric', dataset: 'Sales', column: 'revenue', aggregation: 'sum', label: 'Total revenue' });
  ok('addMetric survives', kpi.ops.length === 1 && kpi.dropped.length === 0, JSON.stringify(kpi.dropped));
  ok('addMetric normalises to the dataset id and defaults to page 0',
     kpi.ops[0].datasetId === SALES && kpi.ops[0].pageIndex === 0 && kpi.ops[0].label === 'Total revenue');
  const kpiNoLabel = one({ op: 'addMetric', dataset: 'Sales', column: 'revenue', aggregation: 'avg' });
  ok('addMetric names itself when the label is missing', kpiNoLabel.ops[0].label === 'avg of revenue');
  // The same rule a planned metric gets: sanitizeCard checks a metric card's
  // SHAPE but never that the column is numeric, so `avg` of text would build a
  // tile that renders "—" forever.
  const kpiText = one({ op: 'addMetric', dataset: 'Sales', column: 'region', aggregation: 'avg' });
  ok('addMetric refuses a numeric aggregation over a text column',
     kpiText.ops.length === 0 && /number column/.test(kpiText.dropped[0].message), JSON.stringify(kpiText.dropped));
  const kpiCount = one({ op: 'addMetric', dataset: 'Sales', column: 'region', aggregation: 'count' });
  ok('…but count over text is legitimate and survives', kpiCount.ops.length === 1, JSON.stringify(kpiCount.dropped));
  const kpiBadAgg = one({ op: 'addMetric', dataset: 'Sales', column: 'revenue', aggregation: 'median' });
  ok('addMetric refuses an aggregation off the whitelist', kpiBadAgg.ops.length === 0);
  const kpiBadCol = one({ op: 'addMetric', dataset: 'Sales', column: 'nope', aggregation: 'sum' });
  ok('addMetric refuses a column the dataset does not have', kpiBadCol.ops.length === 0);

  const rep = one({ op: 'replaceTileEncoding', tile: 'Revenue by region', chartType: 'line',
    encoding: enc('region', 'cost', 'avg') });
  ok('replaceTileEncoding survives and resolves to the cardId',
     rep.ops.length === 1 && rep.ops[0].cardId === 'card-rev' && rep.ops[0].chartType === 'line');
  const partial = one({ op: 'replaceTileEncoding', tile: 'card-cost', chartType: 'area' });
  ok('replaceTileEncoding may change only the chart type',
     partial.ops.length === 1 && partial.ops[0].encoding === undefined);

  const rm = one({ op: 'removeTile', tile: 'Notes' });
  ok('removeTile survives on a text tile', rm.ops.length === 1 && rm.ops[0].cardId === 'card-note');

  const top = one({ op: 'moveTile', tile: 'Cost over time', position: 'top' });
  ok('moveTile to top normalises', top.ops.length === 1
     && top.ops[0].position === 'top' && top.ops[0].anchorCardId === undefined);
  const before = one({ op: 'moveTile', tile: 'Cost over time', position: { before: 'Revenue by region' } });
  ok('moveTile before an anchor carries the anchor cardId',
     before.ops[0].position === 'before' && before.ops[0].anchorCardId === 'card-rev');

  const ctrl = one({ op: 'addControl', kind: 'dropdown', datasetId: SALES, column: 'region' });
  ok('addControl survives and defaults its label to the column',
     ctrl.ops.length === 1 && ctrl.ops[0].label === 'region' && ctrl.ops[0].kind === 'dropdown');
  ok('addControl carries the three fields sanitizeCard requires',
     ctrl.ops[0].datasetId === SALES && ctrl.ops[0].column === 'region' && ctrl.ops[0].pageIndex === 0);

  const ren = one({ op: 'renamePage', page: 2, name: 'Details' });
  ok('renamePage turns a 1-based page number into a 0-based index',
     ren.ops.length === 1 && ren.ops[0].pageIndex === 1 && ren.ops[0].name === 'Details');
  const renByName = one({ op: 'renamePage', page: 'Overview', name: 'Summary' });
  ok('renamePage also accepts a page NAME', renByName.ops[0].pageIndex === 0);

  const page = one({ op: 'addPage', name: 'Q3' });
  ok('addPage survives', page.ops.length === 1 && page.ops[0].name === 'Q3');
  const title = one({ op: 'setTitle', name: 'Sales review' });
  ok('setTitle survives', title.ops.length === 1 && title.ops[0].name === 'Sales review');
}

// ── §2 The resolution ladder ───────────────────────────────────────────────
function checkResolution(): void {
  const rungs: [string, string, string][] = [
    ['exact cardId', 'card-rev', 'card-rev'],
    ['exact title', 'Revenue by region', 'card-rev'],
    ['normalized title', '  revenue   BY Region ', 'card-rev'],
    ['token subset', 'the cost graph', 'card-cost'],
  ];
  for (const [label, query, want] of rungs) {
    const m: any = dd.resolveTile(ctx, query);
    ok('resolveTile rung: ' + label, m.tile !== null && m.tile.cardId === want, JSON.stringify(m));
  }

  // The token rung crosses tile TYPES, and that is deliberate: "the revenue
  // chart" matches both the chart and the "Total revenue" metric, so it is
  // ambiguous and refused. A model that meant one of them must say which.
  const crossType: any = dd.resolveTile(ctx, 'the revenue chart');
  ok('a token query matching a chart AND a metric is ambiguous',
     crossType.tile === null && crossType.reason === 'ambiguous');

  const amb: any = dd.resolveTile(twinCtx, 'revenue');
  ok('an AMBIGUOUS title resolves to nothing', amb.tile === null && amb.reason === 'ambiguous');
  const ambOp = one({ op: 'removeTile', tile: 'revenue' }, twinCtx);
  ok('…and the op is dropped rather than guessed',
     ambOp.ops.length === 0 && ambOp.dropped.length === 1 && ambOp.dropped[0].kind === 'tile');
  ok('…with a message naming the ambiguous reference',
     ambOp.dropped[0].message.includes('"revenue"') && ambOp.dropped[0].message.includes('more than one'),
     ambOp.dropped[0].message);

  // Rung 2 must win before rung 4 can tie: the exact title is unique even
  // though the token subset matches both tiles.
  const exact: any = dd.resolveTile(twinCtx, 'Revenue by region');
  ok('an exact title beats an ambiguous token subset', exact.tile !== null && exact.tile.cardId === 'a');

  const none: any = dd.resolveTile(ctx, 'Profit by quarter');
  ok('an unknown title resolves to nothing', none.tile === null && none.reason === 'none');
  const empty: any = dd.resolveTile(ctx, 42);
  ok('a non-string reference resolves to nothing', empty.tile === null && empty.reason === 'empty');
}

// ── §3 Refusals — one per rule, each reported and each surviving ───────────
function checkRefusals(): void {
  const cases: [string, unknown, string, string][] = [
    ['an unknown dataset', { op: 'addTile', dataset: 'Nope', chartType: 'bar', encoding: enc('region', 'revenue') },
      'dataset', '"Nope"'],
    ['an unknown chart type', { op: 'addTile', datasetId: SALES, chartType: 'sunburst', encoding: enc('region', 'revenue') },
      'chartType', '"sunburst"'],
    ['an unknown category column', { op: 'addTile', datasetId: SALES, chartType: 'bar', encoding: enc('nosuch', 'revenue') },
      'encoding', '"nosuch"'],
    ['an unknown measure column', { op: 'addTile', datasetId: SALES, chartType: 'bar', encoding: enc('region', 'ghost') },
      'encoding', '"ghost"'],
    ['sum over a TEXT column', { op: 'addTile', datasetId: SALES, chartType: 'bar', encoding: enc('region', 'code') },
      'encoding', '"code"'],
    ['an unknown op', { op: 'reticulate', tile: 'Notes' }, 'op', '"reticulate"'],
    ['an unknown tile', { op: 'removeTile', tile: 'Profit' }, 'tile', '"Profit"'],
    ['a bad control kind', { op: 'addControl', kind: 'slider', datasetId: SALES, column: 'region' },
      'control', '"slider"'],
    ['a control on an unknown column', { op: 'addControl', kind: 'multi', datasetId: SALES, column: 'ghost' },
      'control', '"ghost"'],
    ['renamePage on an unknown page', { op: 'renamePage', page: 'Nope', name: 'X' }, 'page', '"Nope"'],
    ['renamePage with no new name', { op: 'renamePage', page: 1, name: '   ' }, 'name', 'name'],
    ['addPage with no name', { op: 'addPage' }, 'name', 'name'],
    ['setTitle with no name', { op: 'setTitle', name: 7 }, 'name', 'name'],
    ['a non-object op', 'just a string', 'op', 'not an object'],
    ['a wrong-typed chart type', { op: 'addTile', datasetId: SALES, chartType: 5, encoding: enc('region', 'revenue') },
      'chartType', '""'],
    ['a move with an unknown position', { op: 'moveTile', tile: 'Notes', position: 'sideways' },
      'position', '"sideways"'],
    ['a move to an unknown anchor', { op: 'moveTile', tile: 'Notes', position: { after: 'Profit' } },
      'tile', '"Profit"'],
  ];
  for (const [label, raw, kind, needle] of cases) {
    const out = one(raw);
    ok('dropped: ' + label,
       out.ops.length === 0 && out.dropped.length >= 1 && out.dropped[0].kind === kind,
       JSON.stringify(out.dropped));
    ok('…and the message names the offender (' + label + ')',
       out.dropped.length >= 1 && out.dropped[0].message.includes(needle),
       out.dropped[0]?.message);
    ok('…and `where` points at the op (' + label + ')',
       out.dropped.length >= 1 && out.dropped[0].where === 'ops[0]');
  }

  // `count` is the one aggregation legal over a text column — the same rule
  // validatePlan applies, for the same reason (it counts non-empty cells).
  const counted = one({ op: 'addTile', datasetId: SALES, chartType: 'bar', encoding: enc('region', 'code', 'count') });
  ok('count over a text column is ALLOWED', counted.ops.length === 1 && counted.dropped.length === 0,
     JSON.stringify(counted.dropped));

  // A non-visual tile has no encoding to replace.
  const onMetric = one({ op: 'replaceTileEncoding', tile: 'Total revenue', encoding: enc('region', 'revenue') });
  ok('replaceTileEncoding on a METRIC tile is dropped',
     onMetric.ops.length === 0 && onMetric.dropped[0].kind === 'tile');
  ok('…with a message saying it is not a chart',
     onMetric.dropped[0].message.includes('metric tile'), onMetric.dropped[0].message);

  // Geometry belongs to the app.
  for (const geo of [{ x: 0 }, { y: 3 }, { w: 6 }, { h: 6 }, { layout: { x: 0, y: 0, w: 6, h: 6 } }]) {
    const moved = one({ op: 'moveTile', tile: 'Notes', position: 'top', ...geo });
    ok('moveTile carrying ' + Object.keys(geo)[0] + ' is refused',
       moved.ops.length === 0 && moved.dropped[0].kind === 'layout', moved.dropped[0]?.message);
  }

  // A filter on a missing column loses the FILTER, not the op.
  const badFilter = one({ op: 'addTile', datasetId: SALES, chartType: 'bar', encoding: enc('region', 'revenue'),
    filters: [{ type: 'filter', column: 'ghost', op: '=', value: 1 }] });
  ok('a filter on a missing column is dropped, the tile is kept',
     badFilter.ops.length === 1 && badFilter.ops[0].filters.length === 0
     && badFilter.dropped.length === 1 && badFilter.dropped[0].kind === 'filter',
     JSON.stringify(badFilter.dropped));
}

// ── §4 Blast radius — a bad op does not take its siblings ──────────────────
function checkBlastRadius(): void {
  const out = dd.validateDelta({ ops: [
    { op: 'setTitle', name: 'Good one' },
    { op: 'addTile', dataset: 'Nope', chartType: 'bar', encoding: enc('region', 'revenue') },
    { op: 'removeTile', tile: 'Notes' },
  ] }, ctx);
  ok('the two good ops survive a bad sibling', out.ops.length === 2
     && out.ops[0].op === 'setTitle' && out.ops[1].op === 'removeTile', JSON.stringify(out.ops));
  ok('the bad sibling is reported at its own index',
     out.dropped.length === 1 && out.dropped[0].where === 'ops[1]');
}

// ── §5 Garbage in ──────────────────────────────────────────────────────────
function checkGarbage(): void {
  const cases: [string, unknown][] = [
    ['null envelope', null],
    ['undefined envelope', undefined],
    ['an array', [1, 2, 3]],
    ['a string', 'not a delta'],
    ['a number', 7],
    ['ops is a number', { ops: 7 }],
    ['ops holds nulls', { ops: [null, undefined, [], 0] }],
    ['an op whose encoding is a string', { ops: [{ op: 'addTile', datasetId: SALES, chartType: 'bar', encoding: 'nope' }] }],
    ['an op whose position is an array', { ops: [{ op: 'moveTile', tile: 'Notes', position: [1, 2] }] }],
    ['deeply wrong types', { ops: [{ op: { nested: true }, tile: { also: 'nested' } }] }],
  ];
  for (const [label, raw] of cases) {
    let threw = false;
    let out: any = null;
    try { out = dd.validateDelta(raw, ctx); } catch { threw = true; }
    ok('validateDelta never throws on ' + label, !threw);
    ok('…and still yields a well-formed result on ' + label,
       !threw && Array.isArray(out.ops) && Array.isArray(out.dropped));
    ok('…and applies no edit on ' + label, !threw && out.ops.length === 0);
  }

  // An empty context is the "brand new dashboard" case: nothing resolves, and
  // nothing throws trying.
  const bare: DeltaContext = { pages: [], tiles: [], datasets: [] };
  let threw = false;
  let out: any = null;
  try { out = dd.validateDelta({ ops: [{ op: 'removeTile', tile: 'anything' }, { op: 'addPage', name: 'P' }] }, bare); }
  catch { threw = true; }
  ok('an EMPTY context never throws', !threw);
  ok('…drops what it cannot resolve and keeps what needs no context',
     !threw && out.ops.length === 1 && out.ops[0].op === 'addPage' && out.dropped.length === 1);
}

// ── §6 Determinism ─────────────────────────────────────────────────────────
function checkDeterminism(): void {
  const envelope = { ops: [
    { op: 'addTile', dataset: 'Sales', chartType: 'bar', encoding: enc('region', 'revenue'),
      filters: [{ type: 'filter', column: 'ghost', op: '=', value: 1 }] },
    { op: 'moveTile', tile: 'the cost chart', position: { after: 'Revenue by region' } },
    { op: 'addTile', dataset: 'Nope', chartType: 'spiral', encoding: enc('x', 'y') },
    { op: 'addControl', controlKind: 'date_range', dataset: 'Headcount', column: 'team', label: 'Team' },
    { op: 'renamePage', pageIndex: 0, name: 'Summary' },
  ] };
  const a = JSON.stringify(dd.validateDelta(envelope, ctx));
  const b = JSON.stringify(dd.validateDelta(JSON.parse(JSON.stringify(envelope)), ctx));
  ok('the same envelope validates byte-identically twice', a === b);
  const parsed = JSON.parse(a);
  ok('…and that envelope keeps exactly the four justifiable ops',
     parsed.ops.length === 4, a);
  ok('…resolving "the cost chart" through the token rung',
     parsed.ops[1].cardId === 'card-cost' && parsed.ops[1].anchorCardId === 'card-rev');
}

checkHappyPath();
checkResolution();
checkRefusals();
checkBlastRadius();
checkGarbage();
checkDeterminism();

if (failureCount()) {
  console.error('\n' + failureCount() + ' dashboard-delta check(s) FAILED');
  process.exit(1);
}
console.log('\nAll dashboard-delta checks passed.');
