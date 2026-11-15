// A Live dataset's source table facts, kept current without a click (docs/assistant/00-design.md, "Table facts") —
// MAIN PROCESS ONLY.
//
// There is no schedule per connection: the scheduled job that reads a connection's catalog is the Live dataset's daily
// schema sync (src/engine/live/schemaSyncJob.ts), so the facts ride it, on the same day's visit to the warehouse (no
// extra wake of a Snowflake or Databricks warehouse). After a SCHEDULED sync lands, the documented source tables of
// that dataset whose facts are older than FACTS_STALE_MS (or were never read) are read again, stalest first, at most
// FACTS_PER_SYNC of them, one after another, each through `readFacts` (./sourceTableRead): the SSRF guard, the
// context's timeout and row clamps, safeError, the secrets redacted, and the click's 60-an-hour count per connection,
// shared with editors. A read that fails, or a count that is spent, writes nothing: the facts stored before stay.
// Never throws: the sync's job never fails for its facts.

import * as datasets from '../data/datasets';
import * as connections from '../connectors/connections';
import { isLive } from '../data/liveDataset';
import { docTablesOf, sourceTablesOf } from '../data/sourceTableOf';
import { listSourceIndex, readSourceDoc } from '../app/sourceTables';
import { logger } from '../app/logger';
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
