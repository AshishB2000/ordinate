// A dbt translation (./dbtImport.ts) through a2's dry run and a3's apply (semantic layer part 7, f1;
// docs/semantic-layer/07-portability.md D10, D4). What a dbt file differs in from model files, and only that:
// - it is a COPY of what dbt says, so a key dbt does not carry is this project's, never cleared: a table's role, grain,
//   description, guide and base filters, a field's other names, example, values and mark, a metric's format,
//   direction and target (`keepHere`);
// - a metric it imported is found again by its `importedFrom` tag, even after a rename here (./modelMatch.ts), so the
//   project's tags are read for the compare (`withImportTags`);
// - each semantic model's dataset is an item (marked when matched by a blind name), and every dbt object the
//   translation skipped is one, with its reason (`dbtItems`); a metric whose model has no dataset falls with that
//   dataset, as a2 says a missing one.

import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { getMetric } from '../analysis/metrics';
import { objectBase, type ModelDataset, type ModelField, type ModelMetric } from './modelFormat';
import { translateDbt, type DbtKind, type DbtSkipped } from './dbtImport';
import type { ModelMatch } from './modelMatch';
import type { ParsedModel } from './modelRead';
import type { PlanItem, PlanKind } from './modelPlan';

/** The upload's JSON as model files, over this project's datasets (their columns and Live flag, never a row). */
export async function dbtModel(projectId: string, json: unknown, datasetMap: Readonly<Record<string, string>>): Promise<ParsedModel> {
  const metas = await Promise.all((await datasets.listDatasets(projectId)).map((d) => datasets.getDatasetMeta(projectId, d.id)));
  const list = metas.filter((m) => !!m).map((m) => ({ id: m.id, name: m.name, columns: m.columns, ...(isLive(m) && { live: true }) }));
  return translateDbt(json, list, datasetMap).model;
}

/** The project's metrics with their stored `importedFrom`: the export never writes it, so a2 reads it here, for a dbt file only. */
export async function withImportTags(projectId: string, here: ParsedModel): Promise<ParsedModel> {
  const metrics = await Promise.all(here.metrics.map(async (pm) => {
    const tag = (await getMetric(projectId, pm.id))?.importedFrom;
    return tag ? { ...pm, importedFrom: tag } : pm;
  }));
  return { ...here, metrics };
}

const content = <T extends object>(o: T | undefined): Partial<T> => {
  const { base: _b, id: _i, ...rest } = (o ?? {}) as T & { base?: unknown; id?: unknown };
  return rest as Partial<T>;
};

/** The translation with every key dbt does not carry taken from the project object it lands on. */
export function keepHere(file: ParsedModel, here: ParsedModel, m: ModelMatch): ParsedModel {
  const guides = new Map(file.guides);
  const datasetsOut = file.datasets.map((fd): ModelDataset => {
    const pd = here.datasets.find((d) => d.id === m.datasets.get(fd.id));
    if (!pd) return fd;
    const guide = here.guides.get(pd.id);
    if (guide) guides.set(fd.id, guide);
    const { fields: _f, base: _b, id: _i, name: _n, key: hereKey, ...docs } = pd;
    const fields = fd.fields?.map((ff): ModelField => ({ ...content(pd.fields?.find((f) => f.name === ff.name)), ...ff }));
    const key = fd.key ?? hereKey;
    return { ...docs, id: fd.id, name: fd.name, base: '', ...(key !== undefined && { key }), ...(fields?.length && { fields }) };
  });
  const metrics = file.metrics.map((fm): ModelMetric => {
    const pm = here.metrics.find((x) => x.id === m.metrics.get(fm.id));
    if (!pm) return fm;
    const description = fm.description ?? pm.description;
    return { ...fm, format: pm.format, ...(pm.direction && { direction: pm.direction }), ...(pm.target && { target: pm.target }), ...(description && { description }) };
  });
  return { ...file, datasets: datasetsOut, guides, metrics };
}

const KIND: Record<DbtKind, PlanKind> = { metric: 'metric', dimension: 'field', entity: 'table', semanticModel: 'dataset' };
const keyOf = (s: Pick<DbtSkipped, 'kind' | 'dbt'>): string => `${KIND[s.kind]}:dbt:${s.dbt}`;

/** Each semantic model's dataset, and each dbt object the translation skipped, as plan items. */
export function dbtItems(file: ParsedModel, datasetName: (id: string) => string): PlanItem[] {
  const src = file.dbt;
  if (!src) return [];
  const items: PlanItem[] = [];
  for (const mm of src.models) {
    if (!mm.datasetId) continue; // a2 lists it as missing, with what names it
    items.push({
      key: `dataset:${mm.datasetId}`, kind: 'dataset', name: mm.name, status: 'unchanged', targetId: mm.datasetId,
      ...(mm.how === 'name' && { changes: [{ field: 'matchedByName', here: datasetName(mm.datasetId) }] }),
      fileHash: objectBase({ model: mm.name, how: mm.how }), hereHash: mm.datasetId,
    });
  }
  const missing = (model: string | undefined): string => `dataset:${file.datasets.find((d) => d.name === model)?.id ?? ''}`;
  for (const s of src.skipped) {
    if (s.kind === 'semanticModel') continue;
    const base = { key: keyOf(s), kind: KIND[s.kind], name: s.name, status: 'skipped' as const, fileHash: objectBase(s), hereHash: '' };
    if (s.because) items.push({ ...base, reason: 'depends_on_skipped', because: keyOf({ kind: 'metric', dbt: s.because }) });
    else if (s.reason === 'no_dataset') items.push({ ...base, reason: 'depends_on_skipped', because: missing(s.model) });
    else items.push({ ...base, reason: s.reason });
  }
  return items;
}
