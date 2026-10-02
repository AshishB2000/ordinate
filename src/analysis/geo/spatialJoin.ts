// The `spatial_join` prepare step — PURE, main process. Each row's point goes
// to the region containing it (./pip over a bbox grid index), written into a
// new TEXT column: a region name is a label, and a custom boundary's "01001"
// FIPS code must stay "01001".
//
// The boundaries arrive in the pipeline context, loaded and indexed by main
// before the fold (src/data/spatialRefs.ts); a set that could not be loaded
// skips the step with the reason, like a union's missing dataset. A row with
// no usable coordinates, or in no region, gets the step's `unmatched` value.
//
// The SQL pipeline (sqlGenPower) BAILS on this step: point in polygon is the
// fold's job, so a prepared dataset with a spatial join always folds in JS.

import type { Cell, TableData } from '../../data/transforms';
import type { PipelineContext, SpatialJoinStep } from '../../data/stepTypes';
import { isValidId } from '../../app/ids';
import { finiteNum, onGlobe } from './mercator';
import { locate } from './pip';
import type { BoundaryIndex } from './pip';

export const BUNDLED_BOUNDARIES: ReadonlyArray<{ id: SpatialJoinStep['boundary']; label: string }> = [
  { id: 'us_state', label: 'US states' },
  { id: 'country', label: 'Countries' },
  { id: 'us_county', label: 'US counties' },
];
const BOUNDARY_IDS: ReadonlySet<string> = new Set(['us_state', 'country', 'us_county', 'custom']);
const MAX_NAME = 500;

/** Where a step's boundary set lives in PipelineContext.boundaries. */
export function spatialKey(s: Pick<SpatialJoinStep, 'boundary' | 'boundaryId' | 'property'>): string {
  return s.boundary === 'custom' ? `custom:${s.boundaryId || ''}:${s.property || ''}` : s.boundary;
}

/** A feature's region name for a bundled level — a county says which state it is in. */
export function bundledName(level: string, props: Record<string, unknown>): string {
  const name = typeof props.name === 'string' ? props.name : '';
  if (level === 'us_county' && name && typeof props.state === 'string' && props.state) return `${name}, ${props.state}`;
  return name;
}

/** Whitelist an untrusted step, or say why it was refused. */
export function checkSpatialJoin(o: Record<string, unknown>): SpatialJoinStep | string {
  const str = (v: unknown): string => (typeof v === 'string' && v.length <= MAX_NAME ? v : '');
  const lat = str(o.lat);
  const lng = str(o.lng);
  if (!lat || !lng) return 'spatial join: pick the latitude and longitude columns';
  const boundary = typeof o.boundary === 'string' && BOUNDARY_IDS.has(o.boundary) ? (o.boundary as SpatialJoinStep['boundary']) : null;
  if (!boundary) return 'spatial join: unknown boundary set';
  const as = str(o.as).trim() || 'region';
  const unmatched = typeof o.unmatched === 'string' ? o.unmatched.slice(0, MAX_NAME) : '';
  const step: SpatialJoinStep = { type: 'spatial_join', lat, lng, boundary, as, unmatched };
  if (boundary === 'custom') {
    if (!isValidId(o.boundaryId)) return 'spatial join: that boundary set is not valid';
    const property = str(o.property);
    if (!property) return 'spatial join: pick the property that names each region';
    step.boundaryId = o.boundaryId as string;
    step.property = property;
  }
  return step;
}

interface JoinPlan { li: number; gi: number; index: BoundaryIndex }

/** The columns and the loaded index, or the reason the step skips. */
export function spatialPlan(t: TableData, s: SpatialJoinStep, ctx?: PipelineContext): JoinPlan | string {
  const li = t.columns.findIndex((c) => c.name === s.lat);
  const gi = t.columns.findIndex((c) => c.name === s.lng);
  if (li < 0) return `Assign regions skipped: unknown column "${s.lat}"`;
  if (gi < 0) return `Assign regions skipped: unknown column "${s.lng}"`;
  if (t.columns.some((c) => c.name === s.as)) return `Assign regions skipped: column "${s.as}" already exists`;
  const loaded = ctx && ctx.boundaries ? ctx.boundaries[spatialKey(s)] : undefined;
  if (!loaded) return 'Assign regions skipped: the boundaries are not loaded';
  if (typeof loaded === 'string') return `Assign regions skipped: ${loaded}`;
  return { li, gi, index: loaded };
}

/** One row's region, or null (no coordinates, or in no region). */
function regionOf(row: Cell[], plan: JoinPlan): string | null {
  const la = finiteNum(row[plan.li]);
  const lo = finiteNum(row[plan.gi]);
  if (!onGlobe(la, lo)) return null;
  return locate(plan.index, lo as number, la as number);
}

export function applySpatialJoin(t: TableData, s: SpatialJoinStep, ctx?: PipelineContext): { table: TableData; warnings: string[] } {
  const plan = spatialPlan(t, s, ctx);
  if (typeof plan === 'string') return { table: t, warnings: [plan] };
  const columns = t.columns.map((c) => ({ ...c })).concat([{ name: s.as, type: 'text' as const }]);
  const rows = t.rows.map((r) => r.concat([regionOf(r, plan) ?? s.unmatched]));
  return { table: { columns, rows }, warnings: [] };
}

/** What the editor's preview prints: matched points, and the regions they fell in most. */
export interface SpatialStats {
  total: number;
  matched: number;
  /** Rows whose coordinates are missing or off the globe. */
  noCoords: number;
  regions: number;
  top: Array<{ name: string; count: number }>;
}

export function spatialStats(t: TableData, s: SpatialJoinStep, ctx?: PipelineContext): SpatialStats | string {
  const plan = spatialPlan(t, s, ctx);
  if (typeof plan === 'string') return plan;
  const counts = new Map<string, number>();
  let matched = 0;
  let noCoords = 0;
  for (const row of t.rows) {
    const la = finiteNum(row[plan.li]);
    const lo = finiteNum(row[plan.gi]);
    if (!onGlobe(la, lo)) { noCoords += 1; continue; }
    const name = locate(plan.index, lo as number, la as number);
    if (name === null) continue;
    matched += 1;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  // Count descending, ties by name — a stable list whatever the row order.
  const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 5).map(([name, count]) => ({ name, count }));
  return { total: t.rows.length, matched, noCoords, regions: counts.size, top };
}
