// What Slack sends us, turned into rows. Used by the Events route (./routes.ts) and by Socket Mode (./socket.ts),
// which carry the same payloads. NOTHING here answers: it inserts a `slack_questions` row and returns, inside
// Slack's three seconds. An unknown or switched-off team, a bot's own post, an edit or a delete is dropped.

import { randomUUID } from 'crypto';
import * as store from './db';

/** The same cap as `copilot:ask`'s question (src/api/assistant.ts). */
export const MAX_QUESTION = 4000;

/** Slack's markup as plain words: `<@U1>` and `<!channel>` gone, `<url|label>` its label, `&lt; &gt; &amp;` decoded. */
export function plainText(raw: string): string {
  return raw
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ')
    .replace(/<![^>]*>/g, ' ')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<([^>|]+)\|([^>]*)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SlackEvent {
  type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel?: string; channel_type?: string; ts?: string; thread_ts?: string;
}
export interface Envelope { type?: string; team_id?: string; event_id?: string; event?: SlackEvent; challenge?: string }

export type Handled = 'queued' | 'duplicate' | 'dropped' | 'uninstalled';

/** One `event_callback`. `Handled` says what became of it (the route answers 200 to all of them). */
export async function handleEvent(env: Envelope): Promise<Handled> {
  const ev = env.event;
  if (env.type !== 'event_callback' || !ev || typeof env.team_id !== 'string' || typeof env.event_id !== 'string') return 'dropped';
  const install = await store.installByTeam(env.team_id);
  if (!install) return 'dropped';
  if (ev.type === 'app_uninstalled' || ev.type === 'tokens_revoked') {
    await store.markUninstalled(env.team_id);
    return 'uninstalled';
  }
  if (!install.enabled) return 'dropped';
  const dm = ev.type === 'message' && ev.channel_type === 'im';
  if (!(ev.type === 'app_mention' || dm)) return 'dropped';
  // Not a person's new message: a bot's (Ordinate's own among them), an edit, a delete, a join.
  if (ev.bot_id || ev.subtype || !ev.user || ev.user === install.botUserId || !ev.channel || !ev.ts || typeof ev.text !== 'string') return 'dropped';
  if (!(await store.recordEvent(env.event_id))) return 'duplicate';
  const text = plainText(ev.text).slice(0, MAX_QUESTION);
  if (!text) return 'dropped';
  await store.enqueue({
    id: randomUUID(), orgId: install.orgId, teamId: env.team_id, channelId: ev.channel, channelType: dm ? 'im' : 'channel',
    // A channel answer goes in a thread under the mention; a DM answers in place.
    threadTs: dm ? (ev.thread_ts ?? null) : (ev.thread_ts ?? ev.ts), eventTs: ev.ts, slackUserId: ev.user, text,
  });
  return 'queued';
}

interface Interaction {
  type?: string; team?: { id?: string }; user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string; thread_ts?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
}
export const FEEDBACK_ID = 'ord_feedback';
export const SHARE_ID = 'ord_share';

/** A button press: Helpful / Not helpful (stored with the answer) or Share to channel (a `share` question). Only the asker's own press counts. */
export async function handleInteraction(p: Interaction): Promise<'feedback' | 'share' | 'dropped'> {
  const team = p.team?.id;
  const clicker = p.user?.id;
  const act = p.actions?.[0];
  if (p.type !== 'block_actions' || !team || !clicker || !act?.action_id || typeof act.value !== 'string') return 'dropped';
  const install = await store.installByTeam(team);
  if (!install || !install.enabled) return 'dropped';
  const [qid, arg] = act.value.split(':');
  if (!/^[0-9a-f-]{36}$/i.test(qid ?? '')) return 'dropped';
  const q = await store.questionById(install.orgId, qid);
  if (!q || q.teamId !== team || q.slackUserId !== clicker) return 'dropped';
  if (act.action_id.startsWith(FEEDBACK_ID) && (arg === 'helpful' || arg === 'not_helpful')) {
    await store.setFeedback(install.orgId, qid, arg);
    return 'feedback';
  }
  if (act.action_id === SHARE_ID && !(await store.shareExists(q.id))) { // a double click is one share
    await store.enqueue({
      id: randomUUID(), orgId: install.orgId, teamId: team, kind: 'share', channelId: q.channelId, channelType: q.channelType, threadTs: q.threadTs,
      eventTs: null, slackUserId: clicker, text: '', ofQuestion: q.id,
    });
    return 'share';
  }
  return 'dropped';
}
