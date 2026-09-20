// THE TEMPLATE CATALOGUE — six dashboards and three layouts, as pure data plus
// one plan factory each.
//
// A template is NOT a new way to build a dashboard. Every factory here returns
// an ordinary `AnalysisPlan` and goes through the SAME `validatePlan` →
// `buildPlan` path a model's envelope and the starter layouts do, against the
// same real records. It gets no privileges for being app code: a role that
// mapped to the wrong column produces a dropped tile with a message, exactly
// like a model naming a column that is not there.
//
// NO MODEL, NO NETWORK, NO I/O. Columns and app-computed summaries in, a plan
// out. Nothing in this file produces a figure — the KPI tiles name a column and
// an aggregation, and `dashboard:metric` computes them at render time.
//
// ── What a tile may assume ────────────────────────────────────────────────
//
// A tile whose roles did not map is NOT EMITTED. That is the whole discipline
// here: every factory reads the mapping first and appends only what it can
// express, so "3 of 5 mapped · 2 tiles will be skipped" is a statement about
// what this file is about to do, not a guess. A template never emits a broken
// card and lets the validator clean up after it.
//
// ── Known ceilings, named rather than faked ───────────────────────────────
//
//   - NO TOP-N. `VizEncoding` has no `topN`, so "top customers" is a bar chart
//     over the customer column and vizData's own category cap decides how many
//     bars. Adding one is a storage-format decision, not a template's.
//   - NO COUNT-DISTINCT. `METRIC_AGGS` is sum/avg/count/min/max, so a "how many
//     customers" KPI is not expressible and the Customer template counts ORDERS
//     instead, labelled as such. Never a distinct count wearing a count's label.
//   - NO MEDIAN. Operations shows an average and a maximum duration.
//   - NO COHORT. A first-order-month cohort needs a per-customer `min(date)`
//     joined back onto every row. The only shape close to that in Prepare is
//     `group_aggregate`, which COLLAPSES the table — it would silently destroy
//     the dataset every other tile on the same sheet reads. Left out.

import { compile } from '../formula/formula';
import type {
  AnalysisPlan, PlanDataset, PlanSheet, PlannedCalcField, PlannedControl,
  PlannedMetric, PlannedVisual,
} from './analysisPlan';
import { buildStarterPlan } from './starterPlan';
import type { VizAggregation, VizEncoding } from './visuals';
import type { ResolvedGeoLevel } from './geoResolve';
import type { RoleMapping, TemplateRole } from './templateRoles';

export interface TemplateBuildOpts {
  /** The dashboard's name. Defaults to the template's own. */
  name?: string;
  /** column → the geography its VALUES resolve to (geoResolve.resolveGeoHits).
   *  A `geo` role with no entry here gets a bar chart instead of a map. */
  geoHits?: Record<string, { level: ResolvedGeoLevel; hitRate: number }>;
}

export interface DashboardTemplate {
  id: string;
  /** 'Templates' is the six subject dashboards; 'Layouts' is the three starters. */
  group: 'Templates' | 'Layouts';
  name: string;
  blurb: string;
  /** The chart type the gallery thumbnail draws from its fixture. '' = none. */
  thumb: string;
  roles: TemplateRole[];
  build(ds: PlanDataset, m: RoleMapping, opts?: TemplateBuildOpts): AnalysisPlan;
}

// ── Shared factory helpers ──────────────────────────────────────────────────

/** A formula reference to a column: bare when it is an identifier, bracketed
 *  otherwise (`[Order Date]`). Same rule as starterPlan.ts. */
function ref(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `[${name}]`;
}

/**
 * A tile name built from a COLUMN NAME, with its first letter raised.
 *
 * The column name itself is never touched — it is the truth about the data, and
 * the axis still shows it verbatim. This is only so a card reads "Revenue by
 * month" rather than "revenue by month" on a dataset whose columns are
 * lower-case, which most exports' are.
 */
