// A dashboard tile's drill (semantic layer D5): reader view state beside `tileSteps`, never saved and never on
// another tile. Each level is what `visual:drillDown` answered: the drilled encoding, the steps behind the mark and
// the crumb. The tile, its rows drawer, Explain and its ⋯ menu all read ONE drilled definition (`drilledDef`) and the
// SAME filters (`tileFilters` appends `drillSteps`).

import type { Step, VisualDef } from '../analyses/api';

export interface TileDrillLevel {
  encoding: VisualDef['encoding'];
  steps: Step[];
  crumb: { label: string; next: string; word: string };
}
/** `root`: the hierarchy's name, or "All dates". */
export interface TileDrill {
  root: string;
  levels: TileDrillLevel[];
}

/** `def` with the last level's encoding; the same object while the tile is not drilled. */
export function drilledDef<D extends { encoding: VisualDef['encoding'] }>(def: D, drill: TileDrill | undefined): D {
  const last = drill?.levels.at(-1);
  return last ? { ...def, encoding: last.encoding } : def;
}

export const drillSteps = (drill: TileDrill | undefined): Step[] => drill?.levels.flatMap((l) => l.steps) ?? [];
