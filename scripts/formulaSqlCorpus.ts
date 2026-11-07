// The formula-SQL differential's FIXTURE and HARNESS (semantic layer part 8, step 03): about 40 rows
// holding every edge the SQL builder must agree with evaluate() on, a seeded generator of well-typed
// v1 expressions, and `calcDiff`, which runs them on a ParityEngine and compares each row, under
// Object.is, with what a copy stores. Helper for scripts/test-formulaSqlDiff.ts; step 05 runs the
// same `calcDiff` on the real engines. Not a suite itself.

import type { Cell, ParityEngine, StoredColumn } from './liveParityFixture';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { LiveSource } from '../src/engine/live/compile';
import type { SqlDialect } from '../src/engine/live/dialect';
import type { SqlTerm } from '../src/engine/live/formulaSql';
import type { FValue } from '../src/formula/formula';
import { compile } from '../src/formula/formula';
import { compileCalcSql, SqlFormulaBuilder } from '../src/engine/live/formulaSql';
import { DIALECT_IDS, dialectFor } from '../src/engine/live/dialects';
import { ParamSink, boundCount } from '../src/engine/live/sqlParams';
import { MAX_LIVE_PARAMS } from '../src/connectors/liveParams';
import { SRC } from '../src/engine/live/compileFilter';

const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');

export const CALC_COLUMNS: LiveColumn[] = [
  { name: 'rid', type: 'number' }, { name: 'n', type: 'number' }, { name: 'm', type: 'number' },
  { name: 't', type: 'text' }, { name: 'u', type: 'text' },
  { name: 'd', type: 'date' }, { name: 'e', type: 'date' }, { name: 'ts', type: 'date' },
];
const STORED: StoredColumn[] = CALC_COLUMNS.map((c) => ({ name: c.name, store: c.type === 'number' ? 'float' : c.name === 'ts' ? 'timestamp' : c.type === 'date' ? 'date' : 'text' }));

// Magnitudes stay below 1e6, so nothing a depth-4 formula builds overflows. 2^53 is TEXT (u): a number
// column past 15 digits would import as text (preflight F5).
const NUMS: Cell[] = [null, 0, -0, 0.5, 1.5, 2.5, -0.5, -2.5, 1e-7, 123456.789, 1, -1, 3, 7, 10, 100, -7.25, 0.1, 0.2, 999999];
const TEXTS: Cell[] = [null, '', '  ', '\t', 'ß', 'İ', 'ΑΣ', '%_\\', '007', 'a', 'ab', 'Alpha', 'beta', 'x y', '9007199254740992', 'a%b', '!x', "a'b", ' a'];
const DATES: Cell[] = ['2024-02-29', '2023-12-31', '2024-01-01', '1970-01-01', null, '2024-07-15', '2025-03-31', '1999-12-31', '2024-12-30'];
// A copy holds a TIMESTAMP as its UTC ISO text (liveParityPins 7).
const TSS: Cell[] = ['2024-01-01T23:59:59.000Z', null, '2023-12-31T00:00:00.000Z', '2024-02-29T12:30:00.000Z', '1970-01-01T00:00:00.000Z', '2025-03-31T23:00:00.000Z'];

/** The rows as the warehouse holds them, in `rid` order. Row 0 is every column null. */
export const CALC_ROWS: Cell[][] = Array.from({ length: 40 }, (_v, i) => i === 0
  ? [0, null, null, null, null, null, null, null]
  : [i, NUMS[i % NUMS.length], NUMS[(i * 7 + 3) % NUMS.length], TEXTS[i % TEXTS.length], TEXTS[(i * 5 + 2) % TEXTS.length],
    DATES[i % DATES.length], DATES[(i * 4 + 1) % DATES.length], TSS[i % TSS.length]]);

/** What one copy cell stores before its column is retyped: '' and null are null, a boolean its text, −0 is 0. */
export function copyCell(v: FValue): Cell {
  if (v === null || v === '') return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return Object.is(v, -0) ? 0 : v;
}

export function show(v: unknown): string {
  return Object.is(v, -0) ? '-0' : JSON.stringify(v);
}

// ── The generator ────────────────────────────────────────────────────────────

type Ty = 'number' | 'text' | 'boolean' | 'date';

/** mulberry32 — the corpus is the same on every run. */
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

