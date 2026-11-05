// A project's definitions as model files (semantic layer part 7, D2, D3; ./modelFormat.ts): the table and
// field docs, value labels, metrics, terms, relationships and Live base filters. METADATA ONLY: the dataset
// records, the catalog, the metric and term records and relationships.json; never a row (`getDataset` is
// never called), never a warehouse.
//
// Every record is mapped to its shape by an explicit whitelist, never spread, so a field a store adds later
// stays home until the format names it. Never written: an origin (path, table, SQL, URL, connection),
// connections, row or column access rules, the privacy salt, secrets, stamps (`updatedAt`, `updatedBy`,
// `createdAt`), what a count derived (`keyCheck`, a relationship's `verified` and `warning`) and a metric's
// tree. References are ids, resolved through the export's own files.
//
// A caller row access rules restrict is refused (D7): the files hold term values and value labels part 1
// withholds from them.

import * as path from 'path';
import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import * as projects from './projects';
import * as recordFs from './recordFs';
import { listFullTerms } from '../analysis/terms';
import { listRelationships } from '../analysis/relationships';
import { loadStrict, type ColumnDoc } from './catalog';
import { getCalendar } from '../analysis/dateIntel';
import { restrictedOn } from '../data/rowAccess';
import { projectDir } from './recordKinds';
import { modelFiltersUnreadable, modelRestricted } from './modelFileMessages';
import {
  MODEL_FORMAT, MODEL_VERSION, modelJson, objectBase, slugsFor,
  type ModelDataset, type ModelField, type ModelFiles, type ModelManifest, type ModelMetric, type ModelRelationship, type ModelTerm,
} from './modelFormat';

/** Kinds a project may hold that formatVersion 1 does not carry (cross-part check item 10): fixed words, never a name. */
export const NOT_CARRIED = ['metricTrees', 'hierarchies', 'status', 'instructions', 'verifiedQuestions', 'sourceDocs', 'liveCalcs'] as const;
export type NotCarried = typeof NOT_CARRIED[number];

export interface ModelCounts { datasets: number; metrics: number; terms: number; relationships: number }
export interface ModelExport { files: ModelFiles; counts: ModelCounts; notCarried: NotCarried[] }

/** Thrown with a sentence a person may read: the handler answers it as `{ ok: false, error }`. */
export class ModelExportRefused extends Error {}

/** A key only when it holds something: a project that filled in nothing exports `{ base, id, name }`. */
const some = <T>(v: T | undefined | null | '' | readonly unknown[]): T | undefined => (v === '' || v == null || (Array.isArray(v) && v.length === 0) ? undefined : (v as T));

