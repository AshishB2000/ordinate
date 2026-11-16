// The write side of shared folders (docs/team-folders/00-design.md D18): a write needs Edit on the item's folder, a
// create Edit on the folder it lands in. One rule, applied at three seams:
//
//   - the stores' own writes (`mustEdit`, through src/app/recordOpen.ts `mustEditRecord`): every guarded update
//     (editConflict.lockedUpdate), a move to the Trash and back, and each follower's create and duplicate — so the
//     RPC route, MCP, the Assistant's plans and model imports are held alike;
//   - the route (./folderWriteGate.ts): the dataset-scoped writes, whose parts live in many modules, and where a new
//     dataset or dashboard lands;
//   - the first write of a new dataset or dashboard (`placeFirst`): its placement row is written BEFORE its record, so
//     a dataset derived from a closed parent is never, for a moment, in Everyone.
//
// A closed item answers as for a missing one wherever the store's read is the caller's (E2's tagged reads); where a
// refusal is thrown it is `closed` (names nothing) and below Edit `edit`. INERT: with no folder besides Everyone, an
// org or project admin, or a published page, every check passes with no read, and nothing is placed.

import { AsyncLocalStorage } from 'node:async_hooks';
import { isValidId } from '../../app/ids';
import { logger } from '../../app/logger';
import { ctx, orgKey } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { readOnceInOrg } from '../db/orgTx';
import { folderAccessOn, FolderError, foldersRestrict, levelIn, placedIn, placementOf, type FolderLevel, type PlacedKind } from './folders';
import { levelOfItem, levelsOf } from './folderGate';

export interface Anchor {
  readonly kind: PlacedKind;
  readonly id: string;
}

const ORDER: Readonly<Record<FolderLevel, number>> = { none: 0, view: 1, edit: 2, manage: 3 };
/** The lower of two levels. */
export const lower = (a: FolderLevel, b: FolderLevel): FolderLevel => (ORDER[a] <= ORDER[b] ? a : b);

let enabled = true;
/**
 * Test seam (scripts/folderNetWrites.ts): off, the write checks neither read nor refuse — its NEGATIVE CONTROL's same
 * write lands, and its cost check measures what they add. Where a new item lands is not a check: it still applies.
 */
export function setFolderWritesForTest(on: boolean): void {
  enabled = on;
}
export const writesChecked = (): boolean => enabled;

/** A write on an item the caller cannot open answers as for a missing one (D12): the store returns its "gone". */
export const hidesWrite = (level: FolderLevel): boolean => enabled && level === 'none';

/** Below Edit refuses: `closed` for an item the caller cannot open, `edit` for one they only view (D15). */
export function refuseBelowEdit(level: FolderLevel): void {
  if (!enabled) return;
  if (level === 'none') throw new FolderError('closed');
  if (level === 'view') throw new FolderError('edit');
}

/** The caller's lowest level over `anchors` (`manage` for none, or when nothing restricts them: no read). */
export async function levelOfAll(projectId: string, anchors: readonly Anchor[]): Promise<FolderLevel> {
  let min: FolderLevel = 'manage';
  if (!enabled) return min;
  for (const a of anchors) if (typeof a.id === 'string' && isValidId(a.id)) min = lower(min, await levelOfItem(projectId, a.kind, a.id));
  return min;
}

/**
 * Refuses unless the caller edits every dataset of the project — what the project's pipeline names and runs (as the
 * system) — from the placements alone, no listing: one in a folder they cannot open is `closed`, one they view `edit`.
 */
export async function mustEditEveryDataset(projectId: string): Promise<void> {
  if (!enabled || !(await levelsOf(projectId, 'dataset'))) return; // nothing restricts the caller here: no read
  const access = await folderAccessOn(projectId);
  let min: FolderLevel = levelIn(access, projectId);
  for (const f of new Set((await placedIn(projectId, 'dataset')).values())) min = lower(min, levelIn(access, f));
  refuseBelowEdit(min);
}

/** Refuses unless the caller edits every anchor. */
export async function mustEdit(projectId: string, anchors: readonly Anchor[]): Promise<void> {
  refuseBelowEdit(await levelOfAll(projectId, anchors));
}

/** The datasets among `ids` the caller edits (all of them, with no read, when nothing restricts the caller). */
export async function editsOnly(projectId: string, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) if (ORDER[await levelOfAll(projectId, datasetsAt([id]))] >= ORDER.edit) out.push(id);
  return out;
}

/** Refuses `closed` unless the caller opens every anchor (a card added to a dashboard needs its dataset open, D18). */
export async function mustOpen(projectId: string, anchors: readonly Anchor[]): Promise<void> {
  if (enabled && (await levelOfAll(projectId, anchors)) === 'none') throw new FolderError('closed');
}

export const datasetsAt = (ids: readonly unknown[]): Anchor[] => ids.filter((x): x is string => typeof x === 'string' && isValidId(x)).map((id) => ({ kind: 'dataset', id }));

const hasMemo = new WeakMap<object, Map<string, Promise<boolean>>>();

