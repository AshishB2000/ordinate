// A metric's save and update, and the checks before them — MAIN (moved out of ./metrics.ts for semantic layer part 7,
// a2, so a model import is held to the editor's own checks and its apply writes through the same bodies).
//
// `metric:save` and `metric:update` call these and reply exactly what they return. The checks run in the editor's
// order: the name (another metric's, or a glossary term's name or alias: semantic D10), then part 5's (a period's base
// and own date, a funnel's columns, a snapshot's date and per), the date it counts by, and a target.

import * as metrics from '../analysis/metrics';
import { listFullTerms } from '../analysis/terms';
import { aliasCollision } from '../app/columnNames';
import { termNameTaken } from '../data/termMessages';
import { checkTarget } from './targetResolve';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import * as versions from '../app/versions';
import { settleOnSave, settleOnUpdate } from '../analysis/metricTimeScope';
import { snapshotProblem } from '../analysis/snapshotGuards';
import { contentTag, isRecordChanged } from '../app/editConflict';
import { checkPeriodDefinition } from './periodMetric';
import { checkFunnelDefinition } from './funnelMetric';
import * as datasets from '../data/datasets';
import { externalReadOnly } from '../engine/semanticMessages';
import { layerLabel, refuseLayer } from '../engine/live/semantic/semanticRefusals';
import * as msg from './metricSaveMessages';

/** The sentence a duplicate name is refused with — said by save, update and the editor's check alike. */
export function nameTakenMessage(name: unknown): string {
  return msg.metricNameTaken(String(name).trim());
}

/**
 * The sentence `name` is refused with among these metrics and terms, or null: `nameRefusal`'s rule over any set — the
 * project as stored, or a model import's names as they will be after it (src/app/modelGates.ts).
 */
export function nameRefusalAmong(name: unknown, list: readonly { id: string; name: string }[], terms: readonly { name: string; aliases?: string[] }[], exceptId?: string): string | null {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (list.some((m) => m.name.toLowerCase() === key && m.id !== exceptId)) return nameTakenMessage(name);
  const term = aliasCollision([String(name)], [...terms])?.column.name;
  return term ? termNameTaken(String(name).trim(), term) : null;
}

/**
 * Is this name already a metric in this project?
 *
 * A duplicate NAME is refused, not disambiguated: a formula references a metric
 * by name, so two called "Revenue" would make `[Revenue]` mean whichever one
 * sorted first — a figure that changes when a record is renamed somewhere else
 * entirely. Exported for scripts/test-metrics.ts.
 */
export async function nameTaken(projectId: string, name: unknown, exceptId?: string): Promise<boolean> {
  return (await nameRefusal(projectId, name, exceptId)) !== null;
}

/** The sentence a name is refused with — another metric's, or a glossary term's name or alias (semantic D10) — or null. */
export async function nameRefusal(projectId: string, name: unknown, exceptId?: string): Promise<string | null> {
  if (!String(name || '').trim()) return null;
  return nameRefusalAmong(name, await metrics.listMetrics(projectId), await listFullTerms(projectId), exceptId);
}

/** A refusal as the reply spreads it: the sentence and the box it belongs beside. */
export type MetricRefusal = { error: string; field: string };

/**
 * `metric:save`'s checks, in its order: the refusal, or the date the save settles on. `named`: the name's check (the
 * project as stored; a model import passes its own set). `excused`: the formula's parts a model import writes first
 * (lower-cased), left out of the date check: the save after theirs checks them.
 */
export async function metricProblem(
  projectId: string,
  raw: any, // any: the zod-checked input, read field by field (as the handler always read it)
  named: (name: unknown) => Promise<string | null> = (n) => nameRefusal(projectId, n),
  excused?: ReadonlySet<string>,
): Promise<{ problem: MetricRefusal } | { when: { timeColumn?: string } }> {
  // `field`: which box of the editor the sentence belongs beside.
  const taken = await named(raw.name);
  if (taken) return { problem: { error: taken, field: 'name' } };
  const onLayer = await layerFieldMetric(projectId, raw.datasetId, raw.definition); // part 7 b2: a layer's dataset measures its own metrics only
  if (onLayer) return { problem: { error: onLayer, field: 'definition' } };
  const per = (await checkPeriodDefinition(projectId, raw.datasetId, raw.definition, raw.timeColumn)) ?? (await checkFunnelDefinition(projectId, raw.datasetId, raw.definition)); if (per) return { problem: per };
  const snap = await snapshotProblem(projectId, raw.datasetId, raw.definition);
  if (snap) return { problem: { error: snap, field: 'snapshot' } };
  const when = await settleOnSave(projectId, raw, excused);
  if ('error' in when) return { problem: { error: when.error, field: 'timeColumn' } };
  const tg = await checkTarget(projectId, { ...raw, id: '', name: String(raw.name), definition: metrics.sanitizeDefinition(raw.definition), ...when }, raw.target); if (tg) return { problem: tg };
  return { when };
}

