// The figure doors under row access rules (docs/row-policy/00-design.md D7) —
// MAIN PROCESS.
//
// `vizDataFor`, `computeCardMetric` and `computeCard` (and the grid's `pageFor`)
// wrap their unchanged bodies with these. For a caller nothing restricts on the
// dataset, the body runs as it always did. For a restricted caller:
//
//   - the refusals (data/rowAccess.rowLockFor: fan-out, export, as-of, derived,
//     column, pipeline, no entitlement), and here: a question that reaches a
//     related dataset (a column a relationship supplies, labels from another
//     dataset, a saved metric measure), and a drivers tile (it anchors "latest"
//     on the whole period column);
//   - else the lock FIRST in the filter list — after sanitization, before the
//     Live split and the answer-cache key — filter steps only, prepended unless
//     the list already starts with it; the body runs in the lock scope of this
//     one dataset, which is what lets the storage net (data/rowAccess.gateRows)
//     hand its reads through.

import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import type { Lock } from '../data/rowLock';
import { RowPolicyError, isRowPolicyError, rowLockFor, rowPolicyRefusal, withLockSteps, withRowLock } from '../data/rowAccess';
import type { RowPolicyReason } from '../data/rowAccess';
import { hasMetricMeasure } from '../analysis/metricMeasures';
import type { VizEncoding } from '../analysis/visuals';
import { relatedColumnNames } from './relationships';

/** Every string a question names (encoding, filters, a metric spec): the columns it may reach. */
function namesIn(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) namesIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) namesIn(x, out);
  return out;
}

/** Does the question reach another dataset? Conservative: any name a relationship would supply counts. */
async function reachesOther(projectId: string, datasetId: string, encoding: VizEncoding | null, rest: unknown): Promise<boolean> {
  if (encoding && (hasMetricMeasure(encoding) || [encoding.categoryDatasetId, encoding.seriesDatasetId].some((o) => !!o && o !== datasetId))) return true;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const own = new Set((meta?.columns ?? []).map((c) => c.name));
  const foreign = [...namesIn([encoding, rest])].filter((n) => !own.has(n));
  if (!foreign.length) return false;
  const related = new Set(await relatedColumnNames(projectId, datasetId));
  return foreign.some((n) => related.has(n));
}

type Refusal = ReturnType<typeof rowPolicyRefusal>;

/** The lock, or the refusal as a reply (a chart door answers `{ok:false}`; it never throws a figure's failure). */
async function lockOrRefusal(projectId: string, datasetId: string): Promise<Lock | null | Refusal> {
  try {
    return await rowLockFor(projectId, datasetId);
  } catch (err) {
    if (isRowPolicyError(err)) return rowPolicyRefusal(err.reason);
    throw err;
  }
}

const isRefusal = (x: unknown): x is Refusal => !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === false;

/** `vizDataFor` under the rules: the body as before, or locked, or a typed refusal reply. */
export async function lockedViz<O extends { sample?: boolean }, R>(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  opts: O,
  body: (projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[], opts: O) => Promise<R>,
): Promise<R | Refusal> {
  const lock = await lockOrRefusal(projectId, datasetId);
  if (isRefusal(lock)) return lock;
  if (!lock) return body(projectId, datasetId, encoding, filters, opts);
  if (encoding && encoding.drivers) return rowPolicyRefusal('reader');
  if (await reachesOther(projectId, datasetId, encoding, filters)) return rowPolicyRefusal('related');
  // The builder's sample is drawn over the whole table and reports its size: never under a lock.
  return withRowLock(datasetId, () => body(projectId, datasetId, encoding, withLockSteps(lock, filters), { ...opts, sample: false }));
}

/** `computeCardMetric` under the rules: a refusal THROWS, as a Live KPI's failure does (an ok:false reads as "dataset gone"). */
export async function lockedMetric<S extends { column: string }, P, R>(
  projectId: string,
  datasetId: string,
  spec: S,
  filters: FilterStep[],
  params: P,
  body: (projectId: string, datasetId: string, spec: S, filters: FilterStep[], params: P) => Promise<R>,
): Promise<R> {
  const lock = await rowLockFor(projectId, datasetId);
  if (!lock) return body(projectId, datasetId, spec, filters, params);
  if (await reachesOther(projectId, datasetId, null, [spec.column, filters])) throw new RowPolicyError('related');
  return withRowLock(datasetId, () => body(projectId, datasetId, spec, withLockSteps(lock, filters), params));
}

/** Any door whose body takes the lock itself (an answer card, the grid page): the lock, in its scope. */
export async function withLockOf<R>(projectId: string, datasetId: string, body: (lock: Lock | null) => Promise<R>): Promise<R> {
  const lock = await rowLockFor(projectId, datasetId);
  return lock ? withRowLock(datasetId, () => body(lock)) : body(null);
}

/** A hydrated table folded through the lock FIRST, so every helper after it sees entitled rows only. */
export function lockedTable<T extends { columns: datasets.Dataset['columns']; rows: datasets.Dataset['rows'] }>(ds: T, lock: Lock | null): T {
  if (!lock) return ds;
  const t = applyPipeline({ columns: ds.columns, rows: ds.rows }, [...lock.steps]);
  return { ...ds, rows: t.rows, rowCount: t.rows.length, source: undefined };
}

/** A typed refusal for a reader that is not a door (the explicit checks). */
export function refuseRows(reason: RowPolicyReason): never {
  throw new RowPolicyError(reason);
}
