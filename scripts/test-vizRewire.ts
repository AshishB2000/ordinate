// Self-check for the Phase 2.5 `visual:data` rewire (src/ipc/visuals.ts).
//
// The handler now answers the AGGREGATED, no-split, no-geo chart straight off
// the dataset's Parquet file (`residentQuery.aggregateResident`) instead of
// hydrating the whole table. `buildVizData` remains the reference
// implementation, so this suite is DIFFERENTIAL by construction: a real dataset
// is written to disk with `datasets.saveDataset`, the SHIPPED handler is invoked
// (captured by stubbing `ipcMain.handle`), and its output is compared cell for
// cell — labels, series names, values, and the JS `typeof` of every one — with
// `buildVizData` over the SAME round-tripped columns/rows.
//
// A hand-written expectation can agree with a bug in both implementations; an
// equivalence assertion cannot. The only non-differential assertions here are
// the ones the reference cannot state about itself: WHICH path ran (the fast
// path must actually be taken, or this suite would be green and inert), and the
// measured float-summation divergence inherited from `residentQuery`.
//
//   npm run build:ts && node scripts/test-vizRewire.js

export {}; // module scope — sibling test scripts share top-level names

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

void assert; // parity with test-datasets.ts (asserts done via ok())

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-vizrewire-'));

// ── The electron stub ────────────────────────────────────────────────────────
// Two jobs: point userData at a temp dir (as test-datasets.ts does), and CAPTURE
// every ipcMain.handle registration so the test can invoke the real, shipped
// handler rather than a copy of its logic.
const handlers = new Map<string, (e: unknown, arg: unknown) => Promise<any>>();

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData },
      ipcMain: {
        handle: (channel: string, fn: (e: unknown, arg: unknown) => Promise<any>) => {
          handlers.set(channel, fn);
        },
      },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings.
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/projects') = require('../src/projects');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const visualsMod: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type VizEncoding = import('../src/analysis/visuals').VizEncoding;

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

// ── Differential harness ─────────────────────────────────────────────────────

let visualData!: (e: unknown, arg: unknown) => Promise<any>;

interface Fixture {
  id: string;
  label: string;
  /** Columns/rows AS READ BACK from storage — the reference must see the same
   *  bytes the fast path queries, not the in-memory array that went in. */
  columns: ParsedColumn[];
  rows: Cell[][];
}

let projectId = '';

async function makeFixture(label: string, columns: ParsedColumn[], rows: Cell[][]): Promise<Fixture> {
  const ds = await datasets.saveDataset(projectId, { name: label, sourceKind: 'csv', columns, rows });
  if (!ds) throw new Error('saveDataset failed for ' + label);
  const back = await datasets.getDataset(projectId, ds.id);
  if (!back) throw new Error('getDataset failed for ' + label);
  return { id: ds.id, label, columns: back.columns, rows: back.rows };
}

/** A structural description of a chart result, `typeof` of every cell included. */
function shapeOf(data: any): string {
  const labels = (data.labels as (string | number)[]).map((l) => `${typeof l}:${JSON.stringify(l)}`);
  const series = (data.series as { name: string; values: (number | null)[] }[]).map(
    (s) => `${JSON.stringify(s.name)}=[${s.values.map((v) => `${typeof v}:${JSON.stringify(v)}`).join(',')}]`,
  );
  const extra = [
    'geo' in data ? `geo:${JSON.stringify(data.geo)}` : '',
    'dataShape' in data ? `dataShape:${JSON.stringify(data.dataShape)}` : '',
  ].filter(Boolean);
  return `L[${labels.join(',')}]|S[${series.join(';')}]${extra.length ? '|' + extra.join('|') : ''}`;
}

/**
 * Invoke the SHIPPED handler and assert byte-equality with the reference.
 * `expectFast` pins which path ran, so a rewire that silently stops firing (or
 * one that fires where it must not) fails loudly instead of passing by default.
 */
