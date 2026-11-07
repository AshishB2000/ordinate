// Count distinct non-empty values (semantic layer part 5, D1): THE JS reference. Its resident twin is
// src/engine/countDistinctSql.ts, held to this with Object.is by scripts/test-countDistinct.ts. The column's DECLARED
// type decides, never a cell's look. LOD COUNTD (src/formula/lod.ts) is not this: it counts date spellings.

import type { ColumnType } from '../data/parse';
import { isEmptyCell, type Cell } from '../data/transforms';
import { periodDay } from './dateIntel';

/** Text: distinct strings as stored (case-sensitive, untrimmed). Number: distinct finite numbers (a Set joins -0 and 0). Date: distinct readable days. Empties are not counted; no cells is 0. */
export function countDistinct(cells: Iterable<Cell>, type: ColumnType): number {
  const seen = new Set<string | number>();
  for (const c of cells) {
    const key = type === 'number' ? (typeof c === 'number' && Number.isFinite(c) ? c : null) : type === 'date' ? periodDay(c) : isEmptyCell(c) ? null : String(c);
    if (key !== null) seen.add(key);
  }
  return seen.size;
}
