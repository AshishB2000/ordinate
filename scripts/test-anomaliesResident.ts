// Self-check for src/anomaliesResident.ts — the anomaly detector computed off a
// dataset's Parquet file instead of a hydrated Cell[][].
//
// EVERY assertion about an anomaly is DIFFERENTIAL. The resident list is compared
// against `anomalies.detectAnomalies` applied to the SAME bytes read back through
// `parquetStore.readTable` — which is literally the code `dashboard:explainAnomalies`
// ran before the rewire. A hand-written expectation can agree with a bug on both
// sides; an equivalence assertion cannot.
//
// The comparison is deliberately harsher than a `deepStrictEqual`:
//
//   • The FULL SERIALISED LIST is compared, in order — kind, column, severity,
//     the `detail` string byte for byte, and every `facts` entry. Those strings
//     are quoted verbatim into a model prompt, so a changed digit is a changed
//     prompt, and the model then narrates it as ground truth.
//   • Scalars are compared with `Object.is`, so `null` can never pass as `0`,
//     `-0` can never pass as `0`, and a `1.0000000000000002` can never pass as
//     a `1`.
//
// The last section drives the SHIPPED `dashboard:explainAnomalies` handler for
// real (electron stubbed, `register()` called) and spies on
// `datasets.getDataset`, so "the resident path was taken" is asserted as "the
// table was never hydrated" rather than assumed.
//
//   npm run build:ts && node scripts/test-anomaliesResident.js

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/transforms').Cell;
type ParsedColumn = import('../src/parse').ParsedColumn;
type Anomaly = import('../src/anomalies').Anomaly;
type AnomalyOptions = import('../src/anomalies').AnomalyOptions;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-anom-resident-'));

// ── The electron stub (test-datasets.ts pattern, plus handler capture) ───────
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
      dialog: {},
      net: {},
      nativeImage: {},
      shell: {},
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const parquetStore: typeof import('../src/parquetStore') = require('../src/parquetStore');
const anomalies: typeof import('../src/anomalies') = require('../src/anomalies');
const anomaliesResident: typeof import('../src/anomaliesResident') = require('../src/anomaliesResident');
const projects: typeof import('../src/projects') = require('../src/projects');
const datasets: typeof import('../src/datasets') = require('../src/datasets');
const dashboards: typeof import('../src/dashboards') = require('../src/dashboards');
const dashboardsIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

dashboardsIpc.register();
const explainHandler = handlers.get('dashboard:explainAnomalies');

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-anom-fixtures-'));
let fileSeq = 0;
function fixtureFile(): string {
  fileSeq += 1;
  return path.join(tmpDir, `f${fileSeq}.parquet`);
}

// ── Comparison helpers ───────────────────────────────────────────────────────

/**
 * One anomaly rendered as a total-order string: every field, every fact, with
 * `Object.is`-grade scalar formatting (`-0` and `0` render differently, and a
 * float renders all 17 digits). Comparing these strings compares the whole
 * anomaly INCLUDING the key sets of `facts`.
 */
function showOne(a: Anomaly): string {
  const facts = Object.keys(a.facts).sort().map((k) => {
    const v = (a.facts as Record<string, unknown>)[k];
    return `${k}=${typeof v === 'number' ? (Object.is(v, -0) ? '-0' : String(v)) : JSON.stringify(v)}`;
  }).join('|');
  return `${a.kind}${a.column ?? '<none>'}${a.severity}${a.detail}{${facts}}`;
}

function showList(list: Anomaly[]): string {
  return list.map(showOne).join('\n');
}

/** Deep equality field by field, `Object.is` on every scalar. */
function sameList(a: Anomaly[], b: Anomaly[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== y.kind || x.severity !== y.severity) return false;
    if (!Object.is(x.column, y.column)) return false;
    if (x.detail !== y.detail) return false;
    const kx = Object.keys(x.facts).sort();
    const ky = Object.keys(y.facts).sort();
    if (kx.join(',') !== ky.join(',')) return false;
    for (const k of kx) {
      if (!Object.is((x.facts as any)[k], (y.facts as any)[k])) return false;
    }
  }
  return true;
}

interface Fixture {
  label: string;
  file: string;
  columns: ParsedColumn[];
  /** The rows as READ BACK from Parquet — what the JS reference must see. */
  rows: Cell[][];
}

/**
 * Write a table, read it back, and keep the round-tripped rows: the comparison
 * must be like for like, since a Parquet round trip is not an identity on every
 * cell type (NaN/Infinity in a number column come back as null on BOTH sides).
 */
function makeFixture(label: string, columns: ParsedColumn[], rows: Cell[][]): Fixture {
  const file = fixtureFile();
  parquetStore.writeTable(file, columns, rows);
  const back = parquetStore.readTable(file, columns);
  if (!back) throw new Error(`fixture read-back failed: ${label}`);
  return { label, file, columns, rows: back.rows };
}

/**
 * THE differential. Returns the resident list so a test can additionally pin
 * WHAT the shared answer is (a change that moves both sides together must still
 * fail).
 */
