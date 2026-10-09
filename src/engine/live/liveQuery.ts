// The live executor — MAIN PROCESS ONLY. docs/live-data/00-plan.md L2.3 (§4, D5–D9).
//
//   question ─► adapt (./liveSpec) ─► cache? ─► warehouse() ─► shape (./evaluate)
//
// `warehouse()` (./liveWarehouse, re-exported here) is the one door every Live
// statement goes through: a LIVE_MAX_CONCURRENT slot, the daily limit that
// counts it (L2.7), then connector.live.runBound.
//
// Three entry points, one per door L2.4 routes. Each takes exactly what its
// door has today and answers what the extract twin answers, plus `asOf`
// ({at: when the warehouse answered, mode: 'live', cached?, stale?}):
//
//   liveVizData(projectId, datasetId, encoding, filters)   ← vizDataFor (charts, publish, export)
//   liveMetric(projectId, datasetId, spec, filters)        ← metricFor / computeCardMetric (KPI tiles)
//   liveAnswer(projectId, spec)                            ← computeCard (AI answers)
//   liveLookup(projectId, datasetId, build)                ← computeCard's case fix (L2.4)
//
// THE CACHE (D5) is queryCache with an age, one entry per question:
//   orgKey('live' · projectId · datasetId · epoch · schemaSyncedAt · {ir, source, dialect})
// The epoch lives in the record, so "Refresh" moves every pod's key at once;
// `maxCacheAgeSec` is the entry's age, read at every lookup (0 = always ask);
// inside a published /p/ page's request it is never under
// LIVE_MIN_CACHE_AGE_PUBLIC_SEC (L2.7, `agesOf`).
// The period resolver's MAX() is cached the same way under its own statement,
// so every answer over one date column shares one.
//
// ONE CALL PER QUESTION. Identical questions asked together share one warehouse
// call — a "flight" (./liveFlight.ts) — always, even at age 0. A shared call is
// cancelled only when EVERY asker has hung up: one closed tab must not fail the
// tile another viewer is waiting on. An asker that hangs up stops waiting at once.
//
// NEVER AN EMPTY RESULT (D6, D7). Live has no JS fallback. When the warehouse
// fails, the last answer this pod cached for the question is served however
// old, labelled `asOf.stale`; with none, a typed error in a catalog sentence.
// The warehouse's own words go to the server log (secrets redacted by
// safeError), never into a reply: they can quote the SQL, a table or a host (R-L6).
//
// Every question is counted on residentTrace as `live:<dialect>` — hit,
// warehouse, stale, refused, failed or cancelled — and so on /metrics.

import type { AsOf } from '../../api/asOf';
import type { AnswerSpec } from '../../ai/answerSpec';
import { specFilterSteps } from '../../ai/answerSpec';
import type { VizEncoding } from '../../analysis/visuals';
import type { ChartData } from '../../analysis/vizData';
import { recommendChartType } from '../../analysis/vizData';
import type { CategoryInfo } from '../../analysis/categoryKey';
import type { FilterStep } from '../../data/transforms';
import { LIVE_ROW_LIMIT } from '../../connectors/liveRun';
import { safeError } from '../../connectors/types';
import { ctx, orgKey, runInContext } from '../../server/context';
import * as queryCache from '../queryCache';
import * as trace from '../residentTrace';
import * as msg from '../liveQueryMessages';
import * as budget from './liveBudget';
import type { Compiled, CompiledQuery } from './compile';
import type { LiveOutcome, LiveRunner, PeriodRange } from './evaluate';
import { evaluateLive } from './evaluate';
import { fly } from './liveFlight';
import type { AdaptOpts, LiveAdapted, LiveIR, LiveRefusal, LiveRefusalCode } from './liveSpec';
import { fromAnswerSpec, fromMetric, fromVizEncoding, refuse } from './liveSpec';
import type { LiveRows } from './shape';
import type { LiveTarget, TargetProblem } from './liveTarget';
import { liveTarget } from './liveTarget';
import { answerNames, encodingNames, metricNames, missingRefusal } from './liveMissing';
import { failed, LiveCallError, opOf, timeoutMs, warehouse } from './liveWarehouse';

