'use strict';

// Self-check for the category-key rewrite: 10 bins for a number Category, a
// grain for a date one, the top-50 cap for a text one.
//
// DIFFERENTIAL, in the house style. The rewrite exists twice — once in the pure
// JS reference (`vizData.buildVizData`) and once in SQL (`residentQuery` +
// `residentCategory`) — so almost nothing below is asserted against a
// hand-written figure. A fixture is saved through the REAL dataset store, read
// back, and the answer the SHIPPED funnel (`ipc/visuals.vizDataFor`, which the
// builder, dashboard tiles, thumbnails, the share export and the Assistant all
// go through) returns is compared label-for-label and value-for-value against
// `buildVizData` over those exact stored rows, with `Object.is`. The LABELS
// themselves are pinned separately, in test-categoryKey.ts.
//
// AND the fast path is proven to have fired: `datasets.getDataset` is spied on,
// so "the resident path answered" is asserted as "not one row was hydrated". A
// fast path that quietly stops firing would otherwise pass this suite green and
// inert — every comparison would be the JS path against itself.
//
//   npm run build:ts && node scripts/test-vizCategory.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type VizEncoding = import('../src/analysis/visuals').VizEncoding;
type DateGrain = import('../src/analysis/categoryKey').DateGrain;
type VizDataResult = import('../src/analysis/vizData').VizDataResult;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-viz-category-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      ipcMain: { handle: () => {}, on: () => {} },
      net: {},
      nativeImage: {},
      shell: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const categoryKey: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');

// ── The hydration spy ────────────────────────────────────────────────────────
// ipc/visuals.js resolves `datasets.getDataset` off the module namespace at CALL
// time, so replacing the export here is observed by the shipped funnel.
const realGetDataset = datasets.getDataset;
let hydrations = 0;
(datasets as any).getDataset = async (...args: any[]): Promise<any> => {
  hydrations += 1;
  return (realGetDataset as any)(...args);
};

interface Fixture {
  id: string;
  projectId: string;
  label: string;
  columns: ParsedColumn[];
  rows: Cell[][];
}

/** The SHIPPED funnel — the same call `visual:data` makes. */
async function viaFunnel(
  f: Fixture,
  encoding: unknown,
  filters?: FilterStep[],
): Promise<{ reply: any; hydrated: number }> {
  hydrations = 0;
  const reply = await ipcVisuals.vizDataFor(
    f.projectId,
    f.id,
    visuals.sanitizeEncoding(encoding),
    filters ?? [],
  );
  return { reply, hydrated: hydrations };
}

/** The reference: the pure bridge over the rows as READ BACK from storage. */
function reference(f: Fixture, encoding: unknown, filters?: FilterStep[]): VizDataResult {
  return vizData.buildVizData(f.columns, f.rows, visuals.sanitizeEncoding(encoding), filters ?? []);
}

