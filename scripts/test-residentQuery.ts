'use strict';

// Self-check for src/residentQuery.ts — computing straight off Parquet.
//
// This suite is DIFFERENTIAL by design. residentQuery's only job is to produce
// the same answer as the code the app already ships, so almost nothing here is
// asserted against a hand-written number: a fixture is written with
// `parquetStore.writeTable`, read back with `parquetStore.readTable`, and the
// resident answer is compared to `metricValue.computeMetric` /
// `vizData.buildVizData` over those exact rows. A hand-written expectation can
// agree with a bug in both implementations; an equivalence assertion cannot.
//
// The few non-differential assertions are the ones the reference implementation
// cannot state about itself: label ORDER stability across repeated runs, and
// the measured float-summation divergence.
//
//   npm run build:ts && node scripts/test-residentQuery.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as rq from '../src/residentQuery';
import * as pq from '../src/parquetStore';
import * as duck from '../src/duckdb';
import * as metricValue from '../src/metricValue';
import * as vizData from '../src/vizData';
import type { ParsedColumn } from '../src/parse';
import type { Cell, FilterStep } from '../src/transforms';
import type { VizEncoding } from '../src/visuals';

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-resident-'));
let seq = 0;
function tmpFile(): string {
  return path.join(dir, `t${seq++}.parquet`);
}
function cleanup(): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ── The differential harness ─────────────────────────────────────────────────
//
// A fixture is (columns, rows). `fixture()` writes it, reads it back, and hands
// back both the resident source AND the hydrated table — so every comparison is
// against the SAME bytes, not against the in-memory array that went in. That
// matters: a `number` column's NaN becomes null on the way through storage, and
// the reference has to see the post-round-trip value too.

interface Fixture {
  src: rq.ResidentSource;
  columns: ParsedColumn[];
  rows: Cell[][];
}

function fixture(columns: ParsedColumn[], rows: Cell[][]): Fixture {
  const file = tmpFile();
  pq.writeTable(file, columns, rows);
  const back = pq.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { src: { parquetPath: file, columns }, columns: back.columns, rows: back.rows };
}

const AGGS: metricValue.MetricAggregation[] = ['sum', 'avg', 'count', 'min', 'max'];

/** computeMetricResident must equal computeMetric, for every aggregation. */
function diffMetric(label: string, f: Fixture, column: string, filters?: FilterStep[]): void {
  const rows = filters && filters.length > 0 ? applyFilters(f, filters) : f.rows;
  for (const agg of AGGS) {
    const want = metricValue.computeMetric(f.columns, rows, { column, aggregation: agg });
    const got = rq.computeMetricResident(f.src, { column, aggregation: agg }, filters);
    ok(`${label}: ${agg}(${column}) === computeMetric (${fmt(want)})`, Object.is(want, got));
  }
}

// The reference path for a filtered metric is exactly what ipc/dashboards.ts
// does today: applyPipeline the filters in JS, then computeMetric the result.
function applyFilters(f: Fixture, filters: FilterStep[]): Cell[][] {
  const transforms: typeof import('../src/transforms') = require('../src/transforms');
  return transforms.applyPipeline({ columns: f.columns, rows: f.rows }, filters).rows;
}

/** aggregateResident must equal buildVizData, label-for-label and value-for-value. */
function diffAggregate(
  label: string,
  f: Fixture,
  category: string,
  measures: rq.ResidentMeasure[],
  filters?: FilterStep[],
): void {
  const encoding: VizEncoding = {
    category,
    values: measures.map((m) => ({ column: m.column, aggregation: m.aggregation })),
  };
  const want = vizData.buildVizData(f.columns, f.rows, encoding, filters).data;
  const got = rq.aggregateResident(f.src, category, measures, filters);
  if (!got) {
    ok(`${label}: aggregateResident returned a result`, false);
    return;
  }
  ok(
    `${label}: labels === buildVizData (${want.labels.length} groups)`,
    sameLabels(want.labels, got.labels),
  );
  ok(`${label}: series count === buildVizData`, want.series.length === got.series.length);
  for (let i = 0; i < Math.min(want.series.length, got.series.length); i++) {
    ok(`${label}: series[${i}].name === "${want.series[i].name}"`, want.series[i].name === got.series[i].name);
    ok(
      `${label}: series[${i}].values === buildVizData`,
      sameValues(want.series[i].values, got.series[i].values),
    );
  }
}

