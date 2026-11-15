// A source table answered with no dataset (docs/assistant/00-design.md, "Asking needs no dataset; keeping makes one",
// outcome C) — MAIN PROCESS ONLY.
//
// An editor's answer from a warehouse table runs through the Live doors exactly as a Live dataset's does
// (../ipc/liveAnswers → engine/live/liveQuery → liveTarget → warehouse()), but no record and no Parquet are written: the
// table's Live "view" is a DatasetMeta built in memory from its source table doc's facts (../ipc/sourceAnswers) and
// held here for the length of one call, as ./asOf holds a snapshot. Inside `withSourceViews`, the three dataset reads
// everything bottoms out in ask first: `getDatasetMeta` answers the view, `getDataset` throws LiveDatasetError (a Live
// dataset has no rows here, D6), and `persist` refuses to write it. Outside a scope the id is no dataset at all, so
// nothing else (a list, a visual, a dashboard) can ever meet it. A view's id is its doc's id: a random UUID no dataset has.

import { AsyncLocalStorage } from 'async_hooks';
import type { DatasetMeta } from './datasets'; // types only: datasets.ts imports this file

interface Scope { projectId: string; views: ReadonlyMap<string, DatasetMeta> }

const als = new AsyncLocalStorage<Scope>();

/** `fn` with `views` readable as Live datasets of `projectId` (and nowhere else). A nested scope adds to the outer one. */
export function withSourceViews<T>(projectId: string, views: readonly DatasetMeta[], fn: () => Promise<T>): Promise<T> {
  const outer = als.getStore();
  const all = new Map(outer && outer.projectId === projectId ? outer.views : []);
  for (const v of views) all.set(v.id, v);
  return als.run({ projectId, views: all }, fn);
}

/** The view `id` names inside a scope (a copy: no reader may change it), or undefined: read the record. */
export function viewHook(projectId: string, id: string): DatasetMeta | undefined {
  const s = als.getStore();
  const v = s && s.projectId === projectId ? s.views.get(id) : undefined;
  return v ? structuredClone(v) : undefined;
}

/** Is `id` a source table's view in this scope? */
export function isSourceView(projectId: string, id: string): boolean {
  const s = als.getStore();
  return !!s && s.projectId === projectId && s.views.has(id);
}

/** A write of a view is refused: keeping one makes a NEW dataset (../ipc/sourceKeep), never this id. */
export function assertNotView(projectId: string, id: string): void {
  if (isSourceView(projectId, id)) throw new Error('A source table answered without a dataset is never saved as one.');
}
