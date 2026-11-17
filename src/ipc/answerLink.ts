// Outcome E: an answer that needs a link nobody defined (docs/assistant/00-design.md, "A question needs a link nobody
// defined") — MAIN PROCESS ONLY.
//
// The chart form joins only through a saved link. When the model's answer names, on one dataset, a column another dataset has (bare or
// as "Countries.region") and no relationship joins the two, Ordinate never guesses a join: it checks one and asks. The
// check is the Relationships page's own (./relationships `suggest`): key pairs ranked by name and type, the sampled
// share of FROM keys found in TO, and the full-table key statistics that say whether TO's key is unique, all computed by
// the engine on our copies. An editor gets the card (`link`) with **Add link and answer**, which saves the link through
// `relationship:save` (counted over the full tables again) and asks again; a viewer gets the sentence and the reason
// `link` (Ask an editor), and no check runs for them. A pair with a Live side gets the same card: the pairs are ranked by
// names and types only (no sampled share found), and each key column is counted where it lives (`keyCounts`, the table
// notes' key check: rows, empty keys, repeated keys): our engine on a copy, ONE bounded warehouse statement on a Live
// dataset, under the caller's row lock, through liveLookup (warehouse(), the budget, the cache). Approve (`relationship:save`) counts matched rows over both tables, so it is offered where one engine holds
// both: two copies, or two Live datasets on one connection (its warehouse, ./linkLive). Any other mix carries
// `blocked`, ./linkLive's sentence, in place of Approve, and `copy`, the Live datasets whose copies would let it: the card
// shows the checks, says why, and offers "Make a copy" of each.

import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { seesSourceNames } from '../data/sourceNames';
import { listRelationships } from '../analysis/relationships';
import { resolveColumn } from '../ai/answerSpec';
import { searchModel } from './assistantSearch';
import { suggest } from './relationships';
import * as say from '../ai/sourceAnswerMessages';
import { rankKeys } from '../analysis/keySuggest';
import { keyCheckFromRow } from '../analysis/keyCheck';
import type { KeyCheckCounts } from '../analysis/keyCheck';
import { compileKeyCheck } from '../engine/live/compile';
import { liveLookup } from '../engine/live/liveQuery';
import { adaptFilters } from '../engine/live/liveSpec';
import * as dateRange from '../engine/live/liveDateRange';
import { extractCounts } from './tableDocs';
import { withLockOf } from './rowDoors';
import { linkBlocked } from './linkLive';

import type { AnswerLink } from '../ai/answerNeeds';
export type { AnswerLink };

export type LinkRefusal = { ok: false; reason: string; needs: 'link'; link?: AnswerLink };

/** Datasets step 3 finds a column called `said` on, other than `datasetId`: at most this many are looked at. */
const OWNERS = 8;

/** The dataset (other than `datasetId`) that has the column `said` names, and that column, or null. Metadata only. */
async function ownerOf(projectId: string, datasetId: string, said: string): Promise<{ meta: datasets.DatasetMeta; column: string } | null> {
  const dot = said.indexOf('.');
  const asked = dot > 0 ? [said, said.slice(dot + 1)] : [said];
  const hits = await searchModel(projectId, asked[asked.length - 1], { kinds: ['column'], limit: OWNERS * 4, exceptDatasetIds: [datasetId] });
  const ids = [...new Set(hits.flatMap((h) => (h.score > 0 && h.datasetId ? [h.datasetId] : [])))].slice(0, OWNERS);
  for (const id of ids) {
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (!meta) continue;
    const qualified = dot > 0 && meta.name.toLowerCase() === said.slice(0, dot).trim().toLowerCase();
    const col = resolveColumn(qualified ? asked[1] : said, meta.columns);
    if (col) return { meta, column: col.name };
  }
  return null;
}

/**
 * A key column's rows, empty keys and repeated keys: the extract's on our engine (./tableDocs `extractCounts`), a Live
 * dataset's in ONE warehouse statement (`compileKeyCheck`) under the caller's lock, and inside the date range its table
 * requires (`lookupRequired`: REQUIRED_RANGE, BigQuery's partition time), `note` saying so. Null: it cannot be said (a
 * refusal, a hidden column, a semantic layer, a required integer-range partition no default can fill) — the caller then
 * offers no card, never a guessed one.
 */
