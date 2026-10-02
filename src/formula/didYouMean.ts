// "Did you mean [revenue]?" — the nearest real column to a name that is not
// one. MAIN PROCESS, PURE logic. Moved out of ipc/formula.ts so the formula
// editor's unknown-column hint and an LOD's unknown-dimension error
// (formula/lod.ts) suggest the SAME column.

/**
 * Levenshtein distance, two rows rather than a full matrix.
 *
 * Only ever run over COLUMN NAMES against one another, so the inputs are short
 * and few; there is no cache and does not need one.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The nearest column name, or undefined when nothing is near enough.
 *
 * The threshold scales with the typo's length: a third of it, at least one and
 * at most three. A flat threshold is wrong at both ends — at 1 it misses
 * `reveune`/`revenue` (a transposition is 2), and at 3 it confidently offers
 * `qty` for a three-letter word that shares nothing with it. Compared
 * case-insensitively because the lookup that failed is case-SENSITIVE, so
 * `[Revenue]` against a `revenue` column is exactly the case worth catching.
 */
export function nearestColumn(name: string, columns: string[]): string | undefined {
  const target = name.toLowerCase();
  const limit = Math.max(1, Math.min(3, Math.floor(target.length / 3)));
  let best: string | undefined;
  let bestDist = Infinity;
  for (const col of columns) {
    const dist = editDistance(target, col.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = col;
    }
  }
  return best !== undefined && bestDist <= limit ? best : undefined;
}
