// End-to-end viz-filter self-check: wires the PURE bridge (src/vizData.ts) to the
// persisted Visual (src/visuals.ts) + the transform pipeline (src/transforms.ts)
// and asserts the three Week 8 guarantees:
//   1. A visual with a row filter (region = West) aggregates ONLY the filtered
//      rows to the correct per-category totals — East rows never contribute.
//   2. duplicateVisual yields an INDEPENDENT copy with a distinct id (editing the
//      copy leaves the source untouched).
//   3. overrides persist verbatim through save + reload from disk.
// Like test-visuals.ts, we stub the 'electron' module so userData points at a
// fresh temp dir, then exercise the REAL modules against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-vizfilter-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// Compiled siblings of the real modules.
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/projects') = require('../src/projects');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

const MISSING_UUID = '00000000-0000-0000-0000-000000000000';

// A tiny sales table spanning two regions. West sales: A = 10+5 = 15, B = 20.
// East sales: A = 100, B = 200. A region=West filter must exclude every East row.
const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'product', type: 'text' },
  { name: 'sales', type: 'number' },
];
const ROWS: Cell[][] = [
  ['West', 'A', 10],
  ['West', 'A', 5],
  ['East', 'A', 100],
  ['West', 'B', 20],
  ['East', 'B', 200],
];

