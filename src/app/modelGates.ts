// The editor's own checks, asked of a planned import (semantic layer part 7, a2; docs/semantic-layer/07-portability.md
// D5): each object is checked by the function its save path uses and refused with that function's sentence, so an
// import never stores what the editor would refuse. Nothing here writes.
//
// Names are checked against the names AFTER the import (`PostNames`): the project's, with each object the import
// writes in its file form, so two file objects that would collide are refused too, and a swap of two names is not.
// A check that reads the store for what an object names (a period's base, a target's plan metric) runs only when
// everything it names exists already: one that names an object this import creates is checked by its save, when the
// apply writes it after what it names.

import type { DatasetMeta } from '../data/datasets';
import * as datasets from '../data/datasets';
import { keyNotAColumn } from './tableDocMessages';
import { labelsRefusal } from './columnLabelAccess';
import { valueLabelProblem } from '../analysis/valueLabels';
import { valueLabelProblemText } from '../analysis/valueLabelMessages';
import { columnNamesRefusal } from './catalog';
import { aliasCollision, sanitizeAliases } from './columnNames';
import { stableStringify } from '../engine/queryCache';
import { baseFiltersRefusal } from '../ipc/liveBaseFilters';
import { labelClash, type Relationship } from '../analysis/relationships';
import { labelTaken } from '../analysis/joinMessages';
import { termProblem } from '../analysis/terms';
import { termNameTaken } from '../data/termMessages';
import { isExternalDefinition, isFormulaDefinition, sanitizeDefinition, type MetricDefinition } from '../analysis/metrics';
import { checkMetricFormula, type KnownMetric } from '../analysis/metricCheck';
import { compileMetricFormula } from '../analysis/metricFormula';
import { relatedColumnNames } from '../ipc/relationships';
import { metricProblem, nameRefusalAmong } from '../ipc/metricSave';
import { modelExternalMetric, modelObjectUnreadable } from './modelFileMessages';
import type { ModelField, ModelMetric, ModelRelationship, ModelTerm } from './modelFormat';

type Columns = DatasetMeta['columns'];

/** A table doc's key must be a column the dataset has now (`catalog:setTable`). */
export function tableRefusal(columns: Columns, key: unknown): string | null {
  return typeof key === 'string' && key && !columns.some((c) => c.name === key) ? keyNotAColumn(key) : null;
}

/**
 * A field doc, as `catalog:setColumn` checks one: labels on a text column, a label list a reader would keep whole, and
 * names no other column answers to. `post`: the dataset's field docs after the import; `here`: the doc stored now.
 */
export function fieldRefusal(columns: Columns, f: ModelField, here: ModelField | undefined, post: readonly ModelField[]): string | null {
  if (f.values?.length) {
    const refusal = labelsRefusal(columns, f.name);
    if (refusal) return refusal;
    const problem = valueLabelProblem(f.values);
    if (problem) return valueLabelProblemText(problem);
  }
  const others = columns.filter((c) => c.name !== f.name).map((c) => {
    const d = post.find((x) => x.name === c.name);
    return { name: c.name, ...(d && { displayName: d.displayName ?? '', aliases: d.aliases ?? [] }) };
  });
  const aliases = stableStringify(f.aliases ?? []) !== stableStringify(here?.aliases ?? []) ? sanitizeAliases(f.aliases ?? [], f.name) : undefined;
  const renamed = !!f.displayName && f.displayName !== (here?.displayName ?? '');
  return columnNamesRefusal(aliases, renamed ? (f.displayName as string) : '', others);
}

/** Base filters, as `live:setBaseFilters` checks them against the Live dataset's declared columns. */
export function baseFilterRefusal(meta: DatasetMeta, steps: unknown): string | null {
  const r = baseFiltersRefusal(meta, steps);
  return 'error' in r ? r.error : null;
}