// Object.is throughout, so '' can never compare equal to null and 0 can never
// compare equal to '' by coercion — the distinctions this whole storage layer
// exists to preserve.
function sameLabels(a: (string | number)[], b: (string | number)[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
function sameValues(a: (number | null)[], b: (number | null)[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
function fmt(v: unknown): string {
  return v === null ? 'null' : String(v);
}

// ─────────────────────────────────────────────────────────────────────────────

if (!rq.isResident()) {
  console.error('FAIL residentQuery: DuckDB bridge unavailable — nothing was verified');
  cleanup();
  process.exit(1);
}
ok('isResident(): true when the bridge is up', rq.isResident() === true);

// ── 1. All five aggregations over a plain numeric column ─────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'region', type: 'text' },
    { name: 'sales', type: 'number' },
  ];
  const f = fixture(cols, [
    ['West', 100],
    ['East', 200],
    ['West', null],
    ['North', 50],
    ['East', 0],
  ]);
  diffMetric('numeric column', f, 'sales');
  ok('numeric: sum is the real total', rq.computeMetricResident(f.src, { column: 'sales', aggregation: 'sum' }) === 350);
  ok('numeric: min sees 0 as a real value', rq.computeMetricResident(f.src, { column: 'sales', aggregation: 'min' }) === 0);
  ok(
    'numeric: avg divides by finite-numeric count, not row count',
    rq.computeMetricResident(f.src, { column: 'sales', aggregation: 'avg' }) === 350 / 4,
  );
  ok(
    'unknown column → null (not an error)',
    rq.computeMetricResident(f.src, { column: 'nope', aggregation: 'sum' }) === null,
  );
  ok(
    'unsupported aggregation → null',
    rq.computeMetricResident(f.src, { column: 'sales', aggregation: 'median' as metricValue.MetricAggregation }) === null,
  );
  diffAggregate('numeric', f, 'region', [
    { column: 'sales', aggregation: 'sum' },
    { column: 'sales', aggregation: 'avg' },
    { column: 'sales', aggregation: 'count' },
    { column: 'sales', aggregation: 'min' },
    { column: 'sales', aggregation: 'max' },
  ]);
}

// ── 2. A TEXT column must aggregate to null — never an implicit cast ─────────
//
// The catastrophic case from phase-0/04: `sum(zip)` in DuckDB implicitly casts
// VARCHAR→DOUBLE, so '007' becomes 7 and a metric card renders a plausible
// wrong total. The gate is the DECLARED type, in TS, before any SQL exists.
{
  const cols: ParsedColumn[] = [
    { name: 'city', type: 'text' },
    { name: 'zip', type: 'text' },
  ];
  const f = fixture(cols, [
    ['Boston', '007'],
    ['Boston', '012'],
    ['Reno', '90210'],
  ]);
  diffMetric('text column', f, 'zip');
  for (const agg of ['sum', 'avg', 'min', 'max'] as metricValue.MetricAggregation[]) {
    ok(
      `text: ${agg}(zip) is null, NOT a cast of '007'`,
      rq.computeMetricResident(f.src, { column: 'zip', aggregation: agg }) === null,
    );
  }
  ok('text: count(zip) === 3', rq.computeMetricResident(f.src, { column: 'zip', aggregation: 'count' }) === 3);
  diffAggregate('text measure', f, 'city', [
    { column: 'zip', aggregation: 'sum' },
    { column: 'zip', aggregation: 'count' },
  ]);
}

// ── 3. An ALL-EMPTY column: null, and emphatically not 0 ────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'k', type: 'text' },
    { name: 'v', type: 'number' },
  ];
  const f = fixture(cols, [
    ['a', null],
    ['b', null],
    ['a', null],
  ]);
  diffMetric('all-empty column', f, 'v');
  for (const agg of ['sum', 'avg', 'min', 'max'] as metricValue.MetricAggregation[]) {
    const got = rq.computeMetricResident(f.src, { column: 'v', aggregation: agg });
    ok(`all-empty: ${agg} is null — NOT 0, NOT NaN`, got === null);
  }
  ok('all-empty: count is 0, not null', rq.computeMetricResident(f.src, { column: 'v', aggregation: 'count' }) === 0);
  diffAggregate('all-empty', f, 'k', [
    { column: 'v', aggregation: 'sum' },
    { column: 'v', aggregation: 'count' },
  ]);
}

