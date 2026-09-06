// The two STARTER LAYOUTS, built app-side from a dataset's own columns.
//
// "KPIs + chart" and "Two-up" used to insert a text card reading "Add metric
// cards here" and then open a modal asking which SAVED VISUAL to use — so on a
// fresh project, where no visual exists yet, the whole layout was one text card.
// A starter that asks you to have already done the work is not a starter.
//
// This module is JUST ANOTHER PLAN AUTHOR. What it returns goes through the same
// `validatePlan` a model's envelope does, against the same real records, so a
// column it picks badly is dropped and reported exactly as a model's would be.
// It gets no privileges for being app code — scripts/test-starterPlan.ts asserts
// the round trip, which is what makes that a property rather than a claim.
//
// No model, no network, no I/O: columns and app-computed summaries in, a plan
// out. MAIN PROCESS, PURE.

import { compile } from '../formula/formula';
import type { AnalysisPlan, PlanDataset, PlannedCalcField, PlannedMetric, PlannedVisual } from './analysisPlan';
import type { ColumnSummary } from '../data/datasetStats';
import type { ParsedColumn } from '../data/parse';
import type { VizEncoding } from './visuals';

export type StarterKind = 'kpis' | 'twoup';

/** Names that read as a measure someone actually wants totalled. Preference
 *  only — every numeric column is still eligible, these just go first. */
const KPI_NAME_RE = /revenue|sales|amount|total|count|units/i;

/** A KPI strip is a strip. Beyond four it is a table, and a 12-column grid at
 *  3 wide gives exactly four. */
const MAX_KPIS = 4;

/** Above this many distinct values a bar chart is a barcode. */
const MAX_CATEGORY_DISTINCT = 20;

/** The chart every starter draws. Deliberately a literal rather than a call to
 *  vizData.recommendChartType: for every shape this module builds (text
 *  category, one measure, no split, no geo) that function returns exactly this,
 *  so importing it would buy a constant we already know. The renderer's richer
 *  `eligibleChartTypes` is a classic <script> with no exports and main cannot
 *  require it at all. */
const CHART_TYPE = 'column';

function summaryOf(ds: PlanDataset, name: string): ColumnSummary | undefined {
  // BY NAME, never by index. Nothing states that `summaries[]` is index-aligned
  // with `columns[]`, and ColumnSummary carries its own name precisely so a
  // caller does not have to assume it.
  return ds.summaries ? ds.summaries.find((s) => s.name === name) : undefined;
}

/** Numeric columns, preferred names first, declared order within each group.
 *  A partition rather than a sort with a comparator — it says what it means. */
function kpiColumns(ds: PlanDataset): ParsedColumn[] {
  const nums = ds.columns.filter((c) => c.type === 'number');
  return [
    ...nums.filter((c) => KPI_NAME_RE.test(c.name)),
    ...nums.filter((c) => !KPI_NAME_RE.test(c.name)),
  ].slice(0, MAX_KPIS);
}

/**
 * Text columns narrow enough to read as an axis.
 *
 * `distinct` is only populated for a RESIDENT dataset. With no summaries at all
 * every text column stays eligible: a wide axis is ugly, never wrong, and never
 * worth hydrating a table to avoid.
 */
function categoryColumns(ds: PlanDataset): ParsedColumn[] {
  const text = ds.columns.filter((c) => c.type === 'text');
  if (!ds.summaries) return text;
  return text.filter((c) => {
    const d = summaryOf(ds, c.name);
    // A column with no summary of its own is kept, for the same reason as above.
    if (!d || typeof d.distinct !== 'number') return true;
    return d.distinct > 0 && d.distinct <= MAX_CATEGORY_DISTINCT;
  });
}

/** A formula reference to a column: bare when it is an identifier, bracketed
 *  when it is anything else (`[Order Date]`). */
function ref(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `[${name}]`;
}

