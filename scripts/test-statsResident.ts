// Self-check for src/statsResident.ts — per-column summaries and quality issues
// computed off a dataset's Parquet file instead of a hydrated Cell[][].
//
// EVERY assertion about a number is DIFFERENTIAL. The resident answer is
// compared against `datasetStats.computeColumnSummary` / `findQualityIssues`
// applied to the SAME bytes read back through `parquetStore.readTable` — which
// is literally the code `dataset:stats` ran before the rewire. A hand-written
// expectation can agree with a bug on both sides; an equivalence assertion
// cannot.
//
// Two things make the comparison sharper than a `deepStrictEqual`:
//
//   • KEY SETS ARE COMPARED, not just values. `ColumnSummary` carries TWO
//     different "no data" conventions — `min`/`max`/`mean` must be ABSENT when
//     the numeric count is 0, while `mostCommon` must be PRESENT AND NULL. The
//     renderer tests `typeof sum.min === 'number'`, so a stray `min: null` would
//     render identically and ship silently.
//   • Values are compared with `Object.is`, so `null` can never pass as `0` and
//     a `-0` can never pass as `0`.
//
// The last section drives the SHIPPED `dataset:stats` / `dataset:explain`
// handlers for real (electron stubbed, `register()` called) and spies on
// `datasets.getDataset`, so "the resident path was taken" is asserted as "the
// table was never hydrated" rather than assumed.
//
//   npm run build:ts && node scripts/test-statsResident.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type ColumnSummary = import('../src/data/datasetStats').ColumnSummary;
type QualityIssue = import('../src/data/datasetStats').QualityIssue;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-stats-resident-'));

// ── The electron stub (test-datasets.ts pattern, plus handler capture) ───────
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      dialog: {},
      net: {},
      nativeImage: {},
      shell: {},
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const datasetStats: typeof import('../src/data/datasetStats') = require('../src/data/datasetStats');
const statsResident: typeof import('../src/engine/statsResident') = require('../src/engine/statsResident');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const datasetsIpc: typeof import('../src/ipc/datasets') = require('../src/ipc/datasets');

datasetsIpc.register();
const statsHandler = handlers.get('dataset:stats');
const explainHandler = handlers.get('dataset:explain');


const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-stats-fixtures-'));
let fileSeq = 0;
function fixtureFile(): string {
  fileSeq += 1;
  return path.join(tmpDir, `f${fileSeq}.parquet`);
}

// ── Comparison helpers ───────────────────────────────────────────────────────

function keysOf(o: object): string {
  return Object.keys(o).sort().join(',');
}

/** Equal AND with the same set of keys present. `Object.is` throughout. */
function sameSummary(a: ColumnSummary, b: ColumnSummary): boolean {
  if (keysOf(a) !== keysOf(b)) return false;
  for (const k of Object.keys(a)) {
    const va = (a as any)[k];
    const vb = (b as any)[k];
    if (k === 'mostCommon') {
      if (va === null || vb === null) { if (!Object.is(va, vb)) return false; continue; }
      if (!va || !vb) return false;
      if (keysOf(va) !== keysOf(vb)) return false;
      if (va.value !== vb.value || !Object.is(va.count, vb.count)) return false;
      continue;
    }
    if (!Object.is(va, vb)) return false;
  }
  return true;
}

function sameIssues(a: QualityIssue[], b: QualityIssue[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (keysOf(a[i]) !== keysOf(b[i])) return false;
    if (a[i].kind !== b[i].kind || a[i].column !== b[i].column) return false;
    if (a[i].detail !== b[i].detail || a[i].severity !== b[i].severity) return false;
  }
  return true;
}

function show(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x === undefined ? '<absent>' : x));
}

interface Fixture {
  label: string;
  file: string;
  columns: ParsedColumn[];
  /** The rows as READ BACK from Parquet — what the JS reference must see. */
  rows: Cell[][];
  want: ColumnSummary[];
  wantIssues: QualityIssue[];
}

/**
 * Write a table, read it back, and compute the JS reference off the round-tripped
 * rows — the comparison must be like for like, since a Parquet round trip is not
 * an identity on every cell type.
 */
