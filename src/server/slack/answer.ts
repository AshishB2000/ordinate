// Answering one claimed question (./worker.ts holds its lease). In order:
//
//   1. who: the Slack user's link, then their Ordinate account as it is NOW (role, not disabled, no password change owed).
//      Unknown, unlinked or disabled → a private Connect button, the question parked until the link exists (./linking.ts).
//   2. where: a channel's agent (a project admin's choice; none, or a project that is gone → "not connected yet", never a
//      guess) or, in a direct message, the person's own assistant (./ask.ts directTarget). A Slack thread belongs to its
//      first asker: another member's question in it is their own conversation, run as them and checked on its own.
//   3. the placeholder ("Working on it…"), its `ts` written the moment it is posted: a retaken question edits it, so a
//      thread gets ONE answer.
//   4. the ask (./ask.ts), as the linked user, after `authorize()`. Its outcome is stored (ids only) before anything is
//      posted, so a question retaken after a crash does NOT ask the model again.
//   5. the message, rebuilt from the STORED turn and its snapshot (never a copy of the card): the share policy (./shape.ts),
//      the check (./check.ts), the chart or table (./charts.ts, ./render.ts), the post or the private answer, and an audit row.
//      Each step done is recorded (`delivered_at`, `dm_at`), so a retake finishes instead of repeating a post or a direct message.
//
// The lease is the fence: when the heartbeat reports it lost (./worker.ts), `signal` aborts and every step stops.

import type { Pool } from 'pg';
import { audit } from '../authz/audit';
import { runInContext, type Identity } from '../context';
import * as copilot from '../../ai/copilot';
import * as datasets from '../../data/datasets';
import * as projects from '../../app/projects';
import { turnsForBrowser } from '../../ipc/answerSnapshots';
import { appLink } from '../publicUrl';
import * as say from '../slackMessages';
import { ask, directTarget, type Asked, type Target } from './ask';
import { chartBlocks } from './charts';
import { check, viewOf, type Shown, type Verdict } from './check';
import { openDm, postEphemeral, postMessage, updateMessage } from './client';
import * as store from './db';
import { connectUrl, mayLink } from './linking';
import { answerMessage, connectPrompt, note, type Message } from './render';
import { sentenceAtRisk, shape } from './shape';

export class LeaseLost extends Error {
  constructor() {
    super('the question\'s lease was lost');
    this.name = 'LeaseLost';
  }
}

const REFUSALS: Record<string, () => string> = {
  denied: say.noAccess, not_ready: say.notReady, failed: say.failed, no_project: say.noProject, limited: say.tooBusy, agent: say.agentNotYours, timeout: say.timedOut,
};

interface Account { who: Identity; mustChangePassword: boolean }
async function accountOf(org: string, email: string): Promise<Account | null> {
  const r = await store.db().query<{ role: 'admin' | 'editor' | 'viewer'; must: boolean }>(
    'SELECT role, must_change_password AS must FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [org, email]);
  return r.rows[0] ? { who: { user: { email, role: r.rows[0].role }, org: { id: org } }, mustChangePassword: r.rows[0].must } : null;
}

/** The "Open in Ordinate" link: the asker lands on their conversation, anyone else gets the question asked again as themselves. */
export const openLink = (questionId: string): string | null => appLink(`/assistant?slack=${questionId}`);

const linkBlock = (url: string | null): unknown[] => (url
  ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: say.openInOrdinate() }, url }] }]
  : []);