// ── 4. count vs '' and whitespace-only ──────────────────────────────────────
//
// Bare count(col) gives 5 here. The contract is 2.
{
  const cols: ParsedColumn[] = [
    { name: 'g', type: 'text' },
    { name: 'note', type: 'text' },
  ];
  const f = fixture(cols, [
    ['x', 'a'],
    ['x', ''],
    ['y', '   '],
    ['y', null],
    ['x', 'b'],
  ]);
  diffMetric('blank-heavy column', f, 'note');
  ok(
    "count excludes '' , whitespace-only and null → 2",
    rq.computeMetricResident(f.src, { column: 'note', aggregation: 'count' }) === 2,
  );
  diffAggregate('blank-heavy', f, 'g', [{ column: 'note', aggregation: 'count' }]);

  // The full JS whitespace class, which neither DuckDB trim() nor RE2 \s covers
  // on its own (tab vs NBSP). sqlGen.sqlEmpty spells it out; this proves the
  // resident path really is using that definition.
  const ws = fixture(cols, [
    ['x', '\t'],
    ['x', ' '],
    ['x', ''],
    ['x', '\r\n'],
    ['x', 'real'],
  ]);
  diffMetric('unicode-whitespace column', ws, 'note');
  ok(
    'count treats tab/NBSP/VT/CRLF as empty → 1',
    rq.computeMetricResident(ws.src, { column: 'note', aggregation: 'count' }) === 1,
  );
}

// ── 5. Leading zeros as CATEGORY labels ─────────────────────────────────────
//
// '007' must come back as the string '007', not the number 7, and must not be
// fused with a separate '7' group.
{
  const cols: ParsedColumn[] = [
    { name: 'code', type: 'text' },
    { name: 'amt', type: 'number' },
  ];
  const f = fixture(cols, [
    ['007', 10],
    ['7', 20],
    ['007', 5],
    ['0090210', 1],
    ['9007199254740993', 2],
  ]);
  diffAggregate('leading zeros', f, 'code', [{ column: 'amt', aggregation: 'sum' }]);
  const got = rq.aggregateResident(f.src, 'code', [{ column: 'amt', aggregation: 'sum' }]);
  ok("leading zeros: '007' stays the string '007'", !!got && Object.is(got.labels[0], '007'));
  // 5 rows, 4 distinct codes — '007' and '7' must NOT collapse into one group.
  ok("leading zeros: '007' and '7' are DIFFERENT groups", !!got && got.labels.length === 4);
  ok("leading zeros: '7' is its own group, second", !!got && Object.is(got.labels[1], '7'));
  ok(
    'leading zeros: >15-digit id keeps every digit',
    !!got && Object.is(got.labels[3], '9007199254740993'),
  );
  ok('leading zeros: sum of the 007 group is 15', !!got && got.series[0].values[0] === 15);

  // …and the same column as a MEASURE is null, not 7+7+5.
  diffMetric('leading-zero column as measure', f, 'code');
}

