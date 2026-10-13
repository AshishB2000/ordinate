// Self-check: a map always knows its regions (src/analysis/geoHits.ts).
//
// The bug this pins: a dataset of the 50 full US state names resolved to
// `us_state` with a hit rate of 1 and STILL drew an empty map. validatePlan kept
// a drafted `map_choropleth` with no `encoding.geo`, buildVizData emits regions
// only when it is set, and the builder's "Map regions" starts Off.
//
//   1. THE PLAN RULE. A region map with no geo takes its level from the category
//      column's values or is DROPPED with a reason — never coerced into another
//      chart, never touched when it already names its regions, and validating
//      the validated plan changes nothing.
//   2. THE FACTS. A places column says so by LEVEL, never by value, and a map is
//      allowed only on such a column.
//   3. THE REPLY. A chart reply suggests a level from labels it already carries.
//   4. ON REAL DISK, through the shipped doors: the context is sampled without a
//      hydrate, the built map draws all 50 states, `visual:data` and
//      `visual:preview` suggest, and the automation and dashboard-edit doors
//      apply the same rule.
//
//   npm run build:ts && node scripts/test-mapRegions.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { isDeepStrictEqual: same }: typeof import('util') = require('util');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-mapregions-'));

// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const planFacts: typeof import('../src/analysis/planFacts') = require('../src/analysis/planFacts');
const planBuild: typeof import('../src/analysis/planBuild') = require('../src/analysis/planBuild');
const geoHits: typeof import('../src/analysis/geoHits') = require('../src/analysis/geoHits');
const { resolveGeoHits }: typeof import('../src/analysis/geoResolve') = require('../src/analysis/geoResolve');
const delta: typeof import('../src/analysis/dashboardDelta') = require('../src/analysis/dashboardDelta');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const creators: typeof import('../src/automation/creators') = require('../src/automation/creators');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type PlanContext = import('../src/analysis/analysisPlan').PlanContext;
type Cell = import('../src/data/transforms').Cell;

// ── Fixtures: the reported dataset's columns, plus two columns to tell apart ──

const STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia',
  'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland',
  'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina',
  'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];
const REGIONS = ['East', 'West', 'Central'];
const NATIONS = ['France', 'Japan', 'Brazil', 'Kenya', 'Canada'];
const COLS: ParsedColumn[] = [
  { name: 'Rank', type: 'number' }, { name: 'US State', type: 'text' },
  { name: 'Population 2024', type: 'number' }, { name: 'Population 2023', type: 'number' },
  { name: 'Growth Rate', type: 'number' }, { name: '% of US', type: 'number' }, { name: 'Density (/mile2)', type: 'number' },
  { name: 'Region', type: 'text' }, { name: 'Nation', type: 'text' },
];
const ROWS: Cell[][] = STATES.map((s, i) => [i + 1, s, 1000 * (50 - i), 990 * (50 - i), 0.01, 2, 100 + i, REGIONS[i % 3], NATIONS[i % 5]]);

const DS = '22222222-2222-4222-8222-222222222222';
/** A context whose geo signal is the REAL resolver's answer for these values. */
const CTX: PlanContext = {
  datasets: [{
    id: DS, name: 'States', rowCount: 50, columns: COLS, resident: true,
    geoHits: resolveGeoHits({ 'US State': STATES, Region: REGIONS, Nation: NATIONS }),
  }],
  visuals: [],
};
const POP = [{ column: 'Population 2024', aggregation: 'sum' }];
const viz = (chartType: string, category: string, geo?: unknown) =>
  ({ dataset: 'States', name: `Population by ${category}`, chartType, encoding: geo ? { category, values: POP, geo } : { category, values: POP } });
const check = (visual: unknown, ctx: PlanContext = CTX) => plan.validatePlan({ name: 'P', sheets: [{ name: 'S', visuals: [visual] }] }, ctx);

