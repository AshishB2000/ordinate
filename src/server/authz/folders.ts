// Shared folders: who can open and edit what inside a project (docs/team-folders/00-design.md, "Who can open
// what"). The rule, in full:
//
//   level(caller, folder F) = manage                      org admin, or project admin (rank 3)
//                           = cap                         root(F) is Everyone (the project id, or under it)
//                           = min(cap, best team grant on root(F))   root(F) is a top-level folder
//                           = none                        no grant, no project role, or F unresolvable
//   cap   = view for a project viewer, edit for a project editor, none without a project role
//   root  = the nearest ancestor (or F) whose parent is NULL (a top-level folder) or the project id
//
// An item's level is its folder's (`placementOf`: no row → Everyone). A folder deeper than MAX_DEPTH, a
// broken parent chain or an id that is no folder of the project resolves to `none` (admins still open it):
// a hide, never a leak. Grants on a subfolder are ignored (D4: top-level folders carry them).
//
// Fail closed: a database error THROWS (the request is refused), never falls back. No Postgres: no teams,
// no folders, everything is in Everyone at the project role. Memoised per request (a WeakMap keyed by the
// request context, inner keys by orgKey and caller), like ./caller.ts. Inert until E2–E6 call it.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { ctx, orgKey } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { inOrg as inOrgOf, readOnceInOrg } from '../db/orgTx';
import { tagRefusals } from '../../data/refusalTag';
import * as msg from '../folderMessages';
import { rankOn } from './caller';
import { readerEmails, writerEmails } from './index';

export type FolderLevel = 'none' | 'view' | 'edit' | 'manage';
/** The kinds a folder holds (D3); everything else follows one of them. */
export type PlacedKind = 'dataset' | 'dashboard';

/** `all`: every folder (rank 3, or a `wholeProject` walk). Otherwise folder ids, the project id standing for Everyone. */
export type FolderAccess =
  | { readonly all: true }
  | {
      readonly all: false;
      readonly open: readonly string[];
      readonly edit: readonly string[];
      readonly viewOnly: readonly string[];
      /** Folders whose top-level folder lets dashboards elsewhere show its data (`share_figures`), Everyone included. */
      readonly shareFigures: readonly string[];
      /** The project has no folder besides Everyone, so nothing is placed: no placement query is needed. */
      readonly noFolders: boolean;
    };

/** One folder of the project as the resolver's query returns it; `grant` is the caller's best team grant on it. */
export interface FolderRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly shareFigures: boolean;
  readonly grant: 'view' | 'edit' | null;
}

export const MAX_DEPTH = 5;
const PLACED: ReadonlySet<string> = new Set(['dataset', 'dashboard']);
const ORDER: Readonly<Record<FolderLevel, number>> = { none: 0, view: 1, edit: 2, manage: 3 };
const ALL: FolderAccess = Object.freeze({ all: true as const });

// ── The refusal (D15) ─────────────────────────────────────────────────────

export const FOLDER_CODE = 'folder';
export type FolderReason = 'closed' | 'figures_only' | 'edit' | 'publish' | 'move_changed' | 'not_empty';

const SENTENCES: Readonly<Record<FolderReason, () => string>> = {
  closed: msg.folderClosedMessage,
  figures_only: msg.folderFiguresOnlyMessage,
  edit: msg.folderEditMessage,
  publish: msg.folderPublishMessage,
  move_changed: msg.folderMoveChangedMessage,
  not_empty: msg.folderNotEmptyMessage,
};
export const FOLDER_REASONS = Object.keys(SENTENCES) as FolderReason[];

let raised = 0;

/** A folder refusal: the route answers it 409 `folder` with its sentence. A catch never turns it into `[]` or `null`. */
export class FolderError extends Error {
  readonly code = FOLDER_CODE;
  readonly reason: FolderReason;
  constructor(reason: FolderReason) {
    super(SENTENCES[reason]());
    this.name = 'FolderError';
    this.reason = reason;
    raised++;
  }
}

