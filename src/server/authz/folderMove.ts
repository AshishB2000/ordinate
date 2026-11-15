// Moving datasets and dashboards between folders (docs/team-folders/00-design.md, "Folders, items and moves").
//
//   - `impactOf` is the move warning (`folder:moveImpact`): the teams and head counts who lose and gain access, who
//     keeps access at another level, the moved dashboards with a published link (its page keeps its audience, D17),
//     subscription email recipients who stop receiving one, and dashboards in other folders whose published copy shows
//     a moved dataset (and whether the destination lets them, `share_figures`). It hashes that answer together with the
//     people behind it, by email;
//   - `moveItems` (`folder:move`) computes it again and refuses `move_changed` unless the hash is the one the person
//     was shown, then writes the `folder_items` rows in one statement each, as `placeFirst` does (no row: Everyone).
//     What follows a dataset or a dashboard (D3) needs no row of its own, and no index row changes (D1).
//
// Needs Edit where each item is and where it goes (a project admin moves anything); an item the caller cannot open is
// `closed`, as a missing one. A dataset leaving Everyone has its project's dashboard_reads built first (E5's marker),
// so its reach is known before anyone needs it.

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { isValidId } from '../../app/ids';
import { rowsUnder } from '../../app/recordFs';
import { ctx } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { buildReads, DASHBOARD_READS_VERSION } from '../dashboardReads';
import * as msg from '../folderMessages';
import { rankOn } from './caller';
import { folderAccessOn, FolderError, levelIn, rootOf, type FolderAccess, type FolderLevel, type FolderRow, type PlacedKind } from './folders';
import { levelAt, membersOn, type Member } from './folderPeople';

export interface MoveInput {
  readonly items: ReadonlyArray<{ kind: PlacedKind; id: string }>;
  readonly to: string;
  readonly from?: string;
}

/** A team (null: Everyone in the project) and how many of its people a move changes. */
export interface Group { readonly team: string | null; readonly people: number }

export interface MoveImpact {
  readonly ok: true;
  /** The destination's name; null for Everyone in the project. */
  readonly to: string | null;
  readonly moving: { readonly datasets: number; readonly dashboards: number };
  readonly lose: readonly Group[];
  readonly gain: readonly Group[];
  /** People who keep access but can no longer change them, and who can now. */
  readonly viewOnly: number;
  readonly canEdit: number;
  /** Moved dashboards with a published link (or an embed of one): that page keeps its audience (D17). */
  readonly published: number;
  /** Subscription email recipients who stop receiving a moved dashboard. */
  readonly recipients: number;
  /** Dashboards in other folders whose published copy shows a moved dataset; `keeps`: the destination lets them (D9). */
  readonly reachers: { readonly dashboards: number; readonly keeps: boolean };
  readonly hash: string;
}

/** Per item, who loses and gains it, by email: what the safety net holds a move to. Never sent. */
export interface MoveDetail { readonly kind: PlacedKind; readonly id: string; readonly from: string; readonly lose: string[]; readonly gain: string[] }

type Failed = { ok: false; error: string };
const fail = (error: string): Failed => ({ ok: false, error });

interface Grant { teamId: string; team: string; level: 'view' | 'edit' }
interface World { byId: Map<string, FolderRow>; names: Map<string, string>; grants: Map<string, Grant[]>; members: Member[] }

async function worldOf(c: PoolClient, org: string, p: string): Promise<World> {
  const rows = (await c.query<{ id: string; parent_id: string | null; name: string; share_figures: boolean }>(
    'SELECT id::text AS id, parent_id::text AS parent_id, name, share_figures FROM folders WHERE org_id = $1 AND project_id = $2', [org, p],
  )).rows;
  const byId = new Map(rows.map((r) => [r.id.toLowerCase(), { id: r.id.toLowerCase(), parentId: r.parent_id === null ? null : r.parent_id.toLowerCase(), shareFigures: r.share_figures, grant: null }]));
  const grants = new Map<string, Grant[]>();
  for (const g of (await c.query<{ folder_id: string; team_id: string; name: string; level: 'view' | 'edit' }>(
    `SELECT g.folder_id::text AS folder_id, g.team_id::text AS team_id, t.name, g.level
       FROM folder_grants g JOIN teams t ON t.id = g.team_id AND t.org_id = g.org_id WHERE g.org_id = $1 AND g.project_id = $2`, [org, p],
  )).rows) {
    const f = g.folder_id.toLowerCase();
    (grants.get(f) ?? grants.set(f, []).get(f) as Grant[]).push({ teamId: g.team_id.toLowerCase(), team: g.name, level: g.level });
  }
  return { byId, names: new Map(rows.map((r) => [r.id.toLowerCase(), r.name])), grants, members: await membersOn(c, org, p) };
}

