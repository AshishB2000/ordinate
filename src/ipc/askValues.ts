// The values a question names, found before the AI call (docs/assistant/00-design.md, step 3 "Values") — MAIN PROCESS ONLY.
//
// Over the datasets the ask's facts hold (./askTableFacts askDatasets: the open dataset, a visual's, Home's 12 step 3
// picks, a topic's first 12) and those linked to them (./askLinks): never a list. For each copy, ONE DuckDB statement over
// its stored Parquet (../engine/valueSearchResident), one after another within VALUES_BUDGET_MS, inside its door
// (./rowDoors withLockOf): the caller's row lock first, never a column hidden from them, nor one marked personal or
// financial (as ./copyValues). A Live dataset is skipped: no rows here, and its profile's sample values are in its facts
// already (./liveProfile); asking the warehouse on every question is no cheap path. A copy that is not resident is
// skipped, never hydrated. Row values never go into Postgres, and nothing here reads Postgres beyond the records the
// facts already read. Once per ask; never throws.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { isRowPolicyError } from '../data/rowAccess';
import { isFolderError } from '../server/authz/folders';
import { withheldColumns } from '../app/sharePolicy';
import { searchValuesResident } from '../engine/valueSearchResident';
import * as trace from '../engine/residentTrace';
import { VALUE_LINES, askWords, valuesBlock, type ValueLine } from '../ai/valueFacts';
import type { LedgerEntry } from '../ai/numberAudit';
import { logger } from '../app/logger';
import { HOME_DATASETS } from './homeFacts';
import { withLockOf } from './rowDoors';
import { perAsk } from './askMemo';

const NONE = { text: '', ledger: [] as LedgerEntry[] };

async function valuesOf(projectId: string, meta: DatasetMeta, question: string): Promise<ValueLine[]> {
  const words = askWords(question, [meta.name, ...meta.columns.map((c) => c.name)]);
  if (!words.length) return [];
  try {
    return await withLockOf(projectId, meta.id, async (lock, hidden) => {
      const withheld = await withheldColumns(projectId, meta.id);
      const src = await datasets.residentSource(projectId, meta.id);
      if (!src) return [];
      const cols = src.columns.flatMap((c, i) => (c.type === 'text' && !hidden.has(c.name) && !withheld.has(c.name) ? [i] : []));
      const hits = await searchValuesResident(src, cols, words, lock ? [...lock.steps] : []);
      trace.record('askValues', hits ? 'resident' : 'failed', hits ? undefined : 'no JS path here: the ask lists no values of this dataset');
      return (hits ?? []).map((h) => ({ dataset: meta.name, ...h }));
    });
  } catch (err: unknown) {
    // Refused (row rules, a folder): no values, as for no match.
    if (!isRowPolicyError(err) && !isFolderError(err)) logger.error('[askValues] left out of the ask:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Wall-clock one ask's search may take before the datasets left are skipped (trace `skipped`). The org's DuckDB worker
 * runs one statement at a time, so the statements go one after another, and a long search would hold every other request
 * of the org behind it. Measured (a loaded laptop): a 1,000,000-row dataset of five text columns 0.7 to 1 s a statement;
 * the test's datasets of 30 to 80 rows a few ms. So a project of ordinary tables is searched whole, and one of the largest
 * gets its first dataset or two.
 */
export const VALUES_BUDGET_MS = 400;

/** The VALUES block for one `copilot:ask` (../ai/valueFacts): '' when nothing matched, so the prompt is as without it. */
export async function askValueFacts(projectId: string, about: readonly DatasetMeta[], linked: readonly DatasetMeta[], question: string): Promise<{ text: string; ledger: LedgerEntry[] }> {
  const metas = [...about.slice(0, HOME_DATASETS), ...linked].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i && !isLive(m) && m.resident);
  if (!metas.length) return NONE;
  try {
    return await perAsk(`values\0${projectId}\0${metas.map((m) => m.id).join()}\0${question}`, async () => {
      const lines: ValueLine[] = [];
      const t0 = Date.now();
      for (const m of metas) {
        if (lines.length >= VALUE_LINES) break; // the block is full: what follows would not be shown
        if (Date.now() - t0 > VALUES_BUDGET_MS) trace.record('askValues', 'skipped');
        else lines.push(...(await valuesOf(projectId, m, question)));
      }
      return valuesBlock(lines);
    });
  } catch (err: unknown) {
    logger.error('[askValues] left out of the ask:', err instanceof Error ? err.message : err);
    return NONE;
  }
}
