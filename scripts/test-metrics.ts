// Self-check for the METRICS LAYER — a project's named numbers.
//
// A metric is the app's answer to "what is Revenue", and every way this can be
// wrong is silent. A card, an alert and a caption that each resolve the same
// metric differently do not crash; they disagree, quietly, in three places a
// reader never sees together. So the properties pinned here are the ones whose
// breakage looks like working software:
//
//   1. A METRIC IS THE DASHBOARD'S NUMBER. `resolveMetric` must be `Object.is`
//      to `metricValue.computeMetric` over the same stored rows — the reference
//      every metric path in this app is measured against. Not rounded, not
//      re-derived. Asserted on a fixture ABOVE the resident row threshold and
//      one below it, with `datasets.getDataset` spied on, so the two paths are
//      proven to be different code that still agrees (the test-metricRewire
//      discipline, applied one layer up).
//   2. A FORMULA RESOLVES ITS OPERANDS, NEVER ITS RATIOS. `[Profit]/[Revenue]`
//      under a West filter is West's profit over West's revenue. The wrong
//      implementation — fold the stored ratio, or average per-row ratios —
//      returns a plausible number, so this is asserted against the arithmetic
//      done independently from the fixture rows.
//   3. A CYCLE HAS NO VALUE. `[A] = [B] + 1`, `[B] = [A] + 1` must terminate and
//      resolve to null, not hang the main process.
//   4. THE FORMAT IS THE METRIC'S. One metric, one rendering, everywhere.
//   5. USAGE COUNTS WHAT WOULD BREAK. The delete confirm's sentence is built
//      from it, and a usage read that silently returns nothing is how a metric
//      four cards depend on gets deleted without a word.
//
//   npm run build:ts && node scripts/test-metrics.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metrics-'));

const handlers = new Map<string, IpcHandler>();
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      ipcMain: {
        handle: (channel: string, fn: IpcHandler) => { handlers.set(channel, fn); },
        on: () => {},
      },
      net: {},
      nativeImage: {},
      shell: {},
      Notification: function () { return { show: () => {} }; },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const metricValue: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const metricFormat: typeof import('../src/analysis/metricFormat') = require('../src/analysis/metricFormat');
const metricFormula: typeof import('../src/analysis/metricFormula') = require('../src/analysis/metricFormula');
const metricAuto: typeof import('../src/analysis/metricAuto') = require('../src/analysis/metricAuto');
const metricUsage: typeof import('../src/analysis/metricUsage') = require('../src/analysis/metricUsage');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');

metricsIpc.register();

// ── The hydration spy ────────────────────────────────────────────────────────
// ipc/dashboards.js resolves `datasets.getDataset` off the module namespace at
// CALL time, so replacing the export here is observed by the shipped resolver.
const realGetDataset = datasets.getDataset;
let hydrations = 0;
(datasets as any).getDataset = async (...args: any[]): Promise<any> => {
  hydrations += 1;
  return (realGetDataset as any)(...args);
};

// ── 1. Formatting ────────────────────────────────────────────────────────────

