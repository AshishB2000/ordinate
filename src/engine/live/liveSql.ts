// SQL on Live datasets, F3: THE EXECUTOR (docs/live-data/01-live-sql.md F-D9…F-D14) — MAIN PROCESS ONLY.
//
//   text ─► the column gate on every table ─► DuckDB's parse ─► translate (./sql/tree) ─► DuckDB's binder over
//   empty typed views ─► per table read: liveTarget + withLockOf, ONE connection ─► print (./sql/print) ─► cache
//   ─► one flight ─► BigQuery's dry run ─► warehouse() ─► rows by position
//
// The model's DuckDB SQL never reaches a warehouse: the translator's IR does, printed per dialect with each table
// read through its view CTE (./sql/view: the caller's lock, the base filters, the calcs, only the columns read).
//
//   one connection   every table Live, every one on the same connection (F-D9), none answered by a semantic layer;
//   the gate         `withLockOf` on every table the second call was given, before anything is parsed: rules that
//                    cannot be applied refuse whole (F-D10). The vocabulary the translator resolves against holds the
//                    VISIBLE columns only, so `SELECT *` is what the caller may see and a hidden column is never in a
//                    view. A statement that reads a hidden column (a reference the translator resolves over every
//                    declared column, not a word: `sum()` is no reference to a column named `sum`) gets the column
//                    gate's `hidden`, as a chart naming it does;
//   the binder       DuckDB binds the statement over empty views typed as the Live views are (numbers DOUBLE, dates
//                    DATE, text VARCHAR): what DuckDB would not bind (a column neither grouped nor aggregated) is
//                    refused before any warehouse reads it. No row exists to read;
//   the locks        each table read takes `withLockOf(…, the columns read from it)`, nested, so the statement is
//                    printed and asked inside every one; its lock's values are bound parameters, so two entitlements
//                    are two statements and two cache entries (row-policy D12);
//   a required date  a table whose source doc requires a filter on a date column (../liveDateRange, as a chart):
//                    where neither its lock, its base filters nor any WHERE of the statement names that column, its
//                    view gets REQUIRED_RANGE, and the reply says so (`notes`);
//   the cache        orgKey('livesql' · project · connection · [dataset, epoch, schemaSyncedAt] per table · the
//                    printed SQL · its params), aged by the lowest maxCacheAgeSec of the tables read (F-D12); an
//                    expired entry is the stale fallback, labelled `asOf.stale`;
//   one flight       identical statements asked together share one warehouse call (./liveFlight);
//   the dry run      where the connector prices a statement (BigQuery), free and uncounted, first: past
//                    `liveBytesCap` nothing is sent, in a sentence with both sizes (F-D11);
//   warehouse()      the one door (./liveWarehouse): the slot, the daily limit that counts it, the SSRF guard, the
//                    timeout, `costTag 'live'`. ONE counted statement per answer; a cache hit none.
//
// SQL_PER_HOUR (30 Live SQL answers per member per connection, across pods, ../../server/counters) is taken by the
// lane BEFORE the model writes a statement (`takeSqlHour`), so a refusal costs no model call and no statement.
//
// `checkLiveSql` (F4, the Verified page's check of a verified Live SQL question) takes every step up to the print, under
// the same locks, and stops there: no cache, no flight, no dry run, no warehouse call.
//
// The printed SQL names the warehouse's tables (or an editor's defining query): it never leaves the server (F-D13).
// A failure is a catalog sentence; the warehouse's own words go to the log, through safeError (R-L6).