function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * A plan under construction.
 *
 * Exists so a factory reads as a list of "add this if it maps" lines rather than
 * as array bookkeeping, and so the ONE rule that is easy to get wrong — a
 * calculated field whose name collides with a real column, which
 * `stepCalculatedField` refuses — is enforced in one place.
 */
class Draft {
  readonly calc: PlannedCalcField[] = [];
  readonly metrics: PlannedMetric[] = [];
  readonly visuals: PlannedVisual[] = [];
  readonly controls: PlannedControl[] = [];
  private readonly taken: Set<string>;

  constructor(private readonly ds: PlanDataset) {
    this.taken = new Set(ds.columns.map((c) => c.name));
  }

  /**
   * Add a calculated field and return the column name it will create, or null
   * when the expression does not compile.
   *
   * Compiled HERE with the real parser rather than assumed: a column name the
   * bracket syntax cannot express returns null and the tiles that depend on it
   * are simply not proposed, which costs the user nothing — where proposing one
   * validatePlan will drop costs them a drop message for a tile they never
   * asked about.
   */
  field(base: string, expression: string): string | null {
    let name = base;
    for (let i = 2; this.taken.has(name); i += 1) name = `${base} ${i}`;
    if (!compile(expression).ok) return null;
    this.taken.add(name);
    this.calc.push({ datasetId: this.ds.id, name, expression });
    return name;
  }

  /** `datetrunc` on a date column — the only way to chart by period, since
   *  VizEncoding's `grain` is a rendering choice and not a groupable column. */
  period(grain: 'month' | 'week', dateCol: string): string | null {
    const label = grain === 'month' ? 'Month' : 'Week';
    return this.field(label, `datetrunc('${grain}', ${ref(dateCol)})`);
  }

  metric(column: string | undefined, aggregation: PlannedMetric['aggregation'], label: string): void {
    if (!column) return;
    this.metrics.push({ datasetId: this.ds.id, column, aggregation, label });
  }

  chart(
    name: string,
    chartType: string,
    category: string | undefined,
    values: { column: string | undefined; aggregation: VizAggregation }[],
    extra: { series?: string; geo?: { level: ResolvedGeoLevel }; filters?: VizFilter[] } = {},
  ): void {
    if (!category) return;
    const vals = values.filter((v): v is { column: string; aggregation: VizAggregation } => !!v.column);
    if (vals.length === 0) return;
    const encoding: VizEncoding = { category, values: vals };
    if (extra.series) encoding.series = extra.series;
    if (extra.geo) encoding.geo = extra.geo;
    this.visuals.push({
      kind: 'new',
      datasetId: this.ds.id,
      name: cap(name),
      chartType,
      encoding,
      filters: (extra.filters || []).map((f) => ({ type: 'filter' as const, ...f })),
    });
  }

  control(kind: PlannedControl['kind'], column: string | undefined, label: string): void {
    if (!column) return;
    this.controls.push({ datasetId: this.ds.id, kind, column, label: cap(label) });
  }

  plan(sheetName: string, opts: TemplateBuildOpts, fallbackName: string): AnalysisPlan {
    const sheet: PlanSheet = {
      name: sheetName,
      metrics: this.metrics,
      visuals: this.visuals,
      texts: [],
    };
    if (this.controls.length) sheet.controls = this.controls;
    return {
      name: opts.name || fallbackName,
      rationale: '',
      calculatedFields: this.calc,
      sheets: [sheet],
    };
  }
}

interface VizFilter {
  column: string;
  op: '=' | '!=' | '>' | '<' | '>=' | '<=';
  value: string | number;
}

/** A `geo` role's resolved level, or undefined when its values are not places. */
function levelOf(opts: TemplateBuildOpts, column: string | undefined): ResolvedGeoLevel | undefined {
  if (!column) return undefined;
  return opts.geoHits?.[column]?.level;
}

function role(
  id: string, label: string, kind: TemplateRole['kind'], required: boolean, hints: string[],
): TemplateRole {
  return { id, label, kind, required, hints };
}