/** A formula string literal: backslash escapes the next character. */
export function quoteFormula(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

const NUM_LITS = ['0', '1', '2', '3', '0.5', '1.5', '2.5', '10', '100', '0.1', '1e-7', '123456.789', '-1', '-2.5', '-0.5', '-0'];
const TEXT_LITS = ['a', '', ' ', 'ß', 'İ', 'ΑΣ', '%', '_', '%_\\', "a'b", '007', 'Alpha', '!x', '\t', 'ab'].map(quoteFormula);
const NEEDLES = ['', 'a', '%', '_', '\\', '!', 'ß', ' ', 'Al', 'b', '0', "'"].map(quoteFormula);
const PARTS = ["'day'", "'month'", "'quarter'", "'year'", "'Month'", "' DAY '", "'Year'"];

class Gen {
  private readonly rnd: () => number;
  constructor(seed: number) {
    this.rnd = prng(seed);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rnd() * xs.length)];
  }

  private some(make: () => string, lo: number, hi: number): string[] {
    return Array.from({ length: lo + Math.floor(this.rnd() * (hi - lo + 1)) }, make);
  }

  private leaf(ty: Ty, noTs: boolean): string {
    if (this.rnd() < 0.05) return 'null';
    switch (ty) {
      case 'number': return this.rnd() < 0.6 ? this.pick(['[n]', '[m]']) : this.pick(NUM_LITS);
      case 'text': return this.rnd() < 0.6 ? this.pick(['[t]', '[u]']) : this.pick(TEXT_LITS);
      case 'boolean': return this.pick(['true', 'false']);
      default: return this.pick(noTs ? ['[d]', '[e]'] : ['[d]', '[e]', '[ts]']);
    }
  }

  /** One expression of static type `ty`. `noTs`: no TIMESTAMP-held date, which Live never compares. */
  gen(ty: Ty, depth: number, noTs = false): string {
    if (depth <= 0 || this.rnd() < 0.3) return this.leaf(ty, noTs);
    const k = depth - 1;
    const N = (): string => this.gen('number', k);
    const T = (): string => this.gen('text', k);
    const Bo = (): string => this.gen('boolean', k);
    const D = (): string => this.gen('date', k, noTs);
    const X = (): string => this.gen(ty, k, noTs);
    const branchy: (() => string)[] = [
      () => `if(${Bo()}, ${X()}, ${X()})`,
      () => `iif(${Bo()}, ${this.some(X, 2, 3).join(', ')})`,
      () => {
        const test = (): string => { const b = Bo(); return b.startsWith('(') ? `false or ${b}` : b; }; // `IF (` would read as if()
        const elseIf = this.rnd() < 0.4 ? ` ELSEIF ${test()} THEN ${X()}` : '';
        return `(IF ${test()} THEN ${X()}${elseIf}${this.rnd() < 0.7 ? ` ELSE ${X()}` : ''} END)`;
      },
      () => {
        const sty = this.pick(['number', 'text'] as const);
        const lit = (): string => (this.rnd() < 0.1 ? 'null' : this.pick(sty === 'number' ? NUM_LITS : TEXT_LITS));
        const whens = this.some(() => ` WHEN ${lit()} THEN ${X()}`, 1, 3).join('');
        return `(CASE ${this.gen(sty, k)}${whens}${this.rnd() < 0.6 ? ` ELSE ${X()}` : ''} END)`;
      },
      () => `ifnull(${X()}, ${X()})`,
      () => `coalesce(${this.some(X, 1, 3).join(', ')})`,
    ];
    const own: Record<Ty, (() => string)[]> = {
      number: [
        () => `(${N()} ${this.pick(['+', '-', '*', '/'])} ${N()})`,
        () => `(-${N()})`,
        () => `${this.pick(['abs', 'sign', 'floor', 'ceil', 'ceiling', 'sqrt', 'square', 'zn'])}(${N()})`,
        () => (this.rnd() < 0.3 ? `round(${N()})` : `round(${N()}, ${this.pick(['-2', '-1', '0', '1', '2', '3'])})`),
        () => `${this.pick(['min', 'max'])}(${this.some(N, 1, 3).join(', ')})`,
        () => `${this.pick(['year', 'month', 'day', 'quarter'])}(${D()})`,
        () => `datediff(${this.pick(PARTS)}, ${D()}, ${D()})`,
      ],
      text: [
        () => `trim(${T()})`,
        () => `concat(${this.some(T, 1, 3).join(', ')})`,
      ],
      boolean: [
        () => `(${N()} ${this.pick(['=', '==', '!=', '<', '>', '<=', '>='])} ${N()})`,
        () => `(${T()} ${this.pick(['=', '==', '!=', '<', '>', '<=', '>='])} ${T()})`,
        () => `(${this.gen('date', k, true)} ${this.pick(['=', '!=', '<', '>', '<=', '>='])} ${this.gen('date', k, true)})`,
        () => `(${Bo()} ${this.pick(['=', '!='])} ${Bo()})`,
        () => `(${Bo()} ${this.pick(['and', 'or'])} ${Bo()})`,
        () => `(not ${Bo()})`,
        () => `(${N()} IN (${this.some(() => (this.rnd() < 0.15 ? 'null' : this.pick(NUM_LITS)), 0, 3).join(', ')}))`,
        () => `(${T()} IN (${this.some(() => (this.rnd() < 0.15 ? 'null' : this.pick(TEXT_LITS)), 1, 3).join(', ')}))`,
        () => `isnull(${this.gen(this.pick(['number', 'text', 'boolean', 'date'] as const), k)})`,
        () => `${this.pick(['contains', 'startswith', 'endswith'])}(${T()}, ${this.rnd() < 0.05 ? 'null' : this.pick(NEEDLES)})`,
      ],
      date: [],
    };
    // Dates are only ever arguments: a branch or a null fallback of dates, never a result.
    const choices = ty === 'date' ? branchy.filter((_f, i) => i !== 3) : [...own[ty], ...own[ty], ...branchy];
    return this.pick(choices)();
  }
}

