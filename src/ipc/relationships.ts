// Relationships IPC — the project data model's CRUD, key suggestions, and the
// two query-time hooks that let a visual or a metric reach across it.
//
// Both hooks return NULL when no join is involved, which is every call in a
// project without relationships (one small JSON read) and every call whose
// fields all belong to the primary dataset. Only then does the caller's own,
// unchanged single-dataset path run.

import { ipcMain } from 'electron';
import * as datasets from '../data/datasets';
import type { TableData, FilterStep } from '../data/transforms';
import type { MetricAggregation } from '../analysis/metricValue';
import type { VizEncoding } from '../analysis/visuals';
import * as rels from '../analysis/relationships';
import type { Relationship } from '../analysis/relationships';
import {
  mergedLayout, mergedName, planTables, relatedColumnGroups, resolveColumnOwner, resolveVizJoin,
} from '../analysis/joinPlan';
import type { DsInfo, JoinPlan } from '../analysis/joinPlan';
import { joinRateJs, joinedMetricJs, joinedVizDataJs, keyStatsJs } from '../analysis/joinJs';
import type { KeyStats } from '../analysis/joinJs';
import { RATE_SAMPLE, inferCardinality, rankKeys } from '../analysis/keySuggest';
import { isResident } from '../engine/residentQuery';
import {
  joinRateResident, joinedAggregateResident, joinedMetricResident, keyStatsResident,
} from '../engine/joinResident';
import type { JoinSource } from '../engine/joinResident';
import * as trace from '../engine/residentTrace';
import { isValidId } from '../app/ids';

type Infos = Map<string, DsInfo>;

async function infoFor(projectId: string, id: string): Promise<DsInfo | null> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  return meta ? { id, name: meta.name, columns: meta.columns } : null;
}

/** The primary plus every dataset any relationship names. Deleted datasets simply drop out. */
async function modelInfos(projectId: string, primary: string, list: Relationship[]): Promise<Infos> {
  const ids = new Set([primary]);
  for (const r of list) { ids.add(r.from.datasetId); ids.add(r.to.datasetId); }
  const infos: Infos = new Map();
  for (const id of ids) {
    const info = await infoFor(projectId, id);
    if (info) infos.set(id, info);
  }
  return infos;
}

/** Only relationships whose two datasets and two columns still exist. */
function live(list: Relationship[], infos: Infos): Relationship[] {
  const has = (e: rels.RelEnd): boolean => !!infos.get(e.datasetId)?.columns.some((c) => c.name === e.column);
  return list.filter((r) => has(r.from) && has(r.to));
}

async function residentSources(projectId: string, plan: JoinPlan): Promise<JoinSource[] | null> {
  if (!isResident()) return null;
  const out: JoinSource[] = [];
  for (const t of plan.tables) {
    const src = await datasets.residentSource(projectId, t.datasetId);
    if (!src) return null;
    out.push({ datasetId: t.datasetId, parquetPath: src.parquetPath, columns: src.columns });
  }
  return out;
}

async function hydrate(projectId: string, plan: JoinPlan): Promise<Map<string, TableData> | null> {
  const out = new Map<string, TableData>();
  for (const t of plan.tables) {
    const ds = await datasets.getDataset(projectId, t.datasetId);
    if (!ds) return null;
    out.set(t.datasetId, { columns: ds.columns, rows: ds.rows });
  }
  return out;
}

function hasRefs(encoding: VizEncoding): boolean {
  return !!(encoding && (encoding.categoryDatasetId || encoding.seriesDatasetId || (encoding.values || []).some((v) => v.datasetId)));
}

/**
 * `visual:data` across relationships, or null when the visual needs no join.
 * Same reply shape as `ipc/visuals.vizDataFor`, which calls this first.
 */
