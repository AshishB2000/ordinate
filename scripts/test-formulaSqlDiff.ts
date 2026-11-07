// The formula's SQL back end held to the JS evaluator, row by row (semantic layer part 8, step 03;
// docs/semantic-layer/08-engine.md Tests, "Expression differential", "Safety", "Negative controls"):
// 2,000 seeded v1 expressions over scripts/formulaSqlCorpus.ts's rows, the copy's answer
// (evaluate(), stored as a copy stores it) against the DuckDB bench's under Object.is. Then a negative
// control per D5 spelling, the literals that must stay bound, and the named pins.
//
//   npm run build:ts && node scripts/test-formulaSqlDiff.js

import { ok, finish } from './selfcheck';
import type { Cell } from './liveParityFixture';
import type { CompareOp } from '../src/formula/formulaBuilder';
import type { SqlTerm } from '../src/engine/live/formulaSql';
import { compileCalcSql, SqlFormulaBuilder } from '../src/engine/live/formulaSql';
import { V1_FUNCTIONS } from '../src/engine/live/formulaSqlFunctions';
import { tokenize } from '../src/formula/formulaTokens';
import { compile } from '../src/formula/formula';
import { dialectFor } from '../src/engine/live/dialects';
import { ParamSink } from '../src/engine/live/sqlParams';

const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const cx: typeof import('./formulaSqlCorpus') = require('./formulaSqlCorpus');

const SEED = cx.CALC_SEED;
const CORPUS = cx.calcCorpus(SEED, 2_000);

// ── The negative controls: each drops one of D5's spellings ──
class NoNullFold extends SqlFormulaBuilder {
  ordered(op: CompareOp, a: string, b: string): string {
    return `(${a} ${op} ${b})`; // SQL's three-valued compare: NULL where JS says true or false
  }
}
class NoNullifRead extends SqlFormulaBuilder {
  col(name: string, at: number): SqlTerm {
    const t = super.col(name, at);
    return t.type === 'text' ? { ...t, sql: t.sql.replace(/^NULLIF\((.*), ''\)$/, '$1') } : t; // '' kept apart from NULL
  }
}
class NoNullifProjection extends SqlFormulaBuilder {
  project(t: SqlTerm, at: number): ReturnType<SqlFormulaBuilder['project']> {
    const p = super.project(t, at);
    return t.type === 'text' ? { ...p, sql: t.sql } : p; // a '' the formula made, kept
  }
}

/** How often each v1 function and each operator appears in the corpus, by the formula tokenizer. */
function coverage(exprs: string[]): Map<string, number> {
  const n = new Map<string, number>();
  const add = (k: string): void => { n.set(k, (n.get(k) ?? 0) + 1); };
  for (const e of exprs) {
    const toks = tokenize(e);
    toks.forEach((t, i) => {
      const next = toks[i + 1];
      const prev = toks[i - 1];
      if (t.kind === 'name' && next?.kind === 'punc' && next.value === '(' && t.value.toLowerCase() !== 'in') add(t.value.toLowerCase() + '()');
      else if (t.kind === 'name' && ['and', 'or', 'not', 'in', 'if', 'case'].includes(t.value.toLowerCase())) add(t.value.toUpperCase());
      else if (t.kind === 'op') add(t.value === '-' && (!prev || prev.kind === 'op' || (prev.kind === 'punc' && prev.value !== ')')) ? 'unary -' : t.value);
    });
  }
  return n;
}

async function liveValue(expr: string, row: Cell[]): Promise<Cell | undefined> {
  const r = await cx.liveValues(fx.duckEngine, 'calc_one', [row], [expr]);
  return r.values.get(expr)?.[0];
}

const nullRow = (over: Record<number, Cell>): Cell[] => cx.CALC_ROWS[0].map((v, i) => (i in over ? over[i] : v));

