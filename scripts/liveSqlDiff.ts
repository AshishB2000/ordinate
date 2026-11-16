// The DIFFERENTIAL of SQL on Live datasets (docs/live-data/01-live-sql.md, "Proof", F2). Helper for
// scripts/test-liveSqlParity.ts (DuckDB, every npm test) and scripts/test-liveSqlParityPostgres.ts;
// not a suite itself.
//
//   reference  DuckDB runs the model's OWN text over the extract — the phase B lane, `runSql`
//              (`compile()`, its gate, our Parquet) — with each table a view projecting exactly as
//              the Live view does: numbers DOUBLE, dates DATE, text with '' as NULL; the lock a
//              byte-equal WHERE.
//   live       parse → translate (src/engine/live/sql/tree.ts) → print for the engine's dialect
//              (print.ts, view.ts) → run on the engine over the fixture as a warehouse types it.
//
// Every cell is compared with `Object.is`, float sums and means within 1e-13 only, in order. The
// normalisations, each a named pin in ./liveSqlPins.ts with a check that it still exists:
//   P1  DuckDB's date_trunc over a DATE is a TIMESTAMP ('2024-01-01 00:00:00'); Live prints the day.
//   P2  the DuckDB bridge drops one leading U+FEFF from every string the REFERENCE returns; Live's
//       DuckDB dialect doubles it (`label`) and a warehouse keeps it, so one is dropped from Live's.
//   R4  −0 is 0 (an extract stores String(−0) = '0'; Postgres returns −0), on both sides.
// Every comparison returns PROBLEMS (empty = agree), so a negative control runs the very same check.

import type { CompiledQuery, LiveSource } from '../src/engine/live/compile';
import type { CompileDialectId } from '../src/engine/live/dialect';
import type { LiveRows } from '../src/engine/live/shape';
import type { FilterStep } from '../src/data/transforms';
import type { ViewInput } from '../src/engine/live/sql/view';
import type { SqlEnv } from '../src/engine/live/sql/tree';
import type { LiveSqlIR } from '../src/engine/live/sql/ir';
import type { ParityEngine } from './liveParityFixture';
import type { Cell, SqlCase } from './liveSqlCorpus';

const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const sqlDatasets: typeof import('../src/engine/sqlDatasets') = require('../src/engine/sqlDatasets');
const tree: typeof import('../src/engine/live/sql/tree') = require('../src/engine/live/sql/tree');
const print: typeof import('../src/engine/live/sql/print') = require('../src/engine/live/sql/print');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const { quoteIdent }: typeof import('../src/engine/datasetView') = require('../src/engine/datasetView');

type Ok = (label: string, cond: boolean, extra?: unknown) => void;

/** The viewer's lock in the locked run: `orders` held to region East (byte-equal: not 'east'). */
export const LOCK: FilterStep[] = [{ type: 'filter', column: 'region', op: 'in', values: ['East'], lock: true } as FilterStep];
const LOCKED_VALUE = 'East';

const TABLES = [
  { slug: 'orders', raw: 'orders_raw', columns: fx.COLUMNS },
  { slug: 'targets', raw: 'targets_raw', columns: corpus.TARGET_COLUMNS },
];

export interface Table {
  rows: Cell[][];
  columns: string[];
  sqlTypes: string[];
  truncated: boolean;
}

export interface Kit {
  pid: string;
  env: SqlEnv;
  today: string;
  /** Rows as each table holds them in the warehouse. */
  rows: { orders: Cell[][]; targets: Cell[][] };
}

/** The two tables saved as extracts, typed as an import types them, and the translator's vocabulary. */
export async function setupKit(ok: Ok): Promise<Kit | null> {
  await projects.init();
  const project = await projects.createProject('Live SQL parity');
  const rows = { orders: fx.fixtureRows(), targets: corpus.TARGET_ROWS };
  for (const t of TABLES) {
    const imported = fx.importTyped(t.columns, rows[t.slug as 'orders' | 'targets']);
    const ds = await datasets.saveDataset(project.id, { name: t.raw, sourceKind: 'csv', columns: imported.columns, rows: imported.rows });
    if (!ds) { ok(`saved the ${t.raw} extract`, false); return null; }
  }
  // "Today" as the reference engine sees it (P6): the translator binds the same day.
  const today = String((await duck.queryAsync('SELECT CAST(current_date AS VARCHAR) AS d'))[0].d);
  const env: SqlEnv = { tables: new Map(TABLES.map((t) => [t.slug, { id: t.slug, columns: t.columns }])), today };
  return { pid: project.id, env, today, rows };
}

