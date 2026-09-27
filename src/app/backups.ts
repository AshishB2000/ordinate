// Backups — every project, written as a .ordinate bundle. MAIN ONLY.
//
//   <folder>/<Project name> — <first 8 of id>/2026-09-25T14-05-00-123Z.ordinate
//
// A backup IS a project bundle (bundle.ts): the same whitelist, the same
// manifest, and restoring one is an ordinary import — which always makes a NEW
// project, so a restore can never overwrite the work it is meant to protect.
//
// Two kinds of file share a project's folder. SCHEDULED backups (cadence in
// Settings) are pruned to the newest `keep`. SAFETY backups are taken just
// before something replaces work — a bundle import, a version restore — and are
// named for it (`…-before-import.ordinate`); they are kept apart, the last
// SAFETY_KEEP of them, so a burst of restores can never push out a week of
// dailies, nor the dailies push out the copy made before a restore.
//
// The pure parts (names, pruning, cadence) take their clock as an argument so a
// test can drive them; the writers take the folder, so a test can point them
// at a temp dir.

import * as fs from 'fs';
import * as path from 'path';
import * as bundle from './bundle';
import * as projects from './projects';
import { safeFolderName } from './syncFolder';
import type { BackupSettings } from './backupSettings';

export const SAFETY_KEEP = 5;
export type BackupReason = 'scheduled' | 'before-import' | 'before-restore';

const DAY = 24 * 60 * 60 * 1000;
const PERIOD: Record<string, number> = { daily: DAY, weekly: 7 * DAY };
const NAME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-(before-import|before-restore))?\.ordinate$/;

/** `2026-09-25T14-05-00-123Z[-before-import].ordinate` — sorts by time, legal on every file system. */
export function backupFileName(at: Date, reason: BackupReason = 'scheduled'): string {
  const stamp = at.toISOString().replace(/:/g, '-').replace('.', '-');
  return stamp + (reason === 'scheduled' ? '' : '-' + reason) + '.ordinate';
}

export function parseBackupName(name: string): { at: Date; reason: BackupReason } | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isFinite(at.getTime()) ? { at, reason: (m[6] as BackupReason) || 'scheduled' } : null;
}

/** The file names to delete: scheduled beyond the newest `keep`, safety beyond the newest SAFETY_KEEP. */
export function planPrune(names: string[], keep: number): string[] {
  const parsed = names.map((n) => ({ n, p: parseBackupName(n) })).filter((x) => x.p) as Array<{ n: string; p: { at: Date; reason: BackupReason } }>;
  parsed.sort((a, b) => b.p.at.getTime() - a.p.at.getTime());
  const scheduled = parsed.filter((x) => x.p.reason === 'scheduled').slice(Math.max(1, keep));
  const safety = parsed.filter((x) => x.p.reason !== 'scheduled').slice(SAFETY_KEEP);
  return [...scheduled, ...safety].map((x) => x.n);
}

/** Whether the schedule wants a backup now. A clock that ran backwards counts as due. */
export function isDue(s: BackupSettings, now: Date): boolean {
  const period = PERIOD[s.cadence];
  if (!period) return false;
  const last = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= period || now.getTime() < last;
}

/** When the next scheduled backup falls, or null when the schedule is off. */
export function nextDue(s: BackupSettings, now: Date): Date | null {
  const period = PERIOD[s.cadence];
  if (!period) return null;
  const last = s.lastRunAt ? Date.parse(s.lastRunAt) : NaN;
  return !Number.isFinite(last) || isDue(s, now) ? now : new Date(last + period);
}

export function folderName(p: { id: string; name: string }): string {
  return `${safeFolderName(p.name)} — ${p.id.slice(0, 8)}`;
}

/**
 * The project's backup folder under `root`, created if need be. A project
 * renamed since its last backup has its folder renamed with it, so retention
 * still sees every one of its backups in one place.
 */
async function projectFolder(root: string, p: { id: string; name: string }): Promise<string> {
  const want = path.join(root, folderName(p));
  // A folder on a drive that is not connected must fail, not be re-created on
  // the boot disk by a recursive mkdir: only the last level is ever created.
  if (!fs.existsSync(path.dirname(root))) throw new Error('The backup folder is not available — is its drive connected?');
  await fs.promises.mkdir(root, { recursive: true });
  if (!fs.existsSync(want)) {
    const suffix = ` — ${p.id.slice(0, 8)}`;
    const old = (await fs.promises.readdir(root)).find((n) => n.endsWith(suffix));
    if (old) await fs.promises.rename(path.join(root, old), want).catch(() => { /* write a fresh one */ });
  }
  await fs.promises.mkdir(want, { recursive: true });
  return want;
}

export async function prune(dir: string, keep: number): Promise<string[]> {
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch (_) { return []; }
  const gone = planPrune(names, keep);
  for (const n of gone) await fs.promises.rm(path.join(dir, n), { force: true });
  return gone;
}

