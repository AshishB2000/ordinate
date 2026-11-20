// What happens to documents when what they belong to goes (docs/knowledge-docs/00-design.md, "Lifecycle"). MAIN PROCESS.
//   an agent trashed       nothing here: its documents stay (a restore brings them back), but nothing uses or lists them
//   an agent purged        `forgetAgents`: its documents and passages are deleted (src/app/trash.ts purge / empty / purgeExpired)
//   a project deleted      `forgetProject`: all of its documents (src/app/projects.ts deleteProject)
//   the per-org sweep      `sweep`: the backstop for a purge or delete that died between the file and the rows (a day's grace)
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

/** What a lookup found: `unknown` is any read error or record that does not parse, which never counts as missing. */
export type Found = 'found' | 'missing' | 'unknown';
export interface Exists {
  project(projectId: string): Promise<Found>;
  agent(projectId: string, agentId: string): Promise<Found>;
}

/** A document is deleted this long after its owner was first found missing (and has not been found since). */
export const MISSING_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * One pass for the org, for documents whose project is gone or whose agent is neither live nor in the Trash. The state is a
 * column (`missing_since`), so any pod's pass sees it: a pair DEFINITELY missing is stamped, a pair found again is cleared,
 * a pair whose lookup failed or read as corrupt is left as it is, and only a pair stamped more than a day ago is deleted.
 * Returns how many documents it deleted (their passages go with them). `now`: the clock, injectable.
 */
export async function sweep(exists: Exists, now: number = Date.now()): Promise<number> {
  if (!orgDb()) return 0;
  const pairs = await inOrg(async (c, o) => (await c.query<{ projectId: string; agentId: string | null }>(
    'SELECT DISTINCT project_id::text AS "projectId", agent_id::text AS "agentId" FROM knowledge_docs WHERE org_id = $1', [o])).rows);
  const projects = new Map<string, Found>();
  const at = new Date(now);
  let removed = 0;
  for (const { projectId, agentId } of pairs) {
    if (!projects.has(projectId)) projects.set(projectId, await exists.project(projectId).catch((): Found => 'unknown'));
    const project = projects.get(projectId) as Found;
    const found: Found = project !== 'found' ? project : agentId === null ? 'found' : await exists.agent(projectId, agentId).catch((): Found => 'unknown');
    const where = 'org_id = $1 AND project_id = $2 AND agent_id IS NOT DISTINCT FROM $3::uuid';
    if (found === 'unknown') continue;
    if (found === 'found') {
      await inOrg((c, o) => c.query(`UPDATE knowledge_docs SET missing_since = NULL WHERE ${where} AND missing_since IS NOT NULL`, [o, projectId, agentId]));
      continue;
    }
    await inOrg((c, o) => c.query(`UPDATE knowledge_docs SET missing_since = $4 WHERE ${where} AND missing_since IS NULL`, [o, projectId, agentId, at]));
    removed += await inOrg(async (c, o) => (await c.query(`DELETE FROM knowledge_docs WHERE ${where} AND missing_since < $4`, [o, projectId, agentId, new Date(now - MISSING_GRACE_MS)])).rowCount ?? 0);
  }
  return removed;
}

/** `readRecord` of a record: found, definitely absent (ENOENT), or unknown (any other error, or text that is not a JSON object). */
async function lookup(file: string): Promise<Found> {
  if (!file) return 'unknown';
  try {
    const data: unknown = JSON.parse(String(await (require('../app/recordFs') as typeof import('../app/recordFs')).readFile(file, 'utf8')));
    return data && typeof data === 'object' ? 'found' : 'unknown';
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT' ? 'missing' : 'unknown';
  }
}

/** The real `Exists`: the project's record and the agent's file, else its Trash entry. A corrupt record is unknown, never missing. */
export function realExists(): Exists {
  const path = require('path') as typeof import('path');
  return {
    project: (id) => lookup(path.join((require('../app/recordKinds') as typeof import('../app/recordKinds')).projectDir(id), 'project.json')),
    agent: async (projectId, id) => {
      const kinds = require('../app/recordKinds') as typeof import('../app/recordKinds');
      const live = await lookup(path.join(kinds.projectDir(projectId), kinds.RECORD_DIR.agent, `${id}.json`));
      if (live !== 'missing') return live;
      return lookup((require('../app/trashStore') as typeof import('../app/trashStore')).entryPath(projectId, 'agent', id)); // trashed: a restore brings it back
    },
  };
}
