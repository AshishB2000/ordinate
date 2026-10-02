// The TRANSITION PLAN for a chart whose data changed: which marks stay, which
// arrive and which leave, matched BY LABEL — never by position, so a filter
// that removes "West" shrinks West out instead of morphing it into whatever
// slid into its slot. PURE, shared the markdown.ts way (globals in the
// renderer, require() in scripts/test-motion.js); motion.ts drives Chart.js
// from it.
//
// Duplicate labels are matched in order of appearance: the k-th "N/A" before
// is the k-th "N/A" after. `order[j]` is the old index the mark now at new
// index j came from, or -1 for an arriving one — which is exactly what the
// driver needs to carry a bar's element to its new slot (the slide).
(function (global: any) {
  interface MtEnter { index: number; label: string; to: any }
  interface MtUpdate { from: number; index: number; label: string; fromValue: any; toValue: any }
  interface MtExit { from: number; label: string; fromValue: any }
  interface MtPlan {
    enter: MtEnter[];
    update: MtUpdate[];
    exit: MtExit[];
    /** new index → old index, or -1 for an entering mark. */
    order: number[];
    /** True when the marks that stay are in a different relative order (a sort changed). */
    moved: boolean;
  }

  function keyer(): (label: unknown) => string {
    const seen = new Map<string, number>();
    return (label) => {
      const s = String(label);
      const k = seen.get(s) || 0;
      seen.set(s, k + 1);
      return s + '\u0000' + k;
    };
  }

  function planTransition(oldLabels: any[], oldValues: any[] | null, newLabels: any[], newValues: any[] | null): MtPlan {
    const ov = oldValues || [];
    const nv = newValues || [];
    const oldKey = keyer();
    const oldAt = new Map<string, number>();
    oldLabels.forEach((l, i) => oldAt.set(oldKey(l), i));

    const newKey = keyer();
    const plan: MtPlan = { enter: [], update: [], exit: [], order: [], moved: false };
    const matched = new Set<number>();
    let last = -1;
    newLabels.forEach((l, j) => {
      const i = oldAt.get(newKey(l));
      if (i === undefined) {
        plan.order.push(-1);
        plan.enter.push({ index: j, label: String(l), to: nv[j] });
        return;
      }
      plan.order.push(i);
      matched.add(i);
      if (i < last) plan.moved = true;
      last = i;
      plan.update.push({ from: i, index: j, label: String(l), fromValue: ov[i], toValue: nv[j] });
    });
    oldLabels.forEach((l, i) => {
      if (!matched.has(i)) plan.exit.push({ from: i, label: String(l), fromValue: ov[i] });
    });
    return plan;
  }

  /**
   * The FIRST step when marks leave: still on the OLD axis, every staying mark
   * at its new value and every leaving one at 0 — so exits shrink out where
   * they stood before anything slides. A leaving gap (null) stays a gap.
   */
  function exitStep(plan: MtPlan, oldValues: any[], newValues: any[]): any[] {
    const out = oldValues.map((v) => (typeof v === 'number' ? 0 : null));
    plan.update.forEach((u) => { out[u.from] = newValues[u.index]; });
    return out;
  }

  const api = { planTransition, exitStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    global.planTransition = planTransition;
    global.exitStep = exitStep;
  }
})(typeof window !== 'undefined' ? window : globalThis);
