// A chart's encoding and its row filters, as the server stores them
// (src/analysis/visuals.ts VizEncoding, data/transforms FilterStep) — TYPES
// ONLY, no imports, so a page's pure helpers (and the e2e, type-stripped in
// Node) can name them without pulling in the RPC client. ./api re-exports them.

export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none';

export interface Measure {
  column: string;
  aggregation: Agg;
  /** A measure from a RELATED dataset (the "from …" groups). */
  datasetId?: string;
  metricId?: string;
  calc?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Geo {
  level: 'country' | 'us_state' | 'us_county' | 'us_city' | 'us_zip' | 'world_city' | 'point' | 'custom' | 'hexbin' | 'flow';
  lat?: string;
  lon?: string;
  lat2?: string;
  lon2?: string;
  from?: string;
  to?: string;
  color?: string;
  boundaryId?: string;
  property?: string;
  basemap?: 'osm' | 'none';
}

/**
 * A chart's encoding as the server stores it. Open on purpose: the shelves this
 * screen does not edit yet (pivot, cohort, eventFunnel, facet, drivers, bins)
 * ride through untouched, so opening and saving never drops them.
 */
export interface Encoding {
  category: string;
  values: Measure[];
  series?: string;
  grain?: string;
  overlay?: 'previous_year';
  geo?: Geo;
  categoryDatasetId?: string;
  seriesDatasetId?: string;
  [shelf: string]: unknown;
}

/**
 * A step in a filter list this version cannot edit: a glossary `term`, or a step a newer release
 * added. The server keeps it through every save (data/filterList.ts); the web carries it whole
 * (keptStep.ts `isKeptStep`) and never reads inside it.
 */
export interface KeptStep {
  type: string;
  [k: string]: unknown;
}

/** A visual-level row filter (a transforms `filter` step). */
export interface FilterStep {
  type: 'filter';
  column: string;
  op: string;
  value?: string | number | null;
  values?: (string | number | null)[];
  [k: string]: unknown;
}