import type { AsOf } from '../../api/asOf';
import type { ColumnType, ParsedColumn } from '../../data/parse';
import type { Cell } from '../../data/transforms';
import type { Lock } from '../../data/rowLock';
import * as datasets from '../../data/datasets';
import { isRowPolicyError } from '../../data/rowAccess';
import { estimateLabel } from '../../connectors/bigqueryShape';
import { estimateLive, liveBytesCap } from '../../connectors/liveRun';
import { safeError } from '../../connectors/types';
import { MAX_SQL_TEXT } from '../../ai/answerSql';
import { ctx, orgKey } from '../../server/context';
import * as counters from '../../server/counters';
import { utcDay } from '../../server/live/usageStore';
import { withLockOf } from '../../ipc/rowDoors';
import * as duck from '../duckdb';
import { foldKey, quoteIdent } from '../datasetView';
import { cleanDuckError, stripSemicolons } from '../sqlDatasets';
import * as queryCache from '../queryCache';
import * as trace from '../residentTrace';
import * as qmsg from '../liveQueryMessages';
import * as msg from '../liveSqlMessages';
import * as budget from './liveBudget';
import { fly } from './liveFlight';
import { missingRefusal } from './liveMissing';
import type { LiveFailureCode } from './liveQuery';
import type { CompiledQuery } from './sqlParams';
import type { LiveRows } from './shape';
import { liveTarget, type LiveTarget } from './liveTarget';
import { LiveCallError, dialectOf, failed, opOf, timeoutMs, warehouse } from './liveWarehouse';
import type { LiveSqlIR, Ty } from './sql/ir';
import { LIVE_SQL_ROWS, printLiveSql } from './sql/print';
import { whereColumns, type ViewInput } from './sql/view';
import { requiredRange } from './liveDateRange';
import { parseSql, translate, type SqlEnv, type SqlRefusal } from './sql/tree';
import { seesSourceNames } from '../../data/sourceNames';

/** Live SQL answers one member may have from one connection in an hour (open question 1: a guess, not a measurement). */
export const SQL_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

/** Why there is no table: a catalog sentence. `code` for a Live failure; none for the row rules' own refusal. */
export type LiveSqlFailure = { ok: false; error: string; code?: LiveFailureCode };

/** The result table, positional to the statement's outputs, dated (`asOf`), and the datasets it read, in the IR's order. */
/** `notes`: what the card says beside it (a required date range the view was given, ./liveDateRange). */
export type LiveSqlReply = { ok: true; columns: ParsedColumn[]; rows: Cell[][]; truncated: boolean; deps: string[]; asOf: AsOf; notes?: string[] } | LiveSqlFailure;

/** One dataset the statement may name: its record id, and the names the second call was given (the slug, the exact name). */
export interface LiveSqlTable {
  id: string;
  names: string[];
}

/** One cached answer: the rows as the card shows them, and when the warehouse gave them. */
interface Answered {
  rows: Cell[][];
  at: string;
}

const refused = (op: string, error: string, code: LiveFailureCode = 'live_refused'): LiveSqlFailure => {
  trace.recordLive(op, 'refused');
  return { ok: false, code, error };
};

/** Each dataset's target: all Live, all on ONE connection (F-D9), none a semantic layer's; or why not. */
async function targetsOf(projectId: string, ids: readonly string[]): Promise<Map<string, LiveTarget> | LiveSqlFailure> {
  const out = new Map<string, LiveTarget>();
  for (const id of ids) {
    const found = await liveTarget(projectId, id);
    if (!found.ok) return found.kind === 'refused' ? refused(opOf(found.dialect), found.refusal.message) : refused(opOf(found.dialect), found.error, 'live_unavailable');
    const t = found.target;
    if (t.semantic) return refused(opOf(dialectOf(t)), msg.sqlOnLayer());
    const first = out.values().next().value;
    if (first && first.connectionId !== t.connectionId) return refused(opOf(t.dialect), msg.sqlTwoConnections());
    out.set(id, t);
  }
  return out;
}

/** The row rules' fail-closed refusals on every table (F-D10): each one's hidden columns, or the gate's sentence. */
async function gated(projectId: string, ids: readonly string[]): Promise<Map<string, ReadonlySet<string>> | LiveSqlFailure> {
  const out = new Map<string, ReadonlySet<string>>();
  try {
    for (const id of ids) out.set(id, await withLockOf(projectId, id, async (_lock, hidden) => hidden));
  } catch (err) {
    if (isRowPolicyError(err)) return { ok: false, error: err.message };
    throw err;
  }
  return out;
}

