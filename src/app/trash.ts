// Trash — delete becomes a move, restore a move back. MAIN PROCESS ONLY.
//
// The files are src/app/trashStore.ts's business; this module decides WHAT
// moves:
//
//   · Deleting a DATASET takes its visuals with it, stamped `deletedWith`, so a
//     dataset's charts do not sit in the Visuals gallery pointing at nothing —
//     and restoring the dataset brings exactly those visuals back.
//   · Restoring a VISUAL whose dataset is still in the trash restores that
//     dataset too (only the dataset — its other visuals stay where the user
//     can see them), and says so: `restored` lists everything that came back.
//   · An ALERT rule lives inside alerts.json, so alertStore.deleteRule stashes
//     it itself and alertStore.restoreRule puts it back. A rule mirrored from a
//     dataset's "watch for anomalies" toggle is not a record the user wrote and
//     is deleted outright, as before.
//
// Kept RETENTION_DAYS, then purged by the refresh scheduler's tick
// (purgeExpired). "Delete permanently" and "Empty trash" purge early. A purged
// record's version history goes with it.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { RECORD_DIR, projectDir, projectsBase, isValidId, isRecordType } from './recordKinds';
import type { RecordType, FileRecordType } from './recordKinds';
import * as store from './trashStore';
import type { TrashEntry } from './trashStore';
import * as versions from './versions';
import * as visuals from '../analysis/visuals';
import * as alertStore from '../analysis/alertStore';
import * as recordFs from './recordFs';

export const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export interface TrashItem extends TrashEntry {
  daysLeft: number;
}

export interface Restored {
  type: RecordType;
  id: string;
  name: string;
}

// ── Change listeners (the sidebar's count badge) ────────────────────────────
const listeners: Array<(projectId: string) => void> = [];
export function onChange(fn: (projectId: string) => void): void {
  listeners.push(fn);
}
function changed(projectId: string): void {
  for (const fn of listeners) {
    try { fn(projectId); } catch (_) { /* a listener never breaks a delete */ }
  }
}

/** Whole days left before the purge takes it — 30 right after the delete. */
export function daysLeft(deletedAt: string, now = Date.now()): number {
  const at = Date.parse(deletedAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at + RETENTION_DAYS * DAY_MS - now) / DAY_MS));
}

function liveFile(projectId: string, type: FileRecordType, id: string): string {
  const base = projectDir(projectId);
  return base && isValidId(id) ? path.join(base, RECORD_DIR[type], id + '.json') : '';
}

async function exists(file: string): Promise<boolean> {
  try { await recordFs.access(file); return true; } catch (_) { return false; }
}

/** rename, or copy + remove when rename cannot cross whatever it has to. */
async function move(from: string, to: string): Promise<void> {
  if (!(await exists(from))) return;
  try {
    await recordFs.rename(from, to);
  } catch (_) {
    await recordFs.copyFile(from, to);
    await recordFs.rm(from, { force: true });
  }
}

async function moveToTrash(projectId: string, type: FileRecordType, id: string, deletedWith?: string): Promise<string | null> {
  const file = liveFile(projectId, type, id);
  if (!file) return null;
  let rec: any; // ponytail: any stored record
  try {
    rec = JSON.parse(await recordFs.readFile(file, 'utf8'));
  } catch (_) {
    return null;
  }
  if (!(await store.stash(projectId, type, id, rec, { deletedWith }))) return null;
  if (type === 'dataset') {
    const dir = store.trashDir(projectId, 'dataset');
    for (const n of await store.datasetFiles(path.dirname(file), id)) await move(path.join(path.dirname(file), n), path.join(dir, n));
  }
  await recordFs.rm(file, { force: true });
  return typeof rec.name === 'string' ? rec.name : '';
}

/**
 * Move a record to the trash. `cascaded` counts what went with it (a dataset's
 * visuals). Returns ok:false when there was nothing to move.
 */
export async function trashRecord(
  projectId: string,
  type: RecordType,
  id: string,
): Promise<{ ok: boolean; name?: string; cascaded?: number }> {
  if (!isRecordType(type) || !isValidId(projectId) || !isValidId(id)) return { ok: false };
  if (type === 'alert') {
    const ok = await alertStore.deleteRule(projectId, id);
    if (ok) changed(projectId);
    return { ok };
  }
  // The visuals first: if the dataset move fails they are still reachable
  // from its entry — restoring nothing would be worse than restoring both.
  let cascaded = 0;
  if (type === 'dataset' && (await exists(liveFile(projectId, 'dataset', id)))) {
    for (const v of await visuals.listVisuals(projectId)) {
      if (v.datasetId === id && (await moveToTrash(projectId, 'visual', v.id, id)) !== null) cascaded++;
    }
  }
  const name = await moveToTrash(projectId, type, id);
  if (name === null && !cascaded) return { ok: false };
  changed(projectId);
  return { ok: true, name: name || '', cascaded };
}

