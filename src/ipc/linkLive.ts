// A link with a Live side (docs/assistant/00-design.md, "A pair with a Live side") — MAIN PROCESS ONLY.
//
// A relationship's full-table counts (`verified`, the warning) need both tables in one engine. Two copies: ours
// (./relationships `keyStats`). Two Live datasets on ONE connection: that warehouse, in ONE statement
// (engine/live/compileKeyMatch) through `liveLookup` (`warehouse()`, the budget, the daily limit under FROM's id, the
// cache keyed on both epochs), under the caller's row lock on each side (`withLockOf`, nested), each side inside the date
// range its table requires (liveDateRange `lookupRequired`, as the card's key counts are). Any other mix (a Live
// dataset and a copy, Live datasets on two connections) is said, never counted: `linkBlocked`'s catalog sentence, on
// the Assistant's card (./answerLink) and as `relationship:save`'s typed refusal, so a stale card or a direct call
// gets the same words.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import type { Lock } from '../data/rowLock';
import { isLive } from '../data/liveDataset';
import type { KeyStats } from '../analysis/joinJs';
import type { RelEnd, VerifiedRange } from '../analysis/relationships';
import * as say from '../ai/sourceAnswerMessages';
import * as msg from '../engine/liveQueryMessages';
import { compileKeyMatch, keyStatsFromRow } from '../engine/live/compileKeyMatch';
import { liveLookup } from '../engine/live/liveQuery';
import type { LiveFailure } from '../engine/live/liveQuery';
import { adaptFilters, refuse } from '../engine/live/liveSpec';
import * as dateRange from '../engine/live/liveDateRange';
import type { LiveTarget } from '../engine/live/liveTarget';
import { withLockOf } from './rowDoors';

const connOf = (m: DatasetMeta): string => (m.origin?.kind === 'connection' ? m.origin.connId : '');

/**
 * Why a link between these two cannot be saved here (`why`, a catalog sentence) and the Live datasets whose copies would
 * let it (`copy`: the Live side beside a copy; both on two connections, since a copy of one is still Live beside a
 * copy); or null: two copies, or two Live datasets on one connection.
 */
export function linkBlocked(from: DatasetMeta, to: DatasetMeta): { why: string; copy: string[] } | null {
  const [a, b] = [isLive(from), isLive(to)];
  if (!a && !b) return null;
  if (a && b) return connOf(from) && connOf(from) === connOf(to) ? null : { why: say.linkLiveApart(), copy: [from.id, to.id] };
  const live = a ? from : to;
  return { why: say.linkLiveMixed(live.name), copy: [live.id] };
}

/**
 * One side's filters and env: the caller's lock as the compiler's filters (adaptFilters throws on a term step: a lock
 * holds none), then the date range its table requires (`lookupRequired`), or the refusal naming a required column no
 * default can fill.
 */
function sideOf(t: LiveTarget, lock: Lock | null) {
  const f = adaptFilters(lock ? [...lock.steps] : ([] as FilterStep[]), t.columns, {});
  return f.ok ? dateRange.lookupRequired(t, f.filters) : f;
}

/**
 * A link's full-table counts when a side is Live: the warehouse's, or the typed refusal (`linkBlocked`'s sentence, the
 * executor's, or a row it could not read). Null when neither side is Live: the copies' engine counts it.
 */
export async function liveLinkStats(projectId: string, fromEnd: RelEnd, toEnd: RelEnd): Promise<{ ok: true; stats: KeyStats; range?: VerifiedRange; note?: string } | LiveFailure | null> {
  const from = await datasets.getDatasetMeta(projectId, fromEnd.datasetId);
  const to = await datasets.getDatasetMeta(projectId, toEnd.datasetId);
  if (!from || !to || (!isLive(from) && !isLive(to))) return null;
  const blocked = linkBlocked(from, to);
  if (blocked) return { ok: false, code: 'live_refused', error: blocked.why };
  return withLockOf(projectId, from.id, (fromLock) => withLockOf(projectId, to.id, async (toLock) => {
    let ranged: { range?: VerifiedRange; note?: string } = {};
    const r = await liveLookup(projectId, from.id, (f, t) => {
      if (!t || t.connectionId !== f.connectionId) return refuse('badQuery'); // one statement is one warehouse's
      const [fs, ts] = [sideOf(f, fromLock), sideOf(t, toLock)];
      if (!fs.ok) return fs;
      if (!ts.ok) return ts;
      // Both sides' ranges are REQUIRED_RANGE resolved now: one range, one sentence, whichever side needed it.
      const range = fs.range ?? ts.range;
      if (range) ranged = { range, note: fs.notes[0] ?? ts.notes[0] };
      return compileKeyMatch({ column: fromEnd.column, env: fs.env, lock: fs.filters }, { column: toEnd.column, env: ts.env, lock: ts.filters });
    }, to.id);
    const stats = r.ok ? keyStatsFromRow(r.rows[0]) : null;
    return stats ? { ok: true as const, stats, ...ranged } : r.ok ? { ok: false as const, code: 'live_failed' as const, error: msg.liveWarehouseFailed() } : r;
  }, [toEnd.column]), [fromEnd.column]);
}