/** True for a FolderError — by class, or by name and code when it crossed a module copy. */
export function isFolderError(err: unknown): err is FolderError {
  if (err instanceof FolderError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && typeof e === 'object' && e.name === 'FolderError' && e.code === FOLDER_CODE;
}

/** How many refusals this process has raised: the route walks a reply for caught ones only when this moved. */
export function folderRaised(): number {
  return raised;
}

/** The refusal as a reply, for a door whose contract answers `{ok:false, error}` (a chart door never throws). */
export function folderRefusal(reason: FolderReason): { ok: false; code: typeof FOLDER_CODE; reason: FolderReason; error: string } {
  return { ok: false, code: FOLDER_CODE, reason, error: SENTENCES[reason]() };
}

/** Types the folder refusals a handler caught into `{ok:false, error}` (per batch item), as row access rules do. */
export function tagFolderRefusals<T>(reply: T): T {
  return tagRefusals(reply, new Map(FOLDER_REASONS.map((r) => [SENTENCES[r](), r])), FOLDER_CODE);
}

// ── The rule, pure ────────────────────────────────────────────────────────

const capOf = (rank: number): FolderLevel => (rank >= 3 ? 'manage' : rank === 2 ? 'edit' : rank === 1 ? 'view' : 'none');

/** `id`'s root: Everyone, a top-level folder's row, or null (not a folder here, a broken chain, too deep). */
function rootOf(projectId: string, id: string, byId: ReadonlyMap<string, FolderRow>): FolderRow | 'everyone' | null {
  if (id === projectId) return 'everyone';
  let f = byId.get(id);
  let depth = 0;
  while (f) {
    if (f.parentId === null) return f;
    depth++;
    if (depth > MAX_DEPTH) return null; // also ends a cycle
    if (f.parentId === projectId) return 'everyone';
    f = byId.get(f.parentId);
  }
  return null;
}

function levelAt(root: FolderRow | 'everyone' | null, cap: FolderLevel): FolderLevel {
  if (cap === 'manage') return 'manage';
  if (root === null || cap === 'none') return 'none';
  if (root === 'everyone') return cap;
  if (root.grant === null) return 'none';
  return ORDER[root.grant] < ORDER[cap] ? root.grant : cap;
}

/** The rule over one project's folders for a caller of project `rank` (3 admin … 0 none). Pure. */
export function accessFrom(projectId: string, rank: number, rows: readonly FolderRow[]): FolderAccess {
  const cap = capOf(rank);
  if (cap === 'manage') return ALL;
  const p = projectId.toLowerCase();
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), { ...r, parentId: r.parentId === null ? null : r.parentId.toLowerCase() }]));
  const open: string[] = [];
  const edit: string[] = [];
  const shareFigures: string[] = [];
  for (const id of [p, ...byId.keys()]) {
    const root = rootOf(p, id, byId);
    const level = levelAt(root, cap);
    if (level !== 'none') open.push(id);
    if (level === 'edit') edit.push(id);
    if (root === 'everyone' || (root !== null && root.shareFigures)) shareFigures.push(id);
  }
  return Object.freeze({ all: false as const, open, edit, viewOnly: open.filter((id) => !edit.includes(id)), shareFigures, noFolders: rows.length === 0 });
}

/** The caller's level on folder `folderId` (the project id for Everyone), from their access. */
export function levelIn(access: FolderAccess, folderId: string): FolderLevel {
  if (access.all) return 'manage';
  const id = folderId.toLowerCase();
  return access.edit.includes(id) ? 'edit' : access.open.includes(id) ? 'view' : 'none';
}

/** `a` reaches at least `min`. */
export const atLeast = (a: FolderLevel, min: FolderLevel): boolean => ORDER[a] >= ORDER[min];

// ── Whole-project walks (D14) ─────────────────────────────────────────────

const whole = new AsyncLocalStorage<true>();

/**
 * `fn` with folder filtering off for reads: a security walk (lineage, policy checks) must see every dataset,
 * or it fails open. Never for what a reply carries. Its call sites are an allowlist (the safety net, E2).
 */
export function wholeProject<T>(fn: () => Promise<T>): Promise<T> {
  return whole.run(true, fn);
}

export function inWholeProject(): boolean {
  return whole.getStore() === true;
}

// ── The resolver ──────────────────────────────────────────────────────────

const accessMemo = new WeakMap<object, Map<string, Promise<FolderAccess>>>();
const placeMemo = new WeakMap<object, Map<string, string>>();

const perRequest = <T>(m: WeakMap<object, Map<string, T>>): Map<string, T> => {
  const store = ctx() as object;
  let inner = m.get(store);
  if (!inner) {
    inner = new Map();
    m.set(store, inner);
  }
  return inner;
};

