// The live-parity FIXTURE: one table holding every edge case the live compiler
// must agree with the extract on, loaded twice — as an extract (a real dataset
// in a scratch project, Parquet and all) and as a warehouse would hold it (TYPED
// tables: DuckDB here, a real engine through ./liveParityEngines.ts). Helper for
// scripts/test-liveParity*.ts and the real-account nightly; not a suite itself.
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
//           −0 rule is pinned in test-liveCompile against a hand-made reply,
//           and Postgres and ClickHouse return real ones — L2.8's pin R4.)
//   d       ISO-week (Sun 2024-12-29 / Mon 2024-12-30, ISO 2025-W01), quarter and
//           year boundaries, a leap day, nulls.
//   bigid   ids past 15 digits: text in the extract, HUGEINT in the warehouse.
//   tier    a number split (with null).

import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { CompileEnv, CompiledQuery, LiveSource } from '../src/engine/live/compile';
import type { CompileDialectId, SqlDialect } from '../src/engine/live/dialect';
import type { LiveStep } from '../src/engine/live/evaluate';
import type { LiveRows } from '../src/engine/live/shape';

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');

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

/**
 * How a warehouse holds a column — a storage KIND, which every engine spells in
 * its own DDL (`ParityEngine.typeName`): a float, an integer, a 38-digit
 * decimal, a DATE, a TIMESTAMP with or without a zone, text.
 */
export type Store = 'text' | 'float' | 'int' | 'smallint' | 'decimal' | 'date' | 'timestamp' | 'timestamptz';

/** The fixture as a warehouse types it: a quantity is an integer, a long id a DECIMAL(38,0). */
const STORES: Record<string, Store> = {
  many: 'text', cat: 'text', region: 'text', amt: 'float', qty: 'int', tier: 'smallint', d: 'date', bigid: 'decimal',
};

/** The VARCHAR-number variant stores these two as text (the declared-type cast's case). */
const TEXT_NUMBERS = new Set(['amt', 'qty']);

export interface StoredColumn {
  name: string;
  store: Store;
}

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

// ── The extract side ─────────────────────────────────────────────────────────

/**
 * `rows` typed EXACTLY as an import types them: every cell stringified as
 * `connectionRun` does (null → '', −0 → '0'), then `parse.finalizeTable` — the
 * core of every CSV, JSON and connection import — which detects the types and
 * stores '' as null (a whitespace-only cell stays text). So '' and NULL, apart
 * in the warehouse, are ONE null in the extract, as in every real copy (found
 * by L3.2: the L2.2 bench saved its rows raw and kept them apart). Detected
 * types must be the declared ones, or the two sides would answer different
 * questions — a mismatch throws.
 */
export function importTyped(columns: { name: string; type: string }[], rows: Cell[][]): { columns: { name: string; type: import('../src/data/parse').ColumnType }[]; rows: Cell[][] } {
  const r = parse.finalizeTable(columns.map((c) => c.name), rows.map((row) => row.map((v) => (v == null ? '' : String(v)))));
  const off = r.columns.filter((c, i) => c.type !== columns[i].type);
  if (off.length) throw new Error(`an import types ${off.map((c) => `${c.name} as ${c.type}`).join(', ')}, not as declared`);
  return { columns: r.columns.map((c) => ({ name: c.name, type: c.type })), rows: r.rows };
}

// ── The warehouse side ───────────────────────────────────────────────────────

/** The fixture's columns as a warehouse holds them; with `textNumbers`, `amt` and `qty` are text. */
export function layout(columns: LiveColumn[], textNumbers = false): StoredColumn[] {
  return columns.map((c) => ({ name: c.name, store: textNumbers && TEXT_NUMBERS.has(c.name) ? 'text' : STORES[c.name] ?? 'text' }));
}

/**
 * The rows as the warehouse holds them. With `textNumbers`, `amt` and `qty` are
 * the number's JS text ('-0' for −0) and an empty one rotates NULL / '' / '  '.
 */