// ── 6. Filters ──────────────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'region', type: 'text' },
    { name: 'sales', type: 'number' },
    { name: 'code', type: 'text' },
  ];
  const f = fixture(cols, [
    ['West', 100, '007'],
    ['East', 200, '012'],
    ['West', 150, ''],
    ['North', 300, '007'],
    ['East', 50, null],
  ]);
  const cases: { name: string; steps: FilterStep[] }[] = [
    { name: 'text =', steps: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] },
    { name: 'text !=', steps: [{ type: 'filter', column: 'region', op: '!=', value: 'West' }] },
    { name: 'number >', steps: [{ type: 'filter', column: 'sales', op: '>', value: 100 }] },
    { name: 'number <=', steps: [{ type: 'filter', column: 'sales', op: '<=', value: 150 }] },
    { name: 'number = as string', steps: [{ type: 'filter', column: 'sales', op: '=', value: '200' }] },
    { name: 'contains', steps: [{ type: 'filter', column: 'region', op: 'contains', value: 'est' }] },
    { name: 'contains empty needle', steps: [{ type: 'filter', column: 'region', op: 'contains' }] },
    { name: 'is_empty', steps: [{ type: 'filter', column: 'code', op: 'is_empty' }] },
    { name: 'not_empty', steps: [{ type: 'filter', column: 'code', op: 'not_empty' }] },
    { name: "leading-zero '007'", steps: [{ type: 'filter', column: 'code', op: '=', value: '007' }] },
    {
      name: 'chained',
      steps: [
        { type: 'filter', column: 'region', op: '!=', value: 'North' },
        { type: 'filter', column: 'sales', op: '>=', value: 100 },
      ],
    },
    // A filter naming a column this dataset does not have is SKIPPED, which is
    // what lets one dashboard filter span heterogeneous datasets.
    { name: 'unknown column skipped', steps: [{ type: 'filter', column: 'nope', op: '=', value: 'x' }] },
    {
      name: 'unknown operator skipped',
      steps: [{ type: 'filter', column: 'region', op: 'like' as FilterStep['op'], value: 'x' }],
    },
    // A numeric filter whose target cannot be coerced keeps ZERO rows, for every
    // operator including !=.
    { name: 'uncoercible number target', steps: [{ type: 'filter', column: 'sales', op: '!=', value: 'abc' }] },
    { name: "number filter vs '007'", steps: [{ type: 'filter', column: 'sales', op: '=', value: '007' }] },
  ];
  for (const c of cases) {
    diffMetric(`filter ${c.name}`, f, 'sales', c.steps);
    diffAggregate(`filter ${c.name}`, f, 'region', [{ column: 'sales', aggregation: 'sum' }], c.steps);
  }
}

// ── 7. An EMPTY result ──────────────────────────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'region', type: 'text' },
    { name: 'sales', type: 'number' },
  ];
  const f = fixture(cols, [
    ['West', 100],
    ['East', 200],
  ]);
  const none: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'Nowhere' }];
  diffMetric('filtered to nothing', f, 'sales', none);
  ok(
    'filtered to nothing: count is 0 (card shows 0)',
    rq.computeMetricResident(f.src, { column: 'sales', aggregation: 'count' }, none) === 0,
  );
  ok(
    'filtered to nothing: sum is null (card shows —)',
    rq.computeMetricResident(f.src, { column: 'sales', aggregation: 'sum' }, none) === null,
  );
  diffAggregate('filtered to nothing', f, 'region', [{ column: 'sales', aggregation: 'sum' }], none);
  const got = rq.aggregateResident(f.src, 'region', [{ column: 'sales', aggregation: 'sum' }], none);
  ok('filtered to nothing: zero labels', !!got && got.labels.length === 0);

  // A genuinely zero-row table.
  const empty = fixture(cols, []);
  diffMetric('zero-row table', empty, 'sales');
  diffAggregate('zero-row table', empty, 'region', [{ column: 'sales', aggregation: 'sum' }]);
}