async function main(): Promise<void> {
  await projects.init();
  await visuals.init();

  const proj = await projects.createProject('Viz-filter project');
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Sales',
    sourceKind: 'csv',
    columns: COLUMNS,
    rows: ROWS,
  });
  ok('created project + dataset', proj !== null && ds !== null);
  const dsId = ds !== null ? ds.id : '';

  const encoding = { category: 'product', values: [{ column: 'sales', aggregation: 'sum' as const }] };
  const filters = [{ type: 'filter' as const, column: 'region', op: '=' as const, value: 'West' }];

  // ── 1. filtered aggregation ────────────────────────────────────────────────
  const saved = await visuals.saveVisual(proj.id, {
    name: 'West sales by product',
    datasetId: dsId,
    chartType: 'column',
    encoding,
    filters,
  });
  ok('saveVisual persists the region=West filter', saved !== null
    && saved.filters.length === 1 && saved.filters[0].column === 'region' && saved.filters[0].value === 'West');

  // Reload from disk, then run the PURE bridge with the stored encoding + filters.
  const loaded = saved !== null ? await visuals.getVisual(proj.id, saved.id) : null;
  ok('visual reloads from disk', loaded !== null);

  const filteredRes = vizData.buildVizData(COLUMNS, ROWS, loaded!.encoding, loaded!.filters);
  const labels = filteredRes.data.labels;
  const seriesVals = filteredRes.data.series[0]?.values ?? [];
  const totalByProduct = new Map<string | number, number | null>();
  labels.forEach((lbl, i) => totalByProduct.set(lbl, seriesVals[i]));
  ok('filtered result has one series', filteredRes.data.series.length === 1);
  ok('filtered A total = 15 (10+5, East 100 excluded)', totalByProduct.get('A') === 15);
  ok('filtered B total = 20 (East 200 excluded)', totalByProduct.get('B') === 20);
  const grandTotal = seriesVals.reduce((s: number, v) => s + (typeof v === 'number' ? v : 0), 0);
  ok('filtered grand total = 35 (West only)', grandTotal === 35);

  // Sanity: WITHOUT the filter the same encoding sums every row (proves the
  // filter — not some other quirk — is what shrank the totals).
  const unfiltered = vizData.buildVizData(COLUMNS, ROWS, encoding);
  const unLabels = unfiltered.data.labels;
  const unVals = unfiltered.data.series[0]?.values ?? [];
  const unByProduct = new Map<string | number, number | null>();
  unLabels.forEach((lbl, i) => unByProduct.set(lbl, unVals[i]));
  ok('unfiltered A total = 115 (10+5+100)', unByProduct.get('A') === 115);
  ok('unfiltered B total = 220 (20+200)', unByProduct.get('B') === 220);

  // ── 2. duplicateVisual: independent copy, distinct id ──────────────────────
  const dup = saved !== null ? await visuals.duplicateVisual(proj.id, saved.id) : null;
  ok('duplicateVisual returns a copy', dup !== null);
  ok('copy has a distinct id', dup !== null && saved !== null && dup.id !== saved.id);
  ok('copy carries the same filter', dup !== null && dup.filters.length === 1 && dup.filters[0].value === 'West');
  // Mutating the copy must not touch the source.
  if (dup !== null) await visuals.updateVisual(proj.id, dup.id, { name: 'Changed', filters: [] });
  const srcAfter = saved !== null ? await visuals.getVisual(proj.id, saved.id) : null;
  const dupAfter = dup !== null ? await visuals.getVisual(proj.id, dup.id) : null;
  ok('editing the copy leaves the source filter intact',
    srcAfter !== null && srcAfter.filters.length === 1 && srcAfter.name === 'West sales by product');
  ok('the copy actually changed independently',
    dupAfter !== null && dupAfter.filters.length === 0 && dupAfter.name === 'Changed');
  ok('duplicateVisual of a missing uuid → null', (await visuals.duplicateVisual(proj.id, MISSING_UUID)) === null);

  // ── 3. overrides persist through save + reload ─────────────────────────────
  const overrides = { title: 'West sales', color: '#0a7', numberFormat: 'currency' as const, showLegend: true };
  const styled = await visuals.saveVisual(proj.id, {
    name: 'Styled', datasetId: dsId, chartType: 'column', encoding, overrides,
  });
  const styledReloaded = styled !== null ? await visuals.getVisual(proj.id, styled.id) : null;
  ok('overrides survive save + reload', styledReloaded !== null
    && styledReloaded.overrides.title === 'West sales'
    && styledReloaded.overrides.color === '#0a7'
    && styledReloaded.overrides.numberFormat === 'currency'
    && styledReloaded.overrides.showLegend === true);

  // ── 4. an `in` filter survives save + reload, and aggregates correctly ─────
  //
  // The round trip is the part worth pinning: `values` has to get through
  // sanitizeFilters, JSON on disk, and normalize() on load. A whitelist that
  // silently dropped it would leave an `in` step with no operand — which the
  // pipeline then SKIPS, so the chart would quietly show unfiltered totals
  // rather than failing.
  const inVisual = await visuals.saveVisual(proj.id, {
    name: 'A and B, West only',
    datasetId: dsId,
    chartType: 'column',
    encoding,
    filters: [{ type: 'filter', column: 'region', op: 'in', values: ['West', 'East'] }],
  });
  const inLoaded = inVisual !== null ? await visuals.getVisual(proj.id, inVisual.id) : null;
  ok('an `in` filter persists through save + reload', inLoaded !== null && inLoaded.filters.length === 1 && inLoaded.filters[0].op === 'in');
  ok('…carrying its values verbatim', JSON.stringify(inLoaded?.filters[0].values) === JSON.stringify(['West', 'East']));

  // Both regions listed → the same totals as no filter at all (115 / 220).
  const inRes = vizData.buildVizData(COLUMNS, ROWS, inLoaded!.encoding, inLoaded!.filters);
  const inByProduct = new Map<string | number, number | null>();
  inRes.data.labels.forEach((lbl, i) => inByProduct.set(lbl, inRes.data.series[0].values[i]));
  ok('`in` over both regions totals every row (A = 115)', inByProduct.get('A') === 115);
  ok('…and produces no warnings', inRes.warnings.length === 0);

  // One region listed → identical to the `=` filter tested in section 1.
  const oneRes = vizData.buildVizData(COLUMNS, ROWS, encoding, [
    { type: 'filter', column: 'region', op: 'in', values: ['West'] },
  ]);
  ok('a one-value `in` matches the `=` result exactly',
    JSON.stringify(oneRes.data) === JSON.stringify(filteredRes.data));

  const notRes = vizData.buildVizData(COLUMNS, ROWS, encoding, [
    { type: 'filter', column: 'region', op: 'not in', values: ['West'] },
  ]);
  const notByProduct = new Map<string | number, number | null>();
  notRes.data.labels.forEach((lbl, i) => notByProduct.set(lbl, notRes.data.series[0].values[i]));
  ok('`not in` gives the complement (A = 100, B = 200)', notByProduct.get('A') === 100 && notByProduct.get('B') === 200);

  // An empty list is skipped WITH a warning — the user sees why nothing changed.
  const emptyRes = vizData.buildVizData(COLUMNS, ROWS, encoding, [
    { type: 'filter', column: 'region', op: 'in', values: [] },
  ]);
  ok('an empty `in` leaves the chart unfiltered', emptyRes.data.series[0].values[0] === 115);
  ok('…and surfaces a warning rather than blanking it silently',
    emptyRes.warnings.length === 1 && emptyRes.warnings[0].includes('no values'));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' viz-filter check(s) FAILED'); process.exit(1); }
    console.log('\nAll viz-filter checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
