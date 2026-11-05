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
import { readMetric } from '../analysis/metrics';
import { readTerm } from '../analysis/terms';
import { stableStringify } from '../engine/queryCache';
import { exportModel, type NotCarried } from './modelExport';
import { readModelFiles, type ParsedModel } from './modelRead';
import { mapRefs, matchModel, type ModelMatch } from './modelMatch';
import { objectBase, type ModelDataset } from './modelFormat';
import { modelDatasetMoved } from './modelFileMessages';

export type PlanStatus = 'unchanged' | 'updated' | 'renamed' | 'new' | 'conflict' | 'skipped' | 'onlyHere';
export const PLAN_STATUSES: readonly PlanStatus[] = ['unchanged', 'updated', 'renamed', 'new', 'conflict', 'skipped', 'onlyHere'];
export type SkipReason = 'dataset_missing' | 'column_missing' | 'depends_on_skipped' | 'sensitivity_lowered' | 'not_live' | 'invalid' | 'external';
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
  /** What the files say about themselves (their own text). */
  source: { appVersion: string; project: string };
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

export async function planImport(projectId: string, file: ParsedModel): Promise<ImportPlan> {
  const { here, notCarried } = await hereOf(projectId);
  const m: ModelMatch = matchModel(file, here);
  const items: PlanItem[] = [];
  /** `kind:fileId` of each file object the import will not write: what depends on it is skipped too. */
  const skipped = new Set<string>();
  const hereName = new Map(here.datasets.map((d) => [d.id, d.name]));

  // ── Datasets: never created, never renamed; their table, field and base-filter docs ──
  for (const fd of file.datasets) {
    const guide = file.guides.get(fd.id);
    const fileWritten = objectBase({ ...fd, ...(guide && { guide }) });
    const target = m.datasets.get(fd.id) ?? null;
    if (!target) {
      skipped.add(`dataset:${fd.id}`);
      items.push(skip({ key: `dataset:${fd.id}`, kind: 'dataset', name: fd.name, fileHash: fileWritten, hereHash: '' }, 'dataset_missing'));
      continue;
    }
    const pd = here.datasets.find((d) => d.id === target) as ModelDataset;
    const meta = await datasets.getDatasetMeta(projectId, target); // the record's columns, never its rows
    const sides: Sides = { how: m.how.get(`dataset:${fd.id}`), fileBase: fd.base, fileWritten, hereBase: pd.base };
    const at = (kind: PlanKind, key: string, name: string, f: Json, p: Json): Omit<PlanItem, 'status'> => ({ key, kind, name, targetId: target, fileHash: objectBase(f), hereHash: objectBase(p) });

    const ft = tableOf(fd, guide);
    const pt = tableOf(pd, here.guides.get(target));
    if (Object.keys(ft).length || Object.keys(pt).length) items.push(compared(at('table', `table:${fd.id}`, pd.name, ft, pt), ft, pt, sides));

    for (const ff of fd.fields ?? []) {
      const pf = (pd.fields ?? []).find((f) => f.name === ff.name);
      const f = content(ff);
      const p = pf ? content(pf) : {};
      const base = at('field', `field:${fd.id}:${ff.name}`, `${pd.name} · ${ff.name}`, f, p);
      if (!meta?.columns.some((c) => c.name === ff.name)) {
        items.push(skip(base, 'column_missing'));
        continue;
      }
      const item = compared(base, f, p, sides);
      // Sensitivity rises, never falls: only none → a mark is written.
      const lowered = !!pf?.sensitivity && ff.sensitivity !== pf.sensitivity;
      items.push(lowered && (item.status === 'updated' || item.status === 'conflict') ? { ...item, status: 'skipped', reason: 'sensitivity_lowered' } : item);
    }

    const { value: mapped, missing } = mapRefs(fd, m);
    const fb = { baseFilters: mapped.baseFilters ?? [] };
    const pb = { baseFilters: pd.baseFilters ?? [] };
    if (fb.baseFilters.length || pb.baseFilters.length) {
      const base = at('baseFilters', `baseFilters:${fd.id}`, pd.name, fb, pb);
      if (fb.baseFilters.length && !isLive(meta)) items.push(skip(base, 'not_live'));
      else if (missing.length) items.push(skip(base, 'depends_on_skipped', { because: missing[0] }));
      else items.push(compared(base, fb, pb, sides));
    }
  }

  // ── Relationships, terms, metrics: by id then name, each with what it names ──
  const dependency = (r: { missing: string[]; refs: string[] }): string | undefined => r.missing[0] ?? r.refs.find((k) => skipped.has(k));

  for (const fr of file.relationships) {
    const r = mapRefs(fr, m);
    const end = (e: { dataset: string; column: string }): string => `${hereName.get(e.dataset) ?? '?'}.${e.column}`;
    const base = { key: `relationship:${fr.id}`, kind: 'relationship' as const, name: fr.label ?? `${end(r.value.from)} → ${end(r.value.to)}`, fileHash: objectBase(fr), hereHash: '' };
    const dep = dependency(r);
    if (dep) {
      skipped.add(base.key);
      items.push(skip(base, 'depends_on_skipped', { because: dep }));
      continue;
    }
    const target = m.relationships.get(fr.id) ?? null;
    const pr = here.relationships.find((x) => x.id === target);
    const sides: Sides = { how: m.how.get(base.key), fileBase: fr.base, fileWritten: objectBase(fr), hereBase: pr?.base ?? '' };
    items.push(compared({ ...base, ...(pr && { targetId: pr.id, hereHash: pr.base }) }, content(r.value), pr && content(pr), sides));
  }

  for (const ft of file.terms) {
    const r = mapRefs(ft, m);
    const base = { key: `term:${ft.id}`, kind: 'term' as const, name: ft.name, fileHash: objectBase(ft), hereHash: '' };
    const dep = dependency(r);
    if (dep) {
      skipped.add(base.key);
      items.push(skip(base, 'depends_on_skipped', { because: dep }));
      continue;
    }
    const pt = here.terms.find((x) => x.id === m.terms.get(ft.id));
    const tagged = pt ? { targetId: pt.id, hereHash: (await readTerm(projectId, pt.id))?.tag ?? '' } : {};
    if (pt && pt.dataset !== r.value.dataset) {
      skipped.add(base.key);
      items.push(skip({ ...base, ...tagged }, 'invalid', { error: modelDatasetMoved() }));
      continue;
    }
    const sides: Sides = { how: m.how.get(base.key), fileBase: ft.base, fileWritten: objectBase(ft), hereBase: pt?.base ?? '' };
    items.push(compared({ ...base, ...tagged }, content(r.value), pt && content(pt), sides, !!pt && pt.name !== ft.name));
  }

  // A metric may name another (a period's base, a target): a skip travels until nothing more falls.
  const mRefs = new Map(file.metrics.map((fm) => [fm.id, mapRefs(fm, m)]));
  for (let more = true; more;) {
    more = false;
    for (const fm of file.metrics) {
      const key = `metric:${fm.id}`;
      if (!skipped.has(key) && dependency(mRefs.get(fm.id) as ReturnType<typeof mapRefs>)) {
        skipped.add(key);
        more = true;
      }
    }
  }
  for (const fm of file.metrics) {
    const r = mRefs.get(fm.id) as ReturnType<typeof mapRefs<typeof fm>>;
    const base = { key: `metric:${fm.id}`, kind: 'metric' as const, name: fm.name, fileHash: objectBase(fm), hereHash: '' };
    const dep = dependency(r);
    if (dep) {
      items.push(skip(base, 'depends_on_skipped', { because: dep }));
      continue;
    }
    const pm = here.metrics.find((x) => x.id === m.metrics.get(fm.id));
    const tagged = pm ? { targetId: pm.id, hereHash: (await readMetric(projectId, pm.id))?.tag ?? '' } : {};
    if (pm && pm.dataset !== r.value.dataset) {
      items.push(skip({ ...base, ...tagged }, 'invalid', { error: modelDatasetMoved() }));
      continue;
    }
    const sides: Sides = { how: m.how.get(base.key), fileBase: fm.base, fileWritten: objectBase(fm), hereBase: pm?.base ?? '' };
    items.push(compared({ ...base, ...tagged }, content(r.value), pm && content(pm), sides, !!pm && pm.name !== fm.name));
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

  // ── Only here: listed, never deleted ──
  const inFile = new Set(file.invalid.map((b) => b.id).filter((id): id is string => !!id));
  const claimed = (map: Map<string, string | null>): Set<string> => new Set([...map.values()].filter((v): v is string => !!v));
  const only = async (kind: PlanKind, list: readonly { id: string; base: string; name?: string; label?: string }[], map: Map<string, string | null>, tag?: (id: string) => Promise<string>): Promise<void> => {
    const hit = claimed(map);
    for (const o of list) {
      if (hit.has(o.id) || inFile.has(o.id)) continue;
      items.push({ key: `${kind}:here:${o.id}`, kind, name: o.name ?? o.label ?? '', status: 'onlyHere', targetId: o.id, fileHash: '', hereHash: tag ? await tag(o.id) : o.base });
    }
  };
  await only('dataset', here.datasets, m.datasets);
  await only('relationship', here.relationships.map((r) => ({ ...r, name: r.label ?? `${hereName.get(r.from.dataset) ?? '?'}.${r.from.column} → ${hereName.get(r.to.dataset) ?? '?'}.${r.to.column}` })), m.relationships);
  await only('term', here.terms, m.terms, async (id) => (await readTerm(projectId, id))?.tag ?? '');
  await only('metric', here.metrics, m.metrics, async (id) => (await readMetric(projectId, id))?.tag ?? '');

  items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const counts = Object.fromEntries(PLAN_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length])) as Record<PlanStatus, number>;
  const hash = createHash('sha256').update(stableStringify({ v: 1, items: items.map((i) => [i.key, i.status, i.fileHash, i.hereHash]) })).digest('base64url');
  return { hash, items, counts, source: { appVersion: file.manifest.appVersion, project: file.manifest.project.name }, notCarried };
}
