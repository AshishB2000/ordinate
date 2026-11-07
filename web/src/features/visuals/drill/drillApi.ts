// `visual:drillDown` as a screen calls it (src/ipc/drillDown.ts): a clicked mark → the steps behind it and the next
// level's encoding. It never throws: a missing channel (an older pod) or a failed call is `{ ok: false }`, so a click
// that cannot drill leaves the screen as it was. Nothing here computes a figure.

import { rpc, type RpcInput } from '../../../api/client';
import type { Encoding, FilterStep } from '../encoding';
import { DRILL_CHART_TYPES, grainWord, nextGrain, nextLevel, type NavHierarchy } from '../../../../../src/analysis/drillLevels.ts';
import type { DateGrain } from '../../../../../src/analysis/categoryKey.ts';

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

/** What a drill would go to, in the words the sheet uses ("by state", "by month"), or null: the click stays inert. */
export function drillableAxis(a: {
  chartType: string;
  encoding: Encoding;
  category: { kind?: string; grain?: string } | undefined;
  hierarchies: readonly NavHierarchy[];
  ladder: readonly DateGrain[];
}): { next: string; word: string } | null {
  if (!DRILL_CHART_TYPES.has(a.chartType)) return null;
  if (a.category?.kind === 'date') {
    const next = nextGrain(a.ladder, a.category.grain as DateGrain);
    return next ? { next, word: grainWord(next, a.ladder) } : null;
  }
  const down = nextLevel(a.hierarchies, a.encoding.category);
  return down ? { next: down.next, word: down.next } : null;
}
