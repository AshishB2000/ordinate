// Self-check for rebuild-from-a-screenshot (docs/rebuild-from-screenshot/):
// the model's reading sanitized, matched to a dataset by app code, converted to
// a plan, previewed and built through the planner's own doors.
//
// Properties held here, each of which would fail silently otherwise:
//
//   1. NO FIGURE FROM THE MODEL. The fake model reply (scripts/fixtures/rebuild/
//      reading.json) plants figures — a `value`, a `figure`, a `data` table, and
//      money / percent tokens in titles. None survives `sanitizeReading`, and
//      none reaches `rebuild:match`'s reply. Negative control: the raw fixture
//      does carry every one of them.
//   2. MATCHING IS ON THE DECLARED TYPE. A sum over a text column is REFUSED —
//      read so by the model, or picked so by the user — and never built; the
//      same column with a count is built. The validator's own drop is the
//      reason for a tile only the validator could refuse (a map with no places).
//   3. NOTHING COERCED. A chart Ordinate does not draw ("sunburst") waits for a
//      pick; it is not turned into a bar.
//   4. THE ARRANGEMENT IS THE SCREENSHOT'S, IN PLAN ROWS: a note, a KPI strip,
//      two charts side by side; filters become the sheet's chips.
//   5. THE FIGURES ARE THE ENGINE'S. Each KPI equals `computeCardMetric` on the
//      same spec, and a JS fold over the rows (Object.is); the preview chart is
//      `vizDataFor`'s; and matching itself hydrates no table.
//   6. CREATION GOES THROUGH THE ONE DOOR: `analysis:buildPlan` builds the plan
//      `rebuild:match` returned, with the cards the check screen showed.
//
//   npm run build:ts && node scripts/test-rebuild.js

export {};
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-rebuild-'));
const ipcHandlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;

const read: typeof import('../src/ai/rebuildRead') = require('../src/ai/rebuildRead');
const match: typeof import('../src/analysis/rebuildMatch') = require('../src/analysis/rebuildMatch');
const rplan: typeof import('../src/analysis/rebuildPlan') = require('../src/analysis/rebuildPlan');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const rebuildIpc: typeof import('../src/ipc/rebuild') = require('../src/ipc/rebuild');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'rebuild', 'reading.json'), 'utf8'));
/** Every figure the fake model planted. */
const PLANTED = ['2400000', '286,397', '9994', '725457', '678781', '2.4M', '12.5'];

const COLS: ParsedColumn[] = [
  { name: 'Region', type: 'text' },
  { name: 'Segment', type: 'text' },
  { name: 'Category', type: 'text' },
  { name: 'Order Date', type: 'date' },
  { name: 'Revenue', type: 'number' },
  { name: 'Profit', type: 'number' },
  { name: 'Product ID', type: 'text' },
];
const ROWS: Cell[][] = [
  ['West', 'Consumer', 'Furniture', '2024-01-05', 120.5, 30.25, '007'],
  ['East', 'Corporate', 'Technology', '2024-01-19', 310.75, -12.5, '008'],
  ['West', 'Home Office', 'Office', '2024-02-02', 99.1, 14.2, '009'],
  ['South', 'Consumer', 'Technology', '2024-03-11', 45.3, 5.05, '010'],
];

// The hydration spy (test-analysisPlan.ts's): resolved off the module at call time.
const realGetDataset = datasets.getDataset;
let hydrations = 0;
(datasets as any).getDataset = async (...args: any[]): Promise<any> => {
  hydrations += 1;
  return (realGetDataset as any)(...args);
};

