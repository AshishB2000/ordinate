// Snowflake sign-in and host — MAIN PROCESS ONLY. Split out of snowflake.ts.
//
// THE HOST IS OURS (threat model R-L4). A user types an ACCOUNT IDENTIFIER
// (`myorg-myaccount`, or a locator such as `xy12345.us-east-2.aws`), never a
// URL. It must match ACCOUNT_RE — letters, digits, `_` and `-`, at most four
// dot-separated parts — and we build `https://<account>.snowflakecomputing.com`
// (or `<account>.privatelink.snowflakecomputing.com`) from it. So whatever is
// typed, the socket can only go to a subdomain of snowflakecomputing.com, and
// the transport still resolves, checks and pins it (ssrf.ts) — a PrivateLink
// name resolves inside the operator's VPC and is refused unless SSRF_ALLOW
// opens that range.
//
// TWO SIGN-INS, no password. Snowflake is retiring password-only sign-in, so it
// is not offered:
//   • key pair — a KEYPAIR_JWT signed (RS256, jwt.ts) with the user's private
//     key: iss = ACCOUNT.USER.SHA256:<public key fingerprint>, sub =
//     ACCOUNT.USER, at most one hour long. ACCOUNT is the identifier's first
//     part, upper-cased: Snowflake wants a locator WITHOUT its region/cloud
//     suffix, and an org-account name (MYORG-MYACCOUNT) as is.
//   • programmatic access token (PAT) — sent as the bearer, as is.
// Both secrets live in the `token` slot (connectionSecrets.ts); a private key's
// passphrase in `password`. A private key is never sent anywhere: a PEM in the
// PAT slot is refused before a socket opens.
//
// The JWT is cached per connection (its account, user and key) under orgKey():
// signing is cheap, but decrypting an encrypted PKCS#8 key on every statement is
// not. The cache key is a SHA-256 of the material, never the material.

import { createHash } from 'node:crypto';
import { orgKey } from '../server/context';
import { loadPrivateKey, publicKeyFingerprint, signJwtRs256 } from './jwt';
import type { ConnectorContext, ConnectorError } from './types';

export const ACCOUNT_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+){0,3}$/;
const SUFFIX = '.snowflakecomputing.com';

/** A JWT lives at most an hour (Snowflake's own ceiling); ours lives 59 minutes … */
export const JWT_LIFETIME_SEC = 59 * 60;
/** … and is re-signed once less than this is left, so no statement starts on a dying token. */
const JWT_REFRESH_SEC = 5 * 60;
const CACHE_MAX = 500;

export interface SfAccount {
  ok: true;
  /** The identifier as validated: lower case, no suffix. */
  account: string;
  /** `https://<account>[.privatelink].snowflakecomputing.com` — the only origin a request may name. */
  origin: URL;
  /** ACCOUNT as a key-pair JWT names it. */
  jwtAccount: string;
}

/**
 * Validate the account identifier and build the origin from it. Case-insensitive
 * (Snowflake's are), so it is lower-cased first; a pasted `.snowflakecomputing.com`
 * hostname is reduced to its identifier, since we rebuild the host anyway.
 * Anything else that is not an identifier — a URL, a path, `@`, an empty part —
 * is refused.
 */
export function accountOrigin(raw: unknown, privatelink: boolean): SfAccount | ConnectorError {
  let account = String(raw ?? '').trim().toLowerCase();
  if (!account) return { ok: false, error: 'Account is required' };
  if (account.endsWith(SUFFIX)) account = account.slice(0, -SUFFIX.length);
  if (account.length > 200 || !ACCOUNT_RE.test(account)) {
    return {
      ok: false,
      error: 'Account must be an account identifier such as myorg-myaccount or xy12345.us-east-2.aws — not a URL.',
    };
  }
  const link = privatelink && !account.endsWith('.privatelink') ? '.privatelink' : '';
  const host = `${account}${link}${SUFFIX}`;
  let origin: URL;
  try {
    origin = new URL(`https://${host}/`);
  } catch {
    return { ok: false, error: 'Invalid account' };
  }
  // The URL parser must not have changed what we built (it never should for
  // these characters); a mismatch is refused rather than trusted.
  if (origin.hostname !== host || origin.port !== '') return { ok: false, error: 'Invalid account' };
  return { ok: true, account, origin, jwtAccount: account.split('.')[0].toUpperCase() };
}

