// Self-check for the DASHBOARD TEMPLATES: the catalogue, the semantic column
// mapping, and the plans the factories emit.
//
// Everything here is pure — a PlanDataset literal in, a plan out, through the
// REAL `validatePlan` the Assistant's envelope goes through. No project on
// disk, no model. The one thing that touches the filesystem is the
// geo resolver, which reads the two SHIPPED boundary assets; that is the point
// of it, and the same assets scripts/test-geoLevels.ts loads.
//
// The load-bearing assertion is the third one: every template, on its own
// fixture, produces a plan that validates with ZERO drops. A factory that emits
// a tile the validator refuses is not a smaller dashboard, it is a lie in the
// gallery — the card said it would build six tiles and five appeared.
//
// Run: node scripts/test-templates.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

import type { ParsedColumn } from '../src/data/parse';
import type { ColumnSummary } from '../src/data/datasetStats';
import type { AnalysisPlan, PlanContext, PlanDataset } from '../src/analysis/analysisPlan';
import { validatePlan } from '../src/analysis/analysisPlan';
import { arrangeSheet, readingOrder } from '../src/analysis/planLayout';
import { resolveGeoHits, resolveGeoLevel } from '../src/analysis/geoResolve';
import { mapRoles, mappingOf, type GeoHits, type RoleMapping } from '../src/analysis/templateRoles';
import { TEMPLATES, templateById, type DashboardTemplate } from '../src/analysis/templates';

// ── Fixtures ────────────────────────────────────────────────────────────────

const DS_ID = '11111111-2222-3333-4444-555555555555';

/** A PlanDataset from a compact `name:type:distinct` spec. `distinct` feeds the
 *  shape signal; `nonEmpty` is the row count, so an id's ratio is meaningful. */
function fixture(rows: number, spec: [string, ParsedColumn['type'], number?][]): PlanDataset {
  const columns: ParsedColumn[] = spec.map(([name, type]) => ({ name, type }));
  const summaries: ColumnSummary[] = spec.map(([name, type, distinct]) => {
    const s: ColumnSummary = { name, type, nonEmpty: rows };
    if (typeof distinct === 'number') s.distinct = distinct;
    return s;
  });
  return { id: DS_ID, name: 'Fixture', rowCount: rows, columns, resident: true, summaries };
}

/** The BUNDLED sample dataset's real schema (scripts/gen-sample-data.ts) with
 *  its real cardinalities — the dataset every smoke and every first run sees. */
const SAMPLE = fixture(1_000_000, [
  ['order_date', 'date', 731],
  ['region', 'text', 5],
  ['state', 'text', 25],
  ['category', 'text', 3],
  ['sub_category', 'text', 12],
  ['customer_segment', 'text', 3],
  ['units', 'number'],
  ['unit_price', 'number'],
  ['discount', 'number'],
  ['revenue', 'number'],
  ['profit', 'number'],
  ['ship_days', 'number'],
]);

/** The same data, named the way a real export names it. */
const AWKWARD = fixture(5000, [
  ['Dt', 'date', 400],
  ['Cust ID', 'text', 4200],
  ['Amt', 'number'],
  ['Qty', 'number'],
  ['Product Group', 'text', 8],
  ['Ship To State', 'text', 20],
]);

/** Real values, resolved through the real boundary assets. */
const SAMPLE_GEO: GeoHits = resolveGeoHits({
  region: ['West', 'East', 'Central', 'South', 'Northeast'],
  state: ['California', 'Texas', 'New York', 'Illinois', 'Massachusetts', 'Oregon'],
  category: ['Technology', 'Furniture', 'Office Supplies'],
  sub_category: ['Phones', 'Chairs', 'Paper'],
  customer_segment: ['Consumer', 'Corporate', 'Home Office'],
});
const AWKWARD_GEO: GeoHits = resolveGeoHits({
  'Cust ID': ['C-1', 'C-2'],
  'Product Group': ['Widgets', 'Gadgets'],
  'Ship To State': ['Ohio', 'Maine', 'Nevada', 'Georgia'],
});