// ── 8. Null / '' / duplicate-name / unknown-measure edges ───────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'g', type: 'text' },
    { name: 'v', type: 'number' },
  ];
  const f = fixture(cols, [
    [null, 1],
    ['', 2],
    ['  ', 3],
    [null, 4],
    ['', 5],
  ]);
  // null and '' are DIFFERENT groups even though both label as '' — three
  // groups, three distinct sums, and buildVizData agrees on the ordering.
  diffAggregate('null vs empty category', f, 'g', [{ column: 'v', aggregation: 'sum' }]);
  const got = rq.aggregateResident(f.src, 'g', [{ column: 'v', aggregation: 'sum' }]);
  ok('null and "" stay separate groups', !!got && got.labels.length === 3);

  // Unknown MEASURE column → null values (transforms warns and returns null).
  diffAggregate('unknown measure column', f, 'g', [{ column: 'nope', aggregation: 'sum' }]);

  // Unknown CATEGORY / no measures → null, meaning "fall back to JS".
  ok('unknown category → null', rq.aggregateResident(f.src, 'nope', [{ column: 'v', aggregation: 'sum' }]) === null);
  ok('no measures → null', rq.aggregateResident(f.src, 'g', []) === null);
  ok('empty category name → null', rq.aggregateResident(f.src, '', [{ column: 'v', aggregation: 'sum' }]) === null);
}

// ── 9. A NUMBER column as the category ──────────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'year', type: 'number' },
    { name: 'v', type: 'number' },
  ];
  const f = fixture(cols, [
    [2024, 1],
    [2023, 2],
    [2024, 3],
    [null, 4],
    [2023, 5],
  ]);
  diffAggregate('numeric category', f, 'year', [{ column: 'v', aggregation: 'sum' }]);
  const got = rq.aggregateResident(f.src, 'year', [{ column: 'v', aggregation: 'sum' }]);
  ok('numeric category: labels stay JS numbers', !!got && Object.is(got.labels[0], 2024));
  ok('numeric category: null groups to the "" label', !!got && Object.is(got.labels[2], ''));
}

// ── 10. Fidelity of awkward label text ──────────────────────────────────────
{
  const cols: ParsedColumn[] = [
    { name: 'label', type: 'text' },
    { name: 'v', type: 'number' },
  ];
  const f = fixture(cols, [
    ['Smith, John', 1],
    ['line1\nline2', 2],
    ['She said "hi"', 3],
    ['naïve — ✓ 🎉', 4],
    ['﻿bom-leading', 5],
    ['tab\there', 6],
  ]);
  diffAggregate('awkward labels', f, 'label', [{ column: 'v', aggregation: 'sum' }]);
  const got = rq.aggregateResident(f.src, 'label', [{ column: 'v', aggregation: 'sum' }]);
  ok(
    'a leading BOM survives the transport (bomSafe projection)',
    !!got && Object.is(got.labels[4], '﻿bom-leading'),
  );
}

