// Is a record open to the caller, by what it follows (docs/team-folders/00-design.md, "What lives where")? For the
// readers that hold a record outside its store — a Trash entry's copy, a version history — so they answer a closed
// one as for a missing one. Every answer is "open", with no read, when no folder restricts the caller.

import { levelsOf } from '../server/authz/folderGate';
import { hidesWrite, lower, refuseBelowEdit, writesChecked } from '../server/authz/folderWrites';
import * as recordFs from './recordFs';
import type { FolderLevel } from '../server/authz/folders';
import { followsAll, refsIn } from '../analysis/followsOpen';
import * as trashStore from './trashStore';
import { isRecordType } from './recordKinds';

type Rec = { id?: unknown; datasetId?: unknown; analysisId?: unknown; createdFrom?: { analysisId?: unknown } } & Record<string, unknown>;

/** `rec`, a record of `type` in hand, is open to the caller. A dataset and a dashboard keep their placement in the Trash. */
export async function opensRecord(projectId: string, type: string, rec: unknown): Promise<boolean> {
  const [sets, boards] = await Promise.all([levelsOf(projectId, 'dataset'), levelsOf(projectId, 'dashboard')]);
  if (!sets || !boards) return true;
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Rec;
  if (type === 'dataset') return sets(String(r.id ?? '')) !== 'none';
  if (type === 'dashboard') return boards(String(r.id ?? '')) !== 'none';
  if (type === 'topic' || type === 'agent') return true; // project-level: their members are filtered where they are read
  if (type === 'alert') return (r.createdFrom?.analysisId ? boards(String(r.createdFrom.analysisId)) : sets(String(r.datasetId ?? ''))) !== 'none';
  // A visual, metric, term or verified question follows its dataset; a report its dashboard, else what it names.
  const test = await followsAll(projectId);
  return !test || (await test(type === 'report' && r.analysisId ? { analysisId: r.analysisId } : rec));
}

/** The caller's store's read of a versioned record (null: closed to them, or not there). Lazy: those stores reach this module. */
async function live(projectId: string, type: string, id: string): Promise<unknown> {
  if (type === 'visual') return (require('../analysis/visuals') as typeof import('../analysis/visuals')).getVisual(projectId, id);
  if (type === 'metric') return (require('../analysis/metrics') as typeof import('../analysis/metrics')).getMetric(projectId, id);
  if (type === 'term') return (require('../analysis/terms') as typeof import('../analysis/terms')).getTerm(projectId, id);
  if (type === 'report') return (require('../analysis/reportSpec') as typeof import('../analysis/reportSpec')).getReport(projectId, id);
  return null;
}

/** A record's version history is closed to the caller when the record is: live in their store, else its Trash copy (gone: closed). */
export async function historyClosed(projectId: string, type: string, id: string): Promise<boolean> {
  if (!(await levelsOf(projectId, 'dataset'))) return false;
  if (type === 'dataset' || type === 'dashboard') return !(await opensRecord(projectId, type, { id }));
  if (await live(projectId, type, id)) return false;
  return !isRecordType(type) || !(await opensRecord(projectId, type, await trashStore.readEntry(projectId, type, id)));
}

/**
 * The datasets a verified question's folder is (D3: it follows them) — a chart question's spec's dataset, an SQL
 * question's every dataset its SQL reads (`sql.datasetIds`) — the ONE place every verified write check reads them, so
 * writing one needs Edit on ALL of them, and one closed to the caller hides it (as `listBoth` lists it).
 */
export function questionDatasets(q: unknown): string[] {
  const r = q as { spec?: { datasetId?: unknown }; sql?: { datasetIds?: unknown } } | null;
  const sql = Array.isArray(r?.sql?.datasetIds) ? (r?.sql?.datasetIds as unknown[]) : [];
  return [r?.spec?.datasetId, ...sql].filter((id): id is string => typeof id === 'string');
}

const FOLLOWS_ITS_DATASET: ReadonlySet<string> = new Set(['visual', 'metric', 'metricTree', 'term']);

type Lookups = { sets: (id: string) => FolderLevel; boards: (id: string) => FolderLevel; projectId: string; lists?: Promise<{ visual: Map<string, string>; metric: Map<string, string> }> };

/** One named item's level: a visual or metric by its dataset (closed to the caller's stores: none), a scorecard by what it names. */
async function levelOfRef(at: Lookups, ref: string, id: string, depth: number): Promise<FolderLevel> {
  if (ref === 'dataset') return at.sets(id);
  if (ref === 'dashboard') return at.boards(id);
  if (ref === 'scorecard') {
    const sc = depth < 4 ? await (require('../analysis/scorecards') as typeof import('../analysis/scorecards')).getScorecard(at.projectId, id) : null;
    return sc ? levelOfNames(at, sc, depth + 1) : 'none';
  }
  // Lazy: those stores reach this module.
  at.lists ??= Promise.all([
    (require('../analysis/visuals') as typeof import('../analysis/visuals')).listVisuals(at.projectId),
    (require('../analysis/metrics') as typeof import('../analysis/metrics')).listMetrics(at.projectId),
  ]).then(([v, m]) => ({ visual: new Map(v.map((x) => [x.id.toLowerCase(), x.datasetId])), metric: new Map(m.map((x) => [x.id.toLowerCase(), x.datasetId])) }));
  const lists = await at.lists;
  const ds = (ref === 'visual' ? lists.visual : lists.metric).get(id);
  return ds === undefined ? 'none' : ds ? at.sets(ds) : 'manage';
}

