// "Sync schema" — re-read a Live dataset's columns from its warehouse and
// profile them from one sampled query (docs/live-data/00-plan.md L2.5) — MAIN
// PROCESS ONLY. Started as a job (./schemaSyncJob.ts): on create, on demand
// (`dataset:syncLiveSchema`) and daily (the scheduler's tick).
//
//   1. COLUMNS. The catalog for a table, a one-row run of the defining query
//      otherwise — exactly as the dataset was created (ipc/liveDatasets
//      `readLiveSchema`), declared types and the warehouse's own type names.
//      A failure here changes nothing and says so (a catalog sentence; the
//      warehouse's words go to the server log only, R-L6).
//   2. THE SAMPLE. One statement per table (./profileSql.ts) through the same
//      seams as every live question (./liveQuery `runStatement`): the daily
//      limit, a concurrency slot, the timeout, cancel, `costTag 'live'`, the
//      usage count. A connector that can price a statement (BigQuery) is asked
//      first, and the sample is skipped when the estimate passes
//      LIVE_MAX_BYTES_BILLED. ClickHouse is asked whether the table has a
//      sampling key. A sample that is refused, fails or is skipped is
//      reported, typed, and the last sync's figures are kept — the columns
//      still sync.
//   3. MISSING COLUMNS. A column gone from the warehouse leaves the declared
//      columns (so nothing compiles it), and its name is kept in
//      `live.missingColumns` while a chart, a KPI, a metric or an alert still
//      names it (analysis/liveDependents): those are refused as "column
//      missing" (./liveMissing) instead of failing oddly.
//   4. ONE WRITE. Columns, profile, missing list and `schemaSyncedAt` land in
//      one read-modify-write of the record (data/liveDataset
//      `writeSchemaSync`). `schemaSyncedAt` is part of every live cache key,
//      so a sync retires every cached answer by itself.
//
// Afterwards the sampled values go past the sensitivity detector (a Live
// dataset's only chance to be proposed for review), and a change of columns is
// announced, so an open dashboard redraws its tiles against the new schema.

import * as datasets from '../../data/datasets';
import type { ParsedColumn } from '../../data/parse';
import { isLive, writeSchemaSync } from '../../data/liveDataset';
import type { LiveColumnProfile, LiveProfile, SampleSkip } from '../../data/liveProfile';
import { PROFILE_MAX_COLUMNS, sampleMatrix } from '../../data/liveProfile';
import type { DeclaredColumn } from '../../data/liveSchema';
import { announceRefreshed } from '../../data/refreshEvents';
import { scanDataset } from '../../app/privacyStore';
import { missingDependents } from '../../analysis/liveDependents';
import { estimateLive } from '../../connectors/liveRun';
import { safeError } from '../../connectors/types';
import { readLiveSchema } from '../../ipc/liveDatasets';
import { loadInput } from '../../ipc/lineage';
import { liveQueryTimeoutMs, maxBytesBilled } from '../../server/env';
import * as queryCache from '../queryCache';
import * as trace from '../residentTrace';
import * as msg from '../liveProfileMessages';
import * as qmsg from '../liveQueryMessages';
import type { CompileEnv } from './compile';
import type { SamplePlan } from './dialect';
import type { LiveFailureCode } from './liveQuery';
import { LiveCallError, runStatement } from './liveQuery';
import type { LiveTarget } from './liveTarget';
import { liveTarget } from './liveTarget';
import type { ProfileFigures } from './profileSql';
import { compileProfile, compileSamplingKeyProbe, samplePercent, sampleRowsFor, samples, shapeProfile } from './profileSql';

/** Why the sample was not read — typed as a live question's failure is. `error` is a catalog sentence. */
export interface SampleFailure {
  ok: false;
  code: LiveFailureCode;
  /** `tooCostly` (the estimate), the budget's `dailyLimit`, or a compiler refusal code. */
  reason?: string;
  error: string;
  /** `tooCostly`: the estimate, in bytes. */
  bytes?: number;
}

export type SampleOutcome = { ok: true; rows: number; method: 'sample' | 'limit' } | SampleFailure;

export interface SyncReport {
  ok: true;
  schemaSyncedAt: string;
  /** Declared columns after the sync. */
  columns: number;
  added: string[];
  removed: string[];
  retyped: string[];
  /** Columns gone from the warehouse that something still names. */
  missing: string[];
  sample: SampleOutcome;
}

