// Telling people about metric proposals (./proposals.ts): the bell rows are the gate and are written by the store; the
// push (`proposals:changed`: ids, names of people and project, the state, never the definition) never stands in the
// reply's way. A failure is a log line. No email in this version.

import { logger } from '../../app/logger';
import { personName } from '../../app/mentionToken';
import { getProject } from '../../app/projects';
import { ctx } from '../context';
import { publish } from '../sse';
import type { Proposal } from './store';

export interface ProposalNotice {
  projectId: string;
  id: string;
  by: string;
  on: string;
  state: 'open' | 'approved' | 'declined';
}

const inFlight = new Set<Promise<void>>();

/** Test hook: until every notice started so far has ended. */
export async function proposalsSettled(): Promise<void> {
  while (inFlight.size) await Promise.all(inFlight);
}

export function background(p: Promise<void>): void {
  const q = p.catch((err: unknown) => logger.warn('[proposals] notices failed:', err instanceof Error ? err.message : String(err)));
  inFlight.add(q);
  void q.finally(() => inFlight.delete(q));
}

function push(email: string, notice: ProposalNotice): void {
  try {
    publish({ org: ctx().org.id, user: email }, 'proposals:changed', notice);
  } catch (err) {
    logger.warn('[proposals] push failed:', err instanceof Error ? err.message : String(err));
  }
}

const projectName = async (projectId: string): Promise<string> => (await getProject(projectId).catch(() => null))?.name ?? '';

/** A new card: each approver's tabs. */
export async function tellApprovers(p: Proposal, to: string[], by: string): Promise<void> {
  const on = await projectName(p.projectId);
  for (const email of to) push(email, { projectId: p.projectId, id: p.id, by: personName(by), on, state: 'open' });
}

/** Decided: each asker's tabs. */
export async function tellAskers(p: Proposal, to: string[]): Promise<void> {
  const on = await projectName(p.projectId);
  const by = personName(ctx().user.email);
  for (const email of to) push(email, { projectId: p.projectId, id: p.id, by, on, state: p.state === 'approved' ? 'approved' : 'declined' });
}
