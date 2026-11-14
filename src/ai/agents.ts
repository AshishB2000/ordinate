// Assistant agents (docs/assistant-agents/00-design.md) — the record. MAIN PROCESS ONLY. One JSON file per agent under
// projects/<projectId>/agents/<id>.json, beside `topics/`.
//
// An agent is the same Assistant with a saved bundle of settings: an optional topic (none = all data), its own
// instructions (after the project's, and winning where they disagree), an optional model, whether it may build, and
// the teams that use it. It only ever NARROWS what a person can read; it never grants (rule 3). The Project assistant
// is not one of these records: it is the absence of one (`agentId` null everywhere).
//
// The store mirrors ../analysis/topics.ts: ids UUID-checked before they reach a path, one atomic write, the record
// lock and the edit-conflict tag (`agent:save` writes the settings; its instructions change one at a time through
// `changeAgentInstructions`, under the same lock, by the rules of ../app/instructions.ts), a sanitizer that re-reads a
// stored record into its one shape and a corrupt file skipped, never fatal. Deleting is the Trash's (kind `agent`).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as projects from '../app/projects';
import * as recordFs from '../app/recordFs';
import { isValidId, projectDir, RECORD_DIR } from '../app/recordKinds';
import { lockedUpdate, readTagged, type Tagged } from '../app/editConflict';
import { osUser } from '../app/catalog';
import { logger } from '../app/logger';
import { applyInstructionOp, sanitizeInstructions, type Instruction, type InstructionOp } from '../app/instructions';
import { AI_PROVIDERS } from '../api/admin';
import { agentTooManyInstructions } from './agentMessages';

export const MAX_AGENTS = 50; // as ../analysis/topics.ts MAX_TOPICS
export const MAX_AGENT_TEAMS = 50;
export const MAX_AGENT_NAME = 80;
export const MAX_AGENT_DESCRIPTION = 500;
const MAX_MODEL = 200;
const MAX_BY = 200;
/** What nobody may call an agent: the one that is always there. */
export const PROJECT_ASSISTANT = 'Project assistant';

export interface AgentModel {
  provider: string;
  model: string;
}

export interface Agent {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  /** None: all data, with the agent's own instructions (rule 6). */
  topicId: string | null;
  instructions: Instruction[];
  /** None: each person's own pick (rule 7). */
  model: AgentModel | null;
  /** May it offer the Assistant's plans and other builds (rule 8)? Answering is always on. */
  build: boolean;
  teamIds: string[];
  /** Its place in the list: the preselection's "first agent given to one of their teams". */
  order: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  schemaVersion: 1;
}

/** What `agent:save` writes. The instructions are not among it: they change one at a time. */
export interface AgentInput {
  name: string;
  description?: unknown;
  topicId?: unknown;
  model?: unknown;
  build?: unknown;
  teamIds?: unknown;
}

const dirOf = (projectId: string): string => path.join(projectDir(projectId), RECORD_DIR.agent);
const fileOf = (projectId: string, id: string): string => path.join(dirOf(projectId), id + '.json');

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

const trimTo = (raw: unknown, max: number): string => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const str = (raw: unknown, max: number): string => (typeof raw === 'string' ? raw.slice(0, max) : '');

function sanitizeModel(raw: unknown): AgentModel | null {
  const m = raw as { provider?: unknown; model?: unknown } | null;
  if (!m || typeof m !== 'object') return null;
  const model = trimTo(m.model, MAX_MODEL);
  return (AI_PROVIDERS as readonly unknown[]).includes(m.provider) && model ? { provider: String(m.provider), model } : null;
}

