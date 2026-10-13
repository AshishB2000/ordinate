// The starter layouts, built app-side from a dataset's columns: "KPIs + chart"
// and "Two-up", and the two ARRANGEMENTS of the first — "Spotlight" and "Chart
// first" — which pick the same tiles and differ only in where they sit.
//
// The point of this suite is the ROUND TRIP at the bottom: whatever
// buildStarterPlan produces must survive validatePlan with nothing dropped. The
// starter is just another plan author and gets no privileges for being app code,
// and that is a property worth asserting rather than a claim worth writing down
// — a heuristic that picks a text column for a `sum` is exactly the mistake a
// model makes, and it must be caught by the same gate.
//
// Pure: columns and app-computed summaries in, a plan out. No disk.

export {};
import { ok, failureCount } from './selfcheck';

const starter: typeof import('../src/analysis/starterPlan') = require('../src/analysis/starterPlan');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const layout: typeof import('../src/analysis/planLayout') = require('../src/analysis/planLayout');

/** A sheet as the build will place it: every tile in reading order, as
 *  `kind@x,y,w,h` — the same strings scripts/test-planRows.ts asserts. */
const placed = (sheet: any): string =>
  layout.readingOrder(layout.arrangeSheet(sheet)).map((t) => `${t.kind}@${t.x},${t.y},${t.w},${t.h}`).join(' ');
const rowTypes = (sheet: any): string => (sheet.rows || []).map((r: any) => r.type).join(',');

type Col = { name: string; type: 'text' | 'number' | 'date' };
const DS_ID = '11111111-2222-4333-8444-555555555555';

/** A PlanDataset fixture. `distinct` is only supplied for the columns a test
 *  cares about, mirroring what computeColumnSummariesResident actually returns
 *  (numbers get no distinct count at all). */
function ds(columns: Col[], distinct?: Record<string, number>): any {
  return {
    id: DS_ID,
    name: 'Sales',
    rowCount: 400,
    columns,
    resident: true,
    summaries: distinct === undefined ? undefined : columns.map((c) => ({
      name: c.name,
      type: c.type,
      nonEmpty: 400,
      ...(distinct[c.name] === undefined ? {} : { distinct: distinct[c.name] }),
    })),
  };
}

const ctxFor = (d: any): any => ({ datasets: [d], visuals: [] });

const FULL: Col[] = [
  { name: 'region', type: 'text' },
  { name: 'order_id', type: 'text' },
  { name: 'revenue', type: 'number' },
  { name: 'units', type: 'number' },
  { name: 'row_no', type: 'number' },
  { name: 'order_date', type: 'date' },
];
const FULL_DISTINCT = { region: 5, order_id: 400 };

// ── KPI columns: named measures first, capped at four ───────────────────────
{
  const p = starter.buildStarterPlan('kpis', ds(FULL, FULL_DISTINCT));
  const cols = p.sheets[0].metrics.map((m) => m.column);
  ok('kpis: the named measures come first', cols[0] === 'revenue' && cols[1] === 'units', JSON.stringify(cols));
  ok('kpis: an unnamed numeric column still qualifies, after them',
    cols.indexOf('row_no') === 2, JSON.stringify(cols));
  ok('kpis: every KPI is a sum', p.sheets[0].metrics.every((m) => m.aggregation === 'sum'));
  ok('kpis: no text column is ever a KPI', !cols.includes('region') && !cols.includes('order_id'),
    JSON.stringify(cols));
}
{
  const many: Col[] = [1, 2, 3, 4, 5, 6].map((i) => ({ name: 'n' + i, type: 'number' as const }));
  const p = starter.buildStarterPlan('kpis', ds(many, {}));
  ok('kpis: a strip is capped at four, not one per numeric column',
    p.sheets[0].metrics.length === 4, String(p.sheets[0].metrics.length));
}

