// What a Live dataset's source tables say about its dates, and the date range a question gets when
// its table requires one — MAIN PROCESS. docs/assistant/00-design.md, "Live date filters on key
// columns"; docs/live-data/log.md.
//
// The facts are the source table docs an editor keeps (src/app/sourceTables.ts): the warehouse's own
// partition, sort and cluster keys as a read stored them, and the editor's typed "required filters".
// They are read per question with the target (./liveTarget): records only, no warehouse call.
//
// A table that requires a filter on a date column (BigQuery's require_partition_filter, or an editor
// naming the column in "required filters") refuses, or scans every partition of, a question with no
// filter on it. Such a question gets REQUIRED_RANGE on that column here, in the executor's one shared
// step (./liveQuery `run`), so every door — answers, charts, tiles — gets it the same way and says so
// in one catalog sentence. A question that filters the column already (a filter, a lock, a base
// filter) is left as it came, and so is every question on a table with no such fact. The range is
// in the IR, so it is in the cache key and moves at midnight like any period.

import type { DatasetOrigin } from '../../data/datasetOrigin';
import { docTablesOf, sourceTablesOf } from '../../data/sourceTableOf';
import { listSourceIndex, readSourceDoc } from '../../app/sourceTables';
import type { PeriodSpec } from '../../analysis/dateIntel';
import { describePeriod, getCalendar, resolvePeriodNow } from '../../analysis/dateIntel';
import * as msg from '../liveQueryMessages';
import type { LiveColumn, LiveFilter, LiveIR } from './liveSpec';

/** The range a question on a table that requires one gets when it names none: the date control's "Last 12 months". */
export const REQUIRED_RANGE: PeriodSpec = { preset: 'last_n_months', n: 12 };

export interface DateFacts {
  /** Date columns a question must filter (a required partition filter, or one the editor names). */
  required: string[];
  /** Date columns that are a partition, sort or cluster key (compileFilter `RAW_RANGE_DIALECTS`). */
  keys: string[];
}

const NONE: DateFacts = { required: [], keys: [] };

/** The words of an editor's "required filters" line, lower-cased: `Filter on ORDER_DATE` names `order_date`. */
const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}_$]+/u));

/** What the dataset's documented source tables say about its declared date columns. Records only. */
export async function dateFactsOf(projectId: string, origin: Extract<DatasetOrigin, { kind: 'connection' }>, conn: { table?: string; query?: string } | undefined, columns: LiveColumn[]): Promise<DateFacts> {
  const dates = columns.filter((c) => c.type === 'date');
  if (!dates.length) return NONE;
  const index = new Map((await listSourceIndex(projectId, origin.connId)).map((e) => [e.table, e.docId]));
  if (!index.size) return NONE;
  const required = new Set<string>();
  const keys = new Set<string>();
  for (const table of docTablesOf(sourceTablesOf(origin, conn), [...index.keys()])) {
    const docId = index.get(table);
    const doc = docId ? (await readSourceDoc(projectId, origin.connId, docId))?.rec : undefined;
    if (!doc) continue;
    const f = doc.facts;
    const named = words(doc.requiredFilters);
    const keyed = new Set([...(f?.partition?.columns ?? []), ...(f?.sortKey ?? []), ...(f?.clusterBy ?? [])]);
    for (const c of dates) {
      if ((f?.partition?.required === true && f.partition.columns.includes(c.name)) || named.has(c.name.toLowerCase())) required.add(c.name);
      if (keyed.has(c.name)) keys.add(c.name);
    }
  }
  return { required: [...required], keys: [...keys] };
}

/** `ir` with REQUIRED_RANGE on each required column neither it nor the base filters filter, and the sentence that says so; else `ir` as it came. */
export function withRequiredRange(ir: LiveIR, required: readonly string[] | undefined, base: readonly LiveFilter[] | undefined): { ir: LiveIR; notes: string[] } {
  const filtered = new Set([...(base ?? []), ...ir.filters].map((f) => f.column));
  const missing = (required ?? []).filter((c) => !filtered.has(c));
  const r = missing.length ? resolvePeriodNow(REQUIRED_RANGE) : null;
  if (!r) return { ir, notes: [] };
  const added = missing.map((column): LiveFilter => ({ kind: 'range', column, ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) }));
  return { ir: { ...ir, filters: [...ir.filters, ...added] }, notes: [msg.liveRequiredRange(describePeriod(REQUIRED_RANGE, getCalendar()))] };
}
