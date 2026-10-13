// What `analysis:draft` is told beyond the datasets themselves — the loader of
// planFacts' `PlanFactExtras`. MAIN PROCESS ONLY.
//
// The Assistant's chat already reads the user's column notes and the project's
// defined metrics (src/ipc/copilot.ts: `catalogColumns`, `factMetrics`). The
// draft reads the same two stores here, with one difference that is the whole
// point of this file: a metric arrives as its DEFINITION, never its figure. The
// draft prompt forbids figures and a draft must not cost a query per metric, so
// nothing here resolves one — `describeDefinition` words the stored record, the
// same function `resolveMetric` words its own `definitionText` with.
//
// Record reads only: no table is hydrated and no engine is asked anything.

import type { PlanContext } from '../analysis/analysisPlan';
import type { PlanFactExtras, PlanFactMetric } from '../analysis/planFacts';
import * as metrics from '../analysis/metrics';
import { describeDefinition, describeDefinitionShort } from '../analysis/metricFormat';
// The POLICY's reading of the catalog, not the catalog: a sensitivity mark is
// carried across a later rename, so a marked column stays marked under its new name.
import { assistantColumnDocs } from '../app/sharePolicy';

/** The most metrics a draft is told about, first by name: about what fills the
 *  facts' metric block (planFacts.USER_BLOCK_MAX) at ordinary lengths, and the
 *  bound on how many records one draft reads. */
const MAX_DRAFT_METRICS = 60;

/**
 * The user's column notes for every dataset in `ctx`, and the defined metrics
 * on those datasets.
 *
 * Never throws: a project whose notes or metrics cannot be read drafts exactly
 * as every project did before this existed — with no extras at all, rather than
 * with half of them and no way to tell which columns were marked.
 */
export async function loadDraftFacts(projectId: string, ctx: PlanContext): Promise<PlanFactExtras> {
  try {
    const columnDocs: NonNullable<PlanFactExtras['columnDocs']> = {};
    for (const d of ctx.datasets) columnDocs[d.id] = await assistantColumnDocs(projectId, d.id);

    const inContext = new Set(ctx.datasets.map((d) => d.id));
    const listed = (await metrics.listMetrics(projectId)).filter((s) => inContext.has(s.datasetId)).slice(0, MAX_DRAFT_METRICS);
    const defined: PlanFactMetric[] = [];
    for (const s of listed) {
      // The summary has no filters, and they are part of what the metric means.
      const m = await metrics.getMetric(projectId, s.id);
      if (!m) continue;
      // A filter's literal is a value of its column. On a column the user marked
      // personal or financial the notes say "sample values withheld", and the
      // definition must not then quote one — so it is worded without the clause.
      // ponytail: only FILTERS are looked at. A formula that compares a marked
      // column to a literal is sent as written; read its refs if that turns up.
      const docs = columnDocs[m.datasetId];
      const marked = m.filters.some((f) => {
        const level = docs[f.column] ? docs[f.column].sensitivity : '';
        return level === 'personal' || level === 'financial';
      });
      defined.push({
        name: m.name,
        datasetId: m.datasetId,
        definitionText: marked
          ? `${describeDefinitionShort(m.definition)}, filtered on a column whose values are withheld`
          : describeDefinition(m),
        description: m.description,
      });
    }
    return { columnDocs, metrics: defined };
  } catch (_) {
    return {}; // the notes must never cost the user their draft
  }
}
