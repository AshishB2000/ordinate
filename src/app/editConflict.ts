// Compare-and-set for whole-document editors — MAIN (docs/edit-conflicts/00-design.md).
//
// An editor holds the record's CONTENT TAG from the reply it opened (or last
// saved) with and sends it back as `base`. Each store's update function runs
// `lockedUpdate`: inside `recordFs.locked` on the record's own path (every pod)
// it reads the stored record, and a `base` that is not its tag refuses the
// save, untouched — `ERECORDCHANGED`, which the RPC route answers 409
// `record_changed` with the catalog's sentence and the current tag. No `base`
// keeps last-writer-wins (automation, field patches from a list).
//
// The tag hashes the record AS STORED — the parsed bytes, before any read-time
// repair (a sanitizer that mints a fresh id for a bad or duplicate one would
// otherwise give a raw-imported record a new tag on every read) — and only the
// keys the channel's save writes (`recordDiff.SAVE_KEYS`), in canonical order.
// It is computed on read and never stored. The open reply and the compare
// inside the lock each take the record and its tag from ONE read (`readTagged`).

import { createHash } from 'crypto';
import { canonical, savedPart, type SaveKind } from '../analysis/recordDiff';
import { serverDataDir } from '../server/context';
import { recordChanged } from './editConflictMessages';
import * as recordFs from './recordFs';

/** The push an open editor of the record hears when another save moved its tag. */
export const SAVED_CHANNEL = 'hub:record-saved';

export interface Saved {
  projectId: string;
  type: SaveKind;
  id: string;
  tag: string;
}

/** A record as the editor gets it, and the tag of what is stored. */
export interface Tagged<T> {
  rec: T;
  tag: string;
}

/** sha256 (base64url) of the canonical JSON of the keys `kind`'s save writes. */
export function contentTag(kind: SaveKind, rec: unknown): string {
  return createHash('sha256').update(canonical(savedPart(kind, rec))).digest('base64url');
}

/**
 * ONE read of a record file: the store's own `normalize` of it, and the tag of
 * the bytes as stored. Null when it is missing, unreadable or not a record.
 */
export async function readTagged<T>(kind: SaveKind, file: string, normalize: (data: any) => T | null): Promise<Tagged<T> | null> { // any: parsed stored JSON
  try {
    const data: unknown = JSON.parse(await recordFs.readFile(file, 'utf8'));
    const rec = normalize(data);
    return rec ? { rec, tag: contentTag(kind, data) } : null;
  } catch (_) {
    return null;
  }
}

/** A reply that IS the record (`visual:get`, `story:get`, …): the record with its stored tag on it; null stays null. */
export function recordReply<T extends object>(t: Tagged<T> | null): (T & { tag: string }) | null {
  return t ? { ...t.rec, tag: t.tag } : null;
}

export function isRecordChanged(err: unknown): err is Error & { code: 'ERECORDCHANGED'; tag: string } {
  return (err as { code?: unknown } | null)?.code === 'ERECORDCHANGED';
}

/**
 * One guarded read-modify-write of a record: hold `at.file`, read it (`read`,
 * the store's `readTagged`), refuse a `base` that is not its stored tag, apply.
 * Null when the record is gone (`apply` never runs). `apply` returns the record
 * exactly as it writes it, so its tag is the stored one. After the commit, a
 * save that moved the tag is pushed to the project's writers, so another open
 * editor of it learns at once.
 */
export async function lockedUpdate<T>(
  kind: SaveKind,
  at: { projectId: string; id: string; file: string },
  base: unknown,
  read: () => Promise<Tagged<T> | null>,
  apply: (existing: T) => Promise<T>,
): Promise<T | null> {
  let before = '';
  const saved = await recordFs.locked(at.file, async () => {
    const cur = await read();
    if (!cur) return null;
    if (base !== undefined && base !== null && base !== cur.tag) {
      throw Object.assign(new Error(recordChanged(kind)), { code: 'ERECORDCHANGED', tag: cur.tag });
    }
    before = cur.tag;
    return apply(cur.rec);
  });
  if (saved) {
    const tag = contentTag(kind, saved);
    if (tag !== before) announce({ projectId: at.projectId, type: kind, id: at.id, tag });
  }
  return saved;
}

/**
 * To the open tabs of the project's WRITERS — only they can have an editor open.
 * Ids and a hash only. Never throws. Cost: one writers lookup and one push per
 * writer for each save that changed what an editor holds.
 */
function announce(s: Saved): void {
  if (serverDataDir() === null) return; // the desktop's self-checks: no tabs
  try {
    // Lazy, as comments and alerts push: that module reaches the job runner and the pool.
    (require('../server/jobs/schedules') as typeof import('../server/jobs/schedules')).pushToWriters(s.projectId, SAVED_CHANNEL, s);
  } catch (_) {
    // Outside a request (no org to address): nobody to tell. The 409 is the guarantee.
  }
}
