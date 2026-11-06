// The import dry run (semantic layer part 7, a2; docs/semantic-layer/07-portability.md D4, D5): what importing model
// files into a project would do, object by object, writing NOTHING and keeping nothing in memory (any pod).
//
// The project side is a1's own export read back (./modelExport.ts, ./modelRead.ts), so both sides compare in one shape;
// the file's references are mapped into the project's ids first (./modelMatch.ts). Then, per object:
//   - equal: unchanged;
//   - matched BY ID with a valid `base`: edited in the file only → updated (renamed when the name moved); edited here
//     only → unchanged and `newerHere` (a stale file never reverts newer work); both → conflict, which keeps this
//     project's unless the person picks the file's (a3). A dataset's base covers the whole dataset and its guide, so
//     its table, field and base-filter parts take the dataset's verdict;
//   - matched by name (another project) or with no base: there is nothing shared to compare with, so every difference
//     is an update, shown as a diff;
//   - no match: new (datasets are never created: skipped `dataset_missing`, with every object that names one);
//   - in the project only: `onlyHere`, never a delete.
// A field's sensitivity may rise (none → a mark), never fall; base filters only onto a Live dataset.
//
// The hash covers each item's key, status and the two sides' hashes (a metric or term's edit tag here), so any edit to a
// target between the dry run and the apply moves it. The person's choices are not in it.

import { createHash } from 'crypto';
import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { isExternalDefinition, readMetric, sanitizeDefinition } from '../analysis/metrics';
import { readTerm } from '../analysis/terms';
import { stableStringify } from '../engine/queryCache';
import { exportModel, type NotCarried } from './modelExport';
import { readModelFiles, type ParsedModel } from './modelRead';
import { mapRefs, matchModel, type ModelMatch } from './modelMatch';
import { objectBase, type ModelDataset, type ModelField, type ModelRelationship } from './modelFormat';
import { baseFilterRefusal, fieldRefusal, metricRefusal, relationshipRefusal, tableRefusal, termRefusal, type PostNames } from './modelGates';
import type { Relationship } from '../analysis/relationships';
import type { DatasetMeta } from '../data/datasets';
import { modelDatasetMoved } from './modelFileMessages';
import { dbtItems, formulaNames, keepHere, withImportTags } from './dbtPlan';
import type { DbtSkip } from './dbtImport';
import type { DbtNote } from './dbtCumulative';

export type PlanStatus = 'unchanged' | 'updated' | 'renamed' | 'new' | 'conflict' | 'skipped' | 'onlyHere';
export const PLAN_STATUSES: readonly PlanStatus[] = ['unchanged', 'updated', 'renamed', 'new', 'conflict', 'skipped', 'onlyHere'];
export type SkipReason = 'dataset_missing' | 'column_missing' | 'depends_on_skipped' | 'sensitivity_lowered' | 'not_live' | 'invalid' | 'external' | DbtSkip;
export type PlanKind = 'dataset' | 'table' | 'field' | 'baseFilters' | 'relationship' | 'term' | 'metric';

/** One key that differs, as this project has it and as the files have it (absent: none). Definitions only. */
export interface PlanChange { field: string; here?: unknown; file?: unknown }

export interface PlanItem {
  /** `kind:fileId` (`field:datasetFileId:column`), `kind:here:projectId` for only here, `kind:file:path` for an unreadable file. */
  key: string;
  kind: PlanKind;
  name: string;
  status: PlanStatus;
  /** The project object it lands on, when there is one. */
  targetId?: string;
  changes?: PlanChange[];
  /** Unchanged because the project's copy is newer than the files'. */
  newerHere?: true;
  reason?: SkipReason;
  /** `kind:fileId` of the skipped or missing object a `depends_on_skipped` item names. */
  because?: string;
  /** The editor's own sentence, for `invalid`. */
  error?: string;
  fileHash: string;
  hereHash: string;
}

