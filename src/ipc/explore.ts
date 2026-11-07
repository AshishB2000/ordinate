// `explore:suggest` (docs/explore/00-design.md) — MAIN PROCESS. A dataset's
// declared columns, ranked as starterPlan ranks them, and the questions they
// suggest: structure only (../analysis/exploreSuggest).
//
// ONE metadata read (`getDatasetMeta`; a semantic dataset's mirror metrics too), never a row — for an extract exactly as
// for a Live dataset — so the reply cannot carry a value, and a row policy has
// nothing here to restrict. The dataset is read from the project's own
// directory, so another project's dataset id finds nothing. `hidden` names the columns hidden from the caller
// (part 4; names are not secret), so the page can say its columns, not its rows, are limited.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { exploreSuggest } from '../analysis/exploreSuggest';
// The catalog's "This dataset no longer exists." — the same sentence for any dataset.
import { liveDatasetMissing } from '../engine/liveQueryMessages';
import { readTopic, topicForReaders } from '../analysis/topics';
import { hiddenColumnsFor } from '../data/rowAccess';
import { isExternalDefinition, listMetrics } from '../analysis/metrics';

export function register(): void {
  ipcMain.handle('explore:suggest', async (_e, { projectId, datasetId, topicId }: { projectId?: string; datasetId?: string; topicId?: string } = {}) => {
    const meta = await datasets.getDatasetMeta(String(projectId ?? ''), String(datasetId ?? ''));
    if (!meta) return { ok: false, error: liveDatasetMissing() };
    const hidden = [...(await hiddenColumnsFor(String(projectId), meta.id))];
    // A semantic dataset's measures are its layer's metrics, by their mirrors (part 7 b2).
    const layer = meta.live?.semantic ? (await listMetrics(String(projectId))).filter((m) => m.datasetId === meta.id && isExternalDefinition(m.definition)).map((m) => ({ name: m.name, metricId: m.id })) : undefined;
    const all = { ...exploreSuggest(meta.columns, layer), ...(hidden.length && { hidden }) };
    // A topic narrows the SUGGESTIONS to its fields of this dataset; the field lists stay whole (step 08, D15).
    const t = topicId ? await readTopic(String(projectId), topicId) : null;
    const fields = t && (await topicForReaders(String(projectId), t.rec)).topic.datasets.find((d) => d.id === meta.id)?.fields; // as readers get it: gone fields left out
    if (!fields) return { ok: true, ...all };
    return { ok: true, ...all, suggestions: exploreSuggest(meta.columns.filter((c) => fields.includes(c.name)), layer).suggestions };
  });
}
