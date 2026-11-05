// A funnel metric's figure (semantic layer part 5, D5–D7) — MAIN PROCESS. "Visit → buy" is the funnel grid itself,
// asked of the ONE chart door (`vizDataFor` with an event funnel), so the resident twin or the JS reference, the row
// lock, glossary terms, Live's typed refusal and the answer cache are all the door's. Nothing here counts or matches.
//
// The scope picks WHO ENTERS (D6): a tile's filters, a dashboard's controls and terms ride on the encoding as the
// funnel's entry filters (`FunnelEncoding.entry`, runtime only). The metric's own filters and the row lock pick which
// events count: they are the door's filters, on every event, as the grid's are. A scope step the entry can't apply is
// refused with a sentence, never skipped: a column of another table or none of the dataset's, or a context filter
// over LOD fields (the entry would read the stored values, not the context's).

import type { MetricFunnelDefinition, FunnelShow } from '../analysis/funnelMetric';
import { funnelNeeds, windowMs } from '../analysis/funnelEvents';
import { needsLodPass } from '../analysis/lodQuery';
import { rewriteControlPeriods } from '../analysis/metricTime';
import { expandTerms } from '../analysis/termExpand';
import { resolveFilterParams } from '../analysis/params';
import { scopeRange } from '../analysis/periodScope';
import { periodDay, todayIso } from '../analysis/dateIntel';
import { formatCompact } from '../app/format';
import * as metrics from '../analysis/metrics';
import * as msg from '../analysis/metricCheckMessages';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { RowPolicyError } from '../data/rowPolicyError';
import type { RowPolicyReason } from '../data/rowPolicyError';
import { TermNotExpandedError, TERM_CODE } from '../data/termStep';
import type { TermReason } from '../data/termStep';
import { LiveFigureError } from '../engine/live/liveFigureError';
import type { LiveFailure } from '../engine/live/liveQuery';
import type { ResolveCtx } from './metrics';
import { vizDataFor } from './visuals';
import type { VizDataReply } from './visuals';

/** The figure a funnel (or one breakdown group of it) shows: converted ÷ entered, null when nobody entered. */
export function funnelFigure(f: { counts: number[] }, show: FunnelShow): number | null {
  const entered = f.counts[0] ?? 0;
  const converted = f.counts[f.counts.length - 1] ?? 0;
  if (show === 'entered') return entered;
  if (show === 'converted') return converted;
  return entered > 0 ? converted / entered : null;
}

/** A scope split: the row lock's steps filter every event, as the door applies them; the rest pick who enters. */
export function entryOf(scope: FilterStep[]): { entry: FilterStep[]; lock: FilterStep[] } {
  const plain = rewriteControlPeriods(scope, ''); // no mark reaches an engine or a cache key
  return { entry: plain.filter((f) => !f.lock), lock: plain.filter((f) => f.lock) };
}

/** Why `entry` can't pick who enters `datasetId`'s funnel, or null. */
export async function entryRefusal(projectId: string, datasetId: string, entry: FilterStep[]): Promise<string | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId); // schema only
  const own = new Set((meta?.columns ?? []).map((c) => c.name));
  const foreign = entry.find((f) => f.via || f.datasetId || !own.has(f.column));
  if (foreign) return msg.funnelEntryNotOwn(foreign.column);
  return needsLodPass(meta?.steps, entry, []) ? msg.funnelEntryLod() : null;
}

/** A door's refusal as the KPI door would say it: Live, row access and terms THROW typed; anything else is its sentence. */
export function refusalOf(r: Extract<VizDataReply, { ok: false }>): string {
  if (typeof r.code === 'string' && r.code.startsWith('live_')) throw new LiveFigureError(r as LiveFailure);
  if (r.code === 'row_policy') throw new RowPolicyError(r.reason as RowPolicyReason);
  if (r.code === TERM_CODE) throw new TermNotExpandedError(r.reason as TermReason, r.error);
  return r.error;
}

/** Whether entries in the scope's period on `time` (if any) may still convert: the period ends less than a window before today. */
function mayStillConvert(entry: FilterStep[], def: MetricFunnelDefinition): boolean {
  const range = scopeRange(entry, [{ name: def.funnel.time, type: 'date' }])?.range;
  const today = periodDay(todayIso());
  const end = periodDay(range?.to ?? todayIso());
  return !!range && today !== null && end !== null && end + Math.ceil(windowMs(def.funnel.window) / 86_400_000) >= today;
}

/**
 * The figure of a funnel metric: `ownFilters` (params bound here) on every event, `ctx.scope` picking who enters. At
 * depth 0 (the metric asked for, not a formula's operand) its notes say why there is no figure, how many rows were
 * left out, and that recent entries may still convert.
 */
export async function funnelMetricValue(ctx: ResolveCtx, datasetId: string, def: MetricFunnelDefinition, ownFilters: FilterStep[], depth: number): Promise<number | null> {
  const note = (n: string): void => {
    if (depth === 0 && !(ctx.notes ??= []).includes(n)) ctx.notes.push(n);
  };
  const own = resolveFilterParams(ownFilters, ctx.params).steps;
  const expanded = await expandTerms(ctx.projectId, datasetId, ctx.scope); // a term it can't use THROWS typed, as at the KPI door
  for (const n of expanded.notes) if (!(ctx.notes ??= []).includes(n)) ctx.notes.push(n);
  const { entry, lock } = entryOf(expanded.steps);
  const refused = await entryRefusal(ctx.projectId, datasetId, entry);
  if (refused) return (note(refused), null);
  const r = await vizDataFor(ctx.projectId, datasetId, { category: '', values: [], eventFunnel: { ...def.funnel, entry } }, [...lock, ...own], { params: ctx.params });
  if (!r.ok) return (note(refusalOf(r)), null);
  for (const n of r.notes ?? []) if (!(ctx.notes ??= []).includes(n)) ctx.notes.push(n);
  const f = r.data.eventFunnel;
  if (!f || f.needs) return (note(msg.snapshotPerNotColumn(goneColumn(def, f?.needs ?? ''))), null); // a column gone since the save
  if (f.excluded > 0) note(msg.funnelExcluded(formatCompact(f.excluded)));
  if (mayStillConvert(entry, def)) note(msg.funnelMayStillConvert());
  return funnelFigure(f, def.show);
}

/** The funnel column `needs` names (funnelEvents.funnelNeeds' sentence quotes it), else its entity. */
function goneColumn(def: MetricFunnelDefinition, needs: string): string {
  const { entity, event, time } = def.funnel;
  return [entity, event, time].find((c) => needs.includes(`"${c}"`)) ?? entity;
}

/** Why a save of `definition` as a funnel metric on `datasetId` is refused (its entity, event and time must be columns), or null. */
export async function checkFunnelDefinition(projectId: string, datasetId: string, definition: unknown): Promise<{ error: string; field: 'definition' } | null> {
  const def = metrics.sanitizeDefinition(definition);
  if (!metrics.isFunnelDefinition(def)) return null;
  const columns = (await datasets.getDatasetMeta(projectId, datasetId))?.columns ?? []; // schema only
  const needs = funnelNeeds(columns, def.funnel);
  return needs ? { error: msg.snapshotPerNotColumn(goneColumn(def, needs)), field: 'definition' } : null;
}
