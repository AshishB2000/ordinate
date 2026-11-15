// Is a record open to the caller, by what it follows (docs/team-folders/00-design.md, "What lives where")? For the
// readers that hold a record outside its store — a Trash entry's copy, a version history — so they answer a closed
// one as for a missing one. Every answer is "open", with no read, when no folder restricts the caller.

import { levelsOf } from '../server/authz/folderGate';
import { followsAll } from '../analysis/followsOpen';
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
