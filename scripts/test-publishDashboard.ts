// A published dashboard's shape, built for real over a seeded project (userData in a temp dir):
//   1. a KPI's change line IS the canvas's metric:compare answer (compareMetric), Object.is —
//      signed and formatted on the server, its tone flipped by a down-is-good metric, and absent
//      with no date filter in scope;
//   2. a card's note reaches the page through the whitelist;
//   3. the same control on two sheets publishes ONCE, and saved views still line up with the
//      bar — a view that sets the folded copy apart is left out; a copy whose default filters
//      something else stays its own control (negative control);
//   4. the page's words: the header's takeaway (the first chart's caption in reading order),
//      the figures it sets in bold, a change in percent as the canvas writes it.
//
//   npm run build:ts && node scripts/test-publishDashboard.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID } = require('crypto') as typeof import('crypto');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-pubdash-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const { buildDashboard } = require('../src/publish/dashboardData') as typeof import('../src/publish/dashboardData');
const { sanitizePage } = require('../src/publish/sanitize') as typeof import('../src/publish/sanitize');
const { compareMetric } = require('../src/ipc/periods') as typeof import('../src/ipc/periods');
const format: typeof import('../src/app/format') = require('../src/app/format');
const { formatValue } = format;
const { readAssets } = require('../src/publish/publish') as typeof import('../src/publish/publish');
const vm: typeof import('vm') = require('vm');

