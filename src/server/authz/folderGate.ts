// What the stores, the figure doors and the storage net ask of shared folders (docs/team-folders/00-design.md,
// "The stores", "The doors and the storage net"). The rule is ./folders.ts; this is where it is applied.
//
// INERT until a folder exists: for an org or project admin, a `wholeProject` walk, a published page, or a project
// with no folder besides Everyone, every answer is "open" and no placement is read — exactly today's replies.
//
//   - lists (`openOnly`) leave out items in a folder the caller cannot open, from one placement query;
//   - reads by id (`opens`) answer false for them, and the store returns null, as for a missing id (D12);
//   - the doors (`folderGate`) refuse `closed` for a question on, or reading, such a dataset — unless it is REACHED
//     (D9): read by the published copy of a dashboard the caller opens; then the body runs in a figure scope for it;
//   - the storage net (`gateFolder`, under datasets.getDataset and residentSource) refuses every other reader (D11),
//     `figures_only` on a reached dataset outside its door's scope;
//   - pushes, recipients and mentions (`openers`) reach only those who open the item they are about (D17);
//   - the indexes (`indexFolders`) leave closed folders out in their own WHERE, before ranking and LIMIT (D13).

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import { isValidId } from '../../app/ids';
import { rowsUnder } from '../../app/recordFs';
import { ctx, orgKey } from '../context';
import { readersOf } from '../dashboardReads';
import { atLeast, folderAccessOn, FolderError, foldersRestrict, isFolderError, levelIn, openerEmails, placedIn, wholeProject, type FolderLevel, type PlacedKind } from './folders';
import { readerEmails, writerEmails } from './index';

