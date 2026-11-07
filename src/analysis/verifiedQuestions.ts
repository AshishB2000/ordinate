// Verified questions (semantic layer part 3 D7) — MAIN PROCESS ONLY. One JSON file per question under
// userData/projects/<projectId>/verified/<id>.json. The rules (shape, caps, key) are ./verifiedRules.
//
// The store mirrors ./terms.ts: both ids UUID-checked before either reaches a path, atomic writes, a corrupt
// file skipped, the edit-conflict tag, and a sanitize that runs again on every read.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isValidId, projectDir, RECORD_DIR } from '../app/recordKinds';
import * as recordFs from '../app/recordFs';
import { lockedUpdate, readTagged, type Tagged } from '../app/editConflict';
import { sanitizeVerified, type VerifiedQuestion } from './verifiedRules';

const dirOf = (projectId: string): string => path.join(projectDir(projectId), RECORD_DIR.verified);
const fileOf = (projectId: string, id: string): string => path.join(dirOf(projectId), id + '.json');

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

// any: parsed stored JSON
const normalize = (projectId: string) => (data: any): VerifiedQuestion | null => sanitizeVerified(data && typeof data === 'object' ? { ...data, projectId } : null);

/** Every question of the project with the tag of what is stored, newest `updatedAt` first. A corrupt file is skipped. */
export async function listTagged(projectId: string): Promise<Tagged<VerifiedQuestion>[]> {
  if (!isValidId(projectId)) return [];
  let names: string[];
  try {
    names = await recordFs.readdir(dirOf(projectId));
  } catch (_) {
    return []; // none yet
  }
  const out: Tagged<VerifiedQuestion>[] = [];
  for (const n of names) {
    const id = n.endsWith('.json') ? n.slice(0, -5) : '';
    const t = isValidId(id) ? await readVerified(projectId, id) : null; // a stray or temp file, or a corrupt one: null
    if (t && t.rec.id === id) out.push(t);
  }
  return out.sort((a, b) => (a.rec.updatedAt < b.rec.updatedAt ? 1 : a.rec.updatedAt > b.rec.updatedAt ? -1 : 0));
}

/** Every question of the project, newest `updatedAt` first. A corrupt file is skipped. */
export async function listVerified(projectId: string): Promise<VerifiedQuestion[]> {
  return (await listTagged(projectId)).map((t) => t.rec);
}

/** `fn` holding the project's questions (every pod): a key check and the write or restore it guards run as one. */
export function lockedKeys<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return recordFs.locked(dirOf(projectId), fn);
}

/** The record and the tag of what is stored, from ONE read (../app/editConflict). */
export async function readVerified(projectId: string, id: string): Promise<Tagged<VerifiedQuestion> | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  return readTagged('verified', fileOf(projectId, id), normalize(projectId));
}

export async function getVerified(projectId: string, id: string): Promise<VerifiedQuestion | null> {
  return (await readVerified(projectId, id))?.rec ?? null;
}

/**
 * Store `q` under its id. A new one is one atomic write; an existing one is a guarded read-modify-write that keeps
 * its `createdAt`, where a stale `base` refuses (409 record_changed). Null when an id is bad, `q` is not a record,
 * or the record went while the save waited for it.
 */
export async function writeVerified(projectId: string, q: VerifiedQuestion, base?: unknown): Promise<VerifiedQuestion | null> {
  const next = sanitizeVerified({ ...q, projectId });
  if (!isValidId(projectId) || !next) return null;
  const file = fileOf(projectId, next.id);
  if (!(await readVerified(projectId, next.id))) {
    await fs.promises.mkdir(dirOf(projectId), { recursive: true });
    await writeJsonAtomic(file, next);
    return next;
  }
  return lockedUpdate('verified', { projectId, id: next.id, file }, base, () => readVerified(projectId, next.id), async (existing) => {
    const kept = { ...next, createdAt: existing.createdAt };
    await writeJsonAtomic(file, kept);
    return kept;
  });
}
