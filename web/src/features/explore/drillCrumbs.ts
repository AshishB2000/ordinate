// Explore's drill crumbs, drawn from the question itself: a text hierarchy's path is the group-by (level k) plus one
// `=` step on each level above it. PURE; nothing is stored, so Back, a copied link and a saved visual all agree.

import type { NavHierarchy } from '../model/navigation';
import { isKeptStep } from '../visuals/keptStep.ts';
import { levelOf } from '../../../../src/analysis/drillLevels.ts';
import type { Question } from './spec';

export interface DrillCrumb { label: string; to: Question | null } // null: the current level

const eqOn = (q: Question, column: string) => q.filters.filter((f) => !isKeptStep(f) && f.op === '=' && f.column === column);

/** Group by `h.levels[index]`; drop the `=` steps on the levels from there down to the one drawn now. */
export function upTo(q: Question, h: NavHierarchy, index: number): Question {
  const k = h.levels.indexOf(q.encoding.category);
  const gone = new Set(h.levels.slice(index, k));
  return { ...q, encoding: { ...q.encoding, category: h.levels[index] }, filters: q.filters.filter((f) => isKeptStep(f) || f.op !== '=' || !gone.has(f.column)) };
}

export function crumbsOf(q: Question, list: readonly NavHierarchy[]): DrillCrumb[] | null {
  const at = levelOf(list, q.encoding.category);
  if (!at || at.index < 1) return null;
  const { hierarchy: h, index: k } = at;
  const values: string[] = [];
  for (let j = 0; j < k; j++) {
    const steps = eqOn(q, h.levels[j]);
    if (steps.length !== 1) return null;
    values.push(String(steps[0].value ?? ''));
  }
  return [{ label: h.name, to: upTo(q, h, 0) }, ...values.map((label, j) => ({ label, to: j === k - 1 ? null : upTo(q, h, j + 1) }))];
}
