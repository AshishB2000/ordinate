// The dataset half of an answer-cache key — MAIN PROCESS.
//
// src/engine/queryCache.ts keys an answer on (datasetId, updatedAt,
// pipelineHash, spec). The first three come off the dataset's metadata record
// (one small JSON read, no rows), which is also the trash check: a trashed
// dataset has no record, so it gets no key and nothing is served for it.
//
// `ambient()` is what every answer depends on without naming it in its spec:
// today's date (a relative period like "last 7 days" resolves against it, so a
// cached answer must not outlive the day) and the workspace calendar (week
// start and fiscal year move period boundaries).

import * as datasets from './datasets';
import { pipelineHash } from '../engine/queryCache';
import type { KeyParts } from '../engine/queryCache';
import { todayIso, getCalendar } from '../analysis/dateIntel';
import { asOfIso } from './asOf';

export async function keyParts(projectId: string, datasetId: string): Promise<KeyParts | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  return { datasetId, updatedAt: meta.updatedAt, pipelineHash: pipelineHash(meta.steps) };
}

export function ambient(): { day: string; cal: unknown; asOf?: string } {
  // `asOf`: inside an as-of read (src/data/asOf.ts) the answer is about a past
  // time, and a join may have read a snapshot of a dataset the key does not
  // name — so the time is part of the key. Absent (dropped by stableStringify)
  // for every ordinary read, which keeps their keys exactly as they were.
  return { day: todayIso(), cal: getCalendar(), asOf: asOfIso() };
}
