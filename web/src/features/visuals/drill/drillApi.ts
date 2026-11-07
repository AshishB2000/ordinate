// `visual:drillDown` as a screen calls it (src/ipc/drillDown.ts): a clicked mark → the steps behind it and the next
// level's encoding. It never throws: a missing channel (an older pod) or a failed call is `{ ok: false }`, so a click
// that cannot drill leaves the screen as it was. Nothing here computes a figure.

import { rpc, type RpcInput } from '../../../api/client';
import type { Encoding, FilterStep } from '../encoding';

export type DrillDownReply =
  | { ok: true; available: true; encoding: Encoding; steps: FilterStep[]; crumb: { column: string; label: string; next: string } }
  | { ok: true; available: false; reason: string }
  | { ok: false; error: string };

export const DRILL_FAILED = 'This chart could not drill down. Try again.';

export async function drillDown(input: RpcInput<'visual:drillDown'>): Promise<DrillDownReply> {
  try {
    const r = (await rpc('visual:drillDown', input)) as DrillDownReply | null;
    return r && typeof r === 'object' && 'ok' in r ? r : { ok: false, error: DRILL_FAILED };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : DRILL_FAILED };
  }
}
