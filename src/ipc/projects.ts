import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ipcMain } from './bus';
import * as appPaths from '../app/paths';
import { serverDataDir } from '../server/context';
import { FileTokenError, offerDownload, resolveUpload, type Upload } from '../server/files';
import * as projects from '../app/projects';
import * as bundle from '../app/bundle';
import * as jobs from '../app/jobs';
import * as sharePolicy from '../app/sharePolicy';
import * as config from '../app/config';
import { projectDir } from '../app/recordKinds';
import { safetyBackup } from './backups';
import * as recordFs from '../app/recordFs';

// Projects (workspace shell) IPC — list/create/rename/archive/open, the
// switcher's overview, and the .ordinate bundle's export and import.
//
// `onActive` is told which project was opened or created — the only two ways
// a project becomes the active one.
//
// Export and import are the T0.4 file flows, and the path never comes from a
// client: an export answers with a download token, an import takes an upload's
// file token.
export function register({ onActive }: { onActive?: (id: string) => void } = {}) {
  const active = (id: unknown): void => {
    if (typeof onActive === 'function' && typeof id === 'string' && id) onActive(id);
  };

  ipcMain.handle('projects:list', async () => projects.listProjects());

  // ponytail: untrusted renderer payloads — any.
  ipcMain.handle('projects:create', async (_e, { name }: any) => {
    const created = await projects.createProject(name);
    if (created) {
      active(created.id);
      await projects.touchOpened(created.id);
    }
    return created;
  });

  ipcMain.handle('projects:rename', async (_e, { id, name }: any) => projects.renameProject(id, name));

  ipcMain.handle('projects:delete', async (_e, { id }: any) => {
    // Its connections' stored passwords/tokens go with it (T6.3): they are keyed
    // by connection id, not by project, so they would otherwise outlive it.
    const conns = await (require('../connectors/connections') as typeof import('../connectors/connections')).listConnections(id).catch(() => []);
    const ok = await projects.deleteProject(id);
    if (ok) for (const c of conns) await (require('../app/configSecrets') as typeof import('../app/configSecrets')).dropConnectionSecrets(c.id);
    // Server: who could open it goes with it (src/server/authz/share.ts).
    if (ok && serverDataDir() !== null) await (require('../server/authz/share') as typeof import('../server/authz/share')).dropGrants(id);
    return { ok };
  });

  ipcMain.handle('projects:archive', async (_e, { id, archived }: any) => projects.setArchived(id, archived !== false));

  // A validated project object to enter the workspace with — and the "opened"
  // stamp the switcher shows and a launch adopts by.
  ipcMain.handle('projects:open', async (_e, { id }: any) => {
    const project = await projects.getProject(id);
    if (project) {
      active(project.id);
      await projects.touchOpened(project.id);
    }
    return project;
  });

  /**
   * The switcher's rows: every project with its dataset and dashboard counts
   * and when it was last opened. Counts are directory listings — nothing is
   * parsed — so a long list of projects stays a cheap read.
   */
  ipcMain.handle('projects:overview', async () => {
    const sample = config.get().sample;
    const count = async (id: string, sub: string): Promise<number> => {
      try {
        return (await recordFs.readdir(path.join(projectDir(id), sub))).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n)).length;
      } catch (_) {
        return 0;
      }
    };
    const list = await projects.listProjects();
    return Promise.all(list.map(async (p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      lastOpenedAt: p.lastOpenedAt || null,
      archived: !!p.archivedAt,
      datasets: await count(p.id, 'datasets'),
      dashboards: await count(p.id, 'analyses'),
      // The badge lasts as long as the sample does: remove it, and this is
      // just the user's project again.
      sample: !!sample && sample.projectId === p.id
        && (await recordFs.exists(path.join(projectDir(p.id), 'datasets', sample.datasetId + '.json'))),
    })));
  });

  ipcMain.handle('projects:export', async (_e, { id }: any = {}) => {
    const project = await projects.getProject(id);
    if (!project) return { ok: false, error: 'That project is gone.' };
    const safe = project.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Project';
    // The bundle is written to the org's temp() and handed to the browser as a
    // download token (src/server/files.ts), which deletes the file once sent;
    // the path never leaves the server.
    const target = path.join(appPaths.temp(), `export-${randomUUID()}.ordinate`);
    // A job (src/app/jobs.ts): the zip is deflated off the main thread, the
    // popover shows progress, and Cancel stops it between files. The handler
    // still answers its renderer with the same envelope as before.
    const job = jobs.submit({
      kind: 'bundle',
      label: `Export ${project.name}`,
      projectId: project.id,
      run: async (ctx) => {
        const out = await bundle.exportProject(project.id, {
          onProgress: (p, note) => ctx.progress(0.95 * p, note),
          checkCancelled: () => ctx.checkCancelled(),
        });
        if (!out) throw new Error('That project is gone.');
        ctx.checkCancelled();
        // The Share policy's `bundle` action: sensitive columns masked or dropped,
        // and their datasets' raw prepare history left behind (app/sharePolicy.ts).
        const bytes = await sharePolicy.applyToBundle(project.id, out.bytes);
        const tmp = target + '.partial';
        await recordFs.writeFile(tmp, bytes);
        await recordFs.rename(tmp, target);
        return { path: target, counts: out.manifest.counts };
      },
      // A job's result reaches the tab over SSE: no path in it.
      resultOf: () => undefined,
    });
    try {
      const r = await job.done;
      return { ok: true, counts: r.counts, ...offerDownload(r.path, safe + '.ordinate') };
    } catch (err: any) {
      await fs.promises.rm(target, { force: true }).catch(() => undefined);
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err?.message || 'Export failed.' };
    }
  });

  ipcMain.handle('projects:import', async (_e, { fileToken }: any = {}) => {
    // The bundle was uploaded through POST /api/files; the token resolves to
    // the org's own temp copy, deleted once read.
    let upload: Upload;
    try {
      upload = resolveUpload(fileToken);
    } catch (err) {
      if (err instanceof FileTokenError) return { ok: false, error: 'That upload has expired. Choose the file again.' };
      throw err;
    }
    try {
      return await importBundleFile(upload.path, active);
    } finally {
      upload.done();
    }
  });
}

/**
 * Import one `.ordinate` file as a new project, as a job, and make it active.
 * The path is the server's own: an upload's temp copy.
 */
export async function importBundleFile(file: string, active: (id: unknown) => void): Promise<any> {
  await safetyBackup('before-import'); // a copy of the active project first (src/ipc/backups.ts)
  const job = jobs.submit({
    kind: 'bundle',
    label: `Import ${path.basename(file)}`,
    run: async (ctx) => {
      const res = await bundle.importBundle(await recordFs.readFile(file), {
        onProgress: (p, note) => ctx.progress(p, note),
        checkCancelled: () => ctx.checkCancelled(),
      });
      if (!res.ok) throw new Error(res.error || 'Import failed.');
      return res;
    },
    resultOf: (r) => ({ message: r.project ? `Imported as “${r.project.name}”` : undefined }),
  });
  try {
    const res = await job.done;
    if (res.project) {
      active(res.project.id);
      await projects.touchOpened(res.project.id);
    }
    return res;
  } catch (err: any) {
    if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
    return { ok: false, error: err?.message || 'Import failed.' };
  }
}
