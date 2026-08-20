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

import { get, persist } from './config';
import type { ConnectionSecret } from './config';

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