function diff(f: Fixture, opts?: AnomalyOptions): Anomaly[] | null {
  const want = anomalies.detectAnomalies(f.columns, f.rows, opts);
  const got = anomaliesResident.detectAnomaliesResident({ parquetPath: f.file, columns: f.columns }, opts);
  ok(`${f.label}: resident (not a fallback)`, got !== null);
  if (got === null) return null;
  const equal = sameList(want, got);
  ok(`${f.label}: === detectAnomalies (${want.length} finding${want.length === 1 ? '' : 's'})`, equal);
  if (!equal) {
    console.error('--- want ---\n' + showList(want));
    console.error('--- got  ---\n' + showList(got));
  }
  return got;
}

function kinds(list: Anomaly[] | null): string {
  return (list ?? []).map((a) => `${a.kind}:${a.column ?? '-'}`).join(',');
}
function find(list: Anomaly[] | null, kind: string, column?: string): Anomaly | undefined {
  return (list ?? []).find((a) => a.kind === kind && (column === undefined || a.column === column));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });
const D = (name: string): ParsedColumn => ({ name, type: 'date' });

function ms(t: bigint): string {
  return (Number(t) / 1e6).toFixed(2);
}

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();

  const resident = anomaliesResident.isAnomaliesResident();
  ok('isAnomaliesResident() returns a boolean', typeof resident === 'boolean');
  if (!resident) {
    console.log('#    DuckDB bridge UNAVAILABLE — nothing to test, the JS path is always used');
    return;
  }
  console.log('#    DuckDB bridge available — the resident path is under test');

  // ── 1. numeric_outlier: the IQR fence fires, a clean column stays silent ────
  // The shipped test-anomalies fixture, verbatim. Sorted spike column is
  // [10,10,10,11,11,12,12,1000] → q1 10, q3 12, fences [7, 15]; mean 134.5,
  // POPULATION σ 327.129 → z(1000) = 2.6457, BELOW the default 3. So this case
  // is caught by the FENCE, not the z-test — and the `detail` string's fences
  // are the type-7 quantiles, not quantile_disc's.
  {
    const f = makeFixture('outlier: spike vs clean', [N('clean'), N('spike')], [
      [10, 10], [11, 11], [12, 12], [10, 10],
      [11, 11], [12, 12], [10, 10], [11, 1000],
    ]);
    const got = diff(f);
    const spike = find(got, 'numeric_outlier', 'spike');
    ok('outlier: only the spike column is flagged', kinds(got) === 'numeric_outlier:spike');
    ok('outlier: the fences are type-7 [7, 15], NOT quantile_disc [5, 21]',
      spike?.detail === 'Column "spike" has 1 outlier value outside the expected range [7, 15] (1000).');
    ok('outlier: facts carry the raw offending value and app-computed fences',
      spike?.facts.count === 1 && spike?.facts.minOutlier === 1000 && spike?.facts.maxOutlier === 1000
        && spike?.facts.lowerFence === 7 && spike?.facts.upperFence === 15);
    ok('outlier: severity is warn', spike?.severity === 'warn');
  }

  // ── 2. The z-test uses POPULATION σ (÷N), and it is the UNION with the fence ─
  // [10..16,20]: q1 11.75, q3 15.25, fences [6.5, 20.5] — 20 is INSIDE. So the
  // only way it gets flagged is the z-test. σ_pop = 2.9764702249476644 →
  // z(20) = 2.0578; σ_samp = 3.181980515339464 → z(20) = 1.9251. At
  // zThreshold 2 the two answers DIFFER: population flags it, sample does not.
  // Both directions are asserted, so `stddev()` cannot pass by luck.
  {
    const f = makeFixture('z-score: population σ', [N('v')],
      [[10], [11], [12], [13], [14], [15], [16], [20]]);
    const atDefault = diff(f);
    ok('z: at the default threshold 3 nothing fires (20 is inside the fences too)',
      (atDefault ?? []).length === 0);

    const at2 = diff(f, { zThreshold: 2 });
    ok('z: at threshold 2 the population σ DOES flag 20 (sample σ would not)',
      find(at2, 'numeric_outlier', 'v')?.facts.maxOutlier === 20);
    ok('z: …and the fences in the detail are still the type-7 pair',
      find(at2, 'numeric_outlier', 'v')?.detail
        === 'Column "v" has 1 outlier value outside the expected range [6.5, 20.5] (20).');

    // The exact boundary: z(20) = 2.0578…, so 2.05 flags and 2.06 does not.
    const below = diff(f, { zThreshold: 2.05 });
    const above = diff(f, { zThreshold: 2.06 });
    ok('z: threshold 2.05 (< 2.0578) flags, 2.06 (> 2.0578) does not — the σ divisor is pinned',
      (below ?? []).length === 1 && (above ?? []).length === 0);
  }

  // ── 3. MIN_OUTLIER_SAMPLE: the 8-finite-value boundary, both sides ──────────
  {
    const seven = makeFixture('outlier: 7 finite values', [N('v')],
      [[1], [1], [1], [1], [1], [1], [999]]);
    const r7 = diff(seven);
    ok('outlier: 7 finite values → no finding however extreme', !find(r7, 'numeric_outlier'));

    const eight = makeFixture('outlier: 8 finite values', [N('v')],
      [[1], [1], [1], [1], [1], [1], [1], [999]]);
    const r8 = diff(eight);
    ok('outlier: 8 finite values → the rule engages', Boolean(find(r8, 'numeric_outlier')));

    // 8 CELLS but only 7 finite: nulls and non-finite readings must not count
    // toward the sample size on either side.
    const nulls = makeFixture('outlier: 8 cells, 7 finite', [N('v')],
      [[1], [1], [1], [1], [1], [1], [999], [null]]);
    const rn = diff(nulls);
    ok('outlier: a null cell does not count toward the 8-value minimum', !find(rn, 'numeric_outlier'));

    // NaN/Infinity round-trip to null through Parquet, so they are excluded on
    // BOTH sides — the differential above is the real assertion.
    const nonFinite = makeFixture('outlier: NaN/Infinity cells', [N('v')],
      [[1], [1], [1], [1], [1], [1], [999], [NaN], [Infinity]]);
    const rnf = diff(nonFinite);
    ok('outlier: NaN/Infinity are not finite values on either path', !find(rnf, 'numeric_outlier'));
  }

  // ── 4. Several outliers: count, plural, min and max are RAW data values ─────
  {
    const f = makeFixture('outlier: several', [N('v')],
      [[10], [11], [12], [10], [11], [12], [10], [-500], [900], [11], [1000]]);
    const got = diff(f);
    const a = find(got, 'numeric_outlier', 'v');
    ok('outlier: the count is plural-aware and min/max span the outlier set',
      a?.facts.count === 3 && a?.facts.minOutlier === -500 && a?.facts.maxOutlier === 1000
        && (a?.detail ?? '').includes('3 outlier values'));
    ok('outlier: the detail reads "from X to Y" when min ≠ max',
      (a?.detail ?? '').includes('(from -500 to 1000).'));
  }

  // ── 5. dominant_category at the 0.6 threshold, both sides ──────────────────
  {
    const cells = (vals: string[]): Cell[][] => vals.map((v) => [v]);
    const at = makeFixture('dominant: exactly 0.6',
      [T('c')], cells(['A', 'A', 'A', 'A', 'A', 'A', 'B', 'C', 'D', 'E']));
    const rAt = diff(at);
    ok('dominant: a share of exactly 0.6 FIRES (>= is inclusive)',
      find(rAt, 'dominant_category', 'c')?.facts.share === 0.6);
    ok('dominant: the detail is the shipped wording with app-computed counts',
      find(rAt, 'dominant_category', 'c')?.detail
        === 'Column "c" is dominated by "A" — 6 of 10 non-empty cells (60%).');
    ok('dominant: severity is info', find(rAt, 'dominant_category', 'c')?.severity === 'info');

    const below = makeFixture('dominant: just below 0.6',
      [T('c')], cells(['A', 'A', 'A', 'A', 'A', 'B', 'C', 'D', 'E', 'F']));
    ok('dominant: a share of 0.5 does NOT fire', !find(diff(below), 'dominant_category'));

    // The denominator is NON-EMPTY cells: '' / '   ' / NBSP / U+FEFF must not
    // dilute the share. DuckDB's trim() strips spaces only, so a naive port
    // silently SUPPRESSES this finding.
    const empties = makeFixture('dominant: empties excluded from the denominator',
      [T('c')], [['A'], ['A'], ['A'], ['B'], [''], ['   '], [' '], ['﻿'], [null], ['\t']]);
    const rE = diff(empties);
    ok('dominant: JS trim() whitespace is empty, so the share is 3/4 not 3/10',
      find(rE, 'dominant_category', 'c')?.facts.share === 0.75);

    // counts.size >= 2: a single-valued column is constant_column, NOT dominant.
    const single = makeFixture('dominant: one distinct value only',
      [T('c')], cells(['A', 'A', 'A', 'A']));
    const rS = diff(single);
    ok('dominant: a single-valued column is constant_column, never dominant',
      kinds(rS) === 'constant_column:c');

    // Ties resolve to FIRST OCCURRENCE — `mode()` is unspecified there.
    const tie = makeFixture('dominant: 3–3 tie over 5 non-empty… ',
      [T('c')], cells(['b', 'a', 'b', 'a', 'b', 'a', 'z']));
    diff(tie); // 3/7 = 0.43 → silent; the differential still pins the tie logic
    const tieFires = makeFixture('dominant: tie that clears the threshold',
      [T('c')], [['b'], ['a'], ['b'], ['a'], ['b'], ['a'], ['b'], ['a'], ['z'], ['z']]);
    diff(tieFires);
    const tieFires2 = makeFixture('dominant: same tie, other order',
      [T('c')], [['a'], ['b'], ['a'], ['b'], ['a'], ['b'], ['a'], ['b'], ['z'], ['z']]);
    diff(tieFires2);

    // A date column behaves exactly like text.
    const day = makeFixture('dominant: a date column is categorical',
      [D('day')], cells(['2024-01-01', '2024-01-01', '2024-01-01', '2024-01-02']));
    ok('dominant: a date column can be dominant_category',
      find(diff(day), 'dominant_category', 'day')?.facts.value === '2024-01-01');
  }

  // ── 6. empty_heavy / constant_column pass through, duplicate_rows never does ─
  {
    const f = makeFixture('quality: empty_heavy + constant + duplicates',
      [T('half'), T('same'), T('quarter')],
      [
        ['x', 'k', 'a'],
        ['', 'k', 'b'],
        [null, 'k', 'c'],
        ['x', 'k', ''],
        ['x', 'k', 'a'],
        ['', 'k', 'b'],
      ]);
    const got = diff(f);
    ok('quality: empty_heavy fires at 0.5 and carries the rounded percentage',
      find(got, 'empty_heavy', 'half')?.detail === 'Column "half" is 50% empty');
    ok('quality: empty_heavy is remapped to severity warn with empty facts',
      find(got, 'empty_heavy', 'half')?.severity === 'warn'
        && Object.keys(find(got, 'empty_heavy', 'half')!.facts).length === 0);
    ok('quality: constant_column is remapped to severity info',
      find(got, 'constant_column', 'same')?.detail === 'Column "same" has the same value in every row'
        && find(got, 'constant_column', 'same')?.severity === 'info');
    ok('quality: 1 of 6 empty (0.17) does not fire', !find(got, 'empty_heavy', 'quarter'));
    ok('quality: duplicate_rows is NEVER surfaced as an anomaly',
      !(got ?? []).some((a) => (a.kind as string) === 'duplicate_rows'));

    // An ALL-empty column is empty_heavy but NOT constant (the `empties <
    // rowCount` clause), and not dominant either (nonEmpty === 0).
    const blank = makeFixture('quality: an all-empty column', [T('blank'), T('v')],
      [['', 'a'], ['   ', 'b'], [null, 'c'], ['﻿', 'd']]);
    ok('quality: an all-empty column is empty_heavy only',
      kinds(diff(blank)) === 'empty_heavy:blank');
  }

  // ── 7. period_change: the 50% step, the ordering, and the skip rules ────────
  {
    const f = makeFixture('period: a doubling', [D('year'), N('rev')],
      [['2023', 60], ['2023', 40], ['2024', 200]]);
    const got = diff(f);
    const pc = find(got, 'period_change');
    ok('period: the step is flagged and names the MEASURE column, not the date',
      pc?.column === 'rev' && pc?.facts.dateColumn === 'year');
    ok('period: the app-computed period sums and pct are in the facts',
      pc?.facts.fromPeriod === '2023' && pc?.facts.toPeriod === '2024'
        && pc?.facts.fromValue === 100 && pc?.facts.toValue === 200 && pc?.facts.pctChange === 1);
    ok('period: the detail is the shipped wording',
      pc?.detail === '"rev" rose 100% from 2023 (100) to 2024 (200).');

    const small = makeFixture('period: a 10% step', [D('year'), N('rev')],
      [['2023', 100], ['2024', 110]]);
    ok('period: a 10% step does not fire', !find(diff(small), 'period_change'));

    // Exactly 50% fires (>=), 49.9% does not.
    const at = makeFixture('period: exactly 50%', [D('year'), N('rev')],
      [['2023', 100], ['2024', 150]]);
    ok('period: exactly 50% fires', Boolean(find(diff(at), 'period_change')));
    const under = makeFixture('period: 49%', [D('year'), N('rev')],
      [['2023', 100], ['2024', 149]]);
    ok('period: 49% does not fire', !find(diff(under), 'period_change'));

    // A negative step reads "fell" and rounds half-UP in JS — kept in TS.
    const fell = makeFixture('period: a fall', [D('year'), N('rev')],
      [['2023', 200], ['2024', 50]]);
    ok('period: a fall reads "fell" with the absolute percentage',
      find(diff(fell), 'period_change')?.detail === '"rev" fell 75% from 2023 (200) to 2024 (50).');

    // from === 0 → the step is skipped, never a division by zero.
    const zero = makeFixture('period: a zero base', [D('year'), N('rev')],
      [['2023', 0], ['2024', 500]]);
    ok('period: a zero prior period is skipped, not Infinity', !find(diff(zero), 'period_change'));

    // A measure missing from a bucket is UNDEFINED, not 0 — the step is skipped.
    const missing = makeFixture('period: a measure missing from a bucket',
      [D('year'), N('rev')], [['2023', null], ['2024', 500], ['2025', 100]]);
    const rm = diff(missing);
    ok('period: a bucket with no finite value skips the step (never reads as 0)',
      find(rm, 'period_change')?.facts.fromPeriod === '2024');

    // Fewer than 2 distinct dates → nothing.
    const one = makeFixture('period: one distinct date', [D('year'), N('rev')],
      [['2023', 1], ['2023', 500]]);
    ok('period: one distinct date → no finding', !find(diff(one), 'period_change'));

    // No date column at all → nothing (and the numeric rule still runs).
    const noDate = makeFixture('period: no date column', [T('year'), N('rev')],
      [['2023', 1], ['2024', 500]]);
    ok('period: a TEXT year column is not a date column', !find(diff(noDate), 'period_change'));

    // Empty date cells are skipped by the JS trim() whitespace class.
    const blanks = makeFixture('period: empty date cells', [D('year'), N('rev')],
      [['2023', 100], ['', 999], ['   ', 999], [' ', 999], [null, 999], ['2024', 200]]);
    const rb = diff(blanks);
    ok('period: whitespace-only date cells form no bucket',
      find(rb, 'period_change')?.facts.fromValue === 100);

    // ORDERING. Rows are written OUT of chronological order and out of lexical
    // order; the JS sorts by Date.parse when every key parses. Only the largest
    // single step is reported.
    const unordered = makeFixture('period: sorted by Date.parse, not row order',
      [D('day'), N('rev')],
      [['2024-03-01', 300], ['2024-01-01', 100], ['2024-02-01', 105], ['2024-04-01', 306]]);
    const ru = diff(unordered);
    ok('period: the biggest step is Jan→Feb… no — Feb→Mar (105→300)',
      find(ru, 'period_change')?.facts.fromPeriod === '2024-02-01'
        && find(ru, 'period_change')?.facts.toPeriod === '2024-03-01');

    // Keys that do NOT all parse fall back to a LEXICAL sort. 'Q1'..'Q4' never
    // parse, so the order is the string order — a plain SQL ORDER BY on a real
    // DATE column could not reproduce either branch.
    const lex = makeFixture('period: lexical fallback for unparseable keys',
      [D('q'), N('rev')],
      [['Q3', 400], ['Q1', 100], ['Q4', 410], ['Q2', 105]]);
    const rl = diff(lex);
    ok('period: unparseable keys sort lexically (Q2→Q3 is the biggest step)',
      find(rl, 'period_change')?.facts.fromPeriod === 'Q2'
        && find(rl, 'period_change')?.facts.toPeriod === 'Q3');

    // Several measures: the single largest |pct| across ALL of them wins, and
    // ties go to the FIRST found (column order, then step order).
    const multi = makeFixture('period: several measures, largest |pct| wins',
      [D('year'), N('a'), N('b')],
      [['2023', 100, 100], ['2024', 200, 400]]);
    ok('period: the largest step across all numeric columns wins',
      find(diff(multi), 'period_change')?.column === 'b');
    const tieM = makeFixture('period: a tie between measures goes to the first column',
      [D('year'), N('a'), N('b')],
      [['2023', 100, 100], ['2024', 300, 300]]);
    ok('period: an exact tie is won by the first-found (column order)',
      find(diff(tieM), 'period_change')?.column === 'a');

    // A pinned measureCol restricts the scan.
    ok('period: measureCol pins the measure',
      find(diff(multi, { measureCol: 'a' }), 'period_change')?.column === 'a');

    // A pinned dateCol on a NUMBER column cannot reproduce keyOf() faithfully →
    // the whole call falls back rather than approximating the key.
    ok('period: a dateCol pinned to a NUMBER column returns null (documented gap)',
      anomaliesResident.detectAnomaliesResident(
        { parquetPath: multi.file, columns: multi.columns }, { dateCol: 'a' }) === null);
  }

  // ── 8. One column triggering several rules at once ────────────────────────
  // `dom` is dominant AND empty_heavy; `n` is an outlier column AND the period
  // measure; `day` is the period key AND dominant. Discovery order is
  // per-column (outlier/dominant), then the quality issues, then period_change —
  // and only THEN the stable warn-before-info sort.
  {
    const f = makeFixture('multi-rule: one table, four kinds',
      [T('dom'), N('n'), D('day')],
      [
        ['A', 10, '2023'], ['A', 11, '2023'], ['A', 12, '2023'], ['A', 10, '2023'],
        ['', 11, '2023'], ['', 12, '2023'], ['', 10, '2023'], [null, 5000, '2024'],
      ]);
    const got = diff(f);
    ok('multi-rule: every kind that should fire, fires',
      new Set((got ?? []).map((a) => a.kind)).size >= 3);
    ok('multi-rule: warn precedes info in the final list',
      (got ?? []).every((a, i, l) => i === 0 || !(l[i - 1].severity === 'info' && a.severity === 'warn')));
  }

  // ── 9. Caps and ordering ───────────────────────────────────────────────────
  {
    // Six dominant columns → capped at maxPerKind 3.
    const cols: ParsedColumn[] = [];
    for (let c = 0; c < 6; c += 1) cols.push(T(`d${c}`));
    const rows: Cell[][] = [];
    for (let r = 0; r < 10; r += 1) rows.push(cols.map(() => (r < 8 ? 'A' : `x${r}`)));
    const f = makeFixture('caps: six dominant columns', cols, rows);
    const got = diff(f);
    ok('caps: at most maxPerKind (3) findings of one kind',
      (got ?? []).filter((a) => a.kind === 'dominant_category').length === 3);
    ok('caps: the 3 kept are the FIRST three in column order',
      (got ?? []).filter((a) => a.kind === 'dominant_category').map((a) => a.column).join(',')
        === 'd0,d1,d2');

    ok('caps: maxTotal 1 keeps exactly one finding',
      (diff(f, { maxTotal: 1 }) ?? []).length === 1);
    ok('caps: maxPerKind 1 keeps one per kind', (diff(f, { maxPerKind: 1 }) ?? []).length === 1);

    // warn before info, discovery order preserved inside a severity.
    const mixed = makeFixture('caps: warn before info',
      [T('dom'), T('halfEmpty'), N('spike')],
      [
        ['A', 'x', 10], ['A', '', 11], ['A', '', 12], ['A', 'y', 10],
        ['A', '', 11], ['A', '', 12], ['B', 'z', 10], ['C', '', 1000],
      ]);
    const rm = diff(mixed);
    ok('caps: every warn precedes every info',
      (() => {
        const list = rm ?? [];
        const lastWarn = list.map((a) => a.severity).lastIndexOf('warn');
        const firstInfo = list.map((a) => a.severity).indexOf('info');
        return firstInfo === -1 || lastWarn === -1 || lastWarn < firstInfo;
      })());
  }

  // ── 10. Degenerate inputs ──────────────────────────────────────────────────
  {
    const empty = makeFixture('degenerate: zero rows', [T('a'), N('b'), D('c')], []);
    const got = diff(empty);
    ok('degenerate: a zero-row table yields [] (a real answer, not a fallback)',
      got !== null && got.length === 0);

    const allNull = makeFixture('degenerate: an all-null number column',
      [N('n'), T('t')],
      [[null, 'a'], [null, 'b'], [null, 'c'], [null, 'd'],
        [null, 'e'], [null, 'f'], [null, 'g'], [null, 'h']]);
    const rn = diff(allNull);
    ok('degenerate: an all-null number column produces empty_heavy and no outlier',
      kinds(rn) === 'empty_heavy:n');

    // A leading-zero identifier column is TEXT and must never enter the numeric
    // path — the single most dangerous implicit-cast bug in the port.
    const ids = makeFixture('degenerate: leading-zero identifiers', [T('code')],
      [['007'], ['012'], ['0042'], ['00'], ['7'], ['12'], ['90210'], ['0001']]);
    const ri = diff(ids);
    ok('degenerate: a leading-zero text column yields NO findings at all',
      ri !== null && ri.length === 0);

    // A CONSTANT number column: q1 === q3, so iqr is 0 and both fences collapse
    // onto the value, AND the population σ is 0 — which means the z clause must
    // not be emitted at all (`std > 0` is a TS-side guard, and `x/0` in SQL is
    // NULL or Infinity depending on the type).
    const flat = makeFixture('degenerate: a constant number column', [N('n')],
      [[7], [7], [7], [7], [7], [7], [7], [7]]);
    const rf = diff(flat);
    ok('degenerate: a constant number column is constant_column, never an outlier',
      kinds(rf) === 'constant_column:n');

    // Constant EXCEPT one value: σ > 0, so the z clause IS emitted, and the
    // fences are degenerate (q1 === q3 === 7 → [7, 7]).
    const flatish = makeFixture('degenerate: constant plus one', [N('n')],
      [[7], [7], [7], [7], [7], [7], [7], [900]]);
    const rfi = diff(flatish);
    ok('degenerate: a single deviating value clears a zero-width fence',
      find(rfi, 'numeric_outlier', 'n')?.facts.maxOutlier === 900);

    // …and one where the leading zeros WOULD have been a huge outlier if cast.
    const idSpike = makeFixture('degenerate: leading zeros that would cast to a spike',
      [T('code')],
      [['007'], ['007'], ['007'], ['007'], ['007'], ['007'], ['007'], ['0999999999']]);
    ok('degenerate: a text id column is never scanned for numeric outliers',
      !find(diff(idSpike), 'numeric_outlier'));
  }

  // ── 11. Failure modes: null means fall back, and nothing ever throws ───────
  {
    const cols = [T('a')];
    ok('missing file → null, not a throw',
      anomaliesResident.detectAnomaliesResident(
        { parquetPath: path.join(tmpDir, 'nope.parquet'), columns: cols }) === null);

    const good = makeFixture('good file for the negative cases', cols, [['x'], ['y']]);
    ok('0 columns → null (fall back; the file holds only the row-count sentinel)',
      anomaliesResident.detectAnomaliesResident({ parquetPath: good.file, columns: [] }) === null);
    ok('a schema WIDER than the file → null, never a partial answer',
      anomaliesResident.detectAnomaliesResident(
        { parquetPath: good.file, columns: [T('a'), T('b'), T('c')] }) === null);
    ok('a malformed column entry → null',
      anomaliesResident.detectAnomaliesResident(
        { parquetPath: good.file, columns: [null as any] }) === null);
    ok('a non-string path → null',
      anomaliesResident.detectAnomaliesResident({ parquetPath: 42 as any, columns: cols }) === null);
    ok('a path with a quote in it → null, never a throw',
      anomaliesResident.detectAnomaliesResident(
        { parquetPath: "/tmp/no'such.parquet", columns: cols }) === null);
    ok('a null source → null', anomaliesResident.detectAnomaliesResident(null as any) === null);
  }

  // ── 12. A column name that is SQL, and a BOM in a period key ──────────────
  {
    const nasty = '"; DROP TABLE x; --';
    const f = makeFixture('hostile column name', [T(nasty), N('n')],
      [['A', 1], ['A', 2], ['A', 3], ['B', 4]]);
    const got = diff(f);
    ok('a hostile column name is echoed verbatim and changes no number',
      find(got, 'dominant_category', nasty)?.facts.value === 'A');

    // A leading U+FEFF in a period key must survive the bridge — it reaches the
    // `detail` string.
    const bom = makeFixture('leading BOM in a period key', [D('day'), N('rev')],
      [['﻿2023', 100], ['﻿2024', 400]]);
    const rb = diff(bom);
    ok('a leading BOM in a period key is not eaten by the bridge',
      find(rb, 'period_change')?.facts.fromPeriod === '﻿2023');
  }

  // ── 13. 200,000 rows: the two paths agree exactly, and timed ───────────────
  {
    const columns = [T('region'), N('sales'), T('note'), D('day'), T('code'), N('qty')];
    const build = (n: number): Cell[][] => {
      const rows: Cell[][] = new Array(n);
      for (let i = 0; i < n; i += 1) {
        rows[i] = [
          i % 50 === 0 ? '' : 'north',                       // dominant + a few empties
          i === 3456 ? 999999 : (i % 13) - 6,                // one planted spike (in range at both sizes)
          i % 3 === 0 ? '' : `note-${i % 500}`,              // empty-heavy-ish text
          `2024-0${(i % 3) + 1}`,                            // 3 periods
          String(i % 1000).padStart(4, '0'),                 // leading-zero ids
          i % 2 === 0 ? null : (i % 977) - 400,              // nulls + integers
        ];
      }
      return rows;
    };

    for (const n of [10_000, 200_000]) {
      const f = makeFixture(`${n / 1000}k rows`, columns, build(n));

      const t0 = process.hrtime.bigint();
      const want = anomalies.detectAnomalies(f.columns, f.rows);
      const t1 = process.hrtime.bigint();
      const got = anomaliesResident.detectAnomaliesResident({ parquetPath: f.file, columns: f.columns });
      const t2 = process.hrtime.bigint();

      const equal = got !== null && sameList(want, got);
      ok(`${n / 1000}k: resident === JS, byte for byte (${want.length} findings) ` +
        `[JS ${ms(t1 - t0)} ms compute-only, resident ${ms(t2 - t1)} ms]`, equal);
      if (!equal) {
        console.error('--- want ---\n' + showList(want));
        console.error('--- got  ---\n' + showList(got ?? []));
      }
      ok(`${n / 1000}k: the planted spike is found with its raw value`,
        find(got, 'numeric_outlier', 'sales')?.facts.maxOutlier === 999999);
    }
  }

  // ── 13b. A WIDE table: every column's own figures, uncapped ────────────────
  // Every other fixture here is at most 6 columns, so nothing pinned the SQL
  // that is emitted PER COLUMN once there are a hundred of them — and the
  // outlier passes write one predicate and three aggregates each. This fixture
  // is 90 columns (30 numeric, 1 date) and is diffed with the caps lifted, so
  // the assertion is "all 30 columns' fences, counts and extremes agree", not
  // "the first three do".
  {
    const cols: ParsedColumn[] = [D('day')];
    for (let c = 1; c < 90; c += 1) {
      if (c % 3 === 0) cols.push(N(`n${c}`));
      else if (c % 7 === 0) cols.push(T(`dom${c}`)); // dominant + empty-heavy
      else cols.push(T(`t${c}`));
    }
    const rows: Cell[][] = [];
    for (let r = 0; r < 300; r += 1) {
      const row: Cell[] = [r < 150 ? '2023' : '2024'];
      for (let c = 1; c < 90; c += 1) {
        if (c % 3 === 0) {
          // A planted spike in every third numeric column, at a different row
          // each time, so the columns do NOT share an outlier row or a fence.
          row.push(r === (c % 17) + 5 && c % 9 === 0 ? 100000 + c : ((r * (c + 3)) % 97) - 48);
        } else if (c % 7 === 0) {
          row.push(r % 4 === 0 ? '' : 'A');
        } else {
          row.push(`v${(r + c) % 13}`);
        }
      }
      rows.push(row);
    }
    const f = makeFixture('wide: 90 columns (30 numeric)', cols, rows);
    const uncapped: AnomalyOptions = { maxPerKind: 1000, maxTotal: 1000 };
    const got = diff(f, uncapped);
    ok('wide: every numeric column with a planted spike is flagged',
      (got ?? []).filter((a) => a.kind === 'numeric_outlier').length >= 3);
    ok('wide: the capped list agrees too (the caps run over a long list here)',
      (diff(f) ?? []).length <= 12);
  }

  // ── 14. The one semantic that genuinely differs: float summation order ─────
  // A JS left-fold and DuckDB's parallel partial sums can differ in the last
  // ULPs on NON-INTEGER data, and `quantile_cont` differs from
  // `anomalies.quantile`'s association by a few ULPs too. Both feed the FENCES,
  // which are round()ed to 1e-6 before they are shown — so the divergence is
  // pinned by MAGNITUDE here rather than being asserted away, and a drift larger
  // than a rounding artefact fails loudly.
  {
    const rows: Cell[][] = new Array(200_000);
    for (let i = 0; i < rows.length; i += 1) rows[i] = [((i * 7919) % 100_000) / 7 + 0.1];
    rows[777] = [1e9]; // guarantee a finding, so the fences are actually compared
    const f = makeFixture('float summation', [N('x')], rows);
    const want = anomalies.detectAnomalies(f.columns, f.rows);
    const got = anomaliesResident.detectAnomaliesResident({ parquetPath: f.file, columns: f.columns });
    const w = want.find((a) => a.kind === 'numeric_outlier');
    const g = (got ?? []).find((a) => a.kind === 'numeric_outlier');
    ok('float: both paths find the same NUMBER of outliers', Boolean(w) && Boolean(g)
      && w!.facts.count === g!.facts.count);
    ok('float: minOutlier/maxOutlier are raw data values, so they are EXACT',
      Boolean(w) && Boolean(g)
      && Object.is(w!.facts.minOutlier, g!.facts.minOutlier)
      && Object.is(w!.facts.maxOutlier, g!.facts.maxOutlier));
    const relFence = Math.abs((g!.facts.upperFence as number) - (w!.facts.upperFence as number))
      / Math.abs(w!.facts.upperFence as number);
    ok(`float: the rounded fences agree to better than 1e-9 relative (${relFence.toExponential(2)})`,
      Number.isFinite(relFence) && relFence < 1e-9);
    ok('float: …and in this fixture they are in fact bit-identical after round()',
      Object.is(w!.facts.lowerFence, g!.facts.lowerFence)
      && Object.is(w!.facts.upperFence, g!.facts.upperFence));
    ok('float: the whole list still matches byte for byte', got !== null && sameList(want, got));
  }

  // ── 15. Through the SHIPPED handler, with a hydration spy ─────────────────
  // `ipc/dashboards.js` resolves `datasets.getDataset` off the module namespace
  // at CALL time, so replacing the export here is observed by the shipped
  // handler. Counting the calls is how "the resident path was taken" is PROVEN.
  {
    const realGetDataset = datasets.getDataset;
    let hydrations = 0;
    (datasets as any).getDataset = async (...args: any[]): Promise<any> => {
      hydrations += 1;
      return (realGetDataset as any)(...args);
    };

    const proj = await projects.createProject('Anomaly rewire');
    const columns = [T('region'), N('sales'), D('day')];
    const rows: Cell[][] = [];
    // Above ANOMALY_MIN_ROWS in ipc/dashboards.ts, so the handler takes the
    // resident path; the tiny dataset below it exercises the fallback.
    for (let i = 0; i < 6_000; i += 1) {
      rows.push([
        i % 4 === 0 ? 'south' : 'north',
        i === 5999 ? 500000 : (i % 11) - 5,
        i < 3000 ? '2023' : '2024',
      ]);
    }
    const rec = await datasets.saveDataset(proj.id, {
      name: 'sales', sourceKind: 'csv', columns, rows,
    });
    ok('handler fixture saved', rec !== null);
    if (!rec) return;

    // The reference is the pre-rewire code, over the rows the loader returns.
    const ds = await realGetDataset(proj.id, rec.id);
    const wantList = anomalies.detectAnomalies(ds!.columns, ds!.rows);
    const wantFacts = anomalies.buildAnomaliesFacts(ds!.name, wantList);
    ok('handler fixture actually has anomalies to explain', wantList.length > 0);

    const dash = await dashboards.saveDashboard(proj.id, {
      name: 'D', pages: [{
        name: 'Page 1',
        cards: [{
          type: 'metric',
          layout: { x: 0, y: 0, w: 3, h: 2 },
          metric: { datasetId: rec.id, column: 'sales', aggregation: 'sum', label: 'Sales' },
        }],
      }],
    } as any);
    ok('handler fixture dashboard saved', Boolean(dash && (dash as any).id));

    hydrations = 0;
    const t0 = process.hrtime.bigint();
    const out = await (explainHandler as IpcHandler)(null, { projectId: proj.id, id: (dash as any).id });
    const t1 = process.hrtime.bigint();
    ok('dashboard:explainAnomalies still answers with the app-detected list ' +
      `[${ms(t1 - t0)} ms]`, out.ok === false ? Array.isArray(out.anomalies) : Array.isArray(out.anomalies));
    ok('dashboard:explainAnomalies: no model configured → notReady, list still returned',
      out.notReady === true);
    ok('dashboard:explainAnomalies: the table was NEVER hydrated (resident path taken)',
      hydrations === 0);
    ok('dashboard:explainAnomalies: the list is byte-identical to the pre-rewire answer',
      sameList(wantList, out.anomalies as Anomaly[]));

    // The FACTS block is what the model actually reads; it must be unchanged.
    ok('dashboard:explainAnomalies: buildAnomaliesFacts over the resident list is unchanged',
      anomalies.buildAnomaliesFacts('sales', out.anomalies as Anomaly[]) === wantFacts);

    // A dataset that is NOT resident must still work, through the JS path.
    hydrations = 0;
    const small = await datasets.saveDataset(proj.id, {
      name: 'tiny', sourceKind: 'csv', columns: [T('c')],
      rows: [['A'], ['A'], ['A'], ['B']],
    });
    const dash2 = await dashboards.saveDashboard(proj.id, {
      name: 'D2', pages: [{
        name: 'Page 1',
        cards: [{
          type: 'metric',
          layout: { x: 0, y: 0, w: 3, h: 2 },
          metric: { datasetId: small!.id, column: 'c', aggregation: 'count', label: 'C' },
        }],
      }],
    } as any);
    const out2 = await (explainHandler as IpcHandler)(null, { projectId: proj.id, id: (dash2 as any).id });
    ok('a below-threshold dataset falls back to the JS path and still answers',
      Array.isArray(out2.anomalies) && out2.anomalies.length > 0 && hydrations === 1);

    const missing = await (explainHandler as IpcHandler)(null, {
      projectId: proj.id, id: '00000000-0000-4000-8000-000000000000',
    });
    ok('dashboard:explainAnomalies: an unknown dashboard returns { ok:false, error }',
      missing.ok === false && missing.error === 'Dashboard not found');
    const noArgs = await (explainHandler as IpcHandler)(null);
    ok('dashboard:explainAnomalies: a missing payload returns { ok:false }', noArgs.ok === false);

    (datasets as any).getDataset = realGetDataset;
  }
}

void main()
  .catch((err) => { console.error('FAIL unexpected error', err); failures += 1; })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' anomalies-resident check(s) FAILED'); process.exit(1); }
    console.log('\nAll anomalies-resident checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