export async function joinedVizDataFor(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  // ponytail: the `visual:data` reply envelope (VizDataReply in ipc/visuals.ts), or null
): Promise<any> {
  const list = await rels.listRelationships(projectId);
  if (list.length === 0 && !hasRefs(encoding)) return null;
  const infos = await modelInfos(projectId, datasetId, list);
  const join = resolveVizJoin(datasetId, encoding, filters, live(list, infos), infos);
  if (!join) return null;
  if (!join.ok) return { ok: false, error: join.error };
  const j = join.value;

  const sources = await residentSources(projectId, j.plan);
  if (sources) {
    const fast = joinedAggregateResident(sources, j, infos);
    trace.record('vizJoin', fast ? 'resident' : 'skipped');
    if (fast) return { ok: true, ...fast };
  }
  const tables = await hydrate(projectId, j.plan);
  if (!tables) return { ok: false, error: 'Dataset not found' };
  const r = joinedVizDataJs(j, tables, infos);
  return { ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category };
}

/**
 * A metric's number across relationships, or null when the metric's column and
 * every filter column are its own dataset's. A column the dataset lacks
 * resolves to the NEAREST related dataset that has it — the same rule a
 * dashboard filter follows.
 */
export async function joinedMetricFor(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
): Promise<{ ok: boolean; value: number | null } | null> {
  const list = await rels.listRelationships(projectId);
  if (list.length === 0) return null;
  const infos = await modelInfos(projectId, datasetId, list);
  const model = live(list, infos);
  const needed = new Set<string>();
  const owner = resolveColumnOwner(datasetId, spec.column, model, infos);
  if (owner && owner !== datasetId) needed.add(owner);
  const filterOwners = filters.map((f) => (f && typeof f.column === 'string' ? resolveColumnOwner(datasetId, f.column, model, infos) : null));
  for (const o of filterOwners) if (o && o !== datasetId) needed.add(o);
  if (needed.size === 0) return null;

  const planned = planTables(datasetId, [...needed], model);
  if (!planned.ok) return { ok: true, value: null };
  const plan = planned.value;
  const layout = mergedLayout(plan, infos);
  const tIndex = (id: string): number => plan.tables.findIndex((t) => t.datasetId === id);
  const mOwner = owner || datasetId;
  const column = mergedName(layout, plan, tIndex(mOwner), spec.column, infos) ?? spec.column;
  const flt = filters.map((f, i) => {
    const o = filterOwners[i];
    return o ? { ...f, column: mergedName(layout, plan, tIndex(o), f.column, infos) ?? f.column } : f;
  });

  const sources = await residentSources(projectId, plan);
  if (sources) {
    const v = joinedMetricResident(sources, plan, layout, infos, { column, aggregation: spec.aggregation }, flt);
    if (v !== null) return { ok: true, value: v };
  }
  const tables = await hydrate(projectId, plan);
  if (!tables) return { ok: false, value: null };
  return {
    ok: true,
    value: joinedMetricJs(plan, layout, tables, infos, { column, aggregation: spec.aggregation, table: tIndex(mOwner) }, flt),
  };
}

/** Column names a metric formula on `datasetId` may also name — every related dataset's. */
export async function relatedColumnNames(projectId: string, datasetId: string): Promise<string[]> {
  const list = await rels.listRelationships(projectId);
  if (list.length === 0) return [];
  const infos = await modelInfos(projectId, datasetId, list);
  return relatedColumnGroups(datasetId, live(list, infos), infos).flatMap((g) => g.columns.map((c) => c.name));
}

interface SideRef { parquetPath: string; index: number; type: 'text' | 'number' | 'date' }

async function side(projectId: string, info: DsInfo, column: string): Promise<{ ref: SideRef | null; cells: () => Promise<any[]> }> {
  const index = info.columns.findIndex((c) => c.name === column);
  const src = isResident() ? await datasets.residentSource(projectId, info.id) : null;
  const ref = src && index >= 0 ? { parquetPath: src.parquetPath, index, type: info.columns[index].type } : null;
  const cells = async (): Promise<any[]> => {
    const ds = await datasets.getDataset(projectId, info.id);
    return ds && index >= 0 ? ds.rows.map((r) => r[index]) : [];
  };
  return { ref, cells };
}

async function keyStats(projectId: string, from: DsInfo, fromCol: string, to: DsInfo, toCol: string): Promise<KeyStats> {
  const a = await side(projectId, from, fromCol);
  const b = await side(projectId, to, toCol);
  if (a.ref && b.ref) {
    const s = keyStatsResident(a.ref, b.ref);
    if (s) return s;
  }
  const fType = from.columns.find((c) => c.name === fromCol)?.type || 'text';
  const tType = to.columns.find((c) => c.name === toCol)?.type || 'text';
  return keyStatsJs(await a.cells(), fType, await b.cells(), tType);
}

