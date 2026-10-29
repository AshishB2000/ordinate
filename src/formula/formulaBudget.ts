// A formula's WORK BUDGET — MAIN PROCESS, PURE (NV-42).
//
// A formula runs once per row, synchronously, on the thread that serves every
// org, and its cost per row is the author's: `[a]+[a]+…` at 4,000 characters is
// ~12 µs a row, `len(lower(space(100000)))` repeated is milliseconds a row. User
// regex is bounded off-thread (engine/regexPool.ts); a formula is bounded here,
// by WORK rather than wall time, so a table and a formula get the same verdict on
// every machine.
//
// One budget covers one evaluation over a table (formula/lod.ts) — or a whole
// prepare fold, every formula step in it (transforms.applyPipeline hands its
// steps one). Every row costs the expression's token count; every function call
// costs the text it reads and writes, a unit per TEXT_PER_UNIT characters, and
// the pieces it splits that text into. Past the budget the evaluation throws
// FormulaBudgetError: the step is skipped, the editor's preview and the chart
// say why.
//
// Measured on the dev machine (M-series): a token evaluation is ~13 ns, and no
// text function measured past ~13 ns a unit (proper, regexp_replace over dense
// 100k-character cells), so the budget is ~2.6 s of the slowest work there —
// and still a million rows of 200 formula tokens across a pipeline.

import { formulaTooMuchWork } from '../data/workBudgetMessages';

export const FORMULA_WORK_BUDGET = 200_000_000;
const TEXT_PER_UNIT = 8;
/** A piece a call splits its text into (split, replace, proper's words): ~50 ns each, the dominant cost there. */
export const PIECE_UNITS = 4;
/** The longest text a growing function (concat, replace, regexp_replace) may build; past it the call is null. */
export const MAX_FORMULA_TEXT = 1_000_000;

export class FormulaBudgetError extends Error {
  constructor() {
    super(formulaTooMuchWork());
    this.name = 'FormulaBudgetError';
  }
}

export function isFormulaBudgetError(e: unknown): e is FormulaBudgetError {
  return e instanceof FormulaBudgetError;
}

/** What is left of one budget — shared by every evaluation handed it. */
export interface FormulaBudget {
  left: number;
}

export const newFormulaBudget = (): FormulaBudget => ({ left: FORMULA_WORK_BUDGET });

// The budget of the evaluation running NOW. Only ever set across a SYNCHRONOUS
// call (withFormulaBudget), so no other request's evaluation can interleave.
let current: FormulaBudget | null = null;

/** Run `fn` against `budget` (a fresh one when absent); inside another evaluation, that one's budget counts. */
export function withFormulaBudget<T>(budget: FormulaBudget | undefined, fn: () => T): T {
  if (current) return fn();
  current = budget || newFormulaBudget();
  try {
    return fn();
  } finally {
    current = null;
  }
}

export function spend(units: number): void {
  if (current && (current.left -= units) < 0) throw new FormulaBudgetError();
}

/** One function call: the text it was handed and the text it made. */
export function spendCall(args: unknown[], out: unknown): void {
  if (!current) return;
  let chars = typeof out === 'string' ? out.length : 0;
  for (const a of args) if (typeof a === 'string') chars += a.length;
  spend(1 + chars / TEXT_PER_UNIT);
}