async function diff(
  label: string,
  f: Fixture,
  encoding: unknown,
  filters?: unknown,
  expectFast?: boolean,
): Promise<void> {
  const got = await visualData(null, { projectId, datasetId: f.id, encoding, filters });
  const enc: VizEncoding = visualsMod.sanitizeEncoding(encoding);
  const flt: FilterStep[] = visualsMod.sanitizeFilters(filters);
  const ref = vizData.buildVizData(f.columns, f.rows, enc, flt);

  ok(`${label}: ok`, got && got.ok === true);
  if (!got || !got.ok) return;
  ok(`${label}: labels + series + cell types identical`, shapeOf(got.data) === shapeOf(ref.data));
  if (shapeOf(got.data) !== shapeOf(ref.data)) {
    console.error('   got: ' + shapeOf(got.data));
    console.error('   ref: ' + shapeOf(ref.data));
  }
  ok(`${label}: recommendedShape identical`, got.recommendedShape === ref.recommendedShape);
  ok(`${label}: warnings identical`, JSON.stringify(got.warnings) === JSON.stringify(ref.warnings));

  if (expectFast !== undefined) {
    const fast = await ipcVisuals.residentVizData(projectId, f.id, enc, flt);
    ok(`${label}: path is ${expectFast ? 'RESIDENT' : 'fallback'}`, (fast !== null) === expectFast);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SMALL_COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'code', type: 'text' },
  { name: 'price', type: 'number' },
  { name: 'qty', type: 'number' },
  { name: 'note', type: 'text' },
];

// Deliberate content: repeated categories (grouping), a leading-zero code next
// to its numeric-looking twin, nulls and '' in a measure (empty ≠ zero), a
// text measure (all-null series), and one category that only appears once.
const SMALL_ROWS: Cell[][] = [
  ['West', '007', 10, 3, 'a'],
  ['East', '7', 20, 1, ''],
  ['West', '007', 5, 2, 'b'],
  ['North', '070', null, 4, null],
  ['East', '7', 30, 0, 'c'],
  ['West', '7', -8, 6, ''],
  ['South', '007', 0, null, 'd'],
];

