// Connection secrets — MAIN PROCESS ONLY, and the only place one is read back.
//
// A pg password or a URL token is written here by connection:testAndSave and
// read back only to RUN a connection. Nothing in this file is reachable from a
// renderer: publicConfig()/publicByok() in config.ts are the renderer-safe views
// and they strip every one of these.
//
// Split out of config.ts when that file hit the 800-line cap
// (.claude/rules/file-size.md). It was the cleanest seam by a distance: nothing
// else in config.ts calls these three, they are the file's single most
// security-sensitive surface, and having them in one small file makes that
// surface something a reviewer can read end to end.
//
// Callers use the ASYNC trio at the bottom (save/load/dropConnectionSecrets):
// the desktop's config.json here, the server's encrypted store there.

import { get, persist } from './config';
import type { ConnectionSecret } from './config';
import type { SecretStore } from '../server/secrets/store';
import { ctx, serverDataDir } from '../server/context';

// Connection ids come from the renderer. Validate the SHAPE before one is used
// as a key in the secrets map — the same discipline every id in this app gets.
function isConnId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// MAIN PROCESS ONLY. Stored plaintext in config.json like API keys, keyed by the
// connection's generated UUID. Never in a project file, never to a renderer.

// Merge the non-empty secret fields for a connection. connId must be a UUID.
// ponytail: secret is an IPC payload — validated per-field, empty strings ignored.
export function setConnectionSecret(
  connId: unknown,
  secret: { password?: unknown; token?: unknown },
): { ok: boolean } {
  if (!isConnId(connId)) return { ok: false };
  const cfg = get();
  const cur: ConnectionSecret = cfg.connectionSecrets[connId] || {};
  const next: ConnectionSecret = { ...cur };
  if (secret && typeof secret.password === 'string' && secret.password) next.password = secret.password;
  if (secret && typeof secret.token === 'string' && secret.token) next.token = secret.token;
  cfg.connectionSecrets[connId] = next;
  persist(cfg);
  return { ok: true };
}

// Read a connection's secret — MAIN ONLY. Returns {} when none / invalid id.
export function getConnectionSecret(connId: unknown): ConnectionSecret {
  if (!isConnId(connId)) return {};
  return get().connectionSecrets[connId] || {};
}

// Drop a connection's secret (called on connection:delete).
export function deleteConnectionSecret(connId: unknown): { ok: boolean } {
  if (!isConnId(connId)) return { ok: false };
  const cfg = get();
  if (connId in cfg.connectionSecrets) {
    delete cfg.connectionSecrets[connId];
    persist(cfg);
  }
  return { ok: true };
}

// ── The server's route: the encrypted store, never config.json (T5.3 → T2.5) ──
//
// On the server a connection's password/token goes through T5.3's envelope-
// encrypted store (src/server/secrets/store.ts), keyed (org, kind, connId), and
// NEVER through the per-org plaintext config.json above. A server without that
// store (no DATABASE_URL or no ORDINATE_MASTER_KEY) REFUSES to keep a secret —
// a clear error, nothing written — rather than fall back to plaintext. On the
// desktop these three delegate to the sync functions above, unchanged.
//
// The org is ctx().org — the request's, never an argument.

let store: SecretStore | null = null;

/** Hand the server its secret store once the schema is current (src/server/app.ts), or null to drop it. */
export function useSecretStore(s: SecretStore | null): void {
  store = s;
}

export const NO_SECRET_STORE =
  'This server cannot store passwords or tokens: it needs DATABASE_URL and ORDINATE_MASTER_KEY. Nothing was saved.';

const KIND = { password: 'connection.password', token: 'connection.token' } as const;
const SLOTS = ['password', 'token'] as const;
const onServer = (): boolean => serverDataDir() !== null;

/** Can a connection secret be kept here? Always on the desktop; on the server only with the store. */
export function canStoreConnectionSecrets(): boolean {
  return !onServer() || store !== null;
}

/** Keep a connection's non-empty secret slots. Throws NO_SECRET_STORE on a server without the store. */
export async function saveConnectionSecrets(connId: unknown, secret: { password?: string; token?: string }): Promise<void> {
  if (!onServer()) {
    setConnectionSecret(connId, secret);
    return;
  }
  if (!isConnId(connId)) throw new Error('Invalid connection id');
  if (!store) throw new Error(NO_SECRET_STORE);
  for (const slot of SLOTS) {
    const v = secret[slot];
    if (typeof v === 'string' && v) await store.put(ctx().org.id, KIND[slot], connId, v);
  }
}

/** A connection's secret slots, for MAIN to run it. `{}` when none (or no store: nothing could have been kept). */
export async function loadConnectionSecrets(connId: unknown): Promise<ConnectionSecret> {
  if (!onServer()) return getConnectionSecret(connId);
  if (!isConnId(connId) || !store) return {};
  const out: ConnectionSecret = {};
  for (const slot of SLOTS) {
    const v = await store.get(ctx().org.id, KIND[slot], connId);
    if (v) out[slot] = v;
  }
  return out;
}

/** Forget a connection's secrets (connection:delete). */
export async function dropConnectionSecrets(connId: unknown): Promise<void> {
  if (!onServer()) {
    deleteConnectionSecret(connId);
    return;
  }
  if (!isConnId(connId) || !store) return;
  for (const slot of SLOTS) await store.delete(ctx().org.id, KIND[slot], connId);
}
