// The IdP-group and API-token settings (docs/sso-lifecycle/00-design.md §3.1).
// Split out of ./env.ts, which reads each variable and passes it here. Pure:
// each parser takes the raw value, so a test can run it without a process env.

import { EnvError } from './envError';

type Mode = 'password' | 'oidc' | 'header' | 'dev';

/** Where sign-in reads a person's IdP groups, or null: groups are not read (any mapping is dormant). */
export type GroupsFrom = { readonly claim: string } | { readonly header: string } | null;

const HEADER_RE = /^[a-z0-9-]{1,100}$/;
/** Headers that already mean something else here: a groups header named after one would be nonsense or a hole. */
const RESERVED = new Set(['x-forwarded-email', 'x-forwarded-for', 'authorization', 'cookie', 'host', 'x-csrf-token', 'x-ordinate-client']);
/** RFC 6749 scope-token. */
const SCOPE_RE = /^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/;
const ALWAYS = new Set(['openid', 'email', 'profile']);

/**
 * OIDC_GROUPS_CLAIM (a top-level claim of the ID token) or TRUSTED_GROUPS_HEADER (a header the trusted proxy
 * sets). Each is refused in a mode that cannot read it: a mapping that silently does nothing would let an admin
 * believe roles follow the IdP when they do not.
 */
export function groupsFrom(mode: Mode, claim: string | undefined, header: string | undefined): GroupsFrom {
  const c = (claim ?? '').trim();
  const h = (header ?? '').trim().toLowerCase();
  if (c && mode !== 'oidc') throw new EnvError(`OIDC_GROUPS_CLAIM is read only when AUTH_MODE=oidc, and AUTH_MODE is ${mode}: unset it`);
  if (h && mode !== 'header') throw new EnvError(`TRUSTED_GROUPS_HEADER is read only when AUTH_MODE=header, and AUTH_MODE is ${mode}: unset it`);
  if (c) {
    if (c.length > 256) throw new EnvError('OIDC_GROUPS_CLAIM is longer than 256 characters');
    return Object.freeze({ claim: c });
  }
  if (!h) return null;
  if (!HEADER_RE.test(h)) throw new EnvError(`TRUSTED_GROUPS_HEADER must be a header name (letters, digits and -), for example X-Forwarded-Groups, got ${JSON.stringify(header)}`);
  if (RESERVED.has(h)) throw new EnvError(`TRUSTED_GROUPS_HEADER cannot be ${h}: that header already means something else`);
  return Object.freeze({ header: h });
}

/** OIDC_EXTRA_SCOPES: space- or comma-separated scopes sent after `openid email profile`. */
export function extraScopes(mode: Mode, raw: string | undefined): readonly string[] {
  const list = (raw ?? '').split(/[\s,]+/).filter(Boolean);
  if (list.length && mode !== 'oidc') throw new EnvError(`OIDC_EXTRA_SCOPES is read only when AUTH_MODE=oidc, and AUTH_MODE is ${mode}: unset it`);
  for (const s of list) if (!SCOPE_RE.test(s)) throw new EnvError(`OIDC_EXTRA_SCOPES: ${JSON.stringify(s)} is not a scope`);
  return Object.freeze([...new Set(list)].filter((s) => !ALWAYS.has(s)));
}

export const DEFAULT_API_TOKEN_MAX_DAYS = 365;

/** API_TOKEN_MAX_DAYS: the longest a personal API token lives, in days (1–3650). Lowering it shortens every token. */
export function apiTokenMaxDays(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_API_TOKEN_MAX_DAYS;
  const n = Number(raw);
  if (!/^\d{1,4}$/.test(raw) || n < 1 || n > 3650) throw new EnvError(`API_TOKEN_MAX_DAYS must be a whole number of days from 1 to 3650, got ${JSON.stringify(raw)}`);
  return n;
}