function fieldOf(name: string, d: ColumnDoc): ModelField | null {
  const f: ModelField = {
    name,
    description: some(d.description),
    displayName: some(d.displayName),
    aliases: some(d.aliases),
    example: some(d.example),
    sensitivity: d.sensitivity === 'none' ? undefined : d.sensitivity,
    values: some(d.values),
  };
  return Object.values(f).filter((v) => v !== undefined).length > 1 ? f : null;
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

async function hasRecords(dir: string, re: RegExp): Promise<boolean> {
  try {
    return (await recordFs.readdir(dir)).some((n) => re.test(n));
  } catch (_) {
    return false; // none yet
  }
}

export async function exportModel(projectId: string): Promise<ModelExport> {
  if (await restrictedOn(projectId)) throw new ModelExportRefused(modelRestricted());
  // A catalog that cannot be read fails the export: it must not pass for "nothing documented".
  const [project, list, catalog, summaries, terms, rels] = await Promise.all([
    projects.getProject(projectId), datasets.listDatasets(projectId), loadStrict(projectId),
    metrics.listMetrics(projectId), listFullTerms(projectId), listRelationships(projectId),
  ]);
  const full = (await Promise.all(summaries.map((m) => metrics.getMetric(projectId, m.id)))).filter((m): m is metrics.Metric => !!m);
  const files: ModelFiles = new Map();
  const notCarried = new Set<NotCarried>();
  const put = (p: string, v: unknown): void => void files.set(p, modelJson(v));

  const dsSlugs = slugsFor(list);
  for (const d of list) {
    const meta = await datasets.getDatasetMeta(projectId, d.id);
    if (meta?.live?.baseFiltersUnreadable) throw new ModelExportRefused(modelFiltersUnreadable(d.name));
    if (meta?.live?.calculated?.length || meta?.live?.calculatedUnreadable) notCarried.add('liveCalcs');
    const doc = catalog.tables?.[d.id];
    if (doc?.hierarchies?.length) notCarried.add('hierarchies');
    const cols = catalog.columns[d.id] ?? {};
    const fields = Object.keys(cols).map((n) => fieldOf(n, cols[n])).filter((f): f is ModelField => !!f).sort(byName);
    const out: Omit<ModelDataset, 'base'> = {
      id: d.id,
      name: d.name,
      description: some(catalog.records[`dataset:${d.id}`]?.description),
      role: some(doc?.role),
      key: some(doc?.key),
      grain: some(doc?.grain),
      fields: some(fields),
      baseFilters: some(meta?.live?.baseFilters),
    };
    const guide = doc?.guide ?? '';
    const slug = dsSlugs.get(d.id) as string;
    // The guide travels as its own file, and the base covers it: an edit to either is an edit to the dataset.
    put(`datasets/${slug}.json`, { ...out, base: objectBase({ ...out, ...(guide && { guide }) }) });
    if (guide) files.set(`datasets/${slug}.md`, guide);
  }

  const mSlugs = slugsFor(full);
  for (const m of full) {
    if (m.tree) notCarried.add('metricTrees');
    const out: Omit<ModelMetric, 'base'> = {
      id: m.id,
      name: m.name,
      dataset: m.datasetId,
      definition: m.definition, // verbatim: a snapshot (and its per), a funnel, a period's base metric id
      filters: some(m.filters),
      format: m.format,
      description: some(m.description),
      direction: m.direction,
      timeColumn: some(m.timeColumn),
      target: m.target, // verbatim; a target metric is named by id
    };
    put(`metrics/${mSlugs.get(m.id)}.json`, { ...out, base: objectBase(out) });
  }

  const tSlugs = slugsFor(terms);
  for (const t of terms) {
    const out: Omit<ModelTerm, 'base'> = { id: t.id, name: t.name, dataset: t.datasetId, aliases: some(t.aliases), description: some(t.description), filters: t.filters };
    put(`terms/${tSlugs.get(t.id)}.json`, { ...out, base: objectBase(out) });
  }

  const relationships = [...rels].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r): ModelRelationship => {
    const out: Omit<ModelRelationship, 'base'> = {
      id: r.id,
      from: { dataset: r.from.datasetId, column: r.from.column },
      to: { dataset: r.to.datasetId, column: r.to.column },
      cardinality: r.cardinality,
      label: r.label,
    };
    return { ...out, base: objectBase(out) };
  });
  if (relationships.length) put('relationships.json', { relationships });

  if (catalog.status && Object.keys(catalog.status).length) notCarried.add('status');
  if (catalog.instructions?.length) notCarried.add('instructions');
  const dir = projectDir(projectId);
  if (await hasRecords(path.join(dir, 'verified'), /\.json$/i)) notCarried.add('verifiedQuestions');
  if (await hasRecords(path.join(dir, 'connections'), /\.tables\.json$/i)) notCarried.add('sourceDocs');

  const manifest: ModelManifest = {
    format: MODEL_FORMAT,
    formatVersion: MODEL_VERSION,
    appVersion: (require('../../package.json') as { version: string }).version,
    project: { name: project?.name ?? '' },
    calendar: getCalendar(),
  };
  put('model.json', manifest);
  return {
    files,
    counts: { datasets: list.length, metrics: full.length, terms: terms.length, relationships: relationships.length },
    notCarried: NOT_CARRIED.filter((k) => notCarried.has(k)),
  };
}