// ── §1 the reading carries no figure ───────────────────────────────────────
function checkSanitize(): void {
  const raw = JSON.stringify(RAW);
  ok('negative control: the fake reply DOES plant figures', PLANTED.every((f) => raw.includes(f)), PLANTED.filter((f) => !raw.includes(f)).join(','));
  const r = read.sanitizeReading(RAW);
  const out = JSON.stringify(r);
  ok('sanitize: no planted figure survives', PLANTED.every((f) => !out.includes(f)), PLANTED.filter((f) => out.includes(f)).join(','));
  ok('sanitize: no value / figure / data key is copied', !/"(?:value|figure|data)"/.test(out), out.slice(0, 200));
  ok('sanitize: an unknown kind is skipped, the rest kept and numbered', r.tiles.length === 10 && r.tiles.every((t, i) => t.id === i + 1), String(r.tiles.length));
  ok('sanitize: a title loses its figure, keeps its words', r.tiles[2].title === 'Total Sales' && r.title === 'Superstore Overview', `${r.tiles[2].title} | ${r.title}`);
  ok('sanitize: a note keeps its words around a percent', r.tiles[0].title === 'Sales dashboard: growth', r.tiles[0].title);
  ok('sanitize: the tool is lower-cased onto the closed list', r.tool === 'tableau');
  ok('sanitize: a box is percent of the image', JSON.stringify(r.tiles[6].box) === JSON.stringify({ x: 2, y: 25, w: 47, h: 35 }));
  ok('sanitize: it is idempotent (a reading round-tripped through a browser reads the same)', JSON.stringify(read.sanitizeReading(JSON.parse(out))) === out);
  ok('sanitize: garbage is an empty reading, never a throw', [null, 7, 'x', [], { tiles: 'no' }].every((g) => read.sanitizeReading(g).tiles.length === 0));
  ok('stripFigures keeps a year and a rank', read.stripFigures('Top 10 products, 2024') === 'Top 10 products, 2024');
  ok('stripFigures cuts money, percents, thousands, decimals, K/M/B', read.stripFigures('Sales €1,234 (+4.2%) 3.5k 12B 1,000,000') === 'Sales', read.stripFigures('Sales €1,234 (+4.2%) 3.5k 12B 1,000,000'));
  const prompt = read.REBUILD_SYSTEM_PROMPT;
  ok('prompt: every tile kind and every Ordinate chart id is described', read.TILE_KINDS.every((k) => prompt.includes(k)) && [...plan.CHART_TYPE_IDS].every((c) => prompt.includes(c)));
  ok('prompt: forbids figures', /NEVER output a number/.test(prompt));
}

// ── §2 the matcher ─────────────────────────────────────────────────────────
function checkMatcher(): void {
  const m = match.matchField;
  const exact = m('Region', COLS, 'category');
  ok('match: same name is exact', exact.column === 'Region' && 'confidence' in exact && exact.confidence === 'exact');
  const camel = m('OrderDate', COLS, 'category');
  ok('match: case and separators do not matter', camel.column === 'Order Date' && 'confidence' in camel && camel.confidence === 'exact');
  const syn = m('Sales', COLS, 'value', 'sum');
  ok('match: a synonym is likely, not exact', syn.column === 'Revenue' && 'confidence' in syn && syn.confidence === 'likely', JSON.stringify(syn));
  const text = m('Product ID', COLS, 'value', 'sum');
  ok('match: sum never takes a text column — reported, not matched', text.column === null && 'refusedType' in text && text.refusedType?.column === 'Product ID' && text.refusedType.type === 'text', JSON.stringify(text));
  const count = m('Product ID', COLS, 'value', 'count');
  ok('match: count takes the same text column', count.column === 'Product ID');
  ok('match: a date range only takes a date', m('Region', COLS, 'date_filter').column === null && m('Order Date', COLS, 'date_filter').column === 'Order Date');
  ok('match: nothing close is no match', m('Shipping Mode', COLS, 'category').column === null);
  ok('match: "Number of Records" counts rows', m('Records', COLS, 'value', 'count').column === 'Region');
  ok('splitAggregation reads the aggregation off a name', JSON.stringify(match.splitAggregation('Sum of Profit')) === '{"field":"Profit","aggregation":"sum"}'
    && match.splitAggregation('Avg. Discount').aggregation === 'avg' && match.splitAggregation('Total').field === 'Total' && match.splitAggregation('North').aggregation === '');
  ok('chart words: Ordinate ids pass, BI words map, the rest is null', match.chartTypeOf('line') === 'line' && match.chartTypeOf('Horizontal Bar') === 'bar'
    && match.chartTypeOf('doughnut') === 'donut' && match.chartTypeOf('crosstab') === 'pivot' && match.chartTypeOf('big number') === 'kpi' && match.chartTypeOf('sunburst') === null);
  ok('every mapped chart word lands on a real chart type', ['bar_chart', 'filled_map', 'symbol_map', 'speedometer', 'text_table'].every((w) => plan.CHART_TYPE_IDS.has(match.chartTypeOf(w) ?? '')));
}

