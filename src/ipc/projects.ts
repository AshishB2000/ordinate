import * as fs from 'fs';
import * as path from 'path';
import { ipcMain, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import * as projects from '../app/projects';
import * as bundle from '../app/bundle';
import * as jobs from '../app/jobs';
import * as sharePolicy from '../app/sharePolicy';
import * as config from '../app/config';
import { projectDir } from '../app/recordKinds';
import { syncedTarget } from '../app/syncFolder';
import { safetyBackup } from './backups';

// Projects (workspace shell) IPC — list/create/rename/archive/open, the
// switcher's overview, and the .ordinate bundle's export and import.
//
// `onActive` is the ONE hook: main needs to know which project the user is in
// so a capture fired from the global hotkey (no renderer to ask — the hub may be
// closed) lands in the right project. Opening and creating are the only two ways
// a project becomes the active one, and both go through here.
//
// Export and import go through the NATIVE dialogs, and the path never comes
// from the renderer: a renderer that could name a path to write a bundle to, or
// to read one from, could name any path.
export function register({ onActive, getHubWindow }: {
  onActive?: (id: string) => void;
  getHubWindow?: () => BrowserWindow | null;
} = {}) {
  const active = (id: unknown): void => {
    if (typeof onActive === 'function' && typeof id === 'string' && id) onActive(id);
  };
  const parent = (): BrowserWindow | undefined => {
    const w = getHubWindow ? getHubWindow() : null;
    return w && !w.isDestroyed() ? w : undefined;
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

  ipcMain.handle('projects:delete', async (_e, { id }: any) => ({ ok: await projects.deleteProject(id) }));

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
        return (await fs.promises.readdir(path.join(projectDir(id), sub))).filter((n) => /^[0-9a-f-]{36}\.json$/i.test(n)).length;
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
        && fs.existsSync(path.join(projectDir(p.id), 'datasets', sample.datasetId + '.json')),
      syncedTo: syncedTarget(p.id), // the real folder of a project in a sync folder, else null
    })));
  });

  ipcMain.handle('projects:export', async (_e, { id }: any = {}) => {
    const project = await projects.getProject(id);
    if (!project) return { ok: false, error: 'That project is gone.' };
    const safe = project.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Project';
    const opts = {
      title: 'Export project',
      defaultPath: safe + '.ordinate',
      filters: [{ name: 'Ordinate project', extensions: ['ordinate'] }],
    };
    const win = parent();
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (canceled || !filePath) return { ok: false, canceled: true };
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
        const tmp = filePath + '.partial';
        await fs.promises.writeFile(tmp, bytes);
        await fs.promises.rename(tmp, filePath);
        return { path: filePath, counts: out.manifest.counts };
      },
      resultOf: (r) => ({ path: r.path }),
    });
    try {
      const r = await job.done;
      return { ok: true, path: r.path, counts: r.counts };
    } catch (err: any) {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err?.message || 'Export failed.' };
    }
  });

  ipcMain.handle('projects:import', async () => {
    const opts = {
      title: 'Import project',
      properties: ['openFile' as const],
      filters: [{ name: 'Ordinate project', extensions: ['ordinate'] }],
    };
    const win = parent();
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    const file = filePaths[0];
    await safetyBackup('before-import'); // a copy of the active project first (src/ipc/backups.ts)
    const job = jobs.submit({
      kind: 'bundle',
      label: `Import ${path.basename(file)}`,
      run: async (ctx) => {
        const res = await bundle.importBundle(await fs.promises.readFile(file), {
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
  });
}