/** Every folder of the project with its parent, its switch and `email`'s best team grant on it (null: none). */
async function treeOf(c: PoolClient, org: string, projectId: string, email: string | null): Promise<FolderRow[]> {
  const r = await c.query<{ id: string; parent_id: string | null; share: boolean; best: number }>(
    `SELECT f.id::text AS id, f.parent_id::text AS parent_id, f.share_figures AS share,
            max(CASE g.level WHEN 'edit' THEN 2 WHEN 'view' THEN 1 ELSE 0 END)::int AS best
       FROM folders f
       LEFT JOIN folder_grants g
         ON g.org_id = f.org_id AND g.project_id = f.project_id AND g.folder_id = f.id
        AND g.team_id IN (SELECT tm.team_id FROM team_members tm JOIN users u ON u.id = tm.user_id
                           WHERE u.org_id = $1 AND u.email = $3 AND u.disabled_at IS NULL)
      WHERE f.org_id = $1 AND f.project_id = $2
      GROUP BY f.id, f.parent_id, f.share_figures`,
    [org, projectId, email],
  );
  return r.rows.map((x) => ({ id: x.id, parentId: x.parent_id, shareFigures: x.share, grant: x.best === 2 ? 'edit' : x.best === 1 ? 'view' : null }));
}

async function resolve(projectId: string): Promise<FolderAccess> {
  const rank = await rankOn(projectId);
  if (rank >= 3) return ALL;
  if (!orgDb() || perRequest(bareMemo).has(orgKey(projectId))) return accessFrom(projectId, rank, []); // no folders (known this request)
  const email = ctx().user.email;
  return accessFrom(projectId, rank, await inOrg((c, org) => treeOf(c, org, projectId, email)));
}

/**
 * The caller's folders on `projectId`. Org admins, project admins and `wholeProject` walks: `{ all: true }`, no query.
 * So is a published page's request (`/p/`, a signed embed): its audience is the link's (D17), chosen at Publish.
 */
export function folderAccessOn(projectId: string): Promise<FolderAccess> {
  const who = ctx();
  if (who.user.role === 'admin' || who.published === true || inWholeProject()) return Promise.resolve(ALL); // org admins, the jobs' system identity, desktop
  const p = projectId.toLowerCase();
  const memo = perRequest(accessMemo);
  const key = orgKey(`${who.user.email}\u0000${p}`);
  let hit = memo.get(key);
  if (!hit) {
    hit = resolve(p);
    memo.set(key, hit);
    hit.catch(() => memo.delete(key)); // a failed lookup is not remembered as an answer
  }
  return hit;
}

const bareMemo = new WeakMap<object, Map<string, true>>(); // per request: projects `foldersRestrict` found without a folder
let batched = true;
/** Test seam (scripts/folderNetSends.ts): its NEGATIVE CONTROL resolves each project on its own, as before the batch. */
export function setFolderBatchForTest(on: boolean): void {
  batched = on;
}

/**
 * The projects among `projectIds` where folders may restrict the caller — those with a folder besides Everyone — from
 * ONE round trip for a list across projects (projects:overview). The rest are remembered for this request as having
 * none, so their resolver asks no tree. None, with no read, for a caller nothing restricts (an org admin, a published
 * page, a `wholeProject` walk) or without a database.
 */
export async function foldersRestrict(projectIds: readonly string[]): Promise<ReadonlySet<string>> {
  const who = ctx();
  const pool = orgDb();
  const ids = [...new Set(projectIds.map((p) => p.toLowerCase()))];
  if (!pool || !ids.length || who.user.role === 'admin' || who.published === true || inWholeProject()) return new Set();
  if (!batched) return new Set(ids);
  const rows = await readOnceInOrg<{ project_id: string }>(pool, who.org.id, `SELECT DISTINCT project_id::text AS project_id FROM folders WHERE org_id = current_setting('ordinate.org')`);
  const has = new Set(rows.map((r) => r.project_id.toLowerCase()));
  const bare = perRequest(bareMemo);
  for (const id of ids) if (!has.has(id)) bare.set(orgKey(id), true);
  return new Set(ids.filter((id) => has.has(id)));
}

const checkKind = (kind: string): void => {
  if (!PLACED.has(kind)) throw new Error(`not a placed kind: ${kind}`);
};

/** Where each of `ids` sits: its folder id, or the project id (Everyone). One query for the ids not seen this request. */
export async function placementOf(projectId: string, kind: PlacedKind, ids: readonly string[]): Promise<Map<string, string>> {
  checkKind(kind);
  const p = projectId.toLowerCase();
  const memo = perRequest(placeMemo);
  const keyOf = (id: string): string => orgKey(`${p}\u0000${kind}\u0000${id}`);
  const want = [...new Set(ids.map((id) => id.toLowerCase()))];
  const missing = want.filter((id) => !memo.has(keyOf(id)));
  if (missing.length && orgDb()) {
    const rows = await inOrg(async (c, org) =>
      (await c.query<{ item_id: string; folder_id: string }>(
        `SELECT item_id, folder_id::text AS folder_id FROM folder_items
          WHERE org_id = $1 AND project_id = $2 AND kind = $3 AND item_id = ANY($4::text[])`,
        [org, p, kind, missing],
      )).rows,
    );
    for (const r of rows) memo.set(keyOf(r.item_id), r.folder_id);
  }
  for (const id of missing) if (!memo.has(keyOf(id))) memo.set(keyOf(id), p);
  return new Map(want.map((id) => [id, memo.get(keyOf(id)) as string]));
}

