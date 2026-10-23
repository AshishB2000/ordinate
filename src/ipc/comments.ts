// Comments IPC, and the Settings → General row that belongs to them: the
// display name comments are signed with. MAIN PROCESS. (Comments sync with the
// project itself — see src/app/comments.ts.)
//
// Every comment channel answers with the project's WHOLE live list, so the
// renderer's copy is replaced rather than patched, plus two things only main
// can say: which threads and replies are the caller's own (`mine`, from the
// author main resolves — the renderer never sends a name), and what each
// target is called (`targets`, keyed "kind:id"; a card also names the
// dashboard it sits on, which is how a Home row opens the right one).
//
// `comments:changed` is pushed to every hub window after any change, so a
// second window's card counts follow the first's. An empty projectId means
// "all projects" — the display name changed.
//
// @MENTIONS (docs/notifications/00-design.md §5.5): add, reply and edit read the
// project's current readers first and hand the store a gate it runs INSIDE its
// lock, on the body as stored; a stored piece's new mentions are then told —
// started with `void`, so a mention never delays or fails the comment. The list
// says whether mentions are on, and names the mentioned people who can read the
// project now (`people`) — no one else.

import { ipcMain } from './bus';
import { serverDataDir } from '../server/context';
import * as comments from '../app/comments';
import * as config from '../app/config';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as datasets from '../data/datasets';
import * as stories from '../analysis/stories';
import type { Comment } from '../app/commentModel';
import type { Card } from '../analysis/dashboards';
import { currentReaders, mentionGate, mentionsOn, peopleFor } from '../server/mentions/people';
import { forgetPieces } from '../server/mentions/store';
import { notifyLog, why } from '../server/notifyLog';

interface TargetInfo { name: string; analysisId?: string }

/** A card's name as its head shows it — the visual's name for a chart tile. */
function cardTitle(card: Card, visualNames: Map<string, string>): string {
  if (card.type === 'visual') return (card.visual && card.visual.name) || visualNames.get(card.visualId || '') || 'Visual';
  if (card.type === 'metric' && card.metric) return card.metric.label || `${card.metric.aggregation} of ${card.metric.column}`;
  if (card.type === 'control' && card.control) return card.control.label || 'Filter';
  return card.heading || card.type;
}

/** Names for exactly the kinds these comments point at — no scan for a kind nobody commented on. */
export async function targetNames(projectId: string, list: Comment[]): Promise<Record<string, TargetInfo>> {
  const kinds = new Set(list.map((c) => c.target.kind));
  const out: Record<string, TargetInfo> = {};
  const visualNames = new Map<string, string>();
  if (kinds.has('visual') || kinds.has('card')) {
    for (const v of await visuals.listVisuals(projectId)) {
      visualNames.set(v.id, v.name);
      out['visual:' + v.id] = { name: v.name };
    }
  }
  if (kinds.has('analysis') || kinds.has('card')) {
    for (const s of await analysis.listAnalyses(projectId)) {
      out['analysis:' + s.id] = { name: s.name };
      if (!kinds.has('card')) continue;
      const a = await analysis.getAnalysis(projectId, s.id);
      for (const sheet of a ? a.sheets : []) {
        for (const card of sheet.cards) out['card:' + card.id] = { name: cardTitle(card, visualNames), analysisId: s.id };
      }
    }
  }
  if (kinds.has('dataset')) for (const d of await datasets.listDatasets(projectId)) out['dataset:' + d.id] = { name: d.name };
  if (kinds.has('story')) for (const st of await stories.listStories(projectId)) out['story:' + st.id] = { name: st.name };
  return out;
}

async function answer(projectId: string, res: comments.Result): Promise<unknown> {
  if (!res.ok) return res;
  const list = res.comments.map((c) => ({
    ...c,
    mine: comments.isMine(c.author),
    replies: c.replies.map((r) => ({ ...r, mine: comments.isMine(r.author) })),
  }));
  let targets: Record<string, TargetInfo> = {};
  try { targets = await targetNames(projectId, res.comments); } catch (_) { /* names are a nicety */ }
  const bodies = res.comments.flatMap((c) => [c.body, ...c.replies.map((r) => r.body)]);
  const people = await peopleFor(projectId, bodies);
  return { ok: true, comments: list, targets, mentions: mentionsOn(), people };
}

