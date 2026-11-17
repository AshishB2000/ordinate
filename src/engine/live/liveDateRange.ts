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
// in the IR, so it is in the cache key and moves at midnight like any period. SQL on Live datasets
// takes the same rule through `requiredRange` (./liveSql: in the view of a table no WHERE of the
// statement filters on that column), with the same sentence on its card.
//
// A lookup (the answers' case fix, the latest-day probe, the key check, the schema sync's sample) is not a
// question, so it takes the rule through `lookupRequired`: the same range on each required column its own
// filters leave open. A lookup whose result a person reads says so with the same sentence; one whose result is
// STORED (the key check, the profile) stores the range's days beside it (../../data/liveRange), and a required
// column with no default skips it, said by its reader, never guessed.
//
// Two required partitions are not a declared date. BigQuery's ingestion-time `_PARTITIONTIME` is a
// pseudo-column, in no dataset's columns: a table source gets REQUIRED_RANGE on it as a TIMESTAMP range
// (a `range` with `partitionTime`, compileFilter), among the BASE filters, so it sits on the table scan
// itself, innermost under any calc, and in the cache key. A required integer-range partition has no
// sensible default, so a question that leaves it unfiltered is refused (`requiredFilter`), naming it.

import type { DatasetOrigin } from '../../data/datasetOrigin';
import { docTablesOf, sourceTablesOf } from '../../data/sourceTableOf';
import { listSourceIndex, readSourceDoc } from '../../app/sourceTables';
import { resolvePeriodNow } from '../../analysis/dateIntel';
import { REQUIRED_RANGE, requiredPeriod } from '../../data/liveRange';
import * as msg from '../liveQueryMessages';
import type { LiveColumn, LiveFilter, LiveIR, LiveRefusal } from './liveSpec';
import { refuse } from './liveSpec';
import type { CompileEnv, LiveSource } from './compile';
import type { LiveDialectId } from '../../connectors/types';

/** The range a question on a table that requires one gets when it names none (../../data/liveRange, where stored results read it too). */
export { REQUIRED_RANGE };

/** BigQuery's ingestion-time partition pseudo-column. */
export const PARTITION_TIME = '_PARTITIONTIME';

export interface DateFacts {
  /** Date columns a question must filter (a required partition filter, or one the editor names). */
  required: string[];
  /** Date columns that are a partition, sort or cluster key (compileFilter `RAW_RANGE_DIALECTS`). */
  keys: string[];
  /** The table is partitioned by ingestion time (`_PARTITIONTIME`) and requires a filter on it. */
  partitionTime?: true;
  /** Declared columns, not dates, a required partition filter names (an integer range): no default range. */
  unbounded?: string[];
}

/** What a question on a dataset must filter: LiveTarget's own fields (./liveTarget). */
export interface Requires {
  requiredDates?: string[];
  /** A BigQuery table source partitioned by ingestion time that requires a filter. */
  requiredTime?: true;
  /** Required columns with no default range: a question that leaves one open is refused. */
  requiredColumns?: string[];
}

/**
 * What a question on the dataset must filter, from its tables' facts (`dateFactsOf`). The pseudo-column is the
 * table's: a defining query reads it inside, where its own filter must be, so only a BigQuery table source gets it.
 */
export function requiresOf(dates: DateFacts, dialect: LiveDialectId, source: LiveSource): Requires {
  return {
    ...(dates.required.length ? { requiredDates: dates.required } : {}),
    ...(dates.partitionTime && dialect === 'bigquery' && source.kind === 'table' ? { requiredTime: true as const } : {}),
    ...(dates.unbounded?.length ? { requiredColumns: dates.unbounded } : {}),
  };
}

/** The words of an editor's "required filters" line, lower-cased: `Filter on ORDER_DATE` names `order_date`. */
const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}_$]+/u));

/** What the dataset's documented source tables say about its required partitions and date keys. Records only. */
export async function dateFactsOf(projectId: string, origin: Extract<DatasetOrigin, { kind: 'connection' }>, conn: { table?: string; query?: string } | undefined, columns: LiveColumn[]): Promise<DateFacts> {
  const index = new Map((await listSourceIndex(projectId, origin.connId)).map((e) => [e.table, e.docId]));
  if (!index.size) return { required: [], keys: [] };
  const dates = columns.filter((c) => c.type === 'date');
  const required = new Set<string>();
  const keys = new Set<string>();
  const unbounded = new Set<string>();
  let partitionTime = false;
  for (const table of docTablesOf(sourceTablesOf(origin, conn), [...index.keys()])) {
    const docId = index.get(table);
    const doc = docId ? (await readSourceDoc(projectId, origin.connId, docId))?.rec : undefined;
    if (!doc) continue;
    const f = doc.facts;
    const named = words(doc.requiredFilters);
    const keyed = new Set([...(f?.partition?.columns ?? []), ...(f?.sortKey ?? []), ...(f?.clusterBy ?? [])]);
    const partReq = f?.partition?.required === true ? f.partition.columns : [];
    for (const c of dates) {
      if (partReq.includes(c.name) || named.has(c.name.toLowerCase())) required.add(c.name);
      if (keyed.has(c.name)) keys.add(c.name);
    }
    if (partReq.includes(PARTITION_TIME) && !columns.some((c) => c.name === PARTITION_TIME)) partitionTime = true;
    // Only the warehouse's own fact: an editor's free words name a range nobody could default.
    for (const c of columns) if (c.type !== 'date' && partReq.includes(c.name)) unbounded.add(c.name);
  }
  return { required: [...required], keys: [...keys], ...(partitionTime ? { partitionTime: true as const } : {}), ...(unbounded.size ? { unbounded: [...unbounded] } : {}) };
}

