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

import { ipcMain } from './bus';
import { serverDataDir } from '../server/context';
import * as comments from '../app/comments';
import * as config from '../app/config';
import * as hubs from '../windows/hubRegistry';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as datasets from '../data/datasets';
import * as stories from '../analysis/stories';
import type { Comment } from '../app/commentModel';
import type { Card } from '../analysis/dashboards';

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
  return { ok: true, comments: list, targets };
}

export function register(): void {
  // Every open window (desktop), or every tab of the org (server, T2.9) — the panel re-reads.
  const changed = (projectId: string): void => {
    if (serverDataDir() === null) return hubs.broadcast('comments:changed', { projectId });
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
  ipcMain.handle('comment:add', async (_e, { projectId, target, body }: any = {}) =>
    write(pid(projectId), await comments.add(pid(projectId), target, body)));
  ipcMain.handle('comment:reply', async (_e, { projectId, id: cid, body }: any = {}) =>
    write(pid(projectId), await comments.reply(pid(projectId), id(cid), body)));
  ipcMain.handle('comment:edit', async (_e, { projectId, id: cid, body }: any = {}) =>
    write(pid(projectId), await comments.edit(pid(projectId), id(cid), body)));
  ipcMain.handle('comment:resolve', async (_e, { projectId, id: cid }: any = {}) =>
    write(pid(projectId), await comments.resolve(pid(projectId), id(cid))));
  ipcMain.handle('comment:reopen', async (_e, { projectId, id: cid }: any = {}) =>
    write(pid(projectId), await comments.reopen(pid(projectId), id(cid))));
  ipcMain.handle('comment:delete', async (_e, { projectId, id: cid }: any = {}) =>
    write(pid(projectId), await comments.remove(pid(projectId), id(cid))));
  ipcMain.handle('comment:deleteReply', async (_e, { projectId, id: cid, replyId }: any = {}) =>
    write(pid(projectId), await comments.removeReply(pid(projectId), id(cid), id(replyId))));

  // ── Settings → General → Collaboration ──
  ipcMain.handle('profile:setDisplayName', async (_e, name: unknown) => {
    config.save({ displayName: typeof name === 'string' ? name : '' });
    changed('');
    return { ok: true, displayName: config.get().displayName, author: comments.author() };
  });
}