/** The reference's view of one table: the Live view's projection, over the extract, the lock as a byte-equal WHERE (`true`: East). */
function referenceView(t: (typeof TABLES)[number], lock: boolean | string): { name: string; sql: string } {
  const cols = t.columns.map((c) => {
    const q = quoteIdent(c.name);
    if (c.type === 'date') return `TRY_CAST(${q} AS DATE) AS ${q}`;
    if (c.type === 'text') return `CASE WHEN ${q} = '' THEN NULL ELSE ${q} END AS ${q}`;
    return q;
  });
  const value = lock === true ? LOCKED_VALUE : lock;
  const where = value && t.slug === 'orders' ? ` WHERE "region" IN ('${value.replace(/'/g, "''")}')` : '';
  return { name: t.slug, sql: `SELECT ${cols.join(', ')} FROM ${t.raw}${where}` };
}

const isoMidnight = /^(\d{4}-\d{2}-\d{2}) 00:00:00$/;
const zero = (v: unknown): unknown => (Object.is(v, -0) ? 0 : v);

/** DuckDB running the model's text over the extract, normalised (P1, R4); null with the error when it does not run. `lock`: `orders` held to East (true) or to that value. */
export async function reference(kit: Kit, sql: string, lock: boolean | string): Promise<Table | { error: string }> {
  const res = await sqlDatasets.runSql(kit.pid, sql, [], print.LIVE_SQL_ROWS, TABLES.map((t) => referenceView(t, lock)));
  if (!res.ok) return { error: res.error };
  const rows = res.rows.map((r) => r.map((v, i) => {
    const m = typeof v === 'string' && /^TIMESTAMP/.test(res.sqlTypes[i]) ? isoMidnight.exec(v) : null;
    return (m ? m[1] : zero(v)) as Cell;
  }));
  return { rows, columns: res.columns.map((c) => c.name), sqlTypes: res.sqlTypes, truncated: res.truncated };
}

/** Where each table lives in the engine (loaded once per engine). */
export type Sources = Record<'orders' | 'targets', LiveSource>;

