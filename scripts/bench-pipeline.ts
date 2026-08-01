// Phase 1 compute benchmark — pure-JS pipeline vs (later) DuckDB.
//
// Measures the REAL exported API of src/transforms.ts, src/vizData.ts,
// src/datasetStats.ts and src/metricValue.ts over deterministic synthetic tables
// at 10k / 100k / 1M rows. Nothing is reimplemented here: the compiled siblings
// are require()d exactly as the IPC layer requires them, and the column-cell
// extraction each call site does (`rows.map(r => r[c])`) is timed with the call,
// because that cost is real.
//
// ── Running it ───────────────────────────────────────────────────────────────
//   npm run build:ts && node scripts/bench-pipeline.js
//
//   --sizes=10000,100000        override the row counts
//   --label=<name>              name this run (default "before")
//   --json                      print the machine-readable result to stdout
//   --json-out=<path>           also write that JSON to a file
//   --out=<path>                markdown destination (default
//                               docs/phase-1/benchmark-baseline.md; "-" = none)
//   --baseline=<path.json>      diff this run against an earlier --json-out file
//
// ── How to run the AFTER pass (post-DuckDB) ──────────────────────────────────
// The harness does not know which implementation it is calling — it calls the
// module exports. When the DuckDB path lands BEHIND THE SAME EXPORTS
// (applyPipeline / buildVizData / computeColumnSummary / computeMetric /
// combineTables), the AFTER pass is the identical command:
//
//   npm run build:ts
//   node scripts/bench-pipeline.js --label=after \
//        --out=docs/phase-1/benchmark-after.md \
//        --json-out=docs/phase-1/benchmark-after.json \
//        --baseline=docs/phase-1/benchmark-baseline.json
//
// The diff column then shows after/before per case. If DuckDB lands behind NEW
// exports instead (e.g. a `duckPipeline`), add a second entry to CASES with the
// same `id` + a different `impl` tag rather than rewriting the harness — the
// result shape is keyed on {impl, id, size}.
//
// Every case records a `signature` (row/series counts + a rounded sum of the
// output numbers). The AFTER run MUST produce the same signatures; a changed
// signature means the migration changed the answer, not just the speed.
//
// ── Honesty notes (read before quoting any number) ───────────────────────────
//  * min / median / p95 are reported, never a single number. At 1M rows the
//    sample count is small (3), so p95 there is effectively "worst of 3".
//  * Peak memory is process.resourceUsage().maxRSS, which is monotonic for the
//    process lifetime — the per-size figure is "peak so far", not "peak of this
//    size alone". The delta column is the growth attributable to that block.
//  * A true out-of-memory abort cannot be caught in-process. Results are
//    flushed to disk after EVERY size block, so a hard crash still leaves the
//    smaller sizes recorded, and the missing block is the finding.
//  * A synchronous JS fold cannot be pre-empted, so there is no true timeout.
//    Instead each case is probed once; if the probe exceeds SLOW_PROBE_MS the
//    remaining iterations are dropped and the case is flagged `slow`.
//  * src/parse.ts caps a loaded table at 50,000 rows (MAX_ROWS) and
//    combineTables caps a join output at 50,000. Calling the compute functions
//    directly with 100k / 1M in-memory rows is legitimate (Postgres/xlsx paths
//    and combined datasets can already exceed what one parse returns) but it is
//    ABOVE what the shipping app can load from a file today. Treat 1M as a
//    headroom probe for the migration, not as a current-user scenario.

export {}; // module scope — sibling scripts share top-level names

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const os = require('os') as typeof import('os');

// ponytail: compiled siblings of the src/ modules under test.
const transforms: typeof import('../src/transforms') = require('../src/transforms');
const vizData: typeof import('../src/vizData') = require('../src/vizData');
const datasetStats: typeof import('../src/datasetStats') = require('../src/datasetStats');
const metricValue: typeof import('../src/metricValue') = require('../src/metricValue');

const { applyPipeline, combineTables } = transforms;
const { buildVizData } = vizData;
const { computeColumnSummary } = datasetStats;
const { computeMetric } = metricValue;