function sameLabels(a: (string | number)[], b: (string | number)[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
function sameValues(a: (number | null)[], b: (number | null)[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

/**
 * The whole assertion: the shipped funnel === buildVizData, and (when
 * `expectResident`) it got there without hydrating a row.
 */
async function diff(
  label: string,
  f: Fixture,
  encoding: unknown,
  opts: { filters?: FilterStep[]; expectResident: boolean } = { expectResident: true },
): Promise<void> {
  const want = reference(f, encoding, opts.filters);
  const { reply, hydrated } = await viaFunnel(f, encoding, opts.filters);
  if (!reply || reply.ok !== true) {
    ok(`${label}: funnel returned ok:true`, false, JSON.stringify(reply));
    return;
  }
  ok(
    `${label}: ${opts.expectResident ? 'resident — NOT ONE ROW hydrated' : 'declined to the JS path'}`,
    opts.expectResident ? hydrated === 0 : hydrated > 0,
    `hydrations=${hydrated}`,
  );
  ok(`${label}: labels === buildVizData (${want.data.labels.length} groups)`,
    sameLabels(want.data.labels, reply.data.labels),
    JSON.stringify({ want: want.data.labels.slice(0, 8), got: reply.data.labels.slice(0, 8) }));
  ok(`${label}: series count === buildVizData`, want.data.series.length === reply.data.series.length);
  for (let i = 0; i < Math.min(want.data.series.length, reply.data.series.length); i += 1) {
    ok(`${label}: series[${i}].name === "${want.data.series[i].name}"`,
      want.data.series[i].name === reply.data.series[i].name);
    ok(`${label}: series[${i}].values === buildVizData`,
      sameValues(want.data.series[i].values, reply.data.series[i].values),
      JSON.stringify({ want: want.data.series[i].values.slice(0, 8), got: reply.data.series[i].values.slice(0, 8) }));
  }
  ok(`${label}: warnings still EMPTY on both paths`,
    want.warnings.length === 0 && reply.warnings.length === 0,
    JSON.stringify({ want: want.warnings, got: reply.warnings }));
  ok(`${label}: category info === buildVizData`,
    JSON.stringify(want.category ?? null) === JSON.stringify(reply.category ?? null),
    JSON.stringify({ want: want.category, got: reply.category }));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Dates: BOTH canonical shapes, empty / whitespace / null cells, duplicates,
// and a span wide enough that the five grains give five different bucket counts.
const DATE_COLUMNS: ParsedColumn[] = [
  { name: 'd', type: 'date' },
  { name: 'v', type: 'number' },
];

function dateRows(): Cell[][] {
  const rows: Cell[][] = [];
  // ~2.5 years of dates, every third day, written in alternating shapes so a
  // grain that agreed only on one shape would show up immediately.
  const start = Date.UTC(2022, 0, 3); // a Monday, so week boundaries are visible
  for (let i = 0; i < 300; i += 1) {
    const dt = new Date(start + i * 3 * 86400000);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const day = dt.getUTCDate();
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const us = `${m}/${day}/${y}`;
    rows.push([i % 2 === 0 ? iso : us, i % 11 === 0 ? null : (i % 17) - 8]);
    // A duplicate of the same date in the OTHER shape: both must land in the
    // same bucket, and the group must not appear twice.
    if (i % 5 === 0) rows.push([i % 2 === 0 ? us : iso, i % 9]);
  }
  rows.push(['', 5], ['   ', 6], [null, 7], ['\t', 8]);
  return rows;
}

// A non-canonical date. SQL has no Date.parse, so the resident path must
// DECLINE the whole chart rather than bucket the leftovers differently.
function looseDateRows(): Cell[][] {
  const rows = dateRows();
  rows.push(['Jan 5, 2023', 42]);
  return rows;
}

const NUM_COLUMNS: ParsedColumn[] = [
  { name: 'price', type: 'number' },
  { name: 'qty', type: 'number' },
];

function numberRows(): Cell[][] {
  const rows: Cell[][] = [];
  // Integers only: a fractional measure would put the documented parallel-
  // summation divergence between the two paths, which is a different test.
  for (let i = 0; i < 600; i += 1) rows.push([(i * 37) % 12001, (i % 23) + 1]);
  rows.push([0, 3], [12000, 4]); // both extremes, so lo/hi are exercised
  rows.push([null, 5], [null, 6]); // no numeric key → the '' group, as today
  return rows;
}

const TEXT_COLUMNS: ParsedColumn[] = [
  { name: 'k', type: 'text' },
  { name: 'v', type: 'number' },
];

/**
 * 60 text keys plus a null key: over the cap, so ten of them fold into 'Other'.
 *
 * Two properties are deliberate. Group SIZES differ, so a "fold the already
 * aggregated tail" implementation gets `avg` of the Other bucket wrong (a mean
 * of means is not the mean). And per-key sums are all DISTINCT, so the top-50
 * cut has no tie for the two paths' summation orders to break differently.
 */
function textRows(): Cell[][] {
  const rows: Cell[][] = [];
  for (let i = 0; i < 60; i += 1) {
    const n = 2 + (i % 3); // 2, 3 or 4 rows per key
    rows.push([`k${String(i).padStart(3, '0')}`, 1000 - i - (n - 1)]);
    for (let j = 1; j < n; j += 1) rows.push([`k${String(i).padStart(3, '0')}`, 1]);
  }
  // The empty group KEPT: a null key with the largest sum of all, which also
  // exercises `NULL IN (…)` being NULL (the keepNull flag) rather than folded.
  rows.push([null, 2000]);
  // '' is a DIFFERENT group from null, and a small one — it folds into Other.
  rows.push(['', 1]);
  return rows;
}

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();

  if (!residentQuery.isResident()) {
    console.error('FAIL vizCategory: DuckDB bridge unavailable — nothing was verified');
    process.exit(1);
  }

  const proj = await projects.createProject('Viz category');

  async function save(name: string, columns: ParsedColumn[], rows: Cell[][], label: string): Promise<Fixture> {
    const rec = await datasets.saveDataset(proj.id, { name, sourceKind: 'csv', columns, rows });
    if (!rec) throw new Error('fixture save failed: ' + label);
    // Read back through the REAL loader so the reference sees the STORED cells
    // (a Parquet round trip is not an identity on every cell type).
    const ds = await realGetDataset(proj.id, rec.id);
    if (!ds) throw new Error('fixture read-back failed: ' + label);
    return { id: ds.id, projectId: proj.id, label, columns: ds.columns, rows: ds.rows };
  }

  const dates = await save('dates', DATE_COLUMNS, dateRows(), 'dates');
  const loose = await save('loose-dates', DATE_COLUMNS, looseDateRows(), 'loose');
  const nums = await save('numbers', NUM_COLUMNS, numberRows(), 'numbers');
  const texts = await save('texts', TEXT_COLUMNS, textRows(), 'texts');
  ok('fixtures saved and read back', dates.rows.length > 0 && nums.rows.length > 0 && texts.rows.length > 0);

  // ── 1. Date grain, all five, both paths ───────────────────────────────────
  for (const grain of categoryKey.DATE_GRAINS) {
    const enc: VizEncoding = {
      category: 'd',
      values: [{ column: 'v', aggregation: 'sum' }, { column: 'v', aggregation: 'count' }],
      grain,
    };
    await diff(`date grain=${grain}`, dates, enc);
  }

  // The DEFAULT grain: no `grain` on the encoding, so both paths must choose the
  // same one from the same distinct-bucket counts. 300 dates over ~2.5 years
  // means day and week overflow GRAIN_MAX_POINTS and month is the first that
  // fits — asserted here so a change to the cost model is visible.
  {
    const enc: VizEncoding = { category: 'd', values: [{ column: 'v', aggregation: 'avg' }] };
    await diff('date grain=default', dates, enc);
    const { reply } = await viaFunnel(dates, enc);
    ok('default grain is reported back to the renderer', reply.category?.kind === 'date' && Boolean(reply.category?.grain));
    ok('default grain keeps the axis under GRAIN_MAX_POINTS',
      reply.data.labels.length <= categoryKey.GRAIN_MAX_POINTS,
      `${reply.data.labels.length} labels, grain=${reply.category?.grain}`);
  }

  // An unknown grain is DROPPED by sanitizeEncoding, not clamped, so the chart
  // falls back to the chosen default rather than to a silently different grain.
  {
    const bogus = { category: 'd', values: [{ column: 'v', aggregation: 'sum' }], grain: 'decade' };
    ok('sanitizeEncoding drops an unknown grain', visuals.sanitizeEncoding(bogus).grain === undefined);
    await diff('date grain=<invalid>', dates, bogus);
  }

  // ── 2. A non-canonical date: the resident path DECLINES ───────────────────
  //
  // The JS path still answers, using Date.parse — that asymmetry is the whole
  // reason the probe exists, and it is asserted as a DECLINE (rows hydrated)
  // rather than hoped for.
  {
    const enc: VizEncoding = { category: 'd', values: [{ column: 'v', aggregation: 'sum' }], grain: 'month' };
    await diff('non-canonical date ("Jan 5, 2023")', loose, enc, { expectResident: false });
    // Straight at the resolver, over the REAL parquet file, so the null above
    // is the probe's decision and not an unreadable path or a dead bridge.
    const looseSrc = await datasets.residentSource(loose.projectId, loose.id);
    const cleanSrc = await datasets.residentSource(dates.projectId, dates.id);
    ok('fixtures are resident', Boolean(looseSrc && cleanSrc));
    ok('resolveCatKey refuses a non-canonical date column',
      residentQuery.resolveCatKey(looseSrc!, 'd', [{ column: 'v', aggregation: 'sum' }], [], 'month') === null);
    ok('…and accepts the same column without that one cell',
      residentQuery.resolveCatKey(cleanSrc!, 'd', [{ column: 'v', aggregation: 'sum' }], [], 'month') !== null);
    const js = reference(loose, enc);
    ok('and the JS path still buckets it (Date.parse)',
      js.data.labels.includes('2023-01') && js.category?.grain === 'month');
  }

  // ── 3. Numeric category → ten bins ────────────────────────────────────────
  {
    const enc: VizEncoding = {
      category: 'price',
      values: [{ column: 'qty', aggregation: 'sum' }, { column: 'qty', aggregation: 'avg' }],
    };
    await diff('number → 10 bins', nums, enc);
    const { reply } = await viaFunnel(nums, enc);
    ok('binned is reported back', reply.category?.kind === 'number' && reply.category?.binned === true);
    // 10 buckets plus the '' group for the two null-price rows.
    ok('at most NUM_BINS + 1 groups',
      reply.data.labels.length <= categoryKey.NUM_BINS + 1,
      `${reply.data.labels.length} labels`);
    ok('the empty-price group is still there', reply.data.labels.includes(''));
  }

  // Filters run BEFORE the bins are chosen, so the edges describe what is
  // actually plotted — on both paths.
  {
    const enc: VizEncoding = { category: 'price', values: [{ column: 'qty', aggregation: 'sum' }] };
    const filters: FilterStep[] = [{ type: 'filter', column: 'price', op: '<', value: 6000 }];
    await diff('number → bins, filtered', nums, enc, { filters, expectResident: true });
  }

  // ── 3b. An encoding that NAMES its bucket count ───────────────────────────
  //
  // `bins` is the numeric twin of `grain`, and the column-profile panel asks
  // for 20 of them. The risk it introduces is specific: the count reaches the
  // JS path through `vizData.rewriteCategory` and the resident path through
  // `residentQuery.binKey`, so a count honoured by one and dropped by the other
  // would put every bucket edge in a different place — and the shipped funnel
  // would still return a perfectly plausible chart. Only a differential at a
  // NON-DEFAULT count can see that, which is what these are.
  {
    const enc: VizEncoding = {
      category: 'price',
      values: [{ column: 'qty', aggregation: 'sum' }, { column: 'qty', aggregation: 'avg' }],
    };
    for (const bins of [2, 20, categoryKey.MAX_BINS]) {
      await diff(`number → ${bins} bins`, nums, { ...enc, bins });
      const { reply } = await viaFunnel(nums, { ...enc, bins });
      // The count is ASSERTED, not just agreed on: both paths reading the same
      // wrong default would satisfy the differential above and fail here.
      ok(`number → ${bins} bins: exactly ${bins} buckets + the '' group`,
        reply.data.labels.length === bins + 1,
        `${reply.data.labels.length} labels`);
    }
    // Filtered, at a named count — the two rewrites compose.
    await diff('number → 20 bins, filtered', nums, { ...enc, bins: 20 },
      { filters: [{ type: 'filter', column: 'price', op: '<', value: 6000 }], expectResident: true });
  }

  // An out-of-range or malformed `bins` is DROPPED, never clamped — the rule
  // `sanitizeEncoding` applies to every enum it whitelists. The chart falls back
  // to NUM_BINS, so each of these must be indistinguishable from naming nothing.
  {
    const base: VizEncoding = { category: 'price', values: [{ column: 'qty', aggregation: 'sum' }] };
    const def = await viaFunnel(nums, base);
    // Labelled with String(), not JSON.stringify: the latter renders NaN,
    // Infinity and null all as "null", which would give three assertions the
    // same name and make one of them failing unreadable.
    for (const bad of [0, 1, -5, 101, 7.5, NaN, Infinity, '20', null, {}]) {
      const got = await viaFunnel(nums, { ...base, bins: bad });
      ok(`bins=${typeof bad === 'string' ? `"${bad}"` : String(bad)} (${typeof bad}) is dropped → the default ${categoryKey.NUM_BINS}`,
        sameLabels(def.reply.data.labels, got.reply.data.labels),
        JSON.stringify({ want: def.reply.data.labels.length, got: got.reply.data.labels.length }));
    }
  }

  // A NAMED count on a text or date column is ignored rather than honoured —
  // `bins` is a numeric-axis key, and nothing else may quietly consume it.
  {
    const plain = await viaFunnel(dates, { category: 'd', values: [{ column: 'v', aggregation: 'sum' }], grain: 'month' });
    const withBins = await viaFunnel(dates, { category: 'd', values: [{ column: 'v', aggregation: 'sum' }], grain: 'month', bins: 20 });
    ok('bins on a DATE category changes nothing',
      sameLabels(plain.reply.data.labels, withBins.reply.data.labels));
  }

  // ── 4. Text category → top 50, and 'Other' is a REAL re-aggregation ───────
  //
  // `avg` is the measure that catches a naive implementation: folding the tail's
  // already-aggregated numbers gives a mean of means, which is not the mean.
  {
    const enc: VizEncoding = {
      category: 'k',
      values: [
        { column: 'v', aggregation: 'sum' },
        { column: 'v', aggregation: 'avg' },
        { column: 'v', aggregation: 'min' },
        { column: 'v', aggregation: 'count' },
      ],
    };
    await diff('text → top 50 + Other', texts, enc);
    const { reply } = await viaFunnel(texts, enc);
    ok('the cap note is reported back', reply.category?.note === categoryKey.OTHER_NOTE);
    ok('the note is NOT a warning', reply.warnings.length === 0);
    ok('exactly CATEGORY_CAP + 1 groups',
      reply.data.labels.length === categoryKey.CATEGORY_CAP + 1,
      `${reply.data.labels.length} labels`);
    ok('one group is literally "Other"',
      reply.data.labels.filter((l: string | number) => l === categoryKey.OTHER_LABEL).length === 1);
    // The cut is deterministic by construction: sums are null 2000, k000 1000,
    // k001 999 … k059 941, '' 1. So the top 50 are the null key plus k000–k048,
    // and k049–k059 and '' fold. Pinning it makes the two properties that could
    // otherwise pass silently explicit — that the NULL key wins its rank at all
    // (`NULL IN (…)` is NULL, so it needs the keepNull flag), and that '' is a
    // DIFFERENT group from null even though both render blank.
    ok('the kept empty group survives the cap', reply.data.labels.includes(''));
    ok('k048 is kept', reply.data.labels.includes('k048'));
    ok('k049 folded', !reply.data.labels.includes('k049'));

    // The independent check on 'Other': recompute it here from the raw rows.
    const folded = new Set<string>(['']);
    for (let i = 49; i < 60; i += 1) folded.add(`k${String(i).padStart(3, '0')}`);
    const tail = texts.rows.filter((r) => typeof r[0] === 'string' && folded.has(r[0]));
    const tailNums = tail.map((r) => r[1]).filter((v): v is number => typeof v === 'number');
    const trueMean = tailNums.reduce((a, b) => a + b, 0) / tailNums.length;
    const oi = reply.data.labels.indexOf(categoryKey.OTHER_LABEL);
    ok('Other is the mean over its ROWS, not a mean of means',
      Object.is(reply.data.series[1].values[oi], trueMean),
      `got ${reply.data.series[1].values[oi]} want ${trueMean} over ${tailNums.length} rows`);
    ok('Other counts every one of its rows',
      Object.is(reply.data.series[3].values[oi], tail.length),
      `got ${reply.data.series[3].values[oi]} want ${tail.length}`);
  }

  // Under the cap nothing is rewritten at all: the resident path stays on the
  // plain group key and the note is absent.
  {
    const enc: VizEncoding = { category: 'k', values: [{ column: 'v', aggregation: 'sum' }] };
    const filters: FilterStep[] = [{ type: 'filter', column: 'k', op: 'contains', value: 'k00' }];
    await diff('text → under the cap, untouched', texts, enc, { filters, expectResident: true });
    const { reply } = await viaFunnel(texts, enc, filters);
    ok('under the cap: no note', reply.category?.kind === 'text' && reply.category?.note === undefined);
  }

  // ── 5. Branch (C) raw is left completely alone ────────────────────────────
  //
  // A scatter plots one point per row; binning its x-axis would destroy it.
  {
    const enc: VizEncoding = { category: 'price', values: [{ column: 'qty', aggregation: 'none' }] };
    const want = reference(nums, enc);
    ok('raw build: one point per row', want.data.labels.length === nums.rows.length);
    ok('raw build: no category rewrite', want.category === undefined);
    ok('raw build: labels are the raw cells',
      Object.is(want.data.labels[0], nums.rows[0][0] === null ? '' : nums.rows[0][0]));
  }

  // ── 6. Branch (B) split/pivot gets the same key on the JS path ────────────
  //
  // The resident path still implements (A) only, so this one is asserted
  // against the reference directly rather than differentially.
  {
    const enc: VizEncoding = {
      category: 'd',
      series: 'v',
      values: [{ column: 'v', aggregation: 'sum' }],
      grain: 'year' as DateGrain,
    };
    const out = reference(dates, enc);
    ok('pivot: the category is grained too', out.category?.kind === 'date' && out.category?.grain === 'year');
    ok('pivot: labels are year buckets',
      out.data.labels.every((l) => l === '' || /^\d{4}$/.test(String(l))),
      JSON.stringify(out.data.labels));
  }

  // ── 7. The hydrate ceiling holds for a map too ────────────────────────────
  //
  // A map always hydrates and is answered by ipc/vizExtras before the ceiling's
  // own place in vizDataFor, so the plan preview's cap is checked first.
  {
    const enc = { category: 'k', values: [{ column: 'v', aggregation: 'sum' }], geo: { level: 'us_state' } } as VizEncoding;
    const capped = await ipcVisuals.vizDataFor(proj.id, texts.id, enc, [], { maxHydrateRows: texts.rows.length - 1 });
    ok('map over the ceiling: tooLarge, not a hydrate', !capped.ok && capped.tooLarge === true, JSON.stringify(capped));
    const under = await ipcVisuals.vizDataFor(proj.id, texts.id, enc, [], { maxHydrateRows: texts.rows.length });
    ok('map at the ceiling: answered', under.ok === true, JSON.stringify(under).slice(0, 200));
  }
}

function cleanup(): void {
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

main()
  .then(() => {
    duck.shutdown();
    cleanup();
    if (failureCount() > 0) {
      console.error(`\n${failureCount()} vizCategory check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll vizCategory checks passed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAIL vizCategory: ' + (err && err.stack ? err.stack : String(err)));
    cleanup();
    process.exit(1);
  });
