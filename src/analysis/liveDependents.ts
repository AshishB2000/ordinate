// What still names a column a Live dataset's warehouse no longer has
// (docs/live-data/00-plan.md L2.5) — MAIN, pure.
//
// A schema sync that finds a column gone keeps its name in the record only
// while something here names it; the dataset page lists each with what uses
// it, so the person who can fix a chart sees which one to open. Read off the
// same records lineage reads (./lineage.ts `LineageInput`), with the same
// rule for what a visual names (`visualColumns`: category, split, measures,
// pivot fields, filters): a visual, a saved metric, a dashboard's KPI or filter
// control, an alert rule — each on THIS dataset.

import type { LineageInput } from './lineage';
import { visualColumns } from './lineage';

export type MissingUseKind = 'visual' | 'metric' | 'kpi' | 'control' | 'alert';

/** One record that names a missing column. `dashboardId` is where a KPI or a control sits. */
export interface MissingUse {
  kind: MissingUseKind;
  id: string;
  name: string;
  dashboardId?: string;
}

export interface MissingColumn {
  column: string;
  usedBy: MissingUse[];
}

// ponytail: the records' loose shapes, as lineage reads them — each store's sanitizer already shaped them
type Rec = Record<string, any>;
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The columns a saved metric or an alert reads: its column, its filters, a period column. */
function metricColumns(def: Rec, filters: unknown, extra: unknown[] = []): string[] {
  return [str(def.column), ...arr(filters).map((f) => str(f && f.column)), ...extra.map(str)].filter(Boolean);
}

/** Every use of `datasetId`'s columns, as (column, use) pairs. */
function uses(input: LineageInput, datasetId: string): [string, MissingUse][] {
  const out: [string, MissingUse][] = [];
  const add = (cols: string[], use: MissingUse): void => {
    for (const c of new Set(cols)) out.push([c, use]);
  };
  for (const v of input.visuals) {
    if (str(v.datasetId) === datasetId) add(visualColumns(v), { kind: 'visual', id: str(v.id), name: str(v.name) || 'Visual' });
  }
  for (const m of input.metrics) {
    const def: Rec = m.definition || {};
    if (str(m.datasetId) === datasetId && !def.formula) add(metricColumns(def, m.filters), { kind: 'metric', id: str(m.id), name: str(m.name) || 'Metric' });
  }
  for (const a of input.dashboards) {
    for (const c of arr(a.sheets).flatMap((p) => arr(p && p.cards))) {
      if (!c) continue;
      const where = { dashboardId: str(a.id) };
      if (c.type === 'metric' && c.metric && !c.metric.metricId && str(c.metric.datasetId) === datasetId) {
        const label = str(c.metric.label) || `${str(c.metric.aggregation) || 'sum'} of ${str(c.metric.column)}`;
        add([str(c.metric.column)], { kind: 'kpi', id: str(c.id), name: `${label} · ${str(a.name) || 'Dashboard'}`, ...where });
      } else if (c.type === 'control' && c.control && str(c.control.datasetId) === datasetId) {
        const label = str(c.control.label) || str(c.control.column);
        add([str(c.control.column), str(c.control.lngColumn)].filter(Boolean), { kind: 'control', id: str(c.id), name: `${label} · ${str(a.name) || 'Dashboard'}`, ...where });
      }
    }
  }
  for (const al of input.alerts) {
    const m: Rec = al.metric || {};
    if (str(al.datasetId) === datasetId && !m.metricId) {
      add(metricColumns(m, m.filters, [al.change && al.change.periodColumn]), { kind: 'alert', id: str(al.id), name: str(al.name) || 'Alert' });
    }
  }
  return out;
}

/** Each missing column with what names it, in `missing`'s order; one nothing names is left out. */
export function missingDependents(input: LineageInput, datasetId: string, missing: readonly string[]): MissingColumn[] {
  if (!missing.length) return [];
  const all = uses(input, datasetId);
  return missing
    .map((column) => ({ column, usedBy: all.filter(([c]) => c === column).map(([, u]) => u) }))
    .filter((m) => m.usedBy.length > 0);
}
