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

const NONE: Guided = { text: '', ledger: [], used: { instructions: 0, examples: [] } };
/** The project inventory's datasets, in the order and cut of `buildFacts`' fallback. */
const INVENTORY = 12;

function guided(input: GuidanceInput): Guided {
  const b = guidanceBlock(input);
  return { text: b.text, ledger: b.ledger, used: { instructions: b.instructions, examples: [] } };
}

/**
 * The block for one `copilot:ask`. `factsKind` is the kind of the facts `buildFacts` built (its provenance), so a
 * context that fell back to the project inventory gets the inventory's guides. Guides: the dataset's own for a
 * dataset, the visual's dataset's for a visual, the first 12 datasets' on Home; any other kind gets instructions only.
 */
export async function askGuidance(projectId: string, context: { kind?: string; id?: string }, factsKind: string): Promise<Guided> {
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
      for (const d of (await datasets.listDatasets(projectId)).slice(0, INVENTORY)) {
        if (guideOf(d.id)) guides.push({ dataset: d.name, text: guideOf(d.id), max: GUIDE_INVENTORY_MAX });
      }
    }
    return guided({ instructions, guides });
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
