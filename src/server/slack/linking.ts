// Linking a Slack account to an Ordinate one: two sign-ins, never an email match.
//
//   1. An unknown Slack user asks; the worker parks the question, makes a `slack_link_states` row (random token,
//      10 minutes, single use) and sends a private Connect button to /api/slack/connect?s=<token>.
//   2. /api/slack/connect is behind the normal sign-in. It writes the signed-in Ordinate user onto the state row and
//      sends the browser to Slack's OpenID authorize endpoint (scope `openid`, state = the token, a nonce).
//   3. Slack answers to /api/slack/connect/callback (GET, or a cross-site form_post: no session cookie arrives, none
//      is read). The state row alone says who this is for: it is consumed (single use), the code is exchanged, the
//      id_token verified (signature by JWKS, aud, nonce), and its Slack user and team must equal the row's. Then the
//      link is saved and the parked question goes back in the queue.
//
// A link says who someone is, never what they may see: every question re-reads the Ordinate account.
// Outbound calls go through the SSRF guard (`safeFetch`) to slack.com.

import * as client from 'openid-client';
import { safeFetch } from '../../connectors/ssrf';
import { appLink } from '../publicUrl';
import { slackOrigin } from './base';
import * as store from './db';
import { userInfo } from './client';

const USER_CLAIM = 'https://slack.com/user_id';
const TEAM_CLAIM = 'https://slack.com/team_id';
export const CALLBACK_PATH = '/api/slack/connect/callback';

/** openid-client's fetch, through the SSRF guard. */
const guarded: client.CustomFetch = (url, o) => {
  const body = o.body instanceof URLSearchParams ? o.body.toString() : (o.body as string | undefined | null) ?? undefined; // openid-client sends a string or form
  return safeFetch(url, { method: o.method, headers: o.headers as HeadersInit, body, redirect: 'error', signal: AbortSignal.timeout(20_000) });
};

async function configure(inst: store.Install, secret: string | null): Promise<client.Configuration> {
  const origin = slackOrigin();
  const opts: client.DiscoveryRequestOptions = { [client.customFetch]: guarded, ...(origin.startsWith('http:') ? { execute: [client.allowInsecureRequests] } : {}) };
  return client.discovery(new URL(origin), inst.clientId, secret ? { client_secret: secret } : undefined, secret ? undefined : client.None(), opts);
}

/** The Connect button's URL for a state token, or null when the server does not know its own address. */
export function connectUrl(token: string): string | null {
  return appLink(`/api/slack/connect?s=${encodeURIComponent(token)}`);
}

/** What to say before a Connect button can be made: a person from another Slack organization is never linked. */
export async function mayLink(inst: store.Install, botToken: string, slackUser: string): Promise<boolean> {
  const u = await userInfo(botToken, slackUser);
  return !u.isStranger && u.teamId === inst.teamId && !u.isBot && !u.deleted;
}

/** The Slack authorize URL for a bound state, or null when the state is unknown, used or expired. */
export async function authorizeUrl(token: string, org: string, email: string): Promise<string | null> {
  const state = await store.bindState(token, org, email);
  const inst = state && (await store.installByOrg(org));
  const redirect = appLink(CALLBACK_PATH);
  if (!state || !inst || !redirect || !inst.clientId) return null;
  const conf = await configure(inst, await store.getSecret(org, 'clientSecret'));
  return client.buildAuthorizationUrl(conf, {
    redirect_uri: redirect, scope: 'openid', response_type: 'code', state: token, nonce: state.nonce, team: inst.teamId,
  }).href;
}

export type LinkResult = { ok: true; email: string } | { ok: false; reason: 'state' | 'slack' | 'mismatch' | 'stranger' | 'denied' };

/** The callback. `params`: code, state, error — from the query or the form body, whichever Slack used. No session is consulted. */
export async function finishLink(params: { code?: string; state?: string; error?: string }): Promise<LinkResult> {
  if (typeof params.state !== 'string' || params.state.length > 200) return { ok: false, reason: 'state' };
  const state = await store.consumeState(params.state); // single use: a replay finds it used
  if (!state || !state.userEmail) return { ok: false, reason: 'state' };
  if (params.error || typeof params.code !== 'string') return { ok: false, reason: 'denied' };
  const inst = await store.installByTeam(state.teamId);
  const redirect = appLink(CALLBACK_PATH);
  if (!inst || inst.orgId !== state.orgId || !redirect) return { ok: false, reason: 'slack' };
  let claims: Record<string, unknown> | undefined;
  try {
    const conf = await configure(inst, await store.getSecret(state.orgId, 'clientSecret'));
    const current = new URL(redirect);
    current.searchParams.set('code', params.code);
    current.searchParams.set('state', params.state);
    const tokens = await client.authorizationCodeGrant(conf, current, { expectedState: params.state, expectedNonce: state.nonce, idTokenExpected: true });
    claims = tokens.claims() as Record<string, unknown> | undefined;
  } catch {
    return { ok: false, reason: 'slack' };
  }
  if (!claims) return { ok: false, reason: 'slack' };
  if (claims[USER_CLAIM] !== state.slackUserId || claims[TEAM_CLAIM] !== state.teamId) return { ok: false, reason: 'mismatch' };
  await store.saveLink(state.orgId, state.teamId, state.slackUserId, state.userEmail);
  if (state.questionId) await store.resume(state.orgId, state.questionId);
  return { ok: true, email: state.userEmail };
}