// ── A sum has to MEAN something ─────────────────────────────────────────────
// The first version ranked by one substring regex and summed whatever it found.
// On the app's own bundled sample that produced "total discount: 315.7" and
// "total unit price: 1.2M" — figures that are not facts about a business — and
// it plotted units rather than revenue, because `units` appears earlier in the
// file. This is the first dashboard most people ever see.
{
  const retail = ds([
    { name: 'order_date', type: 'date' }, { name: 'region', type: 'text' },
    { name: 'units', type: 'number' }, { name: 'unit_price', type: 'number' },
    { name: 'discount', type: 'number' }, { name: 'revenue', type: 'number' },
    { name: 'profit', type: 'number' }, { name: 'ship_days', type: 'number' },
  ], { region: 5 });
  const p = starter.buildStarterPlan('kpis', retail);
  const got = p.sheets[0].metrics.map((m) => `${m.aggregation}(${m.column})`);

  ok('money outranks counts, whatever the column order',
    got[0] === 'sum(revenue)' && got[1] === 'sum(profit)' && got[2] === 'sum(units)', JSON.stringify(got));
  ok('a PRICE is averaged, never summed',
    !got.includes('sum(unit_price)') && got.some((g) => g === 'avg(unit_price)'), JSON.stringify(got));
  ok('a RATE is never a headline KPI at all',
    !got.some((g) => /\(discount\)/.test(g)), JSON.stringify(got));
  // "dis(count)" matched the old substring regex, which is how a discount rate
  // came to rank alongside revenue.
  ok('…because the preference matches WORDS, not substrings',
    starter.buildStarterPlan('kpis', ds([{ name: 'discount', type: 'number' },
      { name: 'revenue', type: 'number' }], {})).sheets[0].metrics[0].column === 'revenue');
  ok('and the charts plot the headline measure, not whatever came first',
    p.sheets[0].visuals.every((v) => v.encoding.values[0].column === 'revenue'),
    JSON.stringify(p.sheets[0].visuals.map((v) => v.encoding.values[0].column)));
}
{
  // A dataset whose ONLY measure is a rate still gets a chart — averaged, not
  // summed. Before, this drew a bar chart of added-up percentages.
  const rates = ds([{ name: 'region', type: 'text' }, { name: 'conversion_rate', type: 'number' }], { region: 4 });
  const p = starter.buildStarterPlan('kpis', rates);
  ok('a rate-only dataset averages in the KPI and in the chart',
    p.sheets[0].metrics[0].aggregation === 'avg'
      && p.sheets[0].visuals[0].encoding.values[0].aggregation === 'avg',
    JSON.stringify(p.sheets[0].metrics.concat(p.sheets[0].visuals as any)));
}
{
  // An id or a year is a number the way a phone number is.
  const ids = ds([{ name: 'order_id', type: 'number' }, { name: 'year', type: 'number' },
    { name: 'zip_code', type: 'number' }, { name: 'revenue', type: 'number' }], {});
  const cols = starter.buildStarterPlan('kpis', ids).sheets[0].metrics.map((m) => m.column);
  ok('identifiers, years and zips are not measures',
    cols.length === 1 && cols[0] === 'revenue', JSON.stringify(cols));
}

// ── Category column: narrow enough to read as an axis ───────────────────────
{
  const p = starter.buildStarterPlan('kpis', ds(FULL, FULL_DISTINCT));
  const cat = p.sheets[0].visuals[0].encoding.category;
  ok('the 5-distinct column is the axis, not the 400-distinct one', cat === 'region', String(cat));
}
{
  // 5,000 distinct values is a barcode, not a bar chart.
  const wide = ds([{ name: 'sku', type: 'text' }, { name: 'revenue', type: 'number' }], { sku: 5000 });
  const p = starter.buildStarterPlan('kpis', wide);
  ok('a 5,000-distinct text column is refused as an axis',
    p.sheets[0].visuals.length === 0, JSON.stringify(p.sheets[0].visuals.map((v) => v.encoding.category)));
  ok('…and the KPI row is still built, so the layout is not empty',
    p.sheets[0].metrics.length === 1);
}
{
  // Non-resident: no summaries at all. A wide axis is ugly, never wrong, and
  // never worth hydrating a table to avoid.
  const noStats = ds([{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }]);
  const p = starter.buildStarterPlan('kpis', noStats);
  ok('with no summaries the first text column is used anyway',
    p.sheets[0].visuals.length === 1 && p.sheets[0].visuals[0].encoding.category === 'region',
    JSON.stringify(p.sheets[0].visuals.map((v) => v.encoding.category)));
}

