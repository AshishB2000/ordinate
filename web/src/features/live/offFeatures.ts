// What is OFF for a Live dataset in v1, and why (docs/live-data/00-plan.md
// L2.6) — PURE words and routes. Each of these reads or rewrites ROWS, and a
// Live dataset keeps none here: its charts, KPI tiles and answers ask the
// warehouse instead. Every one is offered on a copy ("Make a copy" — a new
// extract of the same source, the Live dataset left as it is), and these
// routes say where the copy opens so the person lands where they were going.

export type LiveOffFeature =
  | 'prepare'
  | 'table'
  | 'search'
  | 'stats'
  | 'insights'
  | 'quality'
  | 'pivot'
  | 'cohort'
  | 'event_funnel'
  | 'drivers'
  | 'segments'
  | 'scenarios'
  | 'joins'
  | 'snapshots';

export interface LiveOffWords {
  /** "Prepare is off for Live datasets" — the state's title. */
  title: string;
  /** One sentence: what it needs that a Live dataset does not keep. */
  why: string;
  /** Where the copy opens for this feature. */
  open: (projectId: string, copyId: string) => string;
}

const page = (p: string, d: string, tab = '') => `/data/${p}/${d}${tab ? `?tab=${tab}` : ''}`;
const builder = (p: string, d: string) => `/visuals/${p}/new?dataset=${encodeURIComponent(d)}`;

export const LIVE_OFF: Readonly<Record<LiveOffFeature, LiveOffWords>> = {
  prepare: {
    title: 'Prepare steps and formulas are off for Live datasets',
    why: 'Steps, calculated fields and LOD expressions rewrite the rows, and a Live dataset keeps none here — every chart asks the warehouse.',
    open: (p, d) => `/data/${p}/${d}/prepare`,
  },
  table: {
    title: 'The table view is off for Live datasets',
    why: 'The rows stay in the warehouse, so there is nothing stored here to page through or sort.',
    open: (p, d) => page(p, d),
  },
  search: {
    title: 'Data search skips Live datasets',
    why: 'A value search reads the stored rows, and a Live dataset keeps its rows in the warehouse.',
    open: (p, d) => page(p, d),
  },
  stats: {
    title: 'Statistics are off for Live datasets',
    why: 'Correlation, regression and the other tests read every row, and a Live dataset keeps its rows in the warehouse.',
    open: (p, d) => `/analytics/${p}/${d}/stats`,
  },
  insights: {
    title: 'Insights and anomalies are off for Live datasets',
    why: 'The app finds movers, trends and outliers by reading the stored rows, and a Live dataset keeps none here.',
    open: (p, d) => page(p, d, 'insights'),
  },
  quality: {
    title: 'Quality checks are off for Live datasets',
    why: 'A rule is checked against every stored row, and a Live dataset keeps its rows in the warehouse.',
    open: (p, d) => page(p, d, 'quality'),
  },
  pivot: {
    title: 'Pivot tables are off for Live datasets',
    why: 'A pivot’s subtotals are recomputed from the rows, which a Live dataset does not keep here.',
    open: builder,
  },
  cohort: {
    title: 'Cohorts are off for Live datasets',
    why: 'A cohort grid follows each member through the rows, which a Live dataset does not keep here.',
    open: builder,
  },
  event_funnel: {
    title: 'Event funnels are off for Live datasets',
    why: 'A funnel follows each entity through its events in order, which needs the rows stored here.',
    open: builder,
  },
  drivers: {
    title: 'Drivers are off for Live datasets',
    why: 'Breaking a change down by every dimension reads the rows, and a Live dataset keeps none here.',
    open: (p, d) => `/analytics/${p}/${d}/drivers`,
  },
  segments: {
    title: 'Segments are off for Live datasets',
    why: 'k-means and RFM scoring read every row, and a Live dataset keeps its rows in the warehouse.',
    open: (p, d) => `/analytics/${p}/${d}/segments`,
  },
  scenarios: {
    title: 'Scenarios are off for Live datasets',
    why: 'A what-if recomputes its metrics from the stored rows, and a Live dataset keeps none here.',
    open: (p, d) => page(p, d),
  },
  joins: {
    title: 'Joins are off for Live datasets',
    why: 'Joining and relating tables matches rows, and a Live dataset keeps its rows in the warehouse.',
    open: (p, d) => page(p, d),
  },
  snapshots: {
    title: 'Snapshots are off for Live datasets',
    why: 'A snapshot keeps the stored table as it was before a refresh, and a Live dataset stores no table.',
    open: (p, d) => page(p, d, 'snapshots'),
  },
};

/** The plan's list, as the Live dataset's Data tab says it: what works on a copy instead. */
export const LIVE_OFF_LIST: readonly string[] = [
  'Prepare steps and formulas',
  'The table view and data search',
  'Statistics, insights and anomalies, quality checks',
  'Pivot tables, cohorts and event funnels',
  'Drivers, segments, scenarios, LOD and joins',
  'Snapshots',
];

/** Chart types a Live dataset cannot draw in v1: the grid engines, recomputed from the rows (L2.4 refuses them too). */
export const LIVE_OFF_CHARTS: ReadonlySet<string> = new Set(['pivot', 'cohort', 'event_funnel']);

/** The feature a chart type is, when it is off for Live. */
export function chartFeature(type: string): LiveOffFeature | null {
  return type === 'pivot' || type === 'cohort' || type === 'event_funnel' ? type : null;
}
