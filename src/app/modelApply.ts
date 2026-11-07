// Applying a model import (semantic layer part 7, a3; docs/semantic-layer/07-portability.md D4–D6): what a2's dry run
// planned, written object by object through each store's own save. STATELESS (any pod): the upload is planned again
// here, and a plan whose hash moved since the dry run is refused whole, before anything is written.
//
// Order, so that what an object names is written before it: table and field docs (ONE locked catalog write) → a Live
// dataset's base filters → relationships (a filter step's `via`) → terms (a metric's term step) → metrics (a new metric
// after any new metric it names: a period's base, a target's plan metric).
// - Each object is compared with the plan's `hereHash` when it is written: catalog docs inside the catalog's lock, terms
//   and metrics as their editor's `base` (lockedUpdate). One edited since the dry run fails `moved`; the rest still land.
// - New objects get fresh ids from their stores, never the file's (a pod's ids stay unique across projects), and what
//   is written after them names those ids. An update sends only the keys that changed, so a metric's tree (and anything
//   a later format adds) stays as it is.
// - A conflict is written only when the person picked the file's side; the save then checks its names as it writes.
// - No multi-record transaction: the reply lists what was written and what failed, and a re-run re-plans (what landed
//   is then unchanged). Metrics and terms keep a version (their saves record one); the catalog and relationships keep
//   none, so before the first write `io.before` offers the model as it was. Nothing to write: nothing at all is written.

import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { listRelationships } from '../analysis/relationships';
import { isRecordChanged } from './editConflict';
import { mutateCatalog, osUser, sanitizeCatalog } from './catalog';
import { getTableDoc, sanitizeTableDoc } from './tableDocs';
import { logger } from './logger';
import { fieldOf, relationshipOf, tableDocOf } from './modelExport';
import { objectBase, type ModelDataset, type ModelMetric, type ModelRelationship, type ModelTerm } from './modelFormat';
import { mapRefs, type ModelMatch } from './modelMatch';
import { planDetailed, type Mapped, type PlanItem, type PlanStatus } from './modelPlan';
import { formulaNames } from './dbtPlan';
import type { ParsedModel } from './modelRead';
import { modelObjectMoved, modelPlanChanged, modelWriteFailed } from './modelFileMessages';
import { saveMetricChecked, updateMetricChecked } from '../ipc/metricSave';
import { saveTermChecked, updateTermChecked } from '../ipc/terms';
import { saveRelationshipChecked } from '../ipc/relationships';
import { setLiveBaseFilters } from '../ipc/liveBaseFilters';
import { countedAfterSave, recheckRelationshipsTo } from '../ipc/tableDocs';

export type ApplyChoice = 'file' | 'here';
export interface ApplyFailure { key: string; error: string }
export type ApplyReply =
  | { ok: true; written: string[]; failed: ApplyFailure[]; before?: { downloadToken: string } }
  | { ok: false; code: 'plan_changed'; error: string };

export interface ApplyIo {
  /** Offers the project's model as it is now (a download token), before the first write. Absent: no download (MCP: git is the undo). */
  before?: () => Promise<string>;
  /** A test seam: runs before each object's write. */
  onBeforeWrite?: (key: string) => Promise<unknown>;
}

const LANDS: ReadonlySet<PlanStatus> = new Set<PlanStatus>(['updated', 'renamed', 'new']);
/** An absent key in the files, as each store clears it. */
const CLEARED: Record<string, unknown> = { description: '', aliases: [], filters: [], direction: null, timeColumn: '', target: null };

type Out = { written: string[]; failed: ApplyFailure[] };
type Json = Record<string, unknown>;

/** An update's patch: only the keys that changed. */
function patchOf(item: PlanItem, value: object): Json {
  const v = value as Json;
  return Object.fromEntries((item.changes ?? []).map((c) => [c.field, v[c.field] !== undefined ? v[c.field] : CLEARED[c.field]]));
}

/** Runs one object's write and files it as written or failed: `write` answers the save's refusal, or null. */
async function one(item: PlanItem, out: Out, io: ApplyIo, write: () => Promise<string | null>): Promise<void> {
  await io.onBeforeWrite?.(item.key);
  let error: string | null;
  try {
    error = await write();
  } catch (err) {
    if (isRecordChanged(err)) error = modelObjectMoved();
    else {
      logger.error('[modelApply] an object was not written:', err instanceof Error ? err.message : 'failed');
      error = modelWriteFailed();
    }
  }
  if (error) out.failed.push({ key: item.key, error });
  else out.written.push(item.key);
}