type Ranged = { ok: true; filters: LiveFilter[]; notes: string[] };

/**
 * What a table requires that `filtered` (the columns already filtered) leaves open: REQUIRED_RANGE on each
 * required date column and on the partition time, and the sentence that says so; none when nothing is
 * missing. A required column with no default range left open is the refusal naming it.
 */
export function requiredRange(req: Requires | undefined, filtered: Iterable<string>): Ranged | LiveRefusal {
  const done = new Set(filtered);
  const open = (req?.requiredColumns ?? []).find((c) => !done.has(c));
  if (open) return refuse('requiredFilter', open);
  const missing = (req?.requiredDates ?? []).filter((c) => !done.has(c));
  const time = req?.requiredTime === true && !done.has(PARTITION_TIME);
  const r = missing.length || time ? resolvePeriodNow(REQUIRED_RANGE) : null;
  if (!r) return { ok: true, filters: [], notes: [] };
  const bounds = { ...(r.from ? { from: r.from } : {}), ...(r.to ? { to: r.to } : {}) };
  const filters = missing.map((column): LiveFilter => ({ kind: 'range', column, ...bounds }));
  if (time) filters.push({ kind: 'range', column: PARTITION_TIME, ...bounds, partitionTime: true });
  return { ok: true, filters, notes: [requiredRangeNote()] };
}

/** What a figure held to REQUIRED_RANGE says, in the reader's language: *Last 12 months: this table needs a date range*. */
export const requiredRangeNote = (): string => msg.liveRequiredRange(requiredPeriod());

/** `env` with the partition-time range among its base filters (on the table scan, innermost), else `env` as it came. */
function withTime(env: CompileEnv, filters: readonly LiveFilter[]): CompileEnv {
  const time = filters.filter((f) => f.kind === 'range' && f.partitionTime === true);
  return time.length ? { ...env, base: [...(env.base ?? []), ...time] } : env;
}

const dated = (filters: readonly LiveFilter[]): LiveFilter[] => filters.filter((f) => !(f.kind === 'range' && f.partitionTime === true));

/**
 * `ir` with REQUIRED_RANGE on each required column neither it nor the base filters filter (the partition
 * time in `env`'s base filters), and the sentence that says so; else both as they came. A required column
 * with no default left open refuses the question.
 */
export function withRequiredRange(ir: LiveIR, req: Requires & { env: CompileEnv }): { ok: true; ir: LiveIR; env: CompileEnv; notes: string[] } | LiveRefusal {
  const r = requiredRange(req, [...(req.env.base ?? []), ...ir.filters].map((f) => f.column));
  if (!r.ok) return r;
  if (!r.filters.length) return { ok: true, ir, env: req.env, notes: [] };
  const own = dated(r.filters);
  return { ok: true, ir: own.length ? { ...ir, filters: [...ir.filters, ...own] } : ir, env: withTime(req.env, r.filters), notes: r.notes };
}

/**
 * A lookup's filters (`lock`: its own, a row lock among them) with what its table requires that neither they
 * nor the base filters cover, and the env to compile under (the partition time among its base filters).
 * `notes` is the sentence, for a lookup whose result a person reads. A required column with no default left
 * open refuses the lookup, as it would the question.
 */
export function lookupRequired(t: Requires & { env: CompileEnv }, lock: readonly LiveFilter[]): { ok: true; env: CompileEnv; filters: LiveFilter[]; notes: string[]; range?: { from?: string; to?: string } } | LiveRefusal {
  const r = requiredRange(t, [...(t.env.base ?? []), ...lock].map((f) => f.column));
  if (!r.ok) return r;
  if (!r.filters.length) return { ok: true, env: t.env, filters: [...lock], notes: [] };
  const f = r.filters[0] as Extract<LiveFilter, { kind: 'range' }>;
  return { ok: true, env: withTime(t.env, r.filters), filters: [...lock, ...dated(r.filters)], notes: r.notes, range: { ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}) } };
}
