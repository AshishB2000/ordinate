'use strict';

// Phase 3 benchmark — is querying Parquet IN PLACE actually faster than
// hydrate-then-fold?
//
//   npm run build:ts && node scripts/bench-resident.js
//     --sizes=10000,100000,1000000   override the row counts
//     --reps=<n>                     force the iteration count
//     --out=<path.md>                also write the markdown table to a file
//
// ── What is compared ────────────────────────────────────────────────────────
// Three columns, per case, per size:
//
//   (a) HYDRATE+COMPUTE  parquetStore.readTable(file, schema) followed by the
//                        existing JS metricValue.computeMetric /
//                        vizData.buildVizData. This is TODAY'S PATH: every IPC
//                        handler goes through datasets.getDataset, which reads
//                        the Parquet into Cell[][] before any consumer sees it.
//                        The read is included because it is a cost the app
//                        actually pays.
//   (a2) COMPUTE ONLY    the same JS call with the table ALREADY hydrated. This
//                        is the best case today's architecture could reach if
//                        the hydrated table were perfectly cached, and it is the
//                        honest hard target — beating (a) while losing to (a2)
//                        would mean the win is really "we stopped re-reading the
//                        file", not "SQL is faster".
//   (b) RESIDENT         residentQuery.computeMetricResident /
//                        aggregateResident — one query, nothing materialised.
//
// Every case asserts that (a) and (b) produce the SAME answer before it is
// timed. A speed number for a different answer is worthless.
//
// ── Honesty notes (read before quoting any number) ──────────────────────────
//  * min / median / p95, never a single number. At 1M the sample count is small,
//    so p95 there is effectively "worst of n".
//  * The DuckDB bridge is warmed before timing (worker start is ~115 ms, paid
//    once per process, and it is NOT what this benchmark is about).
//  * The Parquet file is warm in the OS page cache by the time it is timed,
//    for BOTH paths. A cold-cache first read would be slower for both.
//  * DuckDB queries block the main thread through a SharedArrayBuffer handshake
//    (src/duckdb.ts). The ~0.1 ms bridge crossing is inside every (b) number.
//  * (a) allocates a Cell[][] of `rows × cols` on every iteration, so its numbers
//    include GC pressure that (b) does not create. That is the real difference,
//    not an artefact.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pq from '../src/engine/parquetStore';
import * as rq from '../src/engine/residentQuery';
// The sync twins: this bench times the blocking resident query against the JS fold.
import { aggregateResidentSync, computeMetricResidentSync, resolveCatKeySync } from '../src/engine/residentSync';
import * as duck from '../src/engine/duckdb';
import * as metricValue from '../src/analysis/metricValue';
import * as vizData from '../src/analysis/vizData';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';

// ── args ─────────────────────────────────────────────────────────────────────

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}
const SIZES = (arg('sizes') ?? '10000,100000,1000000').split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
const FORCED_REPS = arg('reps') ? parseInt(arg('reps') as string, 10) : 0;
const OUT = arg('out');

function repsFor(n: number): number {
  if (FORCED_REPS > 0) return FORCED_REPS;
  if (n <= 10_000) return 15;
  if (n <= 100_000) return 9;
  return 5;
}

// ── fixture ──────────────────────────────────────────────────────────────────
//
// Deterministic, and deliberately shaped like real dashboard data: a
// low-cardinality dimension (region, 7), a high-cardinality one (sku, 1000), a
// numeric measure, and a leading-zero text id that must never be cast.

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'sku', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'code', type: 'text' },
];

function buildRows(n: number): Cell[][] {
  const rows: Cell[][] = new Array(n);
  let s = 987654321;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    rows[i] = [
      `region-${i % 7}`,
      `sku-${s % 1000}`,
      i % 40 === 0 ? null : (s % 100000) / 100,
      String(i % 10000).padStart(5, '0'),
    ];
  }
  return rows;
}

// ── timing ───────────────────────────────────────────────────────────────────

interface Stat {
  min: number;
  median: number;
  p95: number;
}

