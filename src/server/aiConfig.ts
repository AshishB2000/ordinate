// AI setup for an org — which providers are connected, the exact models members
// may use, and each member's pick (docs/ai-models/00-plan.md §4). MAIN PROCESS.
//
// The one owner of this state. It lives in Postgres (0013_ai_models.sql), read
// on every call with no in-process cache, so every pod answers the same: before
// this, everything but the key was in a per-pod config.json and an admin who
// connected on pod A left pod B "not set up". The key itself stays in the
// secrets store (./aiKeys.ts) and never leaves this process.
//
// WITHOUT A DATABASE there is nowhere safe for a key, so nothing here can be
// set up; a no-database server (dev mode, the e2e harness) keeps the old
// single-pod config.json path in src/ai/byok.ts. `enabled()` says which.
//
// Every statement runs in a transaction with `ordinate.org` set, for the
// tables' forced RLS — and names its org anyway.

import type { Pool, PoolClient } from 'pg';
import * as config from '../app/config';
import { ORG_RE } from '../app/paths';
import { AI_PROVIDERS } from '../api/admin';
import * as msg from '../ai/aiMessages';
import * as aiKeys from './aiKeys';
import { ctx } from './context';

/** A model members may use. */
export interface AiModel {
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface MemberView {
  readonly ready: boolean;
  /** Why not ready: no key store on this server, or no model a member may use. */
  readonly reason?: 'no_key_store' | 'no_model';
  /** The models the caller may pick: enabled, on a connected provider, in list order. */
  readonly models: readonly AiModel[];
  /** The model that answers the caller: their pick while it is enabled, else the default. */
  readonly mine: { readonly provider: string; readonly model: string } | null;
}

export interface ProviderState {
  readonly provider: string;
  /** Saved and its last connection test passed. */
  readonly connected: boolean;
  /** Saved (a row exists) — with `connected` false, the last test failed. */
  readonly saved: boolean;
  readonly hasKey: boolean;
  readonly baseUrl: string;
  readonly verifiedAt: string | null;
}

export interface AdminView {
  /** Why this server cannot store a key, or null. */
  readonly keyStore: string | null;
  readonly providers: readonly ProviderState[];
  /** Every enabled model, whatever its provider's state, in list order. */
  readonly models: readonly AiModel[];
}

type Fail = { ok: false; error: string };

/** True when AI setup lives in Postgres (a database is configured). */
export function enabled(): boolean {
  return aiKeys.aiDb() !== null;
}

function pool(): Pool {
  const p = aiKeys.aiDb();
  if (!p) throw new Error('AI setup needs a database');
  return p;
}

/** One transaction as the caller's org, importing its old config.json first if it never was. */
async function asOrg<T>(fn: (c: PoolClient, org: string) => Promise<T>): Promise<T> {
  const org = ctx().org.id;
  if (!ORG_RE.test(org)) throw new Error('invalid org');
  const c = await pool().connect();
  try {
    await c.query(`BEGIN; SELECT set_config('ordinate.org', '${org}', true)`);
    await importLegacy(c, org);
    const out = await fn(c, org);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

// ── Legacy import, once per org ─────────────────────────────────────────────

/**
 * The org's old config.json byok block, into the tables: each provider with a
 * stored key (the gateway: a base URL) that `org_settings.ai_providers`
 * allowed, verified if it was, with its model; the old active provider's model
 * is the default. config.json is never edited. The org_ai_imports row is taken
 * first, so two pods racing import once and a later empty list stays empty.
 */
async function importLegacy(c: PoolClient, org: string): Promise<void> {
  if ((await c.query('SELECT 1 FROM org_ai_imports WHERE org_id = $1', [org])).rowCount) return;
  const took = await c.query('INSERT INTO org_ai_imports (org_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING org_id', [org]);
  if (!took.rowCount) return;
  const byok = config.get().byok;
  // On this transaction's own client: a second connection while holding one deadlocks a full pool.
  const policy = (await c.query<{ ai_providers: string[] | null }>('SELECT ai_providers FROM org_settings WHERE org_id = $1', [org])).rows[0]?.ai_providers;
  const allowed: readonly string[] = policy ?? AI_PROVIDERS;
  const picked = AI_PROVIDERS.filter((p) => {
    const e = byok.providers[p];
    return e && allowed.includes(p) && (p === 'gateway' ? Boolean(e.baseUrl) : Boolean(e.keyStored));
  });
  const def = picked.includes(byok.activeProvider as (typeof AI_PROVIDERS)[number]) ? byok.activeProvider : picked[0];
  let position = 0;
  for (const p of picked) {
    const e = byok.providers[p];
    await c.query(
      'INSERT INTO org_ai_providers (org_id, provider, base_url, verified_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [org, p, e.baseUrl === config.BYOK_DEFAULTS[p]?.baseUrl ? '' : e.baseUrl || '', e.verified ? new Date() : null],
    );
    const model = (e.model || config.BYOK_DEFAULTS[p]?.model || '').slice(0, 200);
    if (!model) continue;
    await c.query(
      'INSERT INTO org_ai_models (org_id, provider, model, label, position, is_default) VALUES ($1, $2, $3, $3, $4, $5) ON CONFLICT DO NOTHING',
      [org, p, model, position++, p === def],
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

interface ModelRow { provider: string; model: string; label: string; is_default: boolean; verified: boolean }

async function modelRows(c: PoolClient, org: string): Promise<ModelRow[]> {
  return (await c.query<ModelRow>(
    `SELECT m.provider, m.model, m.label, m.is_default, p.verified_at IS NOT NULL AS verified
       FROM org_ai_models m JOIN org_ai_providers p USING (org_id, provider)
      WHERE m.org_id = $1 ORDER BY m.position, m.provider, m.model`, [org])).rows;
}

const toModel = (r: ModelRow): AiModel => ({ provider: r.provider, model: r.model, label: r.label, isDefault: r.is_default });

async function member(c: PoolClient, org: string): Promise<MemberView> {
  const models = (await modelRows(c, org)).filter((r) => r.verified).map(toModel);
  const pick = (await c.query<{ provider: string; model: string }>(
    'SELECT provider, model FROM user_ai_model WHERE org_id = $1 AND user_email = $2', [org, ctx().user.email])).rows[0];
  const chosen = (pick && models.find((m) => m.provider === pick.provider && m.model === pick.model))
    ?? models.find((m) => m.isDefault) ?? models[0];
  const mine = chosen ? { provider: chosen.provider, model: chosen.model } : null;
  if (mine) return { ready: true, models, mine };
  return { ready: false, reason: aiKeys.keyStoreUnavailable() ? 'no_key_store' : 'no_model', models, mine };
}

/** What the caller may use, and what answers them. */
export async function memberView(): Promise<MemberView> {
  return asOrg(member);
}

/** The org's whole setup, for Admin → AI. Never a key. */
export async function adminView(): Promise<AdminView> {
  const keyStore = aiKeys.keyStoreUnavailable();
  const { rows, models } = await asOrg(async (c, org) => ({
    rows: (await c.query<{ provider: string; base_url: string; verified_at: Date | null }>(
      'SELECT provider, base_url, verified_at FROM org_ai_providers WHERE org_id = $1', [org])).rows,
    models: (await modelRows(c, org)).map(toModel),
  }));
  const providers: ProviderState[] = [];
  for (const provider of AI_PROVIDERS) {
    const r = rows.find((x) => x.provider === provider);
    providers.push({
      provider,
      connected: Boolean(r?.verified_at),
      saved: Boolean(r),
      hasKey: r ? (await aiKeys.getKey(provider)) !== null : false, // after the transaction: the store takes its own connection
      baseUrl: r?.base_url ?? '',
      verifiedAt: r?.verified_at ? r.verified_at.toISOString() : null,
    });
  }
  return { keyStore, providers, models };
}

/** A provider's endpoint and key for one outbound call (src/app/execConfig.ts byokCredentials). Key — main only. */
export async function credentials(provider: string): Promise<{ apiKey: string | null; baseUrl: string; verified: boolean; saved: boolean }> {
  const row = await asOrg(async (c, org) => (await c.query<{ base_url: string; verified_at: Date | null }>(
    'SELECT base_url, verified_at FROM org_ai_providers WHERE org_id = $1 AND provider = $2', [org, provider])).rows[0]);
  return {
    apiKey: await aiKeys.getKey(provider),
    baseUrl: row?.base_url || config.BYOK_DEFAULTS[provider]?.baseUrl || '',
    verified: Boolean(row?.verified_at),
    saved: Boolean(row),
  };
}

/** The model a call runs on for the caller, with its credentials — or why there is none. */
export async function resolve(): Promise<Fail | { ok: true; provider: string; model: string; apiKey: string | null; baseUrl: string }> {
  const view = await memberView();
  if (!view.mine) return { ok: false, error: msg.aiNotSetUp() };
  const { provider, model } = view.mine;
  const cred = await credentials(provider);
  if (provider !== 'gateway' && !cred.apiKey) return { ok: false, error: msg.aiNotSetUp() };
  if (provider === 'gateway' && !cred.baseUrl) return { ok: false, error: msg.aiNeedsBaseUrl() };
  return { ok: true, provider, model, apiKey: cred.apiKey, baseUrl: cred.baseUrl };
}

/** The model a connection test uses: the given one, the provider's first enabled one, its built-in default. */
export async function testModel(provider: string, model?: string): Promise<string> {
  if (model) return model;
  const first = await asOrg(async (c, org) => (await c.query<{ model: string }>(
    'SELECT model FROM org_ai_models WHERE org_id = $1 AND provider = $2 ORDER BY position LIMIT 1', [org, provider])).rows[0]?.model);
  return first || config.BYOK_DEFAULTS[provider]?.model || '';
}

// ── Writes (org admin; the contracts in src/api/ai.ts enforce it) ───────────

/**
 * Saves a provider and tests it: the key (when sent) to the secrets store, the
 * row as not connected, then a real call — `verified_at` is set only on a pass.
 * `test` is src/ai/analyze.ts testProvider, passed in to keep this module free
 * of the model adapters. Returns the test's result.
 */
export async function connect(
  provider: string,
  input: { apiKey?: string; baseUrl?: string; model?: string },
  test: (provider: string, model: string) => Promise<{ ok: boolean }>,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const why = aiKeys.keyStoreUnavailable();
  if (why) return { ok: false, error: why };
  const before = await credentials(provider);
  if (provider !== 'gateway' && !input.apiKey && !before.apiKey) return { ok: false, error: msg.aiNeedsKey() };
  if (provider === 'gateway' && !(input.baseUrl || (before.saved && before.baseUrl))) return { ok: false, error: msg.aiNeedsBaseUrl() };
  const model = await testModel(provider, input.model);
  if (!model) return { ok: false, error: msg.aiNeedsGatewayModel() };
  if (input.apiKey) await aiKeys.putKey(provider, input.apiKey);
  await asOrg((c, org) => c.query(
    `INSERT INTO org_ai_providers (org_id, provider, base_url, verified_at, updated_at) VALUES ($1, $2, $3, NULL, now())
     ON CONFLICT (org_id, provider) DO UPDATE SET base_url = coalesce($4, org_ai_providers.base_url), verified_at = NULL, updated_at = now()`,
    [org, provider, input.baseUrl ?? '', input.baseUrl ?? null]));
  const r = await test(provider, model);
  if (r.ok) {
    await asOrg((c, org) => c.query('UPDATE org_ai_providers SET verified_at = now() WHERE org_id = $1 AND provider = $2', [org, provider]));
  }
  return r;
}

/** Removes the key and the provider; its models and every pick of them go with it (cascade). */
export async function disconnect(provider: string): Promise<{ ok: true }> {
  await aiKeys.deleteKey(provider);
  await asOrg((c, org) => c.query('DELETE FROM org_ai_providers WHERE org_id = $1 AND provider = $2', [org, provider]));
  return { ok: true };
}

/**
 * Replaces the models members may use, in one transaction. Every provider must
 * be connected, no model twice, and `defaultIndex` names one of them (an empty
 * list has none). A kept model keeps its members' picks; a removed one's picks
 * go (cascade), so those members get the default.
 */
export async function setModels(
  models: readonly { provider: string; model: string; label: string }[],
  defaultIndex: number,
): Promise<{ ok: true } | Fail> {
  if (models.length && !(defaultIndex >= 0 && defaultIndex < models.length)) return { ok: false, error: msg.aiNeedsOneDefault() };
  if (new Set(models.map((m) => `${m.provider}\n${m.model}`)).size !== models.length) return { ok: false, error: msg.aiModelListedTwice() };
  return asOrg(async (c, org) => {
    const connected = new Set((await c.query<{ provider: string }>(
      'SELECT provider FROM org_ai_providers WHERE org_id = $1 AND verified_at IS NOT NULL', [org])).rows.map((r) => r.provider));
    const off = models.find((m) => !connected.has(m.provider));
    if (off) return { ok: false, error: msg.aiProviderNotConnected(off.provider) };
    await c.query(
      `DELETE FROM org_ai_models WHERE org_id = $1
         AND (provider, model) NOT IN (SELECT p, m FROM unnest($2::text[], $3::text[]) AS keep (p, m))`,
      [org, models.map((m) => m.provider), models.map((m) => m.model)]);
    await c.query('UPDATE org_ai_models SET is_default = false WHERE org_id = $1 AND is_default', [org]);
    for (const [i, m] of models.entries()) {
      await c.query(
        `INSERT INTO org_ai_models (org_id, provider, model, label, position, is_default) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, provider, model) DO UPDATE SET label = $4, position = $5, is_default = $6`,
        [org, m.provider, m.model, m.label || m.model, i, i === defaultIndex]);
    }
    return { ok: true } as const;
  });
}

/** The caller's own pick — refused unless the model is one they may use. */
export async function setMine(provider: string, model: string): Promise<{ ok: true } | Fail> {
  return asOrg(async (c, org) => {
    const view = await member(c, org);
    if (!view.models.some((m) => m.provider === provider && m.model === model)) return { ok: false, error: msg.aiModelNotEnabled() };
    await c.query(
      `INSERT INTO user_ai_model (org_id, user_email, provider, model) VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, user_email) DO UPDATE SET provider = $3, model = $4`,
      [org, ctx().user.email, provider, model]);
    return { ok: true } as const;
  });
}