/** True when some dialect refuses `expr` as too long: the CASE spellings repeat their operands, so a deep one can be. */
function tooLong(expr: string): boolean {
  return DIALECT_IDS.some((id) => {
    const r = compileCalcSql(expr, { d: dialectFor(id), b: new ParamSink(), columns: CALC_COLUMNS, earlier: [] });
    return !r.ok && r.code === 'tooLong';
  });
}

/** `n` well-typed v1 expressions of depth ≤ 4, number, text and true/false results alike, each short enough for every dialect. */
export function calcCorpus(seed: number, n: number): string[] {
  const g = new Gen(seed);
  const out: string[] = [];
  while (out.length < n) {
    const e = g.gen((['number', 'text', 'boolean'] as const)[out.length % 3], 4);
    if (!tooLong(e)) out.push(e);
  }
  return out;
}

// ── The harness ──────────────────────────────────────────────────────────────

function fromSql(d: SqlDialect, src: LiveSource): string {
  return src.kind === 'table' ? `${src.parts.map((p) => d.ident(p)).join('.')} AS ${SRC}` : `(\n${src.sql}\n) AS ${SRC}`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 300) : String(e);
}

/** One statement's budget: the connector's parameter gate, and under ClickHouse's default 256 KiB max_query_size. */
const BATCH = { exprs: 100, params: MAX_LIVE_PARAMS, chars: 200_000 };

