// The drill ladders, as pure rules: which level a click goes to next. A hierarchy's levels are text columns a person
// named (src/app/hierarchies.ts); a date drills by the calendar's own ladder and needs no hierarchy. Type-only imports,
// so the web imports this file as it imports figureAsk.ts. Never reads the data: a hierarchy promises nothing.

import type { DateGrain } from './categoryKey';
import type { Hierarchy } from '../app/hierarchies';

/** `missing`: levels that are no longer a text column of the dataset. A hierarchy with any is stored but never walked. */
export interface NavHierarchy extends Hierarchy { missing?: string[] }

export const DRILL_CHART_TYPES: ReadonlySet<string> = new Set([
  'column', 'bar', 'clustered_column', 'clustered_bar', 'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar',
  'line', 'line_markers', 'area', 'stacked_area', 'pie', 'donut',
]);

export function dateLadder(weekCalendar: boolean): DateGrain[] {
  return weekCalendar ? ['year', 'quarter', 'month', 'week', 'day'] : ['year', 'quarter', 'month', 'day'];
}

/** The finer grain; a grain outside the ladder (a Gregorian week) goes to 'day'; 'day' is the last. */
export function nextGrain(ladder: readonly DateGrain[], grain: DateGrain): DateGrain | null {
  if (grain === 'day') return null;
  const i = ladder.indexOf(grain);
  return i < 0 ? 'day' : ladder[i + 1] ?? null;
}

/** Under a week calendar the month rung is the calendar's period. */
export function grainWord(grain: DateGrain, ladder: readonly DateGrain[]): string {
  return grain === 'month' && ladder.includes('week') ? 'period' : grain;
}

const usable = (h: NavHierarchy): boolean => !h.missing?.length;

export function levelOf(list: readonly NavHierarchy[], column: string): { hierarchy: NavHierarchy; index: number } | null {
  for (const hierarchy of list) {
    const index = hierarchy.levels.indexOf(column);
    if (index >= 0 && usable(hierarchy)) return { hierarchy, index };
  }
  return null;
}

export function nextLevel(list: readonly NavHierarchy[], column: string): { hierarchy: NavHierarchy; next: string } | null {
  const at = levelOf(list, column);
  const next = at && at.hierarchy.levels[at.index + 1];
  return at && next ? { hierarchy: at.hierarchy, next } : null;
}

export function navHierarchies(list: readonly Hierarchy[], columns: readonly { name: string; type: string }[]): NavHierarchy[] {
  const text = new Set(columns.filter((c) => c.type === 'text').map((c) => c.name));
  return list.map((h) => {
    const missing = h.levels.filter((l) => !text.has(l));
    return missing.length ? { ...h, missing } : { ...h };
  });
}
