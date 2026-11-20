// May this answer be posted where the question was asked? Run when the answer is posted (so someone who joins the
// channel later can read earlier answers: a known, accepted limit — docs/slack/00-design.md, "Rules").
//
//   1. A direct message: the asker is the only member. Pass.
//      A channel shared with another company (`is_ext_shared`): never figures, whatever the data. Private.
//   2. Restricted? Any dataset the stored turn showed with ROW rules, COLUMN rules, or in a team folder not open to
//      everyone — or any dashboard the question was read off. None: case A, post (even with unlinked members: a
//      project admin connected this channel to this assistant).
//   3. Case B: every member must be a person of this Slack organization (no stranger; no guest unless the org allows
//      it), linked, and — as themselves (`asMember`) — able to read the project (`authorize()`), open every dataset and
//      dashboard (folder level not `none`) and see every dataset EXACTLY as the asker does (`accessPrint`: row lock,
//      hidden columns, view). Either direction fails: an admin asking with a restricted viewer present, and a
//      restricted viewer asking with an admin present. More than 500 members: private.
//
// Memoized within one check only, never across questions. Runs inside the asker's request context.

import type { Pool } from 'pg';
import { columnsRuled, policyClosed } from '../../data/rowAccess';
import { accessPrint } from '../../ipc/answerSnapshots';
import { accessFrom, levelIn, placementOf, type FolderRow } from '../authz/folders';
import { levelsOf } from '../authz/folderGate';
import { ctx, type Identity } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import { asMember } from '../requests/where';
import { channelInfo, channelMembers, userInfo } from './client';
import * as store from './db';
import { mayAsk } from './ask';

export const MEMBER_CAP = 500;

export type Why = 'external' | 'too_many' | 'stranger' | 'guest' | 'unlinked' | 'no_access' | 'different_view' | 'account';
export type Verdict = { post: true; case: 'direct' | 'A' | 'B' } | { post: false; why: Why };

export interface Shown { projectId: string; datasetIds: readonly string[]; dashboardIds: readonly string[] }

/** Is a dataset in a folder everyone in the project may open? (A caller-independent read of the folder rule: a viewer with no team grants.) */
async function openToEveryone(projectId: string, datasetIds: readonly string[]): Promise<Set<string>> {
  const db = orgDb();
  if (!db) return new Set(datasetIds); // no Postgres, no folders
  const p = projectId.toLowerCase();
  const rows = (await inOrg((c, org) => c.query<{ id: string; parent_id: string | null; share: boolean }>(
    'SELECT id::text AS id, parent_id::text AS parent_id, share_figures AS share FROM folders WHERE org_id = $1 AND project_id = $2', [org, p]))).rows;
  if (!rows.length) return new Set(datasetIds);
  const folders: FolderRow[] = rows.map((r) => ({ id: r.id, parentId: r.parent_id, shareFigures: r.share, grant: null }));
  const access = accessFrom(p, 1, folders);
  const where = await placementOf(projectId, 'dataset', datasetIds);
  return new Set(datasetIds.filter((id) => levelIn(access, where.get(id.toLowerCase()) ?? p) !== 'none'));
}

/** Case B's trigger: row rules, column rules, a folder not open to everyone, or a dashboard. */
export async function restricted(s: Shown): Promise<boolean> {
  if (s.dashboardIds.length) return true;
  const open = await openToEveryone(s.projectId, s.datasetIds);
  for (const id of s.datasetIds) {
    if (!open.has(id) || (await policyClosed(s.projectId, id)) || (await columnsRuled(s.projectId, id))) return true;
  }
  return false;
}

/** What one person sees of the answer's data, as themselves: null when they may not read it at all. */
export async function viewOf(pool: Pool, who: Identity, s: Shown): Promise<string | null> {
  if (!(await mayAsk(pool, who, s.projectId))) return null;
  const datasets = await levelsOf(s.projectId, 'dataset');
  if (datasets && s.datasetIds.some((id) => datasets(id) === 'none')) return null;
  const boards = s.dashboardIds.length ? await levelsOf(s.projectId, 'dashboard') : null;
  if (boards && s.dashboardIds.some((id) => boards(id) === 'none')) return null;
  const prints: string[] = [];
  for (const id of [...s.datasetIds].sort()) prints.push(await accessPrint(s.projectId, id));
  return prints.join('|');
}

/** The verdict. `asker` is the question's Slack user; the caller is inside the asker's context. */
export async function check(pool: Pool, inst: store.Install, token: string, channelId: string, asker: string, shown: Shown, o: { dm?: boolean; override?: boolean } = {}): Promise<Verdict> {
  if (o.dm) return { post: true, case: 'direct' }; // a direct message (the event says so): the asker is the only member
  const info = await channelInfo(token, channelId);
  if (info.isIm) return { post: true, case: 'direct' };
  if (info.isExtShared) return { post: false, why: 'external' }; // never overridden: another company
  if (!(await restricted(shown))) return { post: true, case: 'A' };
  if (o.override) return { post: true, case: 'B' }; // an org admin's setting let the asker post past the check (./worker.ts passes it)

  const ids = await channelMembers(token, channelId, MEMBER_CAP);
  if (ids.length > MEMBER_CAP) return { post: false, why: 'too_many' };
  const people = new Set<string>();
  for (const id of ids) {
    if (id === inst.botUserId) continue;
    const u = await userInfo(token, id);
    if (u.isBot || u.deleted) continue;
    if (u.isStranger || u.teamId !== inst.teamId) return { post: false, why: 'stranger' };
    if (u.isGuest && !inst.allowGuests) return { post: false, why: 'guest' };
    people.add(id);
  }
  people.add(asker);
  const linked = await store.linkedAmong(inst.orgId, inst.teamId, [...people]);
  if ([...people].some((p) => !linked.has(p))) return { post: false, why: 'unlinked' };

  const me = ctx();
  const mine = await viewOf(pool, me, shown);
  if (mine === null) return { post: false, why: 'no_access' };
  for (const p of people) {
    const email = linked.get(p) as string;
    if (email === me.user.email) continue;
    const theirs = await asMember(email, async () => viewOf(pool, ctx(), shown));
    if (theirs === undefined || theirs === null) return { post: false, why: 'no_access' };
    if (theirs !== mine) return { post: false, why: 'different_view' };
  }
  return { post: true, case: 'B' };
}
