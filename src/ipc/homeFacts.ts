// A question asked from Home (nothing open): what it is told about the project — MAIN PROCESS ONLY.
// docs/assistant/00-design.md, "Scale rules": no question lists the whole project.
//
// Counts, never every name: datasets, metrics, terms and source tables off step 3's index (./assistantSearch countModel),
// visuals and dashboards off ⌘K's (./search countNamed). Then the 12 datasets step 3 ranks highest for the question, by
// their own names or their columns', with their columns; the newest after them when fewer match (a question such as
// "what data do we have?"); and the metrics and terms that match it best. Picked once per ask (./askMemo perAsk) and
// shared with the guidance (./guidance), which gives these 12 datasets' guides. Metadata, never a row; a caller's hidden
// columns are left out as the inventory always left them out.

import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import { datasetFilePath } from '../data/datasetRecord';
import { closedToCaller, hiddenColumnsFor } from '../data/rowAccess';
import { dropHidden, tableWithout } from '../ai/hiddenFacts';
import * as copilot from '../ai/copilot';
import type { CopilotFacts } from '../ai/copilot';
import { modelLines } from '../ai/topicFacts';
import { assistantColumnDocs as catalogColumns } from '../app/sharePolicy';
import { tableFacts } from '../app/tableDocs';
import { readTexts } from '../app/recordTexts';
import { liveInventoryNotes } from './liveProfile';
import { copyValueNotes } from './copyValues';
import { countModel, indexedFor, newestModel, newestReference, searchModel, type KeyedItem, type ModelHit, type SearchOptions } from './assistantSearch';
import { countListed, countNamed } from './search';
import { perAsk } from './askMemo';
import type { ActivityEmit } from './copilot';

export const HOME_DATASETS = 12;
/** Ranked datasets and columns read to find 12 datasets: a dataset whose columns match many times takes one place. */
const DATASET_HITS = 60;
/** Metrics and terms named on Home. */
const MODEL_HITS = 8;

export interface HomePicks { datasetIds: string[]; metricIds: string[]; termIds: string[] }

/** Where the picks come from: the index, or (for the differential) every store read. */
export interface PickSources {
  search: (projectId: string, question: string, o: SearchOptions) => Promise<ModelHit[]>;
  newest: (projectId: string, limit: number) => Promise<KeyedItem[]>;
}
const LIVE: PickSources = { search: searchModel, newest: async (p, n) => (await newestModel(p, 'dataset', n)) ?? newestReference(p, 'dataset', n) };

/** What a Home question sees, from `from`. Exported for scripts/test-askIndex.ts (index against reference, Object.is). */
export async function picksFrom(projectId: string, question: string, from: PickSources): Promise<HomePicks> {
  const hits = await from.search(projectId, question, { kinds: ['dataset', 'column'], limit: DATASET_HITS });
  const ids = [...new Set(hits.flatMap((h) => (h.kind === 'dataset' ? [h.id] : h.datasetId ? [h.datasetId] : [])))].slice(0, HOME_DATASETS);
  if (ids.length < HOME_DATASETS) {
    for (const d of await from.newest(projectId, HOME_DATASETS * 2)) if (ids.length < HOME_DATASETS && !ids.includes(d.id)) ids.push(d.id);
  }
  const model = await from.search(projectId, question, { kinds: ['metric', 'term'], limit: MODEL_HITS });
  return { datasetIds: ids, metricIds: model.flatMap((h) => (h.kind === 'metric' ? [h.id] : [])), termIds: model.flatMap((h) => (h.kind === 'term' ? [h.id] : [])) };
}

/** Home's picks for `question`, once per ask. Its readers never change them. */
export const homePicks = (projectId: string, question: string): Promise<HomePicks> =>
  perAsk(`homePicks\0${projectId}\0${question}`, () => picksFrom(projectId, question, LIVE));

/** Home's datasets as records, in the picks' order (one gone since is left out): one query for all of them. */
export async function homeDatasets(projectId: string, question: string): Promise<datasets.DatasetMeta[]> {
  const { datasetIds } = await homePicks(projectId, question);
  const textOf = await readTexts(datasetIds.map((id) => datasetFilePath(projectId, id)));
  const metas = await Promise.all(datasetIds.map((id) => datasets.getDatasetMeta(projectId, id, false, textOf(datasetFilePath(projectId, id)))));
  return metas.flatMap((m) => (m ? [m] : []));
}

const plural = (n: number, one: string, many = one + 's'): string => n + ' ' + (n === 1 ? one : many);

/** The facts of a question asked with nothing open. */
export async function homeFacts(projectId: string, question: string, emit: ActivityEmit): Promise<CopilotFacts> {
  const proj = await projects.getProject(projectId);
  const visible = indexedFor(projectId) ? countNamed(projectId) : countListed(projectId); // ⌘K's index, or the lists as without a database
  const [found, named, metas, picks] = await Promise.all([countModel(projectId), visible, homeDatasets(projectId, question), homePicks(projectId, question)]);
  emit({
    kind: 'inventory',
    label: 'Scanned the project',
    detail: plural(found.dataset, 'dataset') + ', ' + plural(named.visuals, 'visual') + ', ' + plural(named.dashboards, 'dashboard'),
  });
  // Column names and types only — a metadata read, no rows — so a question asked from Home can still come back as an answer chart.
  const schemas = await Promise.all(metas.map(async (m) => {
    const hidden = await hiddenColumnsFor(projectId, m.id);
    return {
      name: m.name, columns: dropHidden(m.columns, hidden), docs: await catalogColumns(projectId, m.id), table: tableWithout(await tableFacts(projectId, m.id), hidden),
      // A Live dataset's profile and sample values (L2.5), or a copy's from its value index — none from a dataset with row access rules the caller may not read whole.
      notes: (await closedToCaller(projectId, m.id)) ? undefined : (await liveInventoryNotes(projectId, m)) ?? (await copyValueNotes(projectId, m.id, 'inventory')),
    };
  }));
  const more = await modelLines(projectId, picks.metricIds, picks.termIds, 'Metrics that match the question (the app computes their figures; a chart may name one as a measure):');
  return copilot.projectFacts(proj ? proj.name : 'Untitled project', {
    datasets: metas.map((m) => m.name), visuals: [], dashboards: [],
    counts: { datasets: found.dataset, visuals: named.visuals, dashboards: named.dashboards, metrics: found.metric, terms: found.term },
  }, schemas, more);
}
