// The Assistant and agents never see a hidden column (semantic layer part 4, D21) — MAIN PROCESS.
//
// Facts drop a column hidden from the caller ENTIRELY: its name, its statistics, its sample values, its notes.
// Its notes go with the column docs (app/sharePolicy assistantColumnDocs); the metrics and terms that read it go
// with them (analysis/columnHidden). What is left here: the dataset branch's whole-table read, which the storage
// net closes to a caller something is hidden from, opened for that one dataset while the facts drop the hidden
// columns before anything is computed over the rows.

import { gateRows, hiddenColumnsFor, withColumnsChecked } from '../data/rowAccess';
import type { FactTableDoc } from './copilotFacts';

/** `cols` without the hidden ones. The same array when nothing is hidden. */
export function dropHidden<T extends { name: string }>(cols: T[], hidden: ReadonlySet<string>): T[] {
  return hidden.size ? cols.filter((c) => !hidden.has(c.name)) : cols;
}

/** The table notes without a hidden key (and the grain worded from it): the key is the column's name and its state a fact of its values. */
export function tableWithout(table: FactTableDoc | undefined, hidden: ReadonlySet<string>): FactTableDoc | undefined {
  if (!table || !table.key || !hidden.has(table.key)) return table;
  const { key: _k, keyState: _s, grain, ...rest } = table;
  return { ...rest, ...(grain && !grain.includes(table.key) ? { grain } : {}) };
}

/**
 * A whole-dataset facts build of `datasetId` as the caller may be told it. Nothing hidden: the net checks it as
 * before, then `build(EMPTY)`. Else, in a scope where the net lets that one dataset through, `build(hidden)` —
 * which must leave the hidden columns out of the table (columnAccess.withoutColumns) before anything reads its
 * rows, and read nothing computed over every column (insights). Rules that no longer hold, a dataset upstream
 * that hides a column, and row rules still refuse there, typed.
 */
export async function factsOf<T>(projectId: string, datasetId: string, build: (hidden: ReadonlySet<string>) => Promise<T>): Promise<T> {
  const hidden = await hiddenColumnsFor(projectId, datasetId);
  const run = async (): Promise<T> => {
    await gateRows(projectId, datasetId);
    return build(hidden);
  };
  return hidden.size ? withColumnsChecked(new Set([datasetId]), run) : run();
}
