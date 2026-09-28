// What a statistical analysis IS — MAIN PROCESS, PURE. A spec names a dataset,
// a kind and its columns; it never carries a figure. The workbench sends one
// per run, a dashboard "stats" card stores one (src/analysis/dashboards.ts
// sanitizes it through `sanitizeStatsSpec`), and the Assistant's facts are
// recomputed from one — so every number is computed on demand from the data,
// never stored.

import type { ParsedColumn } from '../../data/parse';

export type StatsKind = 'correlation' | 'regression' | 'groups' | 'distribution';
export type CorrMethodSpec = 'pearson' | 'spearman';
export type StatsView = 'table' | 'chart';

export interface StatsSpec {
  kind: StatsKind;
  datasetId: string;
  /** correlation: the numeric columns (2–12); distribution: the one column. */
  columns: string[];
  method?: CorrMethodSpec;
  /** regression */
  target?: string;
  predictors?: string[];
  /** groups: the grouping column, the outcome, which groups, and the "success" level of a binary outcome. */
  group?: string;
  outcome?: string;
  levels?: string[];
  success?: string;
  /** A dashboard card's presentation. Ignored by the workbench. */
  view?: StatsView;
}

export const KINDS: readonly StatsKind[] = ['correlation', 'regression', 'groups', 'distribution'];
export const MAX_CORR_COLUMNS = 12;
export const MAX_PREDICTORS = 30;
export const MAX_GROUPS = 20;
const MAX_NAME = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const name = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME ? v : undefined);
function names(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const s = name(x);
    if (s !== undefined && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Whitelist an untrusted spec. Null when it has no dataset or no kind. */
export function sanitizeStatsSpec(raw: unknown): StatsSpec | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.kind !== 'string' || !KINDS.includes(o.kind as StatsKind)) return null;
  if (typeof o.datasetId !== 'string' || !UUID_RE.test(o.datasetId)) return null;
  const kind = o.kind as StatsKind;
  const spec: StatsSpec = { kind, datasetId: o.datasetId, columns: names(o.columns, MAX_CORR_COLUMNS) };
  if (kind === 'correlation') spec.method = o.method === 'spearman' ? 'spearman' : 'pearson';
  if (kind === 'regression') {
    const target = name(o.target);
    if (target !== undefined) spec.target = target;
    spec.predictors = names(o.predictors, MAX_PREDICTORS).filter((p) => p !== target);
  }
  if (kind === 'groups') {
    const group = name(o.group);
    const outcome = name(o.outcome);
    if (group !== undefined) spec.group = group;
    if (outcome !== undefined && outcome !== group) spec.outcome = outcome;
    const levels = Array.isArray(o.levels) ? o.levels.filter((x): x is string => typeof x === 'string' && x.length <= MAX_NAME) : [];
    const uniq = [...new Set(levels)].slice(0, MAX_GROUPS);
    if (uniq.length) spec.levels = uniq;
    if (typeof o.success === 'string' && o.success.length <= MAX_NAME) spec.success = o.success;
  }
  if (kind === 'distribution') spec.columns = spec.columns.slice(0, 1);
  if (o.view === 'table' || o.view === 'chart') spec.view = o.view;
  return spec;
}

/** How a column is read: finite numbers, or labels (empty → null). */
export interface VectorNeed {
  column: string;
  as: 'number' | 'label';
}

/** What a spec reads, or the reason it cannot run on these columns. */
export function vectorNeeds(spec: StatsSpec, columns: readonly ParsedColumn[]): { needs: VectorNeed[] } | { error: string } {
  const type = (c: string): string | null => columns.find((x) => x.name === c)?.type ?? null;
  const numeric = (c: string | undefined, role: string): VectorNeed | string => {
    if (!c) return `Pick ${role}.`;
    const t = type(c);
    if (t === null) return `“${c}” is not a column of this dataset any more.`;
    if (t !== 'number') return `“${c}” is not a number column.`;
    return { column: c, as: 'number' };
  };
  const any = (c: string | undefined, role: string): VectorNeed | string => {
    if (!c) return `Pick ${role}.`;
    const t = type(c);
    if (t === null) return `“${c}” is not a column of this dataset any more.`;
    return { column: c, as: t === 'number' ? 'number' : 'label' };
  };
  const out: Array<VectorNeed | string> = [];
  if (spec.kind === 'correlation') {
    if (spec.columns.length < 2) return { error: 'Pick at least two numeric columns.' };
    for (const c of spec.columns) out.push(numeric(c, 'a numeric column'));
  } else if (spec.kind === 'regression') {
    out.push(numeric(spec.target, 'a numeric target'));
    if (!spec.predictors || !spec.predictors.length) return { error: 'Pick at least one predictor.' };
    for (const p of spec.predictors) out.push(any(p, 'a predictor'));
  } else if (spec.kind === 'groups') {
    const g = any(spec.group, 'a column to group by');
    out.push(typeof g === 'string' ? g : { column: g.column, as: 'label' });
    out.push(any(spec.outcome, 'an outcome to compare'));
  } else {
    out.push(numeric(spec.columns[0], 'a numeric column'));
  }
  const err = out.find((x): x is string => typeof x === 'string');
  if (err) return { error: err };
  // One read per column, even when a spec names it twice in different roles.
  const needs: VectorNeed[] = [];
  for (const n of out as VectorNeed[]) if (!needs.some((x) => x.column === n.column && x.as === n.as)) needs.push(n);
  return { needs };
}