const BIG_COLUMNS: ParsedColumn[] = [
  { name: 'g', type: 'text' },
  { name: 'v', type: 'number' },
  { name: 'w', type: 'number' },
];
const BIG_ROWS: Cell[][] = [];
{
  // 60,000 rows — past pipelineDuck's DUCKDB_MIN_ROWS (50k) on the reference
  // side too, and enough that the hydrate cost is real rather than theoretical.
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 60000; i += 1) {
    const g = `g${i % 120}`;
    // Integer-valued: float summation order is a KNOWN divergence between the
    // JS left-fold and DuckDB's parallel combine (residentQuery.ts header), and
    // it is pinned separately below rather than smeared across every case.
    BIG_ROWS.push([g, Math.floor(rand() * 1000) - 500, i % 7 === 0 ? null : Math.floor(rand() * 50)]);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!parquetStore.isSupported()) {
    console.log('ok   duckdb bridge unavailable — resident path cannot be exercised, skipping');
    return;
  }

  ipcVisuals.register();
  const h = handlers.get('visual:data');
  ok('visual:data handler registered', typeof h === 'function');
  if (!h) return;
  visualData = h;

  await projects.init();
  await datasets.init();
  const proj = await projects.createProject('Rewire project');
  projectId = proj.id;

  const small = await makeFixture('small', SMALL_COLUMNS, SMALL_ROWS);
  const big = await makeFixture('big', BIG_COLUMNS, BIG_ROWS);
  ok('small fixture is resident (v3)', (await datasets.residentSource(projectId, small.id)) !== null);
  ok('big fixture is resident (v3)', (await datasets.residentSource(projectId, big.id)) !== null);

  // ── (A) aggregated — the rewired branch ────────────────────────────────────

  await diff('single measure (sum)', small, {
    category: 'region',
    values: [{ column: 'price', aggregation: 'sum' }],
  }, undefined, true);

  await diff('multiple measures', small, {
    category: 'region',
    values: [
      { column: 'price', aggregation: 'sum' },
      { column: 'qty', aggregation: 'avg' },
      { column: 'note', aggregation: 'count' },
    ],
  }, undefined, true);

  for (const agg of ['sum', 'avg', 'count', 'min', 'max']) {
    await diff(`aggregation "${agg}"`, small, {
      category: 'region',
      values: [{ column: 'price', aggregation: agg }],
    }, undefined, true);
  }

  // A leading-zero id must stay the STRING label "007" and must group by string
  // identity — "007", "7" and "070" are three groups, never fused by a cast.
  await diff('leading-zero category groups by string identity', small, {
    category: 'code',
    values: [{ column: 'price', aggregation: 'sum' }],
  }, undefined, true);
  {
    const got = await visualData(null, {
      projectId,
      datasetId: small.id,
      encoding: { category: 'code', values: [{ column: 'price', aggregation: 'sum' }] },
    });
    const labels = got.data.labels as (string | number)[];
    ok('leading-zero: "007" is a string label', labels.includes('007') && typeof labels[0] === 'string');
    ok('leading-zero: "007" and "7" are separate groups', labels.includes('007') && labels.includes('7'));
    ok('leading-zero: first-seen order preserved', JSON.stringify(labels) === JSON.stringify(['007', '7', '070']));
  }

  // A text column aggregated with sum has no finite numeric cells by definition
  // → an all-null series. NEVER an implicit VARCHAR→DOUBLE cast turning 007 into 7.
  await diff('non-numeric measure → all-null series', small, {
    category: 'region',
    values: [{ column: 'note', aggregation: 'sum' }],
  }, undefined, true);

  // A 'none' measure in an aggregated (mixed) encoding is coerced to sum AND
  // relabelled "sum of price" — the label must never understate the value.
  await diff('mixed none + sum relabels to "sum of"', small, {
    category: 'region',
    values: [
      { column: 'price', aggregation: 'none' },
      { column: 'qty', aggregation: 'count' },
    ],
  }, undefined, true);
  {
    const got = await visualData(null, {
      projectId,
      datasetId: small.id,
      encoding: {
        category: 'region',
        values: [{ column: 'price', aggregation: 'none' }, { column: 'qty', aggregation: 'count' }],
      },
    });
    ok("'none' measure relabelled 'sum of price'", got.data.series[0].name === 'sum of price');
    ok("'count' measure keeps the bare column name", got.data.series[1].name === 'qty');
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  const FILTER_CASES: { label: string; filters: FilterStep[] }[] = [
    { label: 'text =', filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] },
    { label: 'number >', filters: [{ type: 'filter', column: 'price', op: '>', value: 5 }] },
    { label: 'contains', filters: [{ type: 'filter', column: 'note', op: 'contains', value: 'a' }] },
    { label: 'is_empty', filters: [{ type: 'filter', column: 'note', op: 'is_empty' }] },
    { label: 'not_empty', filters: [{ type: 'filter', column: 'note', op: 'not_empty' }] },
    {
      label: 'two filters (AND)',
      filters: [
        { type: 'filter', column: 'region', op: '!=', value: 'North' },
        { type: 'filter', column: 'qty', op: '>=', value: 2 },
      ],
    },
  ];
  for (const c of FILTER_CASES) {
    await diff(`filter ${c.label}`, small, {
      category: 'region',
      values: [{ column: 'price', aggregation: 'sum' }, { column: 'qty', aggregation: 'max' }],
    }, c.filters, true);
  }

  // A filter that matches nothing → empty labels + empty-but-present series.
  await diff('filter matching no rows → empty result', small, {
    category: 'region',
    values: [{ column: 'price', aggregation: 'sum' }],
  }, [{ type: 'filter', column: 'region', op: '=', value: 'Atlantis' }], true);

  // A filter on a MISSING column is skipped WITH A WARNING by transforms. The
  // fast path cannot emit warnings, so it must decline — and the user must still
  // see the warning.
  await diff('filter on a missing column → falls back, warning kept', small, {
    category: 'region',
    values: [{ column: 'price', aggregation: 'sum' }],
  }, [{ type: 'filter', column: 'nope', op: '=', value: 'x' }], false);
  {
    const got = await visualData(null, {
      projectId,
      datasetId: small.id,
      encoding: { category: 'region', values: [{ column: 'price', aggregation: 'sum' }] },
      filters: [{ type: 'filter', column: 'nope', op: '=', value: 'x' }],
    });
    ok('missing-column filter still warns', got.warnings.length === 1 && /unknown column/.test(got.warnings[0]));
  }

  // Same for an unknown MEASURE column (transforms warns) and an unknown
  // CATEGORY column (a guard-rail early return with its own warning).
  await diff('unknown measure column → falls back, warning kept', small, {
    category: 'region',
    values: [{ column: 'ghost', aggregation: 'sum' }],
  }, undefined, false);
  await diff('unknown category column → falls back, warning kept', small, {
    category: 'ghost',
    values: [{ column: 'price', aggregation: 'sum' }],
  }, undefined, false);
  await diff('no category → falls back', small, {
    category: '',
    values: [{ column: 'price', aggregation: 'sum' }],
  }, undefined, false);
  await diff('no measure → falls back', small, { category: 'region', values: [] }, undefined, false);

  // ── Branches that are NOT rewired ──────────────────────────────────────────

  await diff('(B) split/pivot → falls back', small, {
    category: 'region',
    series: 'code',
    values: [{ column: 'price', aggregation: 'sum' }],
  }, undefined, false);

  await diff('(B) split with missing combos → falls back, nulls kept', small, {
    category: 'code',
    series: 'region',
    values: [{ column: 'qty', aggregation: 'sum' }],
  }, undefined, false);

  await diff("(C) all-'none' raw → falls back", small, {
    category: 'region',
    values: [{ column: 'price', aggregation: 'none' }, { column: 'qty', aggregation: 'none' }],
  }, undefined, false);

  await diff('geo → falls back', small, {
    category: 'region',
    values: [{ column: 'price', aggregation: 'sum' }],
    geo: { level: 'us_state' },
  }, undefined, false);

  await diff('geo + split (dataShape time_series) → falls back', small, {
    category: 'region',
    series: 'code',
    values: [{ column: 'price', aggregation: 'sum' }],
    geo: { level: 'us_state' },
  }, undefined, false);

  // ── Scale: the same encoding over 60k rows must agree too ──────────────────

  await diff('60k rows: sum + count by group', big, {
    category: 'g',
    values: [{ column: 'v', aggregation: 'sum' }, { column: 'w', aggregation: 'count' }],
  }, undefined, true);

  await diff('60k rows: min/max/avg by group', big, {
    category: 'g',
    values: [
      { column: 'v', aggregation: 'min' },
      { column: 'v', aggregation: 'max' },
      { column: 'w', aggregation: 'avg' },
    ],
  }, undefined, true);

  await diff('60k rows: filtered', big, {
    category: 'g',
    values: [{ column: 'v', aggregation: 'sum' }],
  }, [{ type: 'filter', column: 'v', op: '>', value: 0 }], true);

  // Small and large must agree on the SHAPE of the contract, not just per-case:
  // both take the resident path and both are label-order stable across runs.
  {
    const enc = { category: 'g', values: [{ column: 'v', aggregation: 'sum' as const }] };
    const a = await visualData(null, { projectId, datasetId: big.id, encoding: enc });
    const b = await visualData(null, { projectId, datasetId: big.id, encoding: enc });
    ok('60k label order is stable across repeated runs', shapeOf(a.data) === shapeOf(b.data));
    ok('60k: 120 groups, first-seen order', a.data.labels.length === 120 && a.data.labels[0] === 'g0' && a.data.labels[1] === 'g1');
  }

  // ── The one divergence that could NOT be reproduced ────────────────────────
  //
  // JS sums with a left-fold in row order; DuckDB sums in parallel chunks and
  // combines partial sums. Integer data is exact (every case above); fractional
  // doubles differ by a few ULP. Pinned here so it stays visible and measured
  // rather than being discovered by a user.
  {
    const cols: ParsedColumn[] = [{ name: 'g', type: 'text' }, { name: 'x', type: 'number' }];
    const rows: Cell[][] = [];
    let s = 7;
    for (let i = 0; i < 20000; i += 1) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      rows.push(['all', (s / 0x7fffffff) * 1000]);
    }
    const f = await makeFixture('floats', cols, rows);
    const enc = { category: 'g', values: [{ column: 'x', aggregation: 'sum' as const }] };
    const got = await visualData(null, { projectId, datasetId: f.id, encoding: enc });
    const ref = vizData.buildVizData(f.columns, f.rows, visualsMod.sanitizeEncoding(enc), []);
    const a = got.data.series[0].values[0] as number;
    const b = ref.data.series[0].values[0] as number;
    const rel = Math.abs(a - b) / Math.abs(b);
    ok('float sum: still a finite number of the right type', typeof a === 'number' && Number.isFinite(a));
    ok(`float sum: within 1e-12 relative of the JS fold (measured ${rel.toExponential(2)}) — KNOWN DIVERGENCE`, rel < 1e-12);
  }
}

main()
  .catch((err) => {
    console.error('FAIL unexpected error:', err);
    failures++;
  })
  .finally(() => {
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (failures > 0) {
      console.error(`\n${failures} vizRewire check(s) failed.`);
      process.exit(1);
    }
    console.log('\nAll vizRewire checks passed.');
  });