/** Why the caller cannot ask these Live datasets with SQL (one connection, the gate), said before a model call is spent on it; or null. */
export async function liveSqlClosed(projectId: string, ids: readonly string[]): Promise<string | null> {
  const targets = await targetsOf(projectId, ids);
  if (!(targets instanceof Map)) return targets.error;
  const g = await gated(projectId, ids);
  return g instanceof Map ? null : g.error;
}

/** One of the caller's SQL_PER_HOUR Live SQL answers on the datasets' connection, taken across pods; a sentence when none is left. */
export async function takeSqlHour(projectId: string, ids: readonly string[]): Promise<string | null> {
  const origin = (await datasets.getDatasetMeta(projectId, ids[0]))?.origin;
  const conn = origin && origin.kind === 'connection' ? origin.connId : '';
  const c = ctx();
  const r = await counters.take(c.org.id, [{ key: `livesql:${conn}:${c.user.email}`, limit: SQL_PER_HOUR, windowMs: HOUR_MS }]);
  return r.ok ? null : msg.sqlPerHour(SQL_PER_HOUR.toLocaleString('en-US'), Math.ceil(r.retryAfterSec / 60).toLocaleString('en-US'));
}

const DUCK_TYPE: Record<ColumnType, string> = { number: 'DOUBLE', date: 'DATE', text: 'VARCHAR' };

/** DuckDB's binder over the statement, each table an EMPTY view typed as its Live view is: its refusal, or null. Reads nothing. */
async function unbound(text: string, env: SqlEnv): Promise<string | null> {
  const views = [...env.tables].map(([name, t]) => {
    const cols = t.columns.map((c) => `CAST(NULL AS ${DUCK_TYPE[c.type]}) AS ${quoteIdent(c.name)}`);
    return `${quoteIdent(name)} AS (SELECT ${cols.length ? cols.join(', ') : 'NULL AS _'} WHERE false)`;
  });
  try {
    // The text was parsed whole by DuckDB and passed the translator (one SELECT, only these tables, only allowed functions).
    await duck.queryAsync(`DESCRIBE WITH ${views.join(', ')} SELECT * FROM (\n${stripSemicolons(text)}\n) AS _q`);
    return null;
  } catch (err) {
    return msg.sqlBindError(cleanDuckError(err));
  }
}

/**
 * The statement `text` (the model's DuckDB SQL, or a turn's) for the caller over `tables` (its whole vocabulary: a
 * name outside it is no table), asked of their warehouse: the result table, or why not, in a sentence.
 */
