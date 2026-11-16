// A shared folder in a suite's scratch Postgres, written as E7's folder channels will write it (0032): a top-level
// folder of a project, shared with a new team at `view` or `edit`, holding datasets and dashboards. For the suites that
// hold an index to its reference per caller (test-searchIndex, test-assistantSearch, test-verifiedIndex,
// test-meaningSearch, test-askNoProjectLists, test-askBudget). Not a test file itself (no `test-` prefix).

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

export interface Planted { folder: string; team: string }

/**
 * A top-level folder `name` of `projectId` holding `items`, shared at `level` with a new team of `members` (their users
 * made, in org `org`, as a sign-in would). With no members, only admins open it.
 */
export async function plantFolder(pool: Pool, projectId: string, o: { name: string; members?: readonly string[]; level?: 'view' | 'edit'; items: ReadonlyArray<['dataset' | 'dashboard', string]>; org?: string }): Promise<Planted> {
  const org = o.org ?? 'acme';
  await pool.query('INSERT INTO orgs (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [org]);
  const team = (await pool.query<{ id: string }>('INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id::text', [org, `${o.name} team ${randomUUID().slice(0, 8)}`])).rows[0].id;
  for (const email of o.members ?? []) {
    const u = (await pool.query<{ id: string }>(
      'INSERT INTO users (org_id, email) VALUES ($1, $2) ON CONFLICT (org_id, email) DO UPDATE SET email = EXCLUDED.email RETURNING id::text', [org, email])).rows[0].id;
    await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [team, u]);
  }
  const folder = randomUUID();
  await pool.query('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $5)', [org, projectId, folder, o.name, 'fixture@acme.test']);
  await pool.query('INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, $5)', [org, projectId, folder, team, o.level ?? 'view']);
  for (const [kind, id] of o.items) {
    await pool.query('INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, $3, $4, $5, $6)', [org, projectId, kind, id.toLowerCase(), folder, 'fixture@acme.test']);
  }
  return { folder, team };
}

/** Every folder of `projectId` gone, its placements first: the project is bare again (everything in Everyone). */
export async function clearFolders(pool: Pool, projectId: string, org = 'acme'): Promise<void> {
  await pool.query('DELETE FROM folder_items WHERE org_id = $1 AND project_id = $2', [org, projectId]);
  await pool.query('DELETE FROM folders WHERE org_id = $1 AND project_id = $2', [org, projectId]);
}
