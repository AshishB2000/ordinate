// Telling the org's admins (docs/autopilot/00-design.md, phase 4): a push to their tabs (ids, names and counts: never a chart) and, for
// those who turned on the existing "Email me" switch, an email with the counts and a link. The report page is the durable record, so
// neither ever stands in a run's way: a failure is a log line.

import { getProject } from '../../app/projects';
import { logger } from '../../app/logger';
import { ctx } from '../context';
import { orgDb } from '../db/inOrg';
import * as say from '../autopilotMessages';
import { mailOne } from '../requests/tell';
import { publish } from '../sse';

export interface Notice {
  projectId: string;
  runId: string;
  state: 'done' | 'paused';
  counts: Record<string, number>;
}

export const reportPath = (projectId: string, runId: string): string => `/autopilot/${projectId}/${runId}`;

/** Every enabled org admin. */
async function admins(): Promise<string[]> {
  const db = orgDb();
  if (!db) return [];
  return (await db.query<{ email: string }>(`SELECT email FROM users WHERE org_id = $1 AND role = 'admin' AND disabled_at IS NULL ORDER BY email`, [ctx().org.id])).rows.map((r) => r.email);
}

/** Tell the admins (`except`: who is not told, when the run was theirs and they asked for it). Never throws. */
export async function tellAdmins(n: Notice, o: { except?: string; who?: string } = {}): Promise<void> {
  try {
    const project = (await getProject(n.projectId))?.name ?? '';
    const to = (await admins()).filter((e) => e !== o.except);
    const c = (k: string): number => n.counts[k] ?? 0;
    const nothing = n.state === 'done' && c('trashed') + c('repaired') + c('broken') + c('slow') + c('wouldTrash') === 0;
    if (nothing) return; // an empty week is not news
    for (const email of to) publish({ org: ctx().org.id, user: email }, 'autopilot:report', { projectId: n.projectId, runId: n.runId, state: n.state, on: project, counts: n.counts });
    const paused = n.state === 'paused';
    const lines = paused ? [] : [say.movedToTrash(String(c('trashed'))), say.repaired(String(c('repaired'))), say.broken(String(c('broken'))), say.slow(String(c('slow')))];
    for (const email of to) {
      await mailOne(o.who ?? 'autopilot', email, n.projectId, {
        title: paused ? say.pausedTitle(project) : say.reportTitle(project), subtitle: lines, note: paused ? say.pausedNote(o.who ?? '') : '', noteBy: '', path: reportPath(n.projectId, n.runId),
      }).catch((err: unknown) => logger.warn('[autopilot] email failed:', err instanceof Error ? err.message : String(err)));
    }
  } catch (err) {
    logger.warn('[autopilot] notices failed:', err instanceof Error ? err.message : String(err));
  }
}
