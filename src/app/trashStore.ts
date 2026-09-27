// Trash on disk — the low half. MAIN PROCESS ONLY.
//
// A deleted record is MOVED to userData/projects/<projectId>/trash/<type>/
// <id>.json with `deletedAt` stamped on it (and `deletedWith` when another
// record's delete took it along). A dataset's Parquet files travel beside it.
//
// Moving rather than flagging in place is the whole design: every lister,
// search, palette, Home row, alert evaluation, report run and refresh tick
// reads the record directories, so a record that is not in them is gone to all
// of them at once — no `deletedAt` filter to remember at thirty call sites, and
// no scheduler quietly refreshing a dataset the user threw away.
//
// This half knows paths and files only and imports no record store, so a store
// (alertStore, whose rules share one alerts.json) can stash into it without an
// import cycle. src/app/trash.ts decides what moves where.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { projectDir, isValidId, isRecordType } from './recordKinds';
import type { RecordType } from './recordKinds';
import { snapshotFiles } from '../data/snapshotNames';

export interface TrashEntry {
  type: RecordType;
  id: string;
  name: string;
  deletedAt: string;
  /** The record whose delete took this one along — a dataset's visuals. */
  deletedWith?: string;
}

export function trashDir(projectId: string, type?: RecordType): string {
  const base = projectDir(projectId);
  if (!base) return '';
  return type ? path.join(base, 'trash', type) : path.join(base, 'trash');
}

export function entryPath(projectId: string, type: RecordType, id: string): string {
  const dir = trashDir(projectId, type);
  return dir && isRecordType(type) && isValidId(id) ? path.join(dir, id + '.json') : '';
}

/** A dataset's table files, as siblings of its trash entry. */
export function parquetNames(id: string): string[] {
  return [id + '.parquet', id + '.source.parquet'];
}

/** The table files plus its snapshots (strictly matched) found in `dir` — what travels with a dataset. */
export async function datasetFiles(dir: string, id: string): Promise<string[]> {
  let names: string[] = [];
  try { names = await fs.promises.readdir(dir); } catch (_) { /* no dir: just the tables */ }
  return parquetNames(id).concat(snapshotFiles(id, names));
}

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

/**
 * Write a record into the trash, stamping `deletedAt` (now) unless it carries
 * one. Returns false for a bad id/type. The caller removes the live copy AFTER
 * this succeeds, so a failure here leaves the record where it was.
 */
export async function stash(
  projectId: string,
  type: RecordType,
  id: string,
  // ponytail: any record shape — trash keeps it verbatim plus two stamps
  record: any,
  opts: { deletedWith?: string; now?: Date } = {},
): Promise<boolean> {
  const file = entryPath(projectId, type, id);
  if (!file || !record || typeof record !== 'object') return false;
  const out = { ...record, deletedAt: (opts.now || new Date()).toISOString() };
  if (opts.deletedWith && isValidId(opts.deletedWith)) out.deletedWith = opts.deletedWith;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, out);
  return true;
}

// ponytail: the stored record, whatever its type — or null when there is none
export async function readEntry(projectId: string, type: RecordType, id: string): Promise<any> {
  const file = entryPath(projectId, type, id);
  if (!file) return null;
  try {
    const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

/** Remove an entry for good — its JSON and, for a dataset, its Parquet files. */
export async function removeEntry(projectId: string, type: RecordType, id: string): Promise<void> {
  const file = entryPath(projectId, type, id);
  if (!file) return;
  await fs.promises.rm(file, { force: true });
  if (type === 'dataset') {
    for (const n of await datasetFiles(path.dirname(file), id)) await fs.promises.rm(path.join(path.dirname(file), n), { force: true });
  }
}

/** Every entry in one project's trash, newest-deleted first. Corrupt files are skipped. */
export async function listEntries(projectId: string): Promise<TrashEntry[]> {
  const root = trashDir(projectId);
  if (!root) return [];
  const out: TrashEntry[] = [];
  let types: string[] = [];
  try {
    types = await fs.promises.readdir(root);
  } catch (_) {
    return [];
  }
  for (const type of types) {
    if (!isRecordType(type)) continue;
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(path.join(root, type));
    } catch (_) {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!isValidId(id)) continue;
      const rec = await readEntry(projectId, type, id);
      if (!rec || typeof rec.deletedAt !== 'string') continue;
      const entry: TrashEntry = {
        type, id,
        name: typeof rec.name === 'string' && rec.name.trim() ? rec.name : 'Untitled',
        deletedAt: rec.deletedAt,
      };
      if (typeof rec.deletedWith === 'string') entry.deletedWith = rec.deletedWith;
      out.push(entry);
    }
  }
  out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  return out;
}
