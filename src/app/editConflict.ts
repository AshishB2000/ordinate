// Compare-and-set for whole-document editors — MAIN (docs/edit-conflicts/00-design.md).
//
// An editor holds the record's CONTENT TAG from the reply it opened (or last
// saved) with and sends it back as `base`. Each store's update function runs
// `lockedUpdate`: inside `recordFs.locked` on the record's own path (every pod)
// it loads the stored record, and a `base` that is not the stored record's tag
// refuses the save, untouched — `ERECORDCHANGED`, which the RPC route answers
// 409 `record_changed` with the catalog's sentence and the current tag. No
// `base` keeps last-writer-wins (automation, field patches from a list).
//
// The tag hashes what is STORED (sanitized, through `recordDiff.contentOf`, the
// version history's content keys) in canonical key order, and is computed on
// read — never stored, so the record's bytes do not change. Saved views,
// favourites and stamps are not content: they never make an open editor stale.

import { createHash } from 'crypto';
import { canonical, contentOf, type ContentType } from '../analysis/recordDiff';
import { serverDataDir } from '../server/context';
import { recordChanged } from './editConflictMessages';
import * as recordFs from './recordFs';

/** The push an open editor of the record hears when another save moved its tag. */
export const SAVED_CHANNEL = 'hub:record-saved';

export interface Saved {
  projectId: string;
  type: ContentType;
  id: string;
  tag: string;
}

/** sha256 (base64url) of the canonical JSON of the record's content keys. */
export function contentTag(type: ContentType, rec: unknown): string {
  return createHash('sha256').update(canonical(contentOf(type, rec))).digest('base64url');
}

/** `existing`'s tag, after refusing a `base` that is not it. An absent base (undefined or null) is last-writer-wins. */
export function checkBase(type: ContentType, existing: unknown, base: unknown): string {
  const tag = contentTag(type, existing);
  if (base !== undefined && base !== null && base !== tag) throw Object.assign(new Error(recordChanged(type)), { code: 'ERECORDCHANGED', tag });
  return tag;
}

/** A reply that IS the record (`visual:get`, `story:get`, …) with its tag on it; null stays null. */
export function tagged<T extends object>(type: ContentType, rec: T | null): (T & { tag: string }) | null {
  return rec ? { ...rec, tag: contentTag(type, rec) } : null;
}

export function isRecordChanged(err: unknown): err is Error & { code: 'ERECORDCHANGED'; tag: string } {
  return (err as { code?: unknown } | null)?.code === 'ERECORDCHANGED';
}

/**
 * One guarded read-modify-write of a record: hold `at.file`, load, check `base`,
 * apply. Null when the record is gone (`apply` never runs). After the commit, a
 * save that moved the tag is pushed to the project's readers, so another open
 * editor of it learns at once.
 */
export async function lockedUpdate<T>(
  type: ContentType,
  at: { projectId: string; id: string; file: string },
  base: unknown,
  load: () => Promise<T | null>,
  apply: (existing: T) => Promise<T>,
): Promise<T | null> {
  let before = '';
  const saved = await recordFs.locked(at.file, async () => {
    const existing = await load();
    if (!existing) return null;
    before = checkBase(type, existing, base);
    return apply(existing);
  });
  if (saved) {
    const tag = contentTag(type, saved);
    if (tag !== before) announce({ projectId: at.projectId, type, id: at.id, tag });
  }
  return saved;
}

/** To every open tab of the project's readers. Ids and a hash only — nothing a reader cannot read. Never throws. */
function announce(s: Saved): void {
  if (serverDataDir() === null) return; // the desktop's self-checks: no tabs
  try {
    // Lazy, as comments and alerts push: that module reaches the job runner and the pool.
    (require('../server/jobs/schedules') as typeof import('../server/jobs/schedules')).pushToReaders(s.projectId, SAVED_CHANNEL, s);
  } catch (_) {
    // Outside a request (no org to address): nobody to tell. The 409 is the guarantee.
  }
}