// ── By month: a calculated field, because encodings have no granularity ─────
{
  const p = starter.buildStarterPlan('kpis', ds(FULL, FULL_DISTINCT));
  ok('a date column yields exactly one calculated field',
    p.calculatedFields.length === 1, JSON.stringify(p.calculatedFields));
  ok('…which buckets it with datetrunc, not a hand-rolled substring',
    p.calculatedFields[0].expression === "datetrunc('month', order_date)",
    p.calculatedFields[0].expression);
  ok('…and a second chart plots the measure over it',
    p.sheets[0].visuals.length === 2 && p.sheets[0].visuals[1].encoding.category === 'Month',
    JSON.stringify(p.sheets[0].visuals.map((v) => v.encoding.category)));
}
{
  const noDate = ds([{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], { region: 5 });
  const p = starter.buildStarterPlan('kpis', noDate);
  ok('no date column means no calculated field and no month chart',
    p.calculatedFields.length === 0 && p.sheets[0].visuals.length === 1);
}
{
  // validatePlan drops a calculated field whose name collides with a real
  // column, so the collision has to be resolved before it gets there.
  const clash = ds([...FULL, { name: 'Month', type: 'text' }], { ...FULL_DISTINCT, Month: 12 });
  const p = starter.buildStarterPlan('kpis', clash);
  ok('an existing "Month" column pushes the field to "Month 2"',
    p.calculatedFields[0].name === 'Month 2', p.calculatedFields[0].name);
}
{
  // A name the bare-identifier syntax cannot express must be bracketed, or the
  // formula does not compile and the chart is silently dropped downstream.
  const spaced = ds([{ name: 'Order Date', type: 'date' }, { name: 'revenue', type: 'number' }], {});
  const p = starter.buildStarterPlan('kpis', spaced);
  ok('a column name with a space is bracketed in the formula',
    p.calculatedFields.length === 1 && p.calculatedFields[0].expression === "datetrunc('month', [Order Date])",
    JSON.stringify(p.calculatedFields));
}

// ── Two-up ─────────────────────────────────────────────────────────────────
{
  const p = starter.buildStarterPlan('twoup', ds(FULL, FULL_DISTINCT));
  ok('twoup: two charts', p.sheets[0].visuals.length === 2, String(p.sheets[0].visuals.length));
  ok('twoup: they are DIFFERENT charts, not the same one twice',
    p.sheets[0].visuals[0].encoding.category !== p.sheets[0].visuals[1].encoding.category,
    JSON.stringify(p.sheets[0].visuals.map((v) => v.encoding.category)));
  ok('twoup: and a notes card', p.sheets[0].texts.length === 1 && p.sheets[0].texts[0].heading === 'Notes');
  ok('twoup: no KPI strip', p.sheets[0].metrics.length === 0);
}
{
  // One usable axis + a date still makes two charts, via the month rung.
  const oneAxis = ds([
    { name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'd', type: 'date' },
  ], { region: 4 });
  const p = starter.buildStarterPlan('twoup', oneAxis);
  ok('twoup: one category column plus a date still fills both slots',
    p.sheets[0].visuals.length === 2, JSON.stringify(p.sheets[0].visuals.map((v) => v.encoding.category)));
}

// ── Spotlight and Chart first: the KPIs + chart tiles, ARRANGED ─────────────
// Neither picks anything of its own. What they add is `rows`, and the layouts
// below are what planLayout.arrangeSheet makes of those rows — the same call
// the preview and the build place the cards with.
const RETAIL: Col[] = [
  { name: 'order_date', type: 'date' }, { name: 'region', type: 'text' },
  { name: 'units', type: 'number' }, { name: 'unit_price', type: 'number' },
  { name: 'revenue', type: 'number' }, { name: 'profit', type: 'number' },
];
{
  const full = ds(FULL, FULL_DISTINCT);
  const kpis = starter.buildStarterPlan('kpis', full);
  for (const kind of ['spotlight', 'lead'] as const) {
    const p = starter.buildStarterPlan(kind, full);
    const { rows: _rows, ...flat } = p.sheets[0];
    ok(`${kind}: the same tiles as KPIs + chart — same KPIs, same charts, same field`,
      JSON.stringify({ ...p, sheets: [flat] }) === JSON.stringify(kpis), JSON.stringify(flat));
  }

  // Three KPIs and two charts.
  const spot = starter.buildStarterPlan('spotlight', full).sheets[0];
  ok('spotlight: the first chart with the KPIs beside it, then the other chart',
    rowTypes(spot) === 'spotlight,charts', rowTypes(spot));
  ok('spotlight: …and it is the FIRST chart that is spotlit',
    (spot.rows as any)[0].visual === spot.visuals[0] && (spot.rows as any)[1].visuals[0] === spot.visuals[1]);
  ok('spotlight: an 8-wide chart, a rail of three, then a full-width chart',
    placed(spot) === 'visual@0,0,8,6 metric@8,0,4,2 metric@8,2,4,2 metric@8,4,4,2 visual@0,6,12,6', placed(spot));

  const lead = starter.buildStarterPlan('lead', full).sheets[0];
  ok('lead: the first chart, then the KPI strip, then the other chart',
    rowTypes(lead) === 'charts,kpis,charts', rowTypes(lead));
  ok('lead: …and it is the FIRST chart that leads',
    (lead.rows as any)[0].visuals[0] === lead.visuals[0] && (lead.rows as any)[2].visuals[0] === lead.visuals[1]);
  ok('lead: a full-width chart, the strip beneath it, then a full-width chart',
    placed(lead) === 'visual@0,0,12,6 metric@0,6,3,2 metric@3,6,3,2 metric@6,6,3,2 visual@0,8,12,6', placed(lead));

  // FOUR KPIs. A rail holds three (planRows), so the fourth follows on a strip
  // of its own — shapeRows' rule, not one written a second time here.
  const four = starter.buildStarterPlan('spotlight', ds(RETAIL, { region: 5 })).sheets[0];
  ok('spotlight: four KPIs put three in the rail and the fourth on a strip',
    rowTypes(four) === 'spotlight,kpis,charts'
    && placed(four) === 'visual@0,0,8,6 metric@8,0,4,2 metric@8,2,4,2 metric@8,4,4,2 metric@0,6,3,2 visual@0,8,12,6',
    `${rowTypes(four)} · ${placed(four)}`);
  ok('spotlight: …in the strip\'s own order, so the flat list is still the rows\' flattening',
    four.metrics.map((m) => m.column).join(',') === 'revenue,profit,units,unit_price',
    four.metrics.map((m) => m.column).join(','));
  // TWO KPIs fill the rail at half its height each.
  const two = starter.buildStarterPlan('spotlight',
    ds([{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'units', type: 'number' }], { region: 5 })).sheets[0];
  ok('spotlight: two KPIs share the rail', placed(two) === 'visual@0,0,8,6 metric@8,0,4,3 metric@8,3,4,3', placed(two));
}
{
  // DEGENERATE DATASETS. Each is shapeRows' answer to a row that cannot be
  // filled, and none of them is an empty sheet or a tile out of place.
  const oneKpi = ds([{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], { region: 5 });
  // A rail of one is a hole with a number in it, so there is no rail.
  ok('spotlight: one KPI is a strip above the chart, never a rail of one',
    placed(starter.buildStarterPlan('spotlight', oneKpi).sheets[0]) === 'metric@0,0,3,2 visual@0,2,12,6',
    placed(starter.buildStarterPlan('spotlight', oneKpi).sheets[0]));
  ok('lead: one KPI still sits beneath the chart',
    placed(starter.buildStarterPlan('lead', oneKpi).sheets[0]) === 'visual@0,0,12,6 metric@0,6,3,2',
    placed(starter.buildStarterPlan('lead', oneKpi).sheets[0]));

  const numsOnly = ds([{ name: 'revenue', type: 'number' }, { name: 'units', type: 'number' }], {});
  const textOnly = ds([{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }], { a: 3, b: 4 });
  for (const kind of ['spotlight', 'lead'] as const) {
    const noChart = starter.buildStarterPlan(kind, numsOnly).sheets[0];
    ok(`${kind}: no chart → just the KPI strip`,
      rowTypes(noChart) === 'kpis' && placed(noChart) === 'metric@0,0,3,2 metric@3,0,3,2', `${rowTypes(noChart)} · ${placed(noChart)}`);
    // Nothing to arrange is not an arrangement: no `rows` key at all, and the
    // plan is the one KPIs + chart returns for the same dataset.
    ok(`${kind}: nothing at all → the plan KPIs + chart builds, with no rows`,
      JSON.stringify(starter.buildStarterPlan(kind, textOnly)) === JSON.stringify(starter.buildStarterPlan('kpis', textOnly)),
      JSON.stringify(starter.buildStarterPlan(kind, textOnly).sheets[0]));
  }
}
{
  // NEGATIVE CONTROL: the two starters that existed before rows did are FLAT,
  // and are packed exactly as they always were. The sample dashboard is built
  // on 'kpis' (src/app/sampleProject.ts), so a `rows` key appearing here would
  // move every tile of the first dashboard anyone sees.
  const full = ds(FULL, FULL_DISTINCT);
  const kpis = starter.buildStarterPlan('kpis', full).sheets[0];
  const twoup = starter.buildStarterPlan('twoup', full).sheets[0];
  ok('kpis and twoup carry no rows', !('rows' in kpis) && !('rows' in twoup), Object.keys(kpis).concat(Object.keys(twoup)).join(','));
  ok('kpis: still the strip, then the charts two-up',
    placed(kpis) === 'metric@0,0,3,2 metric@3,0,3,2 metric@6,0,3,2 visual@0,2,6,6 visual@6,2,6,6', placed(kpis));
  ok('twoup: still two charts side by side, then the notes',
    placed(twoup) === 'visual@0,0,6,6 visual@6,0,6,6 text@0,6,12,2', placed(twoup));
  ok('…and the arrangements really are different from both',
    new Set(['kpis', 'twoup', 'spotlight', 'lead'].map((k) => placed(starter.buildStarterPlan(k as any, full).sheets[0]))).size === 4);
}

// ── Degenerate datasets still produce a VALID plan ─────────────────────────
{
  const textOnly = ds([{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }], { a: 3, b: 4 });
  for (const kind of ['kpis', 'twoup'] as const) {
    const p = starter.buildStarterPlan(kind, textOnly);
    ok(`${kind}: no numeric column → no KPIs and no chart, but a real plan`,
      p.sheets[0].metrics.length === 0 && p.sheets[0].visuals.length === 0 && p.sheets.length === 1);
  }
  const numsOnly = ds([{ name: 'revenue', type: 'number' }], {});
  const p = starter.buildStarterPlan('kpis', numsOnly);
  ok('kpis: no category column and no date → the KPI row alone',
    p.sheets[0].metrics.length === 1 && p.sheets[0].visuals.length === 0);

  const dateAxis = ds([{ name: 'd', type: 'date' }, { name: 'revenue', type: 'number' }], {});
  const p2 = starter.buildStarterPlan('kpis', dateAxis);
  ok('kpis: with no text column the date stands in as the category',
    p2.sheets[0].visuals.some((v) => v.encoding.category === 'd'),
    JSON.stringify(p2.sheets[0].visuals.map((v) => v.encoding.category)));
}

// ── THE ROUND TRIP ─────────────────────────────────────────────────────────
// Everything above only says what the heuristic INTENDED. This says the real
// validator agrees — the same function, on the same context, that judges a
// model's envelope. A starter that proposed `sum` of a text column, or an axis
// that is not a column, would be dropped here exactly as a model's would be, and
// the user would get a layout with holes in it.
{
  const cases: [string, any][] = [
    ['a full dataset', ds(FULL, FULL_DISTINCT)],
    ['no summaries', ds(FULL)],
    ['text only', ds([{ name: 'a', type: 'text' }], { a: 3 })],
    ['numbers only', ds([{ name: 'revenue', type: 'number' }], {})],
    ['a spaced date column', ds([{ name: 'Order Date', type: 'date' }, { name: 'revenue', type: 'number' }], {})],
    ['a colliding Month column', ds([...FULL, { name: 'Month', type: 'text' }], { ...FULL_DISTINCT, Month: 12 })],
  ];
  for (const [label, d] of cases) {
    for (const kind of ['kpis', 'twoup', 'spotlight', 'lead'] as const) {
      const built = starter.buildStarterPlan(kind, d);
      const res = plan.validatePlan(built, ctxFor(d));
      ok(`round trip: ${kind} on ${label} drops nothing`,
        res.dropped.length === 0, JSON.stringify(res.dropped.map((x: any) => x.message)));
      const before = built.sheets[0];
      const after = res.plan.sheets[0];
      ok(`round trip: ${kind} on ${label} survives structurally`,
        after.metrics.length === before.metrics.length
        && after.visuals.length === before.visuals.length
        && after.texts.length === before.texts.length,
        `${before.metrics.length}/${before.visuals.length}/${before.texts.length} → `
        + `${after.metrics.length}/${after.visuals.length}/${after.texts.length}`);
      // The ARRANGEMENT survives too. With rows the validator reads the rows and
      // nothing else, so rows it re-shaped would be a starter writing a stack
      // the app then corrects — and the sheet built would not be the one asked for.
      ok(`round trip: ${kind} on ${label} is placed as it was written`,
        rowTypes(after) === rowTypes(before) && placed(after) === placed(before),
        `${rowTypes(before)} · ${placed(before)} → ${rowTypes(after)} · ${placed(after)}`);
    }
  }
}

if (failureCount()) {
  console.error('\n' + failureCount() + ' starter-plan check(s) FAILED');
  process.exit(1);
}
console.log('\nAll starter-plan checks passed.');