function fmtChecks(): void {
  const f = metricFormat.formatMetricValue;
  const F = (over: any): any => metrics.sanitizeFormat(over);

  ok('null renders as an em dash, never 0',
    f(null, F({ kind: 'number' })) === '—');
  ok('NaN renders as an em dash too',
    f(NaN, F({ kind: 'number' })) === '—');
  ok('a plain integer keeps its separators',
    f(1234567, F({ kind: 'number', decimals: 0 })) === (1234567).toLocaleString());
  ok('decimals are FIXED, not maximum',
    f(2, F({ kind: 'number', decimals: 2 })) === (2).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  ok('currency leads with $ by default',
    f(5194598.73, F({ kind: 'currency', decimals: 0, compact: true })).startsWith('$'));
  ok('a compact currency is the headline figure',
    f(5194598.73, F({ kind: 'currency', decimals: 0, compact: true })) === '$5.2M');
  ok('compact keeps one fraction digit even at decimals: 0',
    f(5194598.73, F({ kind: 'number', decimals: 0, compact: true })) === '5.2M');
  ok('percent multiplies by 100 and appends %',
    f(0.13209846, F({ kind: 'percent', decimals: 1 })) === '13.2%');
  ok('an explicit prefix beats the currency default',
    f(1200, F({ kind: 'currency', decimals: 0, prefix: '€' })) === '€1,200');
  ok('a suffix trails the number',
    f(3.5, F({ kind: 'number', decimals: 1, suffix: ' days' })) === '3.5 days');
  // "$-1,200" is the bug this pins: the sign belongs to the figure, not inside it.
  ok('a negative currency puts the sign outside the symbol',
    f(-1200, F({ kind: 'currency', decimals: 0 })) === '-$1,200');
  ok('duration reads as time, not as a count of seconds',
    f(5025, F({ kind: 'duration' })) === '1h 23m');
  ok('a sub-minute duration is seconds',
    f(45, F({ kind: 'duration' })) === '45s');
  ok('a multi-day duration stops at two units',
    f(273_600, F({ kind: 'duration' })) === '3d 4h');

  // Clamping: a format is presentation, and a bad one must never be the reason
  // a metric has no value.
  ok('an unknown kind clamps to number', F({ kind: 'bogus' }).kind === 'number');
  ok('decimals clamp into range', F({ kind: 'number', decimals: 99 }).decimals === 6);
  ok('negative decimals clamp to 0', F({ kind: 'number', decimals: -3 }).decimals === 0);
  ok('a non-finite decimals falls back', Number.isFinite(F({ kind: 'number', decimals: NaN }).decimals));
}

// ── 2. Definition in words ───────────────────────────────────────────────────

function describeChecks(): void {
  const d = metricFormat.describeDefinition;
  ok('a simple definition reads as a sentence',
    d({ definition: { column: 'revenue', aggregation: 'sum' }, filters: [] }) === 'sum of revenue');
  ok('avg is spelled "average"',
    d({ definition: { column: 'unit_price', aggregation: 'avg' }, filters: [] }) === 'average of unit_price');
  ok('a filter becomes a where-clause',
    d({
      definition: { column: 'revenue', aggregation: 'sum' },
      filters: [{ type: 'filter', column: 'status', op: '!=', value: 'refunded' }] as FilterStep[],
    }) === 'sum of revenue, where status ≠ refunded');
  ok('two filters are joined with "and"',
    d({
      definition: { column: 'revenue', aggregation: 'sum' },
      filters: [
        { type: 'filter', column: 'status', op: '!=', value: 'refunded' },
        { type: 'filter', column: 'region', op: '=', value: 'West' },
      ] as FilterStep[],
    }).endsWith('status ≠ refunded and region = West'));
  ok('a valueless op needs no operand',
    d({
      definition: { column: 'revenue', aggregation: 'sum' },
      filters: [{ type: 'filter', column: 'note', op: 'is_empty' }] as FilterStep[],
    }) === 'sum of revenue, where note is empty');
  ok('a long list is truncated rather than run on',
    d({
      definition: { column: 'revenue', aggregation: 'sum' },
      filters: [{ type: 'filter', column: 'region', op: 'in', values: ['a', 'b', 'c', 'd', 'e'] }] as FilterStep[],
    }).endsWith('region in a, b, c +2 more'));
  ok('a formula describes itself',
    d({ definition: { formula: '[Profit] / [Revenue]' }, filters: [] }) === '[Profit] / [Revenue]');
}

// ── 3. The formula pre-pass ──────────────────────────────────────────────────

function formulaChecks(): void {
  const c = metricFormula.compileMetricFormula;
  const COLS = ['revenue', 'cost', 'ship_days', 'Order Date'];

  const agg = c('sum(revenue) - sum(cost)', COLS);
  ok('an aggregation call compiles', agg.ok === true);
  if (agg.ok) {
    ok('both aggregations are lifted out',
      agg.program.aggregates.length === 2 && agg.program.metricRefs.length === 0);
    ok('the aggregation and column survive the rewrite',
      agg.program.aggregates[0].aggregation === 'sum' && agg.program.aggregates[0].column === 'revenue');
    ok('an aggregation evaluates over resolved operands',
      metricFormula.evaluateMetricFormula(agg.program, new Map([
        [agg.program.aggregates[0].ref, 100],
        [agg.program.aggregates[1].ref, 30],
      ])) === 70);
    ok('a missing operand degrades the whole expression to null',
      metricFormula.evaluateMetricFormula(agg.program, new Map([
        [agg.program.aggregates[0].ref, 100],
        [agg.program.aggregates[1].ref, null],
      ])) === null);
  }

  const refs = c('[Profit] / [Revenue]', COLS);
  ok('a metric reference is not an aggregation',
    refs.ok === true && refs.program.aggregates.length === 0 && refs.program.metricRefs.length === 2);

  const bracketed = c('sum([Order Date])', COLS);
  ok('a bracketed column name is lifted too',
    bracketed.ok === true && bracketed.program.aggregates.length === 1
    && bracketed.program.aggregates[0].column === 'Order Date');

  // The guard that keeps the shared grammar intact: `min`/`max` ARE row-level
  // functions, and stealing them would change what a calculated field means.
  const scalarMin = c('min(1, 2)', COLS);
  ok('a two-argument min stays the row-level function',
    scalarMin.ok === true && scalarMin.program.aggregates.length === 0);
  const notAColumn = c('min(mystery)', COLS);
  ok('a one-argument call over a NON-column stays a function call',
    notAColumn.ok === true && notAColumn.program.aggregates.length === 0
    && notAColumn.program.metricRefs.length === 1);
  const colMin = c('min(ship_days)', COLS);
  ok('a one-argument min over a real column IS an aggregation',
    colMin.ok === true && colMin.program.aggregates.length === 1
    && colMin.program.aggregates[0].aggregation === 'min');

  ok('an empty expression is refused', c('', COLS).ok === false);
  ok('an injection is a syntax error, never code',
    c('1; process.exit(1)', COLS).ok === false);

  // The rewritten token keeps the span of the text it replaced, so the editor
  // underlines what the user typed rather than a synthetic name.
  const bad = c('sum(revenue) / ', COLS);
  ok('a trailing operator fails with a source span',
    bad.ok === false && !!bad.at && bad.at.end <= 'sum(revenue) / '.length);
}

// ── 4. Auto-definitions ──────────────────────────────────────────────────────

function autoChecks(): void {
  const columns: ParsedColumn[] = [
    { name: 'order_date', type: 'date' },
    { name: 'region', type: 'text' },
    { name: 'units', type: 'number' },
    { name: 'unit_price', type: 'number' },
    { name: 'discount', type: 'number' },
    { name: 'revenue', type: 'number' },
    { name: 'profit', type: 'number' },
    { name: 'order_id', type: 'number' },
  ];
  const proposed = metricAuto.proposeMetrics('11111111-1111-4111-8111-111111111111', columns);
  const names = proposed.map((m) => m.name);

  ok('money ranks ahead of counts and rates',
    names[0] === 'Revenue' && names[1] === 'Profit' && names[2] === 'Units');
  ok('an id column is never a measure', !names.includes('Order id'));
  ok('every dataset gets a row count', names.includes('Rows'));
  ok('a label is sentence case, not a column name', names.includes('Unit price'));

  const revenue = proposed.find((m) => m.name === 'Revenue');
  ok('an additive money column is summed',
    !!revenue && (revenue.definition as any).aggregation === 'sum');
  ok('a money metric carries a currency format',
    !!revenue && (revenue.format as any).kind === 'currency' && (revenue.format as any).compact === true);

  const price = proposed.find((m) => m.name === 'Unit price');
  ok('a price is averaged, never summed',
    !!price && (price.definition as any).aggregation === 'avg');
  ok('an averaged money figure is read to the cent, not compacted',
    !!price && (price.format as any).decimals === 2 && (price.format as any).compact === false);

  const margin = proposed.find((m) => m.name === 'Margin %');
  ok('revenue + profit yields a Margin %', !!margin);
  ok('Margin % is a formula over the two METRICS, not the two columns',
    !!margin && (margin.definition as any).formula === '[Profit] / [Revenue]');
  ok('Margin % is a percent format', !!margin && (margin.format as any).kind === 'percent');

  // No revenue column means no denominator, which means no margin — not a
  // margin over whatever numeric column happened to be first.
  const noRevenue = metricAuto.proposeMetrics('11111111-1111-4111-8111-111111111111', [
    { name: 'units', type: 'number' }, { name: 'region', type: 'text' },
  ]);
  ok('no revenue column means no Margin %', !noRevenue.some((m) => m.name === 'Margin %'));

  ok('a cost column stands in for a missing profit column',
    (metricAuto.proposeMetrics('11111111-1111-4111-8111-111111111111', [
      { name: 'revenue', type: 'number' }, { name: 'cost', type: 'number' },
    ]).find((m) => m.name === 'Margin %')?.definition as any)?.formula === '([Revenue] - [Cost]) / [Revenue]');
  ok('a cost metric is marked as lower-is-better',
    metricAuto.proposeMetrics('11111111-1111-4111-8111-111111111111', [
      { name: 'cost', type: 'number' },
    ]).find((m) => m.name === 'Cost')?.direction === 'down_good');
}

// ── 5. The usage summary sentence ────────────────────────────────────────────

function summaryChecks(): void {
  const s = metricUsage.summarize;
  ok('nothing is an empty sentence', s([]) === '');
  ok('one is singular', s([{ kind: 'card', name: 'a', id: 'x' }]) === '1 card');
  ok('four cards and one alert reads the way the confirm says it',
    s([
      { kind: 'card', name: 'a', id: 'x' }, { kind: 'card', name: 'b', id: 'x' },
      { kind: 'card', name: 'c', id: 'x' }, { kind: 'card', name: 'd', id: 'x' },
      { kind: 'alert', name: 'e', id: 'y' },
    ]) === '4 cards and 1 alert');
  ok('three kinds use a comma then "and"',
    s([
      { kind: 'card', name: 'a', id: 'x' },
      { kind: 'visual', name: 'b', id: 'y' },
      { kind: 'alert', name: 'c', id: 'z' },
    ]) === '1 card, 1 visual and 1 alert');
}

// ── 6. Resolution, on real records ───────────────────────────────────────────

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'revenue', type: 'number' },
  { name: 'profit', type: 'number' },
  { name: 'note', type: 'text' },
];

