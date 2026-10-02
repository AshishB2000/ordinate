// The Share policy, applied — MAIN PROCESS ONLY.
//
// Whatever LEAVES the app (an export, a report, a publish, a project bundle)
// passes through here on the way out, and the project's policy
// (privacyStore.getPolicy) decides what happens to a sensitive column:
//
//   mask     each value becomes its project token (maskSteps.maskToken, the
//            same HMAC a mask_hash step writes, so a masked export and a masked
//            dataset agree token for token). Chart labels and series names
//            drawn from the column are masked; the figures are aggregates and
//            pass through.
//   drop     the column is removed from a table; a chart that USES it in any
//            role is replaced by a "Hidden by the share policy" result.
//   include  passes through. The renderer asks for an explicit confirmation
//            before it lets an export run under this action.
//
// "Sensitive" means marked personal or financial in the catalog — a proposal
// the user has not accepted is not sensitive yet — and NOT already masked by a
// mask step in the dataset's own pipeline (those columns already are what
// leaves; masking a token again would only rename it).
//
// Everything fails CLOSED: if the salt cannot be had, a mask becomes a drop.
//
// PUBLISH is built elsewhere and calls in through three functions:
//   applyToChart(projectId, datasetId, encoding, reply, 'publish')
//   applyToTable(projectId, datasetId, table, 'publish')
//   policySummary(projectId, datasetIds, 'publish')

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as catalog from './catalog';
import * as store from './privacyStore';
import type { ShareAction, SharePath } from './privacyStore';
import { readZip, writeZip } from './bundle';
import type { ZipEntry } from './bundle';
import { projectDir } from './recordKinds';
import * as datasets from '../data/datasets';
import { maskToken, maskedColumns, isMaskStep } from '../data/maskSteps';
import { isEmptyCell } from '../data/transforms';
import type { Cell } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import * as parquetStore from '../engine/parquetStore';
import { OTHER_LABEL } from '../analysis/categoryKey';
import type { VizEncoding } from '../analysis/visuals';
import { engineColumns, isEngineEncoding } from '../analysis/engineViz';

export type SensitiveLevel = 'personal' | 'financial';
export const HIDDEN_BY_POLICY = 'Hidden by the share policy';

export interface SensitiveColumn {
  datasetId: string;
  datasetName: string;
  column: string;
  level: SensitiveLevel;
}

export interface PolicySummary {
  path: SharePath;
  action: ShareAction;
  count: number;
  columns: SensitiveColumn[];
  /** "2 sensitive columns will be masked" — '' when nothing is sensitive. */
  line: string;
}

// ── Which columns ────────────────────────────────────────────────────────────

/**
 * column → level for every column the user marked, CARRIED ACROSS later
 * rename steps. A catalog key is the column's name when it was marked; a
 * rename added afterwards leaves the doc under the old name, and a policy that
 * only looked names up would let the renamed column leave unmasked.
 */
async function markedLevels(projectId: string, datasetId: string, steps: unknown): Promise<Map<string, SensitiveLevel>> {
  const docs = await catalog.getColumns(projectId, datasetId);
  const out = new Map<string, SensitiveLevel>();
  for (const k of Object.keys(docs)) {
    const s = docs[k].sensitivity;
    if (s === 'personal' || s === 'financial') out.set(k, s);
  }
  for (const st of Array.isArray(steps) ? steps : []) {
    const o = st && typeof st === 'object' ? (st as Record<string, unknown>) : {};
    if (o.type !== 'rename_column' || typeof o.from !== 'string' || typeof o.to !== 'string') continue;
    const level = out.get(o.from);
    if (level && !out.has(o.to.trim())) out.set(o.to.trim(), level);
  }
  return out;
}

