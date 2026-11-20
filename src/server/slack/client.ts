// Slack's Web API, the calls Ordinate makes and no others. Every one goes through the SSRF guard
// (src/connectors/ssrf.ts `safeFetch`) to slack.com (./base.ts), with the bot token in the header only: a token
// is never in a URL, a log line or an error message (an error carries Slack's error CODE, nothing else).
//
// Slack answers a rate limit with 429 and Retry-After: the call waits that long (at most MAX_WAIT_SEC, three
// times) and tries again; the caller's lease is kept alive by its own heartbeat meanwhile.

import { safeFetch } from '../../connectors/ssrf';
import { slackOrigin } from './base';

export class SlackApiError extends Error {
  constructor(readonly code: string, readonly method: string) {
    super(`slack ${method}: ${code}`);
    this.name = 'SlackApiError';
  }
}

const MAX_WAIT_SEC = 30;
const TRIES = 3;
export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Test hook: scale Retry-After down (0 = no wait). */
let waitScale = 1;
export function setRetryScaleForTest(scale: number): void {
  waitScale = scale;
}

type Params = Record<string, unknown>;
// any: Slack's reply shapes are wide; each caller reads the few fields it needs.
export type SlackReply = Record<string, any> & { ok: boolean };

/** One Web API call. `json`: chat.* take a JSON body (blocks); reads take a form body. Throws SlackApiError when ok is false. */
export async function slackCall(method: string, token: string | null, params: Params = {}, json = false): Promise<SlackReply> {
  const url = `${slackOrigin()}/api/${method}`;
  const headers: Record<string, string> = json
    ? { 'content-type': 'application/json; charset=utf-8' }
    : { 'content-type': 'application/x-www-form-urlencoded' };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = json
    ? JSON.stringify(params)
    : new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
  for (let attempt = 1; ; attempt += 1) {
    const res = await safeFetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt < TRIES) {
      await res.arrayBuffer().catch(() => undefined);
      const after = Math.min(MAX_WAIT_SEC, Math.max(1, Number(res.headers.get('retry-after')) || 1));
      await sleepMs(after * 1000 * waitScale);
      continue;
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new SlackApiError(`http_${res.status}`, method);
    }
    const out = (await res.json()) as SlackReply;
    if (!out.ok) throw new SlackApiError(typeof out.error === 'string' ? out.error.slice(0, 60) : 'unknown_error', method);
    return out;
  }
}

export interface Posted { channel: string; ts: string }

export async function postMessage(token: string, channel: string, message: { text: string; blocks?: unknown[] }, threadTs?: string | null): Promise<Posted> {
  const r = await slackCall('chat.postMessage', token, { channel, ...message, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false }, true);
  return { channel: String(r.channel), ts: String(r.ts) };
}

export async function updateMessage(token: string, channel: string, ts: string, message: { text: string; blocks?: unknown[] }): Promise<void> {
  await slackCall('chat.update', token, { channel, ts, ...message }, true);
}

export async function postEphemeral(token: string, channel: string, user: string, message: { text: string; blocks?: unknown[] }, threadTs?: string | null): Promise<void> {
  await slackCall('chat.postEphemeral', token, { channel, user, ...message, ...(threadTs ? { thread_ts: threadTs } : {}) }, true);
}

/** The direct-message channel with `user` (opened when there is none). */
export async function openDm(token: string, user: string): Promise<string> {
  const r = await slackCall('conversations.open', token, { users: user });
  return String(r.channel?.id);
}

export interface SlackUser { id: string; teamId: string; isStranger: boolean; isGuest: boolean; isBot: boolean; deleted: boolean }

export async function userInfo(token: string, user: string): Promise<SlackUser> {
  const u = (await slackCall('users.info', token, { user })).user ?? {};
  return {
    id: String(u.id ?? user), teamId: String(u.team_id ?? ''), isStranger: u.is_stranger === true,
    isGuest: u.is_restricted === true || u.is_ultra_restricted === true, isBot: u.is_bot === true || u.id === 'USLACKBOT', deleted: u.deleted === true,
  };
}

export interface SlackChannel { id: string; name: string; isIm: boolean; isExtShared: boolean; isPrivate: boolean }

export async function channelInfo(token: string, channel: string): Promise<SlackChannel> {
  const c = (await slackCall('conversations.info', token, { channel })).channel ?? {};
  return {
    id: String(c.id ?? channel), name: String(c.name ?? ''), isIm: c.is_im === true,
    isExtShared: c.is_ext_shared === true || c.is_shared === true && c.is_org_shared !== true, isPrivate: c.is_private === true,
  };
}

/** Every member id of a channel, paged; stops after `cap + 1` ids so the caller can tell "more than cap". */
export async function channelMembers(token: string, channel: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  let cursor = '';
  do {
    const r = await slackCall('conversations.members', token, { channel, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...((r.members as unknown[]) ?? []).map(String));
    cursor = String(r.response_metadata?.next_cursor ?? '');
  } while (cursor && out.length <= cap);
  return out;
}

/** The channels the bot is in (the picker): public and private, no DMs. */
export async function botChannels(token: string): Promise<Array<{ id: string; name: string; isPrivate: boolean }>> {
  const out: Array<{ id: string; name: string; isPrivate: boolean }> = [];
  let cursor = '';
  do {
    const r = await slackCall('users.conversations', token, { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const c of (r.channels as Array<Record<string, unknown>>) ?? []) out.push({ id: String(c.id), name: String(c.name ?? ''), isPrivate: c.is_private === true });
    cursor = String(r.response_metadata?.next_cursor ?? '');
  } while (cursor && out.length < 1000);
  return out;
}

export interface AuthInfo { teamId: string; teamName: string; botUserId: string; appId: string; enterpriseId: string | null }

/** Who a bot token is: used once when the admin saves the keys. */
export async function authTest(token: string): Promise<AuthInfo> {
  const r = await slackCall('auth.test', token);
  const bot = await slackCall('bots.info', token, { bot: r.bot_id }).catch(() => null);
  return {
    teamId: String(r.team_id), teamName: String(r.team ?? ''), botUserId: String(r.user_id), appId: String(bot?.bot?.app_id ?? ''),
    enterpriseId: r.enterprise_id ? String(r.enterprise_id) : null,
  };
}
