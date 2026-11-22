// Checking a drafted definition AS A PERSON (docs/metric-proposals/00-design.md, "A draft is checked twice"): the
// proposer at proposal, the approving editor at approval. Only structure is checked and nothing is computed. The columns
// a draft may use are those of a dataset the person opens now, minus `hiddenColumnsFor`: a hidden column is an unknown
// column. A failed check is returned as its sentence, never repaired.

import * as datasets from '../../data/datasets';
import * as metrics from '../../analysis/metrics';
import { listFullTerms, sanitizeTermFilters } from '../../analysis/terms';
import { checkMetricFormula } from '../../analysis/metricCheck';
import { hiddenColumnsFor } from '../../data/rowAccess';
import { NUMBER_AGGREGATIONS } from '../../data/aggregations';
import { nameRefusalAmong } from '../../ipc/metricSave';
import { knownMetrics } from '../../ipc/metricCheck';
import { opens } from '../authz/folderGate';
import { isValidId } from '../../app/ids';
import type { DraftIn } from '../../ai/proposalDraft';
import { FIGURE_RE } from '../../app/instructions';
import * as say from '../proposalMessages';
import type { StoredDraft } from './store';

export interface VisibleDataset { id: string; name: string; columns: Array<{ name: string; type: string }> }

/** The dataset `id`, only when the caller opens it, with the columns they may use (never a hidden one). */
export async function visibleDataset(projectId: string, id: string): Promise<VisibleDataset | null> {
  if (!isValidId(id) || !(await opens(projectId, 'dataset', id))) return null;
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta) return null;
  const hidden = await hiddenColumnsFor(projectId, id);
  return { id: meta.id, name: meta.name, columns: meta.columns.filter((c) => !hidden.has(c.name)).map((c) => ({ name: c.name, type: c.type })) };
}

/** A dataset by NAME among the ones the caller may list (case-insensitive), then through `visibleDataset`. */
async function byName(projectId: string, name: string): Promise<VisibleDataset | null> {
  const key = name.trim().toLowerCase();
  const hit = (await datasets.listDatasets(projectId)).find((d) => d.name.trim().toLowerCase() === key);
  return hit ? visibleDataset(projectId, hit.id) : null;
}

export type Checked = { ok: true; draft: StoredDraft } | { ok: false; error: string };

/**
 * `raw` as the caller may write it: its dataset resolved (an id when it has one, else a name), the formula parsed, the
 * columns visible, the name free among what the caller can list. `named: false` leaves the name's check to the save
 * (approval: the editor's own save checks the whole project).
 */
export async function checkDraft(projectId: string, raw: DraftIn, named = true): Promise<Checked> {
  const ds = raw.datasetId ? await visibleDataset(projectId, raw.datasetId) : await byName(projectId, raw.dataset ?? '');
  if (!ds) return { ok: false, error: say.datasetNotFound(raw.dataset ?? '') };
  const name = raw.name.trim();
  if (!name) return { ok: false, error: say.nameEmpty() };
  if ([name, raw.description, ...raw.aliases].some((s) => FIGURE_RE.test(s))) return { ok: false, error: say.figureInDraft() };
  const visible = new Map(ds.columns.map((c) => [c.name, c.type]));
  const base = { name, datasetId: ds.id, description: raw.description.trim(), aliases: [...new Set(raw.aliases.map((a) => a.trim()).filter(Boolean))] };
  if (named) {
    const [list, terms] = [await metrics.listMetrics(projectId), await listFullTerms(projectId)];
    // What the proposer may list only: a name in a folder closed to them is not told (the editor's save checks the project).
    const clash = [name, ...base.aliases].map((n) => nameRefusalAmong(n, list, terms)).find(Boolean);
    if (clash) return { ok: false, error: clash };
  }
  if (raw.kind === 'term') {
    const steps = raw.filters.map((f) => ({ type: 'filter', column: f.column, op: f.op, ...(f.values ? { values: f.values } : { value: f.value }) }));
    const filters = sanitizeTermFilters(steps);
    if (filters.length !== steps.length) return { ok: false, error: say.badDraft() };
    const gone = filters.find((f) => !visible.has(f.column));
    if (gone) return { ok: false, error: say.columnNotUsable(gone.column, ds.name) };
    return { ok: true, draft: { kind: 'term', ...base, filters } };
  }
  const format = raw.format ? { format: raw.format } : {};
  if (raw.formula !== undefined) {
    const verdict = checkMetricFormula({
      expression: raw.formula, datasetId: ds.id, columns: ds.columns, related: [], metrics: await knownMetrics(projectId, undefined), self: name,
    });
    if (!verdict.ok) return { ok: false, error: say.badFormula(verdict.error ?? '') };
    return { ok: true, draft: { kind: 'metric', ...base, formula: raw.formula, ...format } };
  }
  const type = visible.get(raw.column ?? '');
  if (type === undefined) return { ok: false, error: say.columnNotUsable(raw.column ?? '', ds.name) };
  if ((NUMBER_AGGREGATIONS as readonly string[]).includes(raw.aggregation ?? '') && type !== 'number') return { ok: false, error: say.notANumber(raw.column ?? '') };
  return { ok: true, draft: { kind: 'metric', ...base, column: raw.column, aggregation: raw.aggregation, ...format } };
}
