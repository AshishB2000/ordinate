// Self-check: DASHBOARD SHAPES (src/analysis/dashboardShapes.ts) and what they
// change — the registry against the plan's vocabularies, the validator's `shape`
// and `note`, the layout a shape sizes, the build's effects (KPI trends, the
// accent, notes), the preview's takeaway against the app's own caption, and the
// KPI trend (src/ipc/kpiTrend.ts) against the chart door it reads through,
// compared with Object.is.
//
//   node scripts/test-dashboardShapes.js   (after npm run build:ts)

import { ok, failureCount, finish } from './selfcheck';
import { isDeepStrictEqual } from 'util';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-shapes-'));

const shapes: typeof import('../src/analysis/dashboardShapes') = require('../src/analysis/dashboardShapes');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const planRows: typeof import('../src/analysis/planRows') = require('../src/analysis/planRows');
const planLayout: typeof import('../src/analysis/planLayout') = require('../src/analysis/planLayout');
const planBuild: typeof import('../src/analysis/planBuild') = require('../src/analysis/planBuild');
const planPreview: typeof import('../src/analysis/planPreview') = require('../src/analysis/planPreview');
const captions: typeof import('../src/analysis/captions') = require('../src/analysis/captions');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const kpi: typeof import('../src/ipc/kpiTrend') = require('../src/ipc/kpiTrend');

// ── The registry ─────────────────────────────────────────────────────────────

function checkRegistry(): void {
  const ids = shapes.DASHBOARD_SHAPES.map((s) => s.id);
  ok('registry: scorecard, review, visual, table', ids.join() === 'scorecard,review,visual,table', ids.join());
  ok('registry: ids are unique and none is "auto"', new Set(ids).size === ids.length && !ids.includes(shapes.AUTO_SHAPE));
  const vocabulary = new Set<string>([...planRows.ROW_TYPES, ...plan.CHART_TYPE_IDS, 'controls', 'note', 'shape', 'facet', 'cols', 'scale', 'shared', ...ids]);
  const quoted = (s: string): string[] => Array.from(s.matchAll(/"([a-z_]+)"/g), (m) => m[1]);
  for (const s of shapes.DASHBOARD_SHAPES) {
    const sentence = shapes.shapeText(s.id);
    ok(`${s.id}: every chart it names is a plan chart type`, s.questions.every((q) => q.charts.every((c) => plan.CHART_TYPE_IDS.has(c))), JSON.stringify(s.questions));
    ok(`${s.id}: every term it quotes is one a plan may use`, quoted(sentence).length > 0 && quoted(sentence).every((w) => vocabulary.has(w)), quoted(sentence).filter((w) => !vocabulary.has(w)).join());
    ok(`${s.id}: no figure in its sentence`, !/\d/.test(sentence), sentence);
    ok(`${s.id}: its sentence names it and asks for "shape"`, sentence.includes(`"${s.id}"`) && sentence.includes(s.title.toUpperCase()));
    const cells = new Set<string>();
    let clash = false;
    for (const [, x, y, w, h] of s.art) {
      for (let i = x; i < x + w; i++) for (let j = y; j < y + h; j++) { if (cells.has(`${i},${j}`)) clash = true; cells.add(`${i},${j}`); }
    }
    ok(`${s.id}: its picture sits on the 12-column grid without overlaps`, !clash && s.art.every(([, x, , w]) => x >= 0 && w > 0 && x + w <= dashboards.GRID_COLS));
    if (s.kpi) ok(`${s.id}: its KPI width divides the grid`, dashboards.GRID_COLS % s.kpi.w === 0);
  }
  const auto = shapes.shapeText(shapes.AUTO_SHAPE);
  ok('auto: the menu lists every shape', shapes.DASHBOARD_SHAPES.every((s) => auto.includes(`"${s.id}"`)) && !/\d/.test(auto));
  ok('shapeOf: only a registry id', ['constructor', '__proto__', 'toString', '', null, 7, 'auto', 'Scorecard'].every((x) => shapes.shapeOf(x) === undefined) && shapes.shapeOf('table')?.id === 'table');
  ok('planNote: one capped line', shapes.planNote('  Look at\nthe   leader  ') === 'Look at the leader' && shapes.planNote('x'.repeat(500)).length === shapes.CARD_NOTE_MAX);
  ok('planNote: a digit drops the note', shapes.planNote('California is 12% of it') === '' && shapes.planNote('Top 10') === '');
  ok('cardNote: a person\'s note keeps its digits', shapes.cardNote('Top 10 states') === 'Top 10 states' && dashboards.cardNote === shapes.cardNote);
  ok('card record: note and trend survive sanitizing, junk does not',
    dashboards.sanitizeCard({ id: '0b6d5b1e-8a52-4c43-9d36-0d5a8f7c1a11', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, note: 'Watch it', metric: { datasetId: '0b6d5b1e-8a52-4c43-9d36-0d5a8f7c1a12', column: 'v', aggregation: 'sum', trend: true } })?.metric?.trend === true
    && dashboards.sanitizeCard({ id: '0b6d5b1e-8a52-4c43-9d36-0d5a8f7c1a11', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: '0b6d5b1e-8a52-4c43-9d36-0d5a8f7c1a12', column: 'v', aggregation: 'sum', trend: 'yes' } })?.metric?.trend === undefined);
}