/** A column (or funnel) metric on a semantic dataset: refused `columnOnLayer` — aggregating a dimension here goes around the layer. */
export async function layerFieldMetric(projectId: string, datasetId: unknown, definition: unknown): Promise<string | null> {
  const meta = typeof datasetId === 'string' ? await datasets.getDatasetMeta(projectId, datasetId) : null;
  const sem = meta?.live?.semantic;
  const def = sem ? metrics.sanitizeDefinition(definition) : null;
  if (!meta || !sem || !def || !(metrics.isSimpleDefinition(def) || metrics.isFunnelDefinition(def))) return null;
  return refuseLayer('columnOnLayer', { dataset: meta.name, layer: layerLabel(sem.backend), column: metrics.isSimpleDefinition(def) ? def.column : def.funnel.event }).message;
}

/** An edit of a mirror's definition, or a filter on it, on its semantic dataset: refused, the layer's to change. Format, name, description and direction save. */
async function mirrorReadOnly(projectId: string, m: metrics.Metric, raw: { definition?: unknown; filters?: unknown }): Promise<MetricRefusal | null> {
  if (!metrics.isExternalDefinition(m.definition) || !(await datasets.getDatasetMeta(projectId, m.datasetId))?.live?.semantic) return null;
  const filtered = raw.filters !== undefined && sanitizeDashboardFilters(raw.filters).length > 0;
  if (raw.definition === undefined && !filtered) return null;
  return { error: externalReadOnly(layerLabel(m.definition.layer ?? '')), field: raw.definition !== undefined ? 'definition' : 'filters' };
}

/** `metric:save`'s body: the reply. */
export async function saveMetricChecked(projectId: string, input: unknown) { // the reply as it always was
  try {
    const raw: any = input && typeof input === 'object' ? input : {}; // any: the zod-checked input
    const checked = await metricProblem(projectId, raw);
    if ('problem' in checked) return { ok: false, ...checked.problem };
    const { when } = checked;
    const m = await metrics.saveMetric(projectId, {
      ...raw,
      filters: sanitizeDashboardFilters(raw.filters),
      ...when,
    });
    if (!m) return { ok: false, error: msg.metricNotSaved() };
    await versions.record(projectId, 'metric', m);
    return { ok: true, metric: m };
  } catch (err: any) { // any: whatever a store threw
    return { ok: false, error: err?.message || msg.metricSaveFailed() };
  }
}

/** `metric:update`'s body: the reply. `base`: the editor's content tag — a stale copy is 409 record_changed (src/app/editConflict.ts); `tag` is the next base. */
export async function updateMetricChecked(projectId: string, id: string, patch: unknown, base?: unknown) { // the reply as it always was
  try {
    const raw: any = patch && typeof patch === 'object' ? patch : {}; // any: the zod-checked patch
    const taken = raw.name !== undefined ? await nameRefusal(projectId, raw.name, id) : null;
    if (taken) return { ok: false, error: taken, field: 'name' };
    const before = await metrics.getMetric(projectId, id);
    const readOnly = before ? await mirrorReadOnly(projectId, before, raw) : null; // a mirror's definition and filters are its layer's (D13)
    if (readOnly) return { ok: false, ...readOnly };
    const per = before && (raw.definition !== undefined || raw.timeColumn !== undefined) ? (await checkPeriodDefinition(projectId, before.datasetId, raw.definition ?? before.definition, raw.timeColumn)) ?? (await checkFunnelDefinition(projectId, before.datasetId, raw.definition ?? before.definition)) : null; if (per) return { ok: false, ...per };
    const snap = before ? await snapshotProblem(projectId, before.datasetId, raw.definition) : null;
    if (snap) return { ok: false, error: snap, field: 'snapshot' };
    const when = before ? await settleOnUpdate(projectId, before, raw) : {};
    if ('error' in when) return { ok: false, error: when.error, field: 'timeColumn' };
    const next = { ...raw, ...when };
    const tg = before && raw.target ? await checkTarget(projectId, { ...before, ...next, definition: next.definition !== undefined ? metrics.sanitizeDefinition(next.definition) : before.definition }, raw.target) : null; if (tg) return { ok: false, ...tg };
    if (raw.filters !== undefined) next.filters = sanitizeDashboardFilters(raw.filters);
    const m = await metrics.updateMetric(projectId, id, next, base);
    if (!m) return { ok: false, error: msg.metricNotFound() };
    await versions.record(projectId, 'metric', m, { before });
    return { ok: true, metric: m, tag: contentTag('metric', m) };
  } catch (err: any) { // any: whatever a store threw
    if (isRecordChanged(err)) throw err; // the route's 409
    return { ok: false, error: err?.message || msg.metricUpdateFailed() };
  }
}
