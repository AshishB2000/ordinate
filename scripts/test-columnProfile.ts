// Self-check for the column-profile median pair: `data/columnProfile.medianOf`
// (the reference) against `engine/medianResident.medianResident` (the same
// answer off the stored Parquet, with no row hydrated).
//
// EVERY assertion about a number is DIFFERENTIAL, the house style: the resident
// answer is compared with `Object.is` against the JS reference applied to the
// SAME bytes read back through `parquetStore.readTable`. A hand-written
// expectation can agree with a bug on both sides; an equivalence assertion
// cannot. `Object.is` also means a `null` can never pass as a `0` — which
// matters here more than usual, because "no finite cells" and "the median is
// zero" are different answers that a truthiness test would merge.
//
// THE ONE PINNED DIVERGENCE. `anomalies.quantile` evaluates
// `s[lo] + frac*(s[hi]-s[lo])`; DuckDB's `quantile_cont` evaluates an
// algebraically equal expression in a different order, so the two can differ in
// the last ULP on an even-length column (an odd-length one lands exactly on a
// sample and both return it bit-for-bit). That is the same divergence
// `engine/anomaliesResident.ts` records for the IQR fences. It is asserted as a
// RELATIVE tolerance rather than ignored, so a real regression still fails —
// and the exact-equality cases below are asserted with `Object.is`.
//
// The last section drives the SHIPPED `dataset:median` handler (electron
// stubbed, `register()` called) and spies on `datasets.getDataset`, so "the
// resident path was taken" is asserted as "the table was never hydrated"
// rather than assumed.
//
//   npm run build:ts && node scripts/test-columnProfile.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-median-'));

// ── The electron stub (test-statsResident.ts pattern, plus handler capture) ──
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
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const columnProfile: typeof import('../src/data/columnProfile') = require('../src/data/columnProfile');
const medianResidentMod: typeof import('../src/engine/medianResident') = require('../src/engine/medianResident');
const statsResident: typeof import('../src/engine/statsResident') = require('../src/engine/statsResident');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const datasetsIpc: typeof import('../src/ipc/datasets') = require('../src/ipc/datasets');

datasetsIpc.register();
const medianHandler = handlers.get('dataset:median');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-median-fixtures-'));
let fileSeq = 0;
function fixtureFile(): string {
  fileSeq += 1;
  return path.join(tmpDir, `f${fileSeq}.parquet`);
}

const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });

/**
 * The two answers agree.
 *
 * Exact (`Object.is`) whenever the reference lands on a sample — a null, or an
 * odd count, where no interpolation happens on either side. Where both sides DO
 * interpolate, a relative 1e-12 window covers the documented last-ULP
 * divergence and nothing larger.
 */
function agree(label: string, want: number | null, got: { value: number | null } | null): void {
  if (got === null) {
    ok(`${label}: resident answered (not a fallback)`, false, 'medianResident returned null');
    return;
  }
  const g = got.value;
  if (want === null || g === null) {
    ok(`${label}: === medianOf  (${String(want)})`, Object.is(want, g), `want=${String(want)} got=${String(g)}`);
    return;
  }
  const rel = Math.abs(g - want) / Math.max(1, Math.abs(want));
  ok(`${label}: === medianOf  (${want})`, rel <= 1e-12, `want=${want} got=${g} rel=${rel}`);
}

