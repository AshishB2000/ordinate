// Verified questions (semantic layer part 3 D7) — MAIN PROCESS ONLY. One JSON file per question under
// userData/projects/<projectId>/verified/<id>.json. The rules (shape, caps, key) are ./verifiedRules.
//
// The store mirrors ./terms.ts: both ids UUID-checked before either reaches a path, atomic writes, a corrupt
// file skipped, the edit-conflict tag, and a sanitize that runs again on every read.
//
// A verified SQL question (./verifiedRules `VerifiedSqlQuestion`) is a file of the same folder: the chart readers
// (`listTagged`, `readManyTagged`) skip it as a pod older than this release does, and the `…Both` readers return each
// kind from the same one read.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isValidId, projectDir, RECORD_DIR } from '../app/recordKinds';
import * as recordFs from '../app/recordFs';
import { contentTag, lockedUpdate, readTagged, type Tagged } from '../app/editConflict';
import { sanitizeVerified, sanitizeVerifiedSql, type VerifiedQuestion, type VerifiedSqlQuestion } from './verifiedRules';
import { levelsOf, opens } from '../server/authz/folderGate'; // shared folders: it follows its dataset (docs/team-folders D3, D12)

const dirOf = (projectId: string): string => path.join(projectDir(projectId), RECORD_DIR.verified);
const fileOf = (projectId: string, id: string): string => path.join(dirOf(projectId), id + '.json');

async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await recordFs.rename(tmp, file);
}

// any: parsed stored JSON
const normalize = (projectId: string) => (data: any): VerifiedQuestion | null => sanitizeVerified(data && typeof data === 'object' ? { ...data, projectId } : null);
const normalizeSql = (projectId: string) => (data: any): VerifiedSqlQuestion | null => sanitizeVerifiedSql(data && typeof data === 'object' ? { ...data, projectId } : null); // any: parsed stored JSON

/** Each kind of question, as read from one listing or one read. */
export interface Both { spec: Tagged<VerifiedQuestion>[]; sql: Tagged<VerifiedSqlQuestion>[] }

const newestFirst = <T extends { rec: { updatedAt: string } }>(a: T, b: T): number => (a.rec.updatedAt < b.rec.updatedAt ? 1 : a.rec.updatedAt > b.rec.updatedAt ? -1 : 0);

/** Every question of the project of either kind with the tag of what is stored, newest `updatedAt` first. A corrupt file is skipped. */
export async function listBoth(projectId: string): Promise<Both> {
  const out: Both = { spec: [], sql: [] };
  if (!isValidId(projectId)) return out;
  let records;
  try {
    records = await recordFs.listRecords(dirOf(projectId));
  } catch (_) {
    return out; // none yet
  }
  for await (const r of records) {
    const id = r.name.slice(0, -5);
    if (!isValidId(id)) continue; // a stray or temp file
    const t = bothFromBody(projectId, r.text); // a corrupt one: null
    if (t && t.spec && t.spec.rec.id === id) out.spec.push(t.spec);
    if (t && t.sql && t.sql.rec.id === id) out.sql.push(t.sql);
  }
  out.spec.sort(newestFirst);
  out.sql.sort(newestFirst);
  // Shared folders: a chart question follows its dataset, an SQL one every dataset it reads (docs/team-folders D3, D12).
  const level = await levelsOf(projectId, 'dataset');
  if (!level) return out;
  return { spec: out.spec.filter((t) => level(t.rec.spec.datasetId) !== 'none'), sql: out.sql.filter((t) => t.rec.sql.datasetIds.every((id) => level(id) !== 'none')) };
}

/** Every chart question of the project with the tag of what is stored, newest `updatedAt` first. A corrupt file, or an SQL question, is skipped. */
export async function listTagged(projectId: string): Promise<Tagged<VerifiedQuestion>[]> {
  return (await listBoth(projectId)).spec;
}

/** A stored record's text (or a listed record's lazy text) read as either kind, in one parse; null when it is no question. */
function bothFromBody(projectId: string, body: string | (() => string)): { spec?: Tagged<VerifiedQuestion>; sql?: Tagged<VerifiedSqlQuestion> } | null {
  try {
    const data: unknown = JSON.parse(typeof body === 'string' ? body : body());
    const spec = normalize(projectId)(data);
    if (spec) return { spec: { rec: spec, tag: contentTag('verified', data) } };
    const sql = normalizeSql(projectId)(data);
    return sql ? { sql: { rec: sql, tag: contentTag('verified', data) } } : null;
  } catch (_) {
    return null;
  }
}

/** A stored record's text as `readVerified` reads it (re-sanitized, with its tag), or null when it is not a chart question. */
export function verifiedFromBody(projectId: string, body: string): Tagged<VerifiedQuestion> | null {
  return bothFromBody(projectId, body)?.spec ?? null;
}

/** A stored record's text as an SQL question, or null when it is not one. */
export function verifiedSqlFromBody(projectId: string, body: string): Tagged<VerifiedSqlQuestion> | null {
  return bothFromBody(projectId, body)?.sql ?? null;
}

/** The questions `ids` of either kind, in that order, from ONE read; a missing, corrupt or misnamed one is left out, as `listBoth` leaves it. */
export async function readManyBoth(projectId: string, ids: readonly string[]): Promise<Both> {
  const out: Both = { spec: [], sql: [] };
  if (!isValidId(projectId)) return out;
  const valid = ids.filter((id) => isValidId(id));
  const bodies = await recordFs.readMany(valid.map((id) => fileOf(projectId, id)));
  for (const id of valid) {
    const body = bodies.get(fileOf(projectId, id));
    const t = body === undefined ? null : bothFromBody(projectId, body);
    if (t && t.spec && t.spec.rec.id === id) out.spec.push(t.spec);
    if (t && t.sql && t.sql.rec.id === id) out.sql.push(t.sql);
  }
  return out;
}

/** The chart questions `ids`, in that order, from ONE read; a missing, corrupt or misnamed one (or an SQL question) is left out, as `listTagged` leaves it. */
export async function readManyTagged(projectId: string, ids: readonly string[]): Promise<Tagged<VerifiedQuestion>[]> {
  return (await readManyBoth(projectId, ids)).spec;
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

/** As the caller may read it: null in a folder they cannot open. (`readVerified` is the write path's, unfiltered: a save asks "does it exist?".) */
export async function getVerified(projectId: string, id: string): Promise<VerifiedQuestion | null> {
  const q = (await readVerified(projectId, id))?.rec ?? null;
  return q && (await opens(projectId, 'dataset', q.spec.datasetId)) ? q : null;
}

/** The SQL question `id`, or null (none, or a chart's question). */
export async function getVerifiedSql(projectId: string, id: string): Promise<VerifiedSqlQuestion | null> {
  if (!isValidId(projectId) || !isValidId(id)) return null;
  return (await readTagged('verified', fileOf(projectId, id), normalizeSql(projectId)))?.rec ?? null;
}

/** Store a NEW SQL question under its id (one atomic write); null when an id is bad, `q` is not one, or the id is taken. */
export async function writeVerifiedSql(projectId: string, q: VerifiedSqlQuestion): Promise<VerifiedSqlQuestion | null> {
  const next = sanitizeVerifiedSql({ ...q, projectId });
  if (!isValidId(projectId) || !next) return null;
  const file = fileOf(projectId, next.id);
  const held = await readManyBoth(projectId, [next.id]);
  if (held.spec.length || held.sql.length) return null; // a new question only: an SQL one is never edited in place
  await fs.promises.mkdir(dirOf(projectId), { recursive: true });
  await writeJsonAtomic(file, next);
  return next;
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