const listMemo = new WeakMap<object, Map<string, Promise<ReadonlyMap<string, string>>>>();

/** Every moved item of `kind` in the project → its folder (one query, memoised per request): what a list filters by. */
export function placedIn(projectId: string, kind: PlacedKind): Promise<ReadonlyMap<string, string>> {
  checkKind(kind);
  const p = projectId.toLowerCase();
  const memo = perRequest(listMemo);
  const key = orgKey(`${p}\u0000${kind}`);
  let hit = memo.get(key);
  if (!hit) {
    hit = orgDb()
      ? inOrg(async (c, org) => new Map((await c.query<{ item_id: string; folder_id: string }>(
          'SELECT item_id, folder_id::text AS folder_id FROM folder_items WHERE org_id = $1 AND project_id = $2 AND kind = $3',
          [org, p, kind],
        )).rows.map((r) => [r.item_id, r.folder_id])))
      : Promise.resolve(new Map());
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}

/** The caller's level on one item. Rank 3 and a project without folders need no placement query. */
export async function levelOn(projectId: string, kind: PlacedKind, id: string): Promise<FolderLevel> {
  checkKind(kind);
  const access = await folderAccessOn(projectId);
  if (access.all) return 'manage';
  if (access.noFolders) return levelIn(access, projectId);
  return levelIn(access, (await placementOf(projectId, kind, [id])).get(id.toLowerCase()) ?? projectId);
}

const ROLES_FOR: Readonly<Record<'view' | 'edit', string[]>> = { view: ['viewer', 'editor', 'admin'], edit: ['editor', 'admin'] };
const LEVELS_FOR: Readonly<Record<'view' | 'edit', string[]>> = { view: ['view', 'edit'], edit: ['edit'] };

/**
 * Every enabled member of `org` whose level on `anchor` reaches `min`, by the rule above — `readerEmails` /
 * `writerEmails` narrowed to the anchor's root folder, for a push or a recipient list (D17). Everyone: exactly
 * those two. A top-level folder: org admins, project admins, and members whose project role reaches `min`
 * and whose team holds `min` on it. An unresolvable folder: admins only. Outside a request (jobs): takes its org.
 */
export async function openerEmails(pool: Pool, org: string, projectId: string, anchor: { kind: PlacedKind; id: string }, min: 'view' | 'edit'): Promise<string[]> {
  checkKind(anchor.kind);
  const p = projectId.toLowerCase();
  const out = await inOrgOf(pool, org, async (c): Promise<string[] | null> => {
    const placed = await c.query<{ folder_id: string }>(
      'SELECT folder_id::text AS folder_id FROM folder_items WHERE org_id = $1 AND project_id = $2 AND kind = $3 AND item_id = $4',
      [org, p, anchor.kind, anchor.id.toLowerCase()],
    );
    const folder = placed.rows[0]?.folder_id;
    const root = folder ? rootOf(p, folder, new Map((await treeOf(c, org, p, null)).map((r) => [r.id, r]))) : 'everyone';
    if (root === 'everyone') return null;
    const r = await c.query<{ email: string }>(
      `SELECT u.email FROM users u
        WHERE u.org_id = $1 AND u.disabled_at IS NULL
          AND (u.role = 'admin'
               OR EXISTS (SELECT 1 FROM project_grants g
                           WHERE g.org_id = u.org_id AND g.project_id = $2 AND g.role = 'admin'
                             AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id)))
               OR (EXISTS (SELECT 1 FROM project_grants g
                            WHERE g.org_id = u.org_id AND g.project_id = $2 AND g.role = ANY($3::text[])
                              AND (g.user_id = u.id OR g.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id)))
                   AND EXISTS (SELECT 1 FROM folder_grants fg
                                WHERE fg.org_id = u.org_id AND fg.project_id = $2 AND fg.folder_id = $4::uuid
                                  AND fg.level = ANY($5::text[])
                                  AND fg.team_id IN (SELECT team_id FROM team_members WHERE user_id = u.id))))
        ORDER BY u.email`,
      [org, p, ROLES_FOR[min], root === null ? null : root.id, LEVELS_FOR[min]],
    );
    return r.rows.map((row) => row.email);
  });
  if (out) return out;
  return min === 'edit' ? writerEmails(pool, org, p) : readerEmails(pool, org, p);
}
