// lock.json and conflict copies — for a project that lives in a folder the user
// syncs (iCloud Drive, Dropbox; see syncFolder.ts). MAIN ONLY, Electron-free.
//
// A sync service copies files; it does not know two Macs are editing the same
// project. So the app says so itself: while a synced project is open, its
// folder holds a lock.json naming the machine, refreshed every minute. Another
// Mac that opens it sees a FRESH lock (heartbeat < 5 min) and asks first; a
// STALE one (the other Mac quit badly, or went to sleep) is taken over and noted.
//
// Machines are compared by a random per-install id, not the host name — two
// Macs both called "MacBook-Pro" is the default, not an edge case. The host
// name is only what the warning SAYS.
//
// When two machines did write at once, the sync service keeps both versions as
// "conflict copies" beside the file. findConflicts() spots them so the app can
// say so instead of one silently winning.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const LOCK_FILE = 'lock.json';
export const STALE_MS = 5 * 60 * 1000;

export interface LockFile {
  app: 'Ordinate';
  host: string;
  machine: string;
  pid: number;
  appVersion: string;
  openedAt: string;
  heartbeatAt: string;
}

/** This process, as a lock names it. */
export interface Me { host: string; machine: string; pid: number; appVersion: string }

export type LockState =
  | { state: 'free' }
  | { state: 'mine'; lock: LockFile }
  | { state: 'held'; lock: LockFile }
  | { state: 'stale'; lock: LockFile };

/** The lock in `dir`, or null — a corrupt lock is no lock. */
export function readLock(dir: string): LockFile | null {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'));
    if (!l || l.app !== 'Ordinate' || typeof l.host !== 'string' || !Number.isFinite(Date.parse(l.heartbeatAt))) return null;
    return { ...l, machine: typeof l.machine === 'string' ? l.machine : '', openedAt: String(l.openedAt || l.heartbeatAt) };
  } catch (_) {
    return null;
  }
}

export function lockState(dir: string, me: Me, now = Date.now()): LockState {
  const lock = readLock(dir);
  if (!lock) return { state: 'free' };
  if (lock.machine ? lock.machine === me.machine : lock.host === me.host) return { state: 'mine', lock };
  // A heartbeat from the future is a skewed clock, not a live lock forever.
  const age = now - Date.parse(lock.heartbeatAt);
  return age >= 0 && age < STALE_MS ? { state: 'held', lock } : { state: 'stale', lock };
}

/** Write (or refresh) this machine's lock. Keeps `openedAt` when it is ours already. */
export function writeLock(dir: string, me: Me, now = Date.now()): LockFile {
  const prev = readLock(dir);
  const at = new Date(now).toISOString();
  const lock: LockFile = {
    app: 'Ordinate', host: me.host, machine: me.machine, pid: me.pid, appVersion: me.appVersion,
    openedAt: prev && prev.machine === me.machine ? prev.openedAt : at,
    heartbeatAt: at,
  };
  const file = path.join(dir, LOCK_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return lock;
}

/** Remove the lock — only if it is ours. Another machine's lock is not ours to drop. */
export function releaseLock(dir: string, me: Me): void {
  const lock = readLock(dir);
  if (lock && lock.machine === me.machine) {
    try { fs.unlinkSync(path.join(dir, LOCK_FILE)); } catch (_) { /* already gone */ }
  }
}

// Dropbox: "x (Ann's conflicted copy 2026-01-02).json", "x (Case Conflict).json".
const DROPBOX = /conflicted copy|\(case conflict/i;
// iCloud: "x 2.json" beside "x.json" — the number goes before the last extension.
const ICLOUD = /^(.+) ([2-9]|\d{2,})(\.[^. ]+)?$/;

/**
 * Every conflict copy in a project folder, as paths relative to it. A copy of
 * lock.json is not the user's work and is left out. Never throws.
 */
export async function findConflicts(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true }); } catch (_) { return; }
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      const m = ICLOUD.exec(e.name);
      const conflict = DROPBOX.test(e.name) || (!!m && names.has(m[1] + (m[3] || '')));
      if (conflict && !(rel === '' && /^lock\b/i.test(e.name))) out.push(r);
      else if (e.isDirectory()) await walk(r);
    }
  };
  await walk('');
  return out.sort();
}