/** A folder's root as an id (the project id: Everyone), or null — the resolver's `rootOf`. */
const rootId = (p: string, id: string, w: World): string | null => {
  const r = rootOf(p, id, w.byId);
  return r === null ? null : r === 'everyone' ? p : r.id;
};

function mustEdit(access: FolderAccess, id: string): void {
  const level = levelIn(access, id);
  if (level === 'none') throw new FolderError('closed');
  if (level === 'view') throw new FolderError('edit');
}

/** Datasets and dashboards a `from` move takes: every placed one there and below (the Trash included). */
function under(p: string, from: string, w: World): Set<string> {
  if (from === p) return new Set(w.byId.keys());
  const out = [from];
  for (let i = 0; i < out.length; i++) for (const f of w.byId.values()) if (f.parentId === out[i]) out.push(f.id);
  return new Set(out);
}

/** Does the item exist for the caller? A dataset through their store (null for closed or missing), a dashboard's record. */
async function exists(p: string, kind: PlacedKind, id: string): Promise<boolean> {
  if (kind === 'dataset') return (await (require('../../data/datasets') as typeof import('../../data/datasets')).getDatasetMeta(p, id)) !== null;
  return (await (require('../../analysis/analysis') as typeof import('../../analysis/analysis')).getStoredAnalysis(p, id)) !== null;
}

/** The moved dashboards among the project's published links and embeds. */
async function publishedOf(p: string, boards: readonly string[]): Promise<number> {
  if (!boards.length) return 0;
  const sites = await (require('../../publish/hosted') as typeof import('../../publish/hosted')).listSites(p);
  const on = new Set(sites.flatMap((s) => s.config.dashboardIds.map((d) => d.toLowerCase())));
  return boards.filter((b) => on.has(b)).length;
}

/** Per moved dashboard, the members its subscriptions' email channels name (users and teams), by id. */
async function recipientsOf(p: string, boards: readonly string[]): Promise<Map<string, { users: Set<string>; teams: Set<string> }>> {
  const out = new Map<string, { users: Set<string>; teams: Set<string> }>();
  if (!boards.length) return out;
  const subs = (await (require('../../analysis/subscriptions') as typeof import('../../analysis/subscriptions')).listSubscriptions(p)).filter((s) => s.enabled && boards.includes(s.analysisId.toLowerCase()));
  if (!subs.length) return out;
  const channels = new Map((await (require('../../app/channels') as typeof import('../../app/channels')).listChannels()).map((c) => [c.id.toLowerCase(), c]));
  for (const s of subs) {
    const to = out.get(s.analysisId.toLowerCase()) ?? out.set(s.analysisId.toLowerCase(), { users: new Set(), teams: new Set() }).get(s.analysisId.toLowerCase())!;
    for (const id of s.channelIds) {
      const ch = channels.get(id.toLowerCase());
      if (ch?.kind !== 'email' || !ch.to) continue; // Slack and Teams are outside Ordinate's directory (D17)
      for (const u of ch.to.userIds) to.users.add(u.toLowerCase());
      for (const t of ch.to.teamIds) to.teams.add(t.toLowerCase());
    }
  }
  return out;
}

