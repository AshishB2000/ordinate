// The Ossie export (semantic layer part 7, g1; docs/semantic-layer/ossie-mapping.md): the model files (./modelExport,
// so its whitelist: no origin, rule, secret or row) written as one Ossie document, plus a report of everything that did
// not map. Pinned to the spec version read on the day; a later version is a new PR. Stores nothing.

import { slugsFor, modelJson, type ModelDataset, type ModelField, type ModelManifest, type ModelMetric, type ModelRelationship, type ModelTerm } from './modelFormat';
import { exportModel } from './modelExport';
import { ossieInputs, type OssieInputs } from './ossieSources';
import { ossieWhy } from './ossieMessages';
import { sanitizeCalendar } from '../analysis/dateIntel';
import { stableStringify } from '../engine/queryCache';
import { isSimpleDefinition } from '../analysis/metrics';

export const OSSIE_SPEC_VERSION = '0.2.0.dev0';

export interface OssieReport {
  notMapped: Array<{ kind: string; name: string; reason: string }>;
  /** Dataset names whose `source` is not a warehouse table (the document holds the dataset's own name there). */
  noSource: string[];
}

type Json = Record<string, unknown>;
const AGG_SQL: Record<string, (c: string) => string> = {
  sum: (c) => `SUM(${c})`, avg: (c) => `AVG(${c})`, min: (c) => `MIN(${c})`, max: (c) => `MAX(${c})`, count: (c) => `COUNT(${c})`, countd: (c) => `COUNT(DISTINCT ${c})`,
};
const TYPE: Record<string, string> = { text: 'String', date: 'Date' }; // `number` has no single Ossie type: left out
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const some = <T>(v: T[]): T[] | undefined => (v.length ? v : undefined);
/** A column or field name as SQL: bare when it is a plain identifier, else double-quoted. */
const ident = (n: string): string => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`);

function read<T>(files: ReadonlyMap<string, string>, dir: string): T[] {
  return [...files.keys()].filter((p) => p.startsWith(dir + '/') && p.endsWith('.json')).sort().map((p) => JSON.parse(files.get(p) as string) as T);
}
const strip = <T extends object>(o: T): Json => { const { id: _i, base: _b, ...rest } = o as Json; return rest; };

export function toOssie(files: ReadonlyMap<string, string>, inputs: OssieInputs): { text: string; report: OssieReport } {
  const dsets = read<ModelDataset>(files, 'datasets');
  const metrics = read<ModelMetric>(files, 'metrics');
  const terms = read<ModelTerm>(files, 'terms');
  const rels: ModelRelationship[] = files.has('relationships.json') ? JSON.parse(files.get('relationships.json') as string).relationships : [];
  const manifest = JSON.parse(files.get('model.json') as string) as ModelManifest;
  const report: OssieReport = { notMapped: [], noSource: [] };
  const miss = (kind: string, name: string, reason: string): void => void report.notMapped.push({ kind, name, reason });
  const ext: Json = {};
  const keep = (k: string, v: unknown): void => void ((ext[k] ??= []) as unknown[]).push(v);

  const names = new Map([...slugsFor(dsets)].map(([id, s]) => [id, s.replace(/-/g, '_')]));
  const slugOf = (id: string): string => names.get(id) as string;
  const fileSlugs = slugsFor(dsets);
  const colsOf = (d: ModelDataset) => inputs.columns.get(d.id) ?? [];
  const datasets: Json[] = [];

  for (const d of [...dsets].sort(byName)) {
    const docs = new Map((d.fields ?? []).map((f) => [f.name, f]));
    const timeCols = new Set(metrics.filter((m) => m.dataset === d.id && m.timeColumn).map((m) => m.timeColumn));
    const fields = colsOf(d).map((c) => {
      const f: ModelField | undefined = docs.get(c.name);
      const syn = [f?.displayName, ...(f?.aliases ?? [])].filter((s): s is string => !!s);
      const ai: Json = { synonyms: some(syn), examples: f?.example ? [f.example] : undefined };
      if (f?.values?.length) { miss('valueLabels', c.name, ossieWhy.valueLabels()); keep('valueLabels', { dataset: d.name, field: c.name, values: f.values }); }
      if (f?.sensitivity) miss('sensitivity', c.name, ossieWhy.sensitivity());
      return {
        name: c.name, expression: { sql: ident(c.name) }, description: f?.description, datatype: TYPE[c.type],
        ai_context: Object.values(ai).some((v) => v !== undefined) ? ai : undefined,
        dimension: timeCols.has(c.name) ? { is_time: true } : undefined,
      };
    });
    const taken = new Set(fields.map((f) => f.name));
    const dm: Json[] = [];
    for (const m of metrics.filter((x) => x.dataset === d.id).sort(byName)) {
      const def = isSimpleDefinition(m.definition) && AGG_SQL[m.definition.aggregation] ? m.definition : undefined;
      const why = !def ? ossieWhy.metricFormula()
        : def.snapshot ? ossieWhy.metricSnapshot()
        : m.filters?.length ? ossieWhy.metricFilters()
        : d.baseFilters?.length ? ossieWhy.metricBaseFilters() // `source` is the whole table: the figure would be another number
        : undefined;
      if (!def || why) { miss('metric', m.name, why as string); keep('metrics', { ...strip(m), dataset: d.name }); continue; }
      let name = m.name; // a metric shares its dataset's namespace with the fields
      while (taken.has(name)) name += ' (metric)';
      taken.add(name);
      dm.push({ name, expression: { sql: AGG_SQL[def.aggregation](ident(def.column)) }, description: m.description });
      if (m.timeColumn) miss('metricDate', m.name, ossieWhy.metricDate());
      if (m.direction || m.target || m.format.kind !== 'number' || m.format.prefix || m.format.suffix) { miss('metricSettings', m.name, ossieWhy.metricSettings()); keep('metricSettings', { metric: m.name, format: m.format, direction: m.direction, target: m.target }); }
    }
    for (const t of terms.filter((x) => x.dataset === d.id).sort(byName)) { miss('term', t.name, ossieWhy.term()); keep('terms', { ...strip(t), dataset: d.name }); }
    if (d.baseFilters?.length) { miss('baseFilters', d.name, ossieWhy.baseFilters()); keep('baseFilters', { dataset: d.name, filters: d.baseFilters }); }
    if (d.role) miss('role', d.name, ossieWhy.role());
    const source = inputs.sources.get(d.id);
    if (!source) report.noSource.push(d.name);
    const guide = files.get(`datasets/${(fileSlugs.get(d.id) as string)}.md`);
    const syn = slugOf(d.id) === d.name.toLowerCase() ? [] : [d.name];
    const ai: Json = { instructions: guide, synonyms: some(syn) };
    datasets.push({
      name: slugOf(d.id), source: source ?? slugOf(d.id),
      primary_key: d.key && taken.has(d.key) ? [d.key] : undefined,
      description: [d.description, d.grain].filter(Boolean).join('. ') || undefined,
      ai_context: Object.values(ai).some((v) => v !== undefined) ? ai : undefined,
      fields, metrics: some(dm),
    });
  }
  report.noSource.sort();

  const relationships: Array<Json & { name: string }> = [];
  const usedRel = new Set<string>();
  for (const r of rels) {
    if (!names.has(r.from.dataset) || !names.has(r.to.dataset)) { miss('relationship', r.label ?? r.id, ossieWhy.relationship()); continue; }
    let name = (r.label ? r.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : '') || `${slugOf(r.from.dataset)}_to_${slugOf(r.to.dataset)}`;
    while (usedRel.has(name)) name += '_2';
    usedRel.add(name);
    if (r.cardinality === 'one_to_one') miss('cardinality', name, ossieWhy.cardinality());
    relationships.push({ name, from: slugOf(r.from.dataset), to: slugOf(r.to.dataset), from_columns: [r.from.column], to_columns: [r.to.column], ai_context: r.label ? { synonyms: [r.label] } : undefined });
  }
  // A calendar the project never changed says nothing worth reporting.
  if (stableStringify(manifest.calendar) !== stableStringify(sanitizeCalendar({}))) { miss('calendar', 'Calendar', ossieWhy.calendar()); ext.calendar = manifest.calendar; }
  report.notMapped.sort((a, b) => (a.kind + a.name < b.kind + b.name ? -1 : a.kind + a.name > b.kind + b.name ? 1 : 0));

  const doc = {
    version: OSSIE_SPEC_VERSION,
    name: manifest.project.name || 'Ordinate project',
    datasets,
    relationships: some(relationships.sort(byName)),
    custom_extensions: [{ vendor_name: 'ordinate', data: JSON.stringify(JSON.parse(modelJson(ext))) }],
  };
  return { text: modelJson(doc), report };
}

/** The project's Ossie file and report. A caller row access rules restrict is refused by exportModel (ModelExportRefused). */
export async function ossieExport(projectId: string): Promise<{ text: string; report: OssieReport }> {
  const { files } = await exportModel(projectId);
  return toOssie(files, await ossieInputs(projectId));
}
