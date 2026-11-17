// The values a question names, found before the AI call (docs/assistant/00-design.md, step 3 "Values") — MAIN PROCESS ONLY.
//
// Over the datasets the ask's facts hold (./askTableFacts askDatasets: the open dataset, a visual's, Home's 12 step 3
// picks, a topic's first 12) and those linked to them (./askLinks): never a list. A Live dataset is skipped: no rows here,
// and its profile's sample values are in its facts already (./liveProfile). A copy that is not resident is skipped, never
// hydrated. Once per ask; never throws.
//
// FIRST THE INDEX (with a database; ./valueIndex builds each dataset's sidecar after every data write): which sidecars are
// written (./valueIndex sidecarsOf: the files; on S3 one indexed query of the storage registry, names only), then ONE
// DuckDB statement over those (../engine/valueIndexResident lookupValuesResident), each value it finds tested by the
// rule itself (valueMatches). Then, per
// dataset, one after another, inside its door (./rowDoors withLockOf): never a column hidden from the caller, nor one
// marked personal or financial (as ./copyValues). A column the index holds whole, for a caller with no row lock, is
// answered from it, with no DuckDB statement at all. For a caller WITH a row lock, the values found are confirmed under
// it: one bounded DuckDB statement over the dataset (`v IN (…)` after the lock; the index knows no row), so a value that
// exists only in rows outside the lock never reaches the prompt. The rest — a dataset not indexed yet or since its last
// write, a column past the index's cap or found too often (CANDIDATES) — is SCANNED as before
// (../engine/valueSearchResident): the reference, and the whole path without a database. Except a column past the cap
// that the index knows as ID-LIKE (ids, emails: ../engine/valueIndexResident ID_DISTINCT): it is scanned only when the
// question names an id token (../ai/valueFacts idTokens: a digit, an @, a UUID), and for those tokens alone, in the
// same statement. DuckDB statements, a scan's or a confirmation's, are sent only within VALUES_BUDGET_MS of the ask's
// start.

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { isRowPolicyError } from '../data/rowAccess';
import { isFolderError } from '../server/authz/folders';
import { withheldColumns } from '../app/sharePolicy';
import { PER_COLUMN, PER_DATASET, keyRange, searchValuesResident, valueMatches, type ValueHit } from '../engine/valueSearchResident';
import * as trace from '../engine/residentTrace';
import { VALUE_LINES, askWords, idTokens, valuesBlock, type ValueLine } from '../ai/valueFacts';
import type { LedgerEntry } from '../ai/numberAudit';
import { logger } from '../app/logger';
import { VALUE_INDEX_VERSION, lookupValuesResident, stampOf, type Found } from '../engine/valueIndexResident';
import { sidecarsOf, valueIndexWired } from './valueIndex';
import { HOME_DATASETS } from './homeFacts';
import { withLockOf } from './rowDoors';
import { perAsk } from './askMemo';

const NONE = { text: '', ledger: [] as LedgerEntry[] };

let indexOn = true;
/** Test seam (scripts/test-askValueIndex.ts): off, every dataset is scanned, the reference path. */
export function _setValueIndex(on: boolean): void {
  indexOn = on;
}

/** The set of `found`, if it was built from `meta`'s last write by this build version; else null (the dataset is scanned). */
const freshSet = (found: Found | null, meta: DatasetMeta) =>
  (found?.set && found.set.version === VALUE_INDEX_VERSION && found.set.stamp === stampOf(meta) ? found.set : null);

