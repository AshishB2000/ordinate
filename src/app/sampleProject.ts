// The bundled SAMPLE DATA, seeded once on first launch — into the user's OWN
// first project, not a project of its own.
//
// Without it the app opens completely empty — no project, no data, no dashboard,
// every surface showing its empty state — and the only way to find out what
// Ordinate does is to go and find a CSV first. The sample also gives the map, the
// anomaly detector and the starter templates something real to run against.
//
// ── ONE project, and why it changed ─────────────────────────────────────────
// This used to create TWO: "Sample: Retail orders" holding everything, then an
// empty "My project" LAST so that resolveProjectId — which adopts the most
// recently updated one — would adopt the empty one and keep the user's first
// real import out of the sample.
//
// That reasoning only holds if the user can SEE both projects, and there is no
// project front door in the UI: homePage.ts's openRecentItem adopts a project
// implicitly when you click a row, and nothing else lists them. So a new user
// landed in the empty project while Home's Recent and Starred — the only two
// global-across-projects surfaces in the app — showed the sample. Home said
// "My project · 0 datasets · 0 dashboards" over a Starred row for a dashboard
// that was really there, Data said "No datasets yet", Dashboards said "No
// dashboards yet". Three of four surfaces empty, which is the exact first
// impression the sample exists to prevent.
//
// So the sample is seeded INTO the first project. The user's first import lands
// beside it, which is fine and always was — the note card says the sample is
// sample data and offers to remove it, and removing it now takes the sample's
// three records out and LEAVES the project (see markNoteCardDeletable, and
// dashFiltersUi.ts's handler). Installs that already seeded keep their two
// projects: `sampleSeeded` records that seeding happened, and re-homing records
// under someone's feet is worse than an extra project in a list they cannot see.
//
// Everything here goes through the ORDINARY paths: the CSV is parsed by
// fileImport.parseFile (the same call `dataset:pickAndParse` makes), stored by
// datasets.saveDataset, and the dashboard is built by planBuild.buildPlan from a
// plan the starter template wrote. No special-casing of types, no second
// importer, no fixture records written straight to disk — if the ordinary path
// breaks, the sample breaks with it, which is the point.
//
// MAIN PROCESS. No model, no network.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

import * as config from './config';
import * as execConfig from './execConfig';
import * as projects from './projects';
import * as datasets from '../data/datasets';
import { parseFile, sourceKindForPath } from '../data/fileImport';
import * as analysis from '../analysis/analysis';
import * as planBuild from '../analysis/planBuild';
import { loadPlanContext } from '../analysis/analysisPlan';
import type { AnalysisPlan, PlannedMetric, PlannedVisual } from '../analysis/analysisPlan';
import { buildStarterPlan } from '../analysis/starterPlan';

export const SAMPLE_DATASET_NAME = 'Retail orders';
export const SAMPLE_DASHBOARD_NAME = 'Retail overview';
/** The one project a fresh install gets. The sample is seeded INTO it, so every
 *  surface — Home's counts, Data, Dashboards — agrees on first launch. */
export const FIRST_PROJECT_NAME = 'My project';

const SAMPLE_NOTE_HEADING = 'This is sample data';
// Kept SHORT deliberately. The note is one card on a laid-out sheet and its body
// does not grow to fit: the starter plan sizes a text card, and prose past about
// two lines scrolls inside it, hiding the Remove button the note is promising.
const SAMPLE_NOTE_TEXT =
  'A generated retail orders dataset, bundled so the app has something to show on '
  + 'first launch. Nothing here is real — remove it whenever you like; your project stays.';

/** The bundled CSV. `app.getAppPath()` is the repo root in dev and app.asar when
 *  packaged, and Electron patches fs to read inside asar, so one path works for
 *  both — the same resolution src/ipc/geo.ts uses for the map boundaries. */
export function sampleCsvPath(): string {
  return path.join(app.getAppPath(), 'assets', 'samples', 'retail-orders.csv');
}

/**
 * The sample dashboard's plan.
 *
 * The starter template supplies the sheet's SHAPE — a KPI band, then charts,
 * then a note — and, importantly, its `Month` calculated field
 * (`datetrunc('month', order_date)`), which is the only way to chart by month:
 * VizEncoding has no date granularity and vizData groups on the raw cell.
 *
 * The metrics and visuals are then replaced with the sample's own. `kpiColumns`
 * ranks by name (`revenue`, `units`) and then by declared order, which on this
 * dataset means it would offer `sum(unit_price)` and `sum(discount)` — figures
 * that mean nothing, on the one dashboard every new user sees first. Summing a
 * price or a rate is never right; teaching the template that is a real fix, but
 * it is a change to everyone's starter layouts and belongs in its own PR.
 */