// Test seams (scripts/test-folderSafetyNet.ts): its NEGATIVE CONTROLS turn every check here off, or only the doors'
// check of the other datasets a question reads (then a cached answer joined over a closed dataset is served), or
// reach, or `figures_only`.
let enabled = true;
let doorReads = true;
let indexWhere = true;
let reach = true;
let figuresOnly = true;
export function setFolderChecksForTest(on: boolean): void {
  enabled = on;
}
export function setDoorReadsForTest(on: boolean): void {
  doorReads = on;
}
/** Off: nothing is reached, so a dashboard's chart on a dataset the caller cannot open refuses (section 4's control). */
export function setReachForTest(on: boolean): void {
  reach = on;
}
/** Off: a reached dataset reads as open everywhere, the grid included (section 4's control: a row channel leaks). */
export function setFiguresOnlyForTest(on: boolean): void {
  figuresOnly = on;
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

/**
 * Can the caller open this item? (A visual, metric, term or verified question asks of its dataset; an alert of its
 * anchor.) Inside a door's figure scope (D9), the reached datasets it holds read as open — only there.
 */
export async function opens(projectId: string, kind: PlacedKind, id: string): Promise<boolean> {
  if (kind === 'dataset' && inScope(id)) return true;
  if (atLeast(await levelOfItem(projectId, kind, id), 'view')) return true;
  return kind === 'dataset' && !figuresOnly && (await reaches(projectId, id)); // the negative control's leak
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

// ── Reach (D9) ────────────────────────────────────────────────────────────

const scope = new AsyncLocalStorage<ReadonlySet<string>>();
const inScope = (id: string): boolean => scope.getStore()?.has(String(id).toLowerCase()) === true;

const readersMemo = new WeakMap<object, Map<string, Promise<string[]>>>();
/** The folders of the dashboards whose published copy reads `d` (0035): one query per dataset per request. */
function readersOfDataset(p: string, d: string): Promise<string[]> {
  const store = ctx() as object;
  const memo = readersMemo.get(store) ?? readersMemo.set(store, new Map()).get(store)!;
  const key = orgKey(`${p}\u0000${d}`);
  let hit = memo.get(key);
  if (!hit) {
    hit = readersOf(p, [d], rowsUnder).then((m) => m.get(d) ?? []);
    memo.set(key, hit);
    hit.catch(() => memo.delete(key)); // a failed lookup is not remembered as an answer
  }
  return hit;
}

/**
 * Does the caller REACH dataset `id` (D9): not open to them, its top-level folder lets dashboards elsewhere show its
 * data (`share_figures`), and the published copy of some dashboard they open reads it? Asked only of a dataset a
 * folder closes to the caller, so without folders it reads nothing.
 */
export async function reaches(projectId: string, id: string): Promise<boolean> {
  if (!enabled || !reach || !isValidId(projectId) || !isValidId(id)) return false;
  const access = await folderAccessOn(projectId);
  if (access.all || access.noFolders) return false; // everything opens
  const p = projectId.toLowerCase();
  const d = id.toLowerCase();
  const folder = (await placedIn(p, 'dataset')).get(d) ?? p;
  if (levelIn(access, folder) !== 'none' || !access.shareFigures.includes(folder)) return false;
  return (await readersOfDataset(p, d)).some((f) => levelIn(access, f) !== 'none');
}

/** Runs a door's body: inside a figure scope holding exactly the reached datasets it may read, or as it is. */
export type FigureScope = <T>(fn: () => Promise<T>) => Promise<T>;
const direct: FigureScope = (fn) => fn();

/**
 * THE door check (D9), first in every figure door, before the row lock, the Live split and every cache key: the
 * question's dataset, and every other dataset it reads (`reads`: a related column's, a join plan's), open — else
 * reached, and the door's body runs in a figure scope of exactly those (a door inside another reads only its own),
 * where the stores and the storage net hand them through. Neither: `FolderError('closed')`. `open`: a reader beyond
 * the figures (the grid, a profile): a reached dataset refuses `figures_only`. `reads` is not asked when nothing
 * restricts the caller.
 */
export async function folderGate(projectId: string, datasetId: string, reads?: () => Promise<readonly string[]>, mode: 'figures' | 'open' = 'figures'): Promise<FigureScope> {
  if (!enabled || !isValidId(projectId)) return direct;
  const access = await folderAccessOn(projectId);
  if (access.all || access.noFolders) return direct;
  // What the question reads is a security walk (D14): a relationship or a join plan through a closed dataset counts.
  const more = reads && doorReads ? await wholeProject(reads) : [];
  const reached = new Set<string>();
  for (const id of new Set([datasetId, ...more])) {
    if (typeof id !== 'string' || !isValidId(id) || atLeast(await levelOfItem(projectId, 'dataset', id), 'view')) continue;
    if (!inScope(id) && !(await reaches(projectId, id))) throw new FolderError('closed');
    if (mode === 'open' && figuresOnly) throw new FolderError('figures_only');
    reached.add(id.toLowerCase());
  }
  return (fn) => scope.run(reached, fn);
}

/**
 * A FIGURE handler's first step (D9): `fn` in the figure scope of `datasetId` when the caller reaches it, so what it
 * reads around its door (the dataset's columns, its periods, its rows behind a mark) reads there; as it is otherwise —
 * open, or closed, where the stores answer as for a missing id and the doors refuse. Outside such a scope a reached
 * dataset is closed: not listed, its meta null, its rows refused `figures_only`.
 */
export async function inReach<T>(projectId: string, datasetId: unknown, fn: () => Promise<T>): Promise<T> {
  if (typeof datasetId !== 'string') return fn();
  let run: FigureScope;
  try {
    run = await folderGate(projectId, datasetId);
  } catch (err) {
    if (isFolderError(err)) return fn();
    throw err;
  }
  return run(fn);
}

/**
 * The storage net (D11), beside the row rules' `gateRows` under `getDataset` and `residentSource`: a dataset the
 * caller cannot open refuses, typed, whoever reads it — SQL, a Prepare union or lookup, compose, a copy, a
 * relationship's match rate — so a reader nobody listed refuses (a bug report) instead of leaking (a breach). A
 * reached one reads only inside the figure scope a door opened for it; anywhere else it refuses `figures_only`.
 */
export async function gateFolder(projectId: string, id: string): Promise<void> {
  if (!isValidId(projectId) || !isValidId(id) || (await opens(projectId, 'dataset', id))) return;
  throw new FolderError((await reaches(projectId, id)) ? 'figures_only' : 'closed');
}

/**
 * Who opens `anchor` at `min` (D17): `openerEmails`, whoever asks — a push, a recipient list or a mention reaches
 * only them; `anchor.reach` (a refreshed dataset) adds its reachers (D9). With the checks off (a test's negative
 * control) every reader (or writer) of the project, as before E3.
 */
export function openers(pool: Pool, org: string, projectId: string, anchor: { kind: PlacedKind; id: string; reach?: boolean }, min: 'view' | 'edit'): Promise<string[]> {
  if (!enabled) return (min === 'edit' ? writerEmails : readerEmails)(pool, org, projectId);
  return openerEmails(pool, org, projectId, reach ? anchor : { kind: anchor.kind, id: anchor.id }, min, rowsUnder);
}