export async function processQuestion(pool: Pool, q: store.Question, owner: string, signal: AbortSignal): Promise<void> {
  const alive = (): void => { if (signal.aborted) throw new LeaseLost(); };
  const inst = await store.installByTeam(q.teamId);
  const token = inst && inst.enabled ? await store.getSecret(q.orgId, 'botToken') : null;
  if (!inst || !token) return void (await store.finish(q.id, owner, 'failed', 'not_installed'));
  if (q.kind === 'share') return shareJob(pool, inst, token, q, owner, alive);

  const dm = q.channelType === 'im';
  const email = await store.linkedEmail(q.orgId, q.teamId, q.slackUserId);
  const account = email ? await accountOf(q.orgId, email) : null;
  if (!email || !account) {
    // Unlinked (or disabled): a private Connect button, the question parked until the link exists.
    alive();
    if (!(await mayLink(inst, token, q.slackUserId))) {
      await postEphemeral(token, q.channelId, q.slackUserId, note(say.notForYou()), q.threadTs);
      return void (await store.finish(q.id, owner, 'failed', 'not_linkable'));
    }
    const url = connectUrl(await store.newState(q.orgId, q.teamId, q.slackUserId, q.id));
    await postEphemeral(token, q.channelId, q.slackUserId, url ? connectPrompt(url) : note(say.connectUnavailable()), q.threadTs);
    return void (await store.finish(q.id, owner, url ? 'awaiting_link' : 'failed', url ? 'awaiting_link' : 'no_public_url'));
  }
  const { who } = account;
  if (account.mustChangePassword) { // a temporary password the person has not replaced: the app refuses them everything but that
    alive();
    await postEphemeral(token, q.channelId, q.slackUserId, note(say.changePasswordFirst()), q.threadTs);
    return void (await store.finish(q.id, owner, 'failed', 'change_password'));
  }

  await runInContext(who, `slack:${q.id}`, async () => {
    // Where: the channel's agent, or the person's own assistant in a direct message.
    let target: Target | null;
    if (dm) {
      target = await directTarget(pool, who);
    } else {
      const ca = await store.channelAgent(q.teamId, q.channelId);
      const project = ca && ca.orgId === q.orgId ? await projects.getProject(ca.projectId) : null;
      if (ca && ca.orgId === q.orgId && (!project || project.archivedAt)) await store.dropProjectChannels(q.orgId, ca.projectId); // the project is gone (or archived): its channels go with it
      if (!ca || ca.orgId !== q.orgId || !project || project.archivedAt) {
        alive();
        await postMessage(token, q.channelId, note(say.notConnected()), q.threadTs);
        return void (await store.finish(q.id, owner, 'done', 'unmapped'));
      }
      const mine = q.threadTs ? await store.threadOf(q.teamId, q.channelId, q.threadTs) : null;
      // The thread's first asker continues their conversation; anyone else starts one of their own.
      target = { projectId: ca.projectId, agentId: ca.agentId, ...(mine && mine.askerEmail === email && mine.projectId === ca.projectId ? { threadId: mine.threadId } : {}) };
    }
    let placeholder = q.placeholderTs;
    if (!placeholder) {
      alive();
      placeholder = (await postMessage(token, q.channelId, note(say.working()), q.threadTs)).ts;
      await store.setPlaceholder(q.id, owner, placeholder, target?.projectId ?? null, target?.agentId ?? null); // written at once: a crash after the post leaves its ts, not an orphan
    }
    const at = placeholder;
    const finishWith = async (text: string, outcome: string, auditOutcome: 'ok' | 'denied' | 'error' = 'ok') => {
      alive();
      await updateMessage(token, q.channelId, at, note(text));
      await audit(pool, { org: q.orgId, actor: email, action: 'rpc', channel: 'slack:ask', projectId: target?.projectId ?? null, targets: [q.id], outcome: auditOutcome, requestId: `slack:${q.id}` })
        .catch(() => undefined);
      await store.finish(q.id, owner, 'done', outcome);
    };
    if (!target) return finishWith(say.noProject(), 'no_project');

    // The ask — unless an earlier attempt of this question already did it (its outcome is stored): then only the delivery is left.
    let kept = q.answer;
    if (!kept) {
      alive();
      const res: Asked = await ask(pool, who, `slack:${q.id}`, q.text, target, signal);
      if (!res.ok) return finishWith(REFUSALS[res.reason](), res.reason, res.reason === 'denied' ? 'denied' : 'error');
      if (!dm && q.threadTs && !target.threadId) await store.saveThread(q.orgId, q.teamId, q.channelId, q.threadTs, { projectId: res.projectId, threadId: res.threadId, askerEmail: email });
      const names = await Promise.all(res.datasetIds.map(async (id) => (await datasets.getDatasetMeta(res.projectId, id))?.name ?? '')); // inside the asker's context
      kept = {
        threadId: res.threadId, projectId: res.projectId, turnId: res.turnId, agentName: res.agentName, datasetIds: res.datasetIds, dashboardIds: res.dashboardIds,
        datasetNames: names.filter(Boolean), view: await viewOf(pool, who, { projectId: res.projectId, datasetIds: res.datasetIds, dashboardIds: res.dashboardIds }),
        sourceTable: res.sourceTable, outside: res.outside,
      };
      await store.saveAnswer(q.id, owner, kept);
    }
    if (q.deliveredAt) { // posted already (and the private answer sent): a retake only finishes
      await store.finish(q.id, owner, 'done', q.outcome ?? 'delivered', kept.threadId);
      return;
    }
    alive();
    const verdict = await check(pool, inst, token, q.channelId, q.slackUserId, shownOf(kept), { dm });
    await deliver(token, q, owner, at, kept, verdict, alive);
    const outcome = verdict.post ? `posted:${verdict.case}` : `private:${verdict.why}`;
    await audit(pool, { org: q.orgId, actor: email, action: 'rpc', channel: 'slack:ask', projectId: kept.projectId, targets: [q.id, ...kept.datasetIds], outcome: 'ok', requestId: `slack:${q.id}` }).catch(() => undefined);
    await store.finish(q.id, owner, 'done', outcome, kept.threadId);
  });
}

