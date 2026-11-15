// Outcome E: an answer that needs a link nobody defined (docs/assistant/00-design.md, "A question needs a link nobody
// defined") — MAIN PROCESS ONLY.
//
// The chart form reads one dataset. When the model's answer names, on one dataset, a column another dataset has (bare or
// as "Countries.region") and no relationship joins the two, Ordinate never guesses a join: it checks one and asks. The
// check is the Relationships page's own (./relationships `suggest`): key pairs ranked by name and type, the sampled
// share of FROM keys found in TO, and the full-table key statistics that say whether TO's key is unique, all computed by
// the engine on our copies. An editor gets the card (`link`) with **Add link and answer**, which saves the link through
// `relationship:save` (counted over the full tables again) and asks again; a viewer gets the sentence and the reason
// `link` (Ask an editor), and no check runs for them. A Live dataset on either side gets the sentence too.
// shortcut: no warehouse probe for a Live side (the check reads our copies only); add one through warehouse() when Live links are asked for.

import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { seesSourceNames } from '../data/sourceNames';
import { listRelationships } from '../analysis/relationships';
import { resolveColumn } from '../ai/answerSpec';
import { searchModel } from './assistantSearch';
import { suggest } from './relationships';
import * as say from '../ai/sourceAnswerMessages';

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
  if (!(await seesSourceNames(projectId)) || isLive(from) || isLive(to)) return plain;
  const s = await suggest(projectId, from.id, to.id);
  const best = s?.ok ? s.best : null;
  if (!best || (best.cardinality !== 'many_to_one' && best.cardinality !== 'one_to_one') || !best.stats) return plain;
  return {
    ok: false, needs: 'link', reason: say.linkProposed(from.name, to.name),
    link: {
      from: { datasetId: from.id, dataset: from.name, column: best.from },
      to: { datasetId: to.id, dataset: to.name, column: best.to },
      cardinality: best.cardinality,
      checks: { names: best.name === 1, types: best.typeMatch === true, foundPct: typeof best.ratePct === 'number' ? best.ratePct : null, unique: best.stats.toKeys === best.stats.toKeyed },
    },
  };
}