function time(reps: number, fn: () => unknown): Stat {
  fn(); // warm
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number): number => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return { min: samples[0], median: at(0.5), p95: at(0.95) };
}

function ms(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
function ratio(slow: number, fast: number): string {
  if (fast === 0) return '∞';
  const r = slow / fast;
  return r >= 1 ? `${r.toFixed(1)}× faster` : `${(1 / r).toFixed(1)}× SLOWER`;
}

// ── cases ────────────────────────────────────────────────────────────────────

const FILTERS: FilterStep[] = [{ type: 'filter', column: 'region', op: '!=', value: 'region-3' }];

interface Case {
  id: string;
  what: string;
  js: (cols: ParsedColumn[], rows: Cell[][]) => unknown;
  resident: (src: rq.ResidentSource) => unknown;
  sig: (v: unknown) => string;
}

const CASES: Case[] = [
  {
    id: 'metric_sum',
    what: 'metric — sum(sales)',
    js: (c, r) => metricValue.computeMetric(c, r, { column: 'sales', aggregation: 'sum' }),
    resident: (s) => computeMetricResidentSync(s, { column: 'sales', aggregation: 'sum' }),
    sig: (v) => (typeof v === 'number' ? v.toFixed(4) : String(v)),
  },
  {
    id: 'metric_count',
    what: 'metric — count(code)',
    js: (c, r) => metricValue.computeMetric(c, r, { column: 'code', aggregation: 'count' }),
    resident: (s) => computeMetricResidentSync(s, { column: 'code', aggregation: 'count' }),
    sig: (v) => String(v),
  },
  {
    id: 'agg_low_card',
    what: 'aggregate — 7 groups × sum',
    js: (c, r) =>
      vizData.buildVizData(c, r, { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] }).data,
    resident: (s) => aggregateResidentSync(s, 'region', [{ column: 'sales', aggregation: 'sum' }]),
    sig: chartSig,
  },
  {
    id: 'agg_high_card',
    what: 'aggregate — 1,000 groups × sum',
    js: (c, r) =>
      vizData.buildVizData(c, r, { category: 'sku', values: [{ column: 'sales', aggregation: 'sum' }] }).data,
    // 'sku' has 1,000 distinct values, past CATEGORY_CAP, so `buildVizData`
    // caps it at the top 50 plus 'Other'. The resident side has to be given the
    // SAME key or the two answers are not comparable and the timing below them
    // means nothing — the pairing `ipc/visuals.residentVizData` actually ships.
    resident: (s) => {
      const m = [{ column: 'sales', aggregation: 'sum' as const }];
      return aggregateResidentSync(s, 'sku', m, undefined, resolveCatKeySync(s, 'sku', m)?.key);
    },
    sig: chartSig,
  },
  {
    id: 'agg_filtered',
    what: 'aggregate — filtered, 3 measures',
    js: (c, r) =>
      vizData.buildVizData(
        c,
        r,
        {
          category: 'region',
          values: [
            { column: 'sales', aggregation: 'sum' },
            { column: 'sales', aggregation: 'avg' },
            { column: 'code', aggregation: 'count' },
          ],
        },
        FILTERS,
      ).data,
    resident: (s) =>
      aggregateResidentSync(
        s,
        'region',
        [
          { column: 'sales', aggregation: 'sum' },
          { column: 'sales', aggregation: 'avg' },
          { column: 'code', aggregation: 'count' },
        ],
        FILTERS,
      ),
    sig: chartSig,
  },
];

// Rounded so the documented last-ULP float-summation divergence between a JS
// left-fold and DuckDB's parallel sum does not read as "different answers".
function chartSig(v: unknown): string {
  const d = v as { labels?: unknown[]; series?: { name: string; values: (number | null)[] }[] } | null;
  if (!d || !d.labels || !d.series) return 'null';
  const nums = d.series
    .map((s) => s.name + ':' + s.values.map((x) => (x === null ? '-' : x.toFixed(3))).join(','))
    .join('|');
  return `${d.labels.length}g/${d.labels.slice(0, 3).join(',')}/${nums.slice(0, 400)}`;
}

// ── run ──────────────────────────────────────────────────────────────────────

