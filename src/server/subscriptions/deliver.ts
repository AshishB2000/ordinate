// Sending one message to one channel — `deliver`, THE ONE DOOR every send goes
// through: a subscription run, a fired alert, a channel test. It is the only
// module that reads a webhook URL (src/app/channels.ts webhookOf) and the only
// way to the SMTP client (../mail/emailChannel.ts).
//
// A caller names a SOURCE, never the datasets: `deliver` computes them itself
// (./figureDatasets.ts) and asks `refuseFanOut` — item 5's row-policy refusal —
// before a recipient is resolved, a URL read or a socket opened. A test's
// message is composed here, so no figures ride the test branch.
//
// Every post goes through the SSRF guard's `safeFetch` (src/connectors/ssrf.ts):
// the host is resolved, refused when any address is internal, and the socket is
// pinned to the address that was checked. A redirect is an error — a webhook
// that answers 3xx is not one, and following it would send the message (and
// nothing else: no credential rides in a header) somewhere the admin never chose.
//
// RETRIES. Up to three attempts. A 429 waits for `Retry-After` (seconds, capped)
// before the next; a 5xx or a dropped connection backs off 1 s then 4 s. Any
// other 4xx is final at once: the URL was revoked or the payload refused, and a
// retry would only repeat it.
//
// WHAT IS LOGGED. The remote's status and the first part of its body, to the
// server log only — never to a browser, a run's history or an SSE event — with
// the webhook URL (whole, and its path, which is the secret part) cut out of
// every string first. The URL itself is never logged.

import { safeFetch, SsrfError } from '../../connectors/ssrf';
import { webhookOf, webhookProblem, type Channel } from '../../app/channels';
import { composeMessage, type MessageModel } from '../../analysis/subscriptionMessage';
import { renderSlack, renderTeams } from '../../analysis/subscriptionRender';
import * as say from '../../analysis/subscriptionText';
import { sendEmail, setMailSleepForTest } from '../mail/emailChannel';
import { figureDatasets } from './figureDatasets';
import { assertFanOutAllowed, isRowPolicyError, type RowPolicyError } from '../../data/rowAccess';

export type PostCode = 'sent' | 'post_failed' | 'unreachable' | 'refused' | 'no_secret' | 'compute_failed' | 'row_policy'
  | 'mail_off' | 'no_recipients' | 'rate_limited' | 'list_too_large' | 'tls_failed' | 'auth_failed' | 'mail_failed';
export interface PostResult {
  ok: boolean;
  code: PostCode;
  status?: number;
  /** Email only: some recipients got it and some did not (a batch failed, or the hourly budget ran out mid-send). */
  partial?: { sent: number; total: number };
  attempts: number;
}

export interface Log {
  warn(obj: object, msg: string): void;
}

export const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000];
const RETRY_AFTER_CAP_MS = 30_000;
const TIMEOUT_MS = 15_000;
const BODY_LOGGED = 500;

let sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let log: Log = { warn: (obj, msg) => console.warn(msg, JSON.stringify(obj)) };

/** The server's logger (src/server/app.ts); pino's redaction applies on top of the cut made here. */
export function useDeliveryLog(l: Log): void {
  log = l;
}

/** Test hook: how a wait is spent, so a suite does not sleep through a backoff (webhook and email alike). */
export function setSleepForTest(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
  setMailSleepForTest(fn);
}

/** `text` with the webhook URL, and its path and query, cut out. */
export function redactWebhook(text: string, url: string): string {
  let out = text.split(url).join('[webhook]');
  try {
    const u = new URL(url);
    for (const part of [u.pathname + u.search, u.pathname, u.search.slice(1)]) if (part.length > 4) out = out.split(part).join('[webhook]');
  } catch {
    // not a URL: the whole-string cut above is all there is to do
  }
  return out;
}

/** How long a 429 asks us to wait: `Retry-After` in seconds, capped. Absent or unreadable → null (use the backoff). */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const s = Number(header.trim());
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, RETRY_AFTER_CAP_MS) : null;
}

/** POST `body` (JSON) to `url`. Never throws; never returns anything the remote said. */
export async function postJson(url: string, body: string, channel: string): Promise<PostResult> {
  if (webhookProblem(url)) return { ok: false, code: 'refused', attempts: 0 };
  let last: PostResult = { ok: false, code: 'unreachable', attempts: 0 };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let wait = BACKOFF_MS[attempt - 1] ?? 0;
    try {
      const res = await safeFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = (await res.text().catch(() => '')).slice(0, BODY_LOGGED);
      if (res.status >= 200 && res.status < 300) return { ok: true, code: 'sent', status: res.status, attempts: attempt };
      last = { ok: false, code: 'post_failed', status: res.status, attempts: attempt };
      log.warn({ channel, status: res.status, attempt, body: redactWebhook(text, url) }, 'subscription post refused by the remote');
      if (res.status === 429) wait = retryAfterMs(res.headers.get('retry-after')) ?? wait;
      else if (res.status < 500) return last;
    } catch (err) {
      // The guard's refusals are final; a name that did not resolve is the network's failure, not a refusal
      // (ssrf.ts words it "Could not resolve …"), and is retried like any other.
      const refused = err instanceof SsrfError && !err.message.startsWith('Could not resolve');
      last = { ok: false, code: refused ? 'refused' : 'unreachable', attempts: attempt };
      // The message only (an error object can carry the request, URL included), with the URL cut out.
      log.warn({ channel, attempt, error: redactWebhook(err instanceof Error ? err.message : String(err), url) }, 'subscription post failed');
      if (refused) return last;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(wait);
  }
  return last;
}