/** Every table and field doc in ONE locked catalog write, each compared with its `hereHash` inside the lock. */
async function writeCatalog(projectId: string, file: ParsedModel, items: PlanItem[], out: Out, io: ApplyIo): Promise<void> {
  if (!items.length) return;
  for (const item of items) await io.onBeforeWrite?.(item.key);
  const done: Out = { written: [], failed: [] };
  const keyed: string[] = [];
  try {
    await mutateCatalog(projectId, (cat) => {
      const updatedBy = osUser();
      const updatedAt = new Date().toISOString();
      for (const item of items) {
        const target = item.targetId as string;
        const fd = file.datasets.find((d) => d.id === item.key.split(':')[1]) as ModelDataset;
        const changed = new Set((item.changes ?? []).map((c) => c.field));
        if (item.kind === 'table') {
          if (objectBase(tableDocOf(cat, target)) !== item.hereHash) {
            done.failed.push({ key: item.key, error: modelObjectMoved() });
            continue;
          }
          const ref = `dataset:${target}`;
          if (changed.has('description')) cat.records[ref] = { ...(Object.hasOwn(cat.records, ref) ? cat.records[ref] : { tags: [], owner: '' }), description: fd.description ?? '', updatedBy, updatedAt };
          if (['role', 'key', 'grain', 'guide'].some((k) => changed.has(k))) {
            const cur = cat.tables?.[target] ?? sanitizeTableDoc({});
            const key = fd.key ?? '';
            (cat.tables ??= Object.create(null) as NonNullable<typeof cat.tables>)[target] = sanitizeTableDoc({
              ...cur, role: fd.role ?? '', key, grain: fd.grain ?? '', guide: file.guides.get(fd.id) ?? '', keyCheck: key === cur.key ? cur.keyCheck : undefined, updatedBy, updatedAt,
            });
            if (key !== cur.key) keyed.push(target);
          }
        } else {
          const column = item.key.slice(`field:${fd.id}:`.length);
          const cols = (cat.columns[target] ??= Object.create(null) as (typeof cat.columns)[string]);
          const cur = cols[column];
          if (objectBase((cur && fieldOf(column, cur)) ?? {}) !== item.hereHash) {
            done.failed.push({ key: item.key, error: modelObjectMoved() });
            continue;
          }
          const f = fd.fields?.find((x) => x.name === column);
          cols[column] = {
            ...cur, description: f?.description ?? '', displayName: f?.displayName ?? '', aliases: f?.aliases ?? [], example: f?.example ?? '',
            sensitivity: f?.sensitivity ?? cur?.sensitivity ?? 'none', values: f?.values, updatedBy, updatedAt, // a mark never falls
          };
        }
        done.written.push(item.key);
      }
      Object.assign(cat, sanitizeCatalog(cat)); // the store's own sanitizer over what was set: stored as every save stores it
    });
  } catch (err) {
    logger.error('[modelApply] the catalog was not written:', err instanceof Error ? err.message : 'failed');
    out.failed.push(...items.map((i) => ({ key: i.key, error: modelWriteFailed() })));
    return;
  }
  out.written.push(...done.written);
  out.failed.push(...done.failed);
  // As `catalog:setTable` does after a new key on an extract: count it, and judge the relationships into it again.
  for (const datasetId of keyed) {
    try {
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      if (!meta || isLive(meta)) continue;
      const table = await getTableDoc(projectId, datasetId);
      if (table.key) await countedAfterSave(projectId, datasetId, table);
      await recheckRelationshipsTo(projectId, datasetId);
    } catch (err) {
      logger.error('[modelApply] a new key was not counted:', err instanceof Error ? err.message : 'failed'); // the doc is saved; "Check now" retries
    }
  }
}