/** The marked columns the derived table still HAS, in column order, and whether Prepare masks each. */
export async function markedColumns(
  projectId: string, datasetId: string,
): Promise<Array<{ column: string; level: SensitiveLevel; maskedInPrepare: boolean }>> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return [];
  const levels = await markedLevels(projectId, datasetId, meta.steps);
  const masked = maskedColumns(meta.steps);
  return meta.columns
    .map((c) => String(c.name))
    .filter((n) => levels.has(n))
    .map((n) => ({ column: n, level: levels.get(n) as SensitiveLevel, maskedInPrepare: masked.has(n) }));
}

/**
 * column → level for the columns of one dataset the policy acts on: the marked
 * ones, minus those a mask step in the dataset's own pipeline already covers.
 */
export async function sensitiveColumns(projectId: string, datasetId: string): Promise<Map<string, SensitiveLevel>> {
  return new Map((await markedColumns(projectId, datasetId)).filter((m) => !m.maskedInPrepare).map((m) => [m.column, m.level]));
}

/**
 * The columns the Assistant must not quote values from: every marked column,
 * masked in Prepare or not (a token is harmless, but a withheld line is simpler
 * to reason about than an exception).
 */
export async function withheldColumns(projectId: string, datasetId: string): Promise<Set<string>> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return new Set((await markedLevels(projectId, datasetId, meta ? meta.steps : [])).keys());
}

/**
 * The catalog's column docs as the Assistant's facts read them
 * (ipc/copilot.ts): the stored docs, plus a level-only doc for a column a
 * rename step carried a mark to — so its values are withheld under its new name.
 */
export async function assistantColumnDocs(projectId: string, datasetId: string): Promise<Record<string, catalog.ColumnDoc>> {
  const docs: Record<string, catalog.ColumnDoc> = Object.assign(Object.create(null), await catalog.getColumns(projectId, datasetId));
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  for (const [name, level] of await markedLevels(projectId, datasetId, meta ? meta.steps : [])) {
    if (!Object.prototype.hasOwnProperty.call(docs, name)) {
      docs[name] = { description: '', displayName: '', example: '', sensitivity: level, updatedBy: '', updatedAt: '' };
    }
  }
  return docs;
}

export function summaryLine(count: number, action: ShareAction): string {
  if (count <= 0) return '';
  const verb = action === 'mask' ? 'masked' : action === 'drop' ? 'dropped' : 'included as they are';
  return `${count} sensitive column${count === 1 ? '' : 's'} will be ${verb}`;
}

/** What the policy will do on `path` to the datasets named (every dataset in the project when null). */
export async function policySummary(projectId: string, datasetIds: string[] | null, sharePath: SharePath): Promise<PolicySummary> {
  const policy = await store.getPolicy(projectId);
  const action = policy[sharePath];
  const ids = Array.isArray(datasetIds)
    ? [...new Set(datasetIds.filter((d) => typeof d === 'string'))]
    : (await datasets.listDatasets(projectId)).map((d) => d.id);
  const columns: SensitiveColumn[] = [];
  for (const id of ids) {
    const sens = await sensitiveColumns(projectId, id);
    if (!sens.size) continue;
    const meta = await datasets.getDatasetMeta(projectId, id);
    for (const [column, level] of sens) columns.push({ datasetId: id, datasetName: meta ? meta.name : '', column, level });
  }
  return { path: sharePath, action, count: columns.length, columns, line: summaryLine(columns.length, action) };
}

// ── Tables ───────────────────────────────────────────────────────────────────

interface Shaper {
  columns: ParsedColumn[];
  row: (r: Cell[]) => Cell[];
  masked: string[];
  dropped: string[];
}

