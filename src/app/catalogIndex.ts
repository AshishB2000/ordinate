// The catalog ACROSS records — MAIN PROCESS. catalog.ts is the store; this
// file reads every record store beside it to answer the questions that span
// them: the Catalog page's rows (with usage and staleness), `#tag` search, the
// tag chips on search hits, and which sensitivity classes a report touches.
//
// METADATA ONLY. Every lister here returns a summary; the only full reads are
// analysis records (their cards are the references) — never a dataset table.
//
// TABLE-DRIVEN on purpose: `SOURCES` below is the one list of record kinds, so
// the Catalog page, tag search and the usage scan all learn about a new kind
// (stories) from one entry.

import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';
import * as metrics from '../analysis/metrics';
import { metricUsage } from '../analysis/metricUsage';
import { listReports } from '../analysis/reportSpec';
import * as stories from '../analysis/stories';
import { storyRefs } from '../analysis/storyModel';
import * as catalog from './catalog';
import type { CatalogKind, CatalogFile, RecordDoc, DocPatch } from './catalog';

export interface TagChip { name: string; color: number }

/** One record as the Catalog page and tag search see it. */
export interface CatalogEntry {
  id: string;
  name: string;
  updatedAt: string;
  /** The dim second line search already shows: rows, chart type, sheets. */
  sub: string;
  /** Set only where the record itself owns the description (metrics). */
  description?: string;
  stale?: boolean;
}

interface KindSource {
  kind: CatalogKind;
  /** The kind in the words the UI uses ("Dashboard", not "analysis"). */
  label: string;
  list: (projectId: string, now: number) => Promise<CatalogEntry[]>;
}

const plural = (n: number, one: string): string => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

// ── Stale ────────────────────────────────────────────────────────────────────

export const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A dataset WITH a schedule whose data has not landed in 30 days. An
 * unscheduled dataset is never stale — nobody promised it would move.
 * `lastRefreshedAt` falls back to `updatedAt` for records that predate it.
 */
export function isStale(
  d: { autoRefresh?: { every?: string }; lastRefreshedAt?: string; updatedAt?: string },
  now: number,
): boolean {
  if (!d || !d.autoRefresh || !d.autoRefresh.every) return false;
  const at = Date.parse(String(d.lastRefreshedAt || d.updatedAt || ''));
  return Number.isFinite(at) && now - at > STALE_MS;
}

// ── The kind table ───────────────────────────────────────────────────────────

export const SOURCES: KindSource[] = [
  {
    kind: 'dataset', label: 'Dataset',
    list: async (p, now) => (await datasets.listDatasets(p)).map((d) => ({
      id: d.id, name: d.name, updatedAt: d.lastRefreshedAt || d.updatedAt,
      sub: plural(d.rowCount || 0, 'row'), stale: isStale(d, now),
    })),
  },
  {
    kind: 'visual', label: 'Visual',
    list: async (p) => (await visuals.listVisuals(p)).map((v) => ({
      id: v.id, name: v.name, updatedAt: v.updatedAt, sub: v.chartType,
    })),
  },
  {
    kind: 'analysis', label: 'Dashboard',
    list: async (p) => (await analysis.listAnalyses(p)).map((a) => ({
      id: a.id, name: a.name, updatedAt: a.updatedAt, sub: plural(a.sheetCount, 'sheet'),
    })),
  },
  {
    kind: 'metric', label: 'Metric',
    list: async (p) => (await metrics.listMetrics(p)).map((m) => ({
      id: m.id, name: m.name, updatedAt: m.updatedAt, sub: '', description: m.description || '',
    })),
  },
  {
    kind: 'report', label: 'Report',
    list: async (p) => (await listReports(p)).map((r) => ({
      id: r.id, name: r.name, updatedAt: r.updatedAt, sub: String(r.format).toUpperCase(),
    })),
  },
  {
    kind: 'story', label: 'Story',
    list: async (p) => (await stories.listStories(p)).map((s) => ({
      id: s.id, name: s.name, updatedAt: s.updatedAt, sub: `${s.blockCount} block${s.blockCount === 1 ? '' : 's'}`,
    })),
  },
];

export function kindLabel(kind: string): string {
  const s = SOURCES.find((x) => x.kind === kind);
  return s ? s.label : kind;
}

/** Every record of every kind. One unreadable store costs its own rows only. */
async function allEntries(projectId: string, now: number): Promise<Array<CatalogEntry & { kind: CatalogKind }>> {
  const out: Array<CatalogEntry & { kind: CatalogKind }> = [];
  for (const s of SOURCES) {
    try {
      for (const e of await s.list(projectId, now)) out.push({ ...e, kind: s.kind });
    } catch (_) { /* as above */ }
  }
  return out;
}

export function tagChips(file: CatalogFile, names: string[]): TagChip[] {
  return names.map((name) => ({
    name,
    color: Object.prototype.hasOwnProperty.call(file.tags, name) ? file.tags[name].color : 0,
  }));
}

