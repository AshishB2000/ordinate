// `visual:drillDown` (semantic layer part 6, D4): a clicked mark → the exact filter steps behind it and the next level's
// encoding. It computes no figure: the browser asks `visual:data` (or the tile batch) with that encoding and
// `filters + steps`, through the existing doors, cache, Live executor and row lock.
//
// The mark resolves through the rows panel's own `drillInputs` → `resolveDrill` (./drillScope), so "Drill into East"
// and "the rows behind East" select the same rows, and refuse with the same sentence (D5). It is resolved on the axis
// alone (`withoutSplit`), so a split chart drills its axis and keeps every series. The grain lookup runs on Live too:
// it is the tile's own question, the executor's cached answer. A drill that names a column hidden from the caller
// (part 4) is refused at the column gate first, as `visual:data` refuses its chart.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { sanitizeEncoding } from '../analysis/visuals';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { getTableDoc } from '../app/tableDocs';
import { activeWeekCal } from '../analysis/retailCalendar';
import { dateLadder, levelOf, navHierarchies, nextGrain, nextLevel } from '../analysis/drillLevels';
import { rangeLabel } from '../analysis/driverScope';
import { closedToCaller } from '../data/rowAccess';
import { labelPairsForValues } from './valueLabelReplies';
import { drillInputs } from './drillScope';
import type { DrillRequest } from './drillScope';
import { resolveDrill } from './visuals';
import { gateColumnsReply } from './columnDoors';
import { drillFailed, drillFinestDate, drillHiddenLevel, drillLastLevel, drillNoHierarchy, drillNotThisChart } from './drillMessages';

/** `label`: the mark as people read it (a value label, a period); `next`: the next level's column, or the date grain. */
export interface DrillCrumb { column: string; label: string; next: string }

export type DrillDownReply =
  | { ok: true; available: true; encoding: VizEncoding; steps: FilterStep[]; crumb: DrillCrumb }
  | { ok: true; available: false; reason: string }
  | { ok: false; error: string; code?: string; reason?: string };

const withoutSplit = ({ series: _s, seriesDatasetId: _d, ...enc }: VizEncoding): VizEncoding => enc;
const refused = (reason: string): DrillDownReply => ({ ok: true, available: false, reason });

export async function drillDown(projectId: string, datasetId: string, req: DrillRequest, hidden: ReadonlySet<string> = new Set()): Promise<DrillDownReply> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const asked = sanitizeEncoding(req.encoding);
  if (asked.pivot || asked.cohort || asked.eventFunnel || asked.drivers || asked.facet) return refused(drillNotThisChart());

  const got = await drillInputs(projectId, datasetId, meta, req, { liveGrain: true });
  if (!got.ok) return 'reason' in got ? refused(got.reason) : got.failure;
  const { columns, enc, filters, mark, grain } = got.inputs;
  const resolved = resolveDrill(columns, withoutSplit(enc), filters, { category: mark?.category }, grain);
  if (!resolved.available) return refused(resolved.reason);
  const steps = resolved.filters.slice(filters.length);
  const value = mark?.category as string | number; // resolved, so present and not blank

  if (columns.find((c) => c.name === enc.category)?.type === 'date' && grain) {
    const next = nextGrain(dateLadder(activeWeekCal() !== null), grain);
    if (!next) return refused(drillFinestDate());
    return { ok: true, available: true, encoding: { ...enc, grain: next }, steps, crumb: { column: enc.category, label: rangeLabel(steps[0].period), next } };
  }
  const levels = navHierarchies((await getTableDoc(projectId, datasetId)).hierarchies ?? [], columns);
  const down = nextLevel(levels, enc.category);
  if (!down) {
    const at = levelOf(levels, enc.category);
    return refused(at ? drillLastLevel(enc.category, at.hierarchy.name) : drillNoHierarchy(enc.category));
  }
  if (hidden.has(down.next)) return refused(drillHiddenLevel(down.hierarchy.name)); // its chart would be refused next (part 4)
  const { grain: _g, bins: _b, overlay: _o, ...rest } = enc;
  // A value label names a stored value: none for a caller row access rules close the dataset to (catalog:columns REDACT).
  const pairs = typeof value === 'string' && !(await closedToCaller(projectId, datasetId)) ? await labelPairsForValues(projectId, datasetId, enc.category, [value]) : undefined;
  return { ok: true, available: true, encoding: { ...rest, category: down.next }, steps, crumb: { column: enc.category, label: pairs?.[0]?.[1] ?? String(value), next: down.next } };
}

export function register(): void {
  ipcMain.handle('visual:drillDown', async (_e, { projectId, datasetId, encoding, filters, mark, params }: Record<string, unknown> = {}): Promise<DrillDownReply> => {
    try {
      const [p, d] = [String(projectId ?? ''), String(datasetId ?? '')];
      return await gateColumnsReply(p, d, async () => [], [encoding, filters], (hidden) => drillDown(p, d, { encoding, filters, mark, params }, hidden));
    } catch (err) {
      return { ok: false, error: (err instanceof Error && err.message) || drillFailed() };
    }
  });
}
