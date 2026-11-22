// The ONLY way the issues board talks to Linear or Jira (docs/issues-board/00-design.md): through the SSRF guard (`safeFetch`), to the
// provider's own host, over https, with redirects refused. The host is not an input of a call: it is the provider's constant, or the admin's
// Jira site once it passed `jiraHost` (a strict `<name>.atlassian.net`). A secret is a header the caller builds; this file never logs one,
// and an error carries a code, never the provider's words (they could echo a header).
//
// Tests replace the transport (`setTransportForTest`) with a stub provider: no test makes a network call.

import { safeFetch } from '../../../connectors/ssrf';

export const LINEAR_HOST = 'api.linear.app';
const JIRA_SITE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TIMEOUT_MS = 15_000;
const MAX_BODY = 1_000_000;

/** `acme` or `acme.atlassian.net` (case aside) as `acme.atlassian.net`; null for anything else: a scheme, port, path, user info, another domain. */
export function jiraHost(input: string): string | null {
  const s = input.trim().toLowerCase();
  const name = s.endsWith('.atlassian.net') ? s.slice(0, -'.atlassian.net'.length) : s;
  return JIRA_SITE.test(name) ? `${name}.atlassian.net` : null;
}
const allowed = (host: string): boolean => host === LINEAR_HOST || (host.endsWith('.atlassian.net') && jiraHost(host) === host);

export type Transport = (url: URL, init: RequestInit) => Promise<Response>;
const real: Transport = (url, init) => safeFetch(url, init);
let transport: Transport = real;
export function setTransportForTest(t: Transport | null): void {
  transport = t ?? real;
}

export class TrackerError extends Error {
  constructor(readonly code: 'auth' | 'unreachable' | 'rejected' | 'bad_reply') {
    super(`tracker: ${code}`);
    this.name = 'TrackerError';
  }
}

export interface Reply { status: number; json: unknown }

/** One request to `https://<host><path>`. `path` starts with `/`. Never follows a redirect. */
export async function call(host: string, path: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; json?: unknown }): Promise<Reply> {
  if (!allowed(host) || !path.startsWith('/') || path.startsWith('//')) throw new TrackerError('unreachable');
  const url = new URL(`https://${host}${path}`);
  if (url.hostname !== host) throw new TrackerError('unreachable');
  let res: Response;
  try {
    res = await transport(url, {
      method: init.method, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json', ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
  } catch {
    throw new TrackerError('unreachable'); // the refusal's or the network's words are dropped: they may name an address
  }
  const text = (await res.text().catch(() => '')).slice(0, MAX_BODY);
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* not JSON: the status is what counts */ }
  return { status: res.status, json };
}