// ── Usage ────────────────────────────────────────────────────────────────────
//
// ponytail: a scan of the project's own records, not Lineage. Switch to the
// Lineage module's edges when it lands (it is on an unmerged branch today);
// the counts below are the same questions it answers.
//
//   dataset  ← visuals over it + metric/control cards over it + metrics on it
//   visual   ← dashboards whose cards show it
//   metric   ← metricUsage (cards, visuals, alerts, reports, other metrics)
//   analysis ← reports that print it            (+ stories, when they exist)
//   report / story ← 0 for now

export async function usageCounts(projectId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const bump = (ref: string, n = 1): void => { counts.set(ref, (counts.get(ref) || 0) + n); };
  try {
    for (const v of await visuals.listVisuals(projectId)) bump('dataset:' + v.datasetId);
  } catch (_) { /* a store we cannot read is references we cannot count */ }
  try {
    for (const s of await analysis.listAnalyses(projectId)) {
      const a = await analysis.getAnalysis(projectId, s.id);
      if (!a) continue;
      const shown = new Set<string>();
      for (const sheet of a.sheets) {
        for (const card of sheet.cards || []) {
          if (card.type === 'visual' && card.visualId) shown.add(card.visualId);
          else if (card.type === 'metric' && card.metric) bump('dataset:' + card.metric.datasetId);
          else if (card.type === 'control' && card.control) bump('dataset:' + card.control.datasetId);
        }
      }
      shown.forEach((id) => bump('visual:' + id));
    }
  } catch (_) { /* as above */ }
  try {
    for (const m of await metrics.listMetrics(projectId)) {
      bump('dataset:' + m.datasetId);
      bump('metric:' + m.id, (await metricUsage(projectId, m.id)).total);
    }
  } catch (_) { /* as above */ }
  try {
    for (const r of await listReports(projectId)) bump('analysis:' + r.analysisId);
  } catch (_) { /* as above */ }
  // A story that embeds a visual or a metric is a use of it, once per story.
  try {
    for (const s of await stories.listStories(projectId)) {
      const st = await stories.getStory(projectId, s.id);
      if (!st) continue;
      const refs = storyRefs(st.blocks);
      refs.visualIds.forEach((id) => bump('visual:' + id));
      refs.metricIds.forEach((id) => bump('metric:' + id));
    }
  } catch (_) { /* as above */ }
  return counts;
}

// ── The Catalog page ─────────────────────────────────────────────────────────

export interface CatalogRow {
  ref: string;
  kind: CatalogKind;
  type: string;
  id: string;
  name: string;
  sub: string;
  description: string;
  tags: TagChip[];
  owner: string;
  updatedBy: string;
  /** The later of the record's own edit and its docs' edit. */
  updatedAt: string;
  usage: number;
  stale: boolean;
}