// ── The validator, the layout ────────────────────────────────────────────────

const COLS = [{ name: 'month', type: 'date' as const }, { name: 'region', type: 'text' as const }, { name: 'revenue', type: 'number' as const }, { name: 'units', type: 'number' as const }];
const REGIONS = ['West', 'East', 'North'];
const ROWS: Array<Array<string | number>> = [];
for (let m = 1; m <= 14; m++) {
  const month = `${m > 12 ? 2025 : 2024}-${String(((m - 1) % 12) + 1).padStart(2, '0')}-15`;
  REGIONS.forEach((r, i) => ROWS.push([month, r, 100 * (i + 1) + m * 7, 10 + m + i]));
}

let projectId = '';
let dsId = '';
const kpiOf = (column: string) => ({ dataset: 'Sales', column, aggregation: 'sum', label: column });
const bar = (extra: Record<string, unknown> = {}) => ({ dataset: 'Sales', name: 'Who leads?', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, ...extra });

async function checkPlan(): Promise<void> {
  const ctx = await plan.loadPlanContext(projectId);
  const v = (raw: unknown) => plan.validatePlan(raw, ctx);
  ok('validate: a known shape is kept', v({ shape: 'review', sheets: [] }).plan.shape === 'review');
  ok('validate: an unknown shape is left out', ['spiral', 'auto', 'constructor', 7].every((x) => !('shape' in v({ shape: x, sheets: [] }).plan)));
  const noted = v({ sheets: [{ name: 'S', visuals: [bar({ note: 'The West leads' }), bar({ note: 'Up 12% on last year' })] }] });
  ok('validate: a chart keeps its note, minus one with a figure', noted.plan.sheets[0].visuals[0].note === 'The West leads' && !('note' in noted.plan.sheets[0].visuals[1]), JSON.stringify(noted.plan.sheets[0].visuals));
  const facet = v({ sheets: [{ name: 'S', visuals: [bar({ encoding: { category: 'month', values: [{ column: 'revenue', aggregation: 'sum' }], facet: { cols: 'region', scale: 'shared' } } }), bar({ encoding: { category: 'month', values: [{ column: 'revenue', aggregation: 'sum' }], facet: { cols: 'nope' } } })] }] });
  ok('validate: small multiples on a real column are kept', facet.plan.sheets[0].visuals[0].encoding.facet?.cols === 'region');
  ok('validate: small multiples on a missing column are dropped, the chart kept', facet.plan.sheets[0].visuals.length === 2 && !facet.plan.sheets[0].visuals[1].encoding.facet && facet.dropped.some((d) => /small multiples dropped/.test(d.message)), JSON.stringify(facet.dropped));
  ok('validate: a validated plan validates to itself (shape and notes too)', isDeepStrictEqual(v(noted.plan).plan, noted.plan) && isDeepStrictEqual(v({ ...noted.plan, shape: 'visual' }).plan.shape, 'visual'));

  // Layout: a scorecard's six KPIs are two lines of three, bigger; with no shape, a strip as before.
  const six = { name: 'S', metrics: [], visuals: [], texts: [], rows: [{ type: 'kpis', metrics: Array.from({ length: 6 }, () => ({ datasetId: dsId, column: 'revenue', aggregation: 'sum' })) }] } as any;
  six.metrics = six.rows[0].metrics;
  const sc = planLayout.arrangeSheet(six, shapes.shapeOf('scorecard'));
  ok('layout: scorecard KPIs are 4 wide, 3 tall, three to a line', sc.metrics.every((l) => l.w === 4 && l.h === 3) && sc.metrics[3].x === 0 && sc.metrics[3].y === 3, JSON.stringify(sc.metrics));
  const plain = planLayout.arrangeSheet(six);
  ok('layout: no shape, the strip it always was', plain.metrics.every((l) => l.w === 3 && l.h === 2) && plain.metrics[4].y === 2, JSON.stringify(plain.metrics));
  const tall = planLayout.arrangeSheet({ name: 'S', metrics: [], visuals: [{}], texts: [], rows: [{ type: 'charts', visuals: [{}] }] } as any, shapes.shapeOf('table'));
  ok('layout: a table shape\'s chart is taller', tall.visuals[0].h === 10 && tall.visuals[0].w === 12);
}