// ── §1 The plan rule ────────────────────────────────────────────────────────
function checkPlanRule(): void {
  // The reported case, exactly: what the model drafts, no geo anywhere.
  const drafted = check(viz('map_choropleth', 'US State'));
  const kept = drafted.plan.sheets[0].visuals[0];
  ok('a drafted state map is kept', !!kept && drafted.dropped.length === 0, JSON.stringify(drafted.dropped));
  ok('…as the map it was drafted as', kept?.chartType === 'map_choropleth');
  ok('…and now names its regions: geo is { level: us_state } and nothing else', same(kept?.encoding.geo, { level: 'us_state' }), JSON.stringify(kept?.encoding));
  const bubble = check(viz('map_bubble', 'Nation')).plan.sheets[0].visuals[0];
  ok('a bubble map of countries gets the country level', same(bubble?.encoding.geo, { level: 'country' }), JSON.stringify(bubble?.encoding));

  // Not places: dropped and reported — and NOT turned into some other chart.
  const lost = check(viz('map_choropleth', 'Region'));
  ok('a map of a column that holds no places is dropped', lost.plan.sheets[0].visuals.length === 0 && lost.dropped.length === 1, JSON.stringify(lost));
  const msg = lost.dropped[0]?.message || '';
  ok('…with a message that says what a map needs and names the column',
     lost.dropped[0]?.kind === 'encoding' && msg.includes('a map needs a column of places') && msg.includes('"Region"') && msg.includes('"States"') && msg.includes('Population by Region'), msg);

  // A map that already names its regions is nobody's to change — even where the column resolves differently.
  const county = check(viz('map_choropleth', 'Region', { level: 'us_county' }));
  ok('a map that carries geo is left alone on a non-place column', same(county.plan.sheets[0].visuals[0]?.encoding.geo, { level: 'us_county' }) && county.dropped.length === 0);
  const own = check(viz('map_bubble', 'US State', { level: 'country', basemap: 'none' }));
  ok('…and its own level is not overwritten by the column\'s', same(own.plan.sheets[0].visuals[0]?.encoding.geo, { level: 'country', basemap: 'none' }));

  // Idempotent: buildPlan re-runs the validator on the plan the browser hands back.
  const both = plan.validatePlan({ name: 'P', sheets: [{ name: 'S', visuals: [viz('map_choropleth', 'US State'), viz('map_bubble', 'Nation'), viz('column', 'Region')] }] }, CTX);
  const again = plan.validatePlan(both.plan, CTX);
  ok('validating the validated plan changes nothing', both.plan.sheets[0].visuals.length === 3 && same(again.plan, both.plan) && again.dropped.length === 0, JSON.stringify(again.dropped));
  const noSignal: PlanContext = { ...CTX, datasets: [{ ...CTX.datasets[0], geoHits: {} }] };
  ok('…even against a context that no longer resolves the column', same(plan.validatePlan(both.plan, noSignal).plan, both.plan));

  // Negative controls: the rule is about MAPS, and about a context that looked.
  const column = check(viz('column', 'US State')).plan.sheets[0].visuals[0];
  ok('a column chart of a places column is given no geo', !!column && column.encoding.geo === undefined);
  ok('a column chart of a non-place column is kept, not dropped', check(viz('column', 'Region')).plan.sheets[0].visuals.length === 1);
  ok('the same map IS dropped once the context says the column is not places', check(viz('map_choropleth', 'US State'), noSignal).dropped.length === 1);
  const unsampled: PlanContext = { ...CTX, datasets: [{ id: DS, name: 'States', rowCount: 50, columns: COLS, resident: false }] };
  const dry = check(viz('map_choropleth', 'US State'), unsampled);
  ok('a context that never sampled (planCheck\'s dry run) leaves the map for the door that builds it',
     dry.dropped.length === 0 && dry.plan.sheets[0].visuals[0]?.encoding.geo === undefined);
}

// ── §2 The facts ────────────────────────────────────────────────────────────
function checkFacts(): void {
  const facts = planFacts.buildFactsText(CTX, 'A map of population.');
  const lines = facts.split('\n');
  ok('facts: a column of states is marked by level', lines.includes('    - US State (text) — places: US states'), facts);
  ok('facts: a column of countries is marked by level', lines.includes('    - Nation (text) — places: countries'));
  ok('facts: a column that is not places is marked nothing (negative control)', lines.includes('    - Region (text)'));
  ok('facts: a number column is unchanged', lines.includes('    - Rank (number)'));
  const rule = facts.indexOf('map_choropleth and map_bubble may be used ONLY with a category column marked "places"');
  ok('facts: a map is allowed only on a places column', rule > 0);
  ok('facts: …said under the chart types and above the request', rule > facts.indexOf('Chart types you may use') && rule < facts.indexOf('<<<USER REQUEST'));
  ok('facts: the signal is a level, never a value', !STATES.concat(NATIONS, REGIONS).some((v) => facts.includes(v)));
  const bare = planFacts.buildFactsText({ ...CTX, datasets: [{ ...CTX.datasets[0], geoHits: undefined }] });
  ok('facts: no signal, no mark (negative control)', !bare.includes('— places:'));
}