// ── §2–§4 tiles and the plan, against a context ────────────────────────────
function ctxOf(id: string): import('../src/analysis/analysisPlan').PlanContext {
  return { datasets: [{ id, name: 'Superstore', rowCount: ROWS.length, columns: COLS, resident: true }], visuals: [] };
}

function checkPlan(): void {
  const ctx = ctxOf('00000000-0000-4000-8000-000000000001');
  const ds = ctx.datasets[0];
  const reading = read.sanitizeReading(RAW);
  const { tiles, plan: raw, order } = rplan.rebuild(reading, ds, ctx);
  const at = (id: number) => tiles.find((t) => t.id === id)!;
  ok('tiles: one per read tile', tiles.length === 10);
  ok('tiles: KPIs matched (synonym, exact, record count)', at(3).status === 'ready' && at(3).fields[0].column === 'Revenue' && at(4).fields[0].confidence === 'exact' && at(5).fields[0].aggregation === 'count', JSON.stringify(at(3).fields));
  ok('tiles: a BI chart word becomes Ordinate\'s chart', at(7).chartType === 'bar' && at(7).status === 'ready');
  ok('tiles: a split is kept when it matches', at(8).fields.some((f) => f.key === 'split' && f.column === 'Segment'));
  ok('NOT COERCED: a sunburst waits for a pick', at(9).status === 'unmapped' && at(9).chartType === null && /sunburst/.test(at(9).reason ?? ''), at(9).reason);
  ok('REFUSED: the model\'s sum over a text column is not built', at(10).status === 'unmapped' && /needs a number column/.test(at(10).reason ?? '') && /Product ID/.test(at(10).reason ?? ''), at(10).reason);
  ok('tiles: a multi-select filter and a date range', at(2).multi === true && at(2).status === 'ready' && at(6).fields[0].column === 'Order Date');

  const v = plan.validatePlan(raw, ctx);
  ok('plan: validatePlan accepts it with nothing dropped', v.dropped.length === 0, JSON.stringify(v.dropped));
  const sheet = v.plan.sheets[0];
  ok('plan: the screenshot\'s bands as rows — note, KPI strip, two charts side by side', JSON.stringify(sheet.rows?.map((r) => r.type)) === '["note","kpis","charts"]', JSON.stringify(sheet.rows?.map((r) => r.type)));
  ok('plan: two charts in one row', sheet.rows?.[2].type === 'charts' && sheet.rows[2].visuals.length === 2);
  ok('plan: filters are the sheet\'s chips', JSON.stringify(sheet.controls?.map((c) => [c.kind, c.column])) === '[["multi","Region"],["date_range","Order Date"]]', JSON.stringify(sheet.controls));
  ok('plan: the unmapped tiles are left out', sheet.visuals.length === 2 && sheet.metrics.length === 3);
  ok('plan: placement order per kind', JSON.stringify(order) === '{"kpi":[3,4,5],"chart":[7,8],"text":[1]}', JSON.stringify(order));
  ok('plan: the name and rationale are app-written', v.plan.name === 'Superstore Overview' && /Tableau/.test(v.plan.rationale));
  ok('plan: carries no geometry', !/"(?:x|y|w|h)":/.test(JSON.stringify(raw)));

  // The user's corrections, each re-checked.
  const fixed = rplan.rebuild(reading, ds, ctx, [
    { id: 9, chartType: 'donut' },
    { id: 10, fields: { value0: { column: 'Product ID', aggregation: 'count' } } },
    { id: 7, fields: { value0: { column: 'Region', aggregation: 'sum' } } },
    { id: 1, dropped: true },
    { id: 8, fields: { split: { column: null } } },
  ]).tiles;
  const f = (id: number) => fixed.find((t) => t.id === id)!;
  ok('override: a picked chart type is taken', f(9).status === 'ready' && f(9).chartType === 'donut');
  ok('override: count over the text column is built', f(10).status === 'ready' && f(10).fields[1].confidence === 'picked', JSON.stringify(f(10)));
  ok('REFUSED: the user\'s sum over a text column is not built either', f(7).status === 'unmapped' && /needs a number column, but "Region" is text/.test(f(7).reason ?? ''), f(7).reason);
  ok('override: a dropped tile is dropped', f(1).status === 'dropped');
  ok('override: a split cleared is left out, the chart still ready', f(8).status === 'ready' && f(8).fields.find((x) => x.key === 'split')?.column === null);
  ok('override: a chart type off the list is ignored, not trusted', rplan.rebuild(reading, ds, ctx, [{ id: 9, chartType: 'sunburst' }]).tiles[8].status === 'unmapped');
  ok('override: a column the dataset lacks is refused', rplan.rebuild(reading, ds, ctx, [{ id: 7, fields: { category: { column: 'Nope' } } }]).tiles[6].status === 'unmapped');
  ok('override: a KPI turned into a chart becomes one', rplan.rebuild(reading, ds, ctx, [{ id: 3, chartType: 'column', fields: { category: { column: 'Region' } } }]).tiles[2].kind === 'chart');

  // The validator's own refusal becomes the tile's reason: a map over a column of no places.
  const mapped = rplan.rebuild(reading, { ...ds, geoHits: {} }, { ...ctx, datasets: [{ ...ds, geoHits: {} }] }, [{ id: 9, chartType: 'map_choropleth' }]).tiles[8];
  ok('checkTile: a tile the validator drops is shown with its sentence, never built', mapped.status === 'unmapped' && !!mapped.reason && !/dropped/.test(mapped.reason), mapped.reason);

  ok('bands: a tile without a box follows, on its own', JSON.stringify(rplan.bands([{ box: null, n: 1 }, { box: { x: 50, y: 0, w: 40, h: 10 }, n: 2 }, { box: { x: 0, y: 2, w: 40, h: 10 }, n: 3 }]).map((b) => b.map((t) => t.n))) === '[[3,2],[1]]');
}

