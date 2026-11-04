// What the formula PARSER builds through. MAIN PROCESS, PURE.
//
// The parser (formulaParse.ts) owns the grammar, the token positions, the
// `refs` set, the LOD bookkeeping and every error; at each rule it calls ONE
// method here, and the builder turns the parts into its own T. formulaJs.ts is
// the JS builder (today's row closures); a second back end gets the same parse.

import type { LodAgg, LodDim, LodKind } from './formulaParse';

export type ArithOp = '+' | '-' | '*' | '/' | '%';
export type CompareOp = '=' | '==' | '!=' | '>' | '<' | '>=' | '<=';

/** One `{…}` as the parser read it: `arg` is the built argument, the rest is LodSpec's. */
export interface LodParts<T> {
  key: string;
  kind: LodKind;
  dims: LodDim[];
  agg: LodAgg;
  arg: T;
  argCol: string | null;
  nested: boolean;
  cost: number;
  start: number;
  end: number;
}

/** One method per grammar rule. `at` is the token index an error from the builder names (FormulaError.tokenIndex). */
export interface FormulaBuilder<T> {
  num(value: number, at: number): T;
  str(value: string, at: number): T;
  bool(value: boolean, at: number): T;
  nul(at: number): T;
  /** An unbound [[name]]. */
  param(at: number): T;
  col(name: string, at: number): T;
  /** Unary minus; unary + builds nothing. */
  neg(e: T, at: number): T;
  arith(op: ArithOp, l: T, r: T, at: number): T;
  compare(op: CompareOp, l: T, r: T, at: number): T;
  and(l: T, r: T, at: number): T;
  or(l: T, r: T, at: number): T;
  not(e: T, at: number): T;
  inList(subject: T, items: T[], at: number): T;
  ifThen(branches: { test: T; then: T }[], otherwise: T | null, at: number): T;
  caseWhen(subject: T, whens: { val: T; then: T }[], otherwise: T | null, at: number): T;
  /** `name` is lower-cased and an OWN key of FUNCTIONS: the parser checks it. */
  call(name: string, args: T[], at: number): T;
  lod(parts: LodParts<T>, at: number): T;
}
