// The metric tree's PURE-JS REFERENCE — MAIN PROCESS, PURE: rows in, figures
// out. scripts/test-metricTree.ts compares the server's tree (src/ipc/metricTree,
// through the doors: computeCardMetric, the chart door, the resident fast path)
// with this one over the same hydrated rows, every figure with Object.is.
//
// It shares only the ARITHMETIC (./metricTreeMath, ./drivers.memberEffects —
// tested on their own); every figure it feeds them is computed here from rows:
// a metric by the same rules as ipc/metrics.resolveDefinition (a formula's
// aggregates under its own filters, a referenced metric under ITS filters,
// both under the scope), a split's operands by ./driversJs.memberAggsJs.

import type { Cell, FilterStep } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import type { Metric } from './metrics';
import { isFormulaDefinition } from './metrics';
import { computeMetric } from './metricValue';
import { compileMetricFormula, evaluateMetricFormula } from './metricFormula';
import { metricShape, evalLinear } from './driverShape';
import { memberEffects } from './drivers';
import { memberAggsJs } from './driversJs';
import type { TreeNode } from './metricTree';
import { contributions, topSegments } from './metricTreeMath';

export interface RefNode {
  name: string;
  current: number | null;
  previous: number | null;
  contribution?: number | null;
  children: RefNode[];
}

export interface RefInput {
  columns: ParsedColumn[];
  rows: Cell[][];
  metrics: Metric[];
  tree: TreeNode;
  current: FilterStep[];
  previous: FilterStep[];
}

const MAX_DEPTH = 10;

/** A metric's figure over the rows under `scope` — ipc/metrics.resolveDefinition, over rows. */
export function metricJs(columns: ParsedColumn[], rows: Cell[][], metrics: Metric[], m: Metric, scope: FilterStep[], depth = 0, stack = new Set<string>()): number | null {
  const table = (filters: FilterStep[]) => applyPipeline({ columns, rows }, filters.concat(scope));
  if (!isFormulaDefinition(m.definition)) {
    const t = table(m.filters);
    return m.definition.column ? computeMetric(t.columns, t.rows, m.definition) : null;
  }
  if (depth > MAX_DEPTH) return null;
  const compiled = compileMetricFormula(m.definition.formula, columns.map((c) => c.name));
  if (!compiled.ok) return null;
  const values = new Map<string, number | null>();
  const own = table(m.filters);
  for (const agg of compiled.program.aggregates) values.set(agg.ref, computeMetric(own.columns, own.rows, { column: agg.column, aggregation: agg.aggregation }));
  for (const ref of compiled.program.metricRefs) {
    const key = ref.toLowerCase();
    const other = metrics.find((x) => x.name.toLowerCase() === key);
    if (!other || stack.has(key)) {
      values.set(ref, null);
      continue;
    }
    values.set(ref, metricJs(columns, rows, metrics, other, scope, depth + 1, new Set(stack).add(key)));
  }
  return evaluateMetricFormula(compiled.program, values);
}

function splitJs(input: RefInput, m: Metric, column: string): RefNode[] {
  const shape = metricShape(m.datasetId, input.columns, m.definition, m.filters, new Map(input.metrics.map((x) => [x.name.toLowerCase(), x])), new Map(), m.name);
  if (shape.kind === 'none') return [];
  const table = memberAggsJs(input.columns, input.rows, { operands: shape.operands, a: input.current, b: input.previous }, [column]);
  const dim = table.dims[0];
  if (!dim) return [];
  const n = shape.operands.length;
  const sum = (lists: Array<Array<number | null>>): number[] => {
    const out = new Array<number>(n).fill(0);
    for (const l of lists) for (let i = 0; i < n; i += 1) out[i] += typeof l[i] === 'number' && Number.isFinite(l[i]) ? (l[i] as number) : 0;
    return out;
  };
  const figure = (ops: number[]): number | null => {
    const num = evalLinear(shape.num, ops);
    if (shape.kind === 'additive' || num === null) return num;
    const den = evalLinear(shape.den, ops);
    return den === null || den === 0 ? null : num / den;
  };
  const totalOps = { a: sum(dim.members.map((x) => x.a)), b: sum(dim.members.map((x) => x.b)) };
  const ta = figure(totalOps.a);
  const tb = figure(totalOps.b);
  const effects = memberEffects(shape, dim, { a: ta, b: tb, delta: ta !== null && tb !== null ? ta - tb : null }, totalOps);
  if (!effects) return [];
  const pick = topSegments(effects.map((e) => ({ key: e.key, contribution: e.delta })));
  const out: RefNode[] = pick.shown.map((i) => ({ name: effects[i].label, current: effects[i].a, previous: effects[i].b, contribution: effects[i].delta, children: [] }));
  if (pick.rest.length) {
    out.push({
      name: `Other (${pick.rest.length})`,
      current: figure(sum(pick.rest.map((i) => dim.members[i].a))),
      previous: figure(sum(pick.rest.map((i) => dim.members[i].b))),
      contribution: pick.rest.reduce((s, i) => s + effects[i].delta, 0),
      children: [],
    });
  }
  return out;
}

/** The tree's figures and contributions over rows — no residual rows, no display strings. */
export function treeJs(input: RefInput): RefNode {
  const node = (spec: TreeNode): RefNode => {
    const m = input.metrics.find((x) => x.id === spec.metricId);
    if (!m) return { name: '—', current: null, previous: null, children: [] };
    const self = new Set([m.name.toLowerCase()]);
    const out: RefNode = {
      name: m.name,
      current: metricJs(input.columns, input.rows, input.metrics, m, input.current, 0, self),
      previous: metricJs(input.columns, input.rows, input.metrics, m, input.previous, 0, self),
      children: [],
    };
    if (spec.relation && spec.children) {
      out.children = spec.children.map(node);
      const res = contributions(spec.relation, out.children.map((k, i) => ({ previous: k.previous, current: k.current, negative: !!spec.children?.[i].negative })));
      if (res.ok) out.children.forEach((k, i) => (k.contribution = res.contributions[i]));
    } else if (spec.split) {
      out.children = splitJs(input, m, spec.split);
    }
    return out;
  };
  return node(input.tree);
}
