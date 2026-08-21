// Self-check for the Phase 2.5 rewire of `dashboard:metric` in src/ipc/dashboards.ts.
//
// The handler now asks src/residentQuery.ts to compute the metric straight off
// the dataset's Parquet file when the table is resident AND big enough to be
// worth the bridge handshake, and hydrates-and-folds otherwise. Two things have
// to be true for that to be a safe change, and this suite asserts both:
//
//   1. THE ANSWER NEVER CHANGES. Every assertion here is DIFFERENTIAL — the
//      value the SHIPPED handler returns is compared with `Object.is` against
//      the pure `metricValue.computeMetric` applied to the same stored rows
//      (with `transforms.applyPipeline` first when there are filters), which is
//      literally the code the handler ran before the rewire. A hand-written
//      expectation can agree with a bug in both paths; an equivalence assertion
//      cannot, and `Object.is` means `null` can never pass as `0`.
//   2. BOTH BRANCHES ARE ACTUALLY TAKEN. `datasets.getDataset` is spied on, so
//      "the resident path was used" is asserted as "the table was never
//      hydrated" rather than assumed. A fixture above the row threshold and one
//      below it therefore exercise different code and must still agree.
//
// The handler is invoked for real: `electron` is stubbed (as test-datasets.ts
// does for userData) so `ipcMain.handle` records its callbacks, `register()` is
// called, and the recorded `dashboard:metric` callback is what every assertion
// runs. No logic is copied out of the shipped file.
//
//   npm run build:ts && node scripts/test-metricRewire.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type MetricAggregation = import('../src/analysis/metricValue').MetricAggregation;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metric-rewire-'));

// ── The electron stub ────────────────────────────────────────────────────────
// `app.getPath` points every store at a throwaway userData dir (test-datasets.ts
// pattern); `ipcMain.handle` captures the real handlers so they can be invoked.
// The rest are inert placeholders for modules that merely destructure them at
// require time (analyze → net, localCliRun → nativeImage).
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
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const dashboardsStore: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const metricValue: typeof import('../src/analysis/metricValue') = require('../src/analysis/metricValue');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const dashboardsIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

dashboardsIpc.register();
const metricHandler = handlers.get('dashboard:metric');
const summaryHandler = handlers.get('dashboard:summary');


function fmt(v: number | null): string {
  return v === null ? 'null' : String(v);
}

// ── The hydration spy ────────────────────────────────────────────────────────
// ipc/dashboards.js resolves `datasets.getDataset` off the module namespace at
// CALL time, so replacing the export here is observed by the shipped handler.
// Counting the calls is how "the resident path was taken" is proven rather than
// asserted by hope.
const realGetDataset = datasets.getDataset;
let hydrations = 0;
(datasets as any).getDataset = async (...args: any[]): Promise<any> => {
  hydrations += 1;
  return (realGetDataset as any)(...args);
};
function resetSpy(): void { hydrations = 0; }

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Deliberately shaped to hit every semantic the metric path has to preserve:
//   region  a low-cardinality dimension to filter on
//   sales   the numeric measure — with nulls, negatives and fractions
//   note    text with '' AND whitespace-only cells, so `count` (non-empty cells)
//           cannot be confused with SQL's count (which counts both)
//   blank   an ALL-EMPTY column: count → 0, sum/avg/min/max → null (never 0)
//   code    a leading-zero id stored as TEXT: aggregating it must be null, and
//           must NEVER be an implicit VARCHAR→DOUBLE cast turning '0007' into 7

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'note', type: 'text' },
  { name: 'blank', type: 'text' },
  { name: 'code', type: 'text' },
];

function buildRows(n: number): Cell[][] {
  const rows: Cell[][] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [
      `region-${i % 4}`,
      i % 7 === 0 ? null : (i % 13) - 6 + i * 0.5,
      i % 3 === 0 ? '' : i % 3 === 1 ? '   ' : `note-${i}`,
      i % 2 === 0 ? '' : null,
      String(i % 1000).padStart(4, '0'),
    ];
  }
  return rows;
}

const AGGS: MetricAggregation[] = ['sum', 'avg', 'count', 'min', 'max'];

interface Fixture {
  id: string;
  projectId: string;
  label: string;
  columns: ParsedColumn[];
  rows: Cell[][];
}

/** Invoke the SHIPPED handler. */
async function viaIpc(
  f: Fixture,
  column: string,
  aggregation: string,
  filters?: unknown,
): Promise<{ ok: boolean; value?: number | null; error?: string }> {
  return (metricHandler as IpcHandler)(null, {
    projectId: f.projectId,
    datasetId: f.id,
    column,
    aggregation,
    filters,
  });
}