// The one door every Live statement goes through (./liveWarehouse.ts): L2.4's
// lookups and L2.5's profile send theirs through it too, never runLiveBound.
export { LiveCallError, warehouse } from './liveWarehouse';
export type { CallKind } from './liveWarehouse';

// ── Replies ──────────────────────────────────────────────────────────────────

export type LiveFailureCode = 'live_refused' | 'live_unavailable' | 'live_failed' | 'live_timeout' | 'live_cancelled';

/** Why a Live question has no figure. `error` is a catalog sentence: safe for a browser. */
export interface LiveFailure {
  ok: false;
  code: LiveFailureCode;
  error: string;
  /** For `live_refused`: the compiler's refusal code, or the executor's own. */
  reason?: LiveRefusalCode | 'tooManyGroups' | 'dailyLimit' | 'asOf' | 'fx';
}

/** `vizDataFor`'s success shape, dated. */
export type LiveVizReply =
  | { ok: true; data: ChartData; recommendedShape: string; warnings: string[]; category: CategoryInfo; asOf: AsOf }
  | LiveFailure;

/** `computeCardMetric`'s number, dated. */
export type LiveMetricReply = { ok: true; value: number | null; warnings: string[]; asOf: AsOf } | LiveFailure;

/**
 * What `computeCard` builds a card from: the ranked, cut chart (do NOT rank it
 * again), its notes (warnings + the "Other" note, as the card shows them) and
 * the period labels ("order_date: 2024-Q4").
 */
export type LiveAnswerReply =
  | { ok: true; data: ChartData; category: CategoryInfo; warnings: string[]; notes: string[]; filterLabels: string[]; periodRanges: PeriodRange[]; asOf: AsOf }
  | LiveFailure;

/** A lookup's rows (positional to its statement's columns), dated. */
export type LiveLookupReply = { ok: true; rows: LiveRows; asOf: AsOf } | LiveFailure;

type LiveOk = Extract<LiveOutcome, { ok: true }>;

/** One cached answer: the shaped outcome and when the warehouse gave it (its oldest statement). */
interface Answered {
  outcome: LiveOk;
  at: string;
}

type Asked = { ok: true; outcome: LiveOk; asOf: AsOf } | LiveFailure;

// ── Failures ─────────────────────────────────────────────────────────────────

function fail(code: LiveFailureCode, error: string, reason?: LiveFailure['reason']): LiveFailure {
  return reason ? { ok: false, code, error, reason } : { ok: false, code, error };
}

function refused(dialect: string | undefined, r: LiveRefusal): LiveFailure {
  trace.recordLive(opOf(dialect), 'refused');
  return fail('live_refused', r.message, r.code);
}

function unavailable(p: TargetProblem): LiveFailure {
  if (p.kind === 'refused') return refused(p.dialect, p.refusal);
  trace.recordLive(opOf(p.dialect), 'refused');
  return fail('live_unavailable', p.error);
}

/** Test hook: flights in the air (the suite checks none is left behind). */
export { askersInAir, flightsInAir } from './liveFlight';

// ── One question ─────────────────────────────────────────────────────────────

function keyOf(t: LiveTarget, spec: unknown): string {
  return orgKey(['live', t.projectId, t.datasetId, String(t.live.epoch), t.live.schemaSyncedAt, queryCache.stableStringify(spec)].join('\u0000'));
}

/**
 * `lookupMs`: how old an answer THIS asker accepts — the dataset's cache age,
 * never under the request's floor (a /p/ page's, L2.7). `keepMs`, on the
 * entry: the oldest ANY asker accepts, so an answer fetched at age 0 still
 * serves a public page for the floor's length (the tighter of the two wins).
 */
interface Ages {
  lookupMs: number;
  keepMs: number;
}

function agesOf(t: LiveTarget): Ages {
  return {
    lookupMs: Math.max(t.live.maxCacheAgeSec, budget.cacheAgeFloorSec()) * 1000,
    keepMs: Math.max(t.live.maxCacheAgeSec, budget.publicFloorSec()) * 1000,
  };
}