/** As `relationship:save`'s checks run: two datasets, a label no other edge between them has, both columns there. */
export function relationshipRefusal(r: ModelRelationship, id: string, from: DatasetMeta | null, to: DatasetMeta | null, post: readonly Relationship[]): { error: string } | 'column_missing' | null {
  if (r.from.dataset === r.to.dataset) return { error: modelObjectUnreadable() };
  const rel: Relationship = { id, from: { datasetId: r.from.dataset, column: r.from.column }, to: { datasetId: r.to.dataset, column: r.to.column }, cardinality: r.cardinality, ...(r.label && { label: r.label }), verified: { matched: 0, unmatchedFrom: 0 } };
  const clash = labelClash([...post], rel);
  if (clash) return { error: labelTaken(clash) };
  return from?.columns.some((c) => c.name === r.from.column) && to?.columns.some((c) => c.name === r.to.column) ? null : 'column_missing';
}

/** The metrics and terms of the project as they will be after the import; `id`: the project's, or the file's for a new one. */
export interface PostNames {
  metrics: Array<{ id: string; name: string; dataset: string; definition: MetricDefinition }>;
  terms: Array<{ id: string; name: string; aliases: string[] }>;
}

/** A term, as `term:save`/`term:update` check one (`termProblem`), its names against the names after the import. */
export async function termRefusal(projectId: string, t: ModelTerm, selfId: string, post: PostNames): Promise<string | null> {
  const name = t.name.trim();
  const others = [...post.metrics.map((m) => ({ name: m.name })), ...post.terms.filter((x) => x.id !== selfId)];
  for (const said of [[name], sanitizeAliases(t.aliases ?? [], name)]) {
    const hit = aliasCollision(said.filter((n) => n.trim()), others);
    if (hit) return termNameTaken(hit.alias, hit.column.name);
  }
  return (await termProblem(projectId, { datasetId: t.dataset, filters: t.filters }))?.error ?? null;
}

/** `metric:check`'s verdict on a formula, over the metrics after the import. */
async function formulaRefusal(projectId: string, m: ModelMetric, selfId: string, post: PostNames): Promise<string | null> {
  if (!isFormulaDefinition(m.definition)) return null;
  const columnsOf = new Map<string, string[]>();
  const names = async (datasetId: string): Promise<string[]> => {
    if (!columnsOf.has(datasetId)) columnsOf.set(datasetId, ((await datasets.getDatasetMeta(projectId, datasetId))?.columns ?? []).map((c) => c.name));
    return columnsOf.get(datasetId) as string[];
  };
  const known = new Map<string, KnownMetric>();
  for (const pm of post.metrics) {
    if (pm.id === selfId) continue;
    const compiled = isFormulaDefinition(pm.definition) ? compileMetricFormula(pm.definition.formula, await names(pm.dataset)) : null;
    known.set(pm.name.toLowerCase(), { name: pm.name, datasetId: pm.dataset, refs: compiled?.ok ? compiled.program.metricRefs : [] });
  }
  const meta = await datasets.getDatasetMeta(projectId, m.dataset);
  const verdict = checkMetricFormula({
    expression: m.definition.formula,
    datasetId: m.dataset,
    columns: (meta?.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
    related: await relatedColumnNames(projectId, m.dataset),
    metrics: known,
    self: m.name.trim() || undefined,
  });
  return verdict.ok ? null : verdict.error ?? modelObjectUnreadable();
}

/**
 * A metric, as its save checks one (`metricProblem`, moved out of `metric:save`) and as the editor checks its formula
 * (`metric:check`), its name against the names after the import. `pending`: it names an object this import creates.
 */
export async function metricRefusal(projectId: string, m: ModelMetric, selfId: string, post: PostNames, pending: boolean): Promise<string | null> {
  if (isExternalDefinition(sanitizeDefinition(m.definition))) return modelExternalMetric(m.name); // D13: a layer's metric is never written from a file
  const named = nameRefusalAmong(m.name, post.metrics, post.terms, selfId);
  if (named) return named;
  const formula = await formulaRefusal(projectId, m, selfId, post);
  if (formula || pending) return formula;
  const checked = await metricProblem(projectId, { name: m.name, datasetId: m.dataset, definition: m.definition, filters: m.filters, timeColumn: m.timeColumn, target: m.target }, async () => null);
  return 'problem' in checked ? checked.problem.error : null;
}