function shaperFor(columns: ParsedColumn[], sens: Map<string, SensitiveLevel>, action: ShareAction, salt: string | null): Shaper {
  const hits = columns.map((c, i) => (sens.has(String(c.name)) ? i : -1)).filter((i) => i >= 0);
  if (action === 'include' || hits.length === 0) {
    return { columns, row: (r) => r, masked: [], dropped: [] };
  }
  const names = hits.map((i) => String(columns[i].name));
  if (action === 'mask' && salt) {
    const set = new Set(hits);
    return {
      columns: columns.map((c, i) => (set.has(i) ? { ...c, type: 'text' as const } : c)),
      row: (r) => r.map((cell, i) => (set.has(i) && !isEmptyCell(cell) ? maskToken(salt, String(cell)) : cell)),
      masked: names,
      dropped: [],
    };
  }
  // drop — and a mask with no salt, which fails closed to a drop.
  const keep = columns.map((_, i) => i).filter((i) => !hits.includes(i));
  return {
    columns: keep.map((i) => columns[i]),
    row: (r) => keep.map((i) => (r[i] === undefined ? null : r[i])),
    masked: [],
    dropped: names,
  };
}

/**
 * A row shaper for a table that is STREAMED out (the drill CSV): the output
 * columns once, and a per-row function. `columns` are the derived table's.
 */
export async function rowShaper(projectId: string, datasetId: string, columns: ParsedColumn[], sharePath: SharePath): Promise<Shaper> {
  const action = (await store.getPolicy(projectId))[sharePath];
  const sens = action === 'include' ? new Map<string, SensitiveLevel>() : await sensitiveColumns(projectId, datasetId);
  const salt = action === 'mask' && sens.size ? await store.getSalt(projectId) : null;
  return shaperFor(columns, sens, action, salt);
}

/** A whole table, shaped by the policy on `path`. The input is never mutated. */
export async function applyToTable(
  projectId: string, datasetId: string, table: { columns: ParsedColumn[]; rows: Cell[][] }, sharePath: SharePath,
): Promise<{ columns: ParsedColumn[]; rows: Cell[][]; masked: string[]; dropped: string[] }> {
  const s = await rowShaper(projectId, datasetId, table.columns, sharePath);
  return { columns: s.columns, rows: table.rows.map(s.row), masked: s.masked, dropped: s.dropped };
}

// ── Charts ───────────────────────────────────────────────────────────────────

/** The fields of a `visual:data` reply this module reads. Anything else passes through. */
export interface ChartReplyLike {
  ok: boolean;
  data?: {
    labels?: (string | number)[];
    series?: { name: string; role?: string }[];
    geo?: unknown;
    pivot?: { rowHeaders: string[][]; colHeaders: string[][] };
    facets?: unknown;
  };
}
export interface HiddenReply { ok: false; error: string; hiddenByPolicy: true }

/**
 * A chart reply shaped by the policy on `path`. Mask: labels / series names /
 * pivot headers drawn from a sensitive column become tokens. Drop — or a map,
 * which cannot draw a token — returns a HiddenReply the tile shows instead.
 */
