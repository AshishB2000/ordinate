// The ONE place an ask's guidance is assembled (semantic layer part 3, D2/D15): the project's instructions and,
// for the contexts that open a dataset, its editor-written guide. MAIN PROCESS ONLY.
//
// One catalog read and record metadata: never a row, a connection, a source-table note or SQL. Instructions and
// guides are editor prose every reader of the project sees (D5), so a caller row access rules restrict reads the
// same block; the facts beside it are what the lock shapes. Never throws: guidance must never cost an answer.

import { load } from '../app/catalog';
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import { guidanceBlock, GUIDE_INVENTORY_MAX, GUIDE_OPEN_MAX, type GuidanceInput, type Guided } from '../ai/guidanceFacts';
import { logger } from '../app/logger';
import { verifiedStates } from './verifiedState';
import { pickExamples } from '../ai/verifiedPick';
import { listTerms } from '../analysis/terms';
import { withheldColumns } from '../app/sharePolicy';
import { readTopic, topicForReaders } from '../analysis/topics';

const NONE: Guided = { text: '', ledger: [], used: { instructions: 0, examples: [] } };
/** The project inventory's datasets, in the order and cut of `buildFacts`' fallback. */
const INVENTORY = 12;

function guided(input: GuidanceInput, examples: string[] = []): Guided {
  const b = guidanceBlock(input);
  return { text: b.text, ledger: b.ledger, used: { instructions: b.instructions, examples } };
}

/** The verified questions worth showing for `question` (D10), as lines and ids. Metadata only; the caller's row lock hides what it hides. */
async function exampleLines(projectId: string, question: string, datasetId: string | undefined, exclude: string | undefined) {
  const states = await verifiedStates(projectId);
  if (!states.length) return { lines: [], ids: [] };
  const ids = [...new Set(states.map((s) => s.q.spec.datasetId))];
  const [metas, terms, withheld] = await Promise.all([
    Promise.all(ids.map((id) => datasets.getDatasetMeta(projectId, id))), listTerms(projectId), Promise.all(ids.map((id) => withheldColumns(projectId, id))),
  ]);
  const name = new Map(ids.map((id, i) => [id, metas[i]?.name ?? ''] as const));
  const held = new Map(ids.map((id, i) => [id, withheld[i]] as const));
  return pickExamples(states, {
    question, datasetId, exclude, names: { dataset: (id) => name.get(id) ?? '', term: (id) => terms.find((t) => t.id === id)?.name ?? '' },
    withheld: (id) => held.get(id) ?? new Set(),
  });
}

/** A topic's datasets in its order (gone ones dropped), or null when there is no such topic: the project's then. */
async function topicDatasets(projectId: string, id: string): Promise<{ id: string; name: string }[] | null> {
  const stored = await readTopic(projectId, id);
  if (!stored) return null;
  const { topic } = await topicForReaders(projectId, stored.rec);
  const all = new Map((await datasets.listDatasets(projectId)).map((d) => [d.id, d] as const));
  return topic.datasets.flatMap((t) => all.get(t.id) ?? []);
}

/**
 * The block for one `copilot:ask`. `factsKind` is the kind of the facts `buildFacts` built (its provenance), so a
 * context that fell back to the project inventory gets the inventory's guides. Guides: the dataset's own for a
 * dataset, the visual's dataset's for a visual, the first 12 datasets' on Home, a topic's first 12 in its order (part 6; its
 * facts are the inventory's, narrowed); any other kind gets instructions only.
 */
export async function askGuidance(
  projectId: string, context: { kind?: string; id?: string }, factsKind: string, question?: string, opts: { exclude?: string } = {},
): Promise<Guided> {
  try {
    const file = await load(projectId);
    const instructions = (file.instructions ?? []).map((i) => i.text);
    const guideOf = (id: string): string => file.tables?.[id]?.guide ?? '';
    const guides: NonNullable<GuidanceInput['guides']> = [];
    const id = typeof context.id === 'string' ? context.id : '';
    const one = factsKind === 'dataset' ? id : factsKind === 'visual' && id ? ((await visuals.getVisual(projectId, id))?.datasetId ?? '') : '';
    if (one && guideOf(one)) {
      const meta = await datasets.getDatasetMeta(projectId, one);
      if (meta) guides.push({ dataset: meta.name, text: guideOf(one), max: GUIDE_OPEN_MAX });
    }
    if (factsKind === 'project') {
      const topic = context.kind === 'topic' && id ? await topicDatasets(projectId, id) : null;
      for (const d of (topic ?? (await datasets.listDatasets(projectId))).slice(0, INVENTORY)) {
        if (guideOf(d.id)) guides.push({ dataset: d.name, text: guideOf(d.id), max: GUIDE_INVENTORY_MAX });
      }
    }
    // Verified questions as examples, only for an ask (a question to answer); a failure there costs the examples, not the block.
    const ex = question ? await exampleLines(projectId, question, factsKind === 'dataset' ? id : undefined, opts.exclude).catch(() => ({ lines: [], ids: [] })) : { lines: [], ids: [] };
    return guided({ instructions, guides, examples: ex.lines }, ex.ids);
  } catch (err: any) {
    logger.error('[guidance] left out of the ask:', err && err.message);
    return NONE;
  }
}

/** The instructions alone: a narration and the other contexts. */
export async function instructionsGuidance(projectId: string): Promise<Guided> {
  try {
    return guided({ instructions: ((await load(projectId)).instructions ?? []).map((i) => i.text) });
  } catch (err: any) {
    logger.error('[guidance] left out of the narration:', err && err.message);
    return NONE;
  }
}
