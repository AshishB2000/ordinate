// What the stores, the figure doors and the storage net ask of shared folders (docs/team-folders/00-design.md,
// "The stores", "The doors and the storage net"). The rule is ./folders.ts; this is where it is applied.
//
// INERT until a folder exists: for an org or project admin, a `wholeProject` walk, a published page, or a project
// with no folder besides Everyone, every answer is "open" and no placement is read — exactly today's replies.
//
//   - lists (`openOnly`) leave out items in a folder the caller cannot open, from one placement query;
//   - reads by id (`opens`) answer false for them, and the store returns null, as for a missing id (D12);
//   - the doors (`folderGate`) refuse `closed` for a question on, or reading, such a dataset (D9; reach is E5);
//   - the storage net (`gateFolder`, under datasets.getDataset and residentSource) refuses every other reader (D11);
//   - pushes, recipients and mentions (`openers`) reach only those who open the item they are about (D17);
//   - the indexes (`indexFolders`) leave closed folders out in their own WHERE, before ranking and LIMIT (D13).

import type { Pool } from 'pg';
import { isValidId } from '../../app/ids';
import { atLeast, folderAccessOn, FolderError, foldersRestrict, levelIn, openerEmails, placedIn, wholeProject, type FolderLevel, type PlacedKind } from './folders';
import { readerEmails, writerEmails } from './index';

// Test seams (scripts/test-folderSafetyNet.ts): its NEGATIVE CONTROLS turn every check here off, or only the doors'
// check of the other datasets a question reads (then a cached answer joined over a closed dataset is served).
let enabled = true;
let doorReads = true;
let indexWhere = true;
export function setFolderChecksForTest(on: boolean): void {
  enabled = on;
}
export function setDoorReadsForTest(on: boolean): void {
  doorReads = on;
}
/** Off: the indexes' WHERE condition is dropped (./folderSql), every other check stays — so the index alone leaks. */
export function setIndexWhereForTest(on: boolean): void {
  indexWhere = on;
}

/**
 * The folders an index query keeps, for its WHERE (D13, ./folderSql): those the caller opens (the project id stands for
 * Everyone) and those they edit; null when nothing restricts them here — then no condition applies.
 */
export async function indexFolders(projectId: string): Promise<{ open: string[]; edit: string[] } | null> {
  if (!enabled || !indexWhere || !isValidId(projectId)) return null;
  const access = await folderAccessOn(projectId);
  return access.all || access.noFolders ? null : { open: [...access.open], edit: [...access.edit] };
}

/** `foldersRestrict` (one round trip for a list across projects, projects:overview); with the checks off, none and no read. */
export function restrictingProjects(projectIds: readonly string[]): Promise<ReadonlySet<string>> {
  return enabled ? foldersRestrict(projectIds) : Promise.resolve(new Set());
}

/** Each item's level, or null when nothing restricts the caller here (no query was needed to say so). */
export async function levelsOf(projectId: string, kind: PlacedKind): Promise<((id: string) => FolderLevel) | null> {
  if (!enabled || !isValidId(projectId)) return null;
  const access = await folderAccessOn(projectId);
  if (access.all || access.noFolders) return null;
  const placed = await placedIn(projectId, kind);
  return (id) => levelIn(access, placed.get(String(id).toLowerCase()) ?? projectId);
}

/**
 * The caller's level on one item; `manage` when nothing restricts them here (then the project role decides, as today).
 * From the list's placements: one query per request and kind, however many items a reply names.
 */
export async function levelOfItem(projectId: string, kind: PlacedKind, id: string): Promise<FolderLevel> {
  if (!isValidId(id)) return 'manage';
  const level = await levelsOf(projectId, kind);
  return level ? level(id) : 'manage';
}

/** Can the caller open this item? (A visual, metric, term or verified question asks of its dataset; an alert of its anchor.) */
export async function opens(projectId: string, kind: PlacedKind, id: string): Promise<boolean> {
  return atLeast(await levelOfItem(projectId, kind, id), 'view');
}

/** `items` without those whose anchor (`kind` `anchor(x)`) is in a folder the caller cannot open. The same array when nothing restricts. */
export async function openOnly<T>(projectId: string, kind: PlacedKind, items: T[], anchor: (x: T) => string): Promise<T[]> {
  const level = await levelsOf(projectId, kind);
  return level ? items.filter((x) => level(anchor(x)) !== 'none') : items;
}

/** Is any item of `kind` in a folder the caller cannot open? A project-wide list of values (the colour map) then holds back, as row rules' REDACT does. */
export async function anyClosed(projectId: string, kind: PlacedKind): Promise<boolean> {
  const level = await levelsOf(projectId, kind);
  return !!level && [...(await placedIn(projectId, kind)).keys()].some((id) => level(id) === 'none');
}

/**
 * THE door check (D9), first in every figure door, before the row lock, the Live split and every cache key: the
 * question's dataset, and every other dataset it reads (`reads`: a related column's, a join plan's), open — else
 * `FolderError('closed')`. `reads` is not asked when nothing restricts the caller.
 */
export async function folderGate(projectId: string, datasetId: string, reads?: () => Promise<readonly string[]>): Promise<void> {
  if (!enabled || !isValidId(projectId)) return;
  const access = await folderAccessOn(projectId);
  if (access.all || access.noFolders) return;
  // What the question reads is a security walk (D14): a relationship or a join plan through a closed dataset counts.
  const more = reads && doorReads ? await wholeProject(reads) : [];
  for (const id of new Set([datasetId, ...more])) {
    if (typeof id === 'string' && isValidId(id) && !(await opens(projectId, 'dataset', id))) throw new FolderError('closed');
  }
}

/**
 * The storage net (D11), beside the row rules' `gateRows` under `getDataset` and `residentSource`: a dataset the
 * caller cannot open refuses, typed, whoever reads it — SQL, a Prepare union or lookup, compose, a copy, a
 * relationship's match rate — so a reader nobody listed refuses (a bug report) instead of leaking (a breach).
 */
export async function gateFolder(projectId: string, id: string): Promise<void> {
  if (isValidId(projectId) && isValidId(id) && !(await opens(projectId, 'dataset', id))) throw new FolderError('closed');
}

/**
 * Who opens `anchor` at `min` (D17): `openerEmails`, whoever asks — a push, a recipient list or a mention reaches
 * only them. With the checks off (a test's negative control) every reader (or writer) of the project, as before E3.
 */
export function openers(pool: Pool, org: string, projectId: string, anchor: { kind: PlacedKind; id: string }, min: 'view' | 'edit'): Promise<string[]> {
  if (!enabled) return (min === 'edit' ? writerEmails : readerEmails)(pool, org, projectId);
  return openerEmails(pool, org, projectId, anchor, min);
}