/** One dataset's hits: from the index where it answers, the rest by one DuckDB statement (scan and confirmation) while `inBudget()`. */
async function valuesOf(projectId: string, meta: DatasetMeta, words: string[], ids: string[], found: Found | null, inBudget: () => boolean): Promise<ValueLine[]> {
  try {
    return await withLockOf(projectId, meta.id, async (lock, hidden) => {
      const withheld = await withheldColumns(projectId, meta.id);
      const src = await datasets.residentSource(projectId, meta.id);
      if (!src) return [];
      const cols = src.columns.flatMap((c, i) => (c.type === 'text' && !hidden.has(c.name) && !withheld.has(c.name) ? [i] : []));
      const set = freshSet(found, meta);
      trace.record('askValueIndex', set ? 'resident' : 'skipped');
      const byIndex = new Map<number, string[]>(); // a column's hits, or (locked) the values to confirm
      const scan: number[] = [];
      const idScan: number[] = [];
      for (const ci of cols) {
        const c = set?.indexed.includes(ci) ? found!.columns.get(ci) ?? { values: [], n: 0 } : null;
        const exact = c ? c.values.flatMap(([v]) => (valueMatches(v, words) ? [v] : [])) : [];
        // Whole when every candidate came back; for a caller with no lock the first PER_COLUMN of them are enough.
        if (c && (c.n <= c.values.length || (!lock && exact.length >= PER_COLUMN))) byIndex.set(ci, lock ? exact : exact.slice(0, PER_COLUMN));
        else if (set?.idLike.includes(ci)) { if (ids.length) idScan.push(ci); } // ids, emails: only for an id the question names
        else scan.push(ci); // shortcut: a name-like column past the index's cap is scanned on every ask while the budget lasts; index its words if asks name them
      }
      const steps = lock ? [...lock.steps] : [];
      const known = lock ? new Map([...byIndex].filter(([, vs]) => vs.length)) : new Map<number, string[]>();
      let hits: ValueHit[] = [];
      if (scan.length || idScan.length || known.size) {
        if (inBudget()) {
          const r = await searchValuesResident(src, scan, words, steps, known, { cols: idScan, tokens: ids });
          trace.record('askValues', r ? 'resident' : 'failed', r ? undefined : 'no JS path here: the ask lists no values of this dataset');
          hits = r ?? [];
        } else {
          trace.record('askValues', 'skipped');
        }
      }
      if (!lock) for (const [ci, vs] of byIndex) hits.push(...vs.map((value) => ({ column: src.columns[ci].name, value })));
      // Each column's hits are its own (first row first), so the index's and the statement's merge in column order.
      const at = new Map(src.columns.map((c, i) => [c.name, i]));
      return hits.map((h, k) => ({ h, k })).sort((a, b) => at.get(a.h.column)! - at.get(b.h.column)! || a.k - b.k)
        .slice(0, PER_DATASET).map(({ h }) => ({ dataset: meta.name, ...h }));
    });
  } catch (err: unknown) {
    // Refused (row rules, a folder): no values, as for no match.
    if (!isRowPolicyError(err) && !isFolderError(err)) logger.error('[askValues] left out of the ask:', err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Wall-clock one ask's DuckDB statements may start in, after which the datasets left get only what the index answers
 * (trace `skipped`). The org's DuckDB worker runs one statement at a time, so the statements go one after another, and a
 * long search would hold every other request of the org behind it. Measured (a loaded laptop): a scan of a
 * 1,000,000-row dataset of five text columns 0.7 to 1 s; a confirmation of what the index found under a row lock, on the
 * same table, a few ms to 20 ms. The index's own lookup is one DuckDB statement for every dataset (docs, "Values, as built").
 */
export const VALUES_BUDGET_MS = 400;

/** The VALUES block for one `copilot:ask` (../ai/valueFacts): '' when nothing matched, so the prompt is as without it. */
export async function askValueFacts(projectId: string, about: readonly DatasetMeta[], linked: readonly DatasetMeta[], question: string): Promise<{ text: string; ledger: LedgerEntry[] }> {
  const metas = [...about.slice(0, HOME_DATASETS), ...linked].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i && !isLive(m) && m.resident);
  if (!metas.length) return NONE;
  try {
    return await perAsk(`values\0${projectId}\0${metas.map((m) => m.id).join()}\0${question}`, async () => {
      const t0 = Date.now();
      const asks = metas.flatMap((meta) => {
        const names = [meta.name, ...meta.columns.map((c) => c.name)];
        const words = askWords(question, names);
        const ids = idTokens(question, names);
        return words.length || ids.length ? [{ meta, words, ids }] : [];
      });
      if (!asks.length) return NONE;
      let found: Map<string, Found> | null = null;
      if (indexOn && valueIndexWired()) {
        const at = await sidecarsOf(projectId, asks.map((a) => ({ id: a.meta.id, version: a.meta.storageVersion })));
        found = await lookupValuesResident(asks.flatMap((a) => (at.has(a.meta.id) ? [{ datasetId: a.meta.id, path: at.get(a.meta.id)!, ranges: a.words.map(keyRange) }] : [])));
        if (!found) trace.record('askValueIndex', 'failed', 'the lookup failed: every dataset is scanned');
      }
      const lines: ValueLine[] = [];
      for (const a of asks) {
        if (lines.length >= VALUE_LINES) break; // the block is full: what follows would not be shown
        const f = found?.get(a.meta.id) ?? null;
        if (!a.words.length && !freshSet(f, a.meta)?.idLike.length) continue; // id tokens alone: only an id-like column is searched for them
        lines.push(...(await valuesOf(projectId, a.meta, a.words, a.ids, f, () => Date.now() - t0 <= VALUES_BUDGET_MS)));
      }
      return valuesBlock(lines);
    });
  } catch (err: unknown) {
    logger.error('[askValues] left out of the ask:', err instanceof Error ? err.message : err);
    return NONE;
  }
}
