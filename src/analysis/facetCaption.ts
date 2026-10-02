// The caption of a small-multiples tile — PURE, MAIN, NO MODEL.
//
// One sentence ACROSS the panels, from figures the app already computed:
// "West leads in 2 of 3 categories", "Sales rose in 3 of 4 regions". A
// per-panel sentence repeated N times is not a summary. Called by
// `captions.tileCaption` whenever `data.facets` is present.

import type { FacetGrid, FacetPanel } from './facets';

/** "Category" → "categories", "Region" → "regions", "Box" → "boxes". */
export function pluralNoun(field: string): string {
  const w = field.trim().toLowerCase();
  if (!w) return 'panels';
  if (/[^aeiou]y$/.test(w)) return w.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/.test(w)) return w + 'es';
  return w + 's';
}

/** Category label → its total across the panel's series; all-null categories dropped. */
function totals(p: FacetPanel): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  p.labels.forEach((l, i) => {
    let t = 0, seen = false;
    for (const s of p.series) {
      const v = s.values[i];
      if (typeof v === 'number' && Number.isFinite(v)) { t += v; seen = true; }
    }
    if (seen) out.push({ label: String(l), value: t });
  });
  return out;
}

/** `family` is captions' chart family ('line', 'bar', 'part', …). */
export function facetCaption(grid: FacetGrid | null | undefined, family: string): string {
  const panels = grid ? grid.panels.filter((p) => !p.empty) : [];
  if (!grid || !panels.length) return 'No data to summarize';
  const noun = grid.rowField ? 'panels' : pluralNoun(grid.colField || '');
  const n = panels.length;
  if (panels.some((p) => p.pivot) || family === 'point' || family === 'other') return `${n} ${noun}`;

  if (family === 'line') {
    let rose = 0, fell = 0;
    for (const p of panels) {
      const t = totals(p);
      if (t.length < 2) continue;
      const d = t[t.length - 1].value - t[0].value;
      if (d > 0) rose++; else if (d < 0) fell++;
    }
    const s0 = panels[0].series;
    const what = s0.length === 1 && s0[0].name ? s0[0].name.charAt(0).toUpperCase() + s0[0].name.slice(1) : 'The total';
    if (rose || fell) {
      const up = rose >= fell;
      return `${what} ${up ? 'rose' : 'fell'} in ${up ? rose : fell} of ${n} ${noun}`;
    }
  }

  // Who leads most often: the category with the largest total in each panel.
  const wins = new Map<string, number>();
  for (const p of panels) {
    const t = totals(p);
    if (!t.length) continue;
    let best = t[0];
    for (const x of t) if (x.value > best.value) best = x;
    wins.set(best.label, (wins.get(best.label) || 0) + 1);
  }
  if (!wins.size) return `${n} ${noun}`;
  let leader = '', k = 0;
  for (const [label, c] of wins) if (c > k) { leader = label; k = c; }
  if (n === 1) return `${leader} leads`;
  return k === n ? `${leader} leads in all ${n} ${noun}` : `${leader} leads in ${k} of ${n} ${noun}`;
}
