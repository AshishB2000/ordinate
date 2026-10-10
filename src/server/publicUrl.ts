// The address people open this server at — ORDINATE_PUBLIC_URL.
//
// A message the server sends with nobody signed in (a subscription, an alert
// posted to a channel) links back to the dashboard. That link is NEVER built
// from a request's Host or Origin: there is no request, and a header a client
// chose must not decide where a link in Slack points. It is built from this
// variable, which the operator sets, or — under OIDC sign-in — from
// OIDC_REDIRECT_URL, which already names the same origin and is already
// required to be exact. Neither set → no link is sent, and the UI says why.
//
// Pure and re-read per use, like ./liveEnv.ts: parseEnv validates the variable
// at startup (a typo stops the pod), the sender reads it the same way.

import { EnvError } from './envError';

/** The public origin ("https://bi.example.com"), or null when the server does not know it. */
export function publicOrigin(raw: string | undefined, oidcRedirect?: string): string | null {
  const value = raw === undefined || raw === '' ? '' : raw;
  if (value === '') {
    try {
      return oidcRedirect ? new URL(oidcRedirect).origin : null;
    } catch {
      return null; // OIDC_REDIRECT_URL has its own check in parseAuth
    }
  }
  let u: URL | null = null;
  try {
    u = new URL(value);
  } catch {
    // falls through
  }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new EnvError(`ORDINATE_PUBLIC_URL must be the server's origin with no path, for example https://bi.example.com, got ${JSON.stringify(value)}`);
  }
  return u.origin;
}

/**
 * The link to a dashboard in the app, or null.
 * ponytail: always the dashboard as saved — the web app has no saved-view URL yet; add `?view=` when it reads one.
 */
export function dashboardLink(projectId: string, analysisId: string): string | null {
  const origin = publicOrigin(process.env.ORDINATE_PUBLIC_URL, process.env.OIDC_REDIRECT_URL);
  return origin ? `${origin}/analyses/${projectId}/${analysisId}` : null;
}
