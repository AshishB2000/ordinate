import * as appPaths from '../app/paths';
import { serverDataDir } from '../server/context';
import * as path from 'path';
import * as config from '../app/config';
import * as jobs from '../app/jobs';
import * as backups from '../app/backups';
import * as projects from '../app/projects';
import { captureProjectId } from '../app/captureRecord';

// The safety copy taken before an import or a version restore. The work itself
// is src/app/backups.ts. On the server backups are the operator's (Postgres and
// the volume or bucket — plan §8), so this is a no-op there; the scheduled
// backups, the folder picker and "Restore from backup…" were the desktop app's
// Settings → General → Backups and went with it (T8.1).

export function backupRoot(): string {
  return config.get().backups.folder || path.join(appPaths.userData(), 'backups');
}

/**
 * A one-off copy of a project taken just before something replaces its work —
 * a bundle import (the ACTIVE project) or a version restore (the project being
 * restored into). Awaited by the caller, but never blocks it: a copy that could
 * not be written shows as a failed job, and the operation the user asked for
 * still happens.
 */
export async function safetyBackup(reason: 'before-import' | 'before-restore', projectId?: string): Promise<void> {
  // Server: there is no "active project", and a zip under the org's userData
  // nobody can reach would only cost disk.
  if (serverDataDir() !== null) return;
  try {
    const id = projectId || (await captureProjectId());
    const project = id ? await projects.getProject(id) : null;
    if (!project) return;
    const job = jobs.submit({
      kind: 'backup',
      label: `Safety copy of ${project.name}`,
      projectId: project.id,
      run: (ctx) => backups.backupProject(backupRoot(), project.id, reason, new Date(), {
        onProgress: (p, note) => ctx.progress(p, note),
      }),
      resultOf: (r) => (r ? { path: r.file, message: reason === 'before-import' ? 'Taken before an import' : 'Taken before a version restore' } : undefined),
    });
    await job.done;
  } catch (err: any) {
    console.warn('[backups] safety copy failed:', err?.message || err);
  }
}
