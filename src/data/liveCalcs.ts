// A Live dataset's calculated fields (semantic layer part 8, step 00a). PURE.
//
// Stored at the TOP LEVEL of the dataset record, beside `baseFilters` and `rowPolicy`, never inside `live`:
// every Live writer rebuilds `raw.live` from `sanitizeLive`, which never reads this key, so none can erase
// it or copy it. `applyLive` reads it into `meta.live.calculated` (in memory only), and never into
// `meta.columns`: this pod cannot compute a calc, so a picker must not offer one. Until a pod can, every
// question over a dataset that has them is refused (liveTarget, ipc/liveDatasets).

export type LiveCalcType = 'number' | 'text';
export interface LiveCalc { name: string; expression: string; type: LiveCalcType }

/** The most calculated fields a dataset keeps. */
export const MAX_LIVE_CALCS = 50;
export const MAX_CALC_EXPRESSION = 4_000;
export const MAX_CALC_NAME = 200;

/**
 * Does this Live block carry calculated fields this pod must refuse for: some it read, or a stored list it
 * could not read in full (`applyLive` marks it)? The ONE test the guards share, so none can drift apart.
 */
export function hasLiveCalcs(live: { calculated?: readonly unknown[]; calculatedUnreadable?: true } | undefined): boolean {
  return !!live && (live.calculatedUnreadable === true || (live.calculated?.length ?? 0) > 0);
}

/**
 * The calcs of an untrusted stored list, rebuilt as {name, expression, type}: the name trimmed, 1-200
 * characters; the expression 1-4,000; neither holds a NUL; the type `number` or `text`. What cannot be read
 * is dropped, never cut, so a second pass changes nothing. The first 50 are kept.
 */
export function sanitizeLiveCalcs(raw: unknown): LiveCalc[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveCalc[] = [];
  for (const o of raw) {
    if (out.length >= MAX_LIVE_CALCS) break;
    if (!o || typeof o !== 'object') continue;
    const { name, expression, type } = o as Record<string, unknown>;
    if (typeof name !== 'string' || typeof expression !== 'string' || (type !== 'number' && type !== 'text')) continue;
    const n = name.trim();
    if (!n || n.length > MAX_CALC_NAME || !expression || expression.length > MAX_CALC_EXPRESSION) continue;
    if (n.includes('\u0000') || expression.includes('\u0000')) continue;
    out.push({ name: n, expression, type });
  }
  return out;
}
