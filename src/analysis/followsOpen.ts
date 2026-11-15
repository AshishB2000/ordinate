// Records that follow what they read (docs/team-folders/00-design.md D3, "What lives where"): a story, a scorecard, a
// scenario and a report made from a scorecard are open to the caller only when EVERY dataset, dashboard, visual, metric
// and scorecard they name is. Their stores list and read through this, after the read, so no list reads more records
// of its own kind than before; a restricted caller's first test reads the visual and metric lists once.
//
// A named visual or metric the caller's stores do not return counts as closed — a hide, never a leak: a block on a
// deleted chart hides its story from a caller a folder restricts, never from an admin or a project without folders.

import { isValidId } from '../app/ids';
import { levelsOf } from '../server/authz/folderGate';
import * as metrics from './metrics';
import * as visuals from './visuals';

type Ref = 'visual' | 'metric' | 'dataset' | 'dashboard' | 'scorecard';
const KEYS: ReadonlyArray<[RegExp, Ref]> = [
  [/visualids?$/i, 'visual'], [/metricids?$/i, 'metric'], [/datasetids?$/i, 'dataset'], [/^(analysisid|dashboardid)$/i, 'dashboard'], [/^scorecardid$/i, 'scorecard'],
];
const MAX_DEPTH = 40;

/** Every id `v` names under a visual, metric, dataset, dashboard or scorecard key (or in an array under one); null when too deep to read. */
export function refsIn(v: unknown, out: Array<[Ref, string]> = [], key = '', depth = 0): Array<[Ref, string]> | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof v === 'string') {
    const ref = isValidId(v) ? KEYS.find(([re]) => re.test(key))?.[1] : undefined;
    if (ref) out.push([ref, v.toLowerCase()]);
  } else if (Array.isArray(v)) {
    for (const x of v) if (!refsIn(x, out, key, depth + 1)) return null;
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) if (!refsIn(x, out, k, depth + 1)) return null;
  }
  return out;
}

/** A test for "the caller opens everything `rec` names", or null when nothing restricts the caller (then no read). */
export async function followsAll(projectId: string): Promise<((rec: unknown) => Promise<boolean>) | null> {
  const [sets, boards] = await Promise.all([levelsOf(projectId, 'dataset'), levelsOf(projectId, 'dashboard')]);
  if (!sets || !boards) return null;
  let lists: Promise<{ visual: Set<string>; metric: Set<string> }> | null = null;
  const listed = () => (lists ??= Promise.all([visuals.listVisuals(projectId), metrics.listMetrics(projectId)])
    .then(([v, m]) => ({ visual: new Set(v.map((x) => x.id.toLowerCase())), metric: new Set(m.map((x) => x.id.toLowerCase())) })));
  const opens = async ([ref, id]: [Ref, string]): Promise<boolean> => {
    if (ref === 'dataset') return sets(id) !== 'none';
    if (ref === 'dashboard') return boards(id) !== 'none';
    // Lazy: the scorecard store reads through this module.
    if (ref === 'scorecard') return (await (require('./scorecards') as typeof import('./scorecards')).getScorecard(projectId, id)) !== null;
    return (await listed())[ref].has(id);
  };
  return async (rec) => {
    const refs = refsIn(rec);
    if (!refs) return false;
    for (const r of refs) if (!(await opens(r))) return false;
    return true;
  };
}

/** `rec` when the caller opens all it names (or nothing restricts them), else null: a store's read by id, as for a missing one (D12). */
export async function openOrNull<T>(projectId: string, rec: T | null, names: (r: T) => unknown = (r) => r): Promise<T | null> {
  if (!rec) return rec;
  const test = await followsAll(projectId);
  return !test || (await test(names(rec))) ? rec : null;
}