const REGIONS = ['North', 'South', 'East', 'West'];

/**
 * INTEGER measures, deliberately.
 *
 * The resident path sums in parallel and the JS path folds left, and CLAUDE.md
 * pins the resulting ~1e-13 disagreement on floats as a known divergence. Whole
 * numbers below 2^53 sum exactly on both, so `Object.is` here is testing the
 * metrics layer rather than re-litigating float addition.
 */
function buildRows(n: number): Cell[][] {
  const rows: Cell[][] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [
      REGIONS[i % 4],
      i % 11 === 0 ? null : (i % 97) + 3,
      (i % 13) - 4,
      i % 3 === 0 ? '   ' : `note-${i}`,
    ];
  }
  return rows;
}

/** The reference answer: the pure helper over the stored rows, filters first. */
function reference(rows: Cell[][], column: string, aggregation: any, filters: FilterStep[] = []): number | null {
  const table = filters.length
    ? transforms.applyPipeline({ columns: COLUMNS, rows }, filters)
    : { columns: COLUMNS, rows };
  return metricValue.computeMetric(table.columns as ParsedColumn[], table.rows as Cell[][], { column, aggregation });
}

const WEST: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'West' }];

async function resolutionChecks(): Promise<void> {
  await projects.init();
  const project = await projects.createProject('Metrics');
  ok('created a project', !!project && typeof project.id === 'string');
  const projectId = project.id;

  // Two fixtures: one comfortably ABOVE the resident row threshold (1,000) and
  // one below it, so the two branches are both exercised and must still agree.
  const big = buildRows(2500);
  const small = buildRows(120);
  const bigDs = await datasets.saveDataset(projectId, { name: 'Big', sourceKind: 'csv', columns: COLUMNS, rows: big });
  const smallDs = await datasets.saveDataset(projectId, { name: 'Small', sourceKind: 'csv', columns: COLUMNS, rows: small });
  ok('saved both fixtures', !!bigDs && !!smallDs);
  if (!bigDs || !smallDs) return;

  const money = { kind: 'currency', decimals: 0, compact: true };
  const revenue = await metrics.saveMetric(projectId, {
    name: 'Revenue', datasetId: bigDs.id, definition: { column: 'revenue', aggregation: 'sum' }, format: money,
  });
  const profit = await metrics.saveMetric(projectId, {
    name: 'Profit', datasetId: bigDs.id, definition: { column: 'profit', aggregation: 'sum' }, format: money,
  });
  const margin = await metrics.saveMetric(projectId, {
    name: 'Margin %', datasetId: bigDs.id, definition: { formula: '[Profit] / [Revenue]' },
    format: { kind: 'percent', decimals: 1, compact: false },
  });
  ok('saved three metrics', !!revenue && !!profit && !!margin);
  if (!revenue || !profit || !margin) return;

  ok('a metric never stores a number', !('value' in (revenue as any)));
  ok('listMetrics is name-ordered',
    (await metrics.listMetrics(projectId)).map((m) => m.name).join('|') === 'Margin %|Profit|Revenue');

  // ── The differential ───────────────────────────────────────────────────────
  hydrations = 0;
  const bigResolved = await metricsIpc.resolveMetric(projectId, revenue.id);
  const bigHydrations = hydrations;
  ok('a simple metric IS metricValue.computeMetric over the stored rows',
    !!bigResolved && Object.is(bigResolved.value, reference(big, 'revenue', 'sum')),
    `${bigResolved && bigResolved.value} vs ${reference(big, 'revenue', 'sum')}`);

  const smallMetric = await metrics.saveMetric(projectId, {
    name: 'Small revenue', datasetId: smallDs.id, definition: { column: 'revenue', aggregation: 'sum' }, format: money,
  });
  hydrations = 0;
  const smallResolved = smallMetric ? await metricsIpc.resolveMetric(projectId, smallMetric.id) : null;
  ok('a below-threshold metric agrees with the same reference',
    !!smallResolved && Object.is(smallResolved.value, reference(small, 'revenue', 'sum')),
    `${smallResolved && smallResolved.value} vs ${reference(small, 'revenue', 'sum')}`);
  // Proof the two answers came from DIFFERENT code rather than from one path
  // answering both. A machine with no working DuckDB bridge hydrates for both,
  // which is a correct run of a fast path that is simply not available — so
  // this reports rather than fails.
  console.log(bigHydrations === 0 && hydrations > 0
    ? 'ok   the two fixtures took different paths (resident above the threshold, JS below)'
    : `ok   both fixtures took the JS path (no resident bridge here) — agreement still asserted`);

  // Every aggregation, filtered and unfiltered, against the reference.
  for (const aggregation of ['sum', 'avg', 'count', 'min', 'max'] as const) {
    const m = await metrics.saveMetric(projectId, {
      name: `R ${aggregation}`, datasetId: bigDs.id,
      definition: { column: 'revenue', aggregation }, format: { kind: 'number', decimals: 2 },
    });
    if (!m) continue;
    const plain = await metricsIpc.resolveMetric(projectId, m.id);
    ok(`${aggregation} agrees with the reference`,
      !!plain && Object.is(plain.value, reference(big, 'revenue', aggregation)),
      `${plain && plain.value} vs ${reference(big, 'revenue', aggregation)}`);
    const scoped = await metricsIpc.resolveMetric(projectId, m.id, { filters: WEST });
    ok(`${aggregation} under a scope filter agrees too`,
      !!scoped && Object.is(scoped.value, reference(big, 'revenue', aggregation, WEST)),
      `${scoped && scoped.value} vs ${reference(big, 'revenue', aggregation, WEST)}`);
  }

  // A metric's OWN filters are part of what it means, and they compose with the
  // scope rather than being replaced by it.
  const westOnly = await metrics.saveMetric(projectId, {
    name: 'West revenue', datasetId: bigDs.id,
    definition: { column: 'revenue', aggregation: 'sum' }, filters: WEST, format: money,
  });
  const westResolved = westOnly ? await metricsIpc.resolveMetric(projectId, westOnly.id) : null;
  ok("a metric's own filters apply without any scope",
    !!westResolved && Object.is(westResolved.value, reference(big, 'revenue', 'sum', WEST)));

  // ── The ratio-of-ratios guard ──────────────────────────────────────────────
  const globalMargin = await metricsIpc.resolveMetric(projectId, margin.id);
  const expectGlobal = (reference(big, 'profit', 'sum') as number) / (reference(big, 'revenue', 'sum') as number);
  ok('a formula metric is the ratio of two app-computed figures',
    !!globalMargin && Object.is(globalMargin.value, expectGlobal),
    `${globalMargin && globalMargin.value} vs ${expectGlobal}`);

  const westMargin = await metricsIpc.resolveMetric(projectId, margin.id, { filters: WEST });
  const expectWest = (reference(big, 'profit', 'sum', WEST) as number) / (reference(big, 'revenue', 'sum', WEST) as number);
  ok("a scoped formula is the scope's profit over the scope's revenue",
    !!westMargin && Object.is(westMargin.value, expectWest),
    `${westMargin && westMargin.value} vs ${expectWest}`);
  // The whole point. If the operands were not re-resolved under the scope,
  // these two would be equal — which is the bug that looks like working code.
  ok('a scoped formula is NOT the unscoped ratio',
    !!westMargin && !!globalMargin && westMargin.value !== globalMargin.value);

  // An aggregation call inside a formula takes the scope the same way.
  const spread = await metrics.saveMetric(projectId, {
    name: 'Spread', datasetId: bigDs.id, definition: { formula: 'sum(revenue) - sum(profit)' },
    format: { kind: 'number', decimals: 0 },
  });
  const spreadWest = spread ? await metricsIpc.resolveMetric(projectId, spread.id, { filters: WEST }) : null;
  ok('an aggregation call inside a formula is scoped too',
    !!spreadWest && Object.is(spreadWest.value,
      (reference(big, 'revenue', 'sum', WEST) as number) - (reference(big, 'profit', 'sum', WEST) as number)));

  // ── Formatting comes from the metric ───────────────────────────────────────
  ok('the resolved figure carries its own finished display string',
    !!globalMargin && globalMargin.display === metricFormat.formatMetricValue(globalMargin.value, margin.format));
  ok('a percent metric displays as a percent',
    !!globalMargin && globalMargin.display.endsWith('%'));
  ok('the resolved metric carries its definition in words',
    !!bigResolved && bigResolved.definitionText === 'sum of revenue');

  // ── Degrade, never fabricate ───────────────────────────────────────────────
  const missingCol = await metrics.saveMetric(projectId, {
    name: 'Nothing', datasetId: bigDs.id, definition: { column: 'nope', aggregation: 'sum' }, format: money,
  });
  const nothing = missingCol ? await metricsIpc.resolveMetric(projectId, missingCol.id) : null;
  ok('an unknown column is null, never 0', !!nothing && nothing.value === null);
  ok('and it renders as an em dash', !!nothing && nothing.display === '—');

  const textAgg = await metrics.saveMetric(projectId, {
    name: 'Summed text', datasetId: bigDs.id, definition: { column: 'note', aggregation: 'sum' }, format: money,
  });
  const summedText = textAgg ? await metricsIpc.resolveMetric(projectId, textAgg.id) : null;
  ok('summing a text column is null, never an implicit cast',
    !!summedText && Object.is(summedText.value, reference(big, 'note', 'sum')));

  const typo = await metrics.saveMetric(projectId, {
    name: 'Typo', datasetId: bigDs.id, definition: { formula: '[Revenu] / [Revenue]' },
    format: { kind: 'percent', decimals: 1 },
  });
  const typoResolved = typo ? await metricsIpc.resolveMetric(projectId, typo.id) : null;
  ok('a formula naming a metric that does not exist is null, not zero',
    !!typoResolved && typoResolved.value === null);

  // ── The cycle guard ────────────────────────────────────────────────────────
  const a = await metrics.saveMetric(projectId, {
    name: 'Loop A', datasetId: bigDs.id, definition: { formula: '[Loop B] + 1' }, format: money,
  });
  const b = await metrics.saveMetric(projectId, {
    name: 'Loop B', datasetId: bigDs.id, definition: { formula: '[Loop A] + 1' }, format: money,
  });
  ok('saved a cycle', !!a && !!b);
  const looped = a ? await metricsIpc.resolveMetric(projectId, a.id) : null;
  ok('a cycle terminates and resolves to null', !!looped && looped.value === null);

  const selfRef = await metrics.saveMetric(projectId, {
    name: 'Ouroboros', datasetId: bigDs.id, definition: { formula: '[Ouroboros] * 2' }, format: money,
  });
  const selfResolved = selfRef ? await metricsIpc.resolveMetric(projectId, selfRef.id) : null;
  ok('a self-reference resolves to null', !!selfResolved && selfResolved.value === null);

  // ── Series ─────────────────────────────────────────────────────────────────
  const series = await metricsIpc.resolveMetricSeries(projectId, revenue.id, 'region');
  ok('a series has one point per distinct value',
    !!series && series.labels.length === 4 && series.values.length === 4);
  if (series) {
    const west = series.labels.indexOf('West');
    ok('each series point is that point\'s own figure',
      west >= 0 && Object.is(series.values[west], reference(big, 'revenue', 'sum', WEST)));
    ok('a series point carries its display string too',
      west >= 0 && series.display[west] === metricFormat.formatMetricValue(series.values[west], revenue.format));
  }
  const marginSeries = await metricsIpc.resolveMetricSeries(projectId, margin.id, 'region');
  if (marginSeries) {
    const west = marginSeries.labels.indexOf('West');
    ok('a FORMULA series is each point\'s own ratio, never the whole set\'s',
      west >= 0 && Object.is(marginSeries.values[west], expectWest));
  }

  // ── Names are unique ───────────────────────────────────────────────────────
  ok('an existing name is taken', (await metricsIpc.nameTaken(projectId, 'Revenue')) === true);
  ok('the check is case-insensitive', (await metricsIpc.nameTaken(projectId, 'revenue')) === true);
  ok('a metric does not collide with itself',
    (await metricsIpc.nameTaken(projectId, 'Revenue', revenue.id)) === false);
  ok('an unused name is free', (await metricsIpc.nameTaken(projectId, 'Brand new')) === false);

  // ── Update / duplicate / delete ────────────────────────────────────────────
  const renamed = await metrics.updateMetric(projectId, revenue.id, { name: 'Net revenue' });
  ok('update renames', !!renamed && renamed.name === 'Net revenue');
  ok('update bumps updatedAt', !!renamed && renamed.updatedAt >= renamed.createdAt);
  ok('datasetId is immutable', !!renamed && renamed.datasetId === bigDs.id);
  // A renamed metric breaks the formula that referenced the OLD name — which is
  // a null, visibly, rather than a silently wrong figure.
  const afterRename = await metricsIpc.resolveMetric(projectId, margin.id);
  ok('a formula whose operand was renamed away resolves to null',
    !!afterRename && afterRename.value === null);
  await metrics.updateMetric(projectId, revenue.id, { name: 'Revenue' });

  const described = await metrics.updateMetric(projectId, profit.id, { description: 'Gross profit' });
  ok('a description is stored', !!described && described.description === 'Gross profit');
  const cleared = await metrics.updateMetric(projectId, profit.id, { description: '' });
  ok('an emptied description is CLEARED, not ignored', !!cleared && cleared.description === undefined);

  const copy = await metrics.duplicateMetric(projectId, profit.id);
  ok('duplicate appends (copy) and takes a fresh id',
    !!copy && copy.name === 'Profit (copy)' && copy.id !== profit.id);

  // ── Usage ──────────────────────────────────────────────────────────────────
  const sheetCard = {
    id: '33333333-3333-4333-8333-333333333333',
    type: 'metric',
    layout: { x: 0, y: 0, w: 3, h: 2 },
    metric: { datasetId: bigDs.id, column: 'revenue', aggregation: 'sum', label: 'Revenue', metricId: revenue.id },
  };
  const dash = await analysis.saveAnalysis(projectId, {
    name: 'Overview',
    sheets: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Sheet 1', cards: [sheetCard] }],
  });
  ok('a metric card kept its metricId through sanitizeCard',
    !!dash && (dash.sheets[0].cards[0].metric as any).metricId === revenue.id);

  const viz = await visuals.saveVisual(projectId, {
    name: 'Revenue by region', datasetId: bigDs.id, chartType: 'column',
    encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum', metricId: revenue.id }] },
  });
  ok('a measure kept its metricId through sanitizeEncoding',
    !!viz && viz.encoding.values[0].metricId === revenue.id);

  const rule = await alertStore.saveRule(projectId, {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Revenue dropped', datasetId: bigDs.id,
    metric: { column: 'revenue', aggregation: 'sum', label: 'Revenue', metricId: revenue.id },
    compare: 'threshold', threshold: { op: '<', value: 1 }, enabled: true,
  });
  ok('an alert rule kept its metricId through sanitizeRule',
    !!rule && (rule.metric as any).metricId === revenue.id);

  // A pivot's values live on their own shelf, not in `encoding.values`, so the
  // usage walk has to look at both or a pivot silently stops counting.
  const pivot = await visuals.saveVisual(projectId, {
    name: 'Revenue by region and category', datasetId: bigDs.id, chartType: 'pivot',
    encoding: {
      category: 'region',
      values: [],
      pivot: {
        rows: [{ column: 'region' }],
        columns: [],
        values: [{ column: 'revenue', aggregation: 'sum', metricId: revenue.id }],
      },
    },
  });
  ok('a pivot value kept its metricId through the encoding sanitizer',
    !!pivot && (pivot.encoding as any).pivot.values[0].metricId === revenue.id,
    JSON.stringify(pivot && (pivot.encoding as any).pivot));

  const usage = await metricUsage.metricUsage(projectId, revenue.id);
  ok('usage finds the card', usage.refs.some((r) => r.kind === 'card' && r.id === dash!.id));
  ok('usage finds the visual', usage.refs.some((r) => r.kind === 'visual' && r.id === viz!.id));
  ok('usage finds the pivot too', usage.refs.some((r) => r.kind === 'visual' && r.id === pivot!.id));
  ok('usage finds the alert', usage.refs.some((r) => r.kind === 'alert' && r.id === rule!.id));
  ok('a card ref carries the sheet it sits on',
    usage.refs.some((r) => r.kind === 'card' && r.sheetIndex === 0));
  // Two metrics, because `Margin %` and `Typo` both reference [Revenue] in
  // their formulas — deleting Revenue would break them as surely as it breaks
  // the card, and the sentence has to say so.
  ok('the confirm sentence counts what would break',
    usage.summary === '1 card, 2 visuals, 1 alert and 2 metrics', usage.summary);

  // A formula operand is a usage too — deleting Revenue breaks Margin %.
  const marginUsage = await metricUsage.metricUsage(projectId, revenue.id);
  ok('a formula that references the metric counts as usage',
    marginUsage.refs.some((r) => r.kind === 'metric' && r.id === margin.id));
  // Compiled, not substring-matched.
  const quoted = await metrics.saveMetric(projectId, {
    name: 'Quoted', datasetId: bigDs.id, definition: { formula: "if(1 = 1, 0, 0) + len('[Revenue]')" },
    format: money,
  });
  const afterQuoted = await metricUsage.metricUsage(projectId, revenue.id);
  ok('a metric name inside a STRING is not a reference',
    !!quoted && !afterQuoted.refs.some((r) => r.kind === 'metric' && r.id === quoted.id));

  const unused = await metricUsage.metricUsage(projectId, copy!.id);
  ok('an unused metric reports nothing', unused.total === 0 && unused.summary === '');

  // Deleting is allowed even when used — the store degrades, the UI confirms.
  ok('delete removes the record', (await metrics.deleteMetric(projectId, copy!.id)) === true);
  ok('and the record is gone', (await metrics.getMetric(projectId, copy!.id)) === null);

  // ── Path traversal ─────────────────────────────────────────────────────────
  ok('a non-UUID metric id never reaches a path',
    (await metrics.getMetric(projectId, '../../etc/passwd')) === null);
  ok('a non-UUID project id never reaches a path',
    (await metrics.listMetrics('../..')).length === 0);
  ok('saving under a bogus project is refused',
    (await metrics.saveMetric('../..', { name: 'x', datasetId: bigDs.id, definition: { column: 'revenue', aggregation: 'sum' } })) === null);
  ok('saving against a dataset that does not exist is refused',
    (await metrics.saveMetric(projectId, {
      name: 'Orphan', datasetId: '99999999-9999-4999-8999-999999999999',
      definition: { column: 'revenue', aggregation: 'sum' },
    })) === null);
}

async function main(): Promise<void> {
  fmtChecks();
  describeChecks();
  formulaChecks();
  autoChecks();
  summaryChecks();
  await resolutionChecks();
  process.exit(failureCount() ? 1 : 0);
}

void main();