const DATE_HINTS = ['date', 'dt', 'day', 'period', 'timestamp', 'created', 'opened'];

// ── The six subject templates ───────────────────────────────────────────────

const SALES: DashboardTemplate = {
  id: 'sales',
  group: 'Templates',
  name: 'Sales overview',
  blurb: 'Revenue, orders and average order value, over time and by category.',
  thumb: 'line',
  roles: [
    role('date', 'Date', 'date', true, DATE_HINTS),
    role('revenue', 'Revenue', 'measure', true, ['revenue', 'sales', 'amount', 'amt', 'gross', 'turnover', 'total']),
    role('quantity', 'Quantity', 'measure', false, ['quantity', 'qty', 'units', 'unit', 'volume', 'items']),
    role('category', 'Category', 'dimension', true, ['category', 'product', 'type', 'group', 'class', 'segment', 'department', 'line']),
    role('region', 'Region', 'geo', false, ['region', 'state', 'province', 'country', 'market', 'territory', 'location']),
    role('customer', 'Customer', 'id', false, ['customer', 'cust', 'client', 'account', 'buyer', 'member']),
  ],
  build(ds, m, opts = {}) {
    const d = new Draft(ds);
    const month = m.date ? d.period('month', m.date) : null;
    d.metric(m.revenue, 'sum', 'Revenue');
    d.metric(m.date, 'count', 'Orders');
    // avg of the revenue column IS the average order value while a row is an
    // order — which is what "one revenue figure per date" already assumes.
    d.metric(m.revenue, 'avg', 'Avg order value');
    d.metric(m.quantity, 'sum', 'Quantity');
    if (month) d.chart(`${m.revenue} by month`, 'line', month, [{ column: m.revenue, aggregation: 'sum' }]);
    d.chart(`${m.revenue} by ${m.category}`, 'column', m.category, [{ column: m.revenue, aggregation: 'sum' }]);
    if (m.customer) d.chart(`Top ${m.customer}`, 'bar', m.customer, [{ column: m.revenue, aggregation: 'sum' }]);
    const level = levelOf(opts, m.region);
    // A map when the values are places the app can draw, a bar when they are
    // not. The same column either way — only the chart type changes.
    if (m.region) {
      d.chart(`${m.revenue} by ${m.region}`, level ? 'map_choropleth' : 'bar', m.region,
        [{ column: m.revenue, aggregation: 'sum' }], level ? { geo: { level } } : {});
    }
    d.control('date_range', m.date, 'Date');
    d.control('dropdown', m.region || m.category, m.region || m.category || '');
    return d.plan('Overview', opts, this.name);
  },
};

const FINANCE: DashboardTemplate = {
  id: 'finance',
  group: 'Templates',
  name: 'Finance P&L',
  blurb: 'Revenue against cost, profit over time, and margin by account.',
  thumb: 'clustered_column',
  roles: [
    role('date', 'Date', 'date', true, DATE_HINTS),
    role('revenue', 'Revenue', 'measure', true, ['revenue', 'sales', 'amount', 'amt', 'income', 'turnover']),
    role('cost', 'Cost', 'measure', true, ['cost', 'cogs', 'expense', 'expenses', 'spend', 'outlay', 'opex']),
    role('profit', 'Profit', 'measure', false, ['profit', 'net', 'earnings', 'contribution']),
    role('account', 'Account', 'dimension', true, ['account', 'category', 'ledger', 'department', 'line', 'centre', 'center', 'type']),
  ],
  build(ds, m, opts = {}) {
    const d = new Draft(ds);
    const month = m.date ? d.period('month', m.date) : null;
    // Profit is COMPUTED when the data does not carry it — an ordinary
    // calculated field, removable in Prepare like any hand-written one.
    const profit = m.profit
      || (m.cost ? d.field('Profit', `${ref(m.revenue)} - ${ref(m.cost)}`) : null)
      || undefined;
    // `div` is the safe divide: a zero denominator is null, never Infinity and
    // never a fabricated 0.
    const margin = profit
      ? d.field('Margin %', `div(${ref(profit)}, ${ref(m.revenue)}) * 100`) || undefined
      : undefined;
    d.metric(m.revenue, 'sum', 'Revenue');
    d.metric(m.cost, 'sum', 'Cost');
    d.metric(profit, 'sum', 'Profit');
    // Per-ROW margins averaged, which is not the overall margin — so it says so.
    d.metric(margin, 'avg', 'Avg margin %');
    if (month) {
      d.chart('Revenue vs cost by month', 'clustered_column', month, [
        { column: m.revenue, aggregation: 'sum' },
        { column: m.cost, aggregation: 'sum' },
      ]);
      d.chart('Profit by month', 'line', month, [{ column: profit, aggregation: 'sum' }]);
    }
    d.chart(`Cost by ${m.account}`, 'treemap', m.account, [{ column: m.cost, aggregation: 'sum' }]);
    d.chart(`Margin by ${m.account}`, 'table', m.account, [
      { column: margin, aggregation: 'avg' },
      { column: m.revenue, aggregation: 'sum' },
    ]);
    d.control('date_range', m.date, 'Date');
    d.control('dropdown', m.account, m.account || '');
    return d.plan('P&L', opts, this.name);
  },
};