/** The lowest level over every dataset, dashboard, visual, metric and scorecard `rec` names (too deep to read: none). */
async function levelOfNames(at: Lookups, rec: unknown, depth = 0): Promise<FolderLevel> {
  const refs = refsIn(rec);
  if (!refs) return 'none';
  let min: FolderLevel = 'manage';
  for (const [ref, id] of refs) if (min !== 'none') min = lower(min, await levelOfRef(at, ref, id, depth));
  return min;
}

async function lookups(projectId: string): Promise<Lookups | null> {
  const [sets, boards] = await Promise.all([levelsOf(projectId, 'dataset'), levelsOf(projectId, 'dashboard')]);
  return sets && boards ? { sets, boards, projectId } : null;
}

/**
 * The caller's level on `rec`, a record of `type`, by what it follows (D3; `manage` when nothing restricts them, with
 * no read): a dataset or dashboard its own; an alert its dashboard, else its dataset; a verified question its datasets;
 * a report its dashboard; anything else the lowest over all it names. Topics, agents and source tables are the project's.
 */
export async function levelOfRecord(projectId: string, type: string, rec: unknown, own = false): Promise<FolderLevel> {
  if (!writesChecked()) return 'manage'; // the write checks' test seam: no read either
  const at = await lookups(projectId);
  if (!at) return 'manage';
  if (!rec || typeof rec !== 'object') return 'none';
  const r = rec as Rec;
  // `own`: the anchor its store opens it by (E2) — a chart's, metric's or term's dataset — not a label dataset it also reads.
  if (own && FOLLOWS_ITS_DATASET.has(type)) return at.sets(String(r.datasetId ?? ''));
  if (type === 'dataset') return at.sets(String(r.id ?? ''));
  if (type === 'dashboard') return at.boards(String(r.id ?? ''));
  if (type === 'topic' || type === 'agent' || type === 'sourceTable') return 'manage';
  if (type === 'alert') return r.createdFrom?.analysisId ? at.boards(String(r.createdFrom.analysisId)) : at.sets(String(r.datasetId ?? ''));
  if (type === 'verified') return questionDatasets(r).reduce<FolderLevel>((min, id) => lower(min, at.sets(id)), 'manage');
  if (type === 'report' && r.analysisId) return at.boards(String(r.analysisId));
  return levelOfNames(at, rec);
}

/** D18: refuses a write of `rec` unless the caller edits what it follows — `closed` when they cannot open it, `edit` when they view it. */
export async function mustEditRecord(projectId: string, type: string, rec: unknown): Promise<void> {
  refuseBelowEdit(await levelOfRecord(projectId, type, rec));
}

/**
 * D18 for a write of `rec` (its stored JSON; null when missing): false when it is closed to the caller — the store then
 * answers as for a missing one — and below Edit on anything it follows or names refuses (`closed` for a label dataset
 * the caller cannot open, `edit` for one they view). True, with no read, when nothing restricts.
 */
export async function mayChangeRecord(projectId: string, type: string, rec: unknown): Promise<boolean> {
  if (hidesWrite(await levelOfRecord(projectId, type, rec, true))) return false; // closed itself: as missing
  refuseBelowEdit(await levelOfRecord(projectId, type, rec)); // open, but below Edit on something it names: refused
  return true;
}

/** `mayChangeRecord` of the record stored at `file`. */
export async function mayChangeStored(projectId: string, type: string, file: string): Promise<boolean> {
  if (!writesChecked() || !(await lookups(projectId))) return true;
  let rec: unknown = null;
  try {
    rec = JSON.parse(await recordFs.readFile(file, 'utf8'));
  } catch (_) {
    rec = null; // missing or unreadable: nothing the caller may be shown exists
  }
  return mayChangeRecord(projectId, type, rec);
}

/** A dashboard save: every dataset, visual, metric or scorecard its cards name that the stored one did not must be open (D18). */
export async function mustOpenAdded(projectId: string, before: unknown, after: unknown): Promise<void> {
  const at = writesChecked() ? await lookups(projectId) : null;
  if (!at) return;
  const had = new Set((refsIn(before) ?? []).map(([ref, id]) => `${ref}:${id}`));
  const added = (refsIn(after) ?? []).filter(([ref, id]) => !had.has(`${ref}:${id}`) && ref !== 'dashboard');
  for (const [ref, id] of added) if ((await levelOfRef(at, ref, id, 0)) === 'none') refuseBelowEdit('none');
}