export async function applyImport(projectId: string, upload: ParsedModel, planHash: string, choices: Readonly<Record<string, ApplyChoice>>, io: ApplyIo): Promise<ApplyReply> {
  const { plan, forms, match, file } = await planDetailed(projectId, upload); // `file`: as planned (a dbt copy keeps this project's other keys)
  if (plan.hash !== planHash) return { ok: false, code: 'plan_changed', error: modelPlanChanged() };
  const todo = plan.items.filter((i) => LANDS.has(i.status) || (i.status === 'conflict' && choices[i.key] === 'file'));
  if (!todo.length) return { ok: true, written: [], failed: [] };
  const downloadToken = await io.before?.();
  const out: Out = { written: [], failed: [] };
  const of = (kind: PlanItem['kind']): PlanItem[] => todo.filter((i) => i.kind === kind);
  const formOf = (item: PlanItem): Mapped => forms.get(item.key) as Mapped;
  // File id → the id its store gave a new object; `follow` rewrites a later object's references to them.
  const fresh: ModelMatch = { datasets: new Map(), terms: new Map(), metrics: new Map(), relationships: new Map(), how: new Map(), here: new Set() };
  const follow = <T>(v: T): T => mapRefs(v, fresh).value;

  await writeCatalog(projectId, file, todo.filter((i) => i.kind === 'table' || i.kind === 'field'), out, io);

  for (const item of of('baseFilters')) {
    await one(item, out, io, async () => {
      const meta = await datasets.getDatasetMeta(projectId, item.targetId as string);
      // shortcut: base filters keep no tag, so they are compared just before their write, not inside it; take the record's lock across both if an edit ever lands in that gap
      if (objectBase({ baseFilters: meta?.live?.baseFilters ?? [] }) !== item.hereHash) return modelObjectMoved();
      const fd = file.datasets.find((d) => d.id === item.key.split(':')[1]) as ModelDataset;
      const r = await setLiveBaseFilters({ projectId, datasetId: item.targetId, filters: mapRefs(fd, match).value.baseFilters ?? [] });
      return r.ok ? null : r.error;
    });
  }

  for (const item of of('relationship')) {
    await one(item, out, io, async () => {
      const r = formOf(item).value as ModelRelationship;
      if (item.targetId) {
        // shortcut: relationships keep no tag, so they are compared just before their save, as base filters are
        const now = (await listRelationships(projectId)).find((x) => x.id === item.targetId);
        if (!now || relationshipOf(now).base !== item.hereHash) return modelObjectMoved();
      }
      const reply = await saveRelationshipChecked(projectId, {
        ...(item.targetId && { id: item.targetId }),
        from: { datasetId: r.from.dataset, column: r.from.column },
        to: { datasetId: r.to.dataset, column: r.to.column },
        cardinality: r.cardinality,
        label: r.label ?? '', // sent, so an absent label clears the edge's own
      });
      if (!reply?.ok) return String(reply?.error ?? modelWriteFailed());
      if (!item.targetId) fresh.relationships.set(r.id, reply.relationship.id);
      return null;
    });
  }

  for (const item of of('term')) {
    await one(item, out, io, async () => {
      const t = follow(formOf(item).value as ModelTerm);
      if (item.targetId) {
        const reply = await updateTermChecked(projectId, item.targetId, patchOf(item, t), item.hereHash);
        return 'term' in reply ? null : reply.error;
      }
      const reply = await saveTermChecked(projectId, { name: t.name, aliases: t.aliases ?? [], description: t.description ?? '', datasetId: t.dataset, filters: t.filters });
      if (!('term' in reply) || !reply.term) return reply.error;
      fresh.terms.set(t.id, reply.term.id);
      return null;
    });
  }

  // A new metric another new one names is written first; a cycle goes in plan order, and its save says why.
  const pending = of('metric');
  const nameOf = (p: PlanItem): string => String((formOf(p).value as ModelMetric).name).toLowerCase();
  const waits = (item: PlanItem): boolean => formOf(item).refs.some((k) => k !== item.key && pending.some((p) => p.key === k && !p.targetId))
    || (!!file.dbt && formulaNames(formOf(item).value).some((n) => pending.some((p) => p !== item && nameOf(p) === n))); // a dbt formula after its inputs (their date)
  while (pending.length) {
    const at = pending.findIndex((p) => !waits(p));
    const [item] = pending.splice(at < 0 ? 0 : at, 1);
    await one(item, out, io, async () => {
      const m = follow(formOf(item).value as ModelMetric);
      if (item.targetId) {
        const reply = await updateMetricChecked(projectId, item.targetId, patchOf(item, m), item.hereHash);
        return 'metric' in reply ? null : reply.error;
      }
      const reply = await saveMetricChecked(projectId, {
        name: m.name, datasetId: m.dataset, definition: m.definition, filters: m.filters ?? [], format: m.format,
        description: m.description, direction: m.direction, timeColumn: m.timeColumn, target: m.target, importedFrom: m.importedFrom,
      });
      if (!('metric' in reply) || !reply.metric) return String(reply.error);
      fresh.metrics.set(m.id, reply.metric.id);
      return null;
    });
  }

  return { ok: true, ...out, ...(downloadToken ? { before: { downloadToken } } : {}) };
}
