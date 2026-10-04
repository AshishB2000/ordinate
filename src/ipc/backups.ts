import * as appPaths from '../app/paths';
import { ipcMain } from './bus';
import type { BrowserWindow, OpenDialogOptions, WebContents } from 'electron';
import { serverDataDir, windowOf } from '../server/context';
import * as fs from 'fs';
import * as path from 'path';
import * as config from '../app/config';
import * as jobs from '../app/jobs';
import * as backups from '../app/backups';
import * as projects from '../app/projects';
import { CADENCES } from '../app/backupSettings';
import type { BackupSettings } from '../app/backupSettings';
import { captureProjectId } from '../app/captureRecord';
import * as hubs from '../windows/hubRegistry';
import { track } from '../app/quitCleanup';
import type { PlatformDeps } from './platform';

// Backups IPC — Settings → General → Backups, "Restore from backup…", the
// schedule, and the safety copy taken before an import or a version restore.
// The work itself is src/app/backups.ts; this file owns the folder, the jobs
// and the timer.
//
// The backup FOLDER never comes from a renderer: it is set from the native
// folder picker here, or reset to the default. A restore names a backup by the
// id the list handed out, which is resolved under the folder again — a
// renderer cannot point a restore at an arbitrary file.

const TICK_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

export function backupRoot(): string {
  return config.get().backups.folder || path.join(appPaths.userData(), 'backups');
}

function saveBackups(patch: Partial<BackupSettings>): void {
  config.save({ backups: { ...config.get().backups, ...patch } });
}

/** The renderer's view: settings, the folder actually used, and when the next one falls. */
function view() {
  const b = config.get().backups;
  const next = backups.nextDue(b, new Date());
  return { ...b, folder: backupRoot(), custom: !!b.folder, running: !!running, nextAt: next ? next.toISOString() : null };
}

// Electron is required inside the desktop-only bodies below: ipc/projects
// imports this file, and the server must load it without Electron.
function parentOf(e: { sender: WebContents }): BrowserWindow | undefined {
  const w = windowOf(e);
  return w && !w.isDestroyed() ? w : undefined;
}

export async function pickFolder(e: { sender: WebContents }, opts: OpenDialogOptions): Promise<string | null> {
  const { dialog } = (require('electron') as typeof import('electron'));
  const win = parentOf(e);
  const full: OpenDialogOptions = { ...opts, properties: ['openDirectory', 'createDirectory'] };
  const r = win ? await dialog.showOpenDialog(win, full) : await dialog.showOpenDialog(full);
  return r.canceled || !r.filePaths || !r.filePaths[0] ? null : r.filePaths[0];
}

interface RunOutcome { ok: boolean; canceled?: boolean; error?: string; count?: number; failed?: Array<{ name: string; error: string }>; folder?: string }

let running: Promise<RunOutcome> | null = null;
let failedAt = 0;

/**
 * Back up every project now — one job; a second call while it runs joins it.
 * `scheduled` makes it a SILENT job: the daily run shows in the Jobs popover
 * but does not raise a notification every day; "Back up now" still does.
 */
export function backUpNow(scheduled = false): Promise<RunOutcome> {
  if (running) return running;
  const s = config.get().backups;
  const root = backupRoot();
  const now = new Date();
  const job = jobs.submit({
    kind: 'backup',
    label: scheduled ? 'Scheduled backup' : 'Back up all projects',
    cancellable: true,
    silent: scheduled,
    run: (ctx) => backups.backupAll(root, s.keep, now, {
      onProgress: (p, note) => ctx.progress(p, note),
      checkCancelled: () => ctx.checkCancelled(),
    }),
    resultOf: (r) => ({
      path: root,
      message: `${r.count} project${r.count === 1 ? '' : 's'} backed up` + (r.failed.length ? ` · ${r.failed.length} failed` : ''),
    }),
  });
  running = job.done.then(
    (r) => {
      saveBackups({
        lastRunAt: now.toISOString(),
        lastError: r.failed.length ? `Not backed up: ${r.failed.map((f) => f.name).join(', ')} — ${r.failed[0].error}` : undefined,
      });
      return { ok: true, count: r.count, failed: r.failed, folder: root };
    },
    (err: any) => {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      failedAt = Date.now();
      const error = err?.message || 'The backup failed.';
      saveBackups({ lastError: error });
      return { ok: false, error };
    },
  ).finally(() => {
    running = null;
    hubs.broadcast('backups:changed', view());
  });
  hubs.broadcast('backups:changed', view());
  return running;
}

