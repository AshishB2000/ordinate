// A METRIC TREE card on a published page (/p/) — MAIN PROCESS. The page has no
// tree renderer, so the card publishes as a numbers table: one row per node,
// root down ("Revenue", "Revenue › Orders", "Revenue › Orders › West"), its
// current and previous figure and its contribution to its parent's change,
// under the server's headline. Recomputed per filter combination by the same
// computeTree a dashboard draws.
//
// Through the share policy: a tree split by a column the policy withholds
// would publish that column's values as row labels, so the card is hidden.
//
// Under an embed's lock (./embedLock.ts) the scope's lock steps reach every
// node, split and sparkline — but a FORMULA metric may read another dataset,
// where the pipeline would skip the lock's filter and draw the unscoped figure.
// So a tree is drawn only when every metric in it is one a locked KPI may show
// (`metricAllowed`: plain, over a dataset that carries every locked column);
// else it is refused, as a formula KPI is.

import type { FilterStep } from '../data/transforms';
import type { ParamValues } from '../analysis/params';
import * as metrics from '../analysis/metrics';
import * as sharePolicy from '../app/sharePolicy';
import { computeTree } from '../ipc/metricTree';
import { treeMetricIds } from '../analysis/metricTree';
import { metricAllowed, type Lock } from './embedLock';
import { isLiveFigureError } from '../ipc/liveRoute';
import type { TreeNodeOut } from '../ipc/metricTree';
import type { TreeNode } from '../analysis/metricTree';

const splitColumns = (n: TreeNode | undefined): string[] => (n ? [...(n.split ? [n.split] : []), ...(n.children ?? []).flatMap(splitColumns)] : []);

/** May this metric's tree be drawn under an embed's lock? Every metric in it as a locked KPI may be. */
export async function treeAllowed(lock: Lock, projectId: string, metricId: string): Promise<boolean> {
  const m = await metrics.getMetric(projectId, metricId);
  if (!m) return false;
  for (const id of m.tree ? treeMetricIds(m.tree) : [m.id]) {
    if (!(await metricAllowed(lock, projectId, { metricId: id, datasetId: m.datasetId }))) return false;
  }
  return true;
}

export async function metricTreePayload(
  projectId: string,
  card: { metricId: string; compare?: unknown },
  filters: FilterStep[],
  params: ParamValues,
): Promise<Record<string, unknown>> {
  const m = await metrics.getMetric(projectId, card.metricId);
  if (!m) return { error: 'Source removed' };
  const withheld = await sharePolicy.withheldColumns(projectId, m.datasetId);
  if (splitColumns(m.tree).some((c) => withheld.has(c))) return { hidden: sharePolicy.HIDDEN_BY_POLICY };
  let r: Awaited<ReturnType<typeof computeTree>>;
  try {
    r = await computeTree(projectId, m.id, { filters, compare: card.compare, params: [...params.values()] });
  } catch (err) {
    // A Live figure its warehouse could not give (L2.4): this tile says so, as a KPI tile does — the page still publishes.
    if (!isLiveFigureError(err)) throw err;
    return { error: err.message };
  }
  if (!r.ok) return { error: r.error };
  const labels: string[] = [];
  const cur: Array<number | null> = [];
  const prev: Array<number | null> = [];
  const contrib: Array<number | null> = [];
  const walk = (n: TreeNodeOut, path: string): void => {
    const label = path ? `${path} › ${n.name}` : n.name;
    labels.push(label);
    cur.push(n.current);
    prev.push(n.previous);
    contrib.push(n.contribution ?? null);
    for (const c of n.children) walk(c, label);
  };
  walk(r.root, '');
  return {
    labels,
    series: [
      { label: r.period.label, values: cur },
      { label: r.prior.label, values: prev },
      { label: 'Contribution', values: contrib },
    ],
    caption: r.headline,
  };
}
