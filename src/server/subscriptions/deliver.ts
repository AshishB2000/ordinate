// Posting one message to one channel — the ONLY module that reads a webhook URL
// (src/app/channels.ts webhookOf) and the only socket a subscription opens.
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
import { webhookOf, webhookProblem } from '../../app/channels';

export type PostCode = 'sent' | 'post_failed' | 'unreachable' | 'refused' | 'no_secret';
export interface PostResult {
  ok: boolean;
  code: PostCode;
  status?: number;
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

/** Test hook: how a wait is spent, so a suite does not sleep through a backoff. */
export function setSleepForTest(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
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
      const refused = err instanceof SsrfError;
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
export async function postToChannel(channelId: string, channelName: string, payload: unknown): Promise<PostResult> {
  const url = await webhookOf(channelId);
  if (!url) return { ok: false, code: 'no_secret', attempts: 0 };
  return postJson(url, JSON.stringify(payload), channelName);
}