const ctxFor = (ds: PlanDataset): PlanContext => ({ datasets: [ds], visuals: [] });

/** Every column name a plan NAMES, anywhere. */
function referencedColumns(plan: AnalysisPlan): string[] {
  const out: string[] = [];
  for (const sheet of plan.sheets) {
    for (const m of sheet.metrics) out.push(m.column);
    for (const v of sheet.visuals) {
      out.push(v.encoding.category);
      for (const val of v.encoding.values) out.push(val.column);
      if (v.encoding.series) out.push(v.encoding.series);
      for (const f of v.filters) out.push(f.column);
    }
    for (const c of sheet.controls || []) out.push(c.column);
  }
  return out;
}

function tileCount(plan: AnalysisPlan): number {
  return plan.sheets.reduce(
    (n, s) => n + s.metrics.length + s.visuals.length + s.texts.length + (s.controls || []).length, 0);
}

// ── §1 catalogue integrity ──────────────────────────────────────────────────

ok('the catalogue has the six subject templates and the five layouts',
   TEMPLATES.filter((t) => t.group === 'Templates').length === 6 &&
   TEMPLATES.filter((t) => t.group === 'Layouts').length === 5,
   TEMPLATES.map((t) => `${t.group}/${t.id}`).join(' '));

ok('…every id is unique', new Set(TEMPLATES.map((t) => t.id)).size === TEMPLATES.length);

ok('…and buildStarterPlan’s four layouts are catalogue entries, not a second path',
   ['kpis', 'twoup', 'spotlight', 'lead'].every((id) => !!templateById(id)),
   TEMPLATES.filter((t) => t.group === 'Layouts').map((t) => t.id).join(' '));

ok('every role declares a label, a kind and at least one hint',
   TEMPLATES.every((t) => t.roles.every((r) =>
     !!r.id && !!r.label && !!r.kind && Array.isArray(r.hints) && r.hints.length > 0)));

ok('…role ids are unique within a template',
   TEMPLATES.every((t) => new Set(t.roles.map((r) => r.id)).size === t.roles.length));

ok('…and every hint is lower-case (nameScore lower-cases the column, not the hint)',
   TEMPLATES.every((t) => t.roles.every((r) => r.hints.every((h) => h === h.toLowerCase()))));

// EVERY ROLE A TILE READS IS DECLARED. A factory reaching for `m.custmer` would
// otherwise fail silently — the tile is simply never emitted, the plan still
// validates, and the gallery quietly builds one card fewer than it promised.
// A recording Proxy is what makes that loud.
for (const t of TEMPLATES) {
  const declared = new Set(t.roles.map((r) => r.id));
  const read = new Set<string>();
  const spy = new Proxy({} as RoleMapping, {
    get(_t, k: string) { read.add(String(k)); return 'order_date'; },
    has(_t, k: string) { read.add(String(k)); return true; },
  });
  t.build(SAMPLE, spy, { geoHits: SAMPLE_GEO });
  const undeclared = [...read].filter((k) => !declared.has(k) && k !== 'then');
  ok(`${t.id}: every role its tiles read is declared`, undeclared.length === 0, undeclared.join(', '));
}

// ── §2 mapRoles ─────────────────────────────────────────────────────────────

const sales = templateById('sales') as DashboardTemplate;
const salesMap = mappingOf(mapRoles(sales.roles, SAMPLE, SAMPLE_GEO).matches);

ok('Sales on the sample data maps date → order_date', salesMap.date === 'order_date', salesMap.date);
ok('…revenue → revenue', salesMap.revenue === 'revenue', salesMap.revenue);
ok('…quantity → units (NOT unit_price: a sum of prices is not a quantity)',
   salesMap.quantity === 'units', salesMap.quantity);
ok('…category → category (NOT sub_category: the whole name wins the tie)',
   salesMap.category === 'category', salesMap.category);
// THE POINT OF THE GEO SIGNAL. `region` matches the role's name hints exactly
// and `state` matches them too — only one of them holds places the app can draw.
ok('…and region → state, because its VALUES resolve to a geography',
   salesMap.region === 'state', salesMap.region);