async function main(): Promise<void> {
  // ── The corpus itself ──
  ok('the corpus is 2,000 expressions, the same on every run', CORPUS.length === 2_000 && cx.calcCorpus(SEED, 2_000).join('\n') === CORPUS.join('\n'));
  const notJs = CORPUS.filter((e) => !compile(e).ok);
  ok('every expression compiles on the copy', notJs.length === 0, notJs.slice(0, 3).join(' | '));
  const cov = coverage(CORPUS);
  const wanted = [...V1_FUNCTIONS.map((f) => `${f}()`), '+', '-', '*', '/', 'unary -', '=', '==', '!=', '<', '>', '<=', '>=', 'AND', 'OR', 'NOT', 'IN', 'IF', 'CASE'];
  const thin = wanted.filter((k) => (cov.get(k) ?? 0) < 20);
  ok('every v1 function and every operator appears at least 20 times', thin.length === 0, thin.map((k) => `${k}: ${cov.get(k) ?? 0}`).join(', '));
  ok('the fixture imports as declared (2^53 sits in a text column)', cx.copyRows(cx.CALC_ROWS).length === cx.CALC_ROWS.length);

  // ── The differential ──
  const bad = await cx.calcDiff(fx.duckEngine, CORPUS);
  ok('every v1 expression, every row: copyCell(evaluate) === Live, under Object.is', bad.length === 0, `${bad.length} problems: ${bad.slice(0, 5).join(' | ')}`);

  // ── Negative controls: each spelling D5 needs, dropped, is caught ──
  const using = (re: RegExp): string[] => CORPUS.filter((e) => re.test(e)).slice(0, 300);
  for (const [name, B, re] of [
    ['no null fold in <', NoNullFold, /[<>]/],
    ["no NULLIF('') on a text column", NoNullifRead, /\[[tu]\]/],
    ["no NULLIF('') at the projection", NoNullifProjection, /trim\(|concat\(/],
    ['ROUND instead of the FLOOR CASE', cx.WithRound, /round\(/],
  ] as const) {
    const caught = await cx.calcDiff(fx.duckEngine, using(re), B);
    ok(`NEGATIVE CONTROL: ${name} is caught`, caught.length > 0 && caught.every((p) => !/refused/.test(p)), caught.slice(0, 2).join(' | '));
  }

  // ── Safety: a value the formula writes is a parameter, never statement text ──
  for (const lit of ["'; DROP TABLE x; --", "a'b", 'back\\slash', 'tick`', 'nul\u0000', '\u0000 0 \u0000']) {
    const b = new ParamSink();
    const d = dialectFor('duckdb');
    const r = compileCalcSql(`concat([t], ${cx.quoteFormula(lit)})`, { d, b, columns: cx.CALC_COLUMNS, earlier: [] });
    const q = r.ok ? b.finish(r.sql, d, ['v']) : null;
    ok(`literal ${JSON.stringify(lit)} is bound, never in the SQL text`, !!q && !q.sql.includes(lit) && !q.sql.includes('\u0000') && q.params.some((p) => p.value === lit), show(q?.sql));
  }
  const drop = await liveValue("concat([t], '\\'; DROP TABLE calc_one; --')", nullRow({ 3: 'x' }));
  ok("a quote and a DROP in a literal are text on the warehouse, too", drop === "x'; DROP TABLE calc_one; --", show(drop));

  // Step 03's overflow and casing pins run on every engine now: scripts/liveParityPins.ts, PINs 10 and 11.

  // ── PIN: concat past 1,000,000 characters is null in JS (formulaBudget.MAX_FORMULA_TEXT); SQL has no cap ──
  const long = 'x'.repeat(600_000);
  const cj = compile('concat([t], [t])');
  const cl = await liveValue('concat([t], [t])', nullRow({ 3: long }));
  ok('PIN: concat past 1,000,000 characters is null in JS and the whole text on Live',
    cj.ok && cj.fn.evaluate({ t: long }) === null && typeof cl === 'string' && cl.length === 1_200_000, show(typeof cl === 'string' ? cl.length : cl));
}

const show = cx.show;

main().catch((e) => {
  console.error('FAIL harness threw:', e);
  process.exitCode = 1;
}).finally(finish);
