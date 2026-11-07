// The value labels an answer's filters may be said by (semantic layer part 3 D6): "Europe" asked for the stored
// "EU". One catalog read, only the columns a value filter names that have labels. The mapping itself is the
// pure `matchValues` (extract) or `liveCaseFix` (Live), each checked against the caller's own rows: a label
// never names a value the caller's lock hides.

import * as catalog from '../app/catalog';
import { MATCH_OPS } from '../ai/answerValues';
import type { FilterLabels } from '../ai/answerValues';
import type { AnswerFilter } from '../ai/answerSpec';
import type { ValueLabel } from '../analysis/valueLabels';

/** column → its labels, for the value filters' columns that have any; undefined when none do (and no read without a value filter). */
export async function filterLabels(projectId: string, datasetId: string, filters: readonly AnswerFilter[]): Promise<FilterLabels | undefined> {
  const columns = new Set(filters.flatMap((f) => ('term' in f || 'period' in f || !MATCH_OPS.has(f.op) ? [] : [f.column])));
  if (!columns.size) return undefined;
  const docs = (await catalog.load(projectId)).columns[datasetId];
  const out = new Map<string, ValueLabel[]>();
  for (const c of columns) {
    const list = docs && Object.prototype.hasOwnProperty.call(docs, c) ? docs[c].values : undefined;
    if (Array.isArray(list) && list.length) out.set(c, list);
  }
  return out.size ? out : undefined;
}