// ── §3 The reply ────────────────────────────────────────────────────────────
function checkSuggest(): void {
  const enc = { category: 'US State', values: [{ column: 'Population 2024', aggregation: 'sum' as const }] };
  const reply = (labels: unknown[]) => ({ ok: true as const, data: { labels, series: [{ name: 'sum of Population 2024', values: labels.map(() => 1) }] }, recommendedShape: 'categorical', warnings: [] });

  const states = reply(STATES);
  const out = geoHits.withGeoSuggest(states, enc) as typeof states & { geoSuggest?: unknown };
  ok('the 50 state names suggest us_state', same(out.geoSuggest, { level: 'us_state' }), JSON.stringify(out.geoSuggest));
  ok('…and the reply is otherwise the same reply', out.data === states.data && same({ ...out, geoSuggest: undefined }, { ...states, geoSuggest: undefined }));
  ok('the top-50 bucket\'s "Other" does not hide them', same((geoHits.withGeoSuggest(reply([...STATES, 'Other']), enc) as any).geoSuggest, { level: 'us_state' }));
  ok('country names suggest country', same((geoHits.withGeoSuggest(reply(NATIONS), enc) as any).geoSuggest, { level: 'country' }));
  ok('a raw chart\'s one-label-per-row reply still resolves', same((geoHits.withGeoSuggest(reply(Array.from({ length: 5000 }, (_, i) => STATES[i % 50])), enc) as any).geoSuggest, { level: 'us_state' }));

  const plain = reply(REGIONS);
  ok('East / West / Central suggest nothing — the reply comes back untouched', geoHits.withGeoSuggest(plain, enc) === plain);
  ok('an encoding that names its regions is not second-guessed', geoHits.withGeoSuggest(states, { ...enc, geo: { level: 'country' } }) === states);
  const failed = { ok: false as const, error: 'Dataset not found' };
  ok('a failed reply is passed through', geoHits.withGeoSuggest(failed, enc) === failed);
  const live = { ...states, asOf: { at: '2026-10-12T00:00:00Z', mode: 'live' as const } };
  ok('a Live dataset\'s answer suggests nothing — the warehouse path refuses every map', geoHits.withGeoSuggest(live, enc) === live);
  const grid = { ok: true as const, data: { facets: [] }, recommendedShape: 'categorical', warnings: [] };
  ok('a reply with no labels is passed through', geoHits.withGeoSuggest(grid, enc) === grid);
}