function makeFixture(label: string, columns: ParsedColumn[], rows: Cell[][]): Fixture {
  const file = fixtureFile();
  pqSync.writeTable(file, columns, rows);
  const back = pqSync.readTable(file, columns);
  if (!back) throw new Error(`fixture read-back failed: ${label}`);
  const want = columns.map((col, c) =>
    datasetStats.computeColumnSummary(col, back.rows.map((r) => (r ? r[c] ?? null : null))),
  );
  const wantIssues = datasetStats.findQualityIssues(columns, back.rows);
  return { label, file, columns, rows: back.rows, want, wantIssues };
}

/** The whole differential: summaries per column + the quality-issue list. */
async function diff(f: Fixture): Promise<{ summaries: ColumnSummary[] | null; issues: QualityIssue[] | null }> {
  const src = { parquetPath: f.file, columns: f.columns };
  const got = await statsResident.computeColumnSummariesResident(src);
  ok(`${f.label}: summaries are resident (not a fallback)`, got !== null);
  if (got) {
    ok(`${f.label}: one summary per column, in declaration order`,
      got.length === f.want.length && got.every((s, i) => s.name === f.want[i].name));
    f.want.forEach((wantCol, i) => {
      const gotCol = got[i];
      ok(`${f.label}: ${wantCol.name} === computeColumnSummary  ${show(wantCol)}`,
        Boolean(gotCol) && sameSummary(wantCol, gotCol));
    });
  }
  const issues = await statsResident.findQualityIssuesResident(src);
  ok(`${f.label}: issues are resident (not a fallback)`, issues !== null);
  if (issues) {
    ok(`${f.label}: issues === findQualityIssues  ${show(f.wantIssues)}`,
      sameIssues(f.wantIssues, issues));
  }
  return { summaries: got, issues };
}

function summaryOf(list: ColumnSummary[] | null, name: string): ColumnSummary | undefined {
  return list ? list.find((s) => s.name === name) : undefined;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });
const D = (name: string): ParsedColumn => ({ name, type: 'date' });

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();

  const resident = statsResident.isStatsResident();
  ok('isStatsResident() returns a boolean', typeof resident === 'boolean');
  if (!resident) {
    console.log('#    DuckDB bridge UNAVAILABLE — nothing to test, the JS path is always used');
    return;
  }
  console.log('#    DuckDB bridge available — the resident path is under test');

  // ── 1. The mixed fixture: every semantic in one table ──────────────────────
  //
  //   city   text, case-sensitive duplicates + every flavour of empty cell
  //   sales  number with nulls, a zero, a negative — and NaN/Infinity cells,
  //          which the Parquet round trip turns into nulls on BOTH sides
  //   day    date, which must behave exactly like text
  //   code   leading-zero identifiers stored as text: '007' must never be 7
  //   blank  ALL-empty text: distinct 0 and mostCommon PRESENT AND NULL
  //   score  a number column with no finite cells: min/max/mean ABSENT
  {
    const columns = [T('city'), N('sales'), D('day'), T('code'), T('blank'), N('score')];
    const rows: Cell[][] = [
      ['Paris', 10, '2024-01-01', '007', '', null],
      ['paris', 20, '2024-01-02', '012', '   ', null],
      ['Paris', null, '2024-01-01', '007', null, null],
      ['Rome', 0, '2024-01-03', '90210', '\t', null],
      [null, -5, '2024-01-01', '007', ' ', null],
      ['', 5, null, '00', '﻿', null],
      ['   ', NaN, '2024-01-02', '007', '', null],
      ['\t', Infinity, '2024-01-01', '012', '  \t ', null],
      [' ', 5, '2024-01-01', '007', '', null],
    ];
    const f = makeFixture('mixed', columns, rows);
    const { summaries } = await diff(f);

    // Spot-checks that pin WHAT the shared answer actually is, so a change that
    // moves both sides together still fails.
    const city = summaryOf(summaries, 'city');
    ok('mixed: nonEmpty excludes \'\', spaces, tab and NBSP (4 of 9)', city?.nonEmpty === 4);
    ok('mixed: distinct is case-sensitive (Paris ≠ paris → 3)', city?.distinct === 3);
    ok('mixed: mostCommon is the modal value with its count',
      city?.mostCommon?.value === 'Paris' && city?.mostCommon?.count === 2);

    const blank = summaryOf(summaries, 'blank');
    ok('mixed: an all-empty text column has nonEmpty 0 and distinct 0',
      blank?.nonEmpty === 0 && blank?.distinct === 0);
    ok('mixed: an all-empty text column has mostCommon PRESENT and null',
      Boolean(blank) && 'mostCommon' in (blank as object) && blank!.mostCommon === null);

    const score = summaryOf(summaries, 'score');
    ok('mixed: a number column with no finite cells reports count 0',
      score?.count === 0 && score?.nonEmpty === 0);
    ok('mixed: …and min/max/mean are ABSENT, not null',
      Boolean(score) && !('min' in (score as object)) && !('max' in (score as object))
        && !('mean' in (score as object)));
    ok('mixed: …and a number column never carries distinct/mostCommon',
      Boolean(score) && !('distinct' in (score as object)) && !('mostCommon' in (score as object)));

    const sales = summaryOf(summaries, 'sales');
    // NaN and Infinity do not survive the round trip (parquetStore.toCell maps a
    // non-finite reading to null), so they are excluded on BOTH sides — that is
    // the differential assertion above. Here: the finite cells are 10,20,0,-5,5,5.
    ok('mixed: number count is the finite cells only (6 of 9)', sales?.count === 6);
    ok('mixed: nonEmpty === count for a number column', sales?.nonEmpty === 6);
    ok('mixed: min/max are the finite extremes, 0 included',
      sales?.min === -5 && sales?.max === 20);
    ok('mixed: mean is sum ÷ finite count', sales?.mean === 35 / 6);

    const code = summaryOf(summaries, 'code');
    ok("mixed: a leading-zero text column keeps '007' as a distinct string value",
      code?.mostCommon?.value === '007' && code?.distinct === 4);
  }

  // ── 2. mostCommon ties resolve to FIRST OCCURRENCE in row order ────────────
  // The single most fragile semantic in the port: `mode()` is unspecified on
  // ties. Both orders are asserted so a tie-break that ignores the ordinal (or
  // reverses it) cannot pass by luck.
  {
    const cols = [T('v')];
    const a = makeFixture('tie a-first', cols, [['a'], ['b'], ['a'], ['b']]);
    const ra = await diff(a);
    ok("tie: 'a' occurs first and wins the 2–2 tie",
      summaryOf(ra.summaries, 'v')?.mostCommon?.value === 'a');

    const b = makeFixture('tie b-first', cols, [['b'], ['a'], ['b'], ['a']]);
    const rb = await diff(b);
    ok("tie: 'b' occurs first and wins the same tie the other way round",
      summaryOf(rb.summaries, 'v')?.mostCommon?.value === 'b');

    // Three-way tie, with the winner's first occurrence in the middle of the
    // table and empties interleaved (which must not shift the ordinal).
    const c = makeFixture('tie three-way', cols,
      [[''], ['z'], [null], ['y'], ['z'], ['x'], ['y'], ['   '], ['x']]);
    const rc = await diff(c);
    ok("tie: a 2–2–2 tie goes to the earliest first occurrence ('z')",
      summaryOf(rc.summaries, 'v')?.mostCommon?.value === 'z');
  }

  // ── 3. Leading zeros, exactly ──────────────────────────────────────────────
  {
    const f = makeFixture('leading zeros', [T('code'), N('n')],
      [['007', 7], ['007', 7], ['0012', 12], ['00', 0], ['7', 7]]);
    const r = await diff(f);
    const code = summaryOf(r.summaries, 'code');
    ok("leading zeros: '007' and '7' are DIFFERENT values (distinct 4)", code?.distinct === 4);
    ok("leading zeros: the modal value is the string '007'", code?.mostCommon?.value === '007');
    ok('leading zeros: the parallel number column is unaffected',
      summaryOf(r.summaries, 'n')?.mean === 33 / 5);
  }

  // ── 4. A zero-row table ────────────────────────────────────────────────────
  {
    const f = makeFixture('zero rows', [T('a'), N('b'), D('c')], []);
    const r = await diff(f);
    ok('zero rows: every nonEmpty is 0',
      (r.summaries ?? []).every((s) => s.nonEmpty === 0));
    ok('zero rows: the number column has count 0 and no min/max/mean',
      summaryOf(r.summaries, 'b')?.count === 0 && !('mean' in (summaryOf(r.summaries, 'b') as object)));
    ok('zero rows: the text column has mostCommon null, present',
      summaryOf(r.summaries, 'a')!.mostCommon === null);
    ok('zero rows: NO quality issues at all (not even duplicate_rows)',
      r.issues !== null && r.issues.length === 0 && f.wantIssues.length === 0);
  }

  // ── 5. Quality issues: each flag, firing and not firing ────────────────────
  {
    // empty_heavy fires at EXACTLY 0.5 and not at 0.25. `same` is constant.
    // `varied` is neither.
    const half = makeFixture('empty_heavy at exactly 0.5',
      [T('a'), T('quarter'), T('same'), T('varied')],
      [
        ['x', 'x', 'same', 'p'],
        ['', 'y', 'same', 'q'],
        [null, 'z', 'same', 'r'],
        ['w', '', 'same', 's'],
      ]);
    const rh = await diff(half);
    const kinds = (list: QualityIssue[] | null, col: string) =>
      (list ?? []).filter((i) => i.column === col).map((i) => i.kind).join('+');
    ok('quality: 2 of 4 empty (exactly 0.5) → empty_heavy fires', kinds(rh.issues, 'a') === 'empty_heavy');
    ok('quality: 1 of 4 empty (0.25) → nothing fires', kinds(rh.issues, 'quarter') === '');
    ok('quality: a single-valued column → constant_column', kinds(rh.issues, 'same') === 'constant_column');
    ok('quality: a varied, full column → nothing fires', kinds(rh.issues, 'varied') === '');
    ok('quality: the empty_heavy detail string carries the rounded percentage',
      (rh.issues ?? []).some((i) => i.detail === 'Column "a" is 50% empty' && i.severity === 'warn'));
    ok('quality: the constant_column detail string is the shipped wording',
      (rh.issues ?? []).some((i) =>
        i.detail === 'Column "same" has the same value in every row' && i.severity === 'info'));

    // A column with ONE value plus some empties is BOTH empty_heavy and
    // constant; an ALL-empty column is neither (the `empties < rowCount` clause).
    const both = makeFixture('constant + empty_heavy together',
      [T('one'), T('none')],
      [['v', ''], ['', null], [null, '   '], ['v', '']]);
    const rb = await diff(both);
    ok('quality: one value + half empties is empty_heavy AND constant',
      kinds(rb.issues, 'one') === 'empty_heavy+constant_column');
    ok('quality: an ALL-empty column is empty_heavy but NOT constant',
      kinds(rb.issues, 'none') === 'empty_heavy');

    // duplicate_rows: identical across every column. '' and null are NOT the
    // same cell, and a row differing only in a number is not a duplicate.
    const dup = makeFixture('duplicate rows', [T('city'), N('n')],
      [['Paris', 1], ['Paris', 1], ['Paris', 3], ['', 1], [null, 1], ['Paris', 1]]);
    const rd = await diff(dup);
    // ['Paris',1] appears three times → 2 duplicates. ['',1] and [null,1] are
    // each unique: if the row key conflated '' with null there would be 3.
    ok('quality: 2 fully-duplicate rows, counted and pluralised',
      (rd.issues ?? []).some((i) => i.kind === 'duplicate_rows' && i.detail === '2 fully-duplicate rows'));

    const one = makeFixture('one duplicate row', [T('city')], [['a'], ['a'], ['b']]);
    const r1 = await diff(one);
    ok('quality: exactly one duplicate is singular, not "1 fully-duplicate rows"',
      (r1.issues ?? []).some((i) => i.detail === '1 fully-duplicate row'));

    const uniq = makeFixture('no duplicates', [T('city'), N('n')],
      [['a', 1], ['b', 2], ['', 1], [null, 1]]);
    const ru = await diff(uniq);
    ok('quality: an all-unique table reports no duplicate_rows (\'\' ≠ null ≠ a value)',
      !(ru.issues ?? []).some((i) => i.kind === 'duplicate_rows'));

    // Emission order: per column empty_heavy then constant_column, in column
    // order, and duplicate_rows LAST. It drives badge order in the renderer.
    const ord = makeFixture('issue order',
      [T('a'), T('b')],
      [['v', ''], ['v', ''], ['v', ''], ['v', '']]);
    const ro = await diff(ord);
    ok('quality: emission order is per-column, then duplicate_rows last',
      (ro.issues ?? []).map((i) => `${i.column ?? '-'}:${i.kind}`).join(',')
        === 'a:constant_column,b:empty_heavy,-:duplicate_rows');
  }

  // ── 6. Whitespace is the JS trim() class, not DuckDB's ─────────────────────
  // DuckDB's trim() strips spaces only and RE2's \s misses NBSP, so this is the
  // divergence most likely to pass a casual test. One column, one cell per
  // flavour, plus one real value.
  {
    const f = makeFixture('whitespace flavours', [T('w')],
      [[''], ['   '], ['\t'], ['\n'], ['\r'], [''], [''], [' '], ['﻿'],
        [' \t  '], [null], ['x'], [' x ']]);
    const r = await diff(f);
    const w = summaryOf(r.summaries, 'w');
    ok('whitespace: only \'x\' and \' x \' are non-empty (2 of 13)', w?.nonEmpty === 2);
    ok('whitespace: a non-blank value is NEVER trimmed (\'x\' ≠ \' x \')', w?.distinct === 2);
    ok('whitespace: the whole column is empty_heavy but not constant',
      (r.issues ?? []).map((i) => i.kind).join(',') === 'empty_heavy');
  }

  // ── 7. Failure modes: null means fall back, and nothing ever throws ────────
  {
    const cols = [T('a')];
    const missing = { parquetPath: path.join(tmpDir, 'does-not-exist.parquet'), columns: cols };
    ok('missing file → null, not a throw (summaries)',
      await statsResident.computeColumnSummariesResident(missing) === null);
    ok('missing file → null, not a throw (issues)',
      await statsResident.findQualityIssuesResident(missing) === null);

    const good = makeFixture('good file for the negative cases', cols, [['x']]);
    ok('0 columns → null (fall back; the file holds only the row-count sentinel)',
      await statsResident.computeColumnSummariesResident({ parquetPath: good.file, columns: [] }) === null);
    ok('a schema WIDER than the file → null, never a partial answer',
      await statsResident.computeColumnSummariesResident(
        { parquetPath: good.file, columns: [T('a'), T('b'), T('c')] }) === null);
    ok('a malformed column entry → null',
      await statsResident.computeColumnSummariesResident(
        { parquetPath: good.file, columns: [null as any] }) === null);
    ok('a non-string path → null',
      await statsResident.computeColumnSummariesResident({ parquetPath: 42 as any, columns: cols }) === null);
    ok('a path with a quote in it → null (relationSql rejects/escapes it), never a throw',
      await statsResident.findQualityIssuesResident(
        { parquetPath: "/tmp/no'such.parquet", columns: cols }) === null);

    const sample = await statsResident.sampleRowsResident({ parquetPath: good.file, columns: cols }, 5);
    ok('sampleRowsResident returns the stored rows in file order',
      Array.isArray(sample) && sample.length === 1 && sample[0][0] === 'x');
    ok('sampleRowsResident(0) is an empty array, not null',
      JSON.stringify(await statsResident.sampleRowsResident({ parquetPath: good.file, columns: cols }, 0)) === '[]');
  }

  // ── 8. A column name that is a SQL identifier is never SQL ────────────────
  // User-facing names never reach the generated SQL (columns are positional
  // c0..cN), so a hostile header is inert. Asserted rather than assumed.
  {
    const nasty = '"; DROP TABLE x; --';
    const f = makeFixture('hostile column name', [T(nasty), N('n')],
      [['a', 1], ['a', 2], ['b', 3]]);
    const r = await diff(f);
    ok('a hostile column name is echoed verbatim and changes no number',
      summaryOf(r.summaries, nasty)?.mostCommon?.value === 'a');
  }

  // ── 9. A leading BOM in a VALUE survives the bridge ────────────────────────
  {
    const f = makeFixture('leading BOM value', [T('v')],
      [['﻿alpha'], ['﻿alpha'], ['beta']]);
    const r = await diff(f);
    ok('a leading U+FEFF in the modal value is not eaten by the bridge',
      summaryOf(r.summaries, 'v')?.mostCommon?.value === '﻿alpha');
  }

  // ── 10. 60,000 rows: the two paths agree exactly at scale ──────────────────
  {
    const columns = [T('region'), N('sales'), T('note'), D('day'), T('code'), N('qty')];
    const rows: Cell[][] = new Array(60_000);
    for (let i = 0; i < rows.length; i += 1) {
      rows[i] = [
        `region-${i % 40}`,
        i % 7 === 0 ? null : (i % 13) - 6,
        i % 3 === 0 ? '' : i % 3 === 1 ? '   ' : `note-${i % 500}`,
        `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
        String(i % 1000).padStart(4, '0'),
        i % 5,
      ];
    }
    const f = makeFixture('60k rows', columns, rows);
    const r = await diff(f);
    ok('60k: the number column agrees on an integer mean exactly',
      Object.is(summaryOf(r.summaries, 'sales')?.mean, summaryOf(f.want, 'sales')?.mean));
    ok('60k: distinct counts are large and exact',
      summaryOf(r.summaries, 'note')?.distinct === 500);
  }

  // ── 11. The one semantic that genuinely differs: float summation order ─────
  // A JS left-fold and DuckDB's parallel partial sums can differ in the last
  // ULPs on NON-INTEGER data, which reaches the AI prompt as text (mean is
  // embedded unrounded). Integer data is exact. Pinned by magnitude so it stays
  // visible, and so a drift LARGER than a rounding artefact fails loudly.
  {
    const rows: Cell[][] = new Array(50_000);
    for (let i = 0; i < rows.length; i += 1) rows[i] = [((i * 7919) % 100_000) / 7 + 0.1];
    const f = makeFixture('float summation', [N('x')], rows);
    const src = { parquetPath: f.file, columns: f.columns };
    const got = await statsResident.computeColumnSummariesResident(src);
    const wantMean = f.want[0].mean as number;
    const gotMean = got?.[0].mean as number;
    const relErr = Math.abs(gotMean - wantMean) / Math.abs(wantMean);
    ok(`float summation: mean agrees to better than 1e-12 relative (${relErr.toExponential(2)})`,
      Number.isFinite(relErr) && relErr < 1e-12);
    ok('float summation: min/max/count/nonEmpty are exact regardless',
      got !== null && Object.is(got[0].min, f.want[0].min) && Object.is(got[0].max, f.want[0].max)
        && got[0].count === f.want[0].count && got[0].nonEmpty === f.want[0].nonEmpty);

    const ints: Cell[][] = new Array(50_000);
    for (let i = 0; i < ints.length; i += 1) ints[i] = [(i % 977) - 400];
    const fi = makeFixture('integer summation', [N('x')], ints);
    const gi = await statsResident.computeColumnSummariesResident({ parquetPath: fi.file, columns: fi.columns });
    ok('integer summation: the mean is bit-for-bit identical',
      gi !== null && Object.is(gi[0].mean, fi.want[0].mean));
  }

  // ── 12. Through the SHIPPED handlers, with a hydration spy ────────────────
  // `ipc/datasets.js` resolves `datasets.getDataset` off the module namespace at
  // CALL time, so replacing the export here is observed by the shipped handler.
  // Counting the calls is how "the resident path was taken" is PROVEN.
  {
    const realGetDataset = datasets.getDataset;
    let hydrations = 0;
    (datasets as any).getDataset = async (...args: any[]): Promise<any> => {
      hydrations += 1;
      return (realGetDataset as any)(...args);
    };

    const proj = await projects.createProject('Stats rewire');
    const columns = [T('city'), N('pop'), T('blank'), D('day')];
    const rows: Cell[][] = [
      ['Paris', 10, '', '2024-01-01'],
      ['Paris', 20, '   ', '2024-01-02'],
      ['Rome', null, null, '2024-01-01'],
      ['Rome', 0, '', '2024-01-01'],
      ['Paris', 10, '', '2024-01-01'],
    ];
    const rec = await datasets.saveDataset(proj.id, {
      name: 'cities', sourceKind: 'csv', columns, rows,
    });
    ok('handler fixture saved', rec !== null);
    if (!rec) return;

    // The reference is the pre-rewire code, over the rows the loader returns.
    const ds = await realGetDataset(proj.id, rec.id);
    const wantSummaries = ds!.columns.map((col, c) =>
      datasetStats.computeColumnSummary(col, ds!.rows.map((r) => (r ? r[c] ?? null : null))),
    );
    const wantIssues = datasetStats.findQualityIssues(ds!.columns, ds!.rows);

    hydrations = 0;
    const got = await (statsHandler as IpcHandler)(null, { projectId: proj.id, datasetId: rec.id });
    ok('dataset:stats still answers { ok:true, summaries, issues }',
      got.ok === true && Array.isArray(got.summaries) && Array.isArray(got.issues));
    ok('dataset:stats: the table was NEVER hydrated (resident path taken)', hydrations === 0);
    ok('dataset:stats: every summary matches the pre-rewire answer',
      got.summaries.length === wantSummaries.length
        && wantSummaries.every((w, i) => sameSummary(w, got.summaries[i])));
    ok('dataset:stats: the issue list matches the pre-rewire answer',
      sameIssues(wantIssues, got.issues));

    hydrations = 0;
    const missing = await (statsHandler as IpcHandler)(null, {
      projectId: proj.id, datasetId: '00000000-0000-4000-8000-000000000000',
    });
    ok('dataset:stats: an unknown dataset still returns { ok:false, error }',
      missing.ok === false && missing.error === 'Dataset not found');
    const bogus = await (statsHandler as IpcHandler)(null, { projectId: proj.id, datasetId: 'not-a-uuid' });
    ok('dataset:stats: a non-UUID id returns { ok:false }, never a throw', bogus.ok === false);
    const noArgs = await (statsHandler as IpcHandler)(null);
    ok('dataset:stats: a missing payload returns { ok:false }', noArgs.ok === false);

    // dataset:explain has no model configured here, so it stops at not_ready —
    // but only AFTER building the FACTS block, which is the part being rewired.
    hydrations = 0;
    const explained = await (explainHandler as IpcHandler)(null, {
      payload: { projectId: proj.id, datasetId: rec.id },
    });
    ok('dataset:explain: still answers without a model configured', explained.ok === false);
    ok('dataset:explain: the table was NEVER hydrated (stats + sample are resident)',
      hydrations === 0);

    hydrations = 0;
    const explainMissing = await (explainHandler as IpcHandler)(null, {
      payload: { projectId: proj.id, datasetId: '00000000-0000-4000-8000-000000000000' },
    });
    ok('dataset:explain: an unknown dataset still returns { ok:false, error }',
      explainMissing.ok === false && explainMissing.error === 'Dataset not found');

    // The sample block the prompt quotes must be the FIRST rows, in row order.
    const sampleSrc = await datasets.residentSource(proj.id, rec.id);
    const sample = sampleSrc ? await statsResident.sampleRowsResident(sampleSrc, 5) : null;
    ok('dataset:explain: the resident sample is the first rows in stored order',
      JSON.stringify(sample) === JSON.stringify(ds!.rows.slice(0, 5)));

    (datasets as any).getDataset = realGetDataset;
  }
}

void main()
  .catch((err) => { ok('unexpected error', false, err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' stats-resident check(s) FAILED'); process.exit(1); }
    console.log('\nAll stats-resident checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