/** The period resolver's MAX(): cached and shared under its own statement. */
async function latest(t: LiveTarget, query: CompiledQuery, ages: Ages, shared: AbortSignal, seen: (ms: number) => void): Promise<LiveRows> {
  const key = keyOf(t, { latest: query.sql, params: query.params });
  const hit = queryCache.get<{ rows: LiveRows; at: number }>('live', key, { maxAgeMs: ages.lookupMs });
  if (hit) {
    seen(hit.at);
    return hit.rows;
  }
  const { value } = await fly(key, shared, async (s) => {
    const rows = await warehouse(t, query, s);
    const v = { rows, at: queryCache.now() };
    queryCache.set(key, v, [t.datasetId], { maxAgeMs: ages.keepMs });
    return v;
  });
  seen(value.at);
  return value.rows;
}

/** Ask the warehouse (the flight's body): every statement, then cache a real answer. */
async function answer(t: LiveTarget, ir: LiveIR, key: string, ages: Ages, shared: AbortSignal): Promise<{ outcome: LiveOutcome; at: string }> {
  let oldest = Infinity;
  const seen = (ms: number): void => {
    if (ms < oldest) oldest = ms;
  };
  const run: LiveRunner = async (query, step) => {
    if (step === 'latest') return latest(t, query, ages, shared, seen);
    const rows = await warehouse(t, query, shared);
    seen(queryCache.now());
    return rows;
  };
  let outcome: LiveOutcome;
  try {
    // In the asker's context but under the SHARED signal: anything below that
    // reads the request's signal (the DuckDB pool, a connector's fallback)
    // stops when every asker has gone, not when the first one does.
    const c = ctx();
    outcome = await runInContext(c, c.requestId, () => evaluateLive(ir, t.env, run), c.client, shared);
  } catch (err: unknown) {
    // A LiveCallError was logged where it happened; anything else is unexpected, and logged once here.
    throw err instanceof LiveCallError ? err : failed(t, 'failed', safeError(err));
  }
  // A figure is as old as its oldest statement (a cached MAX() included).
  const at = new Date(Number.isFinite(oldest) ? oldest : queryCache.now()).toISOString();
  if (outcome.ok) queryCache.set(key, { outcome, at } satisfies Answered, [t.datasetId], { maxAgeMs: ages.keepMs });
  return { outcome, at };
}

/** A failed ask → the stale answer, or the typed failure. Never an empty result. */
function fallBack(t: LiveTarget, key: string, err: unknown, signal: AbortSignal | undefined): Asked {
  const op = opOf(t.dialect);
  const e = err instanceof LiveCallError ? err : new LiveCallError('failed', safeError(err));
  if (e.kind === 'cancelled' || signal?.aborted) {
    trace.recordLive(op, 'cancelled');
    return fail('live_cancelled', msg.liveCancelled());
  }
  if (e.kind === 'tooLarge') {
    trace.recordLive(op, 'refused');
    return fail('live_refused', msg.liveTooManyGroups(LIVE_ROW_LIMIT.toLocaleString('en-US')), 'tooManyGroups');
  }
  const stale = queryCache.peek<Answered>(key);
  if (stale) {
    trace.recordLive(op, 'stale');
    return { ok: true, outcome: stale.value.outcome, asOf: { at: stale.value.at, mode: 'live', cached: true, stale: true } };
  }
  if (e.kind === 'daily') {
    trace.recordLive(op, 'refused');
    return fail('live_refused', e.detail, 'dailyLimit');
  }
  trace.recordLive(op, 'failed', e.kind === 'timeout' ? 'timeout' : 'warehouse error');
  return e.kind === 'timeout'
    ? fail('live_timeout', msg.liveWarehouseTimeout((timeoutMs() / 1000).toLocaleString('en-US')))
    : fail('live_failed', msg.liveWarehouseFailed());
}