/** Dashboards (id → folder) whose published copy reads one of `datasets`, from 0035 — built first when unbuilt. */
async function readersOfAll(p: string, datasets: readonly string[]): Promise<Map<string, string>> {
  if (!datasets.length) return new Map();
  const ask = () => inOrg(async (c, org) => {
    const built = (await c.query('SELECT 1 FROM dashboard_reads_built WHERE org_id = $1 AND project_id = $2 AND version = $3', [org, p, DASHBOARD_READS_VERSION])).rowCount === 1;
    const rows = (await c.query<{ analysis_id: string; folder: string }>(
      `SELECT DISTINCT r.analysis_id, coalesce(f.folder_id::text, $2::text) AS folder FROM dashboard_reads r
         LEFT JOIN folder_items f ON f.org_id = r.org_id AND f.project_id = r.project_id AND f.kind = 'dashboard' AND f.item_id = r.analysis_id
        WHERE r.org_id = $1 AND r.project_id = $2::uuid AND r.dataset_id = ANY($3::text[])`, [org, p, datasets],
    )).rows;
    return { built, readers: new Map(rows.map((r) => [r.analysis_id, r.folder.toLowerCase()])) };
  });
  const first = await ask();
  if (first.built) return first.readers;
  await buildReads(p, rowsUnder);
  return (await ask()).readers;
}

const groupsOf = (sets: Map<string | null, Set<string>>): Group[] =>
  [...sets].map(([team, people]) => ({ team, people: people.size })).sort((a, b) => b.people - a.people || String(a.team ?? '').localeCompare(String(b.team ?? '')));

/**
 * The move warning, and what it was computed from. Refuses (throws) as the move would: `closed` for an item or a
 * destination the caller cannot open, `edit` below Edit. `moves`: the items whose folder changes, with where they are.
 */
export async function impactOf(projectId: string, input: MoveInput): Promise<Failed | { ok: true; impact: MoveImpact; detail: MoveDetail[]; moves: Array<{ kind: PlacedKind; id: string; from: string }> }> {
  if (!orgDb()) return fail(msg.folderNeedsDatabaseMessage());
  const p = projectId.toLowerCase();
  const to = input.to.toLowerCase();
  const from = input.from?.toLowerCase();
  const access = await folderAccessOn(p);
  if (from === p && (to !== p || (await rankOn(p)) < 3)) return fail(msg.folderEverythingAdminMessage());
  const { w, placed } = await inOrg(async (c, org) => ({
    w: await worldOf(c, org, p),
    placed: (await c.query<{ kind: PlacedKind; item_id: string; folder_id: string }>(
      'SELECT kind, item_id, folder_id::text AS folder_id FROM folder_items WHERE org_id = $1 AND project_id = $2', [org, p],
    )).rows,
  }));
  if (to !== p && !w.byId.has(to)) throw new FolderError('closed');
  mustEdit(access, to);
  const where = new Map(placed.map((r) => [`${r.kind}:${r.item_id}`, r.folder_id.toLowerCase()]));
  const wanted = new Map<string, { kind: PlacedKind; id: string; from: string }>();
  for (const it of input.items) {
    const id = it.id.toLowerCase();
    if (!isValidId(id)) continue;
    const at = where.get(`${it.kind}:${id}`) ?? p;
    mustEdit(access, at);
    if (!(await exists(p, it.kind, id))) throw new FolderError('closed');
    wanted.set(`${it.kind}:${id}`, { kind: it.kind, id, from: at });
  }
  if (from) {
    if (from !== p && !w.byId.has(from)) throw new FolderError('closed');
    mustEdit(access, from);
    const fs = under(p, from, w);
    for (const r of placed) if (fs.has(r.folder_id.toLowerCase()) && (r.kind === 'dataset' || r.kind === 'dashboard')) wanted.set(`${r.kind}:${r.item_id}`, { kind: r.kind, id: r.item_id, from: r.folder_id.toLowerCase() });
  }
  const moves = [...wanted.values()].filter((m) => m.from !== to).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));

  const toRoot = rootId(p, to, w);
  const after = (m: Member): FolderLevel => levelAt(m, toRoot, p, toRoot ? w.grants.get(toRoot) ?? [] : []);
  const lose = new Map<string | null, Set<string>>();
  const gain = new Map<string | null, Set<string>>();
  const viewOnly = new Set<string>();
  const canEdit = new Set<string>();
  const add = (g: Map<string | null, Set<string>>, team: string | null, email: string) => (g.get(team) ?? g.set(team, new Set()).get(team) as Set<string>).add(email);
  const teamsOn = (root: string | null, m: Member): Array<string | null> =>
    root === p ? [null] : (root ? w.grants.get(root) ?? [] : []).filter((g) => m.teams.includes(g.teamId)).map((g) => g.team);
  const detail: MoveDetail[] = [];
  const losing = new Map<string, Set<string>>(); // item → member ids who lose it
  for (const mv of moves) {
    const fromRoot = rootId(p, mv.from, w);
    const d: MoveDetail = { ...mv, lose: [], gain: [] };
    const out = new Set<string>();
    for (const m of w.members) {
      const a = levelAt(m, fromRoot, p, fromRoot ? w.grants.get(fromRoot) ?? [] : []);
      const b = after(m);
      if (a !== 'none' && b === 'none') {
        d.lose.push(m.email);
        out.add(m.id);
        for (const t of teamsOn(fromRoot, m)) add(lose, t, m.email);
      } else if (a === 'none' && b !== 'none') {
        d.gain.push(m.email);
        for (const t of teamsOn(toRoot, m)) add(gain, t, m.email);
      } else if (a === 'edit' && b === 'view') viewOnly.add(m.email);
      else if (a === 'view' && b === 'edit') canEdit.add(m.email);
    }
    losing.set(`${mv.kind}:${mv.id}`, out);
    detail.push(d);
  }

  const boards = moves.filter((m) => m.kind === 'dashboard').map((m) => m.id);
  const datasets = moves.filter((m) => m.kind === 'dataset').map((m) => m.id);
  const subs = await recipientsOf(p, boards);
  const stop = new Set<string>();
  for (const [board, to2] of subs) {
    for (const m of w.members) if (losing.get(`dashboard:${board}`)?.has(m.id) && (to2.users.has(m.id) || m.teams.some((t) => to2.teams.has(t)))) stop.add(m.email);
  }
  const moved = new Set(boards);
  const readers = to === p ? new Map<string, string>() : await readersOfAll(p, datasets);
  const elsewhere = [...readers].filter(([b, f]) => !moved.has(b) && rootId(p, f, w) !== toRoot).map(([b]) => b).sort();
  const keeps = toRoot === p || (toRoot !== null && w.byId.get(toRoot)?.shareFigures === true);
  const published = await publishedOf(p, boards);

  const answer = {
    ok: true as const,
    to: to === p ? null : w.names.get(to) ?? null,
    moving: { datasets: datasets.length, dashboards: boards.length },
    lose: groupsOf(lose),
    gain: groupsOf(gain),
    viewOnly: viewOnly.size,
    canEdit: canEdit.size,
    published,
    recipients: stop.size,
    reachers: { dashboards: elsewhere.length, keeps },
  };
  // The hash covers the answer and the people behind it: a member swapped in a team changes it, though no count moves.
  const behind = { to, toRoot, detail, viewOnly: [...viewOnly].sort(), canEdit: [...canEdit].sort(), stop: [...stop].sort(), elsewhere, who: ctx().user.email.toLowerCase() };
  const hash = createHash('sha256').update(JSON.stringify({ answer, behind })).digest('hex');
  return { ok: true, impact: { ...answer, hash }, detail, moves };
}

