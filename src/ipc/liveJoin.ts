// A Live chart across saved relationships (docs/live-data/00-plan.md L4, "Joins across datasets") — MAIN PROCESS ONLY.
//
// `liveChart` (./liveRoute) asks here first. The plan is the copy's: analysis/joinPlan `resolveVizJoin` over the
// project's relationships and every dataset's METADATA (./relationships `vizJoin`; nothing is hydrated), so the hops
// walk many → one only, a reverse hop is refused in the copy's own sentence, and the merged names are the copy's.
// A measure on a related table is counted once per related row per group (joinJs rule 3, engine/live/compileJoin's
// mask). What only a copy can do is said, typed `live_refused` (reason `related`), never computed: a related dataset
// that is a copy, or Live on another connection — no one engine holds both tables (`liveJoinMixed`, `liveJoinApart`;
// the link card's words for the same case are ai/sourceAnswerMessages').
// A KPI across links (`liveMetricJoinOf`, ./liveRoute liveCardMetric) is planned as a copy's (./relationships
// `metricJoin`, analysis/joinPlan planMetricJoin) and asked the same way (`liveJoinedKpi`).
// Otherwise the executor (engine/live/liveQuery `liveJoinedVizData`) asks ONE statement of the primary's warehouse,
// under the caller's row lock on each related table (`withLockOf`, nested, as ipc/linkLive takes it). The door before
// this (./rowDoors lockedViz) has already refused a locked caller whose question reaches another dataset, and a
// related dataset closed to the caller — as for a copy; the lock here is the one any reader of rows takes itself.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import { isLive } from '../data/liveDataset';
import type { FilterStep } from '../data/transforms';
import type { Lock } from '../data/rowLock';
import { isRowPolicyError, rowPolicyRefusal } from '../data/rowPolicyError';
import { TermNotExpandedError, termRefusal } from '../data/termStep';
import { termNoJoinHere } from '../data/termMessages';
import type { VizEncoding } from '../analysis/visuals';
import type { DsInfo, JoinLayout, JoinPlan } from '../analysis/joinPlan';
import { liveJoinedMetric, liveJoinedVizData } from '../engine/live/liveQuery';
import type { LiveFailure, LiveMetricReply } from '../engine/live/liveQuery';
import type { LiveJoinRequest } from '../engine/live/liveJoin';
import { encodingNames } from '../engine/live/liveMissing';
import * as msg from '../engine/liveRefusals';
import { metricJoin, vizJoin } from './relationships';
import { withLockOf } from './rowDoors';
import type { VizDataReply } from './visuals';

const connOf = (m: DatasetMeta): string => (m.origin?.kind === 'connection' ? m.origin.connId : '');

const related = (error: string): LiveFailure => ({ ok: false, code: 'live_refused', error, reason: 'related' });

/** Why `other` cannot be read beside the Live `primary` in one statement (its sentence), or null: Live on the same connection. */
export function joinBlocked(primary: DatasetMeta, other: DatasetMeta): string | null {
  if (!isLive(other)) return msg.liveJoinMixed(primary.name, other.name);
  return connOf(other) && connOf(other) === connOf(primary) ? null : msg.liveJoinApart(primary.name, other.name);
}

/** A planned Live join: the executor's request, every lock still to take. */
export type LiveJoinPlan = { ok: true; req: Omit<LiveJoinRequest, 'tables'> & { tables: Omit<LiveJoinRequest['tables'][number], 'lock'>[] } } | { ok: false; reply: VizDataReply };

/** The join a Live chart needs, or its refusal; null when it needs none (every field and filter is the dataset's own). */
export async function liveJoinOf(projectId: string, meta: DatasetMeta, encoding: VizEncoding, filters: FilterStep[]): Promise<LiveJoinPlan | null> {
  if (meta.live?.semantic) return null; // a layer's chart refuses any join, in its own words (./semanticFigures)
  const vj = await vizJoin(projectId, meta.id, encoding, filters);
  if (!vj) return null;
  if (!vj.join.ok) {
    const e = vj.join.error;
    return { ok: false, reply: e === termNoJoinHere() ? termRefusal(new TermNotExpandedError('unreachable', e)) : related(e) };
  }
  const { plan, layout } = vj.join.value;
  const why = await blockedIn(projectId, meta, plan);
  if (why) return { ok: false, reply: related(why) };
  return { ok: true, req: { ...layoutOf(vj.infos, plan, layout), encoding: vj.join.value.encoding, filters: vj.join.value.filters } };
}

/** The first table of `plan` no one statement can read beside the Live `meta` (its sentence), or null. */
async function blockedIn(projectId: string, meta: DatasetMeta, plan: JoinPlan): Promise<string | null> {
  for (const id of new Set(plan.tables.slice(1).map((t) => t.datasetId))) {
    const other = id === meta.id ? meta : await datasets.getDatasetMeta(projectId, id);
    const why = other ? joinBlocked(meta, other) : null; // gone since the plan read it: the executor says so
    if (why) return why;
  }
  return null;
}