export interface ImportPlan {
  hash: string;
  items: PlanItem[];
  counts: Record<PlanStatus, number>;
  /** What the files say about themselves (their own text); `kind: 'dbt'` for a dbt translation (f1), a copy. */
  source: { appVersion: string; project: string; kind?: 'dbt'; notes?: DbtNote[] };
  /** Kinds this project holds that model files never carry: an import leaves them as they are. */
  notCarried: NotCarried[];
}

const KIND_ORDER: readonly PlanKind[] = ['dataset', 'table', 'field', 'baseFilters', 'relationship', 'term', 'metric'];
const BASE_RE = /^[A-Za-z0-9_-]{43}$/;

type Json = Record<string, unknown>;
const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
/** An object's content: its own base and its id are not content (a promotion matches other ids). */
const content = (o: object): Json => {
  const { base: _b, id: _i, ...rest } = o as Json;
  return rest;
};
/** Keys that hold something: the export writes no empty key, so neither side compares one. */
const defined = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function changesOf(here: Json, file: Json): PlanChange[] {
  return [...new Set([...Object.keys(here), ...Object.keys(file)])].sort()
    .filter((k) => !same(here[k], file[k]))
    .map((k) => ({ field: k, ...(here[k] !== undefined && { here: here[k] }), ...(file[k] !== undefined && { file: file[k] }) }));
}

/** What a shared base says about two copies that differ (see the header). */
interface Sides { how: 'id' | 'name' | undefined; fileBase: unknown; fileWritten: string; hereBase: string }
function verdict(s: Sides, renamed: boolean): Pick<PlanItem, 'status' | 'newerHere'> {
  if (s.how === 'id' && typeof s.fileBase === 'string' && BASE_RE.test(s.fileBase)) {
    if (s.fileWritten === s.fileBase) return { status: 'unchanged', newerHere: true };
    if (s.hereBase !== s.fileBase) return { status: 'conflict' };
  }
  return { status: renamed && s.how === 'id' ? 'renamed' : 'updated' };
}

/** One part or object, compared: unchanged, or the verdict with its diff. */
function compared(base: Omit<PlanItem, 'status'>, file: Json, here: Json | undefined, sides: Sides, renamed = false): PlanItem {
  if (here && same(file, here)) return { ...base, status: 'unchanged' };
  return { ...base, ...(here ? verdict(sides, renamed) : { status: 'new' as const }), changes: changesOf(here ?? {}, file) };
}

const tableOf = (d: ModelDataset, guide: string | undefined): Json => defined({ description: d.description, role: d.role, key: d.key, grain: d.grain, guide });
const skip = (base: Omit<PlanItem, 'status'>, reason: SkipReason, more: Partial<PlanItem> = {}): PlanItem => ({ ...base, status: 'skipped', reason, ...more });

/** The project's own definitions in the files' shape: a1's export, read back by the same reader. */
async function hereOf(projectId: string): Promise<{ here: ParsedModel; notCarried: NotCarried[] }> {
  const exp = await exportModel(projectId); // refuses a caller row access rules restrict (D7)
  const here = await readModelFiles(exp.files);
  if ('refused' in here) throw new Error('modelPlan: the project export did not read back'); // its own files: never
  return { here, notCarried: exp.notCarried };
}

const WRITES: ReadonlySet<PlanStatus> = new Set<PlanStatus>(['updated', 'renamed', 'new', 'conflict']);
const writes = (i: PlanItem): boolean => WRITES.has(i.status);
/** The editor refused it: kept with its diff, so the person sees what was refused. */
const refuse = (i: PlanItem, error: string, reason: SkipReason = 'invalid'): void => void Object.assign(i, { status: 'skipped', reason, error });

export type Mapped = ReturnType<typeof mapRefs<any>>; // any: one object of any kind, as the files hold it

export async function planImport(projectId: string, file: ParsedModel): Promise<ImportPlan> {
  return (await planDetailed(projectId, file)).plan;
}

/**
 * The plan, and what the apply writes from: each relationship, term and metric item's file form (references mapped) by
 * key, the match, and the files as planned (a dbt translation with this project's keys it does not carry: ./dbtPlan.ts).
 */