export async function loadSources(kit: Kit, engine: ParityEngine): Promise<Sources> {
  return {
    orders: await engine.load('lsql_orders', fx.layout(fx.COLUMNS), kit.rows.orders),
    targets: await engine.load('lsql_targets', corpus.TARGET_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' as const : c.type === 'date' ? 'date' as const : 'text' as const })), kit.rows.targets),
  };
}

/** One view input per dataset the IR reads. */
export function inputsFor(ir: LiveSqlIR, sources: Sources, lock: readonly FilterStep[]): ViewInput[] {
  return ir.views.map((v) => {
    const t = TABLES.find((x) => x.slug === v.id)!;
    return { env: { source: sources[t.slug as 'orders' | 'targets'], columns: t.columns }, lock: t.slug === 'orders' ? lock : [] };
  });
}

/** The statement for a dialect, or the refusal's sentence. */
export async function printed(kit: Kit, sql: string, sources: Sources, lock: readonly FilterStep[], dialect: CompileDialectId): Promise<CompiledQuery | { error: string }> {
  const t = tree.translate(await tree.parseSql(sql), kit.env);
  if (!t.ok) return { error: `refused (${t.code}): ${t.message}` };
  const p = print.printLiveSql(t.ir, inputsFor(t.ir, sources, lock), dialect);
  return p.ok ? p.query : { error: `refused printing (${p.code}): ${p.message}` };
}

/** Live's answer: the printed statement run on the engine, normalised (P2, R4). */
export async function live(kit: Kit, sql: string, sources: Sources, lock: readonly FilterStep[], engine: ParityEngine): Promise<{ rows: LiveRows; raw: LiveRows; query: CompiledQuery } | { error: string }> {
  const q = await printed(kit, sql, sources, lock, engine.dialect);
  if ('error' in q) return q;
  let raw: LiveRows;
  try {
    raw = await engine.run(q, 'sql' as never);
  } catch (e) {
    return { error: `the engine failed: ${(e as Error).message}\n${q.sql}` };
  }
  const rows = raw.map((r) => r.map((v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? zero(v) : null;
    return typeof v === 'string' && v.startsWith('﻿') ? v.slice(1) : v;
  }));
  return { rows: rows as LiveRows, raw, query: q };
}

const close = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-13 * Math.max(1, Math.abs(a), Math.abs(b));

/** Where the two answers differ: empty when they agree cell for cell. */
export async function problems(kit: Kit, c: SqlCase, sources: Sources, engine: ParityEngine, opts: { lock: boolean; liveLock?: readonly FilterStep[] }): Promise<string[]> {
  const ref = await reference(kit, c.sql, opts.lock);
  const got = await live(kit, c.sql, sources, opts.liveLock ?? (opts.lock ? LOCK : []), engine);
  // Both refusing at DuckDB's parser (a NUL ends a literal there) is agreement: nothing ran on either side.
  if ('error' in ref) return 'error' in got && /^Parser Error/.test(ref.error) && /^refused \(parse\)/.test(got.error) ? [] : [`the reference failed: ${ref.error}`];
  if ('error' in got) return [got.error];
  const out: string[] = [];
  const refRows = ref.rows;
  const limit = print.LIVE_SQL_ROWS;
  if (ref.truncated !== got.rows.length > limit) out.push(`truncated: reference ${ref.truncated}, live ${got.rows.length} rows`);
  const liveRows = got.rows.slice(0, limit);
  if (refRows.length !== liveRows.length) out.push(`row count: reference ${refRows.length}, live ${liveRows.length}`);
  for (let r = 0; r < Math.min(refRows.length, liveRows.length) && out.length < 6; r += 1) {
    if (refRows[r].length !== liveRows[r].length) { out.push(`row ${r}: width ${refRows[r].length} vs ${liveRows[r].length}`); continue; }
    refRows[r].forEach((v, i) => {
      const w = liveRows[r][i];
      if (!Object.is(v, w) && !(c.approx?.includes(i) && close(v, w))) out.push(`row ${r} col ${i}: reference ${JSON.stringify(v)}, live ${JSON.stringify(w)}`);
    });
  }
  return out;
}

/** The corpus (or `cases` of it) on one engine, locked or not: one check per case. Returns how many agreed. */
export async function runCorpus(kit: Kit, sources: Sources, engine: ParityEngine, ok: Ok, lock: boolean, cases: readonly SqlCase[] = corpus.CASES): Promise<number> {
  let agree = 0;
  for (const c of cases) {
    const p = await problems(kit, c, sources, engine, { lock });
    if (p.length === 0) agree += 1;
    ok(`${engine.name}${lock ? ', locked to East' : ''}: ${c.name}`, p.length === 0, `${p.join(' | ')}\n  ${c.sql}`);
  }
  return agree;
}

/** The hostile literals as statements: each runs, binds its value, and agrees with the reference. */
export function literalCases(): SqlCase[] {
  return corpus.LITERALS.map((v, i) => {
    const lit = `'${v.replace(/'/g, "''")}'`;
    return {
      name: `hostile literal #${i} ${JSON.stringify(v)}`,
      sql: `SELECT coalesce(note, ${lit}) AS n, CASE WHEN note = ${lit} THEN ${lit} ELSE 'no' END AS hit, count(*) AS c FROM targets WHERE note <> ${lit} OR note IN (${lit}, 'x') OR note LIKE ${lit} OR note IS NULL GROUP BY coalesce(note, ${lit}), CASE WHEN note = ${lit} THEN ${lit} ELSE 'no' END ORDER BY n, hit`,
    };
  });
}