// ── Build and preview ───────────────────────────────────────────────────────

async function checkBuild(): Promise<void> {
  const built = await planBuild.buildPlan(projectId, {
    name: 'Scored', shape: 'scorecard',
    sheets: [{ name: 'S', rows: [{ type: 'kpis', metrics: [kpiOf('revenue'), kpiOf('units')] }, { type: 'charts', visuals: [bar({ note: 'Where it comes from' })] }] }],
  });
  if (!built.ok) { ok('build: scorecard', false, built.error); return; }
  const cards = built.analysis.sheets[0].cards;
  const metricCards = cards.filter((c) => c.type === 'metric');
  ok('build: every scorecard KPI asks for its trend', metricCards.length === 2 && metricCards.every((c) => c.metric?.trend === true));
  ok('build: scorecard KPIs are the shape\'s size', metricCards.every((c) => c.layout.w === 4 && c.layout.h === 3), JSON.stringify(metricCards.map((c) => c.layout)));
  const chart = cards.find((c) => c.type === 'visual');
  ok('build: a chart card carries its note', chart?.note === 'Where it comes from');
  ok('build: a scorecard chart is not accented', !(await visuals.getVisual(projectId, chart?.visualId || ''))?.overrides.accent);

  const story = await planBuild.buildPlan(projectId, { name: 'Story', shape: 'visual', sheets: [{ name: 'S', rows: [{ type: 'charts', visuals: [bar()] }] }] });
  const sv = story.ok ? story.analysis.sheets[0].cards.find((c) => c.type === 'visual') : undefined;
  ok('build: a visual-analysis chart draws the accent', (await visuals.getVisual(projectId, sv?.visualId || ''))?.overrides.accent === true);
  const tbl = await planBuild.buildPlan(projectId, { name: 'Every region', shape: 'table', sheets: [{ name: 'S', rows: [{ type: 'charts', visuals: [bar({ chartType: 'table' })] }] }] });
  const tv = tbl.ok ? tbl.analysis.sheets[0].cards.find((c) => c.type === 'visual') : undefined;
  const tvis = await visuals.getVisual(projectId, tv?.visualId || '');
  ok('build: a table-shape table sorts, searches and draws bars, and is tall', tvis?.overrides.richTable === true && !tvis?.overrides.accent && tv?.layout.h === 10);
  const flat = await planBuild.buildPlan(projectId, { name: 'Plain', sheets: [{ name: 'S', metrics: [kpiOf('revenue')], visuals: [bar()] }] });
  const flatVis = flat.ok ? await visuals.getVisual(projectId, flat.analysis.sheets[0].cards.find((c) => c.type === 'visual')?.visualId || '') : null;
  ok('build: no shape, no trend, no accent, no rich table (negative control)', flat.ok && flat.analysis.sheets[0].cards.every((c) => !c.metric?.trend && !c.note) && !!flatVis && Object.keys(flatVis.overrides).length === 0, JSON.stringify(flatVis?.overrides));

  // The takeaway is the app's caption of the lead chart — the same function, the same figures.
  const prev = await planPreview.previewPlan(projectId, { shape: 'visual', sheets: [{ name: 'S', rows: [{ type: 'charts', visuals: [bar({ note: 'Read the leader' })] }, { type: 'charts', visuals: [bar({ name: 'Second' })] }] }] });
  const lead = prev.sheets[0].visuals[0];
  ok('preview: the shape and the note come back', prev.shape === 'visual' && lead.cardNote === 'Read the leader');
  ok('preview: the takeaway is the lead chart\'s own caption', !!lead.data && prev.takeaway === captions.tileCaption({ chartType: lead.chartType, data: lead.data }) && /leads/.test(prev.takeaway || ''), prev.takeaway);
}