const MARKETING: DashboardTemplate = {
  id: 'marketing',
  group: 'Templates',
  name: 'Marketing funnel',
  blurb: 'Impressions to leads to conversions, by channel, with cost per conversion.',
  thumb: 'funnel',
  roles: [
    role('date', 'Date', 'date', true, DATE_HINTS),
    role('channel', 'Channel', 'dimension', true, ['channel', 'source', 'medium', 'campaign', 'platform', 'network']),
    role('impressions', 'Impressions', 'measure', true, ['impressions', 'impression', 'visits', 'sessions', 'views', 'reach', 'traffic', 'clicks']),
    role('leads', 'Leads', 'measure', true, ['leads', 'lead', 'signups', 'signup', 'opportunities', 'trials', 'mqls']),
    role('conversions', 'Conversions', 'measure', true, ['conversions', 'conversion', 'orders', 'purchases', 'wins', 'closed']),
    role('spend', 'Spend', 'measure', false, ['spend', 'budget', 'investment', 'cost']),
  ],
  build(ds, m, opts = {}) {
    const d = new Draft(ds);
    const month = m.date ? d.period('month', m.date) : null;
    const rate = d.field('Conversion rate %', `div(${ref(m.conversions)}, ${ref(m.impressions)}) * 100`) || undefined;
    const cpc = m.spend
      ? d.field('Cost per conversion', `div(${ref(m.spend)}, ${ref(m.conversions)})`) || undefined
      : undefined;
    d.metric(m.impressions, 'sum', 'Impressions');
    d.metric(m.leads, 'sum', 'Leads');
    d.metric(m.conversions, 'sum', 'Conversions');
    d.metric(rate, 'avg', 'Avg conversion rate %');
    // A STAGE funnel (impressions → leads → conversions) would need those three
    // columns unpivoted into one stage column, which Prepare cannot express
    // without collapsing the table. So the funnel ranks CHANNELS by conversions
    // — the shape the chart type actually draws — and the three stage totals
    // live in the KPI strip above it.
    d.chart(`Conversions by ${m.channel}`, 'funnel', m.channel, [{ column: m.conversions, aggregation: 'sum' }]);
    if (m.spend) {
      d.chart(`Spend vs conversions by ${m.channel}`, 'clustered_column', m.channel, [
        { column: m.spend, aggregation: 'sum' },
        { column: m.conversions, aggregation: 'sum' },
      ]);
    }
    if (month) d.chart('Conversions by month', 'line', month, [{ column: m.conversions, aggregation: 'sum' }]);
    if (cpc) d.chart(`Cost per conversion by ${m.channel}`, 'table', m.channel, [{ column: cpc, aggregation: 'avg' }]);
    d.control('date_range', m.date, 'Date');
    d.control('dropdown', m.channel, m.channel || '');
    return d.plan('Funnel', opts, this.name);
  },
};