/** `exprs` in order, cut into runs that each fit BATCH (an expression alone over it is a run of its own). */
function batches(exprs: string[], d: SqlDialect, columns: LiveColumn[], B: typeof SqlFormulaBuilder): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let params = 0;
  let chars = 0;
  for (const expr of exprs) {
    const r = compileCalcSql(expr, { d, b: new ParamSink(), columns, earlier: [] }, B);
    const [p, c] = r.ok ? [boundCount(r.sql), r.sql.length] : [0, 0];
    if (cur.length && (cur.length >= BATCH.exprs || params + p > BATCH.params || chars + c > BATCH.chars)) {
      out.push(cur);
      cur = [];
      params = 0;
      chars = 0;
    }
    cur.push(expr);
    params += p;
    chars += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Each expression's projected Live value on every row of `rows` (loaded as `table`), [expr][row];
 * a refusal or a warehouse error is a problem, and its values are absent. As many expressions to a
 * statement as fit its budget (BATCH: a billed account pays per statement); a statement the warehouse
 * refuses is retried one expression at a time, to name it.
 */
export async function liveValues(engine: ParityEngine, table: string, rows: Cell[][], exprs: string[], B: typeof SqlFormulaBuilder = SqlFormulaBuilder):
  Promise<{ values: Map<string, Cell[]>; problems: string[] }> {
  const source = await engine.load(table, STORED, rows);
  const columns = CALC_COLUMNS.map((c, i) => ({ ...c, sourceType: engine.typeName(STORED[i].store) }));
  const d = dialectFor(engine.dialect);
  const values = new Map<string, Cell[]>();
  const problems: string[] = [];
  const run = async (batch: string[]): Promise<void> => {
    const b = new ParamSink();
    const kept: string[] = [];
    const parts: string[] = [];
    for (const expr of batch) {
      const r = compileCalcSql(expr, { d, b, columns, earlier: [] }, B);
      if (!r.ok) { problems.push(`${expr}: refused (${r.code}) ${r.error}`); continue; }
      parts.push(`${r.sql} AS o_v${kept.length}`);
      kept.push(expr);
    }
    if (!kept.length) return;
    const sql = `SELECT ${SRC}.${d.ident('rid')} AS o_r, ${parts.join(', ')} FROM ${fromSql(d, source)} ORDER BY o_r`;
    let out: Cell[][];
    try {
      out = (await engine.run(b.finish(sql, d, ['o_r', ...kept.map((_e, k) => `o_v${k}`)]), 'chart')) as Cell[][];
    } catch (e) {
      if (kept.length > 1) { for (const expr of kept) await run([expr]); return; }
      problems.push(`${kept[0]}: the warehouse refused it: ${messageOf(e)}`);
      return;
    }
    if (out.length !== rows.length || out.some((r, i) => r[0] !== rows[i][0])) { problems.push(`${table}: rows came back out of rid order`); return; }
    kept.forEach((expr, k) => values.set(expr, out.map((r) => r[k + 1])));
  };
  for (const batch of batches(exprs, d, columns, B)) await run(batch);
  return { values, problems };
}

/** The rows as an import stores them ('' as null, −0 as 0), as the {column: value} maps evaluate() reads. */
export function copyRows(rows: Cell[][]): Record<string, FValue>[] {
  const typed = fx.importTyped(CALC_COLUMNS, rows); // throws when a column would not import as declared
  return typed.rows.map((r) => Object.fromEntries(typed.columns.map((col, i) => [col.name, r[i]])));
}

/** The copy's answer: evaluate() on each row, as one copy cell stores it. */
export function copyValues(maps: Record<string, FValue>[], expr: string): Cell[] | string {
  const c = compile(expr);
  if (!c.ok) return `does not compile on the copy: ${c.error}`;
  return maps.map((row) => copyCell(c.fn.evaluate(row)));
}

/** The corpus seed every engine runs (test-formulaSqlDiff on DuckDB, step 05's runners on the real ones). */
export const CALC_SEED = 20261104;

/** The negative control for round(): the engine's own ROUND, which splits ties away from zero or to even, never JS's +∞. */
export class WithRound extends SqlFormulaBuilder {
  round(x: SqlTerm, n: SqlTerm | null, at: number): SqlTerm {
    const v = this.need(x, 'number', 'round()', at).sql;
    return { sql: n?.literal ? `ROUND(${v}, ${String(n.literal.value)})` : `ROUND(${v})`, type: 'number' };
  }
}

/** A few statements' worth of round() over the tie rows (±0.5, 1.5, ±2.5, −7.25), for WithRound on a billed engine. */
export const ROUND_TIES: string[] = ['round([n])', 'round([m])', 'round([n], 1)', 'round([m], 1)'];

/** Every disagreement between the copy and Live over CALC_ROWS (empty = agree), the first row each. */
export async function calcDiff(engine: ParityEngine, exprs: string[], B: typeof SqlFormulaBuilder = SqlFormulaBuilder): Promise<string[]> {
  const { values, problems } = await liveValues(engine, 'calc_fx', CALC_ROWS, exprs, B);
  const maps = copyRows(CALC_ROWS);
  for (const [expr, live] of values) {
    const copy = copyValues(maps, expr);
    if (typeof copy === 'string') { problems.push(`${expr}: ${copy}`); continue; }
    const i = copy.findIndex((v, r) => !Object.is(v, live[r]));
    if (i >= 0) problems.push(`${expr} @ rid ${i}: copy ${show(copy[i])}, live ${show(live[i])}`);
  }
  return problems;
}
