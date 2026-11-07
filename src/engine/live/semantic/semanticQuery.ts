// The neutral question a semantic layer is asked (semantic layer part 7, b1; docs/semantic-layer/07-portability.md
// D15, D16) — PURE types. ./semanticPlan builds these from a Live IR; each backend (c1 Snowflake, e1 Cube, d1 dbt)
// encodes one into its own request and maps the reply's members back to the names below. Nothing here is SQL.

import type { DateGrain } from '../../../analysis/categoryKey';
import type { Cell } from '../../../data/transforms';
import type { LiveColumn, LiveFilter } from '../liveSpec';

/**
 * A filter the layer applies: an IR filter once its data-relative periods are resolved, with the IR's meaning
 * (compileFilter is the reference). `binary` (a row lock, row-policy D13) only reaches a backend that declares
 * `caps.binaryCompare`; it must compare those values exactly.
 */
export type SemanticFilter = Exclude<LiveFilter, { kind: 'latest' }>;

export interface SemanticQuery {
  /** Grouped by, in order: a layer dimension, a date one at a grain the layer lists for it. */
  dimensions: Array<{ name: string; grain?: DateGrain }>;
  /** The layer's own metrics, by their names there. Empty: the dimensions' distinct values (a lookup). */
  metrics: string[];
  where: SemanticFilter[];
  /** By a dimension or a metric. A NULL sorts LAST in either direction, as the SQL path's `nullsLast` does. */
  order: Array<{ by: string; desc: boolean }>;
  limit?: number;
  /** Rows whose `dimension` is one of `values` are left out ("Other": everything past the kept categories). */
  exclude?: { dimension: string; values: Cell[] };
}

/** A layer's answer: `columns` name each row's cells by the query's dimensions, then its metrics. */
export interface SemanticAnswer {
  columns: string[];
  rows: unknown[][];
}

/** What the plan knows about the layer behind one dataset (b2 reads it from the synced record). */
export interface SemanticEnv {
  /** For the sentences only: the dataset's name and the layer's (`layerLabel`). */
  dataset: string;
  layer: string;
  /** The layer's dimensions, as the dataset declares them: the only names a filter or an axis may use. */
  columns: LiveColumn[];
  /** The layer's metrics; `additive` is the layer saying plain sum or count. */
  metrics: ReadonlyMap<string, { additive: boolean }>;
  /** The grains the layer lists per date dimension. */
  grains: ReadonlyMap<string, readonly DateGrain[]>;
  caps: { lookups: boolean; binaryCompare: boolean };
  /** The dataset's always-applied filters, AND-ed into every question (cross-part check 14: never skipped). */
  base?: readonly LiveFilter[];
}

/** The names an answer to `q` carries, in the order its cells are read. */
export function answerColumns(q: SemanticQuery): string[] {
  return [...q.dimensions.map((d) => d.name), ...q.metrics];
}

/** The rows positional to `want`, or null when the answer lacks one of them (the caller refuses `rowShape`). */
export function alignRows(columns: readonly string[], rows: readonly unknown[][], want: readonly string[]): unknown[][] | null {
  if (!Array.isArray(columns) || !Array.isArray(rows)) return null;
  const at = want.map((w) => columns.indexOf(w));
  if (at.some((i) => i < 0) || rows.some((r) => !Array.isArray(r) || r.length !== columns.length)) return null;
  return rows.map((r) => at.map((i) => r[i]));
}