const at = (x: number, y: number, w = 3, h = 2) => ({ x, y, w, h });

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Publish shape test');
  const rows: any[][] = []; // any: fixture rows
  // Two years, a month a row per region; 2024's amounts are larger, so its change is up.
  for (const year of [2023, 2024]) for (let m = 1; m <= 12; m++) for (let r = 0; r < 3; r++) {
    rows.push(['region' + r, `${year}-${String(m).padStart(2, '0')}-15`, (year - 2022) * 10 + m + r]);
  }
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }], rows,
  });
  const dsId = ds!.id;
  const v = await visuals.saveVisual(proj.id, { datasetId: dsId, name: 'By region', chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as any); // any: a record literal the saver sanitizes
  const costs = await metricsStore.saveMetric(proj.id, { name: 'Costs', datasetId: dsId, definition: { column: 'amount', aggregation: 'sum' }, direction: 'down_good' } as any); // any: as above
  const year2024 = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-12-31' } }];
  const cmp = { mode: 'previous_year' };
  const kpi = (x: number, metric: object, extra: object = {}) => ({ id: randomUUID(), type: 'metric', layout: at(x, 0), metric: { datasetId: dsId, column: 'amount', aggregation: 'sum', ...metric }, ...extra });
  const sheet = (name: string, cards: object[]) => ({ id: randomUUID(), name, cards });

  // ── 1 + 2. The change line, the note ──────────────────────────────────────────
  const dash = await analysis.saveAnalysis(proj.id, {
    name: 'Changes', filters: year2024,
    sheets: [sheet('Main', [
      kpi(0, { label: 'Total', compare: cmp }, { note: 'All regions,\n  every   month' }),
      kpi(3, { label: 'Costs', metricId: costs!.id, compare: cmp }),
      kpi(6, { label: 'Plain' }),
      { id: randomUUID(), type: 'visual', visualId: v!.id, layout: at(0, 2, 12, 4), note: 'Where the money is' },
    ])],
  } as any); // any: a record literal the saver sanitizes
  const built = await buildDashboard(proj.id, dash!.id, 64);
  const page = sanitizePage({ kind: 'dashboard', site: {}, dashboard: built }) as any; // any: the page's JSON, asserted field by field
  const [total, cost, plain, chart] = page.dashboard.sheets[0].cards;
  const first = (c: any) => c.payloads[c.variants[0]]; // any: a published card
  const direct = await compareMetric(proj.id, { datasetId: dsId, column: 'amount', aggregation: 'sum' }, year2024, cmp, []);
  const shown = first(total).compare;
  ok('compare: the published change IS metric:compare\'s answer — delta, percent, period', typeof direct.delta === 'number' && direct.delta > 0
    && shown.deltaDisplay === '+' + formatValue(Math.abs(direct.delta!), 'auto') && Object.is(shown.pct, direct.pct) && shown.label === direct.label && shown.tone === 'good',
  JSON.stringify([shown, direct]));
  const viaMetric = await compareMetric(proj.id, { metricId: costs!.id }, year2024, cmp, []);
  ok('compare: a down-is-good metric going up is bad news, in the metric\'s own format', first(cost).compare.tone === 'bad'
    && first(cost).compare.deltaDisplay === '+' + viaMetric.deltaDisplay && viaMetric.direction === 'down_good', JSON.stringify([first(cost).compare, viaMetric]));
  ok('compare: a KPI without Compare has no change line', !('compare' in first(plain)));
  ok('note: a KPI\'s and a chart\'s note reach the page, one line', total.note === 'All regions, every month' && chart.note === 'Where the money is' && !('note' in plain), JSON.stringify([total.note, chart.note]));
  const undated = await analysis.saveAnalysis(proj.id, { name: 'Undated', sheets: [sheet('Main', [kpi(0, { label: 'Total', compare: cmp })])] } as any); // any: as above
  const noDate = await buildDashboard(proj.id, undated!.id, 64);
  ok('compare: no date filter in scope → no change line (the canvas says "add a date filter")', !('compare' in (noDate!.sheets[0].cards[0].payloads[0] as object)));

  // ── 3. One control per page ───────────────────────────────────────────────────
  const ctl = (extra: object = {}) => ({ id: randomUUID(), type: 'control', layout: at(0, 0, 3, 1), control: { kind: 'dropdown', label: 'Region', datasetId: dsId, column: 'region', ...extra } });
  const chartCard = () => ({ id: randomUUID(), type: 'visual', visualId: v!.id, layout: at(0, 1, 12, 4) });
  const a = ctl();
  const b = ctl(); // the same control, on the second sheet
  const view = (name: string, controls: object) => ({ id: randomUUID(), name, state: { page: '', controls, params: {}, selection: [], tiles: {}, groupTabs: {} }, createdAt: '', updatedAt: '' });
  const twins = await analysis.saveAnalysis(proj.id, { name: 'Twins', sheets: [sheet('One', [a, chartCard()]), sheet('Two', [b, chartCard()])] } as any); // any: as above
  await analysis.updateAnalysis(proj.id, twins!.id, { views: [view('East', { [a.id]: { value: 'region1' } }), view('Split', { [a.id]: { value: 'region1' }, [b.id]: { value: 'region2' } })] });
  const t = await buildDashboard(proj.id, twins!.id, 64);
  ok('dedupe: the same control on two sheets publishes once', t!.controls.length === 1 && t!.controls[0].id === a.id, JSON.stringify(t!.controls.map((c) => c.label)));
  const east = t!.views.find((x) => x.name === 'East');
  ok('dedupe: a saved view still picks its value on the one control', !!east && t!.controls[0].options[east.picks[0]] === 'region1' && east.picks.length === 1, JSON.stringify(t!.views));
  ok('dedupe: a view that sets the folded copy apart is left out, never shown on the wrong figures (the record holds it)',
    !t!.views.some((x) => x.name === 'Split') && (await analysis.getAnalysis(proj.id, twins!.id))!.views!.some((x) => x.name === 'Split'));
  const pickOf = (label: string) => t!.keys.indexOf(String(t!.controls[0].options.indexOf(label)));
  const answer = (sh: number, label: string) => { const c = t!.sheets[sh].cards[0]; return JSON.stringify(c.payloads[c.variants[pickOf(label)]]); };
  ok('dedupe: the one control filters both sheets', answer(0, 'region1') === answer(1, 'region1') && answer(1, 'region1') !== answer(1, 'All'));
  const apart = await analysis.saveAnalysis(proj.id, {
    name: 'Apart', sheets: [sheet('One', [ctl(), chartCard()]), sheet('Two', [ctl({ default: { value: 'region2' } }), chartCard()])],
  } as any); // any: as above
  const ap = await buildDashboard(proj.id, apart!.id, 64);
  ok('dedupe: …a copy whose default filters something else stays its own control (negative control)',
    ap!.controls.length === 2 && ap!.controls[1].options[ap!.controls[1].defaultIndex] === 'region2', JSON.stringify(ap!.controls));

  // ── 4. The page's words (src/publish/site/publishWords.ts), jsdom-free ─────────
  const ctx: any = { OrdFormat: format }; // any: a bare vm global the core's functions land on; OrdFormat as the page binds it
  vm.createContext(ctx);
  vm.runInContext(readAssets().coreJs, ctx);
  // The header's takeaway: the server's caption of the first CHART in reading order (row, then column), else the first KPI's.
  const said = (kind: string, x: number, y: number, payload: { caption: string; error?: string }) => ({ kind, layout: { x, y }, variants: [0], payloads: [payload] });
  const sheetCards = [said('metric', 0, 0, { caption: 'K' }), said('chart', 6, 2, { caption: 'B' }), said('chart', 0, 2, { caption: 'A' }), said('chart', 0, 1, { error: 'x', caption: 'E' }), said('chart', 3, 1, { caption: ' ' })];
  ok('words: the takeaway is the first chart\'s caption in reading order — an error, a blank or a KPI ahead of it is passed over',
    JSON.stringify(ctx.pkTakeaway(sheetCards, 0)) === '{"at":2,"text":"A"}', JSON.stringify(ctx.pkTakeaway(sheetCards, 0)));
  ok('words: …no chart says anything → the first KPI\'s; nothing at all → none',
    JSON.stringify(ctx.pkTakeaway(sheetCards.filter((c) => c.kind === 'metric' || c.payloads[0].error), 0)) === '{"at":0,"text":"K"}' && ctx.pkTakeaway([], 0) === null);
  const lead = 'Technology leads revenue at $2.1M, 3.4× Furniture; region0 fell −4.1% in 2024 (2,612 orders)';
  const runs = ctx.pkFigureRuns(lead);
  ok('words: the figures in a caption are marked — not a year, not a digit inside a word — and the runs rejoin to the sentence',
    JSON.stringify(runs.filter((r: any) => r.figure).map((r: any) => r.text)) === '["$2.1M","3.4×","−4.1%","2,612"]' && runs.map((r: any) => r.text).join('') === lead, JSON.stringify(runs));
  const pctOf = (v: number) => ctx.pkPct(v, (x: number, d: number) => format.formatNumber(x, { maxDecimals: d }));
  ok('words: a change in percent reads as the canvas writes it', JSON.stringify([18.24, -4.12, 12.6, 0].map(pctOf)) === '["+18%","−4.1%","+13%","0%"]', JSON.stringify([18.24, -4.12, 12.6, 0].map(pctOf)));

  fs.rmSync(tmpUserData, { recursive: true, force: true });
  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
