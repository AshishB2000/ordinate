// A semantic dataset's mirror metrics (semantic layer part 7, b2; docs/semantic-layer/07-portability.md D13) —
// MAIN PROCESS ONLY.
//
// One metric record per layer metric, holding its NAME and never its math: `definition: { external, additive?,
// layer }`, no filters, the default format. So every surface that lists metrics (pickers, KPI tiles, alerts,
// scorecards, the Data model, MCP) gets the layer's metrics with no reader of its own, and the doors ask the layer
// for `{ metric: external }`. The sync is the only writer of an external definition, after the dataset's one sync
// write, each through the metric store's own save and a version:
//   - a name taken in the project (metrics and terms, case-blind) takes ` · <connection name>`;
//   - a mirror in the Trash (same dataset, same layer name) is never recreated;
//   - a metric the layer no longer lists keeps its mirror, which then refuses `metricMissing`; a layer-side rename
//     is a missing one plus a new one, never a remap;
//   - only the definition (`additive`) follows the layer after creation: name, description, format and direction
//     are Ordinate's to edit.

import { isDeepStrictEqual } from 'util';
import * as metrics from '../../../analysis/metrics';
import type { MetricExternalDefinition } from '../../../analysis/externalMetric';
import { isExternalDefinition } from '../../../analysis/externalMetric';
import { listTerms } from '../../../analysis/terms';
import * as trash from '../../../app/trash';
import { readEntry } from '../../../app/trashStore';
import * as versions from '../../../app/versions';
import type { SemanticSettings } from '../../../data/semanticDataset';

const definitionOf = (m: SemanticSettings['metrics'][number], layer: string): MetricExternalDefinition =>
  ({ external: m.name, ...(m.additive ? { additive: true as const } : {}), layer });

/** The layer names whose mirror on `datasetId` sits in the Trash. */
async function trashedOn(projectId: string, datasetId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const e of await trash.list(projectId)) {
    if (e.type !== 'metric') continue;
    const r = (await readEntry(projectId, 'metric', e.id)) as { datasetId?: unknown; definition?: unknown } | null;
    if (r && r.datasetId === datasetId && isExternalDefinition(r.definition)) out.add(r.definition.external);
  }
  return out;
}

/** Create or update the mirrors of `s.metrics` on `datasetId`. Idempotent: a second run writes nothing. */
export async function syncMirrors(projectId: string, datasetId: string, s: SemanticSettings, connectionName: string): Promise<{ created: string[]; updated: string[]; missing: string[] }> {
  const all = await metrics.listMetrics(projectId);
  const mine = new Map<string, (typeof all)[number]>(); // layer name → its mirror
  for (const m of all) if (m.datasetId === datasetId && isExternalDefinition(m.definition) && !mine.has(m.definition.external)) mine.set(m.definition.external, m);
  const trashed = await trashedOn(projectId, datasetId);
  const taken = new Set([...all.map((m) => m.name.toLowerCase()), ...(await listTerms(projectId)).map((t) => t.name.toLowerCase())]);
  const created: string[] = [];
  const updated: string[] = [];
  for (const lm of s.metrics) {
    const definition = definitionOf(lm, s.backend);
    const have = mine.get(lm.name);
    if (have) {
      if (isDeepStrictEqual(have.definition, definition)) continue;
      const u = await metrics.updateMetric(projectId, have.id, { definition });
      if (u) {
        await versions.record(projectId, 'metric', u);
        updated.push(u.name);
      }
      continue;
    }
    if (trashed.has(lm.name)) continue;
    let name = lm.name;
    if (taken.has(name.toLowerCase())) name = `${lm.name} · ${connectionName}`;
    // shortcut: a second clash leaves that layer metric without a mirror; number the names when someone meets one
    if (taken.has(name.toLowerCase())) continue;
    const saved = await metrics.saveMetric(projectId, { name, datasetId, definition, filters: [], ...(lm.description ? { description: lm.description } : {}) });
    if (!saved) continue;
    taken.add(saved.name.toLowerCase());
    await versions.record(projectId, 'metric', saved);
    created.push(saved.name);
  }
  const listed = new Set(s.metrics.map((m) => m.name));
  const missing = [...mine].filter(([external]) => !listed.has(external)).map(([, m]) => m.name);
  return { created, updated, missing };
}
