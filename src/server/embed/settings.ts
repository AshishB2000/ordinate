// An org's embedding settings (docs/embed/00-design.md): the switch and the
// allowed parent origins in `org_settings` (0017_embed.sql), the signing
// secret in the secrets store (kind `embed.signing`, ref `org`), encrypted
// under the org's data key. Without Postgres or ORDINATE_MASTER_KEY there is
// no store: a secret is never generated, and embedding cannot be turned on.
//
// Read on every embed view, by org id, before any request context exists — so
// turning embedding off, or rotating the secret, takes effect on the next view
// on every pod. ponytail: two queries per view (settings, secret) under the
// page cache and the rate limits; a short per-pod cache if they ever show up.

import { randomBytes } from 'crypto';
import type { Pool } from 'pg';
import type { SecretStore } from '../secrets/store';
import { embedNeedsOrigin, embedNeedsSecret, embedNeedsStore, embedOriginBad, embedOriginsMax } from '../embedMessages';

export const MAX_ORIGINS = 20;
const KIND = 'embed.signing';
const REF = 'org';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

let db: Pool | null = null;
let store: SecretStore | null = null;

/** Hand this module the pool and the secret store once the schema is current (src/server/app.ts), or nulls to drop them. */
export function useEmbedDb(pool: Pool | null, secrets: SecretStore | null): void {
  db = pool;
  store = secrets;
}

/** Can this server keep an embed secret (and so embed at all)? */
export function canStore(): boolean {
  return db !== null && store !== null;
}

export interface EmbedSettings {
  readonly enabled: boolean;
  /** Exact origins (`https://portal.acme.com`) allowed to frame /embed/*. */
  readonly origins: string[];
}

/**
 * `raw` as an exact origin, or null: https (any host) or http on a loopback
 * name only; no path, query, fragment, userinfo or wildcard. The result is
 * what `URL.origin` writes, which is how a browser compares frame-ancestors.
 */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 255 || s.includes('*')) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (s.replace(/\/$/, '').toLowerCase() !== u.origin.toLowerCase()) return null; // a path, `?` or `#` with nothing after it
  if (u.protocol === 'https:') return u.origin;
  return u.protocol === 'http:' && LOOPBACK.has(u.hostname) ? u.origin : null;
}

/** The org's settings; off with no row (or no database). */
export async function readSettings(org: string): Promise<EmbedSettings> {
  if (!db) return { enabled: false, origins: [] };
  const r = await db.query<{ on: boolean; origins: string[] }>('SELECT embed_enabled AS on, embed_origins AS origins FROM org_settings WHERE org_id = $1', [org]);
  const row = r.rows[0];
  return { enabled: row?.on === true, origins: (row?.origins ?? []).filter((o) => normalizeOrigin(o) === o) };
}

/** The org's signing secret, or null. Throws (SecretError) when it cannot be decrypted. */
export async function secretOf(org: string): Promise<string | null> {
  return store ? store.get(org, KIND, REF) : null;
}

/** Save the switch and the origins; a sentence when refused. */
export async function saveSettings(org: string, s: { enabled: boolean; origins: readonly string[] }): Promise<{ ok: true; settings: EmbedSettings } | { ok: false; error: string }> {
  if (!db || !store) return { ok: false, error: embedNeedsStore() };
  const origins: string[] = [];
  for (const raw of s.origins) {
    const o = normalizeOrigin(raw);
    if (!o) return { ok: false, error: embedOriginBad(String(raw).slice(0, 80)) };
    if (!origins.includes(o)) origins.push(o);
  }
  if (origins.length > MAX_ORIGINS) return { ok: false, error: embedOriginsMax(MAX_ORIGINS) };
  if (s.enabled && !origins.length) return { ok: false, error: embedNeedsOrigin() };
  if (s.enabled && !(await secretOf(org))) return { ok: false, error: embedNeedsSecret() };
  await db.query(
    `INSERT INTO org_settings (org_id, embed_enabled, embed_origins, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (org_id) DO UPDATE SET embed_enabled = $2, embed_origins = $3, updated_at = now()`,
    [org, s.enabled, origins],
  );
  return { ok: true, settings: { enabled: s.enabled, origins } };
}

/**
 * A new signing secret, replacing the old one: every token signed with the old
 * secret fails from the next view on. Returned ONCE — nothing reads it back to a browser.
 */
export async function rotateSecret(org: string): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  if (!db || !store) return { ok: false, error: embedNeedsStore() };
  const secret = 'ord_embed_' + randomBytes(32).toString('base64url');
  await store.put(org, KIND, REF, secret);
  return { ok: true, secret };
}

/** Is a secret stored for `org`? */
export async function hasSecret(org: string): Promise<boolean> {
  return (await secretOf(org)) !== null;
}