export async function planDetailed(projectId: string, upload: ParsedModel): Promise<{ plan: ImportPlan; forms: ReadonlyMap<string, Mapped>; match: ModelMatch; file: ParsedModel }> {
  const exported = await hereOf(projectId);
  const { notCarried } = exported;
  const here = upload.dbt ? await withImportTags(projectId, exported.here) : exported.here;
  const m: ModelMatch = matchModel(upload, here);
  const file = upload.dbt ? keepHere(upload, here, m) : upload;
  const items: PlanItem[] = [];
  /** `kind:fileId` of each file object that will not exist after the import: whatever names it is skipped too. */
  const gone = new Set<string>();
  /** Each relationship, term and metric item's file form (references mapped) and what it names. */
  const fileOf = new Map<string, Mapped>();
  const hereName = new Map(here.datasets.map((d) => [d.id, d.name]));
  const metas = new Map<string, Promise<DatasetMeta | null>>();
  const metaOf = (id: string): Promise<DatasetMeta | null> => {
    if (!metas.has(id)) metas.set(id, datasets.getDatasetMeta(projectId, id)); // the record's columns, never its rows
    return metas.get(id) as Promise<DatasetMeta | null>;
  };
  const dependency = (r: Mapped): string | undefined => r.missing[0] ?? r.refs.find((k) => gone.has(k));
  const created = (k: string): boolean => {
    const [kind, id] = k.split(':') as [string, string];
    const map = kind === 'term' ? m.terms : kind === 'metric' ? m.metrics : kind === 'relationship' ? m.relationships : null;
    return !!map && map.get(id) === null;
  };

  // ── Datasets: never created, never renamed; their table, field and base-filter docs ──
  for (const fd of file.datasets) {
    const guide = file.guides.get(fd.id);
    const fileWritten = objectBase({ ...fd, ...(guide && { guide }) });
    const target = m.datasets.get(fd.id) ?? null;
    if (!target) {
      gone.add(`dataset:${fd.id}`);
      items.push(skip({ key: `dataset:${fd.id}`, kind: 'dataset', name: fd.name, fileHash: fileWritten, hereHash: '' }, 'dataset_missing'));
      continue;
    }
    const pd = here.datasets.find((d) => d.id === target) as ModelDataset;
    const meta = await metaOf(target);
    const columns = meta?.columns ?? [];
    const sides: Sides = { how: m.how.get(`dataset:${fd.id}`), fileBase: fd.base, fileWritten, hereBase: pd.base };
    const at = (kind: PlanKind, key: string, name: string, f: Json, p: Json): Omit<PlanItem, 'status'> => ({ key, kind, name, targetId: target, fileHash: objectBase(f), hereHash: objectBase(p) });

    const ft = tableOf(fd, guide);
    const pt = tableOf(pd, here.guides.get(target));
    if (Object.keys(ft).length || Object.keys(pt).length) {
      const item = compared(at('table', `table:${fd.id}`, pd.name, ft, pt), ft, pt, sides);
      const refusal = writes(item) ? tableRefusal(columns, ft.key) : null;
      if (refusal) refuse(item, refusal);
      items.push(item);
    }

    const fields: Array<{ item: PlanItem; f: ModelField; p: ModelField | undefined }> = [];
    for (const ff of fd.fields ?? []) {
      const pf = (pd.fields ?? []).find((f) => f.name === ff.name);
      const f = content(ff);
      const p = pf ? content(pf) : {};
      const base = at('field', `field:${fd.id}:${ff.name}`, `${pd.name} · ${ff.name}`, f, p);
      if (!columns.some((c) => c.name === ff.name)) {
        items.push(skip(base, 'column_missing'));
        continue;
      }
      const item = compared(base, f, p, sides);
      // Sensitivity rises, never falls: only none → a mark is written.
      if (!!pf?.sensitivity && ff.sensitivity !== pf.sensitivity && writes(item)) Object.assign(item, { status: 'skipped', reason: 'sensitivity_lowered' });
      fields.push({ item, f: ff, p: pf });
      items.push(item);
    }
    // Each field's names against the dataset's other field docs as they will be after the import.
    const post = [...(pd.fields ?? []).filter((pf) => !fields.some((x) => x.f.name === pf.name && writes(x.item))), ...fields.filter((x) => writes(x.item)).map((x) => x.f)];
    for (const { item, f, p } of fields) {
      const refusal = writes(item) ? fieldRefusal(columns, f, p, post) : null;
      if (refusal) refuse(item, refusal);
    }

    const { value: mapped, missing } = mapRefs(fd, m);
    const fb = { baseFilters: mapped.baseFilters ?? [] };
    const pb = { baseFilters: pd.baseFilters ?? [] };
    if (fb.baseFilters.length || pb.baseFilters.length) {
      const base = at('baseFilters', `baseFilters:${fd.id}`, pd.name, fb, pb);
      if (fb.baseFilters.length && !isLive(meta)) items.push(skip(base, 'not_live'));
      else if (missing.length) items.push(skip(base, 'depends_on_skipped', { because: missing[0] }));
      else {
        const item = compared(base, fb, pb, sides);
        const refusal = writes(item) && meta ? baseFilterRefusal(meta, fb.baseFilters) : null;
        if (refusal) refuse(item, refusal);
        items.push(item);
      }
    }
  }

  // ── Relationships, terms, metrics: by id then name, each with what it names ──
  /** One object's item: skipped when what it names is missing or will not exist, else compared with its project copy. */
  const objectItem = async (
    kind: 'relationship' | 'term' | 'metric', fo: { id: string; base: string }, name: string, target: string | null, po: { id: string; base: string; name?: string; dataset?: string } | undefined, tag: (id: string) => Promise<string>,
  ): Promise<void> => {
    const key = `${kind}:${fo.id}`;
    const r = fileOf.get(key) as Mapped;
    const base = { key, kind, name, fileHash: objectBase(fo), hereHash: '', ...(po && { targetId: po.id, hereHash: await tag(po.id) }) };
    const dep = dependency(r);
    if (dep || (po && po.dataset !== undefined && po.dataset !== r.value.dataset)) {
      if (!target) gone.add(key);
      items.push(dep ? skip(base, 'depends_on_skipped', { because: dep }) : skip(base, 'invalid', { error: modelDatasetMoved() }));
      return;
    }
    const sides: Sides = { how: m.how.get(key), fileBase: fo.base, fileWritten: objectBase(fo), hereBase: po?.base ?? '' };
    items.push(compared(base, content(r.value), po && content(po), sides, !!po?.name && po.name !== name));
  };

  for (const fr of file.relationships) {
    const r = mapRefs(fr, m);
    fileOf.set(`relationship:${fr.id}`, r);
    const end = (e: { dataset: string; column: string }): string => `${hereName.get(e.dataset) ?? '?'}.${e.column}`;
    const target = m.relationships.get(fr.id) ?? null;
    await objectItem('relationship', fr, fr.label ?? `${end(r.value.from)} → ${end(r.value.to)}`, target, here.relationships.find((x) => x.id === target), async (id) => here.relationships.find((x) => x.id === id)?.base ?? '');
  }
  // A label is checked against the relationships as they will be after the import.
  const postRels = (): Relationship[] => {
    const landed = new Map(items.filter((i) => i.kind === 'relationship' && i.targetId).map((i) => [i.targetId as string, i]));
    const asRel = (r: ModelRelationship, id: string): Relationship => ({ id, from: { datasetId: r.from.dataset, column: r.from.column }, to: { datasetId: r.to.dataset, column: r.to.column }, cardinality: r.cardinality, ...(r.label && { label: r.label }), verified: { matched: 0, unmatchedFrom: 0 } });
    return [
      ...here.relationships.map((pr) => { const it = landed.get(pr.id); return asRel(it && writes(it) ? (fileOf.get(it.key) as Mapped).value : pr, pr.id); }),
      ...items.filter((i) => i.kind === 'relationship' && i.status === 'new').map((i) => asRel((fileOf.get(i.key) as Mapped).value, (fileOf.get(i.key) as Mapped).value.id)),
    ];
  };
  const rels = postRels();
  for (const item of items.filter((i) => i.kind === 'relationship' && writes(i))) {
    const r = (fileOf.get(item.key) as Mapped).value as ModelRelationship;
    const id = item.targetId ?? r.id;
    const refusal = relationshipRefusal(r, id, await metaOf(r.from.dataset), await metaOf(r.to.dataset), rels.filter((x) => x.id !== id));
    if (refusal) {
      Object.assign(item, refusal === 'column_missing' ? { status: 'skipped', reason: 'column_missing' } : { status: 'skipped', reason: 'invalid', error: refusal.error });
      if (!item.targetId) gone.add(item.key);
    }
  }

  for (const ft of file.terms) {
    fileOf.set(`term:${ft.id}`, mapRefs(ft, m));
    const target = m.terms.get(ft.id) ?? null;
    await objectItem('term', ft, ft.name, target, here.terms.find((x) => x.id === target), async (id) => (await readTerm(projectId, id))?.tag ?? '');
  }
  // A metric may name another (a period's base, a target): a skip travels until nothing more falls.
  for (const fm of file.metrics) fileOf.set(`metric:${fm.id}`, mapRefs(fm, m));
  for (let more = true; more;) {
    more = false;
    for (const fm of file.metrics) {
      const key = `metric:${fm.id}`;
      if (gone.has(key) || m.metrics.get(fm.id) || !dependency(fileOf.get(key) as Mapped)) continue;
      gone.add(key);
      more = true;
    }
  }
  for (const fm of file.metrics) {
    const target = m.metrics.get(fm.id) ?? null;
    await objectItem('metric', fm, fm.name, target, here.metrics.find((x) => x.id === target), async (id) => (await readMetric(projectId, id))?.tag ?? '');
  }

  // ── The editor's checks on terms and metrics, names against the names after the import ──
  const postNames = (): PostNames => {
    const landed = new Map(items.filter((i) => (i.kind === 'term' || i.kind === 'metric') && i.targetId).map((i) => [`${i.kind}:${i.targetId}`, i]));
    const form = <T>(kind: string, o: T & { id: string }): T => {
      const it = landed.get(`${kind}:${o.id}`);
      return it && (it.status === 'updated' || it.status === 'renamed') ? (fileOf.get(it.key) as Mapped).value : o; // a conflict keeps this project's
    };
    const fresh = (kind: string) => items.filter((i) => i.kind === kind && i.status === 'new').map((i) => (fileOf.get(i.key) as Mapped).value);
    return {
      metrics: [...here.metrics.map((pm) => ({ ...form('metric', pm), id: pm.id })), ...fresh('metric')].map((x) => ({ id: x.id, name: x.name, dataset: x.dataset, definition: x.definition })),
      terms: [...here.terms.map((pt) => ({ ...form('term', pt), id: pt.id })), ...fresh('term')].map((x) => ({ id: x.id, name: x.name, aliases: x.aliases ?? [] })),
    };
  };
  for (let pass = 0; pass <= items.length; pass++) {
    const post = postNames();
    // A dbt formula naming a metric this import writes is judged by its save after that one's (the apply's order).
    const written = new Set(file.dbt ? items.filter((i) => i.kind === 'metric' && writes(i)).map((i) => String((fileOf.get(i.key) as Mapped).value.name).toLowerCase()) : []);
    let fell = false;
    for (const item of items) {
      if ((item.kind !== 'term' && item.kind !== 'metric') || !writes(item)) continue;
      const r = fileOf.get(item.key) as Mapped;
      const self = item.targetId ?? r.value.id;
      const pending = r.refs.some(created) || formulaNames(r.value).some((n) => written.has(n));
      const refusal = item.kind === 'term' ? await termRefusal(projectId, r.value, self, post) : await metricRefusal(projectId, r.value, self, post, pending);
      if (refusal) {
        // A layer's metric is never written from a file (D13): skipped as `external`, with the sentence.
        refuse(item, refusal, item.kind === 'metric' && isExternalDefinition(sanitizeDefinition((r.value as { definition?: unknown }).definition)) ? 'external' : 'invalid');
        if (!item.targetId) gone.add(item.key);
        fell = true;
      }
    }
    // What names a refused new object goes with it.
    for (let more = true; more;) {
      more = false;
      for (const item of items) {
        const dep = writes(item) ? (fileOf.get(item.key) as Mapped | undefined)?.refs.find((k) => gone.has(k)) : undefined;
        if (!dep) continue;
        Object.assign(item, { status: 'skipped', reason: 'depends_on_skipped', because: dep });
        if (!item.targetId) gone.add(item.key);
        more = fell = true;
      }
    }
    if (!fell) break;
  }

  // ── Unreadable files: one skipped item each ──
  const seenPath = new Map<string, number>();
  for (const bad of file.invalid) {
    const kind: PlanKind = bad.path.startsWith('metrics/') ? 'metric' : bad.path.startsWith('terms/') ? 'term' : bad.path === 'relationships.json' ? 'relationship' : bad.path.endsWith('.md') ? 'table' : 'dataset';
    const n = (seenPath.get(bad.path) ?? 0) + 1;
    seenPath.set(bad.path, n);
    const key = `${kind}:file:${bad.path}${n > 1 ? `#${n}` : ''}`;
    items.push(skip({ key, kind, name: bad.path, fileHash: objectBase({ path: bad.path, error: bad.error }), hereHash: '' }, 'invalid', { error: bad.error }));
  }

  items.push(...dbtItems(file, (id) => hereName.get(id) ?? ''));

  // ── Only here: listed, never deleted (for a dbt file, only metrics: it names no term, relationship or other dataset) ──
  const inFile = new Set(file.invalid.map((b) => b.id).filter((id): id is string => !!id));
  const claimed = (map: Map<string, string | null>): Set<string> => new Set([...map.values()].filter((v): v is string => !!v));
  const only = async (kind: PlanKind, list: readonly { id: string; base: string; name?: string; label?: string }[], map: Map<string, string | null>, tag?: (id: string) => Promise<string>): Promise<void> => {
    const hit = claimed(map);
    for (const o of list) {
      if (hit.has(o.id) || inFile.has(o.id)) continue;
      items.push({ key: `${kind}:here:${o.id}`, kind, name: o.name ?? o.label ?? '', status: 'onlyHere', targetId: o.id, fileHash: '', hereHash: tag ? await tag(o.id) : o.base });
    }
  };
  if (!file.dbt) {
    await only('dataset', here.datasets, m.datasets);
    await only('relationship', here.relationships.map((r) => ({ ...r, name: r.label ?? `${hereName.get(r.from.dataset) ?? '?'}.${r.from.column} → ${hereName.get(r.to.dataset) ?? '?'}.${r.to.column}` })), m.relationships);
    await only('term', here.terms, m.terms, async (id) => (await readTerm(projectId, id))?.tag ?? '');
  }
  await only('metric', here.metrics, m.metrics, async (id) => (await readMetric(projectId, id))?.tag ?? '');

  items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const counts = Object.fromEntries(PLAN_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length])) as Record<PlanStatus, number>;
  const hash = createHash('sha256').update(stableStringify({ v: 1, items: items.map((i) => [i.key, i.status, i.fileHash, i.hereHash]) })).digest('base64url');
  // The notes are not hashed: they follow from the items, and the calendar that decides them already moves those (f2).
  const source = { appVersion: file.manifest.appVersion, project: file.manifest.project.name, ...(file.dbt && { kind: 'dbt' as const }), ...(file.dbt?.notes?.length && { notes: file.dbt.notes }) };
  return { plan: { hash, items, counts, source, notCarried }, forms: fileOf, match: m, file };
}
