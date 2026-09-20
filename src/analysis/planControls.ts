// A plan's FILTER-BAR CONTROLS, validated.
//
// Split out of analysisPlan.ts rather than added to it (.claude/rules/
// file-size.md): that file is already at its ceiling, and this is one more
// member of the same family as `validateMetric` / `validateText` — same
// signature, same drop-and-report discipline, same `PlanDrop` vocabulary.
//
// A control is a filter-bar chip (dashControlBar.ts), not a tile: it carries no
// geometry, it computes nothing, and what it filters is decided at READ time by
// dashboardFilters.controlSteps from the reader's own live selection. The only
// thing a plan may say about one is which column it filters and how.

import * as dashboards from './dashboards';
import type { PlanContext, PlanDataset, PlanDrop } from './analysisPlan';

export interface PlannedControl {
  datasetId: string;
  kind: dashboards.ControlKind;
  column: string;
  label?: string;
}

const CONTROL_KINDS: ReadonlySet<string> = new Set(['dropdown', 'multi', 'date_range']);

/** Longest label a plan may put on a chip. A chip is a word, not a sentence. */
const LABEL_MAX = 60;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function resolve(ctx: PlanContext, raw: Record<string, unknown>): PlanDataset | undefined {
  const id = str(raw.datasetId);
  const name = str(raw.dataset);
  return ctx.datasets.find((d) => d.id === id) || ctx.datasets.find((d) => d.name === name);
}

/**
 * One control, validated exactly as hard as a metric.
 *
 * `dashboards.sanitizeCard` checks the SHAPE of a control card — a known kind, a
 * UUID datasetId, a non-empty column — but never that the column exists. A chip
 * over a column that is not there filters nothing and says nothing about why, so
 * it is dropped and reported here instead.
 *
 * A column this plan is about to COMPUTE is accepted, for the same reason a
 * metric over one is: calculated fields are applied before the cards are built.
 */
export function validateControl(
  raw: unknown,
  ctx: PlanContext,
  proposedCols: Map<string, Set<string>>,
  where: string,
  at: string,
  dropped: PlanDrop[],
): PlannedControl | null {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o) {
    dropped.push({ kind: 'metric', where, message: `${at} dropped: not an object.` });
    return null;
  }
  const ds = resolve(ctx, o);
  if (!ds) {
    dropped.push({
      kind: 'dataset',
      where,
      message: `${at} dropped: unknown dataset ${JSON.stringify(str(o.dataset) || str(o.datasetId))}.`,
    });
    return null;
  }
  const kind = str(o.kind);
  if (!CONTROL_KINDS.has(kind)) {
    dropped.push({ kind: 'encoding', where, message: `${at} dropped: ${JSON.stringify(kind)} is not a control kind.` });
    return null;
  }
  const column = str(o.column);
  const known = ds.columns.some((c) => c.name === column) || !!proposedCols.get(ds.id)?.has(column);
  if (!known) {
    dropped.push({ kind: 'encoding', where, message: `${at} dropped: "${column}" is not a column of "${ds.name}".` });
    return null;
  }
  const out: PlannedControl = { datasetId: ds.id, kind: kind as dashboards.ControlKind, column };
  const label = str(o.label).slice(0, LABEL_MAX);
  if (label) out.label = label;
  return out;
}