export async function applyToChart<R extends ChartReplyLike>(
  projectId: string, datasetId: string, encoding: VizEncoding | null | undefined, reply: R, sharePath: SharePath,
): Promise<R | HiddenReply> {
  if (!reply || !reply.ok || !reply.data || !encoding) return reply;
  const action = (await store.getPolicy(projectId))[sharePath];
  if (action === 'include') return reply;

  const cache = new Map<string, Map<string, SensitiveLevel>>();
  const sens = async (ds: string | undefined, col: string | undefined): Promise<boolean> => {
    if (!col) return false;
    const id = ds || datasetId;
    if (!cache.has(id)) cache.set(id, await sensitiveColumns(projectId, id));
    return (cache.get(id) as Map<string, SensitiveLevel>).has(col);
  };
  // A cohort's row labels and a funnel's step / breakdown labels are VALUES of
  // their own columns, spread through a grid the masking below does not know —
  // so any sensitive column behind one hides the tile rather than half-masking it.
  if (isEngineEncoding(encoding)) {
    const touched = (await Promise.all(engineColumns(encoding).map((c) => sens(datasetId, c)))).some(Boolean);
    return touched ? { ok: false, error: HIDDEN_BY_POLICY, hiddenByPolicy: true } : reply;
  }
  // Small multiples spread facet and category values through panel titles,
  // filter steps and the flattened series names — hide rather than half-mask.
  if (encoding.facet && reply.data.facets) {
    const labelish = await Promise.all([encoding.facet.rows, encoding.facet.cols, encoding.category, encoding.series].map((c) => sens(datasetId, c)));
    const valueish = await Promise.all((encoding.values || []).map((m) => sens(datasetId, m.column)));
    const hide = labelish.some(Boolean) || (action === 'drop' && valueish.some(Boolean));
    return hide ? { ok: false, error: HIDDEN_BY_POLICY, hiddenByPolicy: true } : reply;
  }
  const catS = await sens(encoding.categoryDatasetId, encoding.category);
  const serS = await sens(encoding.seriesDatasetId, encoding.series);
  const rowDims = encoding.pivot ? await Promise.all(encoding.pivot.rows.map((d) => sens(datasetId, d.column))) : [];
  const colDims = encoding.pivot ? await Promise.all(encoding.pivot.columns.map((d) => sens(datasetId, d.column))) : [];
  const geoS = encoding.geo ? (await sens(datasetId, encoding.geo.lat)) || (await sens(datasetId, encoding.geo.lon)) : false;
  const labelUse = catS || serS || rowDims.some(Boolean) || colDims.some(Boolean);
  const valueUse = (await Promise.all([
    ...(encoding.values || []).map((m) => sens(datasetId, m.column)),
    ...(encoding.pivot ? encoding.pivot.values.map((v) => sens(datasetId, v.column)) : []),
  ])).some(Boolean);
  if (!labelUse && !valueUse && !geoS) return reply;

  const hidden: HiddenReply = { ok: false, error: HIDDEN_BY_POLICY, hiddenByPolicy: true };
  if (action === 'drop' || geoS || (encoding.geo && catS)) return hidden;
  if (!labelUse) return reply; // mask, and only the figures touch a sensitive column
  const salt = await store.getSalt(projectId);
  if (!salt) return hidden;

  const tok = (v: string | number): string | number =>
    v === null || v === undefined || v === '' || v === OTHER_LABEL ? v : maskToken(salt, String(v));
  const data = { ...reply.data };
  const pivotRows = rowDims.some(Boolean);
  const pivotCols = colDims.some(Boolean);
  if (Array.isArray(data.labels) && (catS || pivotRows)) data.labels = data.labels.map(tok);
  if (Array.isArray(data.series) && (serS || pivotCols)) {
    data.series = data.series.map((s) => (s && s.role !== 'overlay' ? { ...s, name: String(tok(s.name)) } : s));
  }
  if (data.pivot && (pivotRows || pivotCols)) {
    data.pivot = {
      ...data.pivot,
      rowHeaders: data.pivot.rowHeaders.map((h) => h.map((v, k) => (rowDims[k] ? String(tok(v)) : v))),
      colHeaders: data.pivot.colHeaders.map((h) => h.map((v, k) => (colDims[k] ? String(tok(v)) : v))),
    };
  }
  return { ...reply, data };
}

// ── Bundles ──────────────────────────────────────────────────────────────────

const DS_JSON = /^datasets\/([0-9a-f-]{36})\.json$/i;

/**
 * A project bundle (bundle.exportProject's bytes) shaped by the policy.
 *
 * A dataset that holds a sensitive column, or whose pipeline masks one, leaves
 * WITHOUT its prepare history: the source Parquet and the step list hold the
 * raw values, so they cannot travel. What travels is the derived table, its
 * sensitive columns masked or dropped — a dataset with no pipeline, which is
 * still a complete, openable dataset on the other side. The manifest's counts
 * follow what was removed, or import would refuse the bundle.
 */
/**
 * The project's colour map (analysis/colorMap.ts) is keyed by category VALUES,
 * so a column marked in ANY of the bundle's datasets leaves without its
 * colours — the other side deals them again the first time it draws. Every
 * marked column, masked in Prepare or not: a withheld entry is simpler to
 * reason about than a token that happens to be harmless.
 */