/** The executor's tables and merged layout for a planned join (analysis/joinPlan). */
function layoutOf(infos: Map<string, DsInfo>, plan: JoinPlan, layout: JoinLayout): Pick<Extract<LiveJoinPlan, { ok: true }>['req'], 'tables' | 'columns'> {
  const own = (m: number): string => infos.get(plan.tables[layout.tableOf[m]].datasetId)!.columns[layout.srcIndex[m]].name;
  return {
    tables: plan.tables.map((t) => (t.via ? { datasetId: t.datasetId, via: { parent: t.parent, from: t.via.from.column, to: t.via.to.column } } : { datasetId: t.datasetId })),
    columns: layout.columns.map((c, m) => ({ name: c.name, table: layout.tableOf[m], column: own(m) })),
  };
}

type KpiPlan = { ok: true; req: Extract<LiveJoinPlan, { ok: true }>['req'] & { metric: { column: string; aggregation: string } } } | { ok: false; failure: LiveFailure };

/** The join a Live KPI needs (its measure or a filter on a related table), or its refusal; null when it needs none. */
export async function liveMetricJoinOf(projectId: string, meta: DatasetMeta, spec: { column: string; aggregation: string }, filters: FilterStep[]): Promise<KpiPlan | null> {
  if (meta.live?.semantic) return null; // a layer's KPI refuses any join, in its own words (./semanticFigures)
  const mj = await metricJoin(projectId, meta.id, spec.column, filters);
  if (!mj) return null;
  if (!mj.planned.ok) {
    const e = mj.planned.error; // the copy shows no figure here; a Live tile says why, typed
    if (e === termNoJoinHere()) throw new TermNotExpandedError('unreachable', e);
    return { ok: false, failure: related(e) };
  }
  const { plan, layout, column, filters: flt } = mj.planned.value;
  const why = await blockedIn(projectId, meta, plan);
  if (why) return { ok: false, failure: related(why) };
  return { ok: true, req: { ...layoutOf(mj.infos, plan, layout), encoding: { category: '', values: [] }, filters: flt, metric: { column, aggregation: spec.aggregation } } };
}

/** The columns of `id` a joined question reads (its column gate's question): those it names, and the keys its hops read there. */
function readsOn(req: Extract<LiveJoinPlan, { ok: true }>['req'], id: string): string[] {
  const named = new Set([...encodingNames(req.encoding, req.filters), ...(req.metric ? [req.metric.column] : [])]);
  const out = req.columns.filter((c) => named.has(c.name) && req.tables[c.table].datasetId === id).map((c) => c.column);
  for (const t of req.tables) {
    if (!t.via) continue;
    if (t.datasetId === id) out.push(t.via.to);
    if (req.tables[t.via.parent].datasetId === id) out.push(t.via.from);
  }
  return [...new Set(out)];
}

/** Each related table's lock taken (nested, its column gate first), then `body` with every table's lock steps. */
function underLocks<R>(projectId: string, req: Extract<LiveJoinPlan, { ok: true }>['req'], body: (tables: LiveJoinRequest['tables']) => Promise<R>): Promise<R> {
  const ids = [...new Set(req.tables.slice(1).map((t) => t.datasetId))];
  const locks = new Map<string, Lock | null>();
  const ask = async (i: number): Promise<R> => {
    if (i < ids.length) return withLockOf(projectId, ids[i], (lock) => {
      locks.set(ids[i], lock);
      return ask(i + 1);
    }, readsOn(req, ids[i]), 'figures');
    return body(req.tables.map((t, k) => ({ ...t, lock: k === 0 ? [] : [...(locks.get(t.datasetId)?.steps ?? [])] })));
  };
  return ask(0);
}

/** A planned Live KPI across links: each related table's lock taken, then ONE question. A row policy refusal throws, as the KPI door's. */
export function liveJoinedKpi(projectId: string, plan: Extract<KpiPlan, { ok: true }>): Promise<LiveMetricReply> {
  return underLocks(projectId, plan.req, (tables) => liveJoinedMetric(projectId, { ...plan.req, tables }));
}

/** A planned Live join's chart: each related table's lock taken, then the executor's one question. */
export async function liveJoinedChart(projectId: string, plan: Extract<LiveJoinPlan, { ok: true }>): Promise<VizDataReply> {
  const { req } = plan;
  try {
    return await underLocks(projectId, req, async (tables): Promise<VizDataReply> => {
      const r = await liveJoinedVizData(projectId, { ...req, tables });
      if (!r.ok) return r;
      return { ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category, asOf: r.asOf, ...(r.notes ? { notes: r.notes } : {}) };
    });
  } catch (err) {
    if (isRowPolicyError(err)) return rowPolicyRefusal(err.reason); // a lock it cannot take, or a hidden column it reads
    throw err;
  }
}