/** A stored or typed agent in its one shape. Idempotent: sanitizing twice is sanitizing once. */
// any: parsed stored JSON
export function sanitizeAgent(data: any, projectId: string): Agent {
  const a: Agent = {
    id: String(data.id),
    projectId,
    name: trimTo(data.name, MAX_AGENT_NAME) || 'Untitled assistant',
    topicId: isValidId(data.topicId) ? data.topicId : null,
    instructions: sanitizeInstructions(data.instructions),
    model: sanitizeModel(data.model),
    build: data.build === true,
    teamIds: [...new Set((Array.isArray(data.teamIds) ? data.teamIds : []).filter(isValidId).map((t: string) => t.toLowerCase()))].slice(0, MAX_AGENT_TEAMS) as string[],
    order: Number.isInteger(data.order) && data.order >= 0 && data.order <= 1_000_000 ? data.order : 0,
    createdBy: str(data.createdBy, MAX_BY),
    createdAt: str(data.createdAt, 40),
    updatedBy: str(data.updatedBy, MAX_BY),
    updatedAt: str(data.updatedAt, 40),
    schemaVersion: 1,
  };
  const description = trimTo(data.description, MAX_AGENT_DESCRIPTION);
  if (description) a.description = description;
  return a;
}

// any: parsed stored JSON
const isAgent = (data: any): boolean => !!data && typeof data === 'object' && !Array.isArray(data) && isValidId(data.id);

/** Every agent of the project, in list order (then by name). A corrupt or unreadable file is skipped and logged. */
export async function listAgents(projectId: string): Promise<Agent[]> {
  if (!isValidId(projectId)) return [];
  let names: string[];
  try {
    names = await recordFs.readdir(dirOf(projectId));
  } catch (_) {
    return []; // no agents yet
  }
  const out: Agent[] = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    if (!isValidId(id)) continue; // a stray or temp file
    try {
      const data = JSON.parse(await recordFs.readFile(fileOf(projectId, id), 'utf8'));
      if (isAgent(data) && String(data.id).toLowerCase() === id.toLowerCase()) out.push(sanitizeAgent(data, projectId));
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') logger.error('[agents] Skipping corrupt or unreadable agent:', id, (err as Error).message);
    }
  }
  return out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
}

/** The record and the tag of what is stored, from ONE read (../app/editConflict). */
export async function readAgent(projectId: string, id: string): Promise<Tagged<Agent> | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  return readTagged('agent', fileOf(projectId, id), (d) => (isAgent(d) ? sanitizeAgent(d, projectId) : null));
}

/** Create an agent at the end of the list (check `agentProblem` first). Null when the project is missing. */
export async function saveAgent(projectId: string, input: AgentInput): Promise<Agent | null> {
  if (!isValidId(projectId) || !(await projects.getProject(projectId))) return null;
  const last = (await listAgents(projectId)).reduce((m, a) => Math.max(m, a.order + 1), 0);
  const now = new Date().toISOString();
  const by = osUser();
  const agent = sanitizeAgent({ ...input, id: randomUUID(), instructions: [], order: last, createdBy: by, createdAt: now, updatedBy: by, updatedAt: now }, projectId);
  await fs.promises.mkdir(dirOf(projectId), { recursive: true });
  await writeJsonAtomic(fileOf(projectId, agent.id), agent);
  return agent;
}

/** Replace an agent's settings, holding it while it reads and writes; a stale `base` refuses (409 record_changed). */
export async function updateAgent(projectId: string, id: string, input: AgentInput, base?: unknown): Promise<Agent | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const file = fileOf(projectId, id);
  return lockedUpdate('agent', { projectId, id, file }, base, () => readAgent(projectId, id), async (cur) => {
    const next = sanitizeAgent({ ...input, id, instructions: cur.instructions, order: cur.order, createdBy: cur.createdBy, createdAt: cur.createdAt, updatedBy: osUser(), updatedAt: new Date().toISOString() }, projectId);
    await writeJsonAtomic(file, next);
    return next;
  });
}

/** ONE change to the agent's instructions, read fresh under its lock; null when the agent is gone. THROWS the sentence. */
export async function changeAgentInstructions(projectId: string, id: string, op: InstructionOp): Promise<Agent | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  const file = fileOf(projectId, id);
  return lockedUpdate('agent', { projectId, id, file }, undefined, () => readAgent(projectId, id), async (cur) => {
    const next: Agent = { ...cur, instructions: applyInstructionOp(cur.instructions, op, agentTooManyInstructions) };
    await writeJsonAtomic(file, next);
    return next;
  });
}