/** Cache → flight → warehouse → shape, for one adapted question. */
async function ask(t: LiveTarget, ir: LiveIR): Promise<Asked> {
  const op = opOf(t.dialect);
  const key = keyOf(t, { ir, source: t.source, dialect: t.dialect });
  const ages = agesOf(t);
  const fresh = queryCache.get<Answered>('live', key, { maxAgeMs: ages.lookupMs });
  if (fresh) {
    trace.recordLive(op, 'hit');
    return { ok: true, outcome: fresh.outcome, asOf: { at: fresh.at, mode: 'live', cached: true } };
  }
  const signal = ctx().signal;
  let asked: { value: { outcome: LiveOutcome; at: string }; owner: boolean };
  try {
    asked = await fly(key, signal, (shared) => answer(t, ir, key, ages, shared));
  } catch (err: unknown) {
    return fallBack(t, key, err, signal);
  }
  const { outcome, at } = asked.value;
  if (!outcome.ok) return refused(t.dialect, outcome);
  // An asker who joined a flight already in the air made no warehouse call of its own.
  trace.recordLive(op, asked.owner ? 'warehouse' : 'hit');
  return { ok: true, outcome, asOf: { at, mode: 'live' } };
}

/** Resolve the target, adapt, ask: the part every door shares. `names`: the columns the question reads. */
async function run(projectId: string, datasetId: string, names: string[], adapt: (t: LiveTarget) => LiveAdapted): Promise<{ asked: Asked; warnings: string[]; t: LiveTarget } | LiveFailure> {
  const found = await liveTarget(projectId, datasetId);
  if (!found.ok) return unavailable(found);
  const t = found.target;
  // A column the warehouse dropped (L2.5) is said as exactly that, before the adapter could skip or misname it.
  const gone = missingRefusal(t.live.missingColumns, names);
  if (gone) return refused(t.dialect, gone);
  const a = adapt(t);
  if (!a.ok) return refused(t.dialect, a);
  return { asked: await ask(t, a.ir), warnings: a.warnings, t };
}

// ── The three doors ──────────────────────────────────────────────────────────

/** A chart: `vizDataFor`'s question on a Live dataset. */
export async function liveVizData(projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[], opts: AdaptOpts = {}): Promise<LiveVizReply> {
  const r = await run(projectId, datasetId, encodingNames(encoding, filters), (t) => fromVizEncoding(encoding, filters, t.columns, opts));
  if (!('asked' in r)) return r;
  if (!r.asked.ok) return r.asked;
  const o = r.asked.outcome;
  if (o.kind !== 'chart') return refused(r.t.dialect, refuse('badQuery'));
  return {
    ok: true,
    data: o.chart.data,
    recommendedShape: recommendChartType(r.t.columns, encoding).shape,
    warnings: r.warnings.concat(o.warnings),
    category: o.chart.category,
    asOf: r.asked.asOf,
  };
}

/** One KPI number: `metricFor`'s question on a Live dataset. */
export async function liveMetric(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: string },
  filters: FilterStep[],
  opts: AdaptOpts = {},
): Promise<LiveMetricReply> {
  const r = await run(projectId, datasetId, metricNames(spec, filters), (t) => fromMetric(spec, filters, t.columns, opts));
  if (!('asked' in r)) return r;
  if (!r.asked.ok) return r.asked;
  const o = r.asked.outcome;
  if (o.kind !== 'metric') return refused(r.t.dialect, refuse('badQuery'));
  return { ok: true, value: o.value, warnings: r.warnings.concat(o.warnings), asOf: r.asked.asOf };
}

/** An AI answer's chart: `computeCard`'s question on a Live dataset — ranked and cut in the warehouse. */
export async function liveAnswer(projectId: string, spec: AnswerSpec, opts: AdaptOpts = {}): Promise<LiveAnswerReply> {
  const r = await run(projectId, spec && spec.datasetId, answerNames(spec), (t) => fromAnswerSpec(spec, t.columns, opts));
  if (!('asked' in r)) return r;
  if (!r.asked.ok) return r.asked;
  const o = r.asked.outcome;
  if (o.kind !== 'chart') return refused(r.t.dialect, refuse('badQuery'));
  const warnings = r.warnings.concat(o.warnings);
  const notes = o.chart.category.note ? warnings.concat(o.chart.category.note) : warnings.slice();
  return {
    ok: true,
    data: o.chart.data,
    category: o.chart.category,
    warnings,
    notes,
    filterLabels: answerFilterLabels(spec, r.t.columns, o.periodLabels),
    periodRanges: o.periodRanges ?? [],
    asOf: r.asked.asOf,
  };
}

