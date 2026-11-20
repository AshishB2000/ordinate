// Answering one claimed question (./worker.ts holds its lease). In order:
//
//   1. who: the Slack user's link, then their Ordinate account as it is NOW (role, not disabled). Unknown, unlinked or
//      disabled → a private Connect button, the question parked until the link exists (./linking.ts).
//   2. where: a channel's agent (a project admin's choice; none → "not connected yet", never a guess) or, in a direct
//      message, the person's own assistant (./ask.ts directTarget). A Slack thread belongs to its first asker: another
//      member's question in it is their own conversation, run as them and checked on its own.
//   3. the placeholder ("Working on it…"), kept by `ts`: a retaken question edits it, so a thread gets ONE answer.
//   4. the ask (./ask.ts), as the linked user, after `authorize()`.
//   5. the share policy on the card (./shape.ts), the check (./check.ts), the message (./render.ts, ./charts.ts), the
//      post or the private answer, and an audit row.

import type { Pool } from 'pg';
import { audit } from '../authz/audit';
import { runInContext, type Identity } from '../context';
import * as datasets from '../../data/datasets';
import { appLink } from '../publicUrl';
import * as say from '../slackMessages';
import { ask, directTarget, type Asked, type Target } from './ask';
import { chartBlocks } from './charts';
import { check, viewOf, type Shown, type Verdict } from './check';
import { openDm, postEphemeral, postMessage, updateMessage } from './client';
import * as store from './db';
import { connectUrl, mayLink } from './linking';
import { answerMessage, connectPrompt, note, type Message } from './render';
import { shape } from './shape';

type Ok = Extract<Asked, { ok: true }>;
export interface Kept extends Omit<Ok, 'ok'> { datasetNames: string[]; /** The asker's access print when it was asked (./check.ts viewOf). */ view: string | null }

const REFUSALS: Record<string, () => string> = { denied: say.noAccess, not_ready: say.notReady, failed: say.failed, no_project: say.noProject };

async function accountOf(org: string, email: string): Promise<Identity | null> {
  const r = await store.db().query<{ role: 'admin' | 'editor' | 'viewer' }>('SELECT role FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [org, email]);
  return r.rows[0] ? { user: { email, role: r.rows[0].role }, org: { id: org } } : null;
}

/** The "Open in Ordinate" link: the asker lands on their conversation, anyone else gets the question asked again as themselves. */
export const openLink = (questionId: string): string | null => appLink(`/assistant?slack=${questionId}`);

const linkBlock = (url: string | null): unknown[] => (url
  ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: say.openInOrdinate() }, url }] }]
  : []);

export async function processQuestion(pool: Pool, q: store.Question, owner: string): Promise<void> {
  const inst = await store.installByTeam(q.teamId);
  const token = inst && inst.enabled ? await store.getSecret(q.orgId, 'botToken') : null;
  if (!inst || !token) return void (await store.finish(q.id, owner, 'failed', 'not_installed'));
  if (q.kind === 'share') return shareJob(pool, inst, token, q, owner);

  const dm = q.channelType === 'im';
  const email = await store.linkedEmail(q.orgId, q.teamId, q.slackUserId);
  const who = email ? await accountOf(q.orgId, email) : null;
  if (!email || !who) {
    // Unlinked (or disabled): a private Connect button, the question parked until the link exists.
    if (!(await mayLink(inst, token, q.slackUserId))) {
      await postEphemeral(token, q.channelId, q.slackUserId, note(say.notForYou()), q.threadTs);
      return void (await store.finish(q.id, owner, 'failed', 'not_linkable'));
    }
    const url = connectUrl(await store.newState(q.orgId, q.teamId, q.slackUserId, q.id));
    await postEphemeral(token, q.channelId, q.slackUserId, url ? connectPrompt(url) : note(say.connectUnavailable()), q.threadTs);
    return void (await store.finish(q.id, owner, url ? 'awaiting_link' : 'failed', url ? 'awaiting_link' : 'no_public_url'));
  }

  await runInContext(who, `slack:${q.id}`, async () => {
    // Where: the channel's agent, or the person's own assistant in a direct message.
    let target: Target | null;
    if (dm) {
      target = await directTarget(pool, who);
    } else {
      const ca = await store.channelAgent(q.teamId, q.channelId);
      if (!ca || ca.orgId !== q.orgId) {
        await postMessage(token, q.channelId, note(say.notConnected()), q.threadTs);
        return void (await store.finish(q.id, owner, 'done', 'unmapped'));
      }
      const mine = q.threadTs ? await store.threadOf(q.teamId, q.channelId, q.threadTs) : null;
      // The thread's first asker continues their conversation; anyone else starts one of their own.
      target = { projectId: ca.projectId, agentId: ca.agentId, ...(mine && mine.askerEmail === email && mine.projectId === ca.projectId ? { threadId: mine.threadId } : {}) };
    }
    const placeholder = q.placeholderTs ?? (await postMessage(token, q.channelId, note(say.working()), q.threadTs)).ts;
    await store.setPlaceholder(q.id, owner, placeholder, target?.projectId ?? null, target?.agentId ?? null);
    const finishWith = async (text: string, outcome: string, auditOutcome: 'ok' | 'denied' | 'error' = 'ok') => {
      await updateMessage(token, q.channelId, placeholder, note(text));
      await audit(pool, { org: q.orgId, actor: email, action: 'rpc', channel: 'slack:ask', projectId: target?.projectId ?? null, targets: [q.id], outcome: auditOutcome, requestId: `slack:${q.id}` })
        .catch(() => undefined);
      await store.finish(q.id, owner, 'done', outcome);
    };
    if (!target) return finishWith(say.noProject(), 'no_project');

    const res = await ask(pool, who, `slack:${q.id}`, q.text, target);
    if (!res.ok) return finishWith(REFUSALS[res.reason](), res.reason, res.reason === 'denied' ? 'denied' : 'error');

    if (!dm && q.threadTs && !target.threadId) await store.saveThread(q.orgId, q.teamId, q.channelId, q.threadTs, { projectId: res.projectId, threadId: res.threadId, askerEmail: email });
    const names = await Promise.all(res.datasetIds.map(async (id) => (await datasets.getDatasetMeta(res.projectId, id))?.name ?? '')); // inside the asker's context
    const shown: Shown = { projectId: res.projectId, datasetIds: res.datasetIds, dashboardIds: res.dashboardIds };
    const kept: Kept = { ...res, datasetNames: names.filter(Boolean), view: await viewOf(pool, who, shown) };
    await store.saveAnswer(q.id, owner, kept);

    const verdict = await check(pool, inst, token, q.channelId, q.slackUserId, shown, { dm });
    await deliver(pool, inst, token, q, owner, placeholder, kept, verdict);
    await audit(pool, { org: q.orgId, actor: email, action: 'rpc', channel: 'slack:ask', projectId: res.projectId, targets: [q.id, ...res.datasetIds], outcome: 'ok', requestId: `slack:${q.id}` }).catch(() => undefined);
    await store.finish(q.id, owner, 'done', verdict.post ? `posted:${verdict.case}` : `private:${verdict.why}`, res.threadId);
  });
}