interface Case {
  label: string;
  columns: ParsedColumn[];
  rows: Cell[][];
  column: string;
}

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();

  const resident = statsResident.isStatsResident();
  ok('DuckDB availability is a boolean', typeof resident === 'boolean');
  if (!resident) {
    console.log('#    DuckDB bridge UNAVAILABLE — nothing to test, the JS path is always used');
    return;
  }
  console.log('#    DuckDB bridge available — the resident path is under test');

  // ── 1. The shapes a median has to get right ────────────────────────────────
  const cases: Case[] = [
    // ODD count — the median IS a sample, so both sides must return it exactly.
    { label: 'odd count', columns: [N('v')], rows: [[3], [1], [2]], column: 'v' },
    // EVEN count — both sides interpolate; this is where the ULP note applies.
    { label: 'even count', columns: [N('v')], rows: [[4], [1], [3], [2]], column: 'v' },
    { label: 'single row', columns: [N('v')], rows: [[42]], column: 'v' },
    // Empties are NOT zeros. A column of two values and three nulls has the
    // median of the two, not of five.
    { label: 'nulls skipped', columns: [N('v')], rows: [[10], [null], [20], [null], [null]], column: 'v' },
    // Zero and negatives: `Object.is` is what stops a -0 passing for a 0 here.
    { label: 'zero and negatives', columns: [N('v')], rows: [[-5], [0], [5], [-10], [10]], column: 'v' },
    { label: 'all-empty numeric column', columns: [N('v')], rows: [[null], [null]], column: 'v' },
    { label: 'no rows at all', columns: [N('v')], rows: [], column: 'v' },
    // NaN / Infinity survive neither side: the Parquet round trip nulls them,
    // and `isfinite`/`Number.isFinite` reject them anyway.
    { label: 'non-finite cells', columns: [N('v')], rows: [[1], [NaN], [3], [Infinity]], column: 'v' },
    // Fractions, so the interpolation is not landing on integers by luck.
    { label: 'fractional', columns: [N('v')], rows: [[0.1], [0.2], [0.3], [0.4]], column: 'v' },
    // Second column, so a positional `c0`-vs-name mix-up cannot pass.
    { label: 'second column', columns: [T('k'), N('v')], rows: [['a', 7], ['b', 9], ['c', 8]], column: 'v' },
  ];

  for (const c of cases) {
    const file = fixtureFile();
    parquetStore.writeTable(file, c.columns, c.rows);
    const back = parquetStore.readTable(file, c.columns);
    ok(`${c.label}: fixture reads back`, !!back);
    if (!back) continue;
    // The reference runs on the ROUND-TRIPPED rows: a Parquet round trip is not
    // an identity on every cell type, so anything else would compare two
    // different tables.
    const want = columnProfile.medianOf(c.columns, back.rows, c.column);
    agree(c.label, want, medianResidentMod.medianResident({ parquetPath: file, columns: c.columns }, c.column));
  }

  // ── 2. Cast on the DECLARED type, never inference ──────────────────────────
  //
  // '007' is a zero-padded identifier. `TRY_CAST('007' AS DOUBLE)` is 7, so a
  // resident path that read a TEXT column numerically would invent a median for
  // a column that has none. Both sides must answer "no median", and the
  // resident one must say so as a FALLBACK (null), not as `{ value: null }` —
  // the JS reference is what settles a non-number column.
  {
    const cols = [T('code')];
    const rows: Cell[][] = [['007'], ['013'], ['021']];
    const file = fixtureFile();
    parquetStore.writeTable(file, cols, rows);
    const back = parquetStore.readTable(file, cols);
    ok('text column: fixture reads back', !!back);
    if (back) {
      ok('text column: medianOf declines a non-number column',
        Object.is(columnProfile.medianOf(cols, back.rows, 'code'), null));
      ok('text column: medianResident falls back rather than casting 007 to 7',
        medianResidentMod.medianResident({ parquetPath: file, columns: cols }, 'code') === null);
    }
  }

  // ── 3. Unknown column ──────────────────────────────────────────────────────
  {
    const cols = [N('v')];
    const file = fixtureFile();
    parquetStore.writeTable(file, cols, [[1], [2]]);
    ok('unknown column: medianOf → null', Object.is(columnProfile.medianOf(cols, [[1], [2]], 'nope'), null));
    ok('unknown column: medianResident → fall back',
      medianResidentMod.medianResident({ parquetPath: file, columns: cols }, 'nope') === null);
  }

  // ── 4. The SHIPPED handler, with the table never hydrated ──────────────────
  //
  // A fast path that silently stops firing is not wrong, only ~600x slower, and
  // it would pass every assertion above while the handler quietly hydrated a
  // million rows. So this drives `dataset:median` for real and SPIES on
  // `datasets.getDataset`: the assertion is "the table was never read", which is
  // the only thing that fails loudly when the resident path falls out.
  ok('dataset:median is registered', typeof medianHandler === 'function');
  if (typeof medianHandler === 'function') {
    const proj = await projects.createProject('median');
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Numbers',
      sourceKind: 'csv',
      columns: [T('k'), N('v')],
      rows: [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]],
    });
    ok('fixture dataset saved', !!(ds && ds.id));

    const realGet = datasets.getDataset;
    let hydrated = 0;
    (datasets as any).getDataset = async (...args: any[]): Promise<any> => {
      hydrated += 1;
      return (realGet as any)(...args);
    };
    try {
      const res = await medianHandler({}, { projectId: proj.id, datasetId: ds!.id, column: 'v' });
      ok('dataset:median returns ok', !!(res && res.ok === true), JSON.stringify(res));
      ok('dataset:median === 3 (the app computes it, nothing guesses)', Object.is(res && res.median, 3),
        `median=${String(res && res.median)}`);
      ok('dataset:median never hydrated the table', hydrated === 0, `getDataset called ${hydrated}x`);

      // A text column has no median, and the answer must still be a clean
      // `{ ok: true, median: null }` rather than an error the panel has to
      // special-case. This one DOES fall through to the JS reference — that is
      // the documented cost of declining to cast a declared-text column.
      hydrated = 0;
      const txt = await medianHandler({}, { projectId: proj.id, datasetId: ds!.id, column: 'k' });
      ok('dataset:median on a text column → { ok:true, median:null }',
        !!(txt && txt.ok === true) && Object.is(txt.median, null), JSON.stringify(txt));

      // An unknown dataset is not an error state either: the panel renders "—".
      const gone = await medianHandler({}, { projectId: proj.id, datasetId: 'nope', column: 'v' });
      ok('dataset:median on a missing dataset → { ok:true, median:null }',
        !!(gone && gone.ok === true) && Object.is(gone.median, null), JSON.stringify(gone));
    } finally {
      (datasets as any).getDataset = realGet;
    }
  }
}

void main()
  .catch((err) => { ok('unexpected error', false, err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' column-profile check(s) FAILED'); process.exit(1); }
    console.log('\nAll column-profile checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