export function warehouseCells(columns: LiveColumn[], rows: Cell[][], textNumbers = false): Cell[][] {
  if (!textNumbers) return rows;
  let blank = 0;
  return rows.map((r) => r.map((v, i) => {
    if (!TEXT_NUMBERS.has(columns[i].name)) return v;
    return v === null ? [null, '', '  '][blank++ % 3] : Object.is(v, -0) ? '-0' : String(v);
  }));
}

/**
 * Where the live side of the parity matrix runs: a compile dialect, a way to
 * load a table typed the warehouse's way, and a runner. The DuckDB bench below
 * is one; scripts/liveParityEngines.ts and scripts/warehouseLiveParity.ts hold
 * the real engines, each running through its connector's own `runBound`.
 */
export interface ParityEngine {
  /** Names the run in every check label. */
  name: string;
  dialect: CompileDialectId;
  /** One compiled statement → rows positional to `q.columns`. Throws on a warehouse error. */
  run(q: CompiledQuery, step: LiveStep): Promise<LiveRows>;
  /**
   * `rows` typed per `columns`, as a live source: a table created (or replaced)
   * for them, or — on a warehouse the run may not write — a defining query
   * that SELECTs them from literals.
   */
  load(table: string, columns: StoredColumn[], rows: Cell[][]): Promise<LiveSource>;
  /** The engine's own name for a store — what a schema sync records as `sourceType`. */
  typeName(store: Store): string;
}

/**
 * The DuckDB bench's DDL. Every number is DOUBLE and the long id HUGEINT — the
 * types L2.2 measured the matrix with; the real engines use integers and decimals.
 */
const DUCK_TYPE: Record<Store, string> = {
  text: 'VARCHAR', float: 'DOUBLE', int: 'DOUBLE', smallint: 'DOUBLE', decimal: 'HUGEINT', date: 'DATE', timestamp: 'TIMESTAMP', timestamptz: 'TIMESTAMPTZ',
};

async function loadDuck(table: string, columns: StoredColumn[], rows: Cell[][]): Promise<LiveSource> {
  const types = columns.map((c) => DUCK_TYPE[c.store]);
  await duck.execAsync(`CREATE OR REPLACE TABLE "${table}" (${columns.map((c, i) => `"${c.name}" ${types[i]}`).join(', ')})`);
  for (let at = 0; at < rows.length; at += 40) {
    const params: Cell[] = [];
    const tuples = rows.slice(at, at + 40).map((r) => `(${r.map((v, i) => {
      params.push(v);
      return `CAST($${params.length} AS ${types[i]})`;
    }).join(', ')})`);
    await duck.queryAsync(`INSERT INTO "${table}" VALUES ${tuples.join(', ')}`, params);
  }
  return { kind: 'table', parts: [table] };
}

/**
 * Load `rows` into a DuckDB table typed the way a warehouse types it. With
 * `textNumbers`, `amt` and `qty` are VARCHAR (see `warehouseCells`).
 */
export async function loadWarehouse(table: string, columns: LiveColumn[], rows: Cell[][], textNumbers = false): Promise<void> {
  await loadDuck(table, layout(columns, textNumbers), warehouseCells(columns, rows, textNumbers));
}

/** A runner over the DuckDB bridge: rows come back by alias and leave positional. */
export async function runDuck(q: CompiledQuery): Promise<LiveRows> {
  const rows = await duck.queryAsync(q.sql, q.params.map((p) => (typeof p.value === 'boolean' ? String(p.value) : p.value)));
  return rows.map((r) => q.columns.map((c) => r[c] ?? null));
}

/** The DuckDB bench as a parity engine — what every `npm test` runs the whole matrix on. */
export const duckEngine: ParityEngine = {
  name: 'duckdb',
  dialect: 'duckdb',
  run: (q) => runDuck(q),
  load: loadDuck,
  typeName: (store) => DUCK_TYPE[store],
};

export function env(source: LiveSource, columns: LiveColumn[] = COLUMNS, dialect: SqlDialect | CompileDialectId = 'duckdb'): CompileEnv {
  return { dialect, source, columns };
}
