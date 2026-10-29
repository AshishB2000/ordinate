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
import { RowPolicyError, closedToCaller, gateRows, inFanOut, isRowPolicyError, restrictedOn, rowLockFor, rowPolicyRefusal, withLockSteps, withRowLock } from '../data/rowAccess';
import type { RowPolicyReason } from '../data/rowAccess';
import { hasMetricMeasure } from '../analysis/metricMeasures';
import * as visuals from '../analysis/visuals';
import type { VizEncoding, VizOverrides } from '../analysis/visuals';
import { measureNames } from '../analysis/chartFormat';
import { figureAsk, type FigureAsk } from '../analysis/figureAsk';
import type { DriversEncoding } from '../analysis/driverScope';
import { contentTag } from '../app/editConflict';
import type { SaveKind } from '../analysis/recordDiff';
import { isValidId } from '../app/ids';
import { chartReads, metricReads, relatedColumnNames } from './relationships';

/** Every string a question names (encoding, filters, a metric spec): the columns it may reach. */
function namesIn(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === 'string') out.add(v);
  else if (Array.isArray(v)) for (const x of v) namesIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) namesIn(x, out);
  return out;
}

/** The datasets the question names by id: its category's, its series', its measures' — other than its own. */
function namedDatasets(datasetId: string, encoding: VizEncoding | null): string[] {
  if (!encoding) return [];
  const ids = [encoding.categoryDatasetId, encoding.seriesDatasetId, ...(Array.isArray(encoding.values) ? encoding.values.map((v) => v && v.datasetId) : [])];
  return [...new Set(ids.filter((o): o is string => typeof o === 'string' && !!o && o !== datasetId))];
}

/** Does the question reach another dataset? Conservative: any name a relationship would supply counts. */
async function reachesOther(projectId: string, datasetId: string, encoding: VizEncoding | null, rest: unknown): Promise<boolean> {
  if ((encoding && hasMetricMeasure(encoding)) || namedDatasets(datasetId, encoding).length) return true;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const own = new Set((meta?.columns ?? []).map((c) => c.name));
  const foreign = [...namesIn([encoding, rest])].filter((n) => !own.has(n));
  if (!foreign.length) return false;
  const related = new Set(await relatedColumnNames(projectId, datasetId));
  return foreign.some((n) => related.has(n));
}

// Test seam: the related-dataset gate's negative control turns it off (scripts/test-rowPolicyLabels).
let relatedGate = true;
export function setRelatedGateForTest(on: boolean): void {
  relatedGate = on;
}

/**
 * B1: a restricted caller whose question READS another dataset that is closed to them. Asked when nothing
 * restricts them on the base dataset, BEFORE the body and its answer cache: that cache is keyed by the base
 * dataset and the question alone, so an editor's answer joined over a dataset with rules would otherwise be
 * handed to them. `reads` is exactly what the body reads — the datasets named by id and the join plan's
 * tables (./relationships chartReads / metricReads) — so a star schema whose other dimensions are open
 * still answers (C1). The refusal's reason, or null.
 *
 * Inside a fan-out build (a publish, an embed) it gates EVERY caller, editors included, and records each read
 * through the storage net (gateRows): on a cache hit the body never reaches that net, so the related dataset
 * would be neither refused nor recorded, and /p/ would keep serving once it gained rules (D10).
 */
async function relatedClosed(projectId: string, datasetId: string, reads: () => Promise<string[]>): Promise<RowPolicyReason | null> {
  if (!relatedGate) return null;
  const fanout = inFanOut();
  if (!fanout && !(await restrictedOn(projectId))) return null;
  for (const id of new Set(await reads())) {
    if (id === datasetId) continue;
    const why = fanout ? await netRefusal(projectId, id) : (await closedToCaller(projectId, id)) ? 'related' : null;
    if (why) return why;
  }
  return null;
}

/** The storage net on `id`: records the read in the fan-out scope; its refusal (the build is marked refused too), or null. */
async function netRefusal(projectId: string, id: string): Promise<RowPolicyReason | null> {
  try {
    await gateRows(projectId, id);
    return null;
  } catch (err) {
    if (isRowPolicyError(err)) return err.reason;
    throw err;
  }
}

/** What a chart's question reads besides its own dataset. */
const chartReadsOf = (projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[]) => async (): Promise<string[]> =>
  [...namedDatasets(datasetId, encoding), ...(await chartReads(projectId, datasetId, encoding, filters))];

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
  if (!lock) {
    const why = await relatedClosed(projectId, datasetId, chartReadsOf(projectId, datasetId, encoding, filters));
    if (why) return rowPolicyRefusal(why);
    return body(projectId, datasetId, encoding, filters, opts);
  }
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
  if (!lock) {
    const why = await relatedClosed(projectId, datasetId, () => metricReads(projectId, datasetId, spec.column, filters));
    if (why) throw new RowPolicyError(why);
    return body(projectId, datasetId, spec, filters, params);
  }
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


/** What a visual-shaped record carries that row access rules care about. */
interface VisualLike {
  datasetId?: unknown;
  encoding?: unknown;
  overrides?: object;
}