const OPERATIONS: DashboardTemplate = {
  id: 'operations',
  group: 'Templates',
  name: 'Operations',
  blurb: 'Status mix, weekly throughput and how long work takes, by team.',
  thumb: 'donut',
  roles: [
    role('date', 'Date', 'date', true, DATE_HINTS),
    role('status', 'Status', 'dimension', true, ['status', 'state', 'stage', 'phase', 'result', 'outcome', 'disposition']),
    role('team', 'Team', 'dimension', false, ['team', 'owner', 'assignee', 'group', 'department', 'squad', 'agent']),
    role('duration', 'Duration', 'measure', false, ['duration', 'leadtime', 'days', 'age', 'cycle', 'elapsed', 'hours', 'time']),
  ],
  build(ds, m, opts = {}) {
    const d = new Draft(ds);
    const week = m.date ? d.period('week', m.date) : null;
    d.metric(m.status, 'count', 'Items');
    d.metric(m.duration, 'avg', 'Avg duration');
    d.metric(m.duration, 'max', 'Longest');
    d.chart(`Items by ${m.status}`, 'donut', m.status, [{ column: m.status, aggregation: 'count' }]);
    if (week) d.chart('Throughput by week', 'column', week, [{ column: m.date, aggregation: 'count' }]);
    // One box per team, built from that team's weekly averages — a boxplot's
    // boxes are its SERIES (chartDatasets.ts), so the split column is the team.
    if (week && m.team && m.duration) {
      d.chart(`Duration by ${m.team}`, 'boxplot', week, [{ column: m.duration, aggregation: 'avg' }],
        { series: m.team });
    }
    d.control('date_range', m.date, 'Date');
    d.control('dropdown', m.status, m.status || '');
    return d.plan('Operations', opts, this.name);
  },
};

const CUSTOMER: DashboardTemplate = {
  id: 'customer',
  group: 'Templates',
  name: 'Customer',
  blurb: 'Who buys, what they are worth, and how that splits by segment.',
  thumb: 'bar',
  roles: [
    role('customer', 'Customer', 'id', true, ['customer', 'cust', 'client', 'account', 'buyer', 'member', 'user']),
    role('date', 'Date', 'date', true, DATE_HINTS),
    role('revenue', 'Revenue', 'measure', true, ['revenue', 'sales', 'amount', 'amt', 'spend', 'value']),
    role('segment', 'Segment', 'dimension', false, ['segment', 'tier', 'plan', 'cohort', 'type', 'category', 'grade']),
    role('region', 'Region', 'geo', false, ['region', 'state', 'province', 'country', 'market', 'territory', 'location']),
  ],
  build(ds, m, opts = {}) {
    const d = new Draft(ds);
    const month = m.date ? d.period('month', m.date) : null;
    d.metric(m.revenue, 'sum', 'Revenue');
    // ORDERS, not customers: there is no count-distinct aggregation, and a
    // labelled-as-customers row count would be a wrong figure. See the header.
    d.metric(m.customer, 'count', 'Orders');
    d.metric(m.revenue, 'avg', 'Avg order value');
    d.chart(`Top ${m.customer}`, 'bar', m.customer, [{ column: m.revenue, aggregation: 'sum' }]);
    if (m.segment) d.chart(`Revenue by ${m.segment}`, 'donut', m.segment, [{ column: m.revenue, aggregation: 'sum' }]);
    if (month) d.chart('Revenue by month', 'line', month, [{ column: m.revenue, aggregation: 'sum' }]);
    const level = levelOf(opts, m.region);
    if (m.region) {
      d.chart(`Revenue by ${m.region}`, level ? 'map_choropleth' : 'bar', m.region,
        [{ column: m.revenue, aggregation: 'sum' }], level ? { geo: { level } } : {});
    }
    d.control('date_range', m.date, 'Date');
    d.control('dropdown', m.segment || m.region, m.segment || m.region || '');
    return d.plan('Customers', opts, this.name);
  },
};