/**
 * Has the project a folder besides Everyone? ONE statement per request and project: for a caller folders may restrict,
 * `foldersRestrict` — which also tells the resolver that this request needs no tree — and for an org admin its own read.
 * Ungated by the test seams: where a thing lands is not an access check.
 */
export function hasFolders(projectId: string): Promise<boolean> {
  const p = projectId.toLowerCase();
  const pool = orgDb();
  if (!pool || !isValidId(p)) return Promise.resolve(false);
  const who = ctx();
  let memo = hasMemo.get(who as object);
  if (!memo) hasMemo.set(who as object, (memo = new Map()));
  const key = orgKey(p);
  let hit = memo.get(key);
  if (!hit) {
    hit = who.user.role === 'admin'
      ? readOnceInOrg(pool, who.org.id, `SELECT 1 FROM folders WHERE org_id = current_setting('ordinate.org') AND project_id = '${p}' LIMIT 1`).then((r) => r.length > 0) // p passed isValidId
      : foldersRestrict([p]).then((set) => set.size > 0);
    memo.set(key, hit);
    const m = memo;
    hit.catch(() => m.delete(key)); // a failed read is not remembered as an answer
  }
  return hit;
}

/**
 * Where a new dataset or dashboard lands (D18): the folder the request names, else the folder of its first parent
 * dataset that is not in Everyone (so no restricted parent leaks into Everyone through a later one), else Everyone
 * (the project id). Refuses unless the caller edits it: an unknown folder is `closed`, as a closed one is. No folder
 * named and no parent: Everyone, with no read (a write's caller is an editor at least, and edits Everyone).
 */
export async function landsIn(projectId: string, folderId: unknown, parents: readonly unknown[] = []): Promise<string> {
  const p = projectId.toLowerCase();
  const named = typeof folderId === 'string' && folderId.toLowerCase() !== p ? folderId.toLowerCase() : null;
  const ids = folderId === undefined || folderId === null ? datasetsAt(parents).map((a) => a.id.toLowerCase()) : [];
  if (!named && !ids.length) return p;
  if (!(await hasFolders(p))) {
    if (named) refuseBelowEdit('none'); // no folder here at all: the one named is not there
    return p;
  }
  let target = p;
  if (named) {
    target = named;
    if (!isValidId(target) || !(await folderExists(p, target))) refuseBelowEdit('none');
  } else {
    const at = await placementOf(p, 'dataset', ids);
    target = ids.map((id) => at.get(id) ?? p).find((f) => f !== p) ?? p;
  }
  if (await levelsOf(p, 'dataset')) refuseBelowEdit(levelIn(await folderAccessOn(p), target)); // null: nothing restricts the caller
  return target;
}

async function folderExists(projectId: string, folderId: string): Promise<boolean> {
  return !!orgDb() && inOrg(async (c, org) => (await c.query('SELECT 1 FROM folders WHERE org_id = $1 AND project_id = $2 AND id = $3::uuid', [org, projectId, folderId])).rowCount === 1);
}

const landing = new AsyncLocalStorage<{ projectId: string; folder: string }>();

/** `fn` with every dataset and dashboard it creates in `projectId` placed in `folder` first (Everyone: nothing to place). */
export function withLanding<T>(projectId: string, folder: string, fn: () => Promise<T>): Promise<T> {
  return folder.toLowerCase() === projectId.toLowerCase() ? fn() : landing.run({ projectId: projectId.toLowerCase(), folder: folder.toLowerCase() }, fn);
}

/**
 * A new dataset's or dashboard's first write: its placement, when the request lands it outside Everyone — written
 * before the record, so it is never in Everyone. A failure throws: the record is then not written.
 */
export async function placeFirst(projectId: string, kind: PlacedKind, id: string): Promise<void> {
  const at = landing.getStore();
  if (!at || at.projectId !== String(projectId).toLowerCase() || !isValidId(id) || !orgDb()) return;
  await inOrg((c, org) => c.query(
    `INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, $3, $4, $5::uuid, $6)
     ON CONFLICT (org_id, project_id, kind, item_id) DO NOTHING`,
    [org, at.projectId, kind, id.toLowerCase(), at.folder, ctx().user.email],
  ));
}

/** Drops the placements of items deleted for good (a Trash purge): a folder holding none can then be deleted (E7). */
export async function forgetPlacements(projectId: string, items: ReadonlyArray<{ kind: string; id: string }>): Promise<void> {
  const placed = items.filter((a) => isValidId(a.id) && (a.kind === 'dataset' || a.kind === 'dashboard'));
  if (!placed.length || !orgDb() || !isValidId(projectId)) return;
  // Clean-up, never fatal: a row left behind keeps a gone item "in" its folder, which hides nothing and shows nothing.
  await inOrg((c, org) => c.query(
    'DELETE FROM folder_items WHERE org_id = $1 AND project_id = $2 AND (kind, item_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))',
    [org, projectId.toLowerCase(), placed.map((a) => a.kind), placed.map((a) => a.id.toLowerCase())],
  )).catch((err: unknown) => logger.warn('[folders] placements of purged items were not dropped:', err instanceof Error ? err.message : 'failed'));
}