export interface Hooks {
  onProgress?: (fraction: number, note?: string) => void;
  checkCancelled?: () => void;
}

/** One project's backup, written atomically. Returns the file, or null if the project is gone. */
export async function backupProject(
  root: string, projectId: string, reason: BackupReason, now: Date, hooks: Hooks = {},
): Promise<{ file: string; manifest: bundle.BundleManifest } | null> {
  const project = await projects.getProject(projectId);
  if (!project) return null;
  const out = await bundle.exportProject(projectId, hooks);
  if (!out) return null;
  if (hooks.checkCancelled) hooks.checkCancelled();
  const dir = await projectFolder(root, project);
  const file = path.join(dir, backupFileName(now, reason));
  await fs.promises.writeFile(file + '.partial', out.bytes);
  await fs.promises.rename(file + '.partial', file);
  await prune(dir, Number.MAX_SAFE_INTEGER); // safety copies are capped even here
  return { file, manifest: out.manifest };
}

/** Back up every project (archived too), then prune each to `keep`. */
export async function backupAll(
  root: string, keep: number, now: Date, hooks: Hooks = {},
): Promise<{ count: number; failed: Array<{ name: string; error: string }> }> {
  const list = await projects.listProjects();
  const failed: Array<{ name: string; error: string }> = [];
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const share = (f: number, note?: string): void => { if (hooks.onProgress) hooks.onProgress((i + f) / list.length, note); };
    share(0, `${p.name} (${i + 1} of ${list.length})`);
    try {
      const r = await backupProject(root, p.id, 'scheduled', now, {
        onProgress: (f) => share(f, `${p.name} (${i + 1} of ${list.length})`),
        checkCancelled: hooks.checkCancelled,
      });
      if (r) { count++; await prune(path.dirname(r.file), keep); }
    } catch (err: any) {
      if (err && err.name === 'JobCancelled') throw err;
      failed.push({ name: p.name, error: err?.message || 'failed' });
    }
  }
  // Nothing written at all is a failed backup (an unwritable folder, a gone
  // drive), not a partial one — the schedule must not record it as done.
  if (!count && failed.length) throw new Error(failed[0].error);
  return { count, failed };
}

export interface BackupEntry {
  /** `<project folder>/<file>` — what a restore names; resolved under the root again, never trusted as a path. */
  id: string;
  projectName: string;
  at: string;
  reason: BackupReason;
  counts: Record<string, number>;
  size: number;
  appVersion: string;
}

/** Every readable backup under `root`, newest first. Unreadable files are counted, never fatal. */
export async function listBackups(root: string): Promise<{ items: BackupEntry[]; skipped: number }> {
  const items: BackupEntry[] = [];
  let skipped = 0;
  let dirs: fs.Dirent[] = [];
  try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch (_) { return { items, skipped }; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names: string[] = [];
    try { names = await fs.promises.readdir(path.join(root, d.name)); } catch (_) { continue; }
    for (const n of names) {
      const parsed = parseBackupName(n);
      if (!parsed) continue;
      const file = path.join(root, d.name, n);
      const manifest = await bundle.peekManifest(file);
      if (!manifest) { skipped++; continue; }
      items.push({
        id: d.name + '/' + n,
        projectName: String((manifest.project && manifest.project.name) || 'Project'),
        at: parsed.at.toISOString(),
        reason: parsed.reason,
        counts: manifest.counts || {},
        size: (await fs.promises.stat(file)).size,
        appVersion: String(manifest.appVersion || ''),
      });
    }
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { items, skipped };
}

/** A backup id back to its file — only ever a backup-named file one folder under `root`. */
export function resolveBackup(root: string, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const parts = id.split('/');
  if (parts.length !== 2 || !parts[0] || parts[0] === '.' || parts[0] === '..' || /[\\]/.test(id) || !parseBackupName(parts[1])) return null;
  const file = path.join(root, parts[0], parts[1]);
  return path.dirname(path.dirname(file)) === path.resolve(root) ? file : null;
}

/** "Sales (restored Sep 24, 2026)" — the name a restored copy is given. */
export function restoredName(name: string, at: Date): string {
  const d = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${name} (restored ${d})`;
}

/** Restore a backup into a NEW project. The source project is never read or written. */
export async function restoreBackup(file: string, hooks: Hooks = {}): Promise<bundle.ImportResult> {
  const manifest = await bundle.peekManifest(file);
  const parsed = parseBackupName(path.basename(file));
  if (!manifest || !parsed) return { ok: false, error: 'That backup could not be read.' };
  return bundle.importBundle(await fs.promises.readFile(file), {
    ...hooks,
    name: restoredName(String(manifest.project && manifest.project.name || 'Project'), parsed.at),
  });
}