type ParsedColumn = import('../src/parse').ParsedColumn;
type Cell = import('../src/transforms').Cell;
type TableData = import('../src/transforms').TableData;
type TransformStep = import('../src/transforms').TransformStep;

// ── Deterministic data generation ────────────────────────────────────────────
// xorshift32, NOT Math.random(): the same seed must produce the same table on
// every machine and in the AFTER run, or before/after is not comparable.

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

const SEED = 20260801;
const N_CATEGORY = 50; // low-cardinality dimension
const N_REGION = 5;    // very-low-cardinality dimension

const CATEGORIES = Array.from({ length: N_CATEGORY }, (_, i) => `product-${String(i + 1).padStart(2, '0')}`);
const REGIONS = ['north', 'south', 'east', 'west', 'central'];

// Columns:
//   category  text   ~50 distinct
//   region    text   5 distinct
//   amount    number the measure
//   units     number a second measure (so group_aggregate has 3 real aggs)
//   sku       text   "007"-style LEADING ZEROS — must never become a number
//   day       text   date-ish "2024-03-05"
function generate(rowCount: number): TableData {
  const rng = makeRng(SEED);
  const columns: ParsedColumn[] = [
    { name: 'category', type: 'text' },
    { name: 'region', type: 'text' },
    { name: 'amount', type: 'number' },
    { name: 'units', type: 'number' },
    { name: 'sku', type: 'text' },
    { name: 'day', type: 'text' },
  ];
  const rows: Cell[][] = new Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) {
    const cat = CATEGORIES[Math.floor(rng() * N_CATEGORY)];
    const region = REGIONS[Math.floor(rng() * N_REGION)];
    const amount = Math.round(rng() * 1_000_000) / 100; // 2dp, 0..10000
    const units = 1 + Math.floor(rng() * 40);
    const sku = String(Math.floor(rng() * 1000)).padStart(3, '0'); // "007"
    const month = 1 + Math.floor(rng() * 12);
    const dayOfMonth = 1 + Math.floor(rng() * 28);
    const day = `2024-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
    rows[i] = [cat, region, amount, units, sku, day];
  }
  return { columns, rows };
}

// The join's right side: one row per category (a lookup table), the realistic
// shape — a big fact table joined to a small dimension table.
function generateLookup(): TableData {
  return {
    columns: [
      { name: 'category', type: 'text' },
      { name: 'owner', type: 'text' },
      { name: 'target', type: 'number' },
    ],
    rows: CATEGORIES.map((c, i) => [c, `owner-${(i % 7) + 1}`, (i + 1) * 1000] as Cell[]),
  };
}

// ── Case definitions ─────────────────────────────────────────────────────────
// Each case returns a `signature`: a compact, order-independent-enough summary
// of the OUTPUT. The AFTER run must reproduce it exactly.

interface Fixture {
  table: TableData;
  lookup: TableData;
}

interface BenchCase {
  id: string;
  label: string;
  run: (f: Fixture) => string;
}

function sumOfNumbers(rows: Cell[][]): number {
  let total = 0;
  for (const r of rows) for (const c of r) if (typeof c === 'number' && Number.isFinite(c)) total += c;
  return Math.round(total * 100) / 100;
}

const FILTER_STEP: TransformStep = { type: 'filter', column: 'amount', op: '>', value: 5000 };

const GROUP_STEP: TransformStep = {
  type: 'group_aggregate',
  groupBy: ['category'],
  aggregations: [
    { column: 'amount', fn: 'sum', as: 'total_amount' },
    { column: 'units', fn: 'avg', as: 'avg_units' },
    { column: 'sku', fn: 'count', as: 'rows' },
  ],
};

const CHAIN_STEPS: TransformStep[] = [
  { type: 'filter', column: 'amount', op: '>', value: 2500 },
  { type: 'calculated_field', name: 'revenue', expression: 'amount * units' },
  {
    type: 'group_aggregate',
    groupBy: ['category', 'region'],
    aggregations: [
      { column: 'revenue', fn: 'sum', as: 'total_revenue' },
      { column: 'amount', fn: 'max', as: 'max_amount' },
    ],
  },
  { type: 'dedupe', columns: ['category'] },
];

const CASES: BenchCase[] = [
  {
    id: 'pipeline.filter',
    label: 'applyPipeline — 1 filter (amount > 5000)',
    run: (f) => {
      const r = applyPipeline(f.table, [FILTER_STEP]);
      return `rows=${r.rowCount} sum=${sumOfNumbers(r.rows)}`;
    },
  },
  {
    id: 'pipeline.group_aggregate',
    label: 'applyPipeline — group_aggregate (1 groupBy, 3 aggs)',
    run: (f) => {
      const r = applyPipeline(f.table, [GROUP_STEP]);
      return `rows=${r.rowCount} sum=${sumOfNumbers(r.rows)}`;
    },
  },
  {
    id: 'pipeline.chain4',
    label: 'applyPipeline — 4 steps (filter → calc → group → dedupe)',
    run: (f) => {
      const r = applyPipeline(f.table, CHAIN_STEPS);
      return `rows=${r.rowCount} sum=${sumOfNumbers(r.rows)} warn=${r.warnings.length}`;
    },
  },
  {
    id: 'vizData.aggregated',
    label: 'buildVizData — aggregated (category × sum amount)',
    run: (f) => {
      const r = buildVizData(f.table.columns, f.table.rows, {
        category: 'category',
        values: [{ column: 'amount', aggregation: 'sum' }],
      });
      const total = r.data.series.reduce(
        (a, s) => a + s.values.reduce((b: number, v) => b + (typeof v === 'number' ? v : 0), 0),
        0,
      );
      return `labels=${r.data.labels.length} series=${r.data.series.length} sum=${Math.round(total * 100) / 100}`;
    },
  },
  {
    id: 'vizData.pivot',
    label: 'buildVizData — split/pivot (category × region, sum amount)',
    run: (f) => {
      const r = buildVizData(f.table.columns, f.table.rows, {
        category: 'category',
        values: [{ column: 'amount', aggregation: 'sum' }],
        series: 'region',
      });
      const total = r.data.series.reduce(
        (a, s) => a + s.values.reduce((b: number, v) => b + (typeof v === 'number' ? v : 0), 0),
        0,
      );
      return `labels=${r.data.labels.length} series=${r.data.series.length} sum=${Math.round(total * 100) / 100}`;
    },
  },
  {
    id: 'stats.allColumns',
    label: 'computeColumnSummary — all 6 columns',
    run: (f) => {
      // Mirrors the real call site (src/ipc/datasets.ts): one column-cell
      // extraction per column, then the summary. Both are timed.
      const parts = f.table.columns.map((col, c) => {
        const s = computeColumnSummary(col, f.table.rows.map((row) => (row ? row[c] ?? null : null)));
        return `${s.name}:${s.nonEmpty}:${s.distinct ?? Math.round((s.mean ?? 0) * 100) / 100}`;
      });
      return parts.join('|');
    },
  },
  {
    id: 'metric.sum',
    label: 'computeMetric — sum(amount)',
    run: (f) => {
      const v = computeMetric(f.table.columns, f.table.rows, { column: 'amount', aggregation: 'sum' });
      return `value=${v === null ? 'null' : Math.round(v * 100) / 100}`;
    },
  },
  {
    id: 'combine.join',
    label: 'combineTables — inner join on category (right = 50-row lookup)',
    run: (f) => {
      const r = combineTables(f.table, f.lookup, 'join', { left: 'category', right: 'category' });
      // combineTables re-types EVERY output column (retypeColumn), so the join is
      // where a leading-zero id is most at risk of silently becoming a number.
      // The signature carries sku's post-join type so the AFTER run must match.
      const sku = r.columns.find((c) => c.name === 'sku');
      return `rows=${r.rowCount} cols=${r.columns.length} warn=${r.warnings.length} skuType=${sku ? sku.type : 'missing'}`;
    },
  },
];

// ── Timing / measurement ─────────────────────────────────────────────────────

// Iteration budget per size. Fewer at 1M — one run there is expensive, and a
// long warm-up would risk an OOM before anything is written to disk.
const PLAN: Record<string, { warmup: number; iters: number }> = {
  '10000': { warmup: 2, iters: 12 },
  '100000': { warmup: 1, iters: 6 },
  '1000000': { warmup: 1, iters: 3 },
};
function planFor(size: number): { warmup: number; iters: number } {
  const exact = PLAN[String(size)];
  if (exact) return exact;
  if (size <= 20_000) return { warmup: 2, iters: 12 };
  if (size <= 200_000) return { warmup: 1, iters: 6 };
  return { warmup: 1, iters: 3 };
}

// A synchronous fold cannot be interrupted, so there is no real timeout. If the
// first (probe) iteration is slower than this, the extra iterations are skipped
// and the case is flagged — a slow case must not turn a benchmark into an hour.
const SLOW_PROBE_MS = 15_000;

interface CaseResult {
  impl: string;
  id: string;
  label: string;
  size: number;
  status: 'ok' | 'failed' | 'skipped';
  iterations: number;
  minMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  samplesMs: number[];
  signature: string | null;
  note: string | null;
  error: string | null;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank. With 3 samples, p95 IS the max — reported as such, not dressed up.
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function runCase(c: BenchCase, f: Fixture, size: number, impl: string): CaseResult {
  const base: CaseResult = {
    impl, id: c.id, label: c.label, size,
    status: 'ok', iterations: 0,
    minMs: null, medianMs: null, p95Ms: null, samplesMs: [],
    signature: null, note: null, error: null,
  };
  const { warmup, iters } = planFor(size);
  let signature: string | null = null;

  try {
    for (let i = 0; i < warmup; i += 1) signature = c.run(f);
  } catch (e) {
    base.status = 'failed';
    base.error = describeError(e);
    return base;
  }

  const samples: number[] = [];
  let note: string | null = null;
  try {
    for (let i = 0; i < iters; i += 1) {
      const t0 = nowMs();
      signature = c.run(f);
      const dt = nowMs() - t0;
      samples.push(dt);
      if (i === 0 && dt > SLOW_PROBE_MS) {
        note = `probe took ${Math.round(dt)}ms (> ${SLOW_PROBE_MS}ms) — remaining iterations dropped; single sample only`;
        break;
      }
    }
  } catch (e) {
    base.status = 'failed';
    base.error = describeError(e);
    base.iterations = samples.length;
    base.samplesMs = samples.map(round);
    base.signature = signature;
    return base;
  }

  const sorted = samples.slice().sort((a, b) => a - b);
  base.iterations = samples.length;
  base.samplesMs = samples.map(round);
  base.minMs = round(sorted[0]);
  base.medianMs = round(quantile(sorted, 0.5));
  base.p95Ms = round(quantile(sorted, 0.95));
  base.signature = signature;
  base.note = note;
  return base;
}

function describeError(e: unknown): string {
  if (e instanceof RangeError) return `RangeError (likely out of memory / array limit): ${e.message}`;
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

// ── Memory ───────────────────────────────────────────────────────────────────
// process.resourceUsage().maxRSS is the OS peak RSS for the whole process
// lifetime (kilobytes) — monotonic, so per-size we report "peak so far" plus the
// growth over that block. In-call peaks cannot be sampled: the compute is
// synchronous and blocks the event loop, so no timer could ever fire mid-run.

function maxRssMb(): number {
  return Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10;
}
function rssMb(): number {
  return Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
}

interface SizeBlock {
  size: number;
  generated: boolean;
  genMs: number | null;
  peakRssMbAfter: number;
  peakRssMbDelta: number;
  rssMbAfter: number;
  error: string | null;
  results: CaseResult[];
}

// ── Args ─────────────────────────────────────────────────────────────────────

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return null;
}
function argFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

const REPO_ROOT = path.resolve(__dirname, '..');
const sizes = (argValue('sizes') ?? '10000,100000,1000000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const label = argValue('label') ?? 'before';
const impl = argValue('impl') ?? 'js';
const wantJson = argFlag('json');
const jsonOut = argValue('json-out');
const mdOutRaw = argValue('out') ?? path.join(REPO_ROOT, 'docs', 'phase-1', 'benchmark-baseline.md');
const mdOut = mdOutRaw === '-' ? null : path.resolve(REPO_ROOT, mdOutRaw);
const baselinePath = argValue('baseline');

type BaselineIndex = Map<string, CaseResult>;

function loadBaseline(): BaselineIndex | null {
  if (!baselinePath) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, baselinePath), 'utf8')) as Report;
    const idx: BaselineIndex = new Map();
    for (const b of raw.blocks) for (const r of b.results) idx.set(`${r.id}@${r.size}`, r);
    return idx;
  } catch (e) {
    console.error(`  !! baseline not loaded (${describeError(e)}) — diff column omitted`);
    return null;
  }
}

const baseline = loadBaseline();

// ── Run ──────────────────────────────────────────────────────────────────────

const cpus = os.cpus();
const env = {
  date: new Date().toISOString(),
  node: process.version,
  v8: process.versions.v8,
  platform: `${process.platform} ${process.arch} (${os.release()})`,
  cpu: cpus.length > 0 ? `${cpus[0].model} × ${cpus.length}` : 'unknown',
  totalMemGb: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
  heapLimitMb: Math.round((require('v8') as typeof import('v8')).getHeapStatistics().heap_size_limit / 1024 / 1024),
  execArgv: process.execArgv.join(' ') || '(none)',
};

const blocks: SizeBlock[] = [];

console.log(`Ordinate compute benchmark — label="${label}" impl="${impl}"`);
console.log(`  node ${env.node} · ${env.platform} · ${env.cpu} · ${env.totalMemGb} GB · heap limit ${env.heapLimitMb} MB`);
console.log(`  sizes: ${sizes.join(', ')} · cases: ${CASES.length}`);
console.log('');

const lookup = generateLookup();

for (const size of sizes) {
  const peakBefore = maxRssMb();
  const block: SizeBlock = {
    size, generated: false, genMs: null,
    peakRssMbAfter: peakBefore, peakRssMbDelta: 0, rssMbAfter: rssMb(),
    error: null, results: [],
  };
  blocks.push(block);

  console.log(`── ${size.toLocaleString('en-US')} rows ─────────────────────────────`);
  let table: TableData;
  try {
    const t0 = nowMs();
    table = generate(size);
    block.genMs = round(nowMs() - t0);
    block.generated = true;
    console.log(`  generated in ${block.genMs} ms`);
  } catch (e) {
    block.error = describeError(e);
    console.error(`  !! DATA GENERATION FAILED: ${block.error}`);
    console.error('  !! ALL CASES AT THIS SIZE ARE SKIPPED — this is a finding, not a gap.');
    for (const c of CASES) {
      block.results.push({
        impl, id: c.id, label: c.label, size, status: 'skipped',
        iterations: 0, minMs: null, medianMs: null, p95Ms: null, samplesMs: [],
        signature: null, note: 'skipped: dataset generation failed at this size', error: block.error,
      });
    }
    flush();
    continue;
  }

  const fixture: Fixture = { table, lookup };
  for (const c of CASES) {
    process.stdout.write(`  ${c.id} … `);
    const res = runCase(c, fixture, size, impl);
    block.results.push(res);
    if (res.status === 'ok') {
      console.log(`min ${res.minMs} ms · median ${res.medianMs} ms · p95 ${res.p95Ms} ms · n=${res.iterations}${res.note ? ` · ${res.note}` : ''}`);
    } else {
      console.log(`FAILED (${res.error})`);
    }
    // Flush after every case: an OOM abort is uncatchable, so anything already
    // measured must already be on disk.
    block.peakRssMbAfter = maxRssMb();
    block.peakRssMbDelta = Math.round((block.peakRssMbAfter - peakBefore) * 10) / 10;
    block.rssMbAfter = rssMb();
    flush();
  }

  console.log(`  peak RSS after this block: ${block.peakRssMbAfter} MB (grew ${block.peakRssMbDelta} MB) · current RSS ${block.rssMbAfter} MB`);
  console.log('');

  // `table`/`fixture` are block-scoped and die here, so the next (larger) size
  // does not stack on top of this one. Nudge V8 when run with --expose-gc.
  const g = (globalThis as unknown as { gc?: () => void }).gc;
  if (typeof g === 'function') g();
}

// ── Output ───────────────────────────────────────────────────────────────────

interface Report {
  schema: 1;
  label: string;
  impl: string;
  env: typeof env;
  sizes: number[];
  blocks: SizeBlock[];
}

function report(): Report {
  return { schema: 1, label, impl, env, sizes, blocks };
}

function fmt(n: number | null): string {
  return n === null ? '—' : String(n);
}

function markdown(): string {
  const r = report();
  const L: string[] = [];
  L.push(`# Phase 1 — compute benchmark (${r.label})`);
  L.push('');
  L.push(`Generated by \`scripts/bench-pipeline.ts\` on ${r.env.date}.`);
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Node | ${r.env.node} (V8 ${r.env.v8}) |`);
  L.push(`| Platform | ${r.env.platform} |`);
  L.push(`| CPU | ${r.env.cpu} |`);
  L.push(`| Memory | ${r.env.totalMemGb} GB (V8 heap limit ${r.env.heapLimitMb} MB) |`);
  L.push(`| node flags | ${r.env.execArgv} |`);
  L.push(`| Implementation | \`${r.impl}\` (pure-JS \`src/\` modules as exported today) |`);
  L.push('');
  L.push('## How to read this');
  L.push('');
  L.push('- Timings are wall-clock milliseconds around the real module export, warm-up excluded.');
  L.push('- **min / median / p95** are all reported. At 1M rows only 3 iterations run, so p95 there is the worst of 3 — treat it as a range, not a tail estimate.');
  L.push('- `signature` is a compact summary of each case\'s OUTPUT. The AFTER (DuckDB) run must reproduce every signature exactly; a changed signature means the answer changed, not just the speed.');
  L.push('- Peak memory is `process.resourceUsage().maxRSS`, which is monotonic for the process, so the per-size figure is "peak so far" and the delta is the growth attributable to that block. An in-call peak is not observable: the compute is synchronous and blocks the event loop, so no sampler could fire.');
  L.push('- A synchronous fold cannot be pre-empted, so there is no true timeout. A case whose first iteration exceeds 15 s drops its remaining iterations and is flagged.');
  L.push('');
  L.push('> **Scope caveat.** `src/parse.ts` caps a parsed table at **50,000 rows** (`MAX_ROWS`), and `combineTables` caps a join output at 50,000. This benchmark calls the compute functions directly with in-memory tables, which is legitimate — nothing in `transforms`/`vizData`/`datasetStats`/`metricValue` enforces a row cap, and Postgres/xlsx/combined datasets can already exceed one parse — but **100k and 1M rows are above what the shipping app can load from a file today**. Read 1M as a headroom probe for the migration, not as a current user scenario.');
  L.push('');
  L.push('## Cases');
  L.push('');
  L.push('Every case calls the real module export — nothing is reimplemented in the harness.');
  L.push('');
  for (const c of CASES) L.push(`- \`${c.id}\` — ${c.label}`);
  L.push('');
  L.push('Data is generated by a seeded xorshift32 (seed `20260801`) — no `Math.random()` — so every run sees byte-identical tables. Columns: `category` (~50 distinct text), `region` (5 distinct text), `amount` (number), `units` (number), `sku` (**leading-zero text, `"007"`-style** — the correctness-sensitive column), `day` (date-ish text). The join\'s right side is a 50-row `category → owner/target` lookup, i.e. the realistic big-fact-to-small-dimension shape.');
  L.push('');

  // Per-size detail is collected here and appended AFTER the scaling summary —
  // the summary is what the phase gate is read against.
  const D: string[] = ['## Per-size detail', ''];
  for (const b of r.blocks) {
    D.push(`### ${b.size.toLocaleString('en-US')} rows`);
    D.push('');
    if (!b.generated) {
      D.push(`**DATA GENERATION FAILED — every case at this size was SKIPPED.**`);
      D.push('');
      D.push(`\`\`\`\n${b.error}\n\`\`\``);
      D.push('');
      continue;
    }
    D.push(`Fixture built in ${b.genMs} ms. Peak RSS after this block: **${b.peakRssMbAfter} MB** (grew ${b.peakRssMbDelta} MB during it); RSS at block end ${b.rssMbAfter} MB.`);
    D.push('');
    const head = ['Case', 'n', 'min (ms)', 'median (ms)', 'p95 (ms)', 'signature / status'];
    if (baseline) head.push('vs baseline');
    D.push(`| ${head.join(' | ')} |`);
    D.push(`|${head.map(() => '---').join('|')}|`);
    for (const c of b.results) {
      const status =
        c.status === 'ok'
          ? `\`${c.signature ?? ''}\`${c.note ? ` — **${c.note}**` : ''}`
          : `**${c.status.toUpperCase()}** — ${c.error}`;
      const cells = [`\`${c.id}\``, String(c.iterations), fmt(c.minMs), fmt(c.medianMs), fmt(c.p95Ms), status];
      if (baseline) {
        const prev = baseline.get(`${c.id}@${c.size}`);
        if (prev && prev.medianMs && c.medianMs) {
          const ratio = c.medianMs / prev.medianMs;
          cells.push(`${ratio < 1 ? `${round(1 / ratio)}× faster` : `${round(ratio)}× slower`}`);
        } else cells.push('—');
      }
      D.push(`| ${cells.join(' | ')} |`);
    }
    D.push('');
  }

  // ── Scaling + observations: derived from the numbers above, never hand-typed,
  // so a re-run can never leave stale prose behind.
  const done = r.blocks.filter((b) => b.generated);
  if (done.length >= 2) {
    L.push('## Scaling');
    L.push('');
    L.push('Median ms per case per size, plus the growth factor between consecutive sizes. A 10× row increase costing ~10× time is linear; materially more than 10× is super-linear and is where a set-based engine wins.');
    L.push('');
    const head = ['Case'];
    done.forEach((b, i) => {
      head.push(`median @ ${b.size.toLocaleString('en-US')} (ms)`);
      if (i > 0) head.push(`vs prev (${round(b.size / done[i - 1].size)}× rows)`);
    });
    head.push('ns / row @ largest');
    L.push(`| ${head.join(' | ')} |`);
    L.push(`|${head.map(() => '---').join('|')}|`);
    for (const c of CASES) {
      const per = done.map((b) => b.results.find((x) => x.id === c.id) ?? null);
      const cells: string[] = [`\`${c.id}\``];
      per.forEach((p, i) => {
        cells.push(p && p.medianMs !== null ? String(p.medianMs) : '—');
        if (i > 0) {
          const prev = per[i - 1];
          cells.push(prev && prev.medianMs && p && p.medianMs ? `${round(p.medianMs / prev.medianMs)}×` : '—');
        }
      });
      const last = per[per.length - 1];
      const lastSize = done[done.length - 1].size;
      cells.push(last && last.medianMs !== null ? String(Math.round((last.medianMs * 1e6) / lastSize)) : '—');
      L.push(`| ${cells.join(' | ')} |`);
    }
    L.push('');
    L.push('Memory, per size:');
    L.push('');
    L.push('| Rows | fixture build (ms) | peak RSS after block | growth during block | bytes / row (growth ÷ rows) |');
    L.push('|---|---|---|---|---|');
    for (const b of done) {
      L.push(`| ${b.size.toLocaleString('en-US')} | ${b.genMs} | ${b.peakRssMbAfter} MB | ${b.peakRssMbDelta} MB | ~${Math.round((b.peakRssMbDelta * 1024 * 1024) / b.size)} |`);
    }
    L.push('');
    L.push('The FIRST block\'s growth also carries process start-up (module load, V8 warm-up), so its bytes/row is inflated; the largest block is the honest per-row figure.');
    L.push('');
    const capped = r.blocks.flatMap((b) => b.results).filter((c) => (c.signature ?? '').includes('warn=1'));
    if (capped.length > 0) {
      L.push(`> **Row cap hit.** ${capped.length} case run(s) reported a cap warning in their signature (\`warn=1\`) — \`combineTables\` stops at 50,000 output rows, so at those sizes the join timing measures the CAP, not the full workload. Compare join numbers only where \`warn=0\`.`);
      L.push('');
    }
    const failedAll = r.blocks.flatMap((b) => b.results).filter((c) => c.status !== 'ok');
    L.push(failedAll.length === 0
      ? '**No case failed and none were skipped** — every operation completed at every size on this machine.'
      : `**${failedAll.length} case run(s) failed or were skipped** (listed inline above with their reason). A failure at a size IS a finding: it is the ceiling of the current implementation, not a gap in the harness.`);
    L.push('');
  }

  for (const line of D) L.push(line);

  L.push('## Reproducing / running the AFTER pass');
  L.push('');
  L.push('```bash');
  L.push('npm run build:ts');
  L.push('node scripts/bench-pipeline.js                 # this baseline');
  L.push('');
  L.push('# after DuckDB lands behind the same module exports:');
  L.push('node scripts/bench-pipeline.js --label=after --impl=duckdb \\');
  L.push('  --out=docs/phase-1/benchmark-after.md \\');
  L.push('  --json-out=docs/phase-1/benchmark-after.json \\');
  L.push('  --baseline=docs/phase-1/benchmark-baseline.json');
  L.push('```');
  L.push('');
  L.push('The harness never names an implementation — it calls `applyPipeline` / `buildVizData` / `computeColumnSummary` / `computeMetric` / `combineTables`. Swapping the bodies is enough; the same command produces the AFTER numbers and the `--baseline` flag adds the ratio column. Results are keyed `{impl, id, size}`, so a parallel DuckDB-only export can be added as a second `impl` instead of a rewrite.');
  L.push('');
  L.push('**This file is generated — do not hand-edit it.** Re-running the command above overwrites it in full.');
  L.push('');
  return L.join('\n');
}

