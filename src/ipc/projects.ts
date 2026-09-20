import { ipcMain } from 'electron';
import * as projects from '../app/projects';

// Projects (workspace shell) IPC — list/create/rename/delete/open. All are
// ipcMain.handle (request/response) since the renderer needs the returned data.
// `onActive` is the ONE hook: main needs to know which project the user is in
// so a capture fired from the global hotkey (no renderer to ask — the hub may be
// closed) lands in the right project. Opening and creating are the only two ways
// a project becomes the active one, and both go through here.
export function register({ onActive }: { onActive?: (id: string) => void } = {}) {
  const active = (id: unknown): void => {
    if (typeof onActive === 'function' && typeof id === 'string' && id) onActive(id);
  };

  ipcMain.handle('projects:list', async () => projects.listProjects());

  // ponytail: untrusted renderer payloads — any.
  ipcMain.handle('projects:create', async (_e, { name }: any) => {
    const created = await projects.createProject(name);
    if (created) active(created.id);
    return created;
  });

  ipcMain.handle('projects:rename', async (_e, { id, name }: any) => projects.renameProject(id, name));

  ipcMain.handle('projects:delete', async (_e, { id }: any) => ({ ok: await projects.deleteProject(id) }));

  // Thin getProject for now (SHELL — nothing to load into yet); gives the
  // renderer a validated project object to enter the workspace with.
  ipcMain.handle('projects:open', async (_e, { id }: any) => {
    const project = await projects.getProject(id);
    if (project) active(project.id);
    return project;
  });
}
