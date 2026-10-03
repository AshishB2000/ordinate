import { shell, app } from 'electron';
import * as appPaths from '../app/paths';
import { ipcMain } from './bus';
import { senderOf } from '../server/context';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as sync from '../app/syncFolder';
import { lockState, writeLock, releaseLock, findConflicts } from '../app/syncLock';
import type { Me } from '../app/syncLock';
import { isValidId } from '../app/recordKinds';
import { getProject } from '../app/projects';
import { noteDir } from '../connectors/duckdbDirs';
import { hardeningState } from './mosaic';
import * as hubs from '../windows/hubRegistry';
import { track } from '../app/quitCleanup';
import { pickFolder } from './backups';
import type { PlatformDeps } from './platform';

// Sync-folder IPC — move a project to (or open one from) a folder the user
// syncs, move it back, and the lock.json that tells a second Mac it is open
// here. The file work is src/app/syncFolder.ts and src/app/syncLock.ts.
//
// WHO HOLDS WHAT. Each hub window tells main which project it adopted
// (`sync:take`); a project stays locked while ANY window holds it, and is
// released when the last one moves on or closes, and on quit. The heartbeat
// refreshes every held synced project's lock once a minute. If another Mac
// took the lock over in the meantime ("Open anyway" there), this one stops
// writing it and says so rather than the two fighting over the file.
//
// DuckDB's allow-list resolves symlinks, so a project's real folder must be on
// it or its tables are unreadable once the engine is locked (src/ipc/mosaic.ts).
// Every synced folder is noted in the allow-list registry when it is linked and
// again at launch; a folder linked AFTER the engine locked needs a restart,
// and the renderer is told so.

const HEARTBEAT_MS = 60 * 1000;

let machine = '';
function me(): Me {
  if (!machine) {
    const file = path.join(appPaths.userData(), 'machine-id');
    try { machine = fs.readFileSync(file, 'utf8').trim(); } catch (_) { machine = ''; }
    if (!isValidId(machine)) {
      machine = randomUUID();
      try { fs.writeFileSync(file, machine, 'utf8'); } catch (_) { /* this session still has one */ }
    }
  }
  return { host: os.hostname().replace(/\.local$/i, ''), machine, pid: process.pid, appVersion: app.getVersion() };
}