// ── §4 On real disk, through the shipped doors ──────────────────────────────
async function checkDoors(): Promise<void> {
  const realGetDataset = datasets.getDataset;
  let hydrations = 0;
  (datasets as any).getDataset = async (...args: any[]): Promise<any> => {
    hydrations += 1;
    return (realGetDataset as any)(...args);
  };

  const p = await projects.createProject('Maps');
  if (!p) throw new Error('createProject failed');
  const ds = await datasets.saveDataset(p.id, { name: 'States', sourceKind: 'csv', columns: COLS, rows: ROWS });
  if (!ds) throw new Error('saveDataset failed');
  ok('the fixture dataset is resident (Parquet-backed)', (await datasets.getDatasetMeta(p.id, ds.id))?.resident === true);

  hydrations = 0;
  const ctx = await plan.loadPlanContext(p.id);
  const hits = ctx.datasets[0].geoHits || {};
  ok('loadPlanContext resolves the states column', hits['US State']?.level === 'us_state' && hits['US State']?.hitRate === 1, JSON.stringify(hits));
  ok('…and the countries column, and not the regions one', hits.Nation?.level === 'country' && !('Region' in hits));
  ok('…carrying a level and a hit rate, never a value', same(Object.keys(hits['US State'] || {}).sort(), ['hitRate', 'level']));
  ok('…without hydrating the table', hydrations === 0, String(hydrations));
  ok('facts: the mark rides on a summarised column line too',
     planFacts.buildFactsText(ctx).split('\n').includes('    - US State (text): 50 distinct, 50 non-empty — places: US states'), planFacts.buildFactsText(ctx));

  // Draft → build → draw: the map the user was promised.
  const built = await planBuild.buildPlan(p.id, { name: 'Population', sheets: [{ name: 'Overview', visuals: [viz('map_choropleth', 'US State'), viz('map_choropleth', 'Region')] }] });
  ok('build: succeeded, with the non-place map reported', built.ok === true && built.dropped.length === 1, JSON.stringify(built));
  if (!built.ok) return;
  const saved = await visuals.getVisual(p.id, built.visualIds[0]);
  ok('build: the saved map names its regions', built.visualIds.length === 1 && same(saved?.encoding.geo, { level: 'us_state' }), JSON.stringify(saved?.encoding));
  const data = handlers.get('visual:data')!;
  const drawn = await data(null, { projectId: p.id, datasetId: ds.id, encoding: saved?.encoding, filters: [] });
  ok('draw: `visual:data` returns all 50 regions for it — never "Nothing to map"', drawn.ok === true && drawn.data.geo?.level === 'us_state' && drawn.data.geo.items.length === 50, JSON.stringify(drawn).slice(0, 200));
  ok('draw: a reply that is already a map suggests nothing', !('geoSuggest' in drawn));

  // The builder: no geo chosen yet.
  const ask = (category: string) => ({ projectId: p.id, datasetId: ds.id, encoding: { category, values: POP }, filters: [] });
  hydrations = 0;
  const suggested = await data(null, ask('US State'));
  ok('visual:data suggests us_state for the states column', suggested.ok === true && same(suggested.geoSuggest, { level: 'us_state' }), JSON.stringify(suggested).slice(0, 200));
  ok('…from the labels it already had: nothing hydrated', hydrations === 0, String(hydrations));
  ok('…and is still the plain chart it was asked for', suggested.data.geo === undefined && suggested.data.labels.length === 50);
  const preview = await handlers.get('visual:preview')!(null, ask('US State'));
  ok('visual:preview (the builder\'s own channel) suggests it too', same(preview.geoSuggest, { level: 'us_state' }));
  ok('visual:data suggests country for the countries column', same((await data(null, ask('Nation'))).geoSuggest, { level: 'country' }));
  const none = await data(null, ask('Region'));
  ok('visual:data suggests nothing for East / West / Central (negative control)', none.ok === true && !('geoSuggest' in none));
  const batch = await handlers.get('visual:dataBatch')!(null, { projectId: p.id, items: [{ datasetId: ds.id, encoding: { category: 'US State', values: POP }, filters: [] }] });
  ok('visual:dataBatch answers the same', same(batch[0]?.geoSuggest, { level: 'us_state' }));

  // The other doors a chart is made through apply the same rule.
  const made = await creators.checkVisual(p.id, 'States', { name: 'M', chartType: 'map_choropleth', encoding: { category: 'US State', values: POP }, filters: [] });
  ok('automation: a map spec with no geo gets its level', same(made.encoding.geo, { level: 'us_state' }));
  const refused = await creators.checkVisual(p.id, 'States', { name: 'M', chartType: 'map_choropleth', encoding: { category: 'Region', values: POP }, filters: [] })
    .then(() => '', (e: Error) => e.message);
  ok('automation: …or a refusal that says why', refused.includes('a map needs a column of places') && refused.includes('"Region"'), refused);
  const dctx = { pages: [{ name: 'Overview', tileCount: 1 }], tiles: [], datasets: ctx.datasets };
  const add = (category: string) => delta.validateDelta({ ops: [{ op: 'addTile', dataset: 'States', name: 'M', chartType: 'map_choropleth', encoding: { category, values: POP } }] }, dctx);
  const added = add('US State').ops[0] as { encoding?: { geo?: unknown } } | undefined;
  ok('dashboard edit: an added map gets its level', same(added?.encoding?.geo, { level: 'us_state' }), JSON.stringify(add('US State')));
  ok('dashboard edit: …or is dropped and reported', add('Region').ops.length === 0 && (add('Region').dropped[0]?.message || '').includes('a map needs a column of places'));
  const tile = { cardId: 'c1', pageIndex: 0, type: 'visual' as const, title: 'Population', datasetId: ctx.datasets[0].id, chartType: 'map_choropleth' };
  const swapped = delta.validateDelta({ ops: [{ op: 'replaceTileEncoding', tile: 'Population', encoding: { category: 'Nation', values: POP } }] }, { ...dctx, tiles: [tile] });
  ok('dashboard edit: a map tile re-encoded onto another places column follows it', same((swapped.ops[0] as { encoding?: { geo?: unknown } } | undefined)?.encoding?.geo, { level: 'country' }), JSON.stringify(swapped));

  await analysisStore.deleteAnalysis(p.id, built.analysis.id);
  (datasets as any).getDataset = realGetDataset;
}

(async () => {
  for (const mod of ['../src/ipc/visuals', '../src/ipc/vizSample']) (require(mod) as { register: () => void }).register();
  await projects.init();
  await datasets.init();
  await visuals.init();
  await analysisStore.init();
  checkPlanRule();
  checkFacts();
  checkSuggest();
  await checkDoors();
  finish();
})().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});