export async function listRows(projectId: string, now = Date.now()): Promise<CatalogRow[]> {
  const [entries, file, usage] = await Promise.all([
    allEntries(projectId, now), catalog.load(projectId), usageCounts(projectId),
  ]);
  return entries.map((e) => {
    const ref = `${e.kind}:${e.id}`;
    const doc: RecordDoc | undefined = Object.prototype.hasOwnProperty.call(file.records, ref) ? file.records[ref] : undefined;
    const docAt = doc ? doc.updatedAt : '';
    return {
      ref, kind: e.kind, type: kindLabel(e.kind), id: e.id, name: e.name, sub: e.sub,
      description: e.description !== undefined ? e.description : (doc ? doc.description : ''),
      tags: tagChips(file, doc ? doc.tags : []),
      owner: doc ? doc.owner : '',
      updatedBy: doc ? doc.updatedBy : '',
      updatedAt: docAt > String(e.updatedAt || '') ? docAt : String(e.updatedAt || ''),
      usage: usage.get(ref) || 0,
      stale: Boolean(e.stale),
    };
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────────

/** Exact normalised match first, then prefix matches ('#sal' → sales). PURE. */
export function filterByTag<T extends { tags: string[] }>(items: T[], query: string): T[] {
  const q = catalog.normalizeTag(query);
  if (!q) return [];
  const exact = items.filter((i) => i.tags.indexOf(q) >= 0);
  const prefix = items.filter((i) => i.tags.indexOf(q) < 0 && i.tags.some((t) => t.startsWith(q)));
  return exact.concat(prefix);
}

/** Every tag in the project with its colour and use count, and each record's tags. */
export async function tagIndex(projectId: string): Promise<{ tags: Array<TagChip & { count: number }>; refs: Record<string, string[]> }> {
  const file = await catalog.load(projectId);
  const count = new Map<string, number>();
  const refs: Record<string, string[]> = {};
  for (const ref of Object.keys(file.records)) {
    const tags = file.records[ref].tags;
    if (!tags.length) continue;
    refs[ref] = tags;
    tags.forEach((t) => count.set(t, (count.get(t) || 0) + 1));
  }
  const tags = Object.keys(file.tags)
    .map((name) => ({ name, color: file.tags[name].color, count: count.get(name) || 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { tags, refs };
}

export interface TagHit { kind: CatalogKind; id: string; name: string; sub: string; type: string; tags: TagChip[] }

/** `#sales` in the top-bar search: records of every kind carrying the tag. */
export async function tagSearch(projectId: string, query: string): Promise<TagHit[]> {
  const [entries, file] = await Promise.all([allEntries(projectId, Date.now()), catalog.load(projectId)]);
  const tagged = entries.map((e) => {
    const ref = `${e.kind}:${e.id}`;
    return { e, tags: Object.prototype.hasOwnProperty.call(file.records, ref) ? file.records[ref].tags : [] };
  });
  return filterByTag(tagged, query).map(({ e, tags }) => ({
    kind: e.kind, id: e.id, name: e.name, sub: e.sub, type: kindLabel(e.kind), tags: tagChips(file, tags),
  }));
}

/** Put tag chips on ordinary name-search hits. One catalog read per project. */
export async function attachTags<T extends { kind: string; id: string; projectId: string; tags?: TagChip[] }>(hits: T[]): Promise<void> {
  const files = new Map<string, CatalogFile>();
  for (const h of hits) {
    if (!files.has(h.projectId)) files.set(h.projectId, await catalog.load(h.projectId));
    const file = files.get(h.projectId) as CatalogFile;
    const ref = `${h.kind}:${h.id}`;
    if (Object.prototype.hasOwnProperty.call(file.records, ref) && file.records[ref].tags.length) {
      h.tags = tagChips(file, file.records[ref].tags);
    }
  }
}

// ── Record docs, with the metric exception ───────────────────────────────────

export interface DocView extends Omit<RecordDoc, 'tags'> { tags: TagChip[] }

/** A metric's description is the Metric record's own field — read it there. */
export async function getDoc(projectId: string, ref: string): Promise<DocView | null> {
  const doc = await catalog.getDoc(projectId, ref);
  const r = catalog.parseRef(ref);
  if (!doc || !r) return null;
  if (r.kind === 'metric') {
    const m = await metrics.getMetric(projectId, r.id);
    doc.description = (m && m.description) || '';
  }
  return { ...doc, tags: tagChips(await catalog.load(projectId), doc.tags) };
}

/** …and write it there, through the metric store's own update (single source). */
export async function setDoc(projectId: string, ref: string, patch: DocPatch): Promise<DocView | null> {
  const r = catalog.parseRef(ref);
  if (!r) return null;
  const p: DocPatch = { ...(patch && typeof patch === 'object' ? patch : {}) };
  if (r.kind === 'metric' && p.description !== undefined) {
    const m = await metrics.updateMetric(projectId, r.id, { description: String(p.description || '') });
    if (!m) return null;
    delete p.description;
  }
  if (!(await catalog.setDoc(projectId, ref, p))) return null;
  return getDoc(projectId, ref);
}

// ── Sensitivity on a report's cover ──────────────────────────────────────────

/**
 * The datasets a dashboard reads: its visuals' datasets and every metric or
 * control card's. DATASET-level on purpose — a table visual shows every
 * column, and a cover that under-reports sensitive data is the one wrong
 * answer here, so any flagged column in a dataset the report reads counts.
 */
export function analysisDatasetIds(a: analysis.Analysis, visualDataset: Map<string, string>): string[] {
  const ids = new Set<string>();
  for (const sheet of a.sheets) {
    for (const card of sheet.cards || []) {
      if (card.type === 'visual' && card.visualId && visualDataset.has(card.visualId)) {
        ids.add(visualDataset.get(card.visualId) as string);
      } else if (card.type === 'metric' && card.metric) ids.add(card.metric.datasetId);
      else if (card.type === 'control' && card.control) ids.add(card.control.datasetId);
    }
  }
  return [...ids];
}

export async function reportSensitivity(
  projectId: string, analysisId: string,
): Promise<{ classes: Array<'financial' | 'personal'>; lines: string[] }> {
  const a = await analysis.getAnalysis(projectId, analysisId);
  if (!a) return { classes: [], lines: [] };
  const byVisual = new Map<string, string>();
  for (const v of await visuals.listVisuals(projectId)) byVisual.set(v.id, v.datasetId);
  const file = await catalog.load(projectId);
  const docs = analysisDatasetIds(a, byVisual)
    .filter((id) => Object.prototype.hasOwnProperty.call(file.columns, id))
    .map((id) => file.columns[id]);
  const classes = catalog.sensitivityClasses(docs);
  return { classes, lines: catalog.sensitivityLines(classes) };
}
