import { ipcMain } from 'electron';
import * as projects from '../projects';

// Projects (workspace shell) IPC — list/create/rename/delete/open. All are
// ipcMain.handle (request/response) since the renderer needs the returned data.
// No deps: pure disk ops (main.js wires this via `require(...).register()`).
export function register() {
  ipcMain.handle('projects:list', async () => projects.listProjects());

  // ponytail: untrusted renderer payloads — any.
  ipcMain.handle('projects:create', async (_e, { name }: any) => projects.createProject(name));

  ipcMain.handle('projects:rename', async (_e, { id, name }: any) => projects.renameProject(id, name));

  ipcMain.handle('projects:delete', async (_e, { id }: any) => ({ ok: await projects.deleteProject(id) }));

  // Thin getProject for now (SHELL — nothing to load into yet); gives the
  // renderer a validated project object to enter the workspace with.
  ipcMain.handle('projects:open', async (_e, { id }: any) => projects.getProject(id));
}
