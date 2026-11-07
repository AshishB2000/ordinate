// `model:overview` — the Data model's Datasets tab in one read (semantic layer part 1, step 10): for every
// dataset, its role, key and whether the key was found to repeat, its description, the filters always applied
// to it (a copy's Prepare filter steps, a Live dataset's base filters) and its calculated fields (a copy's Prepare
// steps, a Live dataset's calcs, part 8 step 04), plus what is
// left to fill in, ranked. METADATA ONLY: the dataset records and the catalog file, never a row, never a warehouse.
//
// A caller row access rules restrict on a dataset (REDACT) gets no key count (as `readableTableDoc`), and no
// value a filter step or formula quotes: each step is cut to its column and operator, each formula to ''.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { loadStrict } from '../app/catalog';
import { closedToCaller, restrictedOn } from '../data/rowAccess';
import { redactBaseFilters } from '../data/liveBaseFilters';
import { reviewItems, type ReviewItem } from '../analysis/statusReview';
import type { TableRole } from '../app/tableDocs';
import type { FilterStep, TransformStep } from '../data/transforms';
import { listVerified } from '../analysis/verifiedQuestions';
import { verifiedEnv, verifiedProblem } from './verifiedState';

/** A gap, and its rank: the first kind listed comes first in the strip. */
export type TodoKind = 'key_repeats' | 'verified_broken' | 'no_key' | 'no_guide' | 'no_description' | 'no_role';
// repeats = keyCheck.repeatedKeys; count = the verified questions that no longer run (one item, datasetId '': part 3 D7)
export interface TodoItem { datasetId: string; kind: TodoKind; repeats?: number; count?: number }

export interface ModelTable {
  datasetId: string;
  role: TableRole;
  key: string;
  /** '' = no key; unchecked = never counted, or the count is hidden from this caller. */
  keyState: '' | 'unchecked' | 'unique' | 'repeats';
  /** The catalog record doc's (`dataset:<id>`). */
  description: string;
  alwaysApplied: { kind: 'prepare' | 'live'; steps: FilterStep[] };
  calculated: { name: string; formula: string }[];
  /** A closed caller: steps are {type, column, op}, formulas ''. */
  valuesHidden?: true;
}

export interface TodoRow { datasetId: string; role: TableRole; key: string; repeatedKeys: number | null; hasGuide: boolean; description: string }

/** `review` is absent when nothing needs it (part 4); `todo` keeps its part-1 kinds for older browsers. */
export type OverviewReply = { ok: true; tables: ModelTable[]; todo: TodoItem[]; more: number; review?: ReviewItem[] } | { ok: false; error: string };

export const TODO_SHOWN = 4;

const GAPS: readonly [Exclude<TodoKind, 'verified_broken'>, (r: TodoRow) => boolean][] = [
  ['key_repeats', (r) => !!r.key && (r.repeatedKeys ?? 0) > 0],
  ['no_key', (r) => !r.key],
  ['no_guide', (r) => !r.hasGuide],
  ['no_description', (r) => !r.description],
  ['no_role', (r) => !r.role],
];

/** Every row's gaps, by rank and then row order; the first TODO_SHOWN, and how many more. `brokenVerified` ranks after the repeating keys. */
export function todoOf(rows: TodoRow[], brokenVerified = 0): { todo: TodoItem[]; more: number } {
  const all: TodoItem[] = [];
  for (const [kind, gap] of GAPS) {
    for (const r of rows) if (gap(r)) all.push(kind === 'key_repeats' ? { datasetId: r.datasetId, kind, repeats: r.repeatedKeys as number } : { datasetId: r.datasetId, kind });
    if (kind === 'key_repeats' && brokenVerified > 0) all.push({ datasetId: '', kind: 'verified_broken', count: brokenVerified });
  }
  return { todo: all.slice(0, TODO_SHOWN), more: Math.max(0, all.length - TODO_SHOWN) };
}

const isFilter = (s: TransformStep): s is FilterStep => s.type === 'filter';

/** How many verified questions no longer run (./verifiedState): metadata only, and no read at all without one. */
async function brokenVerified(projectId: string): Promise<number> {
  const list = await listVerified(projectId);
  if (!list.length) return 0;
  const env = await verifiedEnv(projectId);
  return list.filter((q) => verifiedProblem(q, env) !== null).length;
}

export async function modelOverview(projectId: string): Promise<{ tables: ModelTable[]; todo: TodoItem[]; more: number; review?: ReviewItem[] }> {
  // A catalog that cannot be read fails the read: it must not pass for "nothing written yet".
  const [list, file, restricted] = await Promise.all([datasets.listDatasets(projectId), loadStrict(projectId), restrictedOn(projectId)]);
  const rows: TodoRow[] = [];
  const tables = await Promise.all(list.map(async (d): Promise<ModelTable> => {
    const meta = await datasets.getDatasetMeta(projectId, d.id);
    const doc = file.tables?.[d.id];
    const closed = restricted && (await closedToCaller(projectId, d.id));
    const live = d.mode === 'live';
    const key = doc?.key ?? '';
    const check = closed ? undefined : doc?.keyCheck;
    const description = file.records[`dataset:${d.id}`]?.description ?? '';
    const steps = live ? [] : meta?.steps ?? [];
    const filters = live ? meta?.live?.baseFilters ?? [] : steps.filter(isFilter);
    const calcs = live ? meta?.live?.calculated ?? [] : steps.flatMap((s) => (s.type === 'calculated_field' ? [s] : []));
    rows.push({ datasetId: d.id, role: doc?.role ?? '', key, repeatedKeys: check ? check.repeatedKeys : null, hasGuide: !!doc?.guide, description });
    return {
      datasetId: d.id,
      role: doc?.role ?? '',
      key,
      keyState: !key ? '' : !check ? 'unchecked' : check.repeatedKeys > 0 ? 'repeats' : 'unique',
      description,
      alwaysApplied: { kind: live ? 'live' : 'prepare', steps: redactBaseFilters(filters, closed) }, // the one REDACT of a filter list (PR 08)
      calculated: calcs.map((s) => ({ name: s.name, formula: closed ? '' : s.expression })),
      ...(closed && { valuesHidden: true as const }),
    };
  }));
  // `rows` was filled as each dataset resolved: put it back in list order before ranking.
  const order = new Map(list.map((d, i) => [d.id, i]));
  rows.sort((a, b) => (order.get(a.datasetId) ?? 0) - (order.get(b.datasetId) ?? 0));
  const review = await reviewItems(projectId);
  return { tables, ...todoOf(rows, await brokenVerified(projectId)), ...(review.length && { review }) };
}

export function register(): void {
  ipcMain.handle('model:overview', async (_e, { projectId }: { projectId?: unknown } = {}): Promise<OverviewReply> => {
    try {
      return { ok: true, ...(await modelOverview(typeof projectId === 'string' ? projectId : '')) };
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || 'The data model could not be read.' };
    }
  });
}
