// Safe expression evaluator — MAIN PROCESS, PURE logic.
// No Electron, no fs, no DOM. Its ONLY job: turn a small expression string into a
// compiled function that maps a row ({colName: value}) to a scalar. Used by
// src/transforms.ts for `calculated_field` steps.
//
// SECURITY: this is a hand-written tokenizer + recursive-descent parser +
// tree-walking evaluator, across four files — this one (the public API),
// formulaTokens.ts, formulaEval.ts and formulaParse.ts. There is deliberately
// NO `eval` and NO `new Function` in ANY of them — an expression is DATA, never
// code. A malformed
// expression (syntax error, unknown function, injection like "1; process.exit")
// returns a structured { ok:false, error } from `compile` and NEVER throws.
// Per-row runtime problems (unknown column, div-by-zero, type mismatch) degrade
// to `null`, never throw and never fabricate a number.
//
// The strict-number rule (parse.isFiniteNumber) is intentionally NOT applied to
// numeric LITERALS inside an expression (a formula may legitimately write 1.50).
// transforms.ts applies it to the OUTPUT column only when the results are NOT
// already numbers, so an identifier-shaped result (e.g. "007") still lands as
// text — while a computed double keeps its type instead of being re-inferred from
// its own decimal expansion, which the >15-digit guard would reject.

import { FormulaError, tokenize, type Tok } from './formulaTokens';
import { Parser } from './formulaParse';

// ── Public API ───────────────────────────────────────────────────────────────

export type FValue = number | string | boolean | null;

export interface Compiled {
  // Evaluate against a single row. Never throws — degrades to null on any
  // runtime issue (unknown column, div-by-zero, non-numeric operand).
  evaluate(row: Record<string, FValue>): FValue;
  // Column names referenced by the expression, so transforms.ts can warn when a
  // formula references a column that does not exist.
  refs: string[];
}

/** Where an error is, in SOURCE OFFSETS — `expression.slice(start, end)` is the
 *  offending text. Present whenever the failure could be pinned to one; the
 *  formula editor underlines it, and every other caller ignores it. */
export interface SourceSpan {
  start: number;
  end: number;
}

export type CompileResult =
  | { ok: true; fn: Compiled }
  | { ok: false; error: string; at?: SourceSpan };

// The parser counts TOKENS; an underline needs CHARACTERS. The tokens are right
// here, so this is the whole mapping.
//
// A token index PAST the end is the "…but got end of input" case — an unclosed
// call, a trailing operator. There is no token to underline, so the span runs
// from the last token's end to the end of the source; when the expression ends
// exactly there (nothing trailing to mark) it backs up over the final character,
// because a zero-width underline draws nothing at all.
function spanOf(tokens: Tok[], index: number, src: string): SourceSpan | undefined {
  const t = tokens[index];
  if (t) return { start: t.start, end: t.end };
  const last = tokens[tokens.length - 1];
  const start = last ? last.end : 0;
  // Trailing whitespace is never where the mistake is. Without this, `[a] / `
  // underlines the space after the operator and `[a] /` underlines the
  // operator — the same mistake, marked in two places, decided by whether the
  // user's finger was still on the space bar.
  let end = src.length;
  while (end > 0 && /\s/.test(src[end - 1])) end -= 1;
  if (end <= 0) return undefined;
  return start < end ? { start, end } : { start: Math.max(0, end - 1), end };
}

// Parse ONCE to a compiled function; evaluate per row (cheap). Any failure to
// parse is returned as { ok:false, error }, never thrown.
export function compile(expression: string): CompileResult {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { ok: false, error: 'Empty expression' };
  }
  let tokens: Tok[];
  try {
    tokens = tokenize(expression);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Parse error';
    const at = e instanceof FormulaError ? e.at : undefined;
    return at ? { ok: false, error: msg, at } : { ok: false, error: msg };
  }
  return compileTokens(tokens, expression);
}

/**
 * `compile`, starting from tokens the caller already has.
 *
 * Exists for ONE caller: src/analysis/metricFormula.ts, which rewrites
 * `sum(revenue)` into a single synthetic reference token before parsing, so that
 * a metric-level aggregation works without adding aggregate functions to the
 * row-level `FUNCTIONS` table (where `sum` over one row's cell would be a
 * different and wrong thing).
 *
 * `src` is the ORIGINAL expression, used only to turn a token index back into a
 * source span. Because a rewritten token keeps the `start`/`end` of the text it
 * replaced, an error inside a rewritten call still underlines what the user
 * actually typed.
 */
export function compileTokens(tokens: Tok[], src: string): CompileResult {
  try {
    const parser = new Parser(tokens);
    const fn = parser.parse();
    const refs = Array.from(parser.refs);
    const compiled: Compiled = {
      refs,
      evaluate(row: Record<string, FValue>): FValue {
        try {
          const v = fn(row);
          return v === undefined ? null : v;
        } catch (_) {
          return null; // per-row degrade — never throw
        }
      },
    };
    return { ok: true, fn: compiled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Parse error';
    if (e instanceof FormulaError) {
      const at = e.at ?? (e.tokenIndex === undefined ? undefined : spanOf(tokens, e.tokenIndex, src));
      if (at) return { ok: false, error: msg, at };
    }
    return { ok: false, error: msg };
  }
}
