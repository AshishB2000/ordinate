// Metric-level formulas — MAIN PROCESS, PURE logic.
// No Electron, no fs, no DOM. Node-testable by a plain `node` self-check.
//
// A metric formula is an expression over OTHER METRICS and over AGGREGATIONS of
// this dataset's columns:
//
//     [Profit] / [Revenue]
//     sum(revenue) - sum(cost)
//
// This is NOT a row-level calculated field. A calculated field in Prepare runs
// once per row and stays exactly what it is; this runs once per RESOLUTION, over
// figures the app has already computed. `[Profit]` here is the Profit metric's
// whole number, not a cell.
//
// ── Why the grammar is untouched ─────────────────────────────────────────────
// The parser resolves a call against `FUNCTIONS` (formulaEval.ts) at PARSE time,
// so `sum(revenue)` is "Unknown function: sum" — and `min`/`max` DO exist there,
// as row-level scalars over their arguments. Adding aggregates to that table
// would make `min(a, b)` mean one thing in a calculated field and another here.
//
// So the expression is REWRITTEN AT THE TOKEN LEVEL instead: the four tokens
// `sum` `(` `revenue` `)` collapse into ONE synthetic reference token, and the
// ordinary parser then sees a plain column reference it already knows how to
// read. Nothing in formulaTokens/formulaParse/formulaEval changes, and a
// one-argument `min(ship_days)` still falls through to `FUNCTIONS` untouched
// unless its argument names a real column.
//
// The synthetic token KEEPS the start/end of the text it replaced, so a parse
// error inside a rewritten call still underlines what the user typed.

import { tokenize, type Tok } from '../formula/formulaTokens';
import { compileTokens, type Compiled, type SourceSpan } from '../formula/formula';
import type { MetricAggregation } from './metricValue';

/**
 * The sentinel that marks a rewritten aggregation.
 *
 * `@` cannot start a bare identifier (IDENT_START is `[A-Za-z_]`) and the
 * tokenizer rejects it outright outside brackets, so no expression a user can
 * type produces a reference in this namespace — which is what stops a metric
 * named `agg:sum:revenue` from colliding with one.
 */
const AGG_PREFIX = '@agg:';

const AGG_FNS: ReadonlySet<string> = new Set<MetricAggregation>(['sum', 'avg', 'count', 'min', 'max']);

/** One `sum(revenue)` the rewrite turned into a reference. */
export interface AggOperand {
  ref: string;
  aggregation: MetricAggregation;
  column: string;
}

export interface MetricFormulaProgram {
  fn: Compiled;
  /** Aggregations to compute against this metric's own dataset. */
  aggregates: AggOperand[];
  /** Everything else the expression referenced — resolved as metric NAMES. */
  metricRefs: string[];
}

export type MetricFormulaResult =
  | { ok: true; program: MetricFormulaProgram }
  | { ok: false; error: string; at?: SourceSpan };

function isAggRef(ref: string): boolean {
  return ref.startsWith(AGG_PREFIX);
}

/** `@agg:sum:revenue` → {aggregation, column}. The column may itself contain a
 *  colon, so only the FIRST separator after the prefix is a separator. */
function parseAggRef(ref: string): AggOperand | null {
  const body = ref.slice(AGG_PREFIX.length);
  const cut = body.indexOf(':');
  if (cut < 0) return null;
  const aggregation = body.slice(0, cut);
  const column = body.slice(cut + 1);
  if (!AGG_FNS.has(aggregation) || !column) return null;
  return { ref, aggregation: aggregation as MetricAggregation, column };
}

/**
 * Collapse `agg(column)` calls into single reference tokens.
 *
 * Rewrites ONLY when every one of these holds, so an ordinary `FUNCTIONS` call
 * is never stolen:
 *   · the name is one of the five aggregations;
 *   · it is immediately followed by `(`;
 *   · there is EXACTLY ONE argument token, a bare identifier or a [bracketed]
 *     reference, closed by `)`;
 *   · that argument names a column the metric's dataset actually has.
 *
 * `min(ship_days)` over a real column is therefore the minimum of the column,
 * while `min(1, 2)` and `min(x)` over a non-column stay the row-level function
 * the calculated-field grammar already defines.
 */
function rewriteAggregations(tokens: Tok[], columns: ReadonlySet<string>): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const name = tokens[i];
    const open = tokens[i + 1];
    const arg = tokens[i + 2];
    const close = tokens[i + 3];
    const isCall =
      name.kind === 'name' &&
      AGG_FNS.has(name.value.toLowerCase()) &&
      open && open.kind === 'punc' && open.value === '(' &&
      arg && (arg.kind === 'name' || arg.kind === 'col') &&
      close && close.kind === 'punc' && close.value === ')' &&
      columns.has(arg.value);
    if (!isCall) {
      out.push(name);
      continue;
    }
    out.push({
      kind: 'col',
      value: AGG_PREFIX + name.value.toLowerCase() + ':' + arg.value,
      // The whole call's span, so an underline covers `sum(revenue)` and not a
      // synthetic name that appears nowhere in the source.
      start: name.start,
      end: close.end,
    });
    i += 3;
  }
  return out;
}

/**
 * Compile a metric formula against the columns of its own dataset.
 *
 * `columns` decides only which single-argument calls are AGGREGATIONS; an
 * expression that references no column at all (`[Profit] / [Revenue]`) compiles
 * the same with an empty set.
 *
 * Never throws: a tokenizer or parser failure comes back as `{ok:false}` with
 * the span the editor underlines, exactly as `compile` does.
 */
export function compileMetricFormula(expression: string, columns: Iterable<string>): MetricFormulaResult {
  if (typeof expression !== 'string' || expression.trim() === '') {
    return { ok: false, error: 'Empty expression' };
  }
  let tokens: Tok[];
  try {
    tokens = tokenize(expression);
  } catch (e: any) {
    const at = e && e.at ? (e.at as SourceSpan) : undefined;
    const error = e instanceof Error ? e.message : 'Parse error';
    return at ? { ok: false, error, at } : { ok: false, error };
  }

  const res = compileTokens(rewriteAggregations(tokens, new Set(columns)), expression);
  if (!res.ok) return res;

  const aggregates: AggOperand[] = [];
  const metricRefs: string[] = [];
  for (const ref of res.fn.refs) {
    if (!isAggRef(ref)) {
      metricRefs.push(ref);
      continue;
    }
    const agg = parseAggRef(ref);
    // Unreachable via rewriteAggregations, which only ever emits well-formed
    // refs — but a ref in the sentinel namespace that did not come from there
    // is not an aggregation, and treating it as a metric name is the honest
    // fallback (it will simply not resolve).
    if (agg) aggregates.push(agg);
    else metricRefs.push(ref);
  }
  return { ok: true, program: { fn: res.fn, aggregates, metricRefs } };
}

/**
 * Evaluate a compiled program against already-resolved operand values.
 *
 * `values` is keyed by REF — `@agg:sum:revenue` for an aggregation, the metric
 * name as written for a metric reference. A missing or non-numeric operand is
 * `null`, and the formula engine degrades the whole expression to null rather
 * than fabricating a figure: `[Profit] / [Revenue]` with no Revenue is "—", not
 * Infinity and not 0.
 */
export function evaluateMetricFormula(
  program: MetricFormulaProgram,
  values: Map<string, number | null>,
): number | null {
  const row: Record<string, number | null> = Object.create(null);
  for (const [k, v] of values) row[k] = v;
  const out = program.fn.evaluate(row);
  return typeof out === 'number' && Number.isFinite(out) ? out : null;
}