const salesGeo = mapRoles(sales.roles, SAMPLE, SAMPLE_GEO).matches.find((m) => m.role === 'region');
ok('…carrying the choropleth level that resolved', salesGeo?.geoLevel === 'us_state', JSON.stringify(salesGeo));

ok('with NO geo evidence the same role falls back to the name match',
   mappingOf(mapRoles(sales.roles, SAMPLE, {}).matches).region === 'region');

const awkward = mappingOf(mapRoles(sales.roles, AWKWARD, AWKWARD_GEO).matches);
ok('awkward names: date → Dt', awkward.date === 'Dt', awkward.date);
ok('…revenue → Amt', awkward.revenue === 'Amt', awkward.revenue);
ok('…quantity → Qty', awkward.quantity === 'Qty', awkward.quantity);
ok('…category → Product Group', awkward.category === 'Product Group', awkward.category);
ok('…customer → Cust ID', awkward.customer === 'Cust ID', awkward.customer);
ok('…region → Ship To State', awkward.region === 'Ship To State', awkward.region);

ok('mapping is deterministic — same inputs, same answer',
   JSON.stringify(mapRoles(sales.roles, SAMPLE, SAMPLE_GEO))
   === JSON.stringify(mapRoles(sales.roles, SAMPLE, SAMPLE_GEO)));

ok('one column plays one part',
   new Set(Object.values(salesMap)).size === Object.values(salesMap).length,
   JSON.stringify(salesMap));

// A REQUIRED role that cannot map is what dims a card. Finance needs a cost
// column and the sample has none — no numeric column here is a cost, and the
// mapper must not settle for the nearest number.
const finance = templateById('finance') as DashboardTemplate;
const financeOnSample = mapRoles(finance.roles, SAMPLE, SAMPLE_GEO);
ok('Finance cannot map "Cost" on the sample data, so its card is dimmed',
   financeOnSample.missingRequired.length === 1 && financeOnSample.missingRequired[0] === 'Cost',
   JSON.stringify(financeOnSample.missingRequired));

ok('confidence is reported per role, and an exact name+shape match is high',
   mapRoles(sales.roles, SAMPLE, SAMPLE_GEO).matches
     .filter((m) => m.role === 'revenue' || m.role === 'region')
     .every((m) => m.confidence === 'high'));
ok('…while a name match over the wrong SHAPE is downgraded, not dropped',
   mapRoles(sales.roles, SAMPLE, SAMPLE_GEO).matches
     .find((m) => m.role === 'customer')?.confidence === 'medium');

ok('a column whose declared type is wrong is never taken, however it is named',
   mappingOf(mapRoles(sales.roles,
     fixture(10, [['revenue', 'text', 9], ['order_date', 'date', 9]]), {}).matches).revenue === undefined);

ok('geoResolve says no to values that are not places',
   resolveGeoLevel(['East', 'West', 'Central']) === null);
ok('…and yes to US states', resolveGeoLevel(['California', 'Texas', 'Ohio'])?.level === 'us_state');
ok('…and to countries', resolveGeoLevel(['France', 'Japan', 'Brazil'])?.level === 'country');
ok('…on an empty column it is simply null', resolveGeoLevel([null, '', '  ']) === null);

// ── §3 every template builds a plan the validator keeps WHOLE ───────────────