// ── §5 + §6 end to end on real records ─────────────────────────────────────
async function checkEndToEnd(): Promise<void> {
  const p = await projects.createProject('Rebuild project');
  const ds = await datasets.saveDataset(p!.id, { name: 'Superstore', sourceKind: 'csv', columns: COLS, rows: ROWS });
  const projectId = p!.id;
  // Matching reads metadata only; the previews and figures are the engine's doors, whose cost model decides how.
  hydrations = 0;
  const pctx = await plan.loadPlanContext(projectId, ds!.id);
  rplan.rebuild(read.sanitizeReading(RAW), pctx.datasets[0], pctx);
  ok('match: matching hydrates no table', hydrations === 0, String(hydrations));
  const r = await rebuildIpc.matchReading(projectId, ds!.id, RAW, []);
  ok('match: ok', r.ok === true, JSON.stringify(r).slice(0, 300));
  const json = JSON.stringify(r);
  ok('match: no planted figure in the reply', PLANTED.every((f) => !json.includes(f)), PLANTED.filter((f) => json.includes(f)).join(','));

  const tile = (id: number) => r.tiles.find((t: any) => t.id === id);
  const revenue = ROWS.reduce((n, row) => n + (row[4] as number), 0);
  const viaDoor = await dashIpc.computeCardMetric(projectId, ds!.id, { column: 'Revenue', aggregation: 'sum' });
  ok('figure: the KPI is computeCardMetric\'s', Object.is(tile(3).figure.value, viaDoor.value), `${tile(3).figure.value} vs ${viaDoor.value}`);
  ok('figure: …which is the JS fold over the rows', Object.is(viaDoor.value, revenue), `${viaDoor.value} vs ${revenue}`);
  ok('figure: the count KPI counts the rows', tile(5).figure.value === ROWS.length);
  ok('preview: a ready chart carries the engine\'s data', Array.isArray(tile(7).preview?.data?.labels) && tile(7).preview.data.labels.includes('West'), JSON.stringify(tile(7).preview).slice(0, 200));
  ok('preview: an unmapped tile has none', tile(10).preview === undefined && tile(10).figure === undefined);
  ok('layout: every placed tile is numbered by its tile', r.layout.length === 6 && r.layout.every((l: any) => typeof l.tileId === 'number'), JSON.stringify(r.layout));
  ok('layout: the KPI strip sits above the charts', r.layout.find((l: any) => l.tileId === 3).y < r.layout.find((l: any) => l.tileId === 7).y);

  // Creation: the one door.
  const analyses: typeof import('../src/ipc/analyses') = require('../src/ipc/analyses');
  analyses.register();
  const built = await ipcHandlers.get('analysis:buildPlan')!(null, { projectId, plan: r.plan });
  ok('build: analysis:buildPlan builds the returned plan', built.ok === true, JSON.stringify(built).slice(0, 300));
  const cards = built.analysis?.sheets?.[0]?.cards ?? [];
  const count = (type: string) => cards.filter((c: any) => c.type === type).length;
  ok('build: the cards the check screen showed', count('metric') === 3 && count('visual') === 2 && count('text') === 1, JSON.stringify(cards.map((c: any) => c.type)));
  ok('build: the filter chips', count('control') === 2 || (built.analysis.sheets[0].controls ?? []).length === 2, JSON.stringify(cards.map((c: any) => c.type)));

  const gone = await rebuildIpc.matchReading(projectId, '00000000-0000-4000-8000-00000000dead', RAW, []);
  ok('match: a dataset that is not there is refused in words', gone.ok === false && typeof gone.error === 'string' && gone.error.length > 0);
}