const INVENTORY: DashboardTemplate = {
  id: 'inventory',
  group: 'Templates',
  name: 'Inventory',
  blurb: 'What is on the shelf, what it is worth, and what needs reordering.',
  thumb: 'column',
  roles: [
    role('sku', 'SKU', 'id', true, ['sku', 'product', 'item', 'part', 'model', 'upc', 'barcode']),
    role('category', 'Category', 'dimension', true, ['category', 'type', 'group', 'class', 'family', 'department']),
    role('stock', 'Stock', 'measure', true, ['stock', 'inventory', 'onhand', 'quantity', 'qty', 'units', 'available']),
    role('reorder', 'Reorder level', 'measure', false, ['reorder', 'minimum', 'threshold', 'safety', 'par']),
    role('cost', 'Unit cost', 'measure', false, ['cost', 'cogs', 'value']),
  ],
  build(ds, m, opts = {}) {
    const d = new Draft(ds);
    const value = m.cost ? d.field('Stock value', `${ref(m.stock)} * ${ref(m.cost)}`) || undefined : undefined;
    // A 1/0 flag rather than a filtered metric: a PlannedMetric carries no
    // filters, so "how many are below reorder" is a SUM of a computed flag.
    const below = m.reorder
      ? d.field('Below reorder', `if(${ref(m.stock)} < ${ref(m.reorder)}, 1, 0)`) || undefined
      : undefined;
    d.metric(m.sku, 'count', 'SKUs');
    d.metric(m.stock, 'sum', 'Units in stock');
    d.metric(below, 'sum', 'Below reorder');
    d.metric(value, 'sum', 'Stock value');
    d.chart(`Stock by ${m.category}`, 'column', m.category, [{ column: m.stock, aggregation: 'sum' }]);
    if (below) {
      d.chart('Below reorder', 'table', m.sku, [
        { column: m.stock, aggregation: 'sum' },
        { column: m.reorder, aggregation: 'sum' },
      ], { filters: [{ column: below, op: '=', value: 1 }] });
    }
    if (value) d.chart(`Value by ${m.category}`, 'column', m.category, [{ column: value, aggregation: 'sum' }]);
    d.control('dropdown', m.category, m.category || '');
    return d.plan('Inventory', opts, this.name);
  },
};

// ── The three starter layouts, in the same catalogue ────────────────────────
//
// ONE CODE PATH: the gallery, the mapping step and the Create button do not
// know a "Layouts" card from a "Templates" card — they read `roles` (empty here)
// and call `build`. The two real starters delegate to buildStarterPlan, which is
// still the only author of those two shapes.

function starter(id: 'kpis' | 'twoup', name: string, blurb: string, thumb: string): DashboardTemplate {
  return {
    id, group: 'Layouts', name, blurb, thumb, roles: [],
    build(ds, _m, opts = {}) { return buildStarterPlan(id, ds, { name: opts.name }); },
  };
}

const BLANK: DashboardTemplate = {
  id: 'blank',
  group: 'Layouts',
  name: 'Blank sheet',
  blurb: 'One empty sheet. Add cards as you go.',
  thumb: '',
  roles: [],
  build(_ds, _m, opts = {}) {
    return {
      name: opts.name || 'Untitled dashboard',
      rationale: '',
      calculatedFields: [],
      sheets: [{ name: 'Sheet 1', metrics: [], visuals: [], texts: [] }],
    };
  },
};

export const TEMPLATES: DashboardTemplate[] = [
  SALES, FINANCE, MARKETING, OPERATIONS, CUSTOMER, INVENTORY,
  BLANK,
  starter('kpis', 'KPIs + chart', 'A KPI strip across the top, with a wide chart beneath it.', 'column'),
  starter('twoup', 'Two-up', 'Two charts side by side, with a notes card below.', 'bar'),
];

export function templateById(id: string): DashboardTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