export type SyncReply = SyncReport | { ok: false; code: string; error: string; reason?: string };

const opOf = (t: LiveTarget): string => `liveSync:${t.dialect}`;

/** LIVE_QUERY_TIMEOUT_MS for the estimate (the statements take it inside runStatement). */
function timeoutMs(): number {
  try {
    return liveQueryTimeoutMs(process.env.LIVE_QUERY_TIMEOUT_MS);
  } catch {
    return liveQueryTimeoutMs(undefined);
  }
}

/**
 * What one live query may bill, and so what the sample's estimate may say:
 * LIVE_MAX_BYTES_BILLED, or the connection's own lower ceiling where it has one
 * (BigQuery's "Max bytes billed per query" — the connector refuses a run past it).
 */
function bytesCap(values: Record<string, unknown>): number {
  let cap: number;
  try {
    cap = maxBytesBilled(process.env.LIVE_MAX_BYTES_BILLED);
  } catch {
    cap = maxBytesBilled(undefined);
  }
  const own = Number(values.maxBytesBilled);
  return Number.isSafeInteger(own) && own > 0 ? Math.min(cap, own) : cap;
}

/** A warehouse call that did not answer → the typed failure (the call already logged its reason). */
function callFailure(t: LiveTarget, err: unknown): SampleFailure {
  const e = err instanceof LiveCallError ? err : new LiveCallError('failed', safeError(err));
  const op = opOf(t);
  switch (e.kind) {
    case 'daily':
      trace.recordLive(op, 'refused');
      return { ok: false, code: 'live_refused', reason: 'dailyLimit', error: e.detail };
    case 'tooLarge':
      trace.recordLive(op, 'refused');
      return { ok: false, code: 'live_refused', reason: 'tooManyGroups', error: msg.liveSampleRefused() };
    case 'cancelled':
      trace.recordLive(op, 'cancelled');
      return { ok: false, code: 'live_cancelled', error: qmsg.liveCancelled() };
    case 'timeout':
      trace.recordLive(op, 'failed', 'timeout');
      return { ok: false, code: 'live_timeout', error: msg.liveSampleFailed() };
    default:
      if (!(err instanceof LiveCallError)) console.warn(`[live] ${op} dataset ${t.datasetId}: failed — ${e.detail}`);
      trace.recordLive(op, 'failed', 'warehouse error');
      return { ok: false, code: 'live_failed', error: msg.liveSampleFailed() };
  }
}

/**
 * One profile statement under `plan`: compiled, priced where the connector
 * can (the dry run is free; past the cap the sample is skipped), then run.
 * Throws what the run throws (`LiveCallError`).
 */
async function attempt(t: LiveTarget, env: CompileEnv, plan: SamplePlan, signal: AbortSignal): Promise<{ figures: ProfileFigures } | { outcome: SampleFailure }> {
  const compiled = compileProfile(env, plan);
  if (!compiled.ok) {
    trace.recordLive(opOf(t), 'refused');
    return { outcome: { ok: false, code: 'live_refused', reason: compiled.code, error: compiled.message } };
  }
  const est = await estimateLive(t.def, t.values, await t.secrets(), compiled.query.sql, compiled.query.params, { signal, timeoutMs: timeoutMs() });
  if (est && !est.ok) {
    console.warn(`[live] ${opOf(t)} dataset ${t.datasetId}: estimate failed — ${est.error}`);
    trace.recordLive(opOf(t), 'failed', 'estimate');
    return { outcome: { ok: false, code: 'live_failed', error: msg.liveSampleFailed() } };
  }
  if (est && est.bytes > bytesCap(t.values)) {
    trace.recordLive(opOf(t), 'refused');
    return { outcome: { ok: false, code: 'live_refused', reason: 'tooCostly', error: msg.liveSampleTooCostly(), bytes: est.bytes } };
  }
  const figures = shapeProfile(await runStatement(t, compiled.query, signal), env.columns);
  if (!figures) {
    trace.recordLive(opOf(t), 'refused');
    return { outcome: { ok: false, code: 'live_refused', reason: 'rowShape', error: msg.liveSampleRefused() } };
  }
  return { figures };
}

