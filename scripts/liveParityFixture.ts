// The live-parity FIXTURE: one table holding every edge case the live compiler
// must agree with the extract on, loaded twice — as an extract (a real dataset
// in a scratch project, Parquet and all) and as a warehouse would hold it (TYPED
// DuckDB tables). Helper for scripts/test-liveParity.ts; not a suite itself.
//
// Edge cases, by column:
//   many    60 categories ('m00'…'m59') — past the 50 cap, so "Other" folds.
//           Rows come in label-sorted blocks, so first-seen order IS label order
//           under any filter: ties at the 50th place break the same way on both
//           paths, and the matrix compares "Other" exactly. (The tie divergence
//           itself is pinned separately, on a fixture built to show it.)
//   cat     '' / '  ' / tab / NBSP / null, '007' beside '7', composed and
//           decomposed é, CJK, an astral emoji, a leading BOM, a quote, % and _.
//   amt     −0, fractions that do not sum exactly (0.1, 0.2, 0.7), negatives. No huge
//           outlier: a 1e15 among ~1,000 small cells makes every later addition
//           round at its scale, a BIASED error of ~n·ε that tests the summation
//           order of the engine, not the compiler (measured 8.9e-14 — at the edge).
//           (DuckDB stores −0 as 0, so the bench cannot hold one; the shaping's
//           −0 rule is pinned in test-liveCompile against a hand-made reply.)
//   d       ISO-week (Sun 2024-12-29 / Mon 2024-12-30, ISO 2025-W01), quarter and
//           year boundaries, a leap day, nulls.
//   bigid   ids past 15 digits: text in the extract, HUGEINT in the warehouse.
//   tier    a number split (with null).

import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { CompileEnv, CompiledQuery, LiveSource } from '../src/engine/live/compile';
import type { SqlDialect } from '../src/engine/live/dialect';
import type { LiveRows } from '../src/engine/live/shape';

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');

export type Cell = string | number | null;

export const COLUMNS: LiveColumn[] = [
  { name: 'many', type: 'text' },
  { name: 'cat', type: 'text' },
  { name: 'region', type: 'text' },
  { name: 'amt', type: 'number' },
  { name: 'qty', type: 'number' },
  { name: 'tier', type: 'number' },
  { name: 'd', type: 'date' },
  { name: 'bigid', type: 'text' },
];

/** How the warehouse holds each column (the DuckDB DDL type). */
const TYPED: Record<string, string> = {
  many: 'VARCHAR', cat: 'VARCHAR', region: 'VARCHAR', amt: 'DOUBLE', qty: 'DOUBLE', tier: 'DOUBLE', d: 'DATE', bigid: 'HUGEINT',
};

export const CATS: Cell[] = [
  'Alpha', 'beta', 'Beta', '', '  ', '\t', '\u00a0', null, '007', '7', '\u00e9', 'e\u0301', '東京', '😀',
  '\ufeffBOM', "O'Brien", 'a%b', 'a_b',
];
export const REGIONS: Cell[] = ['North', 'South', 'East', 'West', null];
const AMTS: Cell[] = [-0, 0.1, 0.2, 0.7, 1, 2.5, 12, 7, -3.5, 100, 12345.678, null, 33.3, 0.3];
const DATES: Cell[] = [
  '2023-01-01', '2023-12-31', '2024-01-01', '2024-02-29', '2024-03-31', '2024-04-01', '2024-06-30', '2024-07-01',
  '2024-09-30', '2024-10-01', '2024-12-29', '2024-12-30', '2024-12-31', '2025-01-01', '2025-01-05', '2025-01-06',
  '2025-03-01', null,
];
export const BIG = ['12345678901234567890', '98765432109876543210', '100000000000000001'];

/** A seeded PRNG (mulberry32) — the fixture is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDay(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

/** The source rows, as the warehouse holds them (−0 included). */
export function fixtureRows(): Cell[][] {
  const rnd = prng(20261009);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const rows: Cell[][] = [];
  const start = Date.UTC(2023, 0, 1) / 86400000;
  for (let b = 0; b < 60; b += 1) {
    // 12–24 rows a block: past 1,000 rows in all, so KPI tiles take the resident
    // path (dashboards.RESIDENT_MIN_ROWS) the way a real dataset's do.
    const n = 12 + (b % 13);
    for (let j = 0; j < n; j += 1) {
      const d = rnd() < 0.55 ? pick(DATES) : isoDay(start + Math.floor(rnd() * 790));
      const amt = rnd() < 0.7 ? pick(AMTS) : Math.round(rnd() * 2000) / 10;
      rows.push([
        `m${String(b).padStart(2, '0')}`,
        pick(CATS),
        pick(REGIONS),
        amt,
        rnd() < 0.1 ? null : Math.floor(rnd() * 21),
        rnd() < 0.15 ? null : 1 + Math.floor(rnd() * 3),
        d,
        rnd() < 0.2 ? null : pick(BIG),
      ]);
    }
  }
  return rows;
}

// ── The warehouse side ───────────────────────────────────────────────────────

function sqlType(name: string, textNumbers: boolean): string {
  if (textNumbers && (name === 'amt' || name === 'qty')) return 'VARCHAR';
  return TYPED[name];
}

/**
 * Load `rows` into a DuckDB table typed the way a warehouse types it. With
 * `textNumbers`, `amt` and `qty` are VARCHAR (the declared-type cast's case):
 * a number is its JS text ('-0' for −0), an empty one rotates NULL / '' / '  '.
 */
export async function loadWarehouse(table: string, columns: LiveColumn[], rows: Cell[][], textNumbers = false): Promise<void> {
  const ddl = columns.map((c) => `"${c.name}" ${sqlType(c.name, textNumbers)}`).join(', ');
  await duck.execAsync(`CREATE OR REPLACE TABLE "${table}" (${ddl})`);
  let blank = 0;
  for (let at = 0; at < rows.length; at += 40) {
    const chunk = rows.slice(at, at + 40);
    const params: (string | number | null)[] = [];
    const tuples = chunk.map((r) => `(${columns.map((c, i) => {
      let v = r[i];
      const type = sqlType(c.name, textNumbers);
      if (type === 'VARCHAR' && textNumbers && (c.name === 'amt' || c.name === 'qty')) {
        v = v === null ? [null, '', '  '][blank++ % 3] : Object.is(v, -0) ? '-0' : String(v);
      }
      params.push(v);
      return `CAST($${params.length} AS ${type})`;
    }).join(', ')})`);
    await duck.queryAsync(`INSERT INTO "${table}" VALUES ${tuples.join(', ')}`, params);
  }
}

/** A runner over the DuckDB bridge: rows come back by alias and leave positional. */
export async function runDuck(q: CompiledQuery): Promise<LiveRows> {
  const rows = await duck.queryAsync(q.sql, q.params.map((p) => (typeof p.value === 'boolean' ? String(p.value) : p.value)));
  return rows.map((r) => q.columns.map((c) => r[c] ?? null));
}

export function env(source: LiveSource, columns: LiveColumn[] = COLUMNS, dialect: SqlDialect | 'duckdb' = 'duckdb'): CompileEnv {
  return { dialect, source, columns };
}
