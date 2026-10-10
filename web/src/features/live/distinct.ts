// A column's distinct values (`dataset:distinct`) — the ONE call every picker
// makes (docs/live-data/log.md, L2.6's leftover).
//
// A Live dataset holds no rows, so its values are a schema sync's sample, and
// there may be no list to give: never synced, not sampled, or not a column a
// list is kept for. The server says so in a typed REPLY (200, `ok: false`) —
// an expected state, not an HTTP error — and it is THROWN here as a
// LiveRefusalError, so no caller can read it as "this column has no values"
// (D6). The error keeps the server's sentence and its `reason`.

import { rpc, type RpcInput } from '../../api/client';
import { replyError } from './refusal';

export interface DistinctValues {
  values: string[];
  /** Matching values before the cap. */
  total: number;
  /** A Live dataset's: the list and the total are a sample's, of `sampleRows` rows. */
  approximate?: true;
  sampleRows?: number;
}

/** Why a Live column has no list of values (src/data/liveProfile.ts `UnlistedReason`). */
export type UnlistedReason = 'notSynced' | 'notSampled' | 'notListed';

export async function distinctValues(input: RpcInput<'dataset:distinct'>): Promise<DistinctValues> {
  const r = (await rpc('dataset:distinct', input)) as DistinctValues | { ok: false };
  if ('ok' in r) throw replyError(r, 'The values could not be loaded.');
  return r;
}
