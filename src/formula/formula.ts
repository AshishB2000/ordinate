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

import { tokenize } from './formulaTokens';
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

export type CompileResult = { ok: true; fn: Compiled } | { ok: false; error: string };

// Parse ONCE to a compiled function; evaluate per row (cheap). Any failure to
// parse is returned as { ok:false, error }, never thrown.
export function compile(expression: string): CompileResult {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { ok: false, error: 'Empty expression' };
  }
  try {
    const tokens = tokenize(expression);
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
    return { ok: false, error: msg };
  }
}
