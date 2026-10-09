// Fresh on ask in the dataset record (docs/live-data/00-plan.md L3.1) — the two
// METADATA-ONLY writes: the setting (`dataset:update`'s `freshOnAsk`), and the
// stamp of a pull's start (src/data/freshOnAsk.ts). MAIN PROCESS ONLY.
//
// Both read-modify-write the record's raw JSON through datasetRecord's
// `serialized` chain, like the quality and incremental writers: no table is
// read, `updatedAt` never moves (it keys the answer cache), and a write racing
// another metadata write of the same record on this pod waits its turn. The
// record lives in Postgres `records` when the server has DATABASE_URL, so a
// stamp written here is what every pod reads.

import { isValidId } from '../app/ids';
import { datasetFilePath, serialized } from './datasetRecord';
import { sanitizeOrigin } from './datasetOrigin';
import { sanitizeIncremental } from './incremental';
import { parseMaxStaleness, sanitizeFreshOnAsk } from './freshOnAskRule';
import type { FreshOnAsk } from './freshOnAskRule';
import { freshOnAskNeedsIncremental, freshOnAskNotForLive, freshOnAskNotSet, freshOnAskRange } from './freshOnAskMessages';

type Refusal = { ok: false; error: string };

/** The record's sanitized block, in the raw JSON's own terms. */
function current(raw: Record<string, unknown>): { fo: FreshOnAsk | undefined; incrementalOn: boolean; live: boolean } {
  const live = raw.mode === 'live';
  const incrementalOn = sanitizeIncremental(raw.incremental, sanitizeOrigin(raw.origin)?.kind)?.enabled === true;
  return { fo: sanitizeFreshOnAsk(raw.freshOnAsk, { incrementalOn, live }), incrementalOn, live };
}

/**
 * Turn fresh on ask on (`{ maxStalenessSec }`) or off (`null`). Refused, with
 * the catalog's sentence, on a Live dataset and without incremental refresh —
 * checked inside the write, against the record as it is then. A new age keeps
 * the last pull's stamp, so changing it cannot start a second pull at once.
 */
export async function setFreshOnAsk(
  projectId: string,
  id: string,
  value: unknown,
): Promise<{ ok: true; freshOnAsk: { maxStalenessSec: number } | null } | Refusal> {
  if (!isValidId(projectId) || !isValidId(id)) return { ok: false, error: freshOnAskNotSet() };
  let sec: number | null = null;
  if (value !== null) {
    sec = parseMaxStaleness(value && typeof value === 'object' ? (value as { maxStalenessSec?: unknown }).maxStalenessSec : undefined);
    if (sec === null) return { ok: false, error: freshOnAskRange() };
  }
  const res = await serialized(datasetFilePath(projectId, id), (raw): 'ok' | 'live' | 'incremental' => {
    if (sec === null) {
      delete raw.freshOnAsk;
      return 'ok';
    }
    const { fo, incrementalOn, live } = current(raw);
    if (live) return 'live';
    if (!incrementalOn) return 'incremental';
    raw.freshOnAsk = { maxStalenessSec: sec, ...(fo?.triggeredAt ? { triggeredAt: fo.triggeredAt } : {}) };
    return 'ok';
  });
  if (res === false) return { ok: false, error: freshOnAskNotSet() };
  if (res === 'live') return { ok: false, error: freshOnAskNotForLive() };
  if (res === 'incremental') return { ok: false, error: freshOnAskNeedsIncremental() };
  return { ok: true, freshOnAsk: sec === null ? null : { maxStalenessSec: sec } };
}

/**
 * Record that a pull started at `at` (ISO). False — nothing written that
 * matters — when fresh on ask is no longer on for the record.
 */
export async function stampTriggered(projectId: string, id: string, at: string): Promise<boolean> {
  if (!isValidId(projectId) || !isValidId(id)) return false;
  const res = await serialized(datasetFilePath(projectId, id), (raw) => {
    const { fo } = current(raw);
    if (!fo) return false;
    raw.freshOnAsk = { maxStalenessSec: fo.maxStalenessSec, triggeredAt: at };
    return true;
  });
  return res === true;
}