/**
 * The move: the warning computed again, refused `move_changed` unless its hash is `hash`, then the placements written
 * in one transaction. Moving to Everyone deletes the rows (D2).
 */
export async function moveItems(projectId: string, input: MoveInput & { hash: string }): Promise<Failed | { ok: true; moved: number }> {
  const r = await impactOf(projectId, input);
  if (!r.ok) return r;
  if (r.impact.hash !== input.hash) throw new FolderError('move_changed');
  if (!r.moves.length) return { ok: true, moved: 0 };
  const p = projectId.toLowerCase();
  const to = input.to.toLowerCase();
  const kinds = r.moves.map((m) => m.kind);
  const ids = r.moves.map((m) => m.id);
  // shortcut: a grant or team change between the check above and this write is not seen; the window is one request.
  await inOrg(async (c, org) => {
    if (to === p) {
      await c.query('DELETE FROM folder_items WHERE org_id = $1 AND project_id = $2 AND (kind, item_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))', [org, p, kinds, ids]);
      return;
    }
    await c.query(
      `INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by)
       SELECT $1, $2, k, i, $5::uuid, $6 FROM unnest($3::text[], $4::text[]) AS m(k, i)
       ON CONFLICT (org_id, project_id, kind, item_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, moved_by = EXCLUDED.moved_by, moved_at = now()`,
      [org, p, kinds, ids, to, ctx().user.email],
    );
  });
  return { ok: true, moved: r.moves.length };
}
