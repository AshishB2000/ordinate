// @mentions over RPC (docs/notifications/00-design.md §5.10-5.13): the picker's
// people, the caller's "Mentioned you" list on Home and its seen marks, and the
// caller's own "Email me when someone mentions me". Every one is the CALLER's;
// the address is ctx()'s, never the input's.

import * as comments from '../../app/comments';
import type { Comment } from '../../app/commentModel';
import { commentSnippet, mentionsIn, normalize, personName, tokenizable } from '../../app/mentionToken';
import { ctx } from '../context';
import { mailReady } from '../mail/emailChannel';
import { aDeletedRecord, mentionsOff } from '../mentionMessages';
import { registry } from '../rpc';
import { currentReaders, labelFor, mentionsOn, peopleIn } from './people';
import { emailMe, listMine, markGone, markSeen, setEmailMe, unseenCount } from './store';

/** People the picker offers. */
export const PICKER_MAX = 8;
/** Rows Home shows, and how many it reads to find them (pieces deleted since are skipped). */
export const HOME_MAX = 20;
const HOME_READ = 60;
/** Projects one call reads comments from. */
export const HOME_PROJECTS = 10;
const SNIPPET = 200;

/** Up to PICKER_MAX current readers matching `q`: filtered first (match, not the caller, a token can carry them), then cut. */
export async function mentionable(projectId: string, q: string): Promise<{ available: boolean; people: Array<{ email: string; name: string }> }> {
  const readers = await currentReaders(projectId);
  if (!readers) return { available: false, people: [] };
  const me = normalize(ctx().user.email);
  const query = normalize(String(q ?? '').trim()).replace(/^@/, '');
  const hit = (email: string, name: string): number => (!query ? 1 : email.startsWith(query) || normalize(name).startsWith(query) ? 2 : email.includes(query) || normalize(name).includes(query) ? 1 : 0);
  const people = [...readers]
    .map((email) => ({ email, name: personName(email) }))
    .filter((p) => hit(p.email, p.name) > 0 && p.email !== me && tokenizable(p.email))
    .sort((a, b) => hit(b.email, b.name) - hit(a.email, a.name) || a.email.localeCompare(b.email))
    .slice(0, PICKER_MAX);
  return { available: true, people };
}

export interface HomeMention {
  projectId: string;
  id: string;
  commentId: string;
  target: Comment['target'];
  on: { name: string; analysisId?: string };
  by: string;
  snippet: string;
  at: string;
  seen: boolean;
}

/**
 * The caller's "Mentioned you": unseen first, each read from the comment as it is
 * now. A row whose piece is gone (deleted, or edited to no longer name the
 * caller) is marked seen, so it never hides what is new; `unseen` is the
 * database's count after that, which is what Mark all seen answers to.
 */
export async function homeMentions(): Promise<{ available: boolean; items: HomeMention[]; unseen: number }> {
  if (!mentionsOn()) return { available: false, items: [], unseen: 0 };
  const me = normalize(ctx().user.email);
  // One call reads at most HOME_PROJECTS projects' comments (the rows' first ones, unseen first): rows on others wait.
  const projects = new Set<string>();
  const rows = (await listMine(HOME_READ)).filter((r) => projects.has(r.projectId) || (projects.size < HOME_PROJECTS && !!projects.add(r.projectId)));
  const { targetNames } = require('../../ipc/comments') as typeof import('../../ipc/comments'); // lazy: that module starts the notices
  const found = new Map<string, { c: Comment; body: string }>(); // project + piece → the comment as it is now
  const gone: Array<{ projectId: string; pieceId: string }> = [];
  const names = new Map<string, Record<string, { name: string; analysisId?: string }>>();
  const readersOf = new Map<string, Set<string> | null>();
  for (const pid of projects) {
    const r = await comments.list(pid).catch(() => null);
    const list = r && r.ok ? r.comments : [];
    const threads = new Map<string, Comment>();
    for (const row of rows) {
      if (row.projectId !== pid) continue;
      const c = list.find((x) => x.id === row.commentId);
      const body = !c ? null : row.pieceId === c.id ? c.body : c.replies.find((x) => x.id === row.pieceId && !x.deletedAt)?.body ?? null;
      if (!c || body === null || !mentionsIn(body).includes(me)) {
        if (!row.seen) gone.push({ projectId: pid, pieceId: row.pieceId }); // deleted, or edited to no longer name the caller
        continue;
      }
      found.set(`${pid}:${row.pieceId}`, { c, body });
      threads.set(c.id, c);
    }
    if (!threads.size) continue;
    readersOf.set(pid, await currentReaders(pid).catch(() => null));
    // Names only for the threads that mention the caller, not the project's every comment.
    names.set(pid, await targetNames(pid, [...threads.values()]).catch(() => ({})));
  }
  const items: HomeMention[] = [];
  for (const row of rows) {
    const hit = found.get(`${row.projectId}:${row.pieceId}`);
    if (!hit || items.length >= HOME_MAX) continue;
    const { c, body } = hit;
    items.push({
      projectId: row.projectId, id: row.pieceId, commentId: row.commentId, target: c.target,
      on: names.get(row.projectId)?.[`${c.target.kind}:${c.target.id}`] ?? { name: aDeletedRecord() },
      by: personName(row.author), snippet: commentSnippet(body, labelFor(peopleIn([body], readersOf.get(row.projectId) ?? null)), SNIPPET),
      at: row.at, seen: row.seen,
    });
  }
  await markGone(gone);
  return { available: true, items, unseen: await unseenCount() };
}

export function register(): void {
  registry.handle('comment:mentionable', async (_e, { projectId, q }: { projectId: string; q: string }) => ({ ok: true as const, ...(await mentionable(projectId, q)) }));
  registry.handle('mentions:list', async () => ({ ok: true as const, ...(await homeMentions()) }));
  registry.handle('mentions:seen', async (_e, input: { projectId: string; id: string } | { through: string }) => {
    if (!mentionsOn()) return { ok: true as const };
    await markSeen('through' in input ? { through: input.through } : { projectId: input.projectId, pieceId: input.id });
    return { ok: true as const };
  });
  registry.handle('mentions:prefs', async () => ({ ok: true as const, available: mentionsOn(), mail: mailReady(), emailMe: mentionsOn() ? await emailMe() : false }));
  registry.handle('mentions:setPrefs', async (_e, { emailMe: on }: { emailMe: boolean }) => {
    if (!mentionsOn()) return { ok: false as const, error: mentionsOff() };
    return { ok: await setEmailMe(on === true) };
  });
}