/**
 * One lookup statement the compiler builds from the target — not a chart: the
 * answers' case fix (L2.4). Cached and shared like the period MAX() (same key
 * rules, same ages — looked up at `lookupMs`, kept for `keepMs` — one flight),
 * sent through the one door (./liveWarehouse `warehouse`), and a failure is the last rows cached for it,
 * labelled stale, or a typed error — never an empty list that looks like "no match".
 */
export async function liveLookup(projectId: string, datasetId: string, build: (t: LiveTarget) => Compiled): Promise<LiveLookupReply> {
  const found = await liveTarget(projectId, datasetId);
  if (!found.ok) return unavailable(found);
  const t = found.target;
  const c = build(t);
  if (!c.ok) return refused(t.dialect, c);
  const op = opOf(t.dialect);
  const key = keyOf(t, { lookup: c.query.sql, params: c.query.params });
  const ages = agesOf(t);
  const at = (ms: number): string => new Date(ms).toISOString();
  const hit = queryCache.get<{ rows: LiveRows; at: number }>('live', key, { maxAgeMs: ages.lookupMs });
  if (hit) {
    trace.recordLive(op, 'hit');
    return { ok: true, rows: hit.rows, asOf: { at: at(hit.at), mode: 'live', cached: true } };
  }
  const signal = ctx().signal;
  try {
    const { value, owner } = await fly(key, signal, async (shared) => {
      const v = { rows: await warehouse(t, c.query, shared), at: queryCache.now() };
      queryCache.set(key, v, [t.datasetId], { maxAgeMs: ages.keepMs });
      return v;
    });
    trace.recordLive(op, owner ? 'warehouse' : 'hit');
    return { ok: true, rows: value.rows, asOf: { at: at(value.at), mode: 'live' } };
  } catch (err: unknown) {
    // Stale rows exactly where `fallBack` would serve a stale answer: never for a hang-up or an oversized result.
    const e = err instanceof LiveCallError ? err : null;
    const stale = signal?.aborted || e?.kind === 'cancelled' || e?.kind === 'tooLarge' ? undefined : queryCache.peek<{ rows: LiveRows; at: number }>(key);
    if (stale) {
      trace.recordLive(op, 'stale');
      return { ok: true, rows: stale.value.rows, asOf: { at: at(stale.value.at), mode: 'live', cached: true, stale: true } };
    }
    // Nothing under this key (just peeked), so fallBack can only answer the typed failure.
    const r = fallBack(t, key, err, signal);
    return r.ok ? fail('live_failed', msg.liveWarehouseFailed()) : r;
  }
}

/**
 * The card's filter labels in spec order, as `specFilterSteps` writes them: a
 * period's ("order_date: 2024-Q4", resolved against the warehouse's latest
 * date — ./evaluate's `periodLabels`, in period order) or the filter's own
 * ("region = North", from `specFilterSteps` itself, which reads no row for one).
 */
function answerFilterLabels(spec: AnswerSpec, columns: LiveTarget['columns'], periodLabels: string[]): string[] {
  const periods = periodLabels.slice();
  const out: string[] = [];
  for (const f of spec.filters || []) {
    if (!columns.some((c) => c.name === f.column)) continue;
    if ('period' in f) {
      const l = periods.shift();
      if (l !== undefined) out.push(l);
    } else {
      out.push(...specFilterSteps({ filters: [f] }, columns, []).labels);
    }
  }
  return out;
}

// ── One statement, for the schema sync ───────────────────────────────────────

/**
 * Send one compiled statement through exactly the seams a question takes — a
 * concurrency slot, the daily limit that counts it (L2.7), the timeout, the
 * shared signal, `costTag 'live'`, the billed bytes — without the question
 * cache: the schema sync's profile, sample and probes (L2.5). It IS
 * `warehouse()` (./liveWarehouse, the one door). Rows positional to
 * `query.columns`; throws `LiveCallError` (its `kind` says why), logged once
 * where it happened.
 */
export function runStatement(t: LiveTarget, query: CompiledQuery, signal: AbortSignal): Promise<LiveRows> {
  return warehouse(t, query, signal);
}