function sampleDashboardPlan(ds: { id: string; name: string; columns: { name: string; type: string }[]; summaries?: unknown }): AnalysisPlan {
  const plan = buildStarterPlan('kpis', ds as never, { name: SAMPLE_DASHBOARD_NAME });
  const sheet = plan.sheets[0];
  const monthCol = plan.calculatedFields[0] ? plan.calculatedFields[0].name : '';

  const metrics: PlannedMetric[] = [
    { datasetId: ds.id, column: 'revenue', aggregation: 'sum', label: 'Revenue' },
    { datasetId: ds.id, column: 'profit', aggregation: 'sum', label: 'Profit' },
    { datasetId: ds.id, column: 'units', aggregation: 'sum', label: 'Units sold' },
    // count, not avg(ship_days): the average rendered as "3.551" under the
    // 'auto' format, and four significant figures is not a headline number.
    { datasetId: ds.id, column: 'order_date', aggregation: 'count', label: 'Orders' },
  ];

  const chart = (name: string, chartType: string, category: string, column: string, geo?: unknown): PlannedVisual => ({
    kind: 'new',
    datasetId: ds.id,
    name,
    chartType,
    encoding: geo
      ? { category, values: [{ column, aggregation: 'sum' }], geo }
      : { category, values: [{ column, aggregation: 'sum' }] },
    filters: [],
  } as PlannedVisual);

  const visuals: PlannedVisual[] = [];
  // Only if the template's month field compiled — if it did not, a chart against
  // a column that does not exist would be dropped by validatePlan and the user
  // would get a reported hole instead of a dashboard.
  if (monthCol) visuals.push(chart('Revenue by month', 'line', monthCol, 'revenue'));
  visuals.push(chart('Revenue by category', 'column', 'category', 'revenue'));
  // Full state names in the data — geoMatch cannot join "CA" to "California".
  visuals.push(chart('Profit by state', 'map_choropleth', 'state', 'profit', { level: 'us_state' }));

  sheet.metrics = metrics;
  sheet.visuals = visuals;
  sheet.texts = [{ heading: SAMPLE_NOTE_HEADING, text: SAMPLE_NOTE_TEXT }];
  return plan;
}

/**
 * Mark the note card so the renderer draws a Remove button on it.
 *
 * That button takes out the sample's three records — the dashboard, its visuals
 * and the dataset — and leaves the project standing, because the project is now
 * the user's own (see this file's header). It used to delete the project whole,
 * which with one project would delete everything they had.
 *
 * `action` is a closed one-value enum on Card, whitelisted by
 * dashboards.sanitizeCard — but deliberately NOT part of PlannedText, so a plan
 * (and therefore any model-authored dashboard) can never grow a delete button.
 * The only way to get one is this patch, from this file.
 */
async function markNoteCardDeletable(projectId: string, analysisId: string): Promise<void> {
  const rec = await analysis.getAnalysis(projectId, analysisId);
  if (!rec) return;
  const sheets = rec.sheets.map((page) => ({
    ...page,
    cards: page.cards.map((c) => (c.type === 'text' ? { ...c, action: 'delete-sample' } : c)),
  }));
  await analysis.updateAnalysis(projectId, analysisId, { sheets });
}

/**
 * Seed the sample project, once, ever.
 *
 * The flag is written BEFORE anything else is created. A half-finished seed that
 * re-ran on the next launch would pile up a duplicate project every time the app
 * opened, which is far worse than one launch with a partial sample — and the
 * flag records that seeding HAPPENED, not that the sample still exists, so a
 * user who deletes it never gets it back.
 */
export async function seedSampleProject(): Promise<{ seeded: boolean; projectId?: string; analysisId?: string }> {
  if (config.get().sampleSeeded) return { seeded: false };
  const csv = sampleCsvPath();
  if (!fs.existsSync(csv)) {
    console.error('[sample] bundled CSV missing at', csv, '— skipping seed');
    return { seeded: false };
  }
  config.save({ sampleSeeded: true });

  // The user's own first project, and the only one. Created here rather than by
  // resolveProjectId so the sample has somewhere to land; resolveProjectId finds
  // it and adopts it exactly as it would any other.
  const project = await projects.createProject(FIRST_PROJECT_NAME);

  const kind = sourceKindForPath(csv) || 'csv';
  const parsed = await parseFile(csv, kind as never);
  // No `origin`: an origin would make the sample "refreshable" from a path
  // inside the read-only asar, offering the user a Refresh that cannot mean
  // anything. It is a snapshot, like a pasted table.
  const ds = await datasets.saveDataset(project.id, {
    name: SAMPLE_DATASET_NAME,
    sourceKind: kind as never,
    columns: parsed.columns,
    rows: parsed.rows,
  });
  if (!ds) {
    console.error('[sample] could not save the sample dataset');
    return { seeded: true, projectId: project.id };
  }

  // The plan needs the dataset's COMPUTED summaries (distinct counts pick the
  // chart's category column), so the context is loaded after the save.
  const ctx = await loadPlanContext(project.id, ds.id);
  const planDs = ctx.datasets[0];
  if (!planDs) return { seeded: true, projectId: project.id };

  const built = await planBuild.buildPlan(project.id, sampleDashboardPlan(planDs));
  let analysisId: string | undefined;
  if (built.ok) {
    analysisId = built.analysis.id;
    await markNoteCardDeletable(project.id, analysisId);
    // Home's Starred is a filter over Recent keyed on "type:id", so pinning the
    // real record is all it takes for the section to have something in it.
    const starred = execConfig.publicConfig().starred || [];
    config.setStarred([...starred, 'analysis:' + analysisId]);
    if (built.dropped.length) {
      console.error('[sample] plan dropped', built.dropped.length, 'element(s):',
        built.dropped.map((d) => d.message).join(' | '));
    }
  } else {
    console.error('[sample] could not build the sample dashboard:', built.error);
  }

  return { seeded: true, projectId: project.id, analysisId };
}
