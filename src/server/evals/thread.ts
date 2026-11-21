// The throwaway conversation one case asks in (docs/eval-suites/00-design.md, "Hidden conversation"): a thread row with `hidden` set
// (0045), so it is in no History list and never "the caller's latest"; deleted when the case ends, and by the sweep if a crash left it.
// Rows only: without a database there are no suites.

import * as copilot from '../../ai/copilot';
import * as rows from '../../ai/copilotRows';
import * as projects from '../../app/projects';

/** A new hidden conversation of the caller's, with `agentId`'s (null: the Project assistant). Null when there is none to make. */
export async function createHidden(projectId: string, agentId: string | null): Promise<string | null> {
  if (!rows.on() || !copilot.isValidId(projectId) || !(await projects.getProject(projectId))) return null;
  return (await rows.createThread(projectId, new Date().toISOString(), copilot.isValidId(agentId) ? agentId : undefined, true)).id;
}
export const dropHidden = (projectId: string, threadId: string): Promise<boolean> => copilot.deleteThread(projectId, threadId);
