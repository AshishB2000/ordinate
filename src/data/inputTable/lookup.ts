// The other side of a lookup — MAIN PROCESS.
//
// A lookup column says "every value here is one of <dataset>.<column>'s keys",
// which is word for word a `references` data-quality rule. So a lookup is
// CHECKED by that rule's own evaluator (qualityRules.failingPredicateJs, see
// ./validate.ts), and all this file does is fetch the other side as the
// evaluator's `RefTable`: one column, one row per distinct key.
//
// Two paths, the resident layer's usual shape: the keys straight off the key
// dataset's Parquet (engine/lookupResident.ts), else `lookupKeysJs` — the
// reference it is differentially tested against — over the hydrated table.

import * as datasets from '../datasets';
import * as trace from '../../engine/residentTrace';
import { lookupKeysResident } from '../../engine/lookupResident';
import { cellKey } from '../../analysis/qualityRules';
import type { RefTable } from '../../analysis/qualityRules';
import type { ParsedColumn } from '../parse';
import type { Cell } from './edits';

/** First-seen distinct non-empty keys (`qualityRules.cellKey`), or null when the column is not there. */
export function lookupKeysJs(columns: ParsedColumn[], rows: Cell[][], column: string): Array<string | number> | null {
  const ci = Array.isArray(columns) ? columns.findIndex((c) => c && c.name === column) : -1;
  if (ci < 0) return null;
  const isNum = columns[ci].type === 'number';
  const seen = new Set<string | number>();
  const out: Array<string | number> = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = cellKey(Array.isArray(row) ? row[ci] : null, isNum);
    if (k === null || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * `<datasetId>.<column>` as a references rule's RefTable. Null when the dataset
 * is gone (the rule then says so). A missing column comes back as the dataset's
 * columns with no rows, so the rule's own resolver names the column that went.
 */
export async function refTableFor(projectId: string, datasetId: string, column: string): Promise<RefTable | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  const ci = meta.columns.findIndex((c) => c && c.name === column);
  if (ci < 0) return { columns: meta.columns, rows: [] };
  const col = { name: meta.columns[ci].name, type: meta.columns[ci].type };

  // ponytail: every distinct key is read on each check, uncached; a key column
  // with hundreds of thousands of keys wants a membership query or a cache.
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const fast = await lookupKeysResident(src, column);
    if (fast) {
      trace.record('lookupKeys', 'resident');
      return { columns: [col], rows: fast.map((k) => [k]) };
    }
    trace.record('lookupKeys', 'failed', `${src.columns.length} cols`);
  } else {
    trace.record('lookupKeys', 'skipped');
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  const keys = ds ? lookupKeysJs(ds.columns, ds.rows, column) : null;
  return keys ? { columns: [col], rows: keys.map((k) => [k]) } : null;
}
