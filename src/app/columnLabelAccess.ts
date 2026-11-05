// Who may save value labels on a column, and who may read the list back — MAIN PROCESS ONLY.
//
// A label list names STORED values ("EU", "c1"), so it is data of the rows. A caller row access rules
// restrict must not read it from any reply that carries a column doc (`catalog:columns`, a save's reply),
// and it is for text columns, which the dataset's record declares (never its rows).

import { closedToCaller, hiddenColumnsFor } from '../data/rowAccess';
import type { ColumnDoc } from './catalog';
import { labelColumnGone, labelsTextOnly } from '../analysis/valueLabelMessages';

/** Why a (non-empty) list may not be saved on `column`, or null: the column must be one the dataset has now, declared text. */
export function labelsRefusal(columns: { name: string; type: string }[] | undefined, column: string): string | null {
  const c = columns?.find((x) => x.name === column);
  return !c ? labelColumnGone(column) : c.type !== 'text' ? labelsTextOnly(column, c.type) : null;
}

const withoutValues = ({ values: _names, ...doc }: ColumnDoc): ColumnDoc => doc;

/**
 * The docs a caller may read: no value labels for a caller closed to the dataset (REDACT, as `readableTableDoc` drops
 * the key check); and a column hidden from them (part 4, D18) has neither its labels nor its example.
 */
export async function readableColumns(projectId: string, datasetId: string, docs: Record<string, ColumnDoc>): Promise<Record<string, ColumnDoc>> {
  const closed = Object.values(docs).some((d) => d.values) && (await closedToCaller(projectId, datasetId));
  const hidden = await hiddenColumnsFor(projectId, datasetId);
  // A plain object either way: a column named `__proto__` stays an own key.
  return Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, hidden.has(name) ? { ...withoutValues(doc), example: '' } : closed ? withoutValues(doc) : doc]));
}

/**
 * One doc, as `readableColumns` reads it: what a save or an alias reply carries. It runs AFTER the write, so rules
 * that cannot be read withhold the list (fail closed) rather than report a save that worked as failed.
 */
export async function readableColumn(projectId: string, datasetId: string, doc: ColumnDoc): Promise<ColumnDoc> {
  return doc.values && (await closedToCaller(projectId, datasetId).catch(() => true)) ? withoutValues(doc) : doc;
}