function flush(): void {
  const r = report();
  if (mdOut) {
    fs.mkdirSync(path.dirname(mdOut), { recursive: true });
    fs.writeFileSync(mdOut, markdown(), 'utf8');
  }
  if (jsonOut) {
    const p = path.resolve(REPO_ROOT, jsonOut);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(r, null, 2), 'utf8');
  }
}

flush();

// Summary table to stdout — the same content the markdown carries.
console.log('══ summary ═══════════════════════════════════════════════════════');
const idWidth = Math.max(...CASES.map((c) => c.id.length));
for (const b of blocks) {
  console.log('');
  console.log(`${b.size.toLocaleString('en-US')} rows — peak RSS ${b.peakRssMbAfter} MB (+${b.peakRssMbDelta} MB)`);
  if (!b.generated) {
    console.log(`  !! SKIPPED ENTIRELY — ${b.error}`);
    continue;
  }
  console.log(`  ${'case'.padEnd(idWidth)}   ${'min'.padStart(10)} ${'median'.padStart(10)} ${'p95'.padStart(10)}   n`);
  for (const c of b.results) {
    if (c.status !== 'ok') {
      console.log(`  ${c.id.padEnd(idWidth)}   FAILED (${c.error})`);
      continue;
    }
    console.log(
      `  ${c.id.padEnd(idWidth)}   ${fmt(c.minMs).padStart(10)} ${fmt(c.medianMs).padStart(10)} ${fmt(c.p95Ms).padStart(10)}   ${c.iterations}${c.note ? `  << ${c.note}` : ''}`,
    );
  }
}
console.log('');

const failed = blocks.flatMap((b) => b.results).filter((r) => r.status !== 'ok');
if (failed.length > 0) {
  console.log(`!! ${failed.length} case(s) failed or were skipped:`);
  for (const f of failed) console.log(`   ${f.id} @ ${f.size}: ${f.status} — ${f.error}`);
  console.log('');
}

if (mdOut) console.log(`markdown → ${path.relative(REPO_ROOT, mdOut)}`);
if (jsonOut) console.log(`json     → ${path.relative(REPO_ROOT, path.resolve(REPO_ROOT, jsonOut))}`);
if (wantJson) console.log(JSON.stringify(report(), null, 2));
