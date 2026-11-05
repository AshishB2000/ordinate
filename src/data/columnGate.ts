// Column access rules, per request (semantic layer part 4, D15–D17) — MAIN PROCESS.
//
// A dataset's hidden columns for the caller (or, inside a fan-out, for its least-entitled
// audience: every ruled column), read raw from the current record once per request, and
// `columnReason`, which the storage net (./rowAccess.closedReason) asks: a dataset that hides
// a column from the caller is closed to every whole-table reader outside a gated door
// (ipc/columnDoors.gateColumns opens the "checked" scope that lets it through).
//
// Imports nothing from ./rowAccess (which imports this), so there is no cycle.

import { isValidId } from '../app/ids';
import { callerOn } from '../server/authz/caller';
import { accessState, columnAccessFromRecord, everyRuled, hiddenFor } from './columnAccess';
import { memoOf, readRawRecord } from './rawRecord';
import { RowPolicyError, isRowPolicyError, type RowPolicyReason } from './rowPolicyError';
import { parentsOfRecord, upstreamIds } from './upstream';

/** Whose view: the caller's own, or a fan-out's (a publish, embed, subscription or alert shows one figure to everyone). */
export type Audience = 'caller' | 'fanout';
/** `columns`: the rules do not hold on the record as it is now (or do not sanitize), and something is hidden. */
export interface ColumnView { hidden: ReadonlySet<string>; state: 'ok' | 'columns' }

const NONE: ReadonlySet<string> = new Set();
const OPEN: ColumnView = Object.freeze({ hidden: NONE, state: 'ok' as const });
const views = new WeakMap<object, Map<string, Promise<ColumnView>>>();

async function viewUncached(projectId: string, id: string, audience: Audience): Promise<ColumnView> {
  let who: { userId: string | null; teamIds: readonly string[] } | null = null;
  if (audience === 'caller') {
    const caller = await callerOn(projectId);
    if (!caller.restricted) return OPEN;
    who = caller;
  }
  const raw = await readRawRecord(projectId, id);
  const access = raw ? columnAccessFromRecord(raw) : null;
  if (!raw || access === null) return OPEN;
  if (access === 'closed') return { hidden: NONE, state: 'columns' }; // every restricted caller, and every fan-out
  const hidden = who ? hiddenFor(access, who.userId, who.teamIds) : everyRuled(access);
  if (!hidden.size) return { hidden, state: 'ok' };
  return { hidden, state: accessState(raw, access) === 'ok' ? 'ok' : 'columns' };
}

/**
 * The columns of `id` hidden from `audience`, and whether the rules still hold. The empty view, with no record
 * read, for an unrestricted caller outside a fan-out. Once per request; a record that cannot be read is refused
 * (`unreadable`), never "no rules", and the failure is not remembered.
 */
export function columnView(projectId: string, id: string, audience: Audience): Promise<ColumnView> {
  if (!isValidId(projectId) || !isValidId(id)) return Promise.resolve(OPEN);
  const memo = memoOf(views);
  const key = `${audience}\0${projectId}\0${id}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = viewUncached(projectId, id, audience).catch((err: unknown) => {
      throw isRowPolicyError(err) ? err : new RowPolicyError('unreadable');
    });
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}

/** Does a dataset `id` is built from hide a column from `audience` (or not hold, or lie past the walk)? Its rows carry those values. */
export async function upstreamHides(projectId: string, id: string, audience: Audience): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  if (audience === 'caller' && !(await callerOn(projectId)).restricted) return false;
  const up = await upstreamIds(id, async (p) => (isValidId(p) ? parentsOfRecord(await readRawRecord(projectId, p)) : []));
  for (const p of up.ids) {
    const v = await columnView(projectId, p, audience);
    if (v.state === 'columns' || v.hidden.size) return true;
  }
  return !up.complete; // a chain longer than the walk is unknown, never clean
}

/** Has `id`, or a dataset it is built from, any column rule at all (for anyone)? What a reply sent alike to every reader treats as closed. */
export async function columnsRuled(projectId: string, id: string): Promise<boolean> {
  const v = await columnView(projectId, id, 'fanout');
  return v.state === 'columns' || v.hidden.size > 0 || (await upstreamHides(projectId, id, 'fanout'));
}

/**
 * The net's column clause: why a reader may not read `id` here, or null. `columns` when the rules do not hold
 * or a dataset upstream hides a column (whatever the door); nothing hidden: null; an export: `export`; inside
 * a gated door that checked `id`: null; else `columns` (a whole-table reader would hand over hidden values).
 */
export async function columnReason(projectId: string, id: string, checked: ReadonlySet<string> | undefined, out: 'fanout' | 'export' | undefined): Promise<RowPolicyReason | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const audience: Audience = out === 'fanout' ? 'fanout' : 'caller';
  try {
    const view = await columnView(projectId, id, audience);
    if (view.state === 'columns' || (await upstreamHides(projectId, id, audience))) return 'columns';
    if (!view.hidden.size) return null;
  } catch (err) {
    if (isRowPolicyError(err)) return err.reason; // unreadable: closed
    throw err;
  }
  if (out === 'export') return 'export';
  return checked && checked.has(id) ? null : 'columns';
}
