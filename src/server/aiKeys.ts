// The server's AI provider keys (T2.12) — the
// seam src/app/execConfig.ts and src/ai/analyze.ts reach in server mode.
//
// KEYS. On the desktop an API key is plaintext in config.json (the documented
// decision). On the server it never is: it lives in T5.3's encrypted secrets
// store, one row per (org, 'ai.apiKey', provider). config.json keeps only the
// non-secret `keyStored` flag beside the provider's endpoint and model. With no
// store — no DATABASE_URL, or no ORDINATE_MASTER_KEY — there is nowhere safe to
// keep a key, so saving one is REFUSED rather than written in the clear.
//
// POLICY is not here: the models members may use are an allow-list in
// Postgres (./aiConfig.ts, Admin → AI).

import type { KeyObject } from 'crypto';
import type { Pool } from 'pg';
import { ctx } from './context';
import { createSecretStore, type SecretStore } from './secrets/store';

let store: SecretStore | null = null;
let db: Pool | null = null;

/** Called once the schema is current (app.ts). `masterKey` null → keys cannot be stored. Null pool → back to none. */
export function useAiKeys(pool: Pool | null, masterKey: KeyObject | null): void {
  db = pool;
  store = pool && masterKey ? createSecretStore(pool, masterKey) : null;
}

/** The pool AI setup lives in (./aiConfig.ts), or null with no database. */
export function aiDb(): Pool | null {
  return db;
}

/** Why a key cannot be stored on this server, or null when it can. */
export function keyStoreUnavailable(): string | null {
  if (store) return null;
  return db
    ? 'This server has no ORDINATE_MASTER_KEY, so it cannot store API keys.'
    : 'This server has no database, so it cannot store API keys.';
}

/** The caller's org's key for `provider`, or null. */
export async function getKey(provider: string): Promise<string | null> {
  return store ? store.get(ctx().org.id, 'ai.apiKey', provider) : null;
}

/** Stores the caller's org's key. Throws when keyStoreUnavailable() would say why. */
export async function putKey(provider: string, value: string): Promise<void> {
  if (!store) throw new Error(keyStoreUnavailable() ?? 'no key store');
  await store.put(ctx().org.id, 'ai.apiKey', provider, value);
}

export async function deleteKey(provider: string): Promise<void> {
  if (store) await store.delete(ctx().org.id, 'ai.apiKey', provider);
}