/** Whether the locked engine would refuse `dir` — true only when it is locked AND the folder is not on its list. */
export function engineLocksOut(dir: string): boolean {
  const applied = hardeningState().applied;
  if (!applied.some((s) => /enable_external_access\s*=\s*false/i.test(s))) return false;
  const allowed = applied.filter((s) => /allowed_directories/i.test(s))
    .flatMap((s) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")));
  let real = dir;
  try { real = fs.realpathSync(dir); } catch (_) { /* judge the path as given */ }
  return !allowed.some((a) => real === a || real.startsWith(a.endsWith(path.sep) ? a : a + path.sep));
}

const held = new Map<number, string>(); // webContents id → project id
const lost = new Set<string>(); // projects another Mac took over while open here

function isHeld(id: string): boolean {
  for (const v of held.values()) if (v === id) return true;
  return false;
}

function release(id: string): void {
  if (isHeld(id)) return;
  lost.delete(id);
  const t = sync.syncedTarget(id);
  if (t) { try { releaseLock(t, me()); } catch (_) { /* folder gone */ } }
}

function heartbeat(): void {
  for (const id of new Set(held.values())) {
    const t = sync.syncedTarget(id);
    if (!t) continue;
    try {
      const st = lockState(t, me());
      if (st.state === 'held') {
        if (!lost.has(id)) hubs.broadcast('sync:lockLost', { projectId: id, host: st.lock.host, at: st.lock.openedAt });
        lost.add(id);
        continue;
      }
      lost.delete(id);
      writeLock(t, me());
    } catch (_) { /* the sync folder is offline — try again next beat */ }
  }
}

function lockView(id: string) {
  const target = sync.syncedTarget(id);
  if (!target) return { synced: false };
  const available = fs.existsSync(path.join(target, 'project.json'));
  const st = available ? lockState(target, me()) : { state: 'free' as const };
  return {
    synced: true, target, available, state: st.state,
    host: 'lock' in st ? st.lock.host : null,
    openedAt: 'lock' in st ? st.lock.openedAt : null,
    heartbeatAt: 'lock' in st ? st.lock.heartbeatAt : null,
  };
}

/** Link bookkeeping after a project is linked: allow-list, lock, and whether a restart is needed. */
function linked(id: string, target: string): { restart: boolean } {
  noteDir(target);
  if (isHeld(id)) { try { writeLock(target, me()); } catch (_) { /* next heartbeat */ } }
  return { restart: engineLocksOut(target) };
}

export function register(deps: PlatformDeps): void {
  ipcMain.handle('sync:status', async (_e, { id }: { id?: unknown } = {}) => {
    if (!isValidId(id)) return { synced: false };
    const p = await getProject(id);
    return { ...lockView(id), name: p ? p.name : '' };
  });

  // A window adopted `id`: hold it, release what it held before, take the lock.
  ipcMain.handle('sync:take', async (e, { id }: { id?: unknown } = {}) => {
    if (!isValidId(id)) return { synced: false };
    const sender = senderOf(e);
    const prev = held.get(sender.id);
    if (!held.has(sender.id)) {
      sender.once('destroyed', () => {
        const was = held.get(sender.id);
        held.delete(sender.id);
        if (was) release(was);
      });
    }
    held.set(sender.id, id);
    if (prev && prev !== id) release(prev);
    const view = lockView(id);
    if (!view.synced || !view.available || !view.target) return view;
    lost.delete(id);
    try { writeLock(view.target, me()); } catch (_) { /* read-only or offline folder */ }
    return {
      ...view,
      tookOver: view.state === 'stale' ? { host: view.host, heartbeatAt: view.heartbeatAt } : null,
      conflicts: await findConflicts(view.target),
      restart: engineLocksOut(view.target),
    };
  });

  ipcMain.handle('sync:conflicts', async (_e, { id }: { id?: unknown } = {}) => {
    const t = isValidId(id) ? sync.syncedTarget(id) : null;
    return t ? findConflicts(t) : [];
  });

  // Reveal names a conflict by the relative path the list returned; it must
  // still BE one of them, so this can never reveal an arbitrary path.
  ipcMain.handle('sync:revealConflict', async (_e, { id, rel }: { id?: unknown; rel?: unknown } = {}) => {
    const t = isValidId(id) ? sync.syncedTarget(id) : null;
    if (!t || typeof rel !== 'string' || !(await findConflicts(t)).includes(rel)) return { ok: false };
    shell.showItemInFolder(path.join(t, ...rel.split('/')));
    return { ok: true };
  });

  ipcMain.handle('sync:revealFolder', (_e, { id }: { id?: unknown } = {}) => {
    const t = isValidId(id) ? sync.syncedTarget(id) : null;
    if (!t || !fs.existsSync(t)) return { ok: false, error: 'The sync folder is not available right now.' };
    shell.showItemInFolder(t);
    return { ok: true };
  });

  ipcMain.handle('sync:moveTo', async (e, { id }: { id?: unknown } = {}) => {
    if (!isValidId(id)) return { ok: false, error: 'That project is gone.' };
    const parent = await pickFolder(e, {
      title: 'Move to a sync folder',
      message: 'Choose a folder you sync with iCloud Drive or Dropbox. The project moves into it.',
      buttonLabel: 'Move here',
    });
    if (!parent) return { ok: false, canceled: true };
    const r = await sync.moveToFolder(id, parent);
    return r.ok && r.target ? { ...r, ...linked(id, r.target) } : r;
  });

  ipcMain.handle('sync:openFrom', async (e) => {
    const folder = await pickFolder(e, {
      title: 'Open a project from a folder',
      message: 'Choose a project folder (…ordinate-project) from iCloud Drive, Dropbox or another synced folder.',
      buttonLabel: 'Open',
    });
    if (!folder) return { ok: false, canceled: true };
    const r = await sync.openFromFolder(folder);
    return r.ok && r.target && r.project ? { ...r, ...linked(r.project.id, r.target) } : r;
  });

  ipcMain.handle('sync:moveBack', async (_e, { id }: { id?: unknown } = {}) => {
    if (!isValidId(id)) return { ok: false, error: 'That project is gone.' };
    const v = lockView(id);
    if (v.state === 'held') return { ok: false, error: `It is open on ${v.host}. Close it there first, then move it back.` };
    if (v.target) { try { releaseLock(v.target, me()); } catch (_) { /* moving anyway */ } }
    const r = await sync.moveBack(id, (dir) => shell.trashItem(dir));
    if (!r.ok && v.target && isHeld(id)) { try { writeLock(v.target, me()); } catch (_) { /* next beat */ } }
    return r;
  });

  ipcMain.handle('sync:relaunch', () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  // A move a crash interrupted is put right, and every linked folder goes back
  // on the allow-list registry — a long list of local folders can push one off.
  void sync.recoverStaging()
    .then(() => sync.listSynced())
    .then((list) => { for (const s of list) if (s.available) noteDir(s.target); });

  if (!deps.headless) {
    track(setInterval(heartbeat, HEARTBEAT_MS));
    app.on('will-quit', () => {
      const ids = new Set(held.values());
      held.clear();
      for (const id of ids) release(id);
    });
  }
}