// ── the read, with the model stubbed at its one door ───────────────────────
async function checkRead(): Promise<void> {
  const real = { dispatch: analyze.dispatch, ready: execConfig.executionReady };
  try {
    (execConfig as any).executionReady = async () => false;
    const nr = await read.readDashboardImage('data:image/png;base64,AAAA');
    ok('read: no model → not_ready', !nr.ok && nr.errorType === 'not_ready');
    let sent: any = null;
    (execConfig as any).executionReady = async () => true;
    (analyze as any).dispatch = async (system: string, messages: any[]) => {
      sent = { system, messages };
      return { rawText: '```json\n' + JSON.stringify(RAW) + '\n```' };
    };
    const r = await read.readDashboardImage('data:image/png;base64,iVBORw0KGgo=');
    ok('read: the image goes to the model on the first turn', sent?.messages?.[0]?.image === 'iVBORw0KGgo=' && sent.system === read.REBUILD_SYSTEM_PROMPT);
    ok('read: the reply is sanitized', r.ok && r.reading.tiles.length === 10 && !JSON.stringify(r.reading).includes('2400000'));
    (analyze as any).dispatch = async () => ({ rawText: 'I cannot help with that.' });
    const bad = await read.readDashboardImage('data:image/png;base64,iVBORw0KGgo=');
    ok('read: prose is a bad reply', !bad.ok && bad.errorType === 'bad_reply');
  } finally {
    (analyze as any).dispatch = real.dispatch;
    (execConfig as any).executionReady = real.ready;
  }
  rebuildIpc.register();
  const noToken = await ipcHandlers.get('rebuild:read')!(null, { projectId: 'x', fileToken: 'not-a-token' });
  ok('rebuild:read: a bad upload token is a sentence, not a throw', noToken.ok === false && typeof noToken.message === 'string' && noToken.message.length > 0);
  ok('sanitizeOverrides: drops what is not an override', JSON.stringify(rebuildIpc.sanitizeOverrides([null, { id: 'x' }, { id: 2, fields: { evil: { column: 'a' }, value0: { column: 'b', aggregation: 'median' } } }]))
    === '[{"id":2,"fields":{"value0":{"column":"b"}}}]');
}

(async () => {
  const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
  ipcVisuals.register();
  await projects.init();
  await datasets.init();
  await visuals.init();
  await analysisStore.init();
  checkSanitize();
  checkMatcher();
  checkPlan();
  await checkRead();
  await checkEndToEnd();
  finish();
})().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});