/**
 * Read the profile sample: the ClickHouse probe, then one statement (priced
 * first where the connector can). Never throws; a sample not read is a typed
 * outcome.
 *
 * ONE SECOND TRY, without the sample clause (LIMIT only — through the same
 * estimate gate, so a table too large to read that way is skipped, typed),
 * in exactly two cases:
 *   - the warehouse REFUSED the sampled statement (an error, not a timeout, a
 *     cancel or a limit): an engine may take its sample clause on a base table
 *     only (BigQuery's TABLESAMPLE), and a "table" can be a view;
 *   - a BLOCK sample came back EMPTY: BigQuery's TABLESAMPLE SYSTEM picks
 *     whole storage blocks, so on a table of few blocks a small percent often
 *     picks none although the catalog counts rows — never stored as "every
 *     column empty".
 */
async function sampleProfile(
  t: LiveTarget,
  columns: DeclaredColumn[],
  rowEstimate: number | undefined,
  signal: AbortSignal,
): Promise<{ outcome: SampleOutcome; figures?: ProfileFigures }> {
  const cols = columns.slice(0, PROFILE_MAX_COLUMNS).map((c) => ({ name: c.name, type: c.type, sourceType: c.sourceType }));
  const env: CompileEnv = { dialect: t.dialect, source: t.source, columns: cols };
  let plan: SamplePlan = { rows: sampleRowsFor(cols.length) };
  try {
    if (t.source.kind === 'table') {
      const percent = samplePercent(plan.rows, rowEstimate);
      if (percent !== undefined) plan.percent = percent;
      const probe = compileSamplingKeyProbe(env);
      if (probe && !probe.ok) return { outcome: { ok: false, code: 'live_refused', reason: probe.code, error: probe.message } };
      if (probe) {
        const key = (await runStatement(t, probe.query, signal))[0]?.[0];
        plan.samplingKey = typeof key === 'string' && key.trim() !== '';
      }
    }
    const limitOnly: SamplePlan = { rows: plan.rows, limitOnly: true };
    let got: Awaited<ReturnType<typeof attempt>>;
    try {
      got = await attempt(t, env, plan, signal);
    } catch (err: unknown) {
      if (!(err instanceof LiveCallError) || err.kind !== 'failed' || !samples(env, plan)) throw err;
      plan = limitOnly; // the engine refused its own sample clause here (logged where it failed)
      got = await attempt(t, env, plan, signal);
    }
    if ('figures' in got && got.figures.rows === 0 && plan.percent !== undefined) {
      plan = limitOnly; // the block sample missed every block
      got = await attempt(t, env, plan, signal);
    }
    if (!('figures' in got)) return got;
    trace.recordLive(opOf(t), 'warehouse');
    return { outcome: { ok: true, rows: got.figures.rows, method: samples(env, plan) ? 'sample' : 'limit' }, figures: got.figures };
  } catch (err: unknown) {
    return { outcome: callFailure(t, err) };
  }
}

function skipOf(f: SampleFailure): SampleSkip {
  if (f.reason === 'tooCostly') return 'tooCostly';
  return f.code === 'live_refused' ? 'refused' : 'failed';
}

/**
 * The profile to store: this sample's figures, or — when none was read — the
 * last sync's, kept for every column still declared with the same type, and
 * marked `skipped`. The warehouse's type names are always this sync's.
 */
function nextProfile(
  columns: DeclaredColumn[],
  sampled: { outcome: SampleOutcome; figures?: ProfileFigures },
  prev: LiveProfile | undefined,
  before: ParsedColumn[],
  now: string,
): LiveProfile {
  const typed = (c: LiveColumnProfile, d: DeclaredColumn): LiveColumnProfile => {
    if (d.sourceType) c.sourceType = d.sourceType;
    else delete c.sourceType;
    return c;
  };
  if (sampled.outcome.ok && sampled.figures) {
    const byName = new Map(sampled.figures.columns.map((f) => [f.name, f]));
    return {
      sampledAt: now,
      sampleRows: sampled.figures.rows,
      method: sampled.outcome.method,
      columns: columns.map((d) => {
        const f = byName.get(d.name);
        const c: LiveColumnProfile = { name: d.name };
        if (f) {
          Object.assign(c, { filled: f.filled, distinct: f.distinct });
          if (f.values && f.counts) Object.assign(c, { values: f.values, counts: f.counts });
        }
        return typed(c, d);
      }),
    };
  }
  const was = new Map(before.map((c) => [c.name, c.type]));
  const old = new Map((prev?.columns ?? []).map((c) => [c.name, c]));
  const out: LiveProfile = {
    columns: columns.map((d) => {
      const p = old.get(d.name);
      return typed(p && was.get(d.name) === d.type ? { ...p } : { name: d.name }, d);
    }),
  };
  if (!sampled.outcome.ok) out.skipped = skipOf(sampled.outcome);
  if (prev?.sampledAt) out.sampledAt = prev.sampledAt;
  if (prev?.sampleRows !== undefined) out.sampleRows = prev.sampleRows;
  if (prev?.method) out.method = prev.method;
  return out;
}