/** The claims of a key-pair JWT (pure: the clock is passed in). */
export function jwtClaims(jwtAccount: string, user: string, fingerprint: string, nowSec: number): Record<string, unknown> {
  const qualified = `${jwtAccount}.${user.toUpperCase()}`;
  return { iss: `${qualified}.${fingerprint}`, sub: qualified, iat: nowSec, exp: nowSec + JWT_LIFETIME_SEC };
}

const jwtCache = new Map<string, { token: string; exp: number }>();

function cacheKey(acct: SfAccount, user: string, pem: string, passphrase: string): string | null {
  const material = createHash('sha256').update([acct.jwtAccount, user.toUpperCase(), pem, passphrase].join('\u0000')).digest('hex');
  try {
    return orgKey(`snowflake-jwt:${material}`);
  } catch {
    return null; // outside a request on the server: no org to file it under, so sign afresh
  }
}

/** Drop every cached JWT. Tests only. */
export function clearJwtCache(): void {
  jwtCache.clear();
}

export interface SfAuth {
  ok: true;
  /** The bearer, JWT or PAT. A secret: never logged, redacted from every error. */
  token: string;
  tokenType: 'KEYPAIR_JWT' | 'PROGRAMMATIC_ACCESS_TOKEN';
}

const NOT_A_KEY =
  'The private key could not be read. Paste the whole PEM (-----BEGIN PRIVATE KEY----- …) and, for an encrypted key, its passphrase.';

/** The bearer for this connection: a (cached) key-pair JWT, or the PAT. */
export function authFor(ctx: ConnectorContext, acct: SfAccount, nowMs: number = Date.now()): SfAuth | ConnectorError {
  const secret = typeof ctx.secrets.token === 'string' ? ctx.secrets.token.trim() : '';
  const mode = ctx.values.auth === 'pat' ? 'pat' : 'keypair';
  if (mode === 'pat') {
    if (!secret) return { ok: false, error: 'Programmatic access token is required' };
    // A private key pasted into the token slot would be SENT as a bearer — refuse it here.
    if (secret.includes('PRIVATE KEY')) return { ok: false, error: 'That is a private key. Choose "Key pair" sign-in to use it.' };
    if (/\s/.test(secret)) return { ok: false, error: 'A programmatic access token has no spaces or line breaks' };
    return { ok: true, token: secret, tokenType: 'PROGRAMMATIC_ACCESS_TOKEN' };
  }

  const user = typeof ctx.values.user === 'string' ? ctx.values.user.trim() : '';
  if (!user) return { ok: false, error: 'User is required for key-pair sign-in' };
  if (!secret) return { ok: false, error: 'Private key is required' };
  const passphrase = typeof ctx.secrets.password === 'string' ? ctx.secrets.password : '';
  const nowSec = Math.floor(nowMs / 1000);
  const key = cacheKey(acct, user, secret, passphrase);
  const hit = key ? jwtCache.get(key) : undefined;
  if (hit && hit.exp - nowSec > JWT_REFRESH_SEC) return { ok: true, token: hit.token, tokenType: 'KEYPAIR_JWT' };

  const pk = loadPrivateKey(secret, passphrase || undefined);
  if (!pk) return { ok: false, error: NOT_A_KEY };
  const claims = jwtClaims(acct.jwtAccount, user, publicKeyFingerprint(pk), nowSec);
  const token = signJwtRs256(claims, pk);
  if (key) {
    if (jwtCache.size >= CACHE_MAX) jwtCache.delete(jwtCache.keys().next().value as string); // oldest first
    jwtCache.set(key, { token, exp: claims.exp as number });
  }
  return { ok: true, token, tokenType: 'KEYPAIR_JWT' };
}
