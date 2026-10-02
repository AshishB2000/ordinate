// A fitted regression as an ordinary calculated field — MAIN PROCESS, PURE.
//
// The workbench's "Save as calculated field" writes `predicted_<target>` as a
// formula in the app's own formula language (src/formula), so the prediction
// is a normal pipeline step: visible in Prepare, recomputed on refresh,
// removable like any other.
//
//   intercept + b1 * [x1] - b2 * [x2] + (CASE [region] WHEN "East" THEN b3
//                                          WHEN "West" THEN b4
//                                          WHEN "North" THEN 0 END)
//
// A categorical predictor is ONE CASE over its levels, the reference level
// THEN 0 and no ELSE — so an empty cell or a level the model never saw yields
// null (no prediction) rather than silently predicting the baseline. A
// missing number does the same through arithmetic on null.
//
// Every coefficient is written with `String(n)`, the shortest text that reads
// back to the same double, and the terms are in the order
// `regression.fittedAt` sums them — scripts/test-statsModels.ts evaluates this
// formula through the real formula engine and asserts it reproduces the
// model's fitted values with Object.is.

import type { RegressionOk } from './regression';
import { modelFits } from './regression';

/** The calculated field's name for a target column. */
export function predictedName(target: string): string {
  return 'predicted_' + target;
}

/**
 * A column name the formula language can reference as `[name]`: the tokenizer
 * reads up to the first `]` and trims, and `[[` opens a parameter.
 */
export function formulaSafeColumn(name: string): boolean {
  return name.length > 0 && !name.includes(']') && !name.startsWith('[') && name.trim() === name;
}

function str(level: string): string {
  return '"' + level.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function regressionFormula(res: RegressionOk): { ok: true; expression: string } | { ok: false; error: string } {
  const { intercept, fits } = modelFits(res);
  const bad = fits.find((f) => !formulaSafeColumn(f.column));
  if (bad) return { ok: false, error: `“${bad.column}” cannot be referenced in a formula (its name has a bracket or surrounding spaces). Rename it, then save again.` };
  let out = String(intercept);
  for (const f of fits) {
    if (f.kind === 'numeric') {
      out += (f.coef < 0 || Object.is(f.coef, -0) ? ' - ' + String(-f.coef) : ' + ' + String(f.coef)) + ' * [' + f.column + ']';
      continue;
    }
    const whens = f.coefs.map((c) => `WHEN ${str(c.level)} THEN ${String(c.coef)}`);
    whens.push(`WHEN ${str(f.reference)} THEN 0`);
    out += ` + (CASE [${f.column}] ${whens.join(' ')} END)`;
  }
  return { ok: true, expression: out };
}
