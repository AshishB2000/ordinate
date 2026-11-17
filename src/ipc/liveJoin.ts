// A Live chart across saved relationships (docs/live-data/00-plan.md L4, "Joins across datasets") — MAIN PROCESS ONLY.
//
// `liveChart` (./liveRoute) asks here first. The plan is the copy's: analysis/joinPlan `resolveVizJoin` over the
// project's relationships and every dataset's METADATA (./relationships `vizJoin`; nothing is hydrated), so the hops
// walk many → one only, a reverse hop is refused in the copy's own sentence, and the merged names are the copy's.
// What only a copy can do is said, typed `live_refused` (reason `related`), never computed:
//   - a measure on a related table (joinJs rule 3, its fan-in mask) — `relatedMeasure`;
//   - a related dataset that is a copy, or Live on another connection: no one engine holds both tables
//     (`liveJoinMixed`, `liveJoinApart`; the link card's words for the same case are ai/sourceAnswerMessages').
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
import { liveJoinedVizData } from '../engine/live/liveQuery';
import type { LiveFailure } from '../engine/live/liveQuery';
import type { LiveJoinRequest } from '../engine/live/liveJoin';
import { encodingNames } from '../engine/live/liveMissing';
import { refuse } from '../engine/live/liveSpec';
import * as msg from '../engine/liveRefusals';
import { vizJoin } from './relationships';
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
  const { plan, layout, measureTable } = vj.join.value;
  if ([...measureTable.values()].some((t) => t > 0)) {
    const r = refuse('relatedMeasure');
    return { ok: false, reply: { ok: false, code: 'live_refused', error: r.message, reason: r.code } };
  }
  for (const id of new Set(plan.tables.slice(1).map((t) => t.datasetId))) {
    const other = id === meta.id ? meta : await datasets.getDatasetMeta(projectId, id);
    const why = other ? joinBlocked(meta, other) : null; // gone since the plan read it: the executor says so
    if (why) return { ok: false, reply: related(why) };
  }
  const own = (m: number): string => vj.infos.get(plan.tables[layout.tableOf[m]].datasetId)!.columns[layout.srcIndex[m]].name;
  return {
    ok: true,
    req: {
      tables: plan.tables.map((t) => (t.via ? { datasetId: t.datasetId, via: { parent: t.parent, from: t.via.from.column, to: t.via.to.column } } : { datasetId: t.datasetId })),
      columns: layout.columns.map((c, m) => ({ name: c.name, table: layout.tableOf[m], column: own(m) })),
      encoding: vj.join.value.encoding,
      filters: vj.join.value.filters,
    },
  };
}

/** The columns of `id` a joined question reads (its column gate's question): those it names, and the keys its hops read there. */
function readsOn(req: LiveJoinRequest | Extract<LiveJoinPlan, { ok: true }>['req'], id: string): string[] {
  const named = new Set(encodingNames(req.encoding, req.filters));
  const out = req.columns.filter((c) => named.has(c.name) && req.tables[c.table].datasetId === id).map((c) => c.column);
  for (const t of req.tables) {
    if (!t.via) continue;
    if (t.datasetId === id) out.push(t.via.to);
    if (req.tables[t.via.parent].datasetId === id) out.push(t.via.from);
  }
  return [...new Set(out)];
}

/** A planned Live join's chart: each related table's lock taken, then the executor's one question. */
export async function liveJoinedChart(projectId: string, plan: Extract<LiveJoinPlan, { ok: true }>): Promise<VizDataReply> {
  const { req } = plan;
  const ids = [...new Set(req.tables.slice(1).map((t) => t.datasetId))];
  const locks = new Map<string, Lock | null>();
  const ask = async (i: number): Promise<VizDataReply> => {
    if (i < ids.length) return withLockOf(projectId, ids[i], (lock) => {
      locks.set(ids[i], lock);
      return ask(i + 1);
    }, readsOn(req, ids[i]), 'figures');
    const tables = req.tables.map((t, k) => ({ ...t, lock: k === 0 ? [] : [...(locks.get(t.datasetId)?.steps ?? [])] }));
    const r = await liveJoinedVizData(projectId, { ...req, tables });
    if (!r.ok) return r;
    return { ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category, asOf: r.asOf, ...(r.notes ? { notes: r.notes } : {}) };
  };
  try {
    return await ask(0);
  } catch (err) {
    if (isRowPolicyError(err)) return rowPolicyRefusal(err.reason); // a lock it cannot take, or a hidden column it reads
    throw err;
  }
}
