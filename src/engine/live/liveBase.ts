// A Live dataset's base filters as the compiler takes them (semantic layer part 1, D13) — PURE.
//
// The stored steps (data/liveBaseFilters) go through the same adapter as a chart's filters
// (./liveSpec `adaptFilter`), once per question, into `CompileEnv.base`; every statement builder ANDs
// them in (./compile `whereOf`, ./profileSql `sampledFrom`). The one difference: where a chart's
// filter is SKIPPED with a warning (a column the dataset lacks, an empty list, a period that resolves
// to nothing), a base filter REFUSES — answering without it would be a wider number than the dataset
// allows, as a row access lock never skips either.

import type { FilterStep } from '../../data/transforms';
import type { LiveSettings } from '../../data/liveDataset';
import type { AdaptOpts, LiveColumn, LiveFilter, LiveRefusal } from './liveSpec';
import { adaptFilter, isRefusal, refuse } from './liveSpec';

export type LiveBase = { ok: true; base: LiveFilter[] } | LiveRefusal;

/** The steps as IR filters, or why one cannot be applied: a skip refuses `baseFilter`, a refusal passes through. */
export function liveBaseOf(steps: readonly FilterStep[] | undefined, columns: LiveColumn[], opts: AdaptOpts = {}): LiveBase {
  const base: LiveFilter[] = [];
  for (const s of steps ?? []) {
    const f = adaptFilter(s, columns, opts, []);
    if (isRefusal(f)) return f;
    if (!f) return refuse('baseFilter', s.column);
    base.push(f);
  }
  return { ok: true, base };
}

/** A Live block's base: refused outright when the stored list could not be read in full (`applyLive` marks it). */
export function baseOfLive(live: Pick<LiveSettings, 'baseFilters' | 'baseFiltersUnreadable'>, columns: LiveColumn[]): LiveBase {
  return live.baseFiltersUnreadable ? refuse('baseFilterUnreadable') : liveBaseOf(live.baseFilters, columns);
}