/** One fixture per template: the shape that template is FOR. */
const FIXTURES: Record<string, { ds: PlanDataset; geo: GeoHits }> = {
  sales: { ds: SAMPLE, geo: SAMPLE_GEO },
  finance: {
    ds: fixture(50_000, [
      ['period', 'date', 36], ['account', 'text', 14],
      ['revenue', 'number'], ['cost', 'number'],
    ]),
    geo: {},
  },
  marketing: {
    ds: fixture(20_000, [
      ['date', 'date', 400], ['channel', 'text', 7],
      ['impressions', 'number'], ['leads', 'number'], ['conversions', 'number'], ['spend', 'number'],
    ]),
    geo: {},
  },
  operations: {
    ds: fixture(30_000, [
      ['created', 'date', 500], ['status', 'text', 4], ['team', 'text', 9],
      ['duration', 'number'],
    ]),
    geo: {},
  },
  customer: {
    ds: fixture(40_000, [
      ['customer', 'text', 30_000], ['order_date', 'date', 500],
      ['segment', 'text', 4], ['state', 'text', 20], ['revenue', 'number'],
    ]),
    geo: resolveGeoHits({ customer: ['C-1'], segment: ['Pro', 'Free'], state: ['Ohio', 'Maine', 'Texas'] }),
  },
  inventory: {
    ds: fixture(8000, [
      ['sku', 'text', 7900], ['category', 'text', 11],
      ['stock', 'number'], ['reorder', 'number'], ['unit_cost', 'number'],
    ]),
    geo: {},
  },
  blank: { ds: SAMPLE, geo: {} },
  kpis: { ds: SAMPLE, geo: {} },
  twoup: { ds: SAMPLE, geo: {} },
  spotlight: { ds: SAMPLE, geo: {} },
  lead: { ds: SAMPLE, geo: {} },
};

for (const t of TEMPLATES) {
  const fx = FIXTURES[t.id];
  const { matches, missingRequired } = mapRoles(t.roles, fx.ds, fx.geo);
  ok(`${t.id}: every required role maps on its own fixture`,
     missingRequired.length === 0, missingRequired.join(', '));
  const plan = t.build(fx.ds, mappingOf(matches), { geoHits: fx.geo });
  const { plan: validated, dropped } = validatePlan(plan, ctxFor(fx.ds));
  ok(`${t.id}: its plan validates with ZERO drops`,
     dropped.length === 0, dropped.map((d) => d.message).join(' | '));
  ok(`${t.id}: nothing survives validation that the factory did not emit`,
     tileCount(validated) === tileCount(plan),
     `${tileCount(plan)} → ${tileCount(validated)}`);
  const known = new Set(fx.ds.columns.map((c) => c.name).concat(plan.calculatedFields.map((c) => c.name)));
  ok(`${t.id}: every column it names exists or is one it computes`,
     referencedColumns(plan).every((c) => known.has(c)),
     referencedColumns(plan).filter((c) => !known.has(c)).join(', '));
  // Re-validating a validated plan must be a fixed point — that is the property
  // `analysis:buildPlan` relies on when it re-validates what the preview showed.
  const again = validatePlan(validated, ctxFor(fx.ds));
  ok(`${t.id}: a validated plan survives re-validation unchanged`,
     again.dropped.length === 0 && tileCount(again.plan) === tileCount(validated));
}

// ── §4 the Sales sheet is the one the gallery promises ──────────────────────

const salesPlan = sales.build(SAMPLE, salesMap, { geoHits: SAMPLE_GEO });
const salesSheet = salesPlan.sheets[0];
ok('Sales builds four KPIs', salesSheet.metrics.length === 4,
   salesSheet.metrics.map((m) => m.label).join(', '));
ok('…a line, a column, a bar and a map',
   JSON.stringify(salesSheet.visuals.map((v) => v.chartType))
     === JSON.stringify(['line', 'column', 'bar', 'map_choropleth']),
   salesSheet.visuals.map((v) => v.chartType).join(', '));
ok('…the map carries the resolved level',
   salesSheet.visuals[3].encoding.geo?.level === 'us_state');
ok('…a filter bar of two controls, a date range and a dropdown',
   JSON.stringify((salesSheet.controls || []).map((c) => c.kind + ':' + c.column))
     === JSON.stringify(['date_range:order_date', 'dropdown:state']),
   JSON.stringify(salesSheet.controls));
ok('…and one calculated field, the month bucket',
   salesPlan.calculatedFields.length === 1 &&
   salesPlan.calculatedFields[0].expression === "datetrunc('month', order_date)",
   JSON.stringify(salesPlan.calculatedFields));