/**
 * The reference: EXACTLY what the handler did before the rewire — sanitize the
 * untrusted filters, applyPipeline them, then computeMetric. Run against the
 * rows as READ BACK from storage, so a value the round trip changed is compared
 * post-round-trip on both sides.
 */
function reference(f: Fixture, column: string, aggregation: string, filters?: unknown): number | null {
  const steps = dashboardsStore.sanitizeDashboardFilters(filters);
  const table = steps.length
    ? transforms.applyPipeline({ columns: f.columns, rows: f.rows }, steps)
    : { columns: f.columns, rows: f.rows };
  return metricValue.computeMetric(table.columns, table.rows, {
    column,
    aggregation: aggregation as MetricAggregation,
  });
}

/** Every aggregation over one column, handler vs reference. */
async function diff(label: string, f: Fixture, column: string, filters?: unknown): Promise<void> {
  for (const agg of AGGS) {
    const want = reference(f, column, agg, filters);
    const got = await viaIpc(f, column, agg, filters);
    ok(`${f.label}/${label}: ${agg}(${column}) → ok:true`, got.ok === true);
    ok(
      `${f.label}/${label}: ${agg}(${column}) === computeMetric (${fmt(want)})`,
      Object.is(got.value ?? null, want),
    );
  }
}

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();

  const resident = residentQuery.isResident();
  console.log(resident
    ? '#    DuckDB bridge available — the resident branch is under test'
    : '#    DuckDB bridge UNAVAILABLE — resident branch assertions are skipped');

  const proj = await projects.createProject('Metric rewire');

  // BELOW the threshold (RESIDENT_MIN_ROWS = 1_000) → always the JS path.
  // `edge` is one row short of it, `boundary` is exactly on it: together they
  // pin which side of the comparison the constant sits on, so moving the
  // threshold cannot silently stop exercising one of the branches.
  const smallRec = await datasets.saveDataset(proj.id, {
    name: 'small', sourceKind: 'csv', columns: COLUMNS, rows: buildRows(60),
  });
  const edgeRec = await datasets.saveDataset(proj.id, {
    name: 'edge', sourceKind: 'csv', columns: COLUMNS, rows: buildRows(999),
  });
  const boundaryRec = await datasets.saveDataset(proj.id, {
    name: 'boundary', sourceKind: 'csv', columns: COLUMNS, rows: buildRows(1_000),
  });
  // WELL above the threshold → the resident path (when the bridge is up).
  const largeRec = await datasets.saveDataset(proj.id, {
    name: 'large', sourceKind: 'csv', columns: COLUMNS, rows: buildRows(12_000),
  });
  ok('fixtures saved', Boolean(smallRec && edgeRec && boundaryRec && largeRec));
  if (!smallRec || !edgeRec || !boundaryRec || !largeRec) return;

  // Read each back through the real loader so the reference sees the STORED
  // rows (a Parquet round trip is not an identity on every cell type).
  async function load(id: string, label: string): Promise<Fixture> {
    const ds = await realGetDataset(proj.id, id);
    if (!ds) throw new Error('fixture read-back failed: ' + label);
    return { id: ds.id, projectId: proj.id, label, columns: ds.columns, rows: ds.rows };
  }
  const small = await load(smallRec.id, 'small60');
  const edge = await load(edgeRec.id, 'edge999');
  const boundary = await load(boundaryRec.id, 'boundary1k');
  const large = await load(largeRec.id, 'large12k');

  // ── 1. Contract: response shape is unchanged ───────────────────────────────
  {
    const good = await viaIpc(small, 'sales', 'sum');
    ok('contract: success is { ok:true, value } and nothing else',
      good.ok === true && 'value' in good && Object.keys(good).sort().join(',') === 'ok,value');

    const missing = await viaIpc({ ...small, id: '00000000-0000-4000-8000-000000000000' }, 'sales', 'sum');
    ok('contract: unknown dataset → { ok:false, error }',
      missing.ok === false && missing.error === 'Dataset not found');

    const bogusId = await viaIpc({ ...small, id: 'not-a-uuid' }, 'sales', 'sum');
    ok('contract: non-UUID datasetId → { ok:false, error } (never a throw)',
      bogusId.ok === false && typeof bogusId.error === 'string');

    const noArgs = await (metricHandler as IpcHandler)(null);
    ok('contract: missing payload → { ok:false, error }', noArgs.ok === false);
  }

  // ── 2. Differential, JS branch (below threshold) ───────────────────────────
  for (const f of [small, edge]) {
    await diff('unfiltered numeric', f, 'sales');
    await diff('unfiltered text', f, 'note');
    await diff('all-empty column', f, 'blank');
    await diff('leading-zero text column', f, 'code');

    const one: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'region-1' }];
    await diff('one dashboard filter', f, 'sales', one);
    await diff('one dashboard filter (count)', f, 'note', one);

    const numeric: FilterStep[] = [{ type: 'filter', column: 'sales', op: '>=', value: 0 }];
    await diff('numeric dashboard filter', f, 'sales', numeric);

    // A filter naming a column this dataset lacks is SKIPPED, and the metric
    // still computes — the property that lets one dashboard filter span
    // heterogeneous datasets (scripts/test-dashboardFilters.ts pins it too).
    const absent: FilterStep[] = [{ type: 'filter', column: 'nope', op: '=', value: 'x' }];
    await diff('filter on a missing column (skipped)', f, 'sales', absent);
    await diff('missing-column filter + a real one', f, 'sales', [...absent, ...one]);

    // No row survives → count 0, sum/avg/min/max null. NEVER 0 for a sum.
    const none: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'nobody' }];
    await diff('zero-row result', f, 'sales', none);
    const zeroSum = await viaIpc(f, 'sales', 'sum', none);
    const zeroCount = await viaIpc(f, 'sales', 'count', none);
    ok(`${f.label}: zero rows → sum is null, not 0`, zeroSum.value === null);
    ok(`${f.label}: zero rows → count is 0, not null`, zeroCount.value === 0);
  }

  // ── 3. Semantics the rewire must not have quietly changed ──────────────────
  {
    // count is NON-EMPTY cells: '' and '   ' do not count, text does.
    const nonEmpty = small.rows.filter((r) => typeof r[2] === 'string' && r[2].trim() !== '').length;
    const got = await viaIpc(small, 'note', 'count');
    ok(`count excludes '' and whitespace-only cells (${nonEmpty} of ${small.rows.length})`,
      got.value === nonEmpty && nonEmpty > 0 && nonEmpty < small.rows.length);

    // A leading-zero TEXT column never becomes a number.
    const codeSum = await viaIpc(small, 'code', 'sum');
    const codeCount = await viaIpc(small, 'code', 'count');
    ok('leading-zero text column: sum is null (no implicit cast)', codeSum.value === null);
    ok('leading-zero text column: count still counts every cell', codeCount.value === small.rows.length);

    // All-empty column: count 0, everything else null.
    for (const agg of AGGS) {
      const r = await viaIpc(small, 'blank', agg);
      ok(`all-empty column: ${agg} → ${agg === 'count' ? '0' : 'null'}`,
        Object.is(r.value ?? null, agg === 'count' ? 0 : null));
    }

    const unknownCol = await viaIpc(small, 'no-such-column', 'sum');
    ok('unknown column → { ok:true, value:null }', unknownCol.ok === true && unknownCol.value === null);
    const unknownAgg = await viaIpc(small, 'sales', 'median');
    ok('unknown aggregation → { ok:true, value:null }', unknownAgg.ok === true && unknownAgg.value === null);
  }

  // ── 4. sanitizeDashboardFilters is still a SECURITY control ────────────────
  // Untrusted renderer input reaches this handler. A non-filter step smuggled in
  // must be stripped before ANY math, on BOTH paths — otherwise a metric card
  // could run an arbitrary transform.
  {
    const smuggled = [
      { type: 'drop_column', column: 'sales' },
      { type: 'group_aggregate', groupBy: 'region', aggregations: [{ column: 'sales', fn: 'sum' }] },
      { type: 'filter', column: 'region', op: '=', value: 'region-1' },
    ];
    const onlyFilter: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'region-1' }];
    for (const f of [small, large]) {
      const got = await viaIpc(f, 'sales', 'sum', smuggled);
      const want = reference(f, 'sales', 'sum', onlyFilter);
      ok(`${f.label}: non-filter steps are stripped (value === filter-only reference)`,
        got.ok === true && Object.is(got.value ?? null, want) && want !== null);
    }
    ok('sanitizeDashboardFilters keeps only the filter step',
      dashboardsStore.sanitizeDashboardFilters(smuggled).length === 1);
  }

  // ── 5. Differential, resident branch (above threshold) ─────────────────────
  await diff('unfiltered numeric', large, 'sales');
  await diff('unfiltered text', large, 'note');
  await diff('all-empty column', large, 'blank');
  await diff('leading-zero text column', large, 'code');
  {
    const one: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'region-2' }];
    await diff('one dashboard filter', large, 'sales', one);
    await diff('one dashboard filter (count)', large, 'note', one);
    await diff('numeric dashboard filter', large, 'sales',
      [{ type: 'filter', column: 'sales', op: '>=', value: 0 }]);
    const absent: FilterStep[] = [{ type: 'filter', column: 'nope', op: '=', value: 'x' }];
    await diff('filter on a missing column (skipped)', large, 'sales', absent);
    await diff('missing-column filter + a real one', large, 'sales', [...absent, ...one]);
    await diff('zero-row result', large, 'sales',
      [{ type: 'filter', column: 'region', op: '=', value: 'nobody' }]);
  }

  // ── 6. The branches really are different code ──────────────────────────────
  {
    resetSpy();
    await viaIpc(small, 'sales', 'sum');
    ok('below threshold: the table IS hydrated (JS branch taken)', hydrations === 1);

    resetSpy();
    await viaIpc(edge, 'sales', 'sum');
    ok('one row below the threshold: still hydrated', hydrations === 1);

    resetSpy();
    const atBoundary = await viaIpc(boundary, 'sales', 'sum');
    ok(resident
      ? 'exactly at the threshold: NOT hydrated (the comparison is >=)'
      : 'exactly at the threshold: hydrated (no bridge)',
      hydrations === (resident ? 0 : 1));
    ok('exactly at the threshold: the answer still matches computeMetric',
      Object.is(atBoundary.value ?? null, reference(boundary, 'sales', 'sum')));

    resetSpy();
    const big = await viaIpc(large, 'sales', 'sum');
    if (resident) {
      ok('above threshold: NOT hydrated (resident branch taken)', hydrations === 0);
      ok('above threshold: the resident answer is still correct',
        Object.is(big.value ?? null, reference(large, 'sales', 'sum')));
    } else {
      ok('above threshold: falls back to hydration with no bridge', hydrations === 1);
    }

    // A resident `null` is indistinguishable from a resident FAILURE, so it must
    // fall through to the reference path rather than be returned as an answer.
    resetSpy();
    const textAgg = await viaIpc(large, 'code', 'sum');
    ok('resident null falls back to the JS path', hydrations === 1 && textAgg.value === null);

    // Filters do not defeat the resident path.
    resetSpy();
    await viaIpc(large, 'sales', 'count', [{ type: 'filter', column: 'region', op: '=', value: 'region-0' }]);
    ok(resident ? 'filtered metric stays resident' : 'filtered metric hydrates with no bridge',
      hydrations === (resident ? 0 : 1));

    // A missing-column filter must not push the resident path into a fallback:
    // it is skipped in SQL exactly as transforms skips it.
    resetSpy();
    const skipped = await viaIpc(large, 'sales', 'sum', [{ type: 'filter', column: 'nope', op: '=', value: 'x' }]);
    ok(resident ? 'missing-column filter stays resident' : 'missing-column filter hydrates with no bridge',
      hydrations === (resident ? 0 : 1));
    ok('missing-column filter still yields the unfiltered metric',
      Object.is(skipped.value ?? null, reference(large, 'sales', 'sum')));
  }

  // ── 7. The per-call dataset cache is not defeated ──────────────────────────
  // computeMetricCards resolves a dataset ONCE per call. Exercised through the
  // shipped `dashboard:summary` handler, which calls it before asking the model
  // (and then returns notReady here, since no model is configured).
  {
    const cards = (datasetId: string) => [0, 1, 2].map((i) => ({
      type: 'metric',
      layout: { x: (i * 3) % 12, y: 0, w: 3, h: 2 },
      metric: { datasetId, column: i === 2 ? 'note' : 'sales', aggregation: i === 1 ? 'avg' : i === 2 ? 'count' : 'sum' },
    }));

    const dSmall = await dashboardsStore.saveDashboard(proj.id, {
      name: 'small cards', pages: [{ name: 'Page 1', cards: cards(small.id) }],
    });
    resetSpy();
    const rSmall = await (summaryHandler as IpcHandler)(null, { projectId: proj.id, id: dSmall!.id });
    ok('3 metric cards on one small dataset hydrate it exactly once', hydrations === 1);
    ok('dashboard:summary still answers without a model', rSmall.ok === false);

    const dLarge = await dashboardsStore.saveDashboard(proj.id, {
      name: 'large cards', pages: [{ name: 'Page 1', cards: cards(large.id) }],
    });
    resetSpy();
    await (summaryHandler as IpcHandler)(null, { projectId: proj.id, id: dLarge!.id });
    ok(resident
      ? '3 metric cards on one resident dataset never hydrate it'
      : '3 metric cards on one dataset hydrate it exactly once (no bridge)',
      hydrations === (resident ? 0 : 1));
  }
}

void main()
  .catch((err) => { ok('unexpected error', false, err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' metric-rewire check(s) FAILED'); process.exit(1); }
    console.log('\nAll metric-rewire checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