/** Post to a saved channel by id: reads its sealed URL here and nowhere else. */
async function postToChannel(channelId: string, channelName: string, payload: unknown): Promise<PostResult> {
  const url = await webhookOf(channelId);
  if (!url) return { ok: false, code: 'no_secret', attempts: 0 };
  return postJson(url, JSON.stringify(payload), channelName);
}

/** What is being sent, by where it comes from. A caller never says which datasets it holds. */
export type Delivery =
  | { kind: 'test' }
  | { kind: 'dashboard'; projectId: string; analysisId: string; message: MessageModel }
  | { kind: 'alert'; projectId: string; ruleId: string; message: MessageModel };

/** The message a channel's "Send a test message" sends: fixed words, no data. */
export function testMessage(name: string): MessageModel {
  return composeMessage({ title: say.testTitle(), subtitle: [], note: say.testBody(name), kpis: [], visuals: [], link: null, footer: '' });
}

/**
 * ITEM 5's refusal (docs/email/00-design.md §2, docs/row-policy D10): a send whose figures can come from a
 * dataset with row access rules — or one built from one — is refused, for every owner, channel kind and
 * source. Rules that cannot be read refuse too (`row_policy`); any other failure is `compute_failed`.
 */
export async function refuseFanOut(d: Delivery, datasetIds: readonly string[]): Promise<PostResult | null> {
  if (d.kind === 'test') return null;
  try {
    await assertFanOutAllowed(d.projectId, datasetIds);
    return null;
  } catch (err) {
    if (isRowPolicyError(err)) return { ok: false, code: 'row_policy', attempts: 0 };
    log.warn({ error: err instanceof Error ? err.message : String(err) }, 'send refused: its row access rules could not be checked');
    return { ok: false, code: 'compute_failed', attempts: 0 };
  }
}

/**
 * The same refusal asked of a dashboard from its DEFINITION — nothing computed, no warehouse called —
 * before a subscription is previewed or saved. The RowPolicyError, or null when it may be sent.
 */
export async function dashboardSendRefusal(projectId: string, analysisId: string): Promise<RowPolicyError | null> {
  try {
    await assertFanOutAllowed(projectId, await figureDatasets({ kind: 'dashboard', projectId, analysisId }));
    return null;
  } catch (err) {
    if (isRowPolicyError(err)) return err;
    throw err;
  }
}

/**
 * The datasets of one source, read once for every channel of one run or tick: a caller sending the same source to
 * several channels passes one `memo` (run.ts per run, alertPosts.ts per tick). A failed read is memoised too, so
 * every channel refuses alike.
 */
export type DatasetsMemo = Map<string, Promise<string[]>>;
const sourceKey = (d: Delivery): string => (d.kind === 'test' ? 'test' : `${d.kind}:${d.projectId}:${d.kind === 'dashboard' ? d.analysisId : d.ruleId}`);

/** Send one delivery to one channel. Never throws. */
export async function deliver(channel: Channel, d: Delivery, memo?: DatasetsMemo): Promise<PostResult> {
  let datasetIds: string[];
  try {
    const key = sourceKey(d);
    let read = memo?.get(key);
    if (!read) {
      read = figureDatasets(d);
      memo?.set(key, read);
    }
    datasetIds = await read;
  } catch (err) {
    log.warn({ channel: channel.id, error: err instanceof Error ? err.message : String(err) }, 'send refused: what its figures come from could not be read');
    return { ok: false, code: 'compute_failed', attempts: 0 };
  }
  const refused = await refuseFanOut(d, datasetIds);
  if (refused) return refused;
  const message = d.kind === 'test' ? testMessage(channel.name) : d.message;
  try {
    if (channel.kind === 'email') return await sendEmail(channel, d, message);
    return await postToChannel(channel.id, channel.name, (channel.kind === 'teams' ? renderTeams : renderSlack)(message).payload);
  } catch (err) {
    log.warn({ channel: channel.id, error: err instanceof Error ? err.message : String(err) }, 'send failed');
    return { ok: false, code: 'unreachable', attempts: 0 };
  }
}
