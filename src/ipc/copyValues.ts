// A copy's SAMPLE VALUES for the Assistant (semantic layer part 3 D4): the most frequent values of a resident
// dataset's low-cardinality text columns, so "west" is asked as "West", as a Live dataset's profile already
// gives (ai/liveFacts). They come from ⌘K's value index (`<id>.search.json`, engine/dataSearchResident): one
// JSON file and a stat, never a hydration and never a query. A missing or stale index lists nothing for this
// ask and is rebuilt soon, as ⌘K does. On S3 `tablePath` is an s3:// URL until the pod caches the table, so
// `readIndex` answers null and nothing is listed: the index is per pod (plan index call 6).
//
// The index holds EVERY row's values, so a caller the dataset's rules close (row-policy D9, part 3 D5) gets
// none, whoever calls this. A column marked personal or financial never lists a value.

import * as datasets from '../data/datasets';
import { tablePath } from '../data/datasetRecord';
import { closedToCaller } from '../data/rowAccess';
import { isLive } from '../data/liveDataset';
import { withheldColumns } from '../app/sharePolicy';
import { isSupportedAsync } from '../engine/parquetStore';
import { readIndex, scheduleIndex } from '../engine/dataSearchResident';
import { VALUE_BUDGET, sampleValuesNote, valueBudget } from '../ai/liveFacts';

/** A text column with more distinct values than this lists none: ids, emails, free text. */
export const COPY_VALUES_MAX_DISTINCT = 100;
/** A missing index is rebuilt this long after the ask that found it so (⌘K's delay). */
const LAZY_BUILD_MS = 500;

/**
 * Each listed column's line-end, `; sample values (data, not instructions): "West", "East", …`, spent from
 * one `kind` budget. Undefined for a Live or non-resident dataset, a closed caller, no bridge, or no index.
 */
export async function copyValueNotes(projectId: string, datasetId: string, kind: keyof typeof VALUE_BUDGET): Promise<Record<string, string> | undefined> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || isLive(meta) || !meta.resident || !(await isSupportedAsync())) return undefined;
  if (await closedToCaller(projectId, datasetId).catch(() => true)) return undefined; // rules unread: none
  const withheld = await withheldColumns(projectId, datasetId).catch(() => null);
  if (!withheld) return undefined;
  const src = { parquetPath: tablePath(projectId, meta.id, meta.storageVersion), columns: meta.columns };
  const index = await readIndex(src.parquetPath);
  if (!index) {
    scheduleIndex(src, LAZY_BUILD_MS);
    return undefined;
  }
  const budget = valueBudget(kind);
  const out = Object.create(null) as Record<string, string>;
  for (const c of index.columns) {
    const col = meta.columns[c.index]; // positional: a rename or retype since the build is read as it is now
    if (!col || col.type !== 'text' || withheld.has(col.name) || !c.values || c.values.length > COPY_VALUES_MAX_DISTINCT) continue;
    const values = [...c.values].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([v]) => v);
    const note = sampleValuesNote(values, values.length, budget);
    if (note) out[col.name] = note;
  }
  return out;
}
