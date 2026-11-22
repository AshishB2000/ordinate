// The weekly check (docs/issues-board/00-design.md). For one project: read the stored conversations and thumbs since the last check
// (./read.ts), find the signals, group them, store them (growing an issue, reopening a resolved one), name the new groups, sweep.
//
// NO ENGINE QUERY. Nothing here reads a dataset's rows, runs SQL on one or computes a figure; a test spies on every query path.
// The one model call is a group's title and fix, told question texts and signal names only (src/ai/issueName.ts).
// The one outbound call besides it is the embedding of question texts, only when the org set an embedding model up (a failure falls
// back to words). No tracker is ever called from here.

import * as analyze from '../../ai/analyze';
import * as execConfig from '../../app/execConfig';
import { listDatasets } from '../../data/datasets';
import { fingerprint, FINGERPRINT_BATCH, minSimilarity } from '../../ai/fingerprints';
import { bySimilarMeaning, bySimilarWords, groupSignals, MAX_CLUSTERED, type Similar } from '../../ai/issueGroups';
import { nameUser, NAME_SYSTEM, parseName, type NameInput } from '../../ai/issueName';
import { logger } from '../../app/logger';
import { currentFingerprintModel } from '../aiConfig';
import { ctx } from '../context';
import { defineJob } from '../jobs/runner';
import * as store from './db';
import { fallbackFor } from './fallback';
import { read } from './read';
import type { Signal } from '../../ai/issueSignals';

/** The first check reads this far back. */
const FIRST_DAYS = 7;
/** Groups named by the model in one check. */
export const NAMES_PER_RUN = 10;
/** Question texts embedded in one check. */
const MAX_EMBEDDED = 500;
const EVERY_MS = 6 * 3_600_000;

/** Words, or words and meaning when the org set an embedding model up. A failed embedding is words alone. */
async function similarity(signals: readonly Signal[]): Promise<Similar> {
  const pick = currentFingerprintModel();
  if (!pick) return bySimilarWords;
  const texts = [...new Set(signals.filter((s) => !s.key).map((s) => s.question))].slice(0, Math.min(MAX_EMBEDDED, MAX_CLUSTERED));
  const vectors = new Map<string, ArrayLike<number>>();
  for (let i = 0; i < texts.length; i += FINGERPRINT_BATCH) {
    const part = texts.slice(i, i + FINGERPRINT_BATCH);
    const r = await fingerprint(part, pick, { purpose: 'query', quiet: true });
    if (!r.ok) return bySimilarWords;
    part.forEach((t, n) => vectors.set(t, r.vectors[n]));
  }
  return bySimilarMeaning(vectors, minSimilarity(pick));
}

/** One model call for one group; the app's own words when it is off, fails or says something that does not pass. */
async function nameOne(org: string, item: store.ToName, datasets: ReadonlyMap<string, string>, ready: boolean): Promise<void> {
  const own = fallbackFor(item);
  if (!ready) return store.setFallback(org, item.id, own.title, own.fix);
  const input: NameInput = {
    signals: item.signals, names: item.labels, datasets: item.datasetIds.flatMap((d) => (datasets.has(d) ? [datasets.get(d)!] : [])), questions: item.questions,
  };
  const { rawText, error } = await analyze.dispatch(NAME_SYSTEM, [{ role: 'user', text: nameUser(input) }]);
  const named = error ? ({ ok: false } as const) : parseName(rawText ?? '');
  if (named.ok) await store.setName(org, item.id, named.title, named.fix);
  else await store.setFallback(org, item.id, own.title, own.fix);
}

export interface CheckResult extends store.Applied { named: number; swept: number }

/** The check for one project, now. The caller is in the org's context. Throws on a database failure. */
export async function checkProject(projectId: string, since?: Date | null): Promise<CheckResult> {
  const org = ctx().org.id;
  const from = new Date((since ?? new Date(Date.now() - FIRST_DAYS * 86_400_000)).getTime() - 86_400_000);
  const signals = await read(org, projectId, from);
  const groups = groupSignals(signals, await similarity(signals));
  const applied = await store.apply(org, projectId, groups);
  const swept = await store.sweep(org, projectId); // before naming: an issue that lost signals is renamed from what is left
  const todo = await store.toName(org, projectId, NAMES_PER_RUN);
  const ready = todo.length > 0 && (await execConfig.executionReady().catch(() => false));
  const names = new Map<string, string>();
  if (todo.length) for (const d of await listDatasets(projectId)) names.set(d.id, d.name); // names only
  let named = 0;
  for (const item of todo) {
    try {
      await nameOne(org, item, names, ready);
      named += 1;
    } catch (err) {
      logger.warn('[issues] a group could not be named:', err instanceof Error ? err.name : 'error'); // the code only: never a prompt
      const own = fallbackFor(item);
      await store.setFallback(org, item.id, own.title, own.fix);
    }
  }
  return { ...applied, named, swept };
}

/** Every due project of the org. Past `stopAt` it starts no new one and says so (true), as the runner's contract asks. */
export async function checkOrg(stopAt: number): Promise<boolean> {
  const org = ctx().org.id;
  for (const p of await store.dueProjects(org)) {
    if (Date.now() >= stopAt) return true;
    try {
      await checkProject(p.projectId, p.since);
      await store.stamp(org, p.projectId);
    } catch (err) {
      logger.warn('[issues] the weekly check failed:', err instanceof Error ? err.name : 'error');
      await store.failed(org, p.projectId, 'failed');
    }
  }
  return store.hasRequests(org); // a "Check now" that came in during the run: due again at once
}

let wired = false;
/** Declares the job (src/server/app.ts, with a database). Once per process: a second app in one process shares it. */
export function wireIssuesJob(): void {
  if (wired) return;
  wired = true;
  defineJob('issues:weekly', { everyMs: EVERY_MS, run: (_target, stopAt) => checkOrg(stopAt) });
}
