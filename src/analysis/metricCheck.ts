// WHY a metric formula would have no value — MAIN PROCESS, PURE logic.
//
// `compileMetricFormula` answers "does it parse". A formula that parses can
// still resolve to nothing, and the resolver (ipc/metrics.ts) then degrades it
// to null on purpose — a typo must never read as zero. That is right for a
// figure and useless for whoever is typing the formula: the editor would show
// "—" with no reason. This is the reason, as ONE sentence with the span of the
// text it is about, in the order someone would fix them:
//
//   syntax     the compiler's own error, at its own position
//   circular   the formula names the metric it defines, directly or round a loop
//   column     `[revenue]` bare — a column where a measure needs a total
//   unknown    `[Typo]` names no metric (with the nearest one, when close)
//   dataset    a chart measure naming a metric measured on another dataset
//   type       sum / avg / min / max over a column that is not a number
//
// The same compiler the resolver runs decides what an aggregation and what a
// metric reference is, so the editor and the figure cannot disagree about it.

import { tokenize, type Tok } from '../formula/formulaTokens';
import type { SourceSpan } from '../formula/formula';
import { nearestColumn } from '../formula/didYouMean';
import { compileMetricFormula } from './metricFormula';
import * as msg from './metricCheckMessages';

export type MetricIssueCode = 'syntax' | 'circular' | 'column' | 'unknown' | 'dataset' | 'type';

/** What the check needs to know about each OTHER metric of the project. */
export interface KnownMetric {
  name: string;
  datasetId: string;
  /** The metric names its own formula references ([] for a simple definition). */
  refs: string[];
}

export interface MetricCheckInput {
  expression: string;
  datasetId: string;
  /** The dataset's own columns, with their DECLARED types. */
  columns: { name: string; type: string }[];
  /** Columns reached through a relationship: aggregations, type unknown here. */
  related?: string[];
  /** Every other metric, keyed by lowercased name. */
  metrics: ReadonlyMap<string, KnownMetric>;
  /** The name this formula will be saved under — what makes a reference circular. */
  self?: string;
  /** The formula is a CHART measure: every operand must be this dataset's. */
  chart?: boolean;
}

export interface MetricCheck {
  ok: boolean;
  /** Every token with its source offsets — what the editor's highlight layer paints. */
  tokens: Tok[];
  code?: MetricIssueCode;
  error?: string;
  at?: SourceSpan;
}

/** Where `[ref]` (or a bare `ref`) is written. */
function refSpan(tokens: Tok[], ref: string): SourceSpan | undefined {
  const t = tokens.find((x) => (x.kind === 'col' || x.kind === 'name') && x.value === ref);
  return t ? { start: t.start, end: t.end } : undefined;
}

/** Where `sum(column)` is written: the whole call, as the compiler rewrote it. */
function aggSpan(tokens: Tok[], aggregation: string, column: string): SourceSpan | undefined {
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    const name = tokens[i];
    if (name.kind === 'name' && name.value.toLowerCase() === aggregation && tokens[i + 2].value === column) {
      return { start: name.start, end: tokens[i + 3].end };
    }
  }
  return undefined;
}

/**
 * The chain from `start` back to a name already on it, or null. `self` is on the
 * chain from the beginning: the formula being checked is not in `metrics` yet.
 */
function cycleFrom(start: string, self: string, metrics: ReadonlyMap<string, KnownMetric>): string[] | null {
  const path: string[] = [];
  const walk = (key: string, depth: number): boolean => {
    if (key === self || path.includes(key)) {
      path.push(key);
      return true;
    }
    const m = metrics.get(key);
    if (!m || depth > metrics.size) return false;
    path.push(key);
    for (const r of m.refs) if (walk(r.toLowerCase(), depth + 1)) return true;
    path.pop();
    return false;
  };
  return walk(start, 0) ? path : null;
}

export function checkMetricFormula(input: MetricCheckInput): MetricCheck {
  const src = typeof input.expression === 'string' ? input.expression : '';
  // Tokens first and separately: the highlight keeps its colours while a call is half-typed.
  let tokens: Tok[] = [];
  try {
    tokens = tokenize(src);
  } catch (_) {
    /* the compile below reports the same failure, with its position */
  }
  const names = input.columns.map((c) => c.name);
  const compiled = compileMetricFormula(src, names.concat(input.related ?? []));
  if (!compiled.ok) return { ok: false, tokens, code: 'syntax', error: compiled.error, at: compiled.at };

  const fail = (code: MetricIssueCode, error: string, at: SourceSpan | undefined): MetricCheck => ({ ok: false, tokens, code, error, at });
  const self = (input.self ?? '').trim().toLowerCase();
  const display = (key: string): string => (key === self ? (input.self ?? '').trim() : (input.metrics.get(key)?.name ?? key));

  for (const ref of compiled.program.metricRefs) {
    const key = ref.toLowerCase();
    const at = refSpan(tokens, ref);
    if (self && key === self) return fail('circular', msg.refersToItself(display(key)), at);
    const known = input.metrics.get(key);
    if (!known) {
      const column = names.find((n) => n === ref) ?? names.find((n) => n.toLowerCase() === key);
      if (column) return fail('column', msg.columnNeedsTotal(column), at);
      const near = nearestColumn(ref, Array.from(input.metrics.values(), (m) => m.name));
      return fail('unknown', near ? msg.unknownMetricNear(ref, near) : msg.unknownMetric(ref), at);
    }
    const loop = cycleFrom(key, self, input.metrics);
    if (loop) {
      const chain = (self ? [self] : []).concat(loop).map((k) => `[${display(k)}]`).join(' → ');
      return fail('circular', msg.circularReference(display(self || loop[loop.length - 1]), chain), at);
    }
    if (input.chart && known.datasetId !== input.datasetId) return fail('dataset', msg.otherDataset(known.name), at);
  }

  for (const agg of compiled.program.aggregates) {
    if (agg.aggregation === 'count') continue;
    const col = input.columns.find((c) => c.name === agg.column);
    // A related column or a level-of-detail value: its type is not known here.
    if (!col || col.type === 'number') continue;
    return fail('type', msg.needsNumberColumn(agg.aggregation, agg.column), aggSpan(tokens, agg.aggregation, agg.column));
  }
  return { ok: true, tokens };
}
