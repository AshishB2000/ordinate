// The column gate at the figure doors (semantic layer part 4, D15, D16, D20) — MAIN PROCESS.
//
// `lockedViz`, `lockedMetric` and `withLockOf` (./rowDoors) call `gateColumns` FIRST, after terms are
// expanded and before the row lock, the related-dataset gate, the Live split and the answer cache. For a
// restricted caller (and inside a fan-out, for its least-entitled audience) a question that names a column
// hidden from them on any table it reads — in any role: category, series, measure, filter, sort, facet,
// formula, LOD — is refused, typed `hidden`; rules that no longer hold, an upstream dataset that hides a
// column, or an as-of read refuse `columns`; an export refuses. A question that passes reads no hidden
// column, so its cached answer is safe to share, and the storage net lets the gated datasets through
// (`withColumnsChecked`). The row lock and Prepare and Live base filters may use a hidden column: they
// define the dataset, not the question.

import { isValidId } from '../app/ids';
import { asOfIso } from '../data/asOf';
import { columnView, upstreamHides, type Audience, type ColumnView } from '../data/columnGate';
import { mentionsHidden, nullHidden } from '../data/columnAccess';
import * as datasets from '../data/datasets';
import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import { RowPolicyError, inExport, inFanOut, isRowPolicyError, refuseInScope, restrictedOn, rowPolicyRefusal, withColumnsChecked } from '../data/rowAccess';

const EMPTY: ReadonlySet<string> = new Set();

// Test seam: the cache-order negative control turns the gate off (scripts/test-columnDoors), as setRelatedGateForTest does.
let gateOn = true;
export function setColumnGateForTest(on: boolean): void {
  gateOn = on;
}

async function viewOrRefuse(projectId: string, id: string, audience: Audience): Promise<{ view: ColumnView; upstream: boolean }> {
  try {
    return { view: await columnView(projectId, id, audience), upstream: await upstreamHides(projectId, id, audience) };
  } catch (err) {
    if (isRowPolicyError(err)) refuseInScope(err.reason); // unreadable: a fan-out build remembers it
    throw err;
  }
}

/** The check alone: the datasets it checked and the hidden columns of `datasetId`, or null when nothing applies; a refusal THROWS. */
async function checkColumns(projectId: string, datasetId: string, reads: () => Promise<string[]>, question: unknown): Promise<{ ids: Set<string>; hidden: ReadonlySet<string> } | null> {
  if (!gateOn) return null;
  const fanout = inFanOut();
  if (!fanout && !(await restrictedOn(projectId))) return null;
  const audience: Audience = fanout ? 'fanout' : 'caller';
  const ids = new Set([datasetId, ...(await reads())].filter((id) => typeof id === 'string' && isValidId(id)));
  let hidden = EMPTY;
  for (const id of ids) {
    const { view, upstream } = await viewOrRefuse(projectId, id, audience);
    if (view.state === 'columns' || upstream) refuseInScope('columns');
    if (!view.hidden.size) continue;
    if (asOfIso()) refuseInScope('columns'); // a snapshot's columns and steps are not the record's the rules were saved on
    if (inExport()) refuseInScope('export');
    if (mentionsHidden(question, view.hidden)) refuseInScope('hidden');
    if (id === datasetId) hidden = view.hidden;
  }
  return { ids, hidden };
}

/**
 * The gate: refuses (THROWS) a question that names a column hidden from the caller on `datasetId` or any table
 * `reads` names, else runs `fn` with `datasetId`'s hidden columns in a scope where the net lets those datasets
 * through. For an unrestricted caller outside a fan-out, `fn(EMPTY)` with no reads.
 */
export async function gateColumns<T>(projectId: string, datasetId: string, reads: () => Promise<string[]>, question: unknown, fn: (hidden: ReadonlySet<string>) => Promise<T>): Promise<T> {
  const checked = await checkColumns(projectId, datasetId, reads, question);
  return checked ? withColumnsChecked(checked.ids, () => fn(checked.hidden)) : fn(EMPTY);
}

/** `gateColumns` for a door that answers `{ok:false}`: the gate's own refusal becomes the reply; `fn`'s errors pass through as they are. */
export async function gateColumnsReply<T>(projectId: string, datasetId: string, reads: () => Promise<string[]>, question: unknown, fn: (hidden: ReadonlySet<string>) => Promise<T>): Promise<T | ReturnType<typeof rowPolicyRefusal>> {
  let checked: Awaited<ReturnType<typeof checkColumns>>;
  try {
    checked = await checkColumns(projectId, datasetId, reads, question);
  } catch (err) {
    if (isRowPolicyError(err)) return rowPolicyRefusal(err.reason);
    throw err;
  }
  return checked ? withColumnsChecked(checked.ids, () => fn(checked.hidden)) : fn(EMPTY);
}

/** `reads`, asked once however many gates ask it. */
export function once(reads: () => Promise<string[]>): () => Promise<string[]> {
  let p: Promise<string[]> | null = null;
  return () => (p ??= reads());
}

/**
 * A grid page as the caller gets it (D16): a search is refused while a column is hidden from them (it matches
 * every cell); the hidden cells are null IN PLACE and the reply names them, so any browser's grid stays aligned.
 * With nothing hidden, `read()`'s reply as it is.
 */
export async function pageWithoutHidden<R extends { ok: boolean; rows?: Cell[][] }>(projectId: string, datasetId: string, search: unknown, hidden: ReadonlySet<string>, read: () => Promise<R>): Promise<R & { hidden?: string[] }> {
  if (!hidden.size) return read();
  if (typeof search === 'string' && search.trim() !== '') throw new RowPolicyError('hidden');
  const reply = await read();
  if (!reply.ok || !Array.isArray(reply.rows)) return reply;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) throw new RowPolicyError('columns'); // no header to align the cells with: never the cells unmasked
  return { ...reply, rows: nullHidden(reply.rows, meta.columns, hidden), hidden: meta.columns.filter((c) => hidden.has(c.name)).map((c) => c.name) };
}

/** A row file's columns without the hidden ones, and each row cut to match (a CSV has no grid to keep aligned). */
export function shownColumns(columns: ParsedColumn[], hidden: readonly string[] | undefined): { columns: ParsedColumn[]; row: (r: Cell[]) => Cell[] } {
  const drop = new Set(hidden ?? []);
  const keep = columns.flatMap((c, i) => (drop.has(c.name) ? [] : [i]));
  return keep.length === columns.length ? { columns, row: (r) => r } : { columns: keep.map((i) => columns[i]), row: (r) => keep.map((i) => r[i]) };
}