// ── 11. LABEL ORDER over 60k rows, across repeated runs ─────────────────────
//
// The whole reason an ordinal exists. A bare GROUP BY on this fixture returns
// g10, g21, g70, g76, g147… — stable per run but NOT first-seen order, and
// phase-0 §3 measured it moving across runs too. `ORDER BY min(file_row_number)`
// must reproduce transforms.stepGroupAggregate's first-seen order exactly, and
// must do so identically on every run.
{
  const N = 60_000;
  const G = 997;
  const cols: ParsedColumn[] = [
    { name: 'cat', type: 'text' },
    { name: 'v', type: 'number' },
    { name: 'code', type: 'text' },
  ];
  const rows: Cell[][] = [];
  for (let i = 0; i < N; i++) {
    // Reverse the group order relative to sort order, so an accidental
    // ORDER BY label would be caught rather than coincidentally passing.
    rows.push([`g${G - 1 - (i % G)}`, i % 17, String(i % 1000).padStart(4, '0')]);
  }
  const f = fixture(cols, rows);

  const want = vizData.buildVizData(f.columns, f.rows, {
    category: 'cat',
    values: [{ column: 'v', aggregation: 'sum' }],
  }).data;
  ok(`60k: reference produced ${G} groups`, want.labels.length === G);

  let allSame = true;
  let firstRun: (string | number)[] | null = null;
  for (let run = 0; run < 5; run++) {
    const got = rq.aggregateResident(f.src, 'cat', [{ column: 'v', aggregation: 'sum' }]);
    if (!got) {
      allSame = false;
      break;
    }
    if (!sameLabels(want.labels, got.labels)) allSame = false;
    if (!sameValues(want.series[0].values, got.series[0].values)) allSame = false;
    if (firstRun === null) firstRun = got.labels;
    else if (!sameLabels(firstRun, got.labels)) allSame = false;
  }
  ok('60k: label order === first-seen order, identical on all 5 runs', allSame);
  ok('60k: first label is the first row\'s group, not the lexically-first', want.labels[0] === `g${G - 1}`);

  // Whether a BARE GROUP BY reorders is INFORMATIONAL, never an assertion.
  //
  // This was previously asserted as `bare[0] !== want.labels[0]` — "a bare GROUP
  // BY does NOT preserve first-seen order" — and it failed on a CI runner while
  // passing locally. That test was wrong by construction: SQL does not guarantee
  // that GROUP BY reorders, only that it does not guarantee order. A quieter
  // machine, a different core count, or a smaller morsel can return groups in
  // arrival order by luck, and the assertion then fails while nothing is broken.
  //
  // The property worth pinning is the POSITIVE one, and it is already asserted
  // above: our ordinal-based query reproduces first-seen order, identically on
  // five consecutive runs. That holds whether or not the bare form happens to
  // agree on a given machine.
  const bare = duck.query(
    `SELECT c0 FROM ${pq.relationSql(f.src.parquetPath)} GROUP BY c0 LIMIT ${G};`,
  ).map((r) => String(r.c0));
  console.log(
    `     (informational: a bare GROUP BY returned ${
      bare[0] === String(want.labels[0]) ? 'first-seen order on this machine — luck, not a guarantee' : 'a DIFFERENT order, as usual'
    })`,
  );

  diffMetric('60k table', f, 'v');
  diffAggregate('60k leading-zero categories', f, 'code', [{ column: 'v', aggregation: 'count' }]);
}

// ── 12. The one semantic that could NOT be reproduced: float summation ──────
//
// JS sums with a left-fold in row order; DuckDB sums in vectorised parallel
// chunks. Integer-valued data is exact (asserted above, all over this file).
// Fractional data differs in the last few ULP. This test PINS that: it asserts
// the divergence is tiny and one-directional-in-magnitude, so a real arithmetic
// bug (wrong denominator, dropped rows, an implicit cast) still fails loudly.
{
  const cols: ParsedColumn[] = [
    { name: 'g', type: 'text' },
    { name: 'v', type: 'number' },
  ];
  const rows: Cell[][] = [];
  let s = 12345;
  const rnd = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  // 200k, not 50k: at 50k this repo's DuckDB build happens to agree with the JS
  // fold exactly, which would make the test look like proof of something it is
  // not. 200k is where the parallel-summation divergence actually shows.
  for (let i = 0; i < 200_000; i++) rows.push(['g' + (i % 7), rnd() * 1000]);
  const f = fixture(cols, rows);

  const want = metricValue.computeMetric(f.columns, f.rows, { column: 'v', aggregation: 'sum' }) as number;
  const got = rq.computeMetricResident(f.src, { column: 'v', aggregation: 'sum' }) as number;
  const relErr = Math.abs(got - want) / Math.abs(want);
  ok(`float sum: relative error ${relErr.toExponential(2)} < 1e-12`, relErr < 1e-12);
  ok('float sum: not silently a different magnitude', Math.abs(got - want) < 1e-6 * Math.abs(want));
  if (!Object.is(want, got)) {
    console.log(`     note: float sum differs in the last ULPs (js ${want} vs duckdb ${got}) — parallel summation order, documented`);
  }

  // min/max/count are exact even on fractional data — no summation involved.
  for (const agg of ['count', 'min', 'max'] as metricValue.MetricAggregation[]) {
    const w = metricValue.computeMetric(f.columns, f.rows, { column: 'v', aggregation: agg });
    const g = rq.computeMetricResident(f.src, { column: 'v', aggregation: agg });
    ok(`float data: ${agg} is EXACT`, Object.is(w, g));
  }
}

