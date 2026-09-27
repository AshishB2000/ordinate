// Projects in a sync folder — MAIN ONLY.
//
// A project can live in a folder the user syncs (iCloud Drive, Dropbox): the
// directory moves to <chosen folder>/<Name>.ordinate-project/, and
// userData/projects/<id> becomes a SYMLINK to it (a junction on Windows, which
// needs no admin rights). Project paths are built independently in ~16 modules;
// a link means every one of them keeps working untouched, where a path resolver
// would have to be threaded through all of them.
//
// THE LINK IS THE REGISTRY. "Is this project synced, and where to?" is an lstat
// and a readlink — there is no second list that could disagree with the disk.
//
// Every move is COPY, VERIFY, SWAP, then remove: the original is only removed
// once the copy is known complete (same files, same sizes) and the link is in
// place. A failure at any step leaves the project where it was.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as projects from './projects';
import { projectDir, projectsBase, isValidId } from './recordKinds';
import { LOCK_FILE } from './syncLock';

export const SYNC_SUFFIX = '.ordinate-project';

export interface SyncResult { ok: boolean; error?: string; target?: string; project?: projects.Project | null }

/** Where a synced project really lives, or null for a local one. Sync on purpose: cheap, and used per row. */
export function syncedTarget(id: string): string | null {
  const link = projectDir(id);
  if (!link) return null;
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch (_) {
    return null;
  }
}

/** Every synced project on this machine — including one whose folder is not there right now. */
export async function listSynced(): Promise<Array<{ id: string; target: string; available: boolean }>> {
  let names: string[] = [];
  try { names = (await fs.promises.readdir(projectsBase())).filter((n) => isValidId(n)); } catch (_) { return []; }
  const out: Array<{ id: string; target: string; available: boolean }> = [];
  for (const id of names) {
    const target = syncedTarget(id);
    if (target) out.push({ id, target, available: fs.existsSync(path.join(target, 'project.json')) });
  }
  return out;
}

/** A folder name every file system takes. */
export function safeFolderName(name: string): string {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[. ]+$/, '').slice(0, 80);
  return s || 'Project';
}

function staging(): string {
  return path.join(path.dirname(projectsBase()), 'sync-staging');
}

/**
 * After a crash mid-move: a staged copy whose project has no entry here any
 * more is the project — it goes back. Any other staged copy is spare.
 */
export async function recoverStaging(): Promise<void> {
  let names: string[] = [];
  try { names = await fs.promises.readdir(staging()); } catch (_) { return; }
  for (const n of names) {
    const id = n.slice(0, 36);
    const dir = path.join(staging(), n);
    const missing = isValidId(id) && !(await fs.promises.lstat(projectDir(id)).catch(() => null));
    if (missing) await fs.promises.rename(dir, projectDir(id)).catch(() => { /* left for next launch */ });
    else await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => { /* next launch */ });
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Relative path → size for every file under `dir`, lock.json aside. */
async function manifestOf(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && r !== LOCK_FILE) out.set(r, (await fs.promises.stat(path.join(dir, r))).size);
    }
  };
  await walk('');
  return out;
}

/** Same files, same sizes. What a copy has to be before its original goes. */
export async function sameTree(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([manifestOf(a), manifestOf(b)]);
  return x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
}

async function copyVerified(from: string, to: string): Promise<void> {
  await fs.promises.cp(from, to, {
    recursive: true, errorOnExist: true, force: false,
    filter: (src) => src !== path.join(from, LOCK_FILE),
  });
  if (!(await sameTree(from, to))) throw new Error('The copy did not match the original, so nothing was moved.');
}

