// What happens to documents when what they belong to goes (docs/knowledge-docs/00-design.md, "Lifecycle"). MAIN PROCESS.
//   an agent trashed       nothing here: its documents stay (a restore brings them back), but nothing uses or lists them
//   an agent purged        `forgetAgents`: its documents and passages are deleted (src/app/trash.ts purge / empty / purgeExpired)
//   a project deleted      `forgetProject`: all of its documents (src/app/projects.ts deleteProject)
//   the per-org sweep      `sweep`: the backstop for a purge or delete that died between the file and the rows
// None of them throws: a failure is logged (a code, never text) and the sweep retries.

import { inOrg, orgDb } from '../server/db/inOrg';
import { logger } from '../app/logger';
import { isValidId } from '../app/ids';

const note = (what: string, err: unknown): void => logger.error(`[knowledge] ${what} failed:`, (err as { code?: string })?.code ?? 'error');

/** An agent is gone for good: its documents, and their passages (ON DELETE CASCADE). */
export async function forgetAgents(projectId: string, agentIds: readonly string[]): Promise<void> {
  const ids = agentIds.filter(isValidId);
  if (!orgDb() || !ids.length || !isValidId(projectId)) return;
  try {
    await inOrg((c, org) => c.query('DELETE FROM knowledge_docs WHERE org_id = $1 AND project_id = $2 AND agent_id = ANY($3::uuid[])', [org, projectId, ids]));
  } catch (err) {
    note('forgetting an agent\'s documents', err);
  }
}

/** A project is deleted: every document of it. */
export async function forgetProject(projectId: string): Promise<void> {
  if (!orgDb() || !isValidId(projectId)) return;
  try {
    await inOrg((c, org) => c.query('DELETE FROM knowledge_docs WHERE org_id = $1 AND project_id = $2', [org, projectId]));
  } catch (err) {
    note('forgetting a project\'s documents', err);
  }
}

/** What exists: a project, and an agent of it (live or in the Trash, where a restore can bring it back). */
export interface Exists {
  project(projectId: string): Promise<boolean>;
  agent(projectId: string, agentId: string): Promise<boolean>;
}

/** What the last pass found missing, by org, project and agent: a record read that failed would look the same, and a document is not deleted on one look. */
const suspects = new Set<string>();

/**
 * One pass for the org: documents whose project is gone, and documents whose agent is neither live nor in the Trash.
 * The records are read through stores that answer "not there" for a read that failed too, so a pair is deleted only when
 * TWO passes in a row (five minutes apart) found it missing. Returns how many documents it deleted (passages go with them).
 */
export async function sweep(exists: Exists, org: string): Promise<number> {
  if (!orgDb()) return 0;
  const pairs = await inOrg(async (c, o) => (await c.query<{ projectId: string; agentId: string | null }>(
    'SELECT DISTINCT project_id::text AS "projectId", agent_id::text AS "agentId" FROM knowledge_docs WHERE org_id = $1', [o])).rows);
  const projectOk = new Map<string, boolean>();
  let removed = 0;
  for (const { projectId, agentId } of pairs) {
    const key = `${org}|${projectId}|${agentId ?? ''}`;
    if (!projectOk.has(projectId)) projectOk.set(projectId, await exists.project(projectId));
    const alive = projectOk.get(projectId) === true && (agentId === null || (await exists.agent(projectId, agentId)));
    if (alive) {
      suspects.delete(key);
      continue;
    }
    if (!suspects.has(key)) {
      suspects.add(key);
      continue;
    }
    suspects.delete(key);
    removed += await inOrg(async (c, o) => (await c.query('DELETE FROM knowledge_docs WHERE org_id = $1 AND project_id = $2 AND agent_id IS NOT DISTINCT FROM $3::uuid', [o, projectId, agentId])).rowCount ?? 0);
  }
  return removed;
}

/** The real `Exists`: the project's record and the agent's file, else its Trash entry. */
export function realExists(): Exists {
  return {
    project: async (id) => !!(await (require('../app/projects') as typeof import('../app/projects')).getProject(id)),
    agent: async (projectId, id) => !!(await (require('../ai/agents') as typeof import('../ai/agents')).readAgent(projectId, id))
      || !!(await (require('../app/trashStore') as typeof import('../app/trashStore')).readEntry(projectId, 'agent', id)),
  };
}