const shownOf = (k: store.StoredAnswer): Shown => ({ projectId: k.projectId, datasetIds: k.datasetIds, dashboardIds: k.dashboardIds, sourceTable: k.sourceTable, outside: k.outside });

/** The answer as a message, rebuilt from the stored turn and its snapshot (never a copy of the card) — in the asker's context. */
async function build(q: store.Question, kept: store.StoredAnswer, extra: { share?: boolean; intro?: string }): Promise<Message> {
  const turn = await copilot.findTurn(kept.projectId, kept.threadId, kept.turnId);
  // The snapshot's card is delivered only while the asker's access is what it was when it was computed (turnsForBrowser); a turn the asker no longer opens is none.
  const shown = turn ? (await turnsForBrowser(kept.projectId, [turn]))[0] : undefined;
  if (!turn || !shown) return note(say.failed());
  const shaped = await shape(kept.projectId, shown.card ?? null, kept.datasetIds);
  const atRisk = !shaped.changed && (await sentenceAtRisk(kept.projectId, kept.datasetIds));
  return answerMessage({
    sentence: turn.text, masked: shaped.changed, atRisk, card: shaped.card, agent: kept.agentName, datasets: kept.datasetNames, questionId: q.id, openUrl: openLink(q.id),
    chart: shaped.changed ? null : chartBlocks(shaped.card), ...extra,
  });
}

async function deliver(token: string, q: store.Question, owner: string, placeholder: string, kept: store.StoredAnswer, verdict: Verdict, alive: () => void): Promise<void> {
  if (verdict.post) {
    alive();
    await updateMessage(token, q.channelId, placeholder, await build(q, kept, {}));
    await store.markDelivered(q.id, owner, `posted:${verdict.case}`);
    return;
  }
  // Not postable here: a fixed note in the channel, the full answer by direct message (never ephemeral: it would vanish on reload).
  alive();
  await updateMessage(token, q.channelId, placeholder, note(say.sentPrivately(), linkBlock(openLink(q.id))));
  if (!q.dmAt) {
    const message = await build(q, kept, { intro: say.privateIntro(), share: verdict.why !== 'external' && verdict.why !== 'source_table' && verdict.why !== 'outside' });
    alive();
    await postMessage(token, await openDm(token, q.slackUserId), message);
    await store.markDm(q.id, owner); // the private answer is never sent twice
  }
  await store.markDelivered(q.id, owner, `private:${verdict.why}`);
}

/** "Share to channel": the check again, against the channel's CURRENT members; an org admin's setting may let the asker post past a failed check. */
async function shareJob(pool: Pool, inst: store.Install, token: string, q: store.Question, owner: string, alive: () => void): Promise<void> {
  const email = await store.linkedEmail(q.orgId, q.teamId, q.slackUserId);
  const account = email ? await accountOf(q.orgId, email) : null;
  const orig = q.ofQuestion ? await store.questionById(q.orgId, q.ofQuestion) : null;
  if (!account || !orig?.answer) return void (await store.finish(q.id, owner, 'failed', 'gone'));
  const { who } = account;
  const kept = orig.answer;
  await runInContext(who, `slack:${q.id}`, async () => {
    const shown = shownOf(kept);
    alive();
    let verdict = await check(pool, inst, token, orig.channelId, q.slackUserId, shown, { dm: orig.channelType === 'im' });
    if (!verdict.post && !['external', 'source_table', 'outside'].includes(verdict.why) && inst.allowShareOverride) verdict = await check(pool, inst, token, orig.channelId, q.slackUserId, shown, { override: true });
    const dm = await openDm(token, q.slackUserId);
    // The answer is re-read from its stored turn: if the asker's access has narrowed since, `view` differs and nothing is posted.
    const same = (await viewOf(pool, who, shown)) === kept.view;
    const at = orig.placeholderTs;
    const post = same && verdict.post && !!at;
    alive();
    if (!post || !at) {
      await postMessage(token, dm, note(say.shareRefused()));
    } else {
      await updateMessage(token, orig.channelId, at, await build(orig, kept, {}));
      await postMessage(token, dm, note(say.shared()));
    }
    await audit(pool, { org: q.orgId, actor: email, action: 'rpc', channel: 'slack:share', projectId: kept.projectId, targets: [orig.id], outcome: post ? 'ok' : 'denied', requestId: `slack:${q.id}` }).catch(() => undefined);
    await store.finish(q.id, owner, 'done', post ? 'shared' : 'share_refused');
  });
}