// ── 13. The OTHER semantic that could not be reproduced: string collation ───
//
// An ORDERING filter (< > <= >=) on a text column compares UTF-16 code units in
// JS and UTF-8 bytes in DuckDB. Identical across the BMP; inverted for astral
// characters. Equality, inequality and `contains` are unaffected. This test
// pins BOTH halves: the safe operators must match exactly, and the divergence
// must still be exactly where it is documented — if someone later "fixes" the
// collation, or if a NEW divergence appears in `=`, this test says so.
{
  const cols: ParsedColumn[] = [
    { name: 's', type: 'text' },
    { name: 'v', type: 'number' },
  ];
  const f = fixture(cols, [
    ['�', 1],
    ['\u{10000}', 2],
    ['a', 4],
    ['é', 8],
    ['', 16],
  ]);
  for (const op of ['=', '!=', 'contains'] as FilterStep['op'][]) {
    for (const needle of ['\u{10000}', 'é', 'a', '']) {
      diffMetric(`astral ${op} ${JSON.stringify(needle)}`, f, 'v', [
        { type: 'filter', column: 's', op, value: needle },
      ]);
    }
  }
  // BMP-only ordering agrees.
  diffMetric('BMP ordering filter', f, 'v', [{ type: 'filter', column: 's', op: '>', value: 'a' }]);

  // The documented divergence, asserted as a DIVERGENCE so it cannot rot.
  const astral: FilterStep[] = [{ type: 'filter', column: 's', op: '>', value: '�' }];
  const jsAnswer = metricValue.computeMetric(f.columns, applyFilters(f, astral), {
    column: 'v',
    aggregation: 'sum',
  });
  const resAnswer = rq.computeMetricResident(f.src, { column: 'v', aggregation: 'sum' }, astral);
  ok('astral ordering: JS (UTF-16 code units) keeps no row', jsAnswer === null);
  ok('astral ordering: DuckDB (UTF-8 bytes) keeps the astral row — KNOWN DIVERGENCE', resAnswer === 2);
}

// ── 14. Failure modes never throw ──────────────────────────────────────────
{
  const missing: rq.ResidentSource = {
    parquetPath: path.join(dir, 'does-not-exist.parquet'),
    columns: [{ name: 'a', type: 'number' }],
  };
  ok('missing file: metric → null', rq.computeMetricResident(missing, { column: 'a', aggregation: 'sum' }) === null);
  ok('missing file: aggregate → null', rq.aggregateResident(missing, 'a', [{ column: 'a', aggregation: 'sum' }]) === null);

  const junk = path.join(dir, 'junk.parquet');
  fs.writeFileSync(junk, 'not parquet at all');
  const bad: rq.ResidentSource = { parquetPath: junk, columns: [{ name: 'a', type: 'number' }] };
  ok('corrupt file: metric → null', rq.computeMetricResident(bad, { column: 'a', aggregation: 'sum' }) === null);
  ok('corrupt file: aggregate → null', rq.aggregateResident(bad, 'a', [{ column: 'a', aggregation: 'sum' }]) === null);

  const badPath: rq.ResidentSource = { parquetPath: '/tmp/x.csv', columns: [{ name: 'a', type: 'number' }] };
  ok('non-.parquet path → null, no throw', rq.computeMetricResident(badPath, { column: 'a', aggregation: 'sum' }) === null);

  ok(
    'empty schema → null',
    rq.computeMetricResident({ parquetPath: missing.parquetPath, columns: [] }, { column: 'a', aggregation: 'sum' }) === null,
  );
  ok(
    'malformed source → null',
    rq.computeMetricResident(null as unknown as rq.ResidentSource, { column: 'a', aggregation: 'sum' }) === null,
  );
  ok(
    'malformed spec → null',
    rq.computeMetricResident(missing, null as unknown as { column: string; aggregation: metricValue.MetricAggregation }) === null,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

cleanup();
duck.shutdown();
if (failures > 0) {
  console.error(`\n${failures} residentQuery check(s) failed`);
  process.exit(1);
}
console.log('\nAll residentQuery checks passed.');