/** The answer as a message: share policy first, then the chart or table. */
async function build(q: store.Question, kept: Kept, extra: { share?: boolean; intro?: string }): Promise<Message> {
  const shaped = await shape(kept.projectId, kept.card, kept.datasetIds);
  return answerMessage({
    sentence: kept.text, masked: shaped.changed, card: shaped.card, agent: kept.agentName, datasets: kept.datasetNames, questionId: q.id, openUrl: openLink(q.id),
    chart: shaped.changed ? null : chartBlocks(shaped.card), ...extra,
  });
}

async function deliver(_pool: Pool, _inst: store.Install, token: string, q: store.Question, _owner: string, placeholder: string, kept: Kept, verdict: Verdict): Promise<void> {
  if (verdict.post) {
    await updateMessage(token, q.channelId, placeholder, await build(q, kept, {}));
    return;
  }
  // Not postable here: a fixed note in the channel, the full answer by direct message (never ephemeral: it would vanish on reload).
  await updateMessage(token, q.channelId, placeholder, note(say.sentPrivately(), linkBlock(openLink(q.id))));
  const dmChannel = await openDm(token, q.slackUserId);
  await postMessage(token, dmChannel, await build(q, kept, { intro: say.privateIntro(), share: verdict.why !== 'external' }));
}

/** "Share to channel": the check again, against the channel's CURRENT members; an org admin's setting may let the asker post past a failed check. */
async function shareJob(pool: Pool, inst: store.Install, token: string, q: store.Question, owner: string): Promise<void> {
  const email = await store.linkedEmail(q.orgId, q.teamId, q.slackUserId);
  const who = email ? await accountOf(q.orgId, email) : null;
  const orig = q.ofQuestion ? await store.answerOf(q.orgId, q.ofQuestion) : null;
  const originalQ = q.ofQuestion ? await store.questionById(q.orgId, q.ofQuestion) : null;
  if (!who || !orig || !originalQ) return void (await store.finish(q.id, owner, 'failed', 'gone'));
  const kept = orig.answer as Kept;
  await runInContext(who, `slack:${q.id}`, async () => {
    const shown: Shown = { projectId: kept.projectId, datasetIds: kept.datasetIds, dashboardIds: kept.dashboardIds };
    let verdict = await check(pool, inst, token, orig.channelId, q.slackUserId, shown, { dm: orig.channelType === 'im' });
    if (!verdict.post && verdict.why !== 'external' && inst.allowShareOverride) verdict = await check(pool, inst, token, orig.channelId, q.slackUserId, shown, { override: true });
    const dm = await openDm(token, q.slackUserId);
    // The kept card was computed under the asker's access of THEN: if it has narrowed since, it is not posted (the app withholds a kept card the same way).
    const same = (await viewOf(pool, who, shown)) === kept.view;
    const at = orig.placeholderTs;
    const post = same && verdict.post && !!at;
    if (!post || !at) {
      await postMessage(token, dm, note(say.shareRefused()));
    } else {
      await updateMessage(token, orig.channelId, at, await build(originalQ, kept, {}));
      await postMessage(token, dm, note(say.shared()));
    }
    await audit(pool, { org: q.orgId, actor: email, action: 'rpc', channel: 'slack:share', projectId: kept.projectId, targets: [originalQ.id], outcome: post ? 'ok' : 'denied', requestId: `slack:${q.id}` }).catch(() => undefined);
    await store.finish(q.id, owner, 'done', post ? 'shared' : 'share_refused');
  });
}