ok('no KPI carries a figure — a plan can only name a column and an aggregation',
   salesSheet.metrics.every((m) => Object.keys(m).sort().join(',') === 'aggregation,column,datasetId,label'));

// ── §5 an optional role that does not map drops its tile, not the plan ──────

const { region: _r, customer: _c, quantity: _q, ...bare } = salesMap;
const barePlan = sales.build(SAMPLE, bare as RoleMapping, {});
const bareValidated = validatePlan(barePlan, ctxFor(SAMPLE));
ok('dropping three optional roles drops exactly their tiles',
   bareValidated.dropped.length === 0 &&
   barePlan.sheets[0].metrics.length === 3 &&
   JSON.stringify(barePlan.sheets[0].visuals.map((v) => v.chartType)) === JSON.stringify(['line', 'column']),
   `${barePlan.sheets[0].metrics.length} KPIs / ${barePlan.sheets[0].visuals.map((v) => v.chartType).join(',')}`);
ok('…and the filter bar keeps the controls it still can build',
   JSON.stringify((barePlan.sheets[0].controls || []).map((c) => c.column))
     === JSON.stringify(['order_date', 'category']),
   JSON.stringify(barePlan.sheets[0].controls));

// A geo role that mapped to a column whose values are NOT places is a bar, not
// a blank map — the fallback that makes the role safe to offer at all.
const noGeoPlan = sales.build(SAMPLE, { ...salesMap, region: 'region' }, {});
ok('a geo role over non-places falls back to a bar chart',
   noGeoPlan.sheets[0].visuals.some((v) => v.chartType === 'bar' && v.encoding.category === 'region') &&
   !noGeoPlan.sheets[0].visuals.some((v) => v.chartType === 'map_choropleth'),
   noGeoPlan.sheets[0].visuals.map((v) => v.chartType).join(','));

// ── §6 the templates do not all look alike ──────────────────────────────────
//
// Every template used to be the same page: a KPI strip, then its charts two to
// a row. Four of the six now say how they are arranged, in the SAME row
// vocabulary a drafted plan uses (planRows.ts) — and what is asserted is where
// planLayout.arrangeSheet puts the tiles, which is what the build places them by.

/** A template's sheet on its own fixture, as built and as the validator keeps it. */
function sheetsOf(id: string) {
  const t = templateById(id) as DashboardTemplate;
  const fx = FIXTURES[id];
  const plan = t.build(fx.ds, mappingOf(mapRoles(t.roles, fx.ds, fx.geo).matches), { geoHits: fx.geo });
  return { built: plan.sheets[0], kept: validatePlan(plan, ctxFor(fx.ds)).plan.sheets[0] };
}
type Sheet = ReturnType<typeof sheetsOf>['built'];
const rowTypes = (sheet: Sheet): string => (sheet.rows || []).map((r) => r.type).join(',');
/** Every tile in reading order, as `kind@x,y,w,h` (scripts/test-planRows.ts). */
const placed = (sheet: Sheet): string =>
  readingOrder(arrangeSheet(sheet)).map((t) => `${t.kind}@${t.x},${t.y},${t.w},${t.h}`).join(' ');
const at = (sheet: Sheet, i: number): string => {
  const l = arrangeSheet(sheet).visuals[i];
  return `${l.x},${l.y},${l.w},${l.h}`;
};