// ── KPI trend, against the chart door ───────────────────────────────────────

async function checkTrend(): Promise<void> {
  const card = { datasetId: dsId, column: 'revenue', aggregation: 'sum' as const };
  const t = await kpi.kpiTrend(projectId, card, []);
  const door = await ipcVisuals.vizDataFor(projectId, dsId, { category: 'month', grain: 'month', values: [{ column: 'revenue', aggregation: 'sum' }] }, []);
  if (!t || !door.ok) { ok('trend: computed', false, JSON.stringify({ t, door })); return; }
  const want = door.data.series[0].values.slice(-kpi.TREND_POINTS);
  ok('trend: the last twelve months, as the chart door draws them (Object.is)', t.values.length === 12 && t.values.every((v, i) => Object.is(v, want[i])), JSON.stringify([t.values, want]));
  ok('trend: labels read as months', t.labels.length === 12 && t.labels[11] === 'Feb 2025', t.labels.join());
  const [a, b] = t.values.slice(-2) as number[];
  ok('trend: the change is the latest month against the one before', !!t.change && Object.is(t.change.delta, b - a) && Object.is(t.change.pct, ((b - a) / Math.abs(a)) * 100) && t.change.tone === 'good' && t.change.label === 'Feb 2025 vs Jan 2025', JSON.stringify(t.change));
  const west = await kpi.kpiTrend(projectId, card, [{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
  const westDoor = await ipcVisuals.vizDataFor(projectId, dsId, { category: 'month', grain: 'month', values: [{ column: 'revenue', aggregation: 'sum' }] }, [{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
  ok('trend: under the card\'s filters', !!west && westDoor.ok && west.values.every((v, i) => Object.is(v, westDoor.data.series[0].values.slice(-12)[i])) && !isDeepStrictEqual(west.values, t.values));
  const noDate = await datasets.saveDataset(projectId, { name: 'Flat', sourceKind: 'csv', columns: [{ name: 'k', type: 'text' }, { name: 'v', type: 'number' }], rows: [['a', 1]] });
  ok('trend: no date column, no trend', (await kpi.kpiTrend(projectId, { datasetId: noDate!.id, column: 'v', aggregation: 'sum' }, [])) === null);
  ok('trend: a formula metric (no column), no trend', (await kpi.kpiTrend(projectId, { ...card, column: '' }, [])) === null);
}

(async () => {
  checkRegistry();
  await projects.init();
  await datasets.init();
  await visuals.init();
  await analysisStore.init();
  const p = await projects.createProject('Shapes project');
  if (!p) throw new Error('createProject failed');
  projectId = p.id;
  const ds = await datasets.saveDataset(projectId, { name: 'Sales', sourceKind: 'csv', columns: COLS, rows: ROWS });
  if (!ds) throw new Error('saveDataset failed');
  dsId = ds.id;
  await checkPlan();
  await checkBuild();
  await checkTrend();
  if (failureCount()) console.error('\n' + failureCount() + ' dashboard-shape check(s) FAILED');
  else console.log('\nAll dashboard-shape checks passed.');
  finish();
})().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});
