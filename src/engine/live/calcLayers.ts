// A Live dataset's calculated fields in a statement (semantic layer part 8, step 04; docs/semantic-layer/
// 08-engine.md D7) — PURE.

import type { LiveSource } from './compile';

/**
 * Does a statement over these column names read a calculated field? Ignoring case, as BigQuery and
 * Databricks resolve names, so a warehouse column that differs from a calc only by case is caught too.
 */
export function namesCalc(names: readonly string[], src: LiveSource): boolean {
  const calcs = src?.calcs;
  if (!calcs?.length) return false;
  const lower = new Set(calcs.map((c) => c.name.toLowerCase()));
  return names.some((n) => typeof n === 'string' && lower.has(n.toLowerCase()));
}