const KPI_STRIP = 'metric@0,6,3,2 metric@3,6,3,2 metric@6,6,3,2 metric@9,6,3,2';
const RAIL = 'metric@8,0,4,2 metric@8,2,4,2 metric@8,4,4,2';
/** Four KPIs: the same tiles, one more, beside a chart 8 tall. */
const RAIL4 = `${RAIL} metric@8,6,4,2`;
/** id → [the headline chart, the rows, every tile]. */
const SHAPED: Record<string, [string, string, string]> = {
  // Chart first: the headline at full width, the strip beneath it, the rest two-up.
  sales: ['line', 'charts,kpis,charts,charts',
    `visual@0,0,12,6 ${KPI_STRIP} visual@0,8,6,6 visual@6,8,6,6 visual@0,14,12,6`],
  inventory: ['column', 'charts,kpis,charts',
    `visual@0,0,12,6 ${KPI_STRIP} visual@0,8,6,6 visual@6,8,6,6`],
  // Spotlight: the headline with the KPIs in the rail beside it — Customer's
  // three, Marketing's four (and a chart as tall as the four of them).
  marketing: ['funnel', 'spotlight,charts,charts',
    `visual@0,0,8,8 ${RAIL4} visual@0,8,6,6 visual@6,8,6,6 visual@0,14,12,6`],
  customer: ['bar', 'spotlight,charts,charts',
    `visual@0,0,8,6 ${RAIL} visual@0,6,6,6 visual@6,6,6,6 visual@0,12,12,6`],
  // The two starters that are arrangements of KPIs + chart, on the sample data.
  spotlight: ['column', 'spotlight,charts',
    `visual@0,0,8,8 ${RAIL4} visual@0,8,12,6`],
  lead: ['column', 'charts,kpis,charts',
    `visual@0,0,12,6 ${KPI_STRIP} visual@0,8,12,6`],
};
for (const [id, [headline, rows, tiles]] of Object.entries(SHAPED)) {
  const { built, kept } = sheetsOf(id);
  ok(`${id}: carries its arrangement as rows`, rowTypes(built) === rows, rowTypes(built));
  // The thumbnail in the gallery is the template's headline chart, so a
  // template whose first chart is something else would lead with the wrong one.
  ok(`${id}: its FIRST chart is its headline, and that is the one the shape leads with`,
     built.visuals[0].chartType === headline && (templateById(id) as DashboardTemplate).thumb === headline
     && at(built, 0) === (!rows.startsWith('spotlight') ? '0,0,12,6' : tiles.includes(RAIL4) ? '0,0,8,8' : '0,0,8,6'),
     `${built.visuals[0].chartType} at ${at(built, 0)}`);
  ok(`${id}: every tile sits where the shape puts it`, placed(built) === tiles, placed(built));
  ok(`${id}: …and the validator keeps that arrangement as written`,
     rowTypes(kept) === rows && placed(kept) === tiles, `${rowTypes(kept)} · ${placed(kept)}`);
}

// NEGATIVE CONTROL: the templates that keep the strip say nothing about rows,
// and are packed exactly as every template was before rows existed.
const FLAT: Record<string, string> = {
  finance: 'metric@0,0,3,2 metric@3,0,3,2 metric@6,0,3,2 metric@9,0,3,2 '
    + 'visual@0,2,6,6 visual@6,2,6,6 visual@0,8,6,6 visual@6,8,6,6',
  operations: 'metric@0,0,3,2 metric@3,0,3,2 metric@6,0,3,2 visual@0,2,6,6 visual@6,2,6,6 visual@0,8,6,6',
  kpis: 'metric@0,0,3,2 metric@3,0,3,2 metric@6,0,3,2 metric@9,0,3,2 visual@0,2,6,6 visual@6,2,6,6',
  twoup: 'visual@0,0,6,6 visual@6,0,6,6 text@0,6,12,2',
};
for (const [id, tiles] of Object.entries(FLAT)) {
  const { built, kept } = sheetsOf(id);
  ok(`${id}: is unchanged — no rows, the strip and then the charts`,
     !('rows' in built) && !('rows' in kept) && placed(built) === tiles && placed(kept) === tiles,
     `${Object.keys(built).join(',')} · ${placed(built)}`);
}

// ── §7 a template never emits a figure, and never emits geometry ────────────

const everyPlan = JSON.stringify(TEMPLATES.map((t) => {
  const fx = FIXTURES[t.id];
  return t.build(fx.ds, mappingOf(mapRoles(t.roles, fx.ds, fx.geo).matches), { geoHits: fx.geo });
}));
ok('no plan in the catalogue carries an x/y/w/h — geometry is the app’s',
   !/"[xywh]":/.test(everyPlan));

finish();
