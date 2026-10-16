// A METRIC TREE's shape — MAIN PROCESS, PURE. How a metric breaks into parts
// (docs/metric-tree/00-design.md): its children by a formula relation — sum,
// product, ratio — or its segments by a text column. Stored on the metric's own
// record (`Metric.tree`), so no migration; every figure is computed on demand
// (src/ipc/metricTree.ts), never stored.
//
// `sanitizeTree` is the only way a tree reaches a record: ids are UUIDs, the
// root is the metric itself, the limits below hold, and a metric appears at
// most once on any root→leaf path (a cycle has no figure to decompose).

import { randomUUID } from 'crypto';

export type TreeRelation = 'sum' | 'product' | 'ratio';

export interface TreeNode {
  /** Stable key (expand state, React keys). */
  id: string;
  metricId: string;
  /** Sum only: this part is SUBTRACTED (Profit = Revenue − Cost). */
  negative?: true;
  /** How the children combine into this node. Absent with `split`, or on a leaf. */
  relation?: TreeRelation;
  children?: TreeNode[];
  /** OR: this node's segments by a text column. */
  split?: string;
}

export const TREE_MAX_DEPTH = 4;
export const TREE_MAX_NODES = 40;
/** Parts per relation: [min, max]. */
export const PARTS: Record<TreeRelation, [number, number]> = { sum: [2, 8], product: [2, 4], ratio: [2, 2] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/**
 * Whitelist an untrusted tree for the metric `rootId`, or null (no tree).
 * A node over the limits loses its breakdown, never the whole tree; a child
 * that would repeat a metric on its own path is dropped, and a relation left
 * with too few parts goes with it.
 */
export function sanitizeTree(raw: unknown, rootId: string): TreeNode | null {
  let count = 0;
  const node = (o: unknown, depth: number, path: Set<string>, metricId?: string): TreeNode | null => {
    const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
    const id = metricId ?? (r && isId(r.metricId) ? r.metricId : null);
    if (!r || !id || count >= TREE_MAX_NODES) return null;
    count += 1;
    const out: TreeNode = { id: isId(r.id) ? r.id : randomUUID(), metricId: id };
    if (r.negative === true) out.negative = true;
    if (depth >= TREE_MAX_DEPTH) return out;
    const seen = new Set(path).add(id.toLowerCase());
    if (typeof r.split === 'string' && r.split.trim() && r.split.length <= 512) {
      out.split = r.split;
      return out;
    }
    const relation = r.relation === 'sum' || r.relation === 'product' || r.relation === 'ratio' ? r.relation : null;
    if (!relation || !Array.isArray(r.children)) return out;
    const [min, max] = PARTS[relation];
    const kids: TreeNode[] = [];
    for (const c of r.children.slice(0, max)) {
      const cid = c && typeof c === 'object' ? (c as Record<string, unknown>).metricId : null;
      if (!isId(cid) || seen.has(cid.toLowerCase())) continue;
      const k = node(c, depth + 1, seen);
      if (!k) continue;
      if (relation !== 'sum') delete k.negative;
      kids.push(k);
    }
    if (kids.length < min) return out;
    out.relation = relation;
    out.children = kids;
    return out;
  };
  if (!isId(rootId)) return null;
  const root = node(raw, 0, new Set(), rootId);
  if (!root) return null;
  delete root.negative;
  return root.relation || root.split ? root : null;
}

/** Every metric id a tree names, root first. */
export function treeMetricIds(tree: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): void => {
    if (!out.includes(n.metricId)) out.push(n.metricId);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
}

// ── Suggestions, read from the project's formulas ───────────────────────────

export interface SuggestMetric {
  id: string;
  name: string;
  datasetId: string;
  formula?: string;
}

export interface Suggestion {
  relation: TreeRelation;
  children: Array<{ metricId: string; negative?: true }>;
  /** Which metric's formula it was read from. */
  from: string;
}

const REF = /\[([^\]]+)\]/g;

/** `[A] op [B] op …` with one operator throughout (− mixes with +) → its parts, else null. */
function readFormula(formula: string): { op: '+' | '*' | '/'; parts: Array<{ name: string; negative: boolean }> } | null {
  const tokens = formula.trim().split(REF);
  // split with a capture group: [text, name, text, name, …, text]
  if (tokens.length < 5) return null;
  const parts: Array<{ name: string; negative: boolean }> = [];
  let op: '+' | '*' | '/' | null = null;
  for (let i = 0; i < tokens.length; i += 2) {
    const glue = tokens[i].trim();
    if (i === 0 || i === tokens.length - 1) {
      if (glue) return null;
    } else {
      const kind = glue === '-' || glue === '+' ? '+' : glue === '*' || glue === '×' ? '*' : glue === '/' || glue === '÷' ? '/' : null;
      if (!kind || (op && op !== kind)) return null;
      op = kind;
    }
    if (i + 1 < tokens.length) parts.push({ name: tokens[i + 1].trim(), negative: i > 0 && glue === '-' });
  }
  if (!op || (op === '/' && parts.length !== 2)) return null;
  return { op, parts };
}

/**
 * Ways to break `self` down, from formulas on the same dataset:
 *   its own `[A] × [B]`, `[A] ÷ [B]`, `[A] + [B] − [C]`  → that relation;
 *   another metric `M = [self] ÷ [X]`                    → self = X × M
 *     (Avg order value = [Revenue] / [Orders] gives Revenue = Orders × Avg order value).
 */
export function suggestBreakdowns(self: SuggestMetric, all: SuggestMetric[]): Suggestion[] {
  const same = all.filter((m) => m.datasetId === self.datasetId);
  const byName = new Map(same.map((m) => [m.name.toLowerCase(), m]));
  const out: Suggestion[] = [];
  const push = (s: Suggestion): void => {
    const key = s.relation + s.children.map((c) => c.metricId + (c.negative ? '-' : '')).join();
    if (!out.some((o) => o.relation + o.children.map((c) => c.metricId + (c.negative ? '-' : '')).join() === key)) out.push(s);
  };
  const own = self.formula ? readFormula(self.formula) : null;
  if (own) {
    const kids = own.parts.map((p) => byName.get(p.name.toLowerCase()));
    if (kids.every((k) => k && k.id !== self.id)) {
      const relation: TreeRelation = own.op === '+' ? 'sum' : own.op === '*' ? 'product' : 'ratio';
      if (own.parts.length >= PARTS[relation][0] && own.parts.length <= PARTS[relation][1]) {
        push({ relation, from: self.name, children: kids.map((k, i) => ({ metricId: (k as SuggestMetric).id, ...(relation === 'sum' && own.parts[i].negative ? { negative: true as const } : {}) })) });
      }
    }
  }
  for (const m of same) {
    if (m.id === self.id || !m.formula) continue;
    const f = readFormula(m.formula);
    if (!f || f.op !== '/' || f.parts[0].name.toLowerCase() !== self.name.toLowerCase()) continue;
    const x = byName.get(f.parts[1].name.toLowerCase());
    if (x && x.id !== self.id && x.id !== m.id) push({ relation: 'product', from: m.name, children: [{ metricId: x.id }, { metricId: m.id }] });
  }
  return out;
}