/**
 * A one-off copy of a project taken just before something replaces its work —
 * a bundle import (the ACTIVE project) or a version restore (the project being
 * restored into). Awaited by the caller, but never blocks it: a copy that could
 * not be written shows as a failed job, and the operation the user asked for
 * still happens.
 */
export async function safetyBackup(reason: 'before-import' | 'before-restore', projectId?: string): Promise<void> {
  // Server: backups are the operator's (Postgres and the volume or bucket —
  // plan §8), and there is no "active project"; a zip under the org's
  // userData nobody can reach would only cost disk.
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

function tick(): void {
  if (running || Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) return;
  if (backups.isDue(config.get().backups, new Date())) void backUpNow(true);
}

export function register(deps: PlatformDeps): void {
  ipcMain.handle('backups:settings', () => view());

  // ponytail: untrusted renderer payload — only cadence and keep are read, each checked.
  ipcMain.handle('backups:set', (_e, patch: any = {}) => {
    const next: Partial<BackupSettings> = {};
    if (CADENCES.includes(patch.cadence)) next.cadence = patch.cadence;
    if (Number.isFinite(Number(patch.keep))) next.keep = Number(patch.keep);
    saveBackups(next);
    return view();
  });

  ipcMain.handle('backups:chooseFolder', async (e) => {
    const picked = await pickFolder(e, { title: 'Choose a folder for backups', buttonLabel: 'Use this folder', defaultPath: backupRoot() });
    if (!picked) return { ok: false, canceled: true };
    saveBackups({ folder: picked });
    return { ok: true, settings: view() };
  });

  ipcMain.handle('backups:useDefaultFolder', () => {
    saveBackups({ folder: '' });
    return view();
  });

  ipcMain.handle('backups:reveal', async () => {
    const root = backupRoot();
    await fs.promises.mkdir(root, { recursive: true }).catch(() => { /* openPath reports it */ });
    const err = await (require('electron') as typeof import('electron')).shell.openPath(root);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('backups:now', () => backUpNow(false));

  ipcMain.handle('backups:list', async () => ({ folder: backupRoot(), ...(await backups.listBackups(backupRoot())) }));

  ipcMain.handle('backups:restore', async (_e, { id }: { id?: unknown } = {}) => {
    const file = backups.resolveBackup(backupRoot(), id);
    if (!file || !fs.existsSync(file)) return { ok: false, error: 'That backup is no longer there.' };
    const job = jobs.submit({
      kind: 'restore',
      label: `Restore ${String(id).split('/')[0].replace(/ — [0-9a-f]{8}$/, '')}`,
      cancellable: true,
      run: async (ctx) => {
        const r = await backups.restoreBackup(file, {
          onProgress: (p, note) => ctx.progress(p, note),
          checkCancelled: () => ctx.checkCancelled(),
        });
        if (!r.ok) throw new Error(r.error || 'The backup could not be restored.');
        return r;
      },
      resultOf: (r) => ({ message: r.project ? `Restored as “${r.project.name}”` : undefined }),
    });
    try {
      return await job.done;
    } catch (err: any) {
      if (err instanceof jobs.JobCancelled) return { ok: false, canceled: true };
      return { ok: false, error: err?.message || 'The backup could not be restored.' };
    }
  });

  require('./syncFolder').register(deps);

  // The schedule belongs to the GUI: a headless run registers the handlers and
  // starts nothing. First look a minute after launch, then every ten minutes.
  if (!deps.headless) {
    track(setTimeout(tick, 60 * 1000));
    track(setInterval(tick, TICK_MS));
  }
}
