// The fingerprint job (docs/assistant/00-design.md "Scale rules", PR 7c): fingerprints are made here, never inside a
// save. MAIN PROCESS, server mode with a database only.
//
// One row per org in the jobs table (`search:fingerprints`, ./jobs/runner): a run is a claim, FOR UPDATE SKIP LOCKED
// under a heartbeat lease, so two pods never run one org's job at once (a pod stalled past its lease can be overtaken;
// the second run then sends what the first had not saved, and the upsert keeps one row per item and model). No second
// lock is taken: the claim is the one the runner already holds, and a run is bounded.
//
// A run, for the org's model (Admin → AI) where the vector table exists:
//   - for each project, the items whose (text hash, model) has no row (./fingerprintStore staleTexts), at most RUN_TEXTS
//     a run, sent FINGERPRINT_BATCH at a time with purpose 'document', each batch saved as it comes back;
//   - a project the model now covers drops the rows of any other model, and of items gone (`tidy`), so a model change
//     refingerprints in the background and the search never reads another model's rows meanwhile;
//   - a failure (provider down, a rate limit, a key refused) stops the run: what was not saved is still stale, so the
//     next run sends it. It is logged once per org and code, never a text;
//   - a batch the provider REFUSES (400, 413, 422: what it was sent, not the provider) is sent again one text at a time:
//     the others are saved, and each text refused alone gets an attempt (./fingerprintStore refused); after MAX_ATTEMPTS
//     it is skipped for a day, logged once. Three refused alone and none taken is the provider refusing everything, not
//     a text: the run stops, nothing recorded. A changed text is a new hash, with fresh attempts;
//   - past RUN_TEXTS, or the runner's deadline, it returns true and the runner queues it again at once.
// With no model set, nothing is read and nothing is sent.

import { logger } from '../app/logger';
import { fingerprint, FINGERPRINT_BATCH } from '../ai/fingerprints';
import { currentFingerprintModel } from './aiConfig';
import { ctx } from './context';
import { defineJob } from './jobs/runner';
import * as store from './fingerprintStore';
import { vectorLiteral, vectorPlace } from './vectorStore';

export const FINGERPRINT_JOB = 'search:fingerprints';
export const FINGERPRINT_EVERY_MS = 2 * 60_000;
/** Texts sent in one run at most: five requests. */
export const RUN_TEXTS = 500;

const logged = new Set<string>();
function once(code: string, line: string): void {
  const key = `${ctx().org.id}\0${code}`;
  if (logged.has(key)) return;
  logged.add(key);
  logger.warn(`[fingerprints] ${line} (${code}) for org ${ctx().org.id}; further ones of this kind are not logged.`);
}
const failedOnce = (code: string): void => once(code, 'a batch was not fingerprinted and the next run sends it again');

/** What the provider says of the texts themselves, not of itself: one of them is too long, empty or not accepted. */
const REFUSAL = new Set([400, 413, 422]);
const isRefusal = (r: { errorType: string; status?: number }): boolean => r.errorType === 'provider' && REFUSAL.has(r.status ?? 0);

/** One run for the job's org. True: it stopped with work left (`most` texts sent, or `stopAt` passed). */
export async function fingerprintOrg(stopAt = Infinity, most = RUN_TEXTS): Promise<boolean> {
  const pick = currentFingerprintModel();
  if (!pick) return false; // off: nothing read, nothing sent
  const place = await vectorPlace();
  if (!place) return false; // no pgvector or no table: words only
  const model = store.modelKey(pick);
  const send = (texts: readonly store.Stale[]) => fingerprint(texts.map((t) => t.text), pick, { purpose: 'document', quiet: true });
  const save = (projectId: string, texts: readonly store.Stale[], vectors: readonly Float32Array[]) =>
    store.saveVectors(projectId, model, place, texts.map((t, j) => ({ item: t.item, hash: t.hash, literal: vectorLiteral(vectors[j]) })));
  let left = most;
  let worked = false;

  /** A refused batch, one text at a time. A code when the run must stop (not one text's fault), else null. */
  const oneByOne = async (projectId: string, part: readonly store.Stale[]): Promise<string | null> => {
    const alone: store.Stale[] = [];
    for (const t of part) {
      const r = await send([t]);
      if (r.ok) {
        await save(projectId, [t], r.vectors);
        worked = true;
      } else if (!isRefusal(r)) {
        return r.errorType;
      } else if (alone.push(t) >= 3 && !worked) {
        return 'refused'; // three refused alone and none taken: the provider refuses everything, and nothing is held against a text
      }
    }
    if (await store.refused(projectId, model, alone, 'refused')) once('skipped', `a text refused ${store.MAX_ATTEMPTS} times alone is skipped for a day`);
    return null;
  };

  for (const projectId of await store.projectsOf()) {
    if (left <= 0 || Date.now() >= stopAt) return true;
    const asked = left;
    const todo = await store.staleTexts(projectId, model, asked);
    for (let i = 0; i < todo.length; i += FINGERPRINT_BATCH) {
      if (Date.now() >= stopAt) return true;
      const part = todo.slice(i, i + FINGERPRINT_BATCH);
      const r = await send(part);
      let stop: string | null = null;
      if (r.ok) {
        await save(projectId, part, r.vectors);
        worked = true;
      } else {
        stop = isRefusal(r) ? await oneByOne(projectId, part) : r.errorType;
      }
      if (stop) {
        failedOnce(stop);
        return false; // left stale: the next run, one interval on, sends it
      }
      left -= part.length;
    }
    if (todo.length < asked) await store.tidy(projectId, model); // covered: other models' rows, gone items' and old refusals go
  }
  return left <= 0;
}

let defined = false;
/** Declares the job (src/server/app.ts, with a database). Once per process: a second app in one process shares it. */
export function wireFingerprints(): void {
  if (defined) return;
  defined = true;
  defineJob(FINGERPRINT_JOB, { everyMs: FINGERPRINT_EVERY_MS, run: (_target, stopAt) => fingerprintOrg(stopAt) });
}