async function moveBack(projectId: string, type: RecordType, id: string): Promise<Restored | null> {
  const rec = await store.readEntry(projectId, type, id);
  if (!rec) return null;
  const { deletedAt: _at, deletedWith: _with, ...live } = rec;
  const name = typeof live.name === 'string' ? live.name : '';
  if (type === 'alert') {
    if (!(await alertStore.restoreRule(projectId, live))) return null;
    await store.removeEntry(projectId, type, id);
    return { type, id, name };
  }
  const file = liveFile(projectId, type, id);
  if (!file || (await exists(file))) return null; // never overwrite a live record
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  if (type === 'dataset') {
    const dir = store.trashDir(projectId, 'dataset');
    for (const n of await store.datasetFiles(dir, id)) await move(path.join(dir, n), path.join(path.dirname(file), n));
  }
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(live, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
  await recordFs.rm(store.entryPath(projectId, type, id), { force: true });
  return { type, id, name };
}

/**
 * Bring a record back. `restored[0]` is the one asked for; anything after it
 * came along (a dataset's visuals, or a visual's dataset).
 */
export async function restore(
  projectId: string,
  type: RecordType,
  id: string,
): Promise<{ ok: boolean; error?: string; restored: Restored[] }> {
  const restored: Restored[] = [];
  if (!isRecordType(type) || !isValidId(projectId) || !isValidId(id)) {
    return { ok: false, error: 'Unknown record.', restored };
  }
  const rec = await store.readEntry(projectId, type, id);
  if (!rec) return { ok: false, error: 'That item is no longer in the trash.', restored };

  // A visual cannot draw without its dataset: bring the dataset back first.
  let datasetBack: Restored | null = null;
  if (type === 'visual' && isValidId(rec.datasetId) && !(await exists(liveFile(projectId, 'dataset', rec.datasetId)))) {
    datasetBack = await moveBack(projectId, 'dataset', rec.datasetId);
  }
  const main = await moveBack(projectId, type, id);
  if (!main) {
    return { ok: false, error: 'It could not be restored — something with the same id is already there.', restored };
  }
  restored.push(main);
  if (datasetBack) restored.push(datasetBack);

  if (type === 'dataset') {
    for (const e of await store.listEntries(projectId)) {
      if (e.type === 'visual' && e.deletedWith === id) {
        const v = await moveBack(projectId, 'visual', e.id);
        if (v) restored.push(v);
      }
    }
  }
  changed(projectId);
  return { ok: true, restored };
}

/** Delete one entry for good, with its version history. */
export async function purge(projectId: string, type: RecordType, id: string): Promise<boolean> {
  if (!isRecordType(type) || !store.entryPath(projectId, type, id)) return false;
  await store.removeEntry(projectId, type, id);
  if (type !== 'alert') await versions.forget(projectId, type, id);
  changed(projectId);
  return true;
}

export async function empty(projectId: string): Promise<number> {
  const all = await store.listEntries(projectId);
  for (const e of all) {
    await store.removeEntry(projectId, e.type, e.id);
    if (e.type !== 'alert') await versions.forget(projectId, e.type, e.id);
  }
  if (all.length) changed(projectId);
  return all.length;
}

export async function list(projectId: string, now = Date.now()): Promise<TrashItem[]> {
  return (await store.listEntries(projectId)).map((e) => ({ ...e, daysLeft: daysLeft(e.deletedAt, now) }));
}

/**
 * Purge whatever has been in any project's trash for RETENTION_DAYS. Called by
 * the refresh scheduler's tick; a directory listing per project, so every
 * minute is cheap.
 */
export async function purgeExpired(now = Date.now()): Promise<number> {
  let ids: string[] = [];
  try {
    ids = (await recordFs.readdir(projectsBase())).filter((n) => isValidId(n));
  } catch (_) {
    return 0;
  }
  let n = 0;
  for (const pid of ids) {
    let here = 0;
    for (const e of await store.listEntries(pid)) {
      if (daysLeft(e.deletedAt, now) > 0) continue;
      await store.removeEntry(pid, e.type, e.id);
      if (e.type !== 'alert') await versions.forget(pid, e.type, e.id);
      here++;
    }
    if (here) changed(pid);
    n += here;
  }
  return n;
}