/** After a write that stored a piece: tell its new mentions, never in the write's way. */
function tell(projectId: string, res: comments.Written): void {
  if (!res.ok || !('piece' in res) || !res.mentioned.length) return;
  const c = res.comments.find((x) => x.id === res.piece.commentId);
  if (!c) return;
  const body = res.piece.id === c.id ? c.body : c.replies.find((r) => r.id === res.piece.id)?.body ?? '';
  const { notifyMentions } = require('../server/mentions/notify') as typeof import('../server/mentions/notify');
  void notifyMentions({ projectId, commentId: c.id, id: res.piece.id, target: c.target, author: comments.author(), body }, res.mentioned);
}

/** The gate for a write by the caller: the project's readers, read before the lock. */
async function gateFor(projectId: string): Promise<comments.MentionGate> {
  // No answer from the directory: no one is a reader, so a new mention is refused (fail closed), the rest of the write goes on.
  return mentionGate(await currentReaders(projectId).catch(() => null), comments.author());
}

export function register(): void {
  // Every tab of the org (server, T2.9) — the panel re-reads. Outside server mode, no one to tell.
  const changed = (projectId: string): void => {
    if (serverDataDir() === null) return;
    // Members who may read the project only (T6.3), as alerts and refreshes go.
    (require('../server/jobs/schedules') as typeof import('../server/jobs/schedules')).pushToReaders(projectId, 'comments:changed', { projectId });
  };
  const pid = (v: unknown): string => String(v || '');
  const id = (v: unknown): string => String(v || '').toLowerCase();

  /** A change: answer with the new list, and tell every window. */
  const write = async (projectId: string, res: comments.Result): Promise<unknown> => {
    if (res.ok) changed(projectId);
    return answer(projectId, res);
  };

  // ponytail: IPC payloads are JSON envelopes; every field is re-checked in app/comments
  ipcMain.handle('comment:list', async (_e, { projectId }: any = {}) => answer(pid(projectId), await comments.list(pid(projectId))));
  ipcMain.handle('comment:add', async (_e, { projectId, target, body }: any = {}) => {
    const res = await comments.add(pid(projectId), target, body, await gateFor(pid(projectId)));
    tell(pid(projectId), res);
    return write(pid(projectId), res);
  });
  ipcMain.handle('comment:reply', async (_e, { projectId, id: cid, body }: any = {}) => {
    const res = await comments.reply(pid(projectId), id(cid), body, await gateFor(pid(projectId)));
    tell(pid(projectId), res);
    return write(pid(projectId), res);
  });
  ipcMain.handle('comment:edit', async (_e, { projectId, id: cid, body }: any = {}) => {
    const res = await comments.edit(pid(projectId), id(cid), body, await gateFor(pid(projectId)));
    tell(pid(projectId), res);
    return write(pid(projectId), res);
  });
  ipcMain.handle('comment:resolve', async (_e, { projectId, id: cid }: any = {}) =>
    write(pid(projectId), await comments.resolve(pid(projectId), id(cid))));
  ipcMain.handle('comment:reopen', async (_e, { projectId, id: cid }: any = {}) =>
    write(pid(projectId), await comments.reopen(pid(projectId), id(cid))));
  // A deleted piece is no one's mention any more: its rows go too (a failure only leaves them for Home to skip).
  const forget = (projectId: string, which: Parameters<typeof forgetPieces>[1]) =>
    forgetPieces(projectId, which).catch((err: unknown) => notifyLog().warn({ error: why(err) }, 'mentions of a deleted comment not removed'));
  ipcMain.handle('comment:delete', async (_e, { projectId, id: cid }: any = {}) => {
    const res = await comments.remove(pid(projectId), id(cid));
    if (res.ok) await forget(pid(projectId), { commentId: id(cid) });
    return write(pid(projectId), res);
  });
  ipcMain.handle('comment:deleteReply', async (_e, { projectId, id: cid, replyId }: any = {}) => {
    const res = await comments.removeReply(pid(projectId), id(cid), id(replyId));
    if (res.ok) await forget(pid(projectId), { pieceId: id(replyId) });
    return write(pid(projectId), res);
  });

  // ── Settings → General → Collaboration ──
  ipcMain.handle('profile:setDisplayName', async (_e, name: unknown) => {
    config.save({ displayName: typeof name === 'string' ? name : '' });
    changed('');
    return { ok: true, displayName: config.get().displayName, author: comments.author() };
  });
}
