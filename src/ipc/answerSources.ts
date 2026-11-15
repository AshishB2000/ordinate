// Where an answer's figures come from, and where else they are shown (docs/assistant/00-design.md, The flow, step 7) —
// MAIN PROCESS.
//
// "Answered from ▾" reads what the card already says (its dataset's name, `uses`, its filters, its time, its verified
// question) and `answeredFrom`, worked out here for the caller at every delivery, never kept with a snapshot (a role
// can change): the dataset whose Data page the name opens, and, only for a caller who may see source names (an editor,
// p2-01), where its rows come from as `dataset:source` words it ("Connection · Warehouse · ANALYTICS.RETURNS"). A
// viewer is sent the dataset's name and nothing of its source.
//
// "Also on ▸" (`answer:alsoOn`, asked when its menu opens): the project's dashboards that show the dataset, as the
// caller reads them (a viewer the published copies, an editor the drafts: analysis.analysisOf, the rule listAnalyses
// keeps), newest first, ALSO_ON_MAX of them and how many more. Found by reference, never by listing the project: the
// visuals on the dataset, then the dashboards naming it or one of them (recordFs.recordsNaming, one query each with the
// database), and only those are read and checked, tile by tile, as analysis/analysisTiles reads a dashboard's datasets.

import * as path from 'path';
import { ipcMain } from './bus';
import { keepReads, perAsk } from './askMemo';
import * as recordFs from '../app/recordFs';
import * as appPaths from '../app/paths';
import { isValidId } from '../app/ids';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';
import { atLeast } from '../server/authz/folders';
import { levelsOf } from '../server/authz/folderGate';
import * as connections from '../connectors/connections';
import { sourceView } from '../data/datasetOrigin';
import { seesSourceNames } from '../data/sourceNames';
import { displayNames } from '../app/catalog';
import { measureLabel } from '../analysis/vizData';
import type { AnswerSpec } from '../ai/answerSpec';

/** What "Answered from" adds for the caller. */
export interface AnsweredFrom {
  /** The dataset its name links to (its Data page). */
  datasetId: string;
  /** Editors only (p2-01): where the dataset's rows come from, `dataset:source`'s words. */
  origin?: string;
}

export interface AlsoOn {
  ok: true;
  dashboards: Array<{ id: string; name: string; draft?: true }>;
  /** How many more past the first ALSO_ON_MAX. */
  more: number;
}

export const ALSO_ON_MAX = 5;

/** The dataset's record, read once per kept call however many readers ask (./answerSnapshots `turnsForBrowser` too). */
export const keptMeta = (projectId: string, datasetId: string) =>
  perAsk(`datasetMeta\0${projectId}\0${datasetId}`, () => datasets.getDatasetMeta(projectId, datasetId));

/** `{ answeredFrom }` for a card on `datasetId`, or nothing when the dataset is gone. */
export function answeredFrom(projectId: string, datasetId: string): Promise<{ answeredFrom?: AnsweredFrom }> {
  return perAsk(`answeredFrom\0${projectId}\0${datasetId}`, async () => {
    const meta = await keptMeta(projectId, datasetId);
    if (!meta) return {};
    if (!(await seesSourceNames(projectId))) return { answeredFrom: { datasetId } };
    const conn = meta.origin?.kind === 'connection' ? await connections.getConnection(projectId, meta.origin.connId) : null;
    return { answeredFrom: { datasetId, origin: sourceView(meta.sourceKind, meta.origin, () => conn?.name).label } };
  });
}

/** The columns an answer reads, as the card names them: each measure as its chart's series is ("sum of Revenue"), then the category and the split. */
export async function usesOf(projectId: string, spec: AnswerSpec): Promise<string[]> {
  const names = await displayNames(projectId, spec.datasetId).catch(() => ({} as Record<string, string>));
  const shown = (c: string): string => (Object.hasOwn(names, c) && names[c]) || c;
  const all = [...spec.measures.map((m) => measureLabel({ ...m, column: shown(m.column) })), shown(spec.category), ...(spec.series ? [shown(spec.series)] : [])];
  return all.filter((n, i) => n && all.indexOf(n) === i);
}

const dir = (projectId: string, kind: 'visuals' | 'analyses'): string => path.join(appPaths.userData(), 'projects', projectId, kind);
const idOf = (name: string): string => name.slice(0, -'.json'.length);

/** Does this dashboard (as its reader reads it) show `datasetId`: a chart on it (frozen, or a visual of `onIt`), a KPI or a control. */
function shows(a: analysis.Analysis, datasetId: string, onIt: ReadonlySet<string>): boolean {
  return a.sheets.some((p) => (p.cards || []).some((c) =>
    (c.type === 'visual' && (c.visual ? c.visual.datasetId === datasetId : !!c.visualId && onIt.has(c.visualId)))
    || (c.type === 'metric' && c.metric?.datasetId === datasetId)
    || (c.type === 'control' && c.control?.datasetId === datasetId)));
}

/** The dashboards of `projectId` the caller may open that show `datasetId`, newest first: the first ALSO_ON_MAX and the count past them. */
export async function alsoOn(projectId: string, datasetId: string): Promise<AlsoOn | { ok: false; reason: string }> {
  if (!isValidId(projectId) || !isValidId(datasetId) || !(await keptMeta(projectId, datasetId))) return { ok: false, reason: 'This dataset is no longer in the project.' };
  const onIt = new Set<string>();
  for (const [name, body] of await recordFs.recordsNaming(dir(projectId, 'visuals'), [datasetId])) {
    try {
      const v = visuals.summaryOf(projectId, body);
      if (v && v.datasetId === datasetId && idOf(name) === v.id) onIt.add(v.id);
    } catch { /* unreadable: its list skips it too */ }
  }
  const publishedOnly = await analysis.readsPublishedOnly(projectId);
  const level = await levelsOf(projectId, 'dashboard'); // shared folders: a closed one is not named, a Can-view one is its copy (D8)
  const found: Array<{ id: string; name: string; updatedAt: string; draft?: true }> = [];
  for (const [name, body] of await recordFs.recordsNaming(dir(projectId, 'analyses'), [datasetId, ...onIt])) {
    try {
      const stored = JSON.parse(body);
      const lv = isValidId(idOf(name)) ? level?.(idOf(name)) : 'none';
      const a = lv !== 'none' ? analysis.analysisOf(projectId, stored, publishedOnly || (lv !== undefined && !atLeast(lv, 'edit'))) : null;
      if (a && shows(a, datasetId, onIt)) found.push({ id: a.id, name: a.name, updatedAt: a.updatedAt, ...(!publishedOnly && !a.published ? { draft: true as const } : {}) });
    } catch { /* unreadable: its list skips it too */ }
  }
  found.sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt) || (x.id < y.id ? -1 : 1));
  return { ok: true, dashboards: found.slice(0, ALSO_ON_MAX).map(({ updatedAt: _u, ...d }) => d), more: Math.max(0, found.length - ALSO_ON_MAX) };
}

export function register(): void {
  ipcMain.handle('answer:alsoOn', keepReads(async (_e, { projectId, datasetId }: Record<string, unknown> = {}) => {
    try {
      return await alsoOn(String(projectId ?? ''), String(datasetId ?? ''));
    } catch {
      return { ok: false, reason: 'Could not find the dashboards that use this dataset.' };
    }
  }));
}
