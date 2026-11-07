// Metrics and terms hidden by what they read (semantic layer part 4, D19) — MAIN PROCESS.
//
// A metric whose definition, time column or filters — its glossary terms expanded, and every metric its formula
// names, walked the same way — mention a column hidden from the caller on ANY dataset of the project
// (data/rowAccess.hiddenAnywhere) is hidden from them: listed `hidden: true`, and left out of the Assistant's and
// the agents' vocabularies. A term likewise, by its filters. Matching is `mentionsHidden`'s: conservative, so a
// false match hides, never leaks. Records only: no row is read. The door refuses the figure itself (ipc/columnDoors).

import { hiddenAnywhere } from '../data/rowAccess';
import { mentionsHidden } from '../data/columnAccess';
import { isTermStep } from '../data/termStep';
import { isValidId } from '../app/ids';
import * as metrics from './metrics';
import type { Metric } from './metrics';
import { getTerm } from './terms';

/** Formula metrics nest at most this deep (statusPin's MAX_DEPTH): past it, as round a loop, nothing more is read. */
const MAX_DEPTH = 10;

/** Every string a metric's figure reads by: its definition, time column and filters, terms expanded; the metrics it names, recursively. */
async function questionOf(projectId: string, m: Metric, byName: Map<string, Metric>, seen: Set<string>): Promise<unknown[]> {
  if (seen.has(m.id) || seen.size > MAX_DEPTH) return [];
  seen.add(m.id);
  const out: unknown[] = [m.definition, m.timeColumn ?? '', m.filters];
  for (const s of m.filters as unknown[]) if (isTermStep(s)) out.push((await getTerm(projectId, s.term))?.filters ?? []);
  // A formula names other metrics by name; a later kind may name one by id (a period's base, a target's plan).
  const formula = metrics.isFormulaDefinition(m.definition) ? m.definition.formula : '';
  const named = [...byName.values()].filter((o) => o.id !== m.id && mentionsHidden(formula, new Set([o.name])));
  const ids = JSON.stringify(m.definition).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  for (const id of ids) if (isValidId(id)) { const o = await metrics.getMetric(projectId, id); if (o) named.push(o); }
  for (const o of named) out.push(...(await questionOf(projectId, o, byName, seen)));
  return out;
}

/** Does the metric read a column hidden from the caller anywhere in the project? False for an unrestricted caller. */
export async function metricHidden(projectId: string, id: string): Promise<boolean> {
  const hidden = await hiddenAnywhere(projectId);
  if (!hidden.size) return false;
  const m = await metrics.getMetric(projectId, id);
  return !!m && mentionsHidden(await questionOf(projectId, m, await metrics.metricsByName(projectId), new Set()), hidden);
}

/** Does the glossary term filter on a column hidden from the caller anywhere in the project? */
export async function termHidden(projectId: string, id: string): Promise<boolean> {
  const hidden = await hiddenAnywhere(projectId);
  if (!hidden.size) return false;
  const t = await getTerm(projectId, id);
  return !!t && mentionsHidden(t.filters, hidden);
}