export async function runLiveSql(projectId: string, text: string, tables: readonly LiveSqlTable[]): Promise<LiveSqlReply> {
  const p = await prepared(projectId, text, tables);
  if (!('ir' in p)) return p;
  try {
    return await underLocks(projectId, p.ir, 0, [], (locks) => ask(projectId, p.ir, p.views, locks));
  } catch (err) {
    if (isRowPolicyError(err)) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Why `text` would not run for the caller over `tables`, or null: every step of `runLiveSql` up to the print, under
 * each table's lock, and NO warehouse call (F4: the Verified page's check of a Live SQL question).
 */
export async function checkLiveSql(projectId: string, text: string, tables: readonly LiveSqlTable[]): Promise<LiveSqlFailure | null> {
  const p = await prepared(projectId, text, tables);
  if (!('ir' in p)) return p;
  try {
    return await underLocks(projectId, p.ir, 0, [], async (locks) => {
      const given = inputsOf(p.ir, p.views, locks);
      if ('refusal' in given) return refused(opOf(p.views[0].dialect), given.refusal);
      const printed = printLiveSql(p.ir, given.inputs, p.views[0].dialect);
      return printed.ok ? null : refused(opOf(p.views[0].dialect), printed.message);
    });
  } catch (err) {
    if (isRowPolicyError(err)) return { ok: false, error: err.message };
    throw err;
  }
}

/** Targets, the gate, parse, translate, bind and the dropped columns: the IR and each table read's target, or why not. Sends nothing. */
async function prepared(projectId: string, text: string, tables: readonly LiveSqlTable[]): Promise<{ ir: LiveSqlIR; views: LiveTarget[] } | LiveSqlFailure> {
  if (text.length > MAX_SQL_TEXT) return refused(opOf(undefined), msg.sqlTooLong(MAX_SQL_TEXT.toLocaleString('en-US')));
  const ids = tables.map((t) => t.id);
  const targets = await targetsOf(projectId, ids);
  if (!(targets instanceof Map)) return targets;
  const op = opOf([...targets.values()][0]?.dialect);
  const hidden = await gated(projectId, ids); // rules that cannot apply refuse whole; the columns named are the IR's, below
  if (!(hidden instanceof Map)) return hidden;
  const envOver = (shown: (id: string, column: string) => boolean): SqlEnv => ({
    tables: new Map(tables.flatMap((tb) => {
      const columns = targets.get(tb.id)!.columns.filter((c) => shown(tb.id, c.name));
      return tb.names.map((n) => [foldKey(n), { id: tb.id, columns }] as const);
    })),
    today: utcDay(), // F-D4: the UTC day, as the warehouse's session and the reference read it
  });
  const env = envOver((id, c) => !hidden.get(id)!.has(c));
  const tree = await parseSql(text);
  const tr = translate(tree, env);
  if (!tr.ok) {
    const gate = await hiddenRead(projectId, tree, hidden, envOver);
    return gate ? { ok: false, error: gate } : refused(op, await sentenceOf(projectId, tr)); // the gate's: no code, the caller's access (F4)
  }
  const bind = await unbound(text, env);
  if (bind) return refused(op, bind);
  const ir = tr.ir;
  const views = ir.views.map((v) => targets.get(v.id)!);
  for (const [i, v] of ir.views.entries()) {
    const gone = missingRefusal(views[i].live.missingColumns, v.columns); // a column the schema sync found dropped (L2.5)
    if (gone) return refused(op, gone.message);
  }
  return { ir, views };
}

/**
 * The column gate's own sentence when the refused statement reads a column hidden from the caller, else null. It is
 * translated again over every declared column, and the columns THAT IR reads from each table are the gate's question
 * (F-D10), as a chart's are: only references the translator resolves count (bare, qualified, aliased or through a `*`),
 * so a hidden column named `sum` never refuses `sum()`. Nothing of the second IR is printed or sent.
 */
async function hiddenRead(projectId: string, tree: unknown, hidden: ReadonlyMap<string, ReadonlySet<string>>, envOver: (shown: (id: string, column: string) => boolean) => SqlEnv): Promise<string | null> {
  if (![...hidden.values()].some((h) => h.size)) return null;
  const all = translate(tree, envOver(() => true));
  if (!all.ok) return null;
  try {
    for (const v of all.ir.views) await withLockOf(projectId, v.id, async () => null, v.columns);
  } catch (err) {
    if (isRowPolicyError(err)) return err.message;
    throw err;
  }
  return null;
}

/**
 * The translator's sentence for the caller. A table name outside their vocabulary is told to a viewer without it (F6):
 * a warehouse name, its schema or an ungiven table's label is never echoed back, whoever wrote it.
 */
async function sentenceOf(projectId: string, r: SqlRefusal): Promise<string> {
  return (r.code === 'table' || r.code === 'qualified') && !(await seesSourceNames(projectId)) ? msg.sqlUnknownName() : r.message;
}

/** Every table read under its own lock (F-D10), nested: `body` runs inside all of them with their locks, in `ir.views` order. */
function underLocks<R>(projectId: string, ir: LiveSqlIR, i: number, locks: ReadonlyArray<Lock | null>, body: (locks: ReadonlyArray<Lock | null>) => Promise<R>): Promise<R> {
  if (i === ir.views.length) return body(locks);
  return withLockOf(projectId, ir.views[i].id, (lock) => underLocks(projectId, ir, i + 1, [...locks, lock], body), ir.views[i].columns);
}

/** The lowest cache age of the tables read, never under the request's floor; kept for the public floor (as ./liveQuery `agesOf`). */
function agesOf(views: readonly LiveTarget[]): { lookupMs: number; keepMs: number } {
  const sec = Math.min(...views.map((v) => v.live.maxCacheAgeSec));
  return { lookupMs: Math.max(sec, budget.cacheAgeFloorSec()) * 1000, keepMs: Math.max(sec, budget.publicFloorSec()) * 1000 };
}

/**
 * Each table read as its view input: its lock, and REQUIRED_RANGE (./liveDateRange) on each date column its table
 * requires a filter on that neither the lock, the base filters nor the statement's WHERE restricts by bound values
 * (./sql/view `whereColumns`: not a join condition, not an OR with an unrestricted branch) — a chart question's
 * rule, with its sentence. The range is printed, so it is in the cache key and moves at midnight.
 */
function inputsOf(ir: LiveSqlIR, views: readonly LiveTarget[], locks: ReadonlyArray<Lock | null>): { inputs: ViewInput[]; notes: string[] } | { refusal: string } {
  const named = whereColumns(ir);
  const notes = new Set<string>();
  const inputs: ViewInput[] = [];
  for (const [i, v] of views.entries()) {
    const lock = locks[i]?.steps ?? [];
    // The partition time too (./liveDateRange): a base filter, so on the table scan; a required column with no default refuses.
    const r = requiredRange(v, [...(v.env.base ?? []).map((f) => f.column), ...lock.map((s) => s.column), ...named[i]]);
    if (!r.ok) return { refusal: r.message };
    r.notes.forEach((n) => notes.add(n));
    inputs.push({ env: r.filters.length ? { ...v.env, base: [...(v.env.base ?? []), ...r.filters] } : v.env, lock });
  }
  return { inputs, notes: [...notes] };
}

/** The statement under the caller's locks, with the sentence of any required date range it was given. */
async function ask(projectId: string, ir: LiveSqlIR, views: readonly LiveTarget[], locks: ReadonlyArray<Lock | null>): Promise<LiveSqlReply> {
  const given = inputsOf(ir, views, locks);
  if ('refusal' in given) return refused(opOf(views[0].dialect), given.refusal);
  const { inputs, notes } = given;
  const r = await asked(projectId, ir, views, inputs);
  return r.ok && notes.length ? { ...r, notes } : r;
}

/** Print, then cache → one flight → the dry run → warehouse() (F-D11, F-D12). */
async function asked(projectId: string, ir: LiveSqlIR, views: readonly LiveTarget[], inputs: readonly ViewInput[]): Promise<LiveSqlReply> {
  const t = views[0];
  const op = opOf(t.dialect);
  const printed = printLiveSql(ir, inputs, t.dialect);
  if (!printed.ok) return refused(op, printed.message);
  const q = printed.query;
  const key = orgKey(['livesql', projectId, t.connectionId, ...views.flatMap((v) => [v.datasetId, String(v.live.epoch), v.live.schemaSyncedAt]), q.sql, queryCache.stableStringify(q.params)].join('\u0000'));
  const ages = agesOf(views);
  const hit = queryCache.get<Answered>('live', key, { maxAgeMs: ages.lookupMs });
  if (hit) {
    trace.recordLive(op, 'hit');
    return reply(ir, hit.rows, { at: hit.at, mode: 'live', cached: true });
  }
  const signal = ctx().signal;
  try {
    const { value, owner } = await fly(key, signal, (shared) => fetched(t, ir, q, key, ages.keepMs, shared));
    if ('refusal' in value) return refused(op, value.refusal);
    trace.recordLive(op, owner ? 'warehouse' : 'hit');
    return reply(ir, value.rows, { at: value.at, mode: 'live' });
  } catch (err) {
    return fellBack(t, ir, key, err, signal);
  }
}

/** The flight's body: priced first where the connector can (free, uncounted), then ONE statement through the one door, cached. */
async function fetched(t: LiveTarget, ir: LiveSqlIR, q: CompiledQuery, key: string, keepMs: number, shared: AbortSignal): Promise<Answered | { refusal: string }> {
  try {
    if (typeof t.def.live?.estimate === 'function') {
      const est = await estimateLive(t.def, t.values, await t.secrets(), q.sql, q.params, { signal: shared, timeoutMs: timeoutMs() });
      if (est && !est.ok) throw failed(t, 'failed', `the dry run: ${est.error}`); // never run blind
      const cap = liveBytesCap(t.values);
      if (est && est.bytes > cap) return { refusal: msg.sqlTooCostly(estimateLabel(est.bytes).slice(1), estimateLabel(cap).slice(1)) };
    }
    const v: Answered = { rows: cells(ir, await warehouse(t, q, shared)), at: new Date(queryCache.now()).toISOString() };
    queryCache.set(key, v, [...new Set(ir.views.map((x) => x.id))], { maxAgeMs: keepMs });
    return v;
  } catch (err) {
    throw err instanceof LiveCallError ? err : failed(t, 'failed', safeError(err));
  }
}

/** A failed ask → the stale table, or the typed failure (as ./liveQuery `fallBack`). Never an empty table. */
function fellBack(t: LiveTarget, ir: LiveSqlIR, key: string, err: unknown, signal: AbortSignal | undefined): LiveSqlReply {
  const op = opOf(t.dialect);
  const e = err instanceof LiveCallError ? err : new LiveCallError('failed', safeError(err));
  if (e.kind === 'cancelled' || signal?.aborted) {
    trace.recordLive(op, 'cancelled');
    return { ok: false, code: 'live_cancelled', error: qmsg.liveCancelled() };
  }
  const stale = queryCache.peek<Answered>(key);
  if (stale) {
    trace.recordLive(op, 'stale');
    return reply(ir, stale.value.rows, { at: stale.value.at, mode: 'live', cached: true, stale: true });
  }
  if (e.kind === 'daily') return refused(op, e.detail);
  trace.recordLive(op, 'failed', e.kind === 'timeout' ? 'timeout' : 'warehouse error');
  return e.kind === 'timeout'
    ? { ok: false, code: 'live_timeout', error: qmsg.liveWarehouseTimeout((timeoutMs() / 1000).toLocaleString('en-US')) }
    : { ok: false, code: 'live_failed', error: qmsg.liveWarehouseFailed() };
}

const KIND: Record<Ty, ColumnType> = { number: 'number', date: 'date', ts: 'date', text: 'text', bool: 'text' };

/** The warehouse's rows by position, as the card shows them: a number finite or NULL, −0 as 0 (pin R4); a date is ISO text already (F-D7). */
function cells(ir: LiveSqlIR, raw: LiveRows): Cell[][] {
  const kinds = ir.main.items.map((it) => KIND[it.ty]);
  return raw.map((r) => kinds.map((k, i) => {
    const v = r[i];
    if (v === null || v === undefined) return null;
    if (k !== 'number') return String(v);
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n + 0 : null; // n + 0 turns −0 into 0
  }));
}

/** The table: `ir.names` as its columns, at most LIVE_SQL_ROWS rows (fetched as one more, so "more" is known). */
function reply(ir: LiveSqlIR, rows: Cell[][], asOf: AsOf): LiveSqlReply {
  const columns = ir.names.map((name, i) => ({ name, type: KIND[ir.main.items[i].ty] }));
  const truncated = rows.length > LIVE_SQL_ROWS;
  return { ok: true, columns, rows: truncated ? rows.slice(0, LIVE_SQL_ROWS) : rows, truncated, deps: ir.views.map((v) => v.id), asOf };
}
