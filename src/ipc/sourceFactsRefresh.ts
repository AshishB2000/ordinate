// Source table facts, kept current without a click (docs/assistant/00-design.md, "Table facts") — MAIN PROCESS ONLY.
// Two ways, both through `readFacts` (./sourceTableRead): the SSRF guard, the context's timeout and row clamps,
// safeError, the secrets redacted, and the click's 60-an-hour count per connection, shared with editors. A read that
// fails, or a count that is spent, writes nothing: the facts stored before stay.
//
// 1. A Live dataset's daily schema sync (src/engine/live/schemaSyncJob.ts) reads its catalog anyway, so its tables' facts
//    ride it, on the same day's visit to the warehouse (no extra wake of a Snowflake or Databricks warehouse). After a
//    SCHEDULED sync lands, the documented source tables of that dataset whose facts are older than FACTS_STALE_MS (or
//    were never read) are read again, stalest first, at most FACTS_PER_SYNC of them, one after another. Never throws: the
//    sync's job never fails for its facts.
// 2. The `sourceTable:facts` job, one row per org in the jobs table (src/server/jobs/runner.ts: a run is a claim, FOR
//    UPDATE SKIP LOCKED under a heartbeat lease, so two pods never run one org's at once), hourly, with a database only:
//    every documented table of the org, of any connection whose connector reads facts (an extract's or a Live one's),
//    whose facts are older than TABLE_FACTS_MAX_AGE_HOURS (24) or were never read, stalest first, at most FACTS_PER_RUN
//    reads a run. A connection whose read fails is logged once (its error safeError'd by the door) and skipped for the
//    rest of the run: its tables are still stale, so the next run tries again. Nothing documented: nothing is read.

import * as datasets from '../data/datasets';
import * as connections from '../connectors/connections';
import { isLive } from '../data/liveDataset';
import { docTablesOf, sourceTablesOf } from '../data/sourceTableOf';
import { listSourceIndex, readSourceDoc, readSourceIndexes } from '../app/sourceTables';
import * as projects from '../app/projects';
import { logger } from '../app/logger';
import { getConnector } from '../connectors';
import { canReadFacts } from '../connectors/tableFactsRun';
import { safeError } from '../connectors/types';
import { tableFactsMaxAgeMs } from '../server/env';
import { defineJob } from '../server/jobs/runner';
import { readFacts } from './sourceTableRead';

/**
 * Facts read this recently are kept. Under the sync's 24 h, so each day's sync reads what the last one read; half a
 * day, so a table an editor read this morning, or one another Live dataset on it read in this tick, is not read twice.
 */
export const FACTS_STALE_MS = 12 * 60 * 60 * 1000;
/** Tables one sync reads: a Live dataset over a table has one; one over a query links at most 16, all read in four days. */
export const FACTS_PER_SYNC = 4;

const msOf = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/** How many docs' facts were read and stored. */
export async function refreshSourceFacts(projectId: string, datasetId: string, now = Date.now(), signal?: AbortSignal): Promise<number> {
  try {
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    const origin = meta?.origin;
    if (!meta || !isLive(meta) || origin?.kind !== 'connection') return 0;
    const conn = await connections.getConnection(projectId, origin.connId);
    if (!conn) return 0;
    const byName = new Map((await listSourceIndex(projectId, origin.connId)).map((e) => [e.table, e.docId]));
    const docIds = docTablesOf(sourceTablesOf(origin, conn), [...byName.keys()]).flatMap((t) => (byName.has(t) ? [byName.get(t)!] : []));
    const stale: { docId: string; readAt: number }[] = [];
    for (const docId of docIds) {
      const readAt = msOf((await readSourceDoc(projectId, origin.connId, docId))?.rec.facts?.readAt);
      if (now - readAt >= FACTS_STALE_MS) stale.push({ docId, readAt });
    }
    let read = 0;
    for (const { docId } of stale.sort((a, b) => a.readAt - b.readAt).slice(0, FACTS_PER_SYNC)) {
      if (signal?.aborted) break;
      const r = await readFacts(projectId, origin.connId, docId);
      if (r.ok) read += 1;
      else logger.warn(`[sourceFacts] the facts of a source table of dataset ${datasetId} were not read again; the stored ones stay: ${r.error}`);
    }
    return read;
  } catch (err: unknown) {
    logger.warn(`[sourceFacts] the source table facts of dataset ${datasetId} were not refreshed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

export const FACTS_JOB = 'sourceTable:facts';
export const FACTS_JOB_EVERY_MS = 60 * 60_000;
/** Reads one run starts at most, a failed one included: 480 a day per org, a fraction of each connection's 60 an hour. */
export const FACTS_PER_RUN = 20;

/** TABLE_FACTS_MAX_AGE_HOURS, re-read per run (env.ts refused a bad value at startup). */
export function factsMaxAgeMs(): number {
  try {
    return tableFactsMaxAgeMs(process.env.TABLE_FACTS_MAX_AGE_HOURS);
  } catch {
    return tableFactsMaxAgeMs(undefined);
  }
}

/** One run of the job for the context's org: how many docs' facts were read and stored. Past `stopAt` it starts no read. */
export async function refreshOrgFacts(stopAt = Infinity, most = FACTS_PER_RUN, now = Date.now()): Promise<number> {
  const maxAge = factsMaxAgeMs();
  const stale: { projectId: string; connId: string; docId: string; readAt: number }[] = [];
  for (const p of await projects.listProjects()) {
    const conns = (await connections.listConnections(p.id)).filter((c) => canReadFacts(getConnector(c.connectorId)));
    for (const [connId, entries] of await readSourceIndexes(p.id, conns.map((c) => c.id))) {
      for (const e of entries) {
        const readAt = msOf(e.readAt);
        if (now - readAt >= maxAge) stale.push({ projectId: p.id, connId, docId: e.docId, readAt });
      }
    }
  }
  // shortcut: more than FACTS_PER_RUN connections failing in one org take every read of a run; keep a failure stamp per
  // connection if an org ever has that many broken ones.
  const failed = new Set<string>();
  let tried = 0;
  let read = 0;
  for (const s of stale.sort((a, b) => a.readAt - b.readAt)) {
    if (tried >= most || Date.now() >= stopAt) break;
    if (failed.has(s.connId)) continue;
    tried += 1;
    let error: string;
    try {
      const r = await readFacts(s.projectId, s.connId, s.docId);
      if (r.ok) {
        read += 1;
        continue;
      }
      error = r.error;
    } catch (err: unknown) {
      error = safeError(err);
    }
    failed.add(s.connId);
    logger.warn(`[sourceFacts] connection ${s.connId} of project ${s.projectId}: a table's facts were not read again, so its tables wait for the next run (the stored facts stay): ${error}`);
  }
  return read;
}

let defined = false;
/** Declares the job (src/server/app.ts, with a database). Once per process: a second app in one process shares it. */
export function wireFactsRefresh(): void {
  if (defined) return;
  defined = true;
  defineJob(FACTS_JOB, { everyMs: FACTS_JOB_EVERY_MS, run: async (_target, stopAt) => { await refreshOrgFacts(stopAt); } });
}