async function dropMarkedColors(projectId: string, entries: ZipEntry[]): Promise<boolean> {
  const pj = entries.find((x) => x.name === 'project.json');
  if (!pj) return false;
  let rec: Record<string, unknown>;
  try { rec = JSON.parse(pj.data.toString('utf8')); } catch (_) { return false; }
  const map = rec && rec.colorMap && typeof rec.colorMap === 'object' ? (rec.colorMap as Record<string, unknown>) : null;
  if (!map) return false;
  const marked = new Set<string>();
  for (const e of entries) {
    const m = DS_JSON.exec(e.name);
    if (m) (await withheldColumns(projectId, m[1])).forEach((c) => marked.add(c));
  }
  const drop = Object.keys(map).filter((c) => marked.has(c));
  if (!drop.length) return false;
  drop.forEach((c) => { delete map[c]; });
  pj.data = Buffer.from(JSON.stringify(rec, null, 2), 'utf8');
  return true;
}

export async function applyToBundle(projectId: string, bytes: Buffer): Promise<Buffer> {
  const action = (await store.getPolicy(projectId)).bundle;
  if (action === 'include') return bytes;
  let entries: ZipEntry[] = readZip(bytes);
  const removed = { parquet: 0, versions: 0 };
  const scratch = path.join(projectDir(projectId), 'privacy', 'tmp-' + randomUUID());
  let changed = false;
  try {
    for (const e of entries.slice()) {
      const m = DS_JSON.exec(e.name);
      if (!m) continue;
      const id = m[1];
      let record: Record<string, unknown>;
      try { record = JSON.parse(e.data.toString('utf8')); } catch (_) { continue; }
      const sens = await sensitiveColumns(projectId, id);
      const steps = Array.isArray(record.steps) ? record.steps : [];
      if (!sens.size && !steps.some(isMaskStep)) continue;
      const ds = await datasets.getDataset(projectId, id);
      if (!ds) continue;
      const salt = action === 'mask' && sens.size ? await store.getSalt(projectId) : null;
      const shaped = shaperFor(ds.columns, sens, action, salt);
      const rows = ds.rows.map(shaped.row);

      record.columns = shaped.columns;
      record.steps = [];
      delete record.source;
      const before = entries.length;
      if (Array.isArray(record.rows)) {
        record.rows = rows; // a v2 record: the table is inline
      } else {
        await fs.promises.mkdir(scratch, { recursive: true });
        const file = path.join(scratch, id + '.parquet');
        parquetStore.writeTable(file, shaped.columns, rows);
        const table = entries.find((x) => x.name === `datasets/${id}.parquet`);
        if (table) table.data = await fs.promises.readFile(file);
      }
      e.data = Buffer.from(JSON.stringify(record, null, 2), 'utf8');
      entries = entries.filter((x) => x.name !== `datasets/${id}.source.parquet`);
      removed.parquet += before - entries.length;
      const vBefore = entries.length;
      entries = entries.filter((x) => !x.name.toLowerCase().startsWith(`history/dataset/${id.toLowerCase()}/`));
      removed.versions += vBefore - entries.length;
      changed = true;
    }
  } finally {
    await fs.promises.rm(scratch, { recursive: true, force: true });
  }
  if (await dropMarkedColors(projectId, entries)) changed = true;
  if (!changed) return bytes;
  const manifest = entries.find((x) => x.name === 'manifest.json');
  if (manifest) {
    const mf = JSON.parse(manifest.data.toString('utf8'));
    for (const k of ['parquet', 'versions'] as const) {
      if (!removed[k]) continue;
      const left = (Number(mf.counts[k]) || 0) - removed[k];
      if (left > 0) mf.counts[k] = left;
      else delete mf.counts[k];
    }
    manifest.data = Buffer.from(JSON.stringify(mf, null, 2), 'utf8');
  }
  return writeZip(entries);
}
