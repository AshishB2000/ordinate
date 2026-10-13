// Which columns hold PLACES — so a map is never left without its regions.
// MAIN PROCESS.
//
// A region map is drawn from `encoding.geo` and from nothing else: `buildVizData`
// emits regions only when it is set, and the web's MapView says "Nothing to map"
// without them. The template wizard has always filled it in from the column's
// VALUES (./geoResolve: the shipped boundary names, the renderer's own matcher).
// This file is that one answer for the two doors that never asked:
//
//   a PLAN   (analysisPlan.validateVisual, dashboardDelta) — no prompt gives a
//            model a way to name a geo level, so a drafted map arrives without
//            one. `geoHitsFor` samples a dataset once (loadPlanContext) and
//            `fillMapRegions` writes the level onto the encoding, or says why not.
//   a REPLY  (`visual:data` / `visual:preview`) — the builder's "Map regions"
//            starts Off. `withGeoSuggest` reads the labels the reply already
//            carries, so the builder can offer the map.
//
// What leaves this file is a LEVEL NAME (and, on the server only, a hit rate).
// Never a sampled value — a sample value is a cell out of the table.

import { sampleRowsResident, type StatsSource } from '../engine/statsResident';
import { resolveGeoHits, resolveGeoLevel, type ResolvedGeoLevel } from './geoResolve';
import type { GeoHits } from './templateRoles';
import type { VizEncoding } from './visuals';

export type { GeoHits };

/**
 * Rows read to decide whether a text column holds PLACES.
 *
 * Small on purpose. The question is "do these values resolve to a geography",
 * which a few dozen distinct values answer as well as a million do — and
 * `sampleRowsResident` is ordered, so the answer is the same on every run.
 */
const GEO_SAMPLE_ROWS = 200;

/** A level as a sentence names it — the facts block and the drop message. */
export const GEO_LEVEL_LABELS: Record<ResolvedGeoLevel, string> = { us_state: 'US states', country: 'countries' };

/** Text columns' sample values, for the geo signal only. Never returned to the
 *  renderer — a sample value is a cell out of the table. */
export async function geoHitsFor(src: StatsSource | null): Promise<GeoHits> {
  // A non-resident dataset contributes no geo signal, for the same reason
  // loadPlanContext gives it no summaries: it is never worth a hydrate.
  if (!src) return {};
  const textCols = src.columns
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.type === 'text');
  if (textCols.length === 0) return {};
  const rows = await sampleRowsResident(src, GEO_SAMPLE_ROWS);
  if (!rows) return {};
  const samples: Record<string, (string | number | null)[]> = {};
  for (const { c, i } of textCols) samples[c.name] = rows.map((r) => r[i] ?? null);
  return resolveGeoHits(samples);
}

/** The chart types whose marks are REGIONS: drawn from `encoding.geo`, or not at all. */
const REGION_MAPS: ReadonlySet<string> = new Set(['map_choropleth', 'map_bubble']);

export function isRegionMap(chartType: unknown): boolean {
  return typeof chartType === 'string' && REGION_MAPS.has(chartType);
}

/**
 * Give a region map its regions, or say why it cannot have them.
 *
 * Returns '' when there is nothing to refuse: another chart type, a map that
 * already names its regions (left exactly as it is — which is what makes a
 * validated plan validate to itself), or a map whose category column resolved,
 * in which case `enc.geo` is SET here. Otherwise the reason, for the caller's
 * drop message. The map is never turned into another chart.
 *
 * A dataset entry with no `geoHits` at all was never sampled (planCheck's dry
 * run reads metadata only): its map is left for the door that builds it, which
 * samples first (automation/creators.checkVisual).
 */
export function fillMapRegions(chartType: string, enc: VizEncoding, ds: { name: string; geoHits?: GeoHits }): string {
  if (!isRegionMap(chartType) || enc.geo || !ds.geoHits) return '';
  const hit = ds.geoHits[enc.category];
  if (!hit) {
    return `a map needs a column of places (${Object.values(GEO_LEVEL_LABELS).join(' or ')}), and "${enc.category}" in "${ds.name}" was not recognised as one`;
  }
  enc.geo = { level: hit.level };
  return '';
}

/**
 * A chart reply whose category labels are places, for an encoding that names no
 * regions: `geoSuggest` is the level a map of it would use.
 *
 * Costs no query and hydrates nothing — the labels are the reply's own, already
 * computed, and only the first GEO_SAMPLE_ROWS are read (a raw chart has one
 * per row). The reply gains a level name and nothing else.
 *
 * Not for a Live dataset's answer: the warehouse path refuses every map
 * (engine/live/liveSpec), so the suggestion would lead to a refusal.
 */
export function withGeoSuggest<R extends { ok: boolean }>(reply: R, encoding: VizEncoding): R {
  const r = reply as { data?: { labels?: unknown }; asOf?: { mode?: string } };
  if (!reply.ok || encoding.geo || r.asOf?.mode === 'live') return reply;
  const labels = r.data?.labels;
  if (!Array.isArray(labels)) return reply;
  const hit = resolveGeoLevel((labels as (string | number | null)[]).slice(0, GEO_SAMPLE_ROWS));
  return hit ? { ...reply, geoSuggest: { level: hit.level } } : reply;
}
