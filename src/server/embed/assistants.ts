// Which agents may be embedded and on which datasets (0049 `embed_agents`), and the caps (`embed_assistant_limits`).
// Read before any request context exists (the route), so every statement runs `inOrg(pool, org, …)` (forced RLS).
// A marking is a claim: src/server/embed/asker.ts checks each dataset's current record again on every ask.

import type { Pool } from 'pg';
import { inOrg } from '../db/orgTx';
import { embedPool } from './settings';
import { isValidId } from '../../app/ids';

export const DEFAULT_DAILY_CAP = 1000;
export const DEFAULT_PER_MINUTE_CAP = 10;
export const MAX_EMBED_DATASETS = 12;

/** `writers`: the hash of the steps that write `column`, pinned at marking (rowAccess.pinWriters). Without one the dataset refuses. */
export interface EmbedDataset { readonly id: string; readonly column: string; readonly writers?: string }
export interface EmbedAgent { readonly agentId: string; readonly projectId: string; readonly datasets: readonly EmbedDataset[] }
export interface Caps { readonly daily: number; readonly perMinute: number }

const pool = (): Pool => {
  const p = embedPool();
  if (!p) throw new Error('no database');
  return p;
};

/** `datasets` as stored, each entry checked: a malformed one is dropped, never trusted. */
export function sanitizeDatasets(raw: unknown): EmbedDataset[] {
  const out: EmbedDataset[] = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    const e = d as { id?: unknown; column?: unknown; writers?: unknown } | null;
    if (!e || !isValidId(e.id) || typeof e.column !== 'string' || !e.column || e.column.length > 256) continue;
    const id = String(e.id).toLowerCase();
    if (!out.some((x) => x.id === id)) out.push({ id, column: e.column, ...(typeof e.writers === 'string' && e.writers ? { writers: e.writers } : {}) });
  }
  return out.slice(0, MAX_EMBED_DATASETS);
}

/** The agent's marking, or null when it is not marked (or switched off). */
export async function getEmbedAgent(org: string, agentId: string): Promise<EmbedAgent | null> {
  const r = await inOrg(pool(), org, (c) =>
    c.query<{ agent_id: string; project_id: string; datasets: unknown; enabled: boolean }>('SELECT agent_id::text, project_id::text, datasets, enabled FROM embed_agents WHERE org_id = $1 AND agent_id = $2', [org, agentId]));
  const row = r.rows[0];
  if (!row || !row.enabled) return null;
  const datasets = sanitizeDatasets(row.datasets);
  return datasets.length ? { agentId: row.agent_id, projectId: row.project_id, datasets } : null;
}

/** Marks (or re-marks) an agent. The caller (phase 4's admin contract) has checked each dataset. */
export async function setEmbedAgent(org: string, by: string, a: { agentId: string; projectId: string; datasets: readonly EmbedDataset[]; enabled?: boolean }): Promise<void> {
  await inOrg(pool(), org, (c) =>
    c.query(
      `INSERT INTO embed_agents (org_id, agent_id, project_id, datasets, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
       ON CONFLICT (org_id, agent_id) DO UPDATE SET project_id = $3, datasets = $4::jsonb, enabled = $5, updated_by = $6, updated_at = now()`,
      [org, a.agentId, a.projectId, JSON.stringify(sanitizeDatasets(a.datasets)), a.enabled !== false, by],
    ));
}

export async function getCaps(org: string): Promise<Caps> {
  const r = await inOrg(pool(), org, (c) => c.query<{ daily_cap: number; per_minute_cap: number }>('SELECT daily_cap, per_minute_cap FROM embed_assistant_limits WHERE org_id = $1', [org]));
  const row = r.rows[0];
  return row ? { daily: row.daily_cap, perMinute: row.per_minute_cap } : { daily: DEFAULT_DAILY_CAP, perMinute: DEFAULT_PER_MINUTE_CAP };
}

export type AskOutcome = 'ok' | 'denied' | 'limited' | 'refused' | 'error';

/** One audit row: the customer's id, the agent and the outcome. Never a question, an answer or a filter value. */
export async function recordAsk(org: string, row: { id: string; agentId: string | null; customer: string; outcome: AskOutcome }): Promise<void> {
  await inOrg(pool(), org, (c) =>
    c.query('INSERT INTO embed_asks (org_id, id, agent_id, customer, outcome) VALUES ($1, $2, $3, $4, $5)', [org, row.id, row.agentId, row.customer.slice(0, 200), row.outcome]));
}

export interface EmbedAgentRow extends EmbedAgent { readonly enabled: boolean }

/** Every marked agent of the org, in project then agent order (the Admin screen's list). */
export async function listEmbedAgents(org: string): Promise<EmbedAgentRow[]> {
  const r = await inOrg(pool(), org, (c) =>
    c.query<{ agent_id: string; project_id: string; datasets: unknown; enabled: boolean }>('SELECT agent_id::text, project_id::text, datasets, enabled FROM embed_agents WHERE org_id = $1 ORDER BY project_id, agent_id', [org]));
  return r.rows.map((row) => ({ agentId: row.agent_id, projectId: row.project_id, datasets: sanitizeDatasets(row.datasets), enabled: row.enabled }));
}

/** Stops embedding one agent: its marking is deleted, and every token for it is refused from the next ask on. */
export async function removeEmbedAgent(org: string, agentId: string): Promise<boolean> {
  const r = await inOrg(pool(), org, (c) => c.query('DELETE FROM embed_agents WHERE org_id = $1 AND agent_id = $2', [org, agentId]));
  return (r.rowCount ?? 0) > 0;
}

export const MAX_DAILY_CAP = 1_000_000;
export const MAX_PER_MINUTE_CAP = 600;

/** Saves the caps (Q4). The caller has checked the ranges (they are the table's CHECKs too). */
export async function setCaps(org: string, caps: Caps): Promise<void> {
  await inOrg(pool(), org, (c) =>
    c.query(
      `INSERT INTO embed_assistant_limits (org_id, daily_cap, per_minute_cap, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (org_id) DO UPDATE SET daily_cap = $2, per_minute_cap = $3, updated_at = now()`,
      [org, caps.daily, caps.perMinute],
    ));
}

/** The org's last `days` of asks, by outcome: what the Admin screen shows beside the caps. Counts only. */
export async function askCounts(org: string): Promise<{ today: number; limited: number }> {
  const r = await inOrg(pool(), org, (c) =>
    c.query<{ today: number; limited: number }>(
      `SELECT count(*) FILTER (WHERE outcome = 'ok')::int AS today, count(*) FILTER (WHERE outcome = 'limited')::int AS limited
         FROM embed_asks WHERE org_id = $1 AND at > now() - interval '24 hours'`,
      [org],
    ));
  return r.rows[0] ?? { today: 0, limited: 0 };
}