export async function keyCounts(projectId: string, meta: datasets.DatasetMeta, column: string): Promise<(KeyCheckCounts & { note?: string }) | null> {
  if (!isLive(meta)) return extractCounts(projectId, meta.id, column);
  try {
    return await withLockOf(projectId, meta.id, async (lock) => {
      let note: string | undefined;
      const r = await liveLookup(projectId, meta.id, (t) => {
        const f = adaptFilters(lock ? [...lock.steps] : [], t.columns, {});
        const need = f.ok ? dateRange.lookupRequired(t, f.filters) : f;
        if (!need.ok) return need;
        note = need.notes[0];
        return compileKeyCheck(column, need.env, need.filters);
      });
      const counts = r.ok ? keyCheckFromRow(r.rows[0]) : null;
      return counts && note ? { ...counts, note } : counts;
    }, [column]);
  } catch {
    return null; // a gate's refusal (a hidden column, a lock that cannot apply): no checks, so the plain sentence
  }
}

type Checked = { from: string; to: string; cardinality: AnswerLink['cardinality'] | null; checks: AnswerLink['checks']; note?: string };

/** The best key pair FROM → TO and its checks, or null: the Relationships page's `suggest` for two copies; with a Live side, `keyCounts` per side. */
async function checkedPair(projectId: string, from: datasets.DatasetMeta, to: datasets.DatasetMeta): Promise<Checked | null> {
  if (!isLive(from) && !isLive(to)) {
    const s = await suggest(projectId, from.id, to.id);
    const best = s?.ok ? s.best : null;
    if (!best?.stats) return null;
    const checks = { names: best.name === 1, types: best.typeMatch === true, foundPct: typeof best.ratePct === 'number' ? best.ratePct : null, unique: best.stats.toKeys === best.stats.toKeyed };
    return { from: best.from, to: best.to, cardinality: best.cardinality, checks };
  }
  const [best] = await rankKeys(from.columns, to.columns, () => null);
  const f = best ? await keyCounts(projectId, from, best.from) : null;
  const t = f ? await keyCounts(projectId, to, best.to) : null;
  if (!f || !t) return null;
  // inferCardinality's rule, on the key check's counts: TO's keys unique, then FROM's say one-to-one.
  const unique = (k: KeyCheckCounts): boolean => k.repeatedKeys === 0;
  const note = f.note ?? t.note;
  return { from: best.from, to: best.to, cardinality: unique(t) ? (unique(f) ? 'one_to_one' : 'many_to_one') : null, checks: { names: best.name === 1, types: best.typeMatch, foundPct: null, unique: unique(t) }, ...(note ? { note } : {}) };
}

/** The refusal of a spec on `datasetId` that said `said`, a column of an unlinked dataset; null when that is not the case. */
export async function linkRefusal(projectId: string, datasetId: string, said: unknown): Promise<LinkRefusal | null> {
  if (typeof said !== 'string' || !said.trim()) return null;
  const from = await datasets.getDatasetMeta(projectId, datasetId);
  const owner = from ? await ownerOf(projectId, datasetId, said.trim()) : null;
  if (!from || !owner) return null;
  const to = owner.meta;
  // A relationship between them already (one this answer cannot follow): not a missing link, the other refusals stand.
  if ((await listRelationships(projectId)).some((r) => [r.from.datasetId, r.to.datasetId].sort().join() === [from.id, to.id].sort().join())) return null;
  const plain: LinkRefusal = { ok: false, reason: say.cannotCombine(), needs: 'link' };
  if (!(await seesSourceNames(projectId))) return plain;
  const best = await checkedPair(projectId, from, to);
  if (!best || (best.cardinality !== 'many_to_one' && best.cardinality !== 'one_to_one')) return plain;
  const blocked = linkBlocked(from, to);
  return {
    ok: false, needs: 'link', reason: say.linkProposed(from.name, to.name),
    link: {
      from: { datasetId: from.id, dataset: from.name, column: best.from },
      to: { datasetId: to.id, dataset: to.name, column: best.to },
      cardinality: best.cardinality,
      checks: best.checks,
      ...(best.note ? { note: best.note } : {}),
      ...(blocked ? { blocked: blocked.why, copy: blocked.copy } : {}),
    },
  };
}