const lines: string[] = [];
function say(s: string): void {
  console.log(s);
  lines.push(s);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-bench-resident-'));

if (!rq.isResident()) {
  console.error('DuckDB bridge unavailable — nothing to benchmark.');
  process.exit(1);
}
// Warm the worker + the query planner so neither shows up as a first-iteration
// outlier in the numbers below.
duck.query('SELECT 1;');

say('# Phase 3 — resident Parquet query vs hydrate-then-fold');
say('');
say(`Node ${process.version} · ${os.cpus()[0]?.model ?? 'unknown cpu'} · ${os.cpus().length} cores · ${new Date().toISOString()}`);
say('');
say('`(a) hydrate+compute` = `parquetStore.readTable` + the existing JS function (today\'s path).');
say('`(a2) compute only` = the same JS function with the table already in memory (perfect-cache best case).');
say('`(b) resident` = `residentQuery.*` — one query straight against `read_parquet(...)`.');
say('');

for (const n of SIZES) {
  const file = path.join(dir, `bench-${n}.parquet`);
  const t0 = Date.now();
  pq.writeTable(file, COLUMNS, buildRows(n));
  const writeMs = Date.now() - t0;
  const bytes = fs.statSync(file).size;

  const hydrated = pq.readTable(file, COLUMNS);
  if (!hydrated) throw new Error('bench: read-back failed');
  const src: rq.ResidentSource = { parquetPath: file, columns: COLUMNS };
  const reps = repsFor(n);

  const hydrateStat = time(Math.min(reps, 5), () => pq.readTable(file, COLUMNS));

  say(`## ${n.toLocaleString()} rows × ${COLUMNS.length} columns`);
  say('');
  say(
    `Parquet on disk: ${(bytes / 1024).toFixed(0)} KB · written in ${writeMs} ms · ` +
      `\`readTable\` alone: **${ms(hydrateStat.median)} ms** (median of ${Math.min(reps, 5)}) · ${reps} reps per case`,
  );
  say('');
  say('| case | (a) hydrate+compute | (a2) compute only | (b) resident | b vs a | b vs a2 | same answer |');
  say('|---|---:|---:|---:|---|---|:--:|');

  for (const c of CASES) {
    const wantSig = c.sig(c.js(hydrated.columns, hydrated.rows));
    const gotSig = c.sig(c.resident(src));
    const agree = wantSig === gotSig;

    const a = time(reps, () => {
      const t = pq.readTable(file, COLUMNS);
      return t ? c.js(t.columns, t.rows) : null;
    });
    const a2 = time(reps, () => c.js(hydrated.columns, hydrated.rows));
    const b = time(reps, () => c.resident(src));

    say(
      `| ${c.what} | ${ms(a.median)} ms <br><sub>${ms(a.min)} / ${ms(a.p95)}</sub> ` +
        `| ${ms(a2.median)} ms <br><sub>${ms(a2.min)} / ${ms(a2.p95)}</sub> ` +
        `| ${ms(b.median)} ms <br><sub>${ms(b.min)} / ${ms(b.p95)}</sub> ` +
        `| **${ratio(a.median, b.median)}** | ${ratio(a2.median, b.median)} | ${agree ? '✅' : '❌'} |`,
    );
    if (!agree) {
      say('');
      say(`> ⚠ **${c.id} DISAGREES** — the timings below it are meaningless.`);
      say(`> js:       \`${wantSig.slice(0, 200)}\``);
      say(`> resident: \`${gotSig.slice(0, 200)}\``);
      say('');
    }
  }
  say('');
  say('<sub>cells are median, with min / p95 underneath</sub>');
  say('');

  fs.rmSync(file, { force: true });
}

say('---');
say('');
say('Notes: the bridge is warmed before timing; the file is warm in the page cache for both paths;');
say('`(a)` allocates a fresh `Cell[][]` every iteration, which is the cost the app actually pays today.');

fs.rmSync(dir, { recursive: true, force: true });
duck.shutdown();

if (OUT) {
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
  console.error(`\nwrote ${OUT}`);
}
