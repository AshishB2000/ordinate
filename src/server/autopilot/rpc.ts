// Autopilot's RPC channels (contracts in src/api/autopilot.ts). Org admins only, in their own request context: what they undo, they undo
// as themselves. A project that does not exist is "not found", never a settings row for it.

import { ipcMain } from '../../ipc/bus';
import { getProject, listProjects } from '../../app/projects';
import { ctx } from '../context';
import { orgDb } from '../db/inOrg';
import { runNow } from './job';
import * as store from './store';
import { undoItem, undoRepairs } from './undo';

const fail = (error: string) => ({ ok: false as const, error });
const needsDatabase = () => fail('needs_database');

async function known(projectId: unknown): Promise<string | null> {
  return typeof projectId === 'string' && (await getProject(projectId)) ? projectId.toLowerCase() : null;
}

/** What the browser draws of one project's settings. */
export function settingsView(s: store.Settings) {
  const { slowMs, ...rest } = s;
  return { ...rest, slowSeconds: slowMs / 1000 };
}

export function register(): void {
  ipcMain.handle('autopilot:overview', async () => {
    if (!orgDb()) return needsDatabase();
    const [all, latest] = await Promise.all([store.allSettings(), store.latestRuns()]);
    const projects = (await listProjects()).filter((p) => !p.archivedAt);
    return {
      ok: true as const,
      projects: projects.map((p) => ({ id: p.id, name: p.name, settings: settingsView(all.get(p.id.toLowerCase()) ?? store.defaultsFor(p.id.toLowerCase())), latest: latest.get(p.id.toLowerCase()) ?? null })),
    };
  });

  ipcMain.handle('autopilot:save', async (_e, p: { projectId: string; slowSeconds?: number } & store.Patch) => {
    if (!orgDb()) return needsDatabase();
    const projectId = await known(p.projectId);
    if (!projectId) return fail('not_found');
    const { projectId: _id, slowSeconds, ...patch } = p;
    const saved = await store.saveSettings(projectId, { ...patch, ...(slowSeconds !== undefined ? { slowMs: Math.round(slowSeconds * 1000) } : {}) }, ctx().user.email);
    return saved ? { ok: true as const, settings: settingsView(saved) } : fail('out_of_range');
  });

  ipcMain.handle('autopilot:runNow', async (_e, p: { projectId: string }) => {
    if (!orgDb()) return needsDatabase();
    const projectId = await known(p.projectId);
    if (!projectId) return fail('not_found');
    if (!(await store.getSettings(projectId)).enabled) return fail('off');
    const runId = await runNow(projectId);
    return runId ? { ok: true as const, runId } : fail('failed');
  });

  ipcMain.handle('autopilot:runs', async (_e, p: { projectId: string }) => {
    if (!orgDb()) return needsDatabase();
    const projectId = await known(p.projectId);
    return projectId ? { ok: true as const, runs: await store.listRuns(projectId) } : fail('not_found');
  });

  ipcMain.handle('autopilot:run', async (_e, p: { projectId: string; runId: string }) => {
    if (!orgDb()) return needsDatabase();
    const projectId = await known(p.projectId);
    const run = projectId ? await store.getRun(p.runId) : null;
    if (!projectId || !run || run.projectId !== projectId) return fail('not_found');
    return { ok: true as const, run, items: await store.items(run.id) };
  });

  ipcMain.handle('autopilot:undo', async (_e, p: { projectId: string; runId: string; seq?: number }) => {
    if (!orgDb()) return needsDatabase();
    const projectId = await known(p.projectId);
    const run = projectId ? await store.getRun(p.runId) : null;
    if (!projectId || !run || run.projectId !== projectId) return fail('not_found');
    if (p.seq === undefined) return { ok: true as const, ...(await undoRepairs(projectId, run.id)) };
    const r = await undoItem(projectId, run.id, p.seq);
    return r.ok ? { ok: true as const } : fail(r.why);
  });
}