/**
 * The record without what names values from rows: the custom order, the series colours and the waterfall
 * totals (category labels), the drivers' path values and a bucket compare's labels. A dual axis keeps only
 * the names of the visual's own measures — `validateDualAxis` (analysis/chartFormat) allows no others, so
 * they are exactly the series names any locked result of this encoding carries; a raw record (a version)
 * can hold anything. Funnel steps stay: they are the definition the server runs (R19(a), authored).
 */
function withoutLabels<T extends VisualLike>(v: T): T {
  const out: VisualLike = { ...v };
  if (v.overrides) {
    const { sortOrder: _order, seriesColors: _colors, waterfallTotals: _totals, y2Series, ...overrides } = v.overrides as VizOverrides;
    const measures = new Set(measureNames(v.encoding as VizEncoding | undefined));
    const y2 = Array.isArray(y2Series) ? y2Series.filter((n) => measures.has(n)) : [];
    out.overrides = y2.length ? { ...overrides, y2Series: y2 } : overrides;
  }
  const enc = v.encoding as (VizEncoding & { drivers?: DriversEncoding }) | undefined;
  if (enc && enc.drivers) {
    const c = enc.drivers.compare;
    out.encoding = { ...enc, drivers: { ...enc.drivers, path: [], compare: c && c.mode === 'bucket' ? { ...c, label: '', prev: '' } : c } };
  }
  return out as T;
}

/**
 * A visual as a restricted caller gets it (round 2 #12, R19): on a dataset with rules — or one they cannot
 * name (a version of a deleted visual), or reaching a related dataset closed to them (B1) — without the
 * labels `withoutLabels` drops. CEILING: that caller
 * sees the default order and colours; the waterfall still marks its totals, which the server fills from the
 * stored record (`storedFigureAsk`). Every other caller gets the record unchanged (the same object).
 */
export async function visualForCaller<T extends VisualLike | null>(projectId: string, v: T): Promise<T> {
  if (!v || !(await restrictedOn(projectId))) return v;
  const ds = typeof v.datasetId === 'string' && v.datasetId ? v.datasetId : null;
  const filters = (v as { filters?: unknown }).filters;
  const closed = !ds || (await closedToCaller(projectId, ds))
    || (!!v.encoding && !!(await relatedClosed(projectId, ds, chartReadsOf(projectId, ds, v.encoding as VizEncoding, Array.isArray(filters) ? (filters as FilterStep[]) : []))));
  return closed ? withoutLabels(v) : v;
}

/**
 * A record's edit tag as the caller gets it. The stored tag hashes the bytes as stored (app/editConflict),
 * so it would confirm a guessed label that was not sent; a restricted caller cannot write, so theirs is
 * the tag of what they were sent.
 */
export async function tagForCaller(projectId: string, kind: SaveKind, sent: unknown, stored: string): Promise<string> {
  return (await restrictedOn(projectId)) ? contentTag(kind, sent) : stored;
}

/**
 * A chart request's figure ask (analysis/figureAsk). A waterfall request that names its saved visual
 * (`visualId`) and carries no totals gets the STORED ones — a restricted caller is no longer sent them
 * (`visualForCaller`). Only a visual of this project and this dataset counts. The totals mark only labels
 * already in the reply (analysis/chartShapes), so nothing from another team's rows leaves.
 */
export async function storedFigureAsk(projectId: string, datasetId: string, drawnAs: Record<string, unknown>): Promise<FigureAsk | null> {
  const ask = figureAsk(drawnAs.chartType, drawnAs);
  const id = drawnAs.visualId;
  if (!ask || ask.chartType !== 'waterfall' || ask.waterfallTotals || typeof id !== 'string' || !isValidId(id)) return ask;
  const v = await visuals.getVisual(projectId, id);
  const totals = v && v.datasetId === datasetId ? v.overrides.waterfallTotals : undefined;
  return totals && totals.length ? { ...ask, waterfallTotals: totals } : ask;
}

/** `visual:get`'s reply as the caller gets it: `visualForCaller`, and the tag of what was sent. */
export async function visualReplyForCaller<T extends (VisualLike & { tag: string }) | null>(projectId: string, rec: T): Promise<T> {
  const sent = await visualForCaller(projectId, rec);
  return sent ? { ...sent, tag: await tagForCaller(projectId, 'visual', sent, sent.tag) } : sent;
}

/** A dashboard record's inline `card.visual` definitions (vestigial, still stored by `sanitizeCard`) through `visualForCaller`. */
export async function dashboardForCaller<T>(projectId: string, rec: T): Promise<T> {
  const sheets = (rec as { sheets?: unknown } | null)?.sheets;
  if (!Array.isArray(sheets) || !(await restrictedOn(projectId))) return rec;
  const out = [];
  for (const sheet of sheets as Array<{ cards?: unknown }>) {
    const cards = Array.isArray(sheet?.cards) ? (sheet.cards as Array<{ visual?: VisualLike }>) : null;
    if (!cards) { out.push(sheet); continue; }
    const mapped = [];
    for (const c of cards) mapped.push(c && c.visual ? { ...c, visual: await visualForCaller(projectId, c.visual) } : c);
    out.push({ ...sheet, cards: mapped });
  }
  return { ...(rec as object), sheets: out } as T;
}
