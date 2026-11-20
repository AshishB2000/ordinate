// The ONE place an ask's guidance is assembled (semantic layer part 3, D2/D15): the project's instructions and,
// for the contexts that open a dataset, its editor-written guide. MAIN PROCESS ONLY.
//
// One catalog read and record metadata (and, with a database, the knowledge passages that match the question: ../knowledge): never a row, a connection, a source-table note or SQL. Instructions and
// guides are editor prose every reader of the project sees (D5), so a caller row access rules restrict reads the
// same block; the facts beside it are what the lock shapes. Never throws: guidance must never cost an answer.

import { loadShared as load } from '../app/catalog'; // read-only: the question's one parse (../ipc/askMemo)
import * as datasets from '../data/datasets';
import * as visuals from '../analysis/visuals';
import { guidanceBlock, GUIDE_INVENTORY_MAX, GUIDE_OPEN_MAX, type GuidanceInput, type Guided } from '../ai/guidanceFacts';
import { logger } from '../app/logger';
import { verifiedExamples } from './verifiedLookup';
import { readTopic, topicForReaders } from '../analysis/topics';
import { HOME_DATASETS, homeDatasets } from './homeFacts';
import { passagesFor } from '../knowledge/retrieve';

const NONE: Guided = { text: '', ledger: [], used: { instructions: 0, examples: [] } };
/** Home's datasets (./homeFacts: the ones `buildFacts`' fallback shows, picked once per ask), or a topic's first 12. */
const INVENTORY = HOME_DATASETS;

function guided(input: GuidanceInput, examples: string[] = []): Guided {
  const b = guidanceBlock(input);
  return { text: b.text, ledger: b.ledger, used: { instructions: b.instructions, examples, ...(b.documents.length ? { documents: b.documents } : {}) } };
}

/** The verified questions worth showing for `question` (D10), as lines and ids (./verifiedLookup: ranked by the index with a database). Metadata only; the caller's row lock hides what it hides. */
function exampleLines(projectId: string, question: string, datasetId: string | undefined, exclude: string | undefined, first?: ReadonlySet<string>) {
  return verifiedExamples(projectId, { question, datasetId, exclude, first });
}

/** A topic's datasets in its order (gone ones dropped), or null when there is no such topic: the project's then. */
export async function topicDatasets(projectId: string, id: string): Promise<{ id: string; name: string }[] | null> {
  const stored = await readTopic(projectId, id);
  if (!stored) return null;
  const { topic } = await topicForReaders(projectId, stored.rec); // its datasets that exist, read already (inside an ask, the memo holds them)
  const metas = await Promise.all(topic.datasets.map((t) => datasets.getDatasetMeta(projectId, t.id)));
  return metas.flatMap((m) => (m ? [{ id: m.id, name: m.name }] : []));
}

/**
 * The block for one `copilot:ask`. `factsKind` is the kind of the facts `buildFacts` built (its provenance), so a
 * context that fell back to the project inventory gets the inventory's guides. Guides: the dataset's own for a
 * dataset, the visual's dataset's for a visual, Home's 12 datasets' (./homeFacts), a topic's first 12 in its order (part 6; its
 * facts are the inventory's, narrowed); any other kind gets instructions only. `agent`: the Assistant agent answering
 * (docs/assistant-agents): its instructions after the project's, and the verified questions on its topic's datasets first.
 */
export async function askGuidance(
  projectId: string, context: { kind?: string; id?: string }, factsKind: string, question?: string,
  opts: { exclude?: string; agent?: { id?: string; name: string; instructions: string[]; datasets: ReadonlySet<string> | null } } = {},
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
      for (const d of (topic ?? (await homeDatasets(projectId, question ?? ''))).slice(0, INVENTORY)) {
        if (guideOf(d.id)) guides.push({ dataset: d.name, text: guideOf(d.id), max: GUIDE_INVENTORY_MAX });
      }
    }
    // Verified questions as examples, only for an ask (a question to answer); a failure there costs the examples, not the block.
    const ex = question ? await exampleLines(projectId, question, factsKind === 'dataset' ? id : undefined, opts.exclude, opts.agent?.datasets ?? undefined).catch(() => ({ lines: [], ids: [] })) : { lines: [], ids: [] };
    const agent = opts.agent ? { name: opts.agent.name, instructions: opts.agent.instructions } : undefined;
    // Knowledge passages that match the question (docs/knowledge-docs rule 9); a failure costs the passages, never the answer (rule 8).
    const documents = question ? await passagesFor(projectId, opts.agent?.id ?? null, question).catch((err: any) => { logger.error('[guidance] documents left out of the ask:', err && err.code); return []; }) : [];
    return guided({ instructions, guides, examples: ex.lines, ...(agent ? { agent } : {}), ...(documents.length ? { documents } : {}) }, ex.ids);
  } catch (err: any) {
    logger.error('[guidance] left out of the ask:', err && err.message);
    return NONE;
  }
}

/** The instructions alone: a narration and the other contexts. `agent`: the Assistant agent narrating, its own after the project's. */
export async function instructionsGuidance(projectId: string, agent?: { name: string; instructions: string[] }): Promise<Guided> {
  try {
    return guided({ instructions: ((await load(projectId)).instructions ?? []).map((i) => i.text), ...(agent ? { agent } : {}) });
  } catch (err: any) {
    logger.error('[guidance] left out of the narration:', err && err.message);
    return NONE;
  }
}
