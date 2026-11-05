// A distinct count on Live (semantic layer part 5, D2) — PURE, the live twin of src/engine/countDistinctSql.ts.
//
// The chart statement (./compile.ts) builds its measures from parts that re-aggregate: it ranks categories by summing
// parts across series, folds "Other" by re-aggregating parts, and totals categories and series the same way. A
// distinct count survives none of that, so wherever a statement ranks or folds, a `countd` is COUNTED AGAIN from
// `lv_base`, grouped by that level's key, and joined back. Held to the extract by scripts/test-liveParity.ts.

import type { LiveColumn } from './liveSpec';
import type { Ctx } from './compileFilter';
import { dateOf, emptyOf, numberOf, textOf } from './compileFilter';

/** What a distinct count counts, by the DECLARED type (`analysis/countDistinct`): a finite number, a day, non-empty text. */
export function distinctKey(c: Ctx, col: LiveColumn): string {
  if (col.type === 'number') {
    // −0 and 0 are one value, as in an extract (String(-0) is '0'); spelled as the compiler's number split key is.
    const n = numberOf(c, col);
    return `CASE WHEN ${n} = 0 THEN ${c.d.toDouble('0')} ELSE ${n} END`;
  }
  if (col.type === 'date') return dateOf(c, col);
  return `CASE WHEN NOT ${emptyOf(c, col)} THEN ${textOf(c, col)} END`;
}
