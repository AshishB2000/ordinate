// What the Data model section says needs an admin's attention (semantic layer part 4, D8): items certified whose content
// moved since (`needs_review`), and retired items something still uses. METADATA ONLY, computed per request from the
// catalog's `status` section; a use is counted only for a retired item, so a large project pays nothing for the rest.

import * as catalog from '../app/catalog';
import { parseStatusRef, type StatusKind } from '../app/statusDocs';
import { usageCounts } from '../app/catalogIndex';
import { metricUsage } from './metricUsage';
import { termUsage } from './termUsage';
import { nameOf, statusFor } from './statusStore';

export interface ReviewItem { ref: string; name: string; kind: 'needs_review' | 'retired_used'; uses?: number }

export const REVIEW_SHOWN = 8;

/** needs_review first, then retired with uses > 0 (most used first); at most REVIEW_SHOWN. An unknown count is listed with no `uses`, never as 0. */
export async function reviewItems(projectId: string): Promise<ReviewItem[]> {
  const section = (await catalog.load(projectId)).status ?? {};
  const status = statusFor(projectId);
  const changed: ReviewItem[] = [];
  const retired: Array<{ ref: string; kind: StatusKind; id: string }> = [];
  for (const ref of Object.keys(section)) {
    const r = parseStatusRef(ref);
    if (!r) continue;
    if (section[ref].status === 'retired') retired.push({ ref, ...r });
    else if ((await status(ref))?.state === 'needs_review') {
      const name = await nameOf(projectId, ref);
      if (name !== null) changed.push({ ref, name, kind: 'needs_review' }); // a deleted item is not something to review
    }
  }
  let terms: Awaited<ReturnType<typeof termUsage>> | undefined;
  let datasets: Map<string, number> | undefined;
  const used: ReviewItem[] = [];
  for (const { ref, kind, id } of retired) {
    const name = await nameOf(projectId, ref);
    if (name === null) continue;
    let uses: number | undefined;
    try {
      if (kind === 'metric') uses = (await metricUsage(projectId, id)).total;
      else if (kind === 'term') uses = (terms ??= await termUsage(projectId))[id]?.total ?? 0;
      else uses = (datasets ??= await usageCounts(projectId)).get(ref) ?? 0;
    } catch (_) { /* unknown: listed without a count */ }
    if (uses === undefined || uses > 0) used.push({ ref, name, kind: 'retired_used', ...(uses !== undefined && { uses }) });
  }
  used.sort((a, b) => (b.uses ?? Infinity) - (a.uses ?? Infinity) || a.name.localeCompare(b.name));
  return [...changed.sort((a, b) => a.name.localeCompare(b.name)), ...used].slice(0, REVIEW_SHOWN);
}
