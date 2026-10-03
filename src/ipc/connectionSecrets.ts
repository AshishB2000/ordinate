// A connection's secrets, as the connection:* handlers (./connections.ts) see
// them — MAIN ONLY. Split out of connections.ts at its size budget; this is the
// whole secret half of that file: form payload → secrets, secrets → the store
// (src/app/configSecrets.ts: config.json on the desktop, the encrypted store on
// the server), store → the ConnectorContext, and the "is one set?" answer the
// web form shows as "set" / "replace". A value never leaves this module except
// into a connector call.
//
// KNOWN LIMIT (config.ts, not ours to change): config.ConnectionSecret has
// exactly two slots, `password` and `token`. A connector with more than one
// non-password secret field can therefore only persist the first of them. The
// mapping is explicit in secretSlot() so the day a connector needs a third
// credential, the failure is a one-line fix in config.ts rather than a mystery.

import * as configSecrets from '../app/configSecrets';
import type { ConnectorDef, ConnectorField } from '../connectors/types';

export function fieldsOf(def: ConnectorDef): ConnectorField[] {
  return Array.isArray(def.fields) ? def.fields : [];
}

function secretFields(def: ConnectorDef | null): ConnectorField[] {
  return def ? fieldsOf(def).filter((f) => f.secret === true) : [];
}

// Which of config.json's two secret slots this field key uses. 'password' is its
// own slot; everything else (token, apiKey, serviceAccount, …) shares `token`.
function secretSlot(key: string): 'password' | 'token' {
  return key === 'password' ? 'password' : 'token';
}

// Pull the secret values out of a form payload, keyed by field key. Also accepts
// the two legacy key names the pre-registry renderer sends ({password}/{token})
// when the connector declares a differently-named single secret field.
export function buildSecrets(def: ConnectorDef, raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of secretFields(def)) {
    const direct = raw[f.key];
    if (typeof direct === 'string' && direct) { out[f.key] = direct; continue; }
    const legacy = raw[secretSlot(f.key)];
    if (typeof legacy === 'string' && legacy) out[f.key] = legacy;
  }
  return out;
}

/** Persist a connection's secrets into the two slots. Throws on a server that cannot keep them. */
export async function storeSecrets(connId: string, secrets: Record<string, string>): Promise<void> {
  const payload: { password?: string; token?: string } = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (!value) continue;
    const slot = secretSlot(key);
    if (payload[slot] === undefined) payload[slot] = value; // first writer wins — see KNOWN LIMIT
  }
  if (payload.password || payload.token) await configSecrets.saveConnectionSecrets(connId, payload);
}

// Read a connection's secrets back, re-keyed by the connector's field keys — the
// shape ConnectorContext.secrets promises. MAIN ONLY; never returned anywhere.
export async function loadSecrets(connId: string, def: ConnectorDef | null): Promise<Record<string, string>> {
  const stored = await configSecrets.loadConnectionSecrets(connId);
  const out: Record<string, string> = {};
  const password = typeof stored.password === 'string' ? stored.password : '';
  const token = typeof stored.token === 'string' ? stored.token : '';
  for (const f of secretFields(def)) {
    const v = secretSlot(f.key) === 'password' ? password : token;
    if (v) out[f.key] = v;
  }
  // Always expose the two legacy names too: a connector written against the old
  // vocabulary reads ctx.secrets.password / .token directly.
  if (password) out.password = password;
  if (token) out.token = token;
  return out;
}

/** Per secret field of the connector: is a value stored? Booleans only — what the form shows as "set". */
export async function secretStatus(connId: string, def: ConnectorDef | null): Promise<Record<string, boolean>> {
  const held = await loadSecrets(connId, def);
  const out: Record<string, boolean> = {};
  for (const f of secretFields(def)) out[f.key] = Boolean(held[f.key]);
  return out;
}

/** True when `key` names one of this connector's secret fields. */
export function isSecretField(def: ConnectorDef, key: string): boolean {
  return secretFields(def).some((f) => f.key === key);
}
