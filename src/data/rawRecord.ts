// A dataset record read RAW, once per request — MAIN PROCESS. Moved out of
// ./rowAccess.ts unchanged, so the row rules (./rowAccess.ts) and the column rules
// (./columnGate.ts) share one read and one memo. Never through the as-of hooks,
// which swap in a snapshot's metadata.

import { ctx } from '../server/context';
import * as recordFs from '../app/recordFs';
import { entryPath } from '../app/trashStore';
import { datasetFilePath } from './datasetRecord';

export type Raw = Record<string, unknown>;

/** A per-request memo: the map for this request context (it dies with the request). */
export function memoOf<T>(m: WeakMap<object, Map<string, T>>): Map<string, T> {
  const store = ctx() as object;
  let inner = m.get(store);
  if (!inner) {
    inner = new Map();
    m.set(store, inner);
  }
  return inner;
}

const reads = new WeakMap<object, Map<string, Promise<Raw | null>>>();

/** What a record that does not parse reads as: rules that do not sanitize, so CLOSED (rowPolicy.policyFromRecord). */
const CORRUPT: Raw = Object.freeze({ rowPolicy: '\u0000unparseable', columnAccess: '\u0000unparseable' });

/** A file's text, or null when it is not there (ENOENT); any other failure rejects. */
function textOrNull(file: string): Promise<string | null> {
  if (!file) return Promise.resolve(null);
  return recordFs.readFile(file, 'utf8').catch((err: unknown) => {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return null;
    throw err;
  });
}

/**
 * The record as stored — live, else its Trash entry (NV-16): a trashed dataset keeps its rules, restorable,
 * so its versions, its capture and what was built from it stay governed. A record in neither place has no
 * rules: null (a purge forgets them, as removing the rules would). One that does not parse is CLOSED.
 * Any other failure REJECTS — never "no rules" — and is not remembered, so the next ask reads again.
 */
export function readRawRecord(projectId: string, id: string): Promise<Raw | null> {
  const memo = memoOf(reads);
  const key = `${projectId}\0${id}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = (async (): Promise<Raw | null> => {
      const live = datasetFilePath(projectId, id);
      // Live once more after a Trash miss: a restore writes the live record, then removes the entry, between our reads.
      const text = (await textOrNull(live)) ?? (await textOrNull(entryPath(projectId, 'dataset', id))) ?? (await textOrNull(live));
      if (text === null) return null;
      try {
        const raw: unknown = JSON.parse(text);
        return raw && typeof raw === 'object' ? (raw as Raw) : CORRUPT;
      } catch {
        return CORRUPT;
      }
    })();
    memo.set(key, hit);
    hit.catch(() => memo.delete(key));
  }
  return hit;
}