/**
 * A calculated field bucketing a date column to its month.
 *
 * There is no date granularity in VizEncoding and vizData groups on the raw
 * cell, so "by month" is not something a chart can ask for — but a plan may
 * propose a COLUMN, and `datetrunc('month', …)` yields '2024-07-01' for every
 * day in July. Compiled here with the real parser rather than assumed: a column
 * name the bracket syntax cannot express returns null and the month chart is
 * simply not proposed, which costs the user nothing, where proposing one
 * validatePlan will drop costs them two drop messages for one missing chart.
 */
function monthField(ds: PlanDataset, dateCol: string): PlannedCalcField | null {
  const taken = new Set(ds.columns.map((c) => c.name));
  let name = 'Month';
  for (let i = 2; taken.has(name); i += 1) name = `Month ${i}`;
  const expression = `datetrunc('month', ${ref(dateCol)})`;
  return compile(expression).ok ? { datasetId: ds.id, name, expression } : null;
}

function chart(ds: PlanDataset, category: string, measure: string, label: string): PlannedVisual {
  const encoding: VizEncoding = { category, values: [{ column: measure, aggregation: 'sum' }] };
  return {
    kind: 'new',
    datasetId: ds.id,
    name: label,
    chartType: CHART_TYPE,
    encoding,
    filters: [],
  };
}

/**
 * Build one of the two starter layouts for `ds`.
 *
 * Degenerate datasets still produce a VALID plan rather than nothing: with no
 * numeric column there are no KPIs and no chart, with no text column the date
 * column stands in as the category, and with neither the sheet is the KPI row
 * alone. validatePlan reports whatever that leaves out.
 */
export function buildStarterPlan(kind: StarterKind, ds: PlanDataset, opts: { name?: string } = {}): AnalysisPlan {
  const kpis = kpiColumns(ds);
  const cats = categoryColumns(ds);
  const dateCol = ds.columns.find((c) => c.type === 'date');
  const month = dateCol ? monthField(ds, dateCol.name) : null;

  // With no text column at all, a date reads as a category perfectly well.
  const axes = cats.length ? cats.map((c) => c.name) : (dateCol ? [dateCol.name] : []);
  const measure = kpis.length ? kpis[0].name : '';

  const calculatedFields: PlannedCalcField[] = [];
  const visuals: PlannedVisual[] = [];
  const metrics: PlannedMetric[] = [];
  const texts: { heading?: string; text?: string }[] = [];

  if (kind === 'kpis') {
    for (const c of kpis) {
      metrics.push({ datasetId: ds.id, column: c.name, aggregation: 'sum', label: c.name });
    }
    if (measure && axes.length) {
      visuals.push(chart(ds, axes[0], measure, `${measure} by ${axes[0]}`));
    }
    // The second chart is the point of having a date column: the same measure
    // over time, next to the same measure by category.
    if (measure && month) {
      calculatedFields.push(month);
      visuals.push(chart(ds, month.name, measure, `${measure} by month`));
    }
  } else {
    // Two-up wants two DIFFERENT charts. Walk a deterministic ladder and take
    // the first two that are expressible, so a dataset with one category column
    // and a date still gets two, and one with neither gets none.
    const ladder: { category: string; measure: string; needsMonth?: boolean }[] = [];
    if (measure && axes[0]) ladder.push({ category: axes[0], measure });
    if (measure && axes[1]) ladder.push({ category: axes[1], measure });
    if (measure && month) ladder.push({ category: month.name, measure, needsMonth: true });
    if (kpis[1] && axes[0]) ladder.push({ category: axes[0], measure: kpis[1].name });
    for (const rung of ladder.slice(0, 2)) {
      if (rung.needsMonth && month) calculatedFields.push(month);
      const label = rung.needsMonth ? `${rung.measure} by month` : `${rung.measure} by ${rung.category}`;
      visuals.push(chart(ds, rung.category, rung.measure, label));
    }
    texts.push({ heading: 'Notes', text: 'Add your notes here.' });
  }

  return {
    name: opts.name || ds.name,
    rationale: '',
    calculatedFields,
    sheets: [{ name: 'Overview', metrics, visuals, texts }],
  };
}