/** Ranked key pairs for FROM → TO, each with its sampled match rate and the cardinality the data supports. */
async function suggest(projectId: string, fromId: string, toId: string): Promise<any> {
  const from = await infoFor(projectId, fromId);
  const to = await infoFor(projectId, toId);
  if (!from || !to) return { ok: false, error: 'Dataset not found' };
  const fromSrc = isResident() ? await datasets.residentSource(projectId, fromId) : null;
  const toSrc = isResident() ? await datasets.residentSource(projectId, toId) : null;
  let fromRows: any[][] | null = null;
  let toRows: any[][] | null = null;
  const rateOf = (fc: string, tc: string): number | null => {
    const fi = from.columns.findIndex((c) => c.name === fc);
    const ti = to.columns.findIndex((c) => c.name === tc);
    if (fromSrc && toSrc) {
      return joinRateResident(
        { parquetPath: fromSrc.parquetPath, index: fi, type: from.columns[fi].type },
        { parquetPath: toSrc.parquetPath, index: ti, type: to.columns[ti].type },
        RATE_SAMPLE,
      );
    }
    if (!fromRows || !toRows) return null;
    return joinRateJs(fromRows.map((r) => r[fi]), from.columns[fi].type, toRows.map((r) => r[ti]), to.columns[ti].type, RATE_SAMPLE);
  };
  if (!fromSrc || !toSrc) {
    fromRows = (await datasets.getDataset(projectId, fromId))?.rows || [];
    toRows = (await datasets.getDataset(projectId, toId))?.rows || [];
  }
  const ranked = rankKeys(from.columns, to.columns, rateOf);
  const best = ranked[0];
  const stats = best ? await keyStats(projectId, from, best.from, to, best.to) : null;
  return { ok: true, candidates: ranked, best: best ? { ...best, stats, cardinality: stats ? inferCardinality(stats) : null } : null };
}

async function save(projectId: string, raw: any): Promise<any> {
  const rel = rels.sanitizeRelationship(raw);
  if (!rel) return { ok: false, error: 'Pick two different datasets and a column on each.' };
  const from = await infoFor(projectId, rel.from.datasetId);
  const to = await infoFor(projectId, rel.to.datasetId);
  if (!from || !to) return { ok: false, error: 'Dataset not found' };
  if (!from.columns.some((c) => c.name === rel.from.column) || !to.columns.some((c) => c.name === rel.to.column)) {
    return { ok: false, error: 'That column no longer exists.' };
  }
  const stats = await keyStats(projectId, from, rel.from.column, to, rel.to.column);
  rel.verified = { matched: stats.matched, unmatchedFrom: stats.unmatchedFrom };
  const saved = await rels.saveRelationship(projectId, rel);
  if (!saved) return { ok: false, error: 'Could not save the relationship.' };
  return { ok: true, relationship: saved, stats };
}

export function register(): void {
  ipcMain.handle('relationship:list', async (_e, { projectId }: any = {}) => {
    try {
      return { ok: true, relationships: await rels.listRelationships(projectId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read relationships' };
    }
  });
  ipcMain.handle('relationship:save', async (_e, { projectId, relationship }: any = {}) => {
    try {
      return await save(projectId, relationship);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save the relationship' };
    }
  });
  ipcMain.handle('relationship:delete', async (_e, { projectId, id }: any = {}) => ({
    ok: await rels.deleteRelationship(projectId, id),
  }));
  ipcMain.handle('relationship:suggest', async (_e, { projectId, fromId, toId }: any = {}) => {
    try {
      if (!isValidId(fromId) || !isValidId(toId) || fromId === toId) return { ok: false, error: 'Pick two different datasets.' };
      return await suggest(projectId, fromId, toId);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not suggest keys' };
    }
  });
  ipcMain.handle('relationship:related', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const list = await rels.listRelationships(projectId);
      if (list.length === 0) return { ok: true, groups: [] };
      const infos = await modelInfos(projectId, datasetId, list);
      return { ok: true, groups: relatedColumnGroups(datasetId, live(list, infos), infos) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read relationships' };
    }
  });
}
