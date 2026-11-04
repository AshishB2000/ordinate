// The JS formula builder: the row closures the parser used to build inline,
// moved here verbatim (same helpers, same order). MAIN PROCESS, PURE logic.
// An expression is DATA, never code: no `eval`, no `new Function`.

import { type EvalFn, arith, compareOp, looseEq, num, truthy, FUNCTIONS } from './formulaEval';
import { spendCall } from './formulaBudget';
import { FormulaError } from './formulaTokens';
import type { FormulaBuilder } from './formulaBuilder';
import type { LodSpec } from './formulaParse';

/** A fresh builder; `lods` collects each LOD it builds, in fill order (nested ones first). */
export function jsBuilder(): FormulaBuilder<EvalFn> & { readonly lods: LodSpec[] } {
  const lods: LodSpec[] = [];
  return {
    lods,
    num: (value) => () => value,
    str: (value) => () => value,
    bool: (value) => () => value,
    nul: () => () => null,
    // An UNBOUND parameter reads as null (formulaParse.parsePrimary says why).
    param: () => () => null,
    col: (name) => (row) => row[name] ?? null,
    neg: (e) => (row) => {
      const v = num(e(row));
      return v === null ? null : -v;
    },
    arith: (op, l, r) => arith(op, l, r),
    compare: (op, l, r) => compareOp(op, l, r),
    and: (l, r) => (row) => truthy(l(row)) && truthy(r(row)),
    or: (l, r) => (row) => truthy(l(row)) || truthy(r(row)),
    not: (e) => (row) => !truthy(e(row)),
    inList: (subject, items) => (row) => {
      const v = subject(row);
      for (const it of items) if (looseEq(v, it(row))) return true;
      return false;
    },
    ifThen: (branches, otherwise) => (row) => {
      for (const b of branches) if (truthy(b.test(row))) return b.then(row);
      return otherwise ? otherwise(row) : null;
    },
    caseWhen: (subject, whens, otherwise) => (row) => {
      const s = subject(row);
      for (const w of whens) if (looseEq(s, w.val(row))) return w.then(row);
      return otherwise ? otherwise(row) : null;
    },
    call: (name, args, at) => {
      if (!Object.hasOwn(FUNCTIONS, name)) { // the parser refuses it first; an inherited name is never ours
        const e = new FormulaError('Unknown function: ' + name);
        e.tokenIndex = at;
        throw e;
      }
      const fn = FUNCTIONS[name];
      return (row) => {
        const vals = args.map((a) => a(row));
        const out = fn(vals);
        spendCall(vals, out); // formulaBudget.ts: the text a call reads and writes is the author's to choose
        return out;
      };
    },
    // formula/lod.ts fills the row-map slot `key` before the row is evaluated.
    lod: (parts) => {
      lods.push({ ...parts });
      const key = parts.key;
      return (row) => row[key] ?? null;
    },
  };
}