/** Move a local project into `parent` (the user's synced folder) and link it back. */
export async function moveToFolder(id: string, parent: string): Promise<SyncResult> {
  const project = await projects.getProject(id);
  const link = projectDir(id);
  if (!project || !link) return { ok: false, error: 'That project is gone.' };
  if (syncedTarget(id)) return { ok: false, error: 'This project is already in a sync folder.' };
  let realParent: string;
  try { realParent = await fs.promises.realpath(parent); } catch (_) { return { ok: false, error: 'That folder is not available.' }; }
  if (inside(realParent, await fs.promises.realpath(path.dirname(projectsBase())))) {
    return { ok: false, error: 'Choose a folder outside Ordinate\'s own storage.' };
  }
  const base = safeFolderName(project.name);
  let target = path.join(realParent, base + SYNC_SUFFIX);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(realParent, `${base} ${n}${SYNC_SUFFIX}`);

  const aside = path.join(staging(), `${id}-${randomUUID()}`);
  try {
    await copyVerified(link, target);
    await fs.promises.mkdir(staging(), { recursive: true });
    await fs.promises.rename(link, aside);
  } catch (err: any) {
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => { /* partial copy */ });
    return { ok: false, error: err?.message || 'The project could not be copied.' };
  }
  try {
    await fs.promises.symlink(target, link, 'junction');
  } catch (err: any) {
    await fs.promises.rename(aside, link); // put it back exactly as it was
    await fs.promises.rm(target, { recursive: true, force: true }).catch(() => { /* the copy */ });
    return { ok: false, error: err?.message || 'The project could not be linked.' };
  }
  await fs.promises.rm(aside, { recursive: true, force: true }).catch(() => { /* swept next time */ });
  return { ok: true, target, project };
}

/** Link a project folder someone synced here. Never copies: the folder stays the project. */
export async function openFromFolder(folder: string): Promise<SyncResult> {
  let real: string;
  let data: any; // ponytail: raw project.json off a synced disk — checked below
  try {
    real = await fs.promises.realpath(folder);
    data = JSON.parse(await fs.promises.readFile(path.join(real, 'project.json'), 'utf8'));
  } catch (_) {
    return { ok: false, error: 'That folder does not hold an Ordinate project (no project.json).' };
  }
  if (!data || !isValidId(data.id)) return { ok: false, error: 'That folder\'s project.json is not an Ordinate project.' };
  if (inside(real, await fs.promises.realpath(path.dirname(projectsBase())).catch(() => ''))) {
    return { ok: false, error: 'That folder is inside Ordinate\'s own storage already.' };
  }
  const link = projectDir(data.id);
  if (await fs.promises.lstat(link).catch(() => null)) {
    const here = await projects.getProject(data.id);
    return { ok: false, error: `This project is already on this Mac${here ? ` as “${here.name}”` : ''}.` };
  }
  await fs.promises.mkdir(projectsBase(), { recursive: true });
  try {
    await fs.promises.symlink(real, link, 'junction');
  } catch (err: any) {
    return { ok: false, error: err?.message || 'The project could not be linked.' };
  }
  return { ok: true, target: real, project: await projects.getProject(data.id) };
}

/**
 * Bring a synced project back into this machine's own storage. `discard` gets
 * the synced folder once the local copy is in place — the IPC layer passes the
 * OS trash, so it stays recoverable. A discard that fails is reported, not fatal.
 */
export async function moveBack(id: string, discard: (dir: string) => Promise<void>): Promise<SyncResult & { leftBehind?: string }> {
  const link = projectDir(id);
  const target = syncedTarget(id);
  if (!link || !target) return { ok: false, error: 'This project is not in a sync folder.' };
  if (!fs.existsSync(path.join(target, 'project.json'))) return { ok: false, error: 'The sync folder is not available right now.' };
  const copy = path.join(staging(), `${id}-${randomUUID()}`);
  try {
    await fs.promises.mkdir(staging(), { recursive: true });
    await copyVerified(target, copy);
  } catch (err: any) {
    await fs.promises.rm(copy, { recursive: true, force: true }).catch(() => { /* partial copy */ });
    return { ok: false, error: err?.message || 'The project could not be copied back.' };
  }
  await fs.promises.unlink(link);
  try {
    await fs.promises.rename(copy, link);
  } catch (err: any) {
    await fs.promises.symlink(target, link, 'junction'); // back to how it was
    return { ok: false, error: err?.message || 'The project could not be moved back.' };
  }
  try {
    await discard(target);
    return { ok: true, target, project: await projects.getProject(id) };
  } catch (_) {
    return { ok: true, target, project: await projects.getProject(id), leftBehind: target };
  }
}