/** What changed between the stored columns and the warehouse's. */
function diffColumns(before: ParsedColumn[], after: ParsedColumn[]): { added: string[]; removed: string[]; retyped: string[] } {
  const was = new Map(before.map((c) => [c.name, c.type]));
  const now = new Map(after.map((c) => [c.name, c.type]));
  return {
    added: after.filter((c) => !was.has(c.name)).map((c) => c.name),
    removed: before.filter((c) => !now.has(c.name)).map((c) => c.name),
    retyped: after.filter((c) => was.has(c.name) && was.get(c.name) !== c.type).map((c) => c.name),
  };
}

/** Sync one Live dataset's schema and profile. Call it through ./schemaSyncJob (one at a time per dataset). Never throws. */
export async function syncLiveSchema(projectId: string, datasetId: string, signal: AbortSignal = new AbortController().signal): Promise<SyncReply> {
  const found = await liveTarget(projectId, datasetId);
  if (!found.ok) {
    return found.kind === 'unavailable'
      ? { ok: false, code: 'live_unavailable', error: found.error }
      : { ok: false, code: 'live_refused', reason: found.refusal.code, error: found.refusal.message };
  }
  const t = found.target;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const origin = meta?.origin;
  if (!meta || !isLive(meta) || !meta.live || origin?.kind !== 'connection') return { ok: false, code: 'live_unavailable', error: qmsg.liveNotLive() };

  // 1. The columns, as the dataset was created.
  const read = await readLiveSchema(projectId, origin.connId, origin.sql && origin.sql.trim() ? { query: origin.sql } : { table: origin.table });
  if (!read.ok) {
    console.warn(`[live] ${opOf(t)} dataset ${datasetId}: describe failed — ${safeError(read.error)}`);
    return { ok: false, code: 'live_failed', error: msg.liveSyncReadFailed() };
  }
  const next = read.columns;
  const diff = diffColumns(meta.columns, next);

  // 2. The sample.
  const sampled = await sampleProfile(t, next, read.rowEstimate, signal);
  if (signal.aborted) return { ok: false, code: 'live_cancelled', error: qmsg.liveCancelled() };
  const now = new Date().toISOString();
  const profile = nextProfile(next, sampled, meta.live.profile, meta.columns, now);

  // 3. Columns gone from the warehouse that something still names.
  const gone = [...new Set([...(meta.live.missingColumns ?? []), ...diff.removed])].filter((n) => !next.some((c) => c.name === n));
  const missing = gone.length ? missingDependents(await loadInput(projectId), datasetId, gone).map((m) => m.column) : [];

  // 4. One write; the cache key moves with it.
  const changed = diff.added.length + diff.removed.length + diff.retyped.length > 0;
  if (!(await writeSchemaSync(projectId, datasetId, { columns: next, profile, missingColumns: missing, syncedAt: now, changed }))) {
    return { ok: false, code: 'live_unavailable', error: qmsg.liveNotLive() };
  }
  queryCache.invalidateDataset(datasetId, projectId);
  const declared: ParsedColumn[] = next.map((c) => ({ name: c.name, type: c.type }));
  await scanDataset(projectId, { id: datasetId, columns: declared, rows: sampleMatrix(declared, profile) });
  if (changed) announceRefreshed({ projectId, datasetId, name: meta.name, rowsBefore: 0, rowsAfter: 0 });
  return { ok: true, schemaSyncedAt: now, columns: next.length, ...diff, missing, sample: sampled.outcome };
}
