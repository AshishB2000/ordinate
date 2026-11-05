// `visual:drillDown` (src/ipc/drillDown.ts): a clicked mark → the exact filter steps behind it and the next level's
// encoding, through the shipped handlers. A drill computes no figure: the drilled chart is `visual:data` again.
//
//   shape      region East → by state with one `=` step; a split chart keeps its split; a month → days with the
//              exact range; a Gregorian week → days; the last level, the finest date and a pivot say so
//   refusals   each is the rows panel's own sentence (visual:rows, the same mark); NEGATIVE CONTROL: a column
//              in no hierarchy has its own sentence
//   pinned     an old chart's visual:data and visual:rows replies are byte-identical after a hierarchy is saved
//   walk       for every bar on every level (region › state › city; year › quarter › month › day; and the 4-5-4
//              calendar's year › quarter › period › week › day): the bar is exactly its rows (visual:rows, summed
//              in JS), its drilled chart's children add up to it, and the drill's steps are the rows panel's
//   springfield  a city in two states of one region: drilled under Ohio it is Ohio's rows only; NEGATIVE
//              CONTROL: without the state step the same chart draws a bigger Springfield
//
//   npm run build:ts && node scripts/test-drillDown.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-drilldown-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const msg: typeof import('../src/ipc/drillMessages') = require('../src/ipc/drillMessages');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');

type Any = any; // any: each handler's own reply shape, read field by field below
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
const COLS = [
  { name: 'region', type: 'text' }, { name: 'state', type: 'text' }, { name: 'city', type: 'text' },
  { name: 'category', type: 'text' }, { name: 'sub_category', type: 'text' }, { name: 'order_date', type: 'date' }, { name: 'revenue', type: 'number' },
] as Any;
const PLACES: Array<[string, string, string]> = [
  ['East', 'New York', 'New York City'], ['East', 'New York', 'Albany'], ['East', 'Pennsylvania', 'Philadelphia'], ['East', 'Pennsylvania', 'Springfield'],
  ['East', 'Ohio', 'Columbus'], ['East', 'Ohio', 'Springfield'], ['West', 'California', 'Los Angeles'], ['West', 'California', 'San Diego'],
  ['West', 'Oregon', 'Portland'], ['Central', 'Illinois', 'Chicago'], ['Central', 'Illinois', 'Springfield'], ['Central', 'Texas', 'Houston'], ['Central', 'Texas', 'Austin'],
];
const PRODUCTS: Array<[string, string]> = [['Furniture', 'Chairs'], ['Furniture', 'Tables'], ['Technology', 'Phones'], ['Technology', 'Laptops'], ['Office Supplies', 'Paper'], ['Office Supplies', 'Binders']];
const DAY0 = Date.UTC(2023, 0, 1);
const iso = (n: number): string => new Date(DAY0 + n * 86_400_000).toISOString().slice(0, 10);
/** Whole numbers only, so a JS left-fold and the engine's sum agree to the bit; every place has rows in every month. */
const ROWS = Array.from({ length: 1400 }, (_, i) => [...PLACES[i % PLACES.length], ...PRODUCTS[(i * 7) % PRODUCTS.length], iso((i * 37) % 731), 10 + ((i * 13) % 97)]);

const REV = [{ column: 'revenue', aggregation: 'sum' }];
const BY_REGION = { category: 'region', values: REV };
const BY_REGION_SPLIT = { category: 'region', series: 'category', values: REV };
const BY_CITY = { category: 'city', values: REV };
const BY_CATEGORY = { category: 'category', values: REV };
const BY_MONTH = { category: 'order_date', grain: 'month', values: REV };
const BY_WEEK = { category: 'order_date', grain: 'week', values: REV };
const BY_DAY = { category: 'order_date', grain: 'day', values: REV };
const PIVOT = { ...BY_REGION, pivot: { rows: [{ column: 'region' }], columns: [], values: REV } };

async function main(): Promise<void> {
  for (const m of ['visuals', 'visualsServer', 'tableDocs', 'catalog', 'drillDown']) require(`../src/ipc/${m}`).register();
  const call = (channel: string, args: unknown): Promise<Any> => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`No handler for ${channel}`);
    return h(null, args);
  };
  const P = (await projects.createProject('Drill down')).id;
  const D = (await datasets.saveDataset(P, { name: 'Retail orders', sourceKind: 'csv', columns: COLS, rows: ROWS } as Any))!.id;
  const C = (await datasets.saveDataset(P, { name: 'Regions', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }], rows: [['East'], ['West']] } as Any))!.id;
  const drill = (encoding: unknown, category: unknown, extra: Record<string, unknown> = {}): Promise<Any> => call('visual:drillDown', { projectId: P, datasetId: D, encoding, mark: { category }, ...extra });
  const rows = (encoding: unknown, category: unknown): Promise<Any> => call('visual:rows', { projectId: P, datasetId: D, encoding, filters: [], mark: { category }, page: { offset: 0, limit: 5000 } });

  // ── pinned: an old chart replies as before ───────────────────────────────
  const before = stableStringify([await call('visual:data', { projectId: P, datasetId: D, encoding: BY_REGION }), await rows(BY_REGION, 'East')]);
  const saved = await call('catalog:setTable', { projectId: P, datasetId: D, patch: { hierarchies: [{ name: 'Geography', levels: ['region', 'state', 'city'] }] } });
  ok('fixture: Geography saved through catalog:setTable', saved.ok === true, show(saved));
  const after = stableStringify([await call('visual:data', { projectId: P, datasetId: D, encoding: BY_REGION }), await rows(BY_REGION, 'East')]);
  ok('pinned: an old chart\'s visual:data and visual:rows are byte-identical after a hierarchy is saved', before === after);

  // ── shape ────────────────────────────────────────────────────────────────
  const r = await drill(BY_REGION, 'East');
  ok('region East → by state, one = step', r.ok && r.available && r.encoding.category === 'state' && stableStringify(r.steps) === stableStringify([{ type: 'filter', column: 'region', op: '=', value: 'East' }]) && r.crumb.label === 'East' && r.crumb.next === 'state' && r.crumb.column === 'region', show(r));
  const s = await call('visual:drillDown', { projectId: P, datasetId: D, encoding: BY_REGION_SPLIT, mark: { category: 'East', series: 'Furniture' } });
  ok('a split chart keeps its split and drills its axis', s.available && s.encoding.series === 'category' && s.encoding.category === 'state' && s.steps.length === 1 && s.steps[0].column === 'region', show(s));
  ok('the last level says so', (await drill(BY_CITY, 'Springfield')).reason === msg.drillLastLevel('city', 'Geography'));
  const m = await drill(BY_MONTH, '2024-03');
  ok('a month drills to days, with the exact range', m.available && m.encoding.grain === 'day' && m.steps.length === 1 && m.steps[0].op === 'period' && m.steps[0].period.from === '2024-03-01' && m.steps[0].period.to === '2024-03-31' && m.crumb.label === 'Mar 2024' && m.crumb.next === 'day', show(m));
  ok('a Gregorian week drills to days', (await drill(BY_WEEK, '2024-03-04')).encoding?.grain === 'day');
  ok('a day is the finest', (await drill(BY_DAY, '2024-03-04')).reason === msg.drillFinestDate());
  ok('a pivot does not drill', (await drill(PIVOT, 'East')).reason === msg.drillNotThisChart());
  const text = await drill({ ...BY_REGION, grain: 'month', bins: 5, overlay: 'previous_year' }, 'East');
  ok('a text drill carries no grain, bins or overlay', text.available && !('grain' in text.encoding) && !('bins' in text.encoding) && !('overlay' in text.encoding), show(text));

  // ── refusals: the rows panel's own sentence ──────────────────────────────
  const REFUSALS: Array<[string, unknown, unknown]> = [
    ['blank label', BY_REGION, ''], ['Other', BY_REGION, 'Other'], ['a number axis', { category: 'revenue', values: [{ column: 'region', aggregation: 'count' }] }, '10'],
    ['raw points', { category: 'region', values: [{ column: 'revenue', aggregation: 'none' }] }, 'East'], ['a map', { ...BY_REGION, category: 'state', geo: { level: 'us_state' } }, 'Ohio'],
    ['a related category', { ...BY_REGION, categoryDatasetId: C }, 'East'],
  ];
  for (const [label, enc, mark] of REFUSALS) {
    const [d, p] = [await drill(enc, mark), await rows(enc, mark)];
    ok(`refusal (${label}) is the rows panel's sentence`, d.ok === true && d.available === false && p.available === false && typeof d.reason === 'string' && d.reason === p.reason, show([d, p]));
  }
  ok('NEGATIVE CONTROL: a column in no hierarchy', (await drill(BY_CATEGORY, 'Furniture')).reason === msg.drillNoHierarchy('category'));

  // ── the crumb says the value as people read it; the step keeps the raw value ──
  await call('catalog:setColumn', { projectId: P, datasetId: D, column: 'region', patch: { values: [{ value: 'East', label: 'Eastern region' }] } });
  const lab = await drill(BY_REGION, 'East');
  ok('a labelled value: the crumb reads the label, the step the stored value', lab.available && lab.crumb.label === 'Eastern region' && lab.steps[0].value === 'East', show(lab));
  // ── walk: every bar is its rows, and its children add up to it ─────────────
  const REVENUE = COLS.findIndex((c: Any) => c.name === 'revenue');
  const jsSum = (rs: unknown[][]): number => rs.reduce((n, row) => n + Number(row[REVENUE]), 0);
  const chartOf = (encoding: unknown, filters: unknown[]): Promise<Any> => call('visual:data', { projectId: P, datasetId: D, encoding, filters });
  const rowsUnder = (encoding: unknown, filters: unknown[], category: unknown): Promise<Any> => call('visual:rows', { projectId: P, datasetId: D, encoding, filters, mark: { category }, page: { offset: 0, limit: 5000 } });
  /** Walk every bar from `encoding` down; the levels drawn, and the first problem found. */
  const walk = async (encoding: Any, last: string, levelOfEnc: (e: Any) => string): Promise<{ levels: string[]; bars: number; wrong: string }> => {
    const seen = new Set<string>();
    let bars = 0;
    let wrong = '';
    const down = async (enc: Any, filters: unknown[], path: string): Promise<void> => {
      seen.add(levelOfEnc(enc));
      const chart = await chartOf(enc, filters);
      if (!chart.ok || chart.data.series.length !== 1) { wrong ||= `${path}: the chart did not draw ${show(chart)}`; return; }
      for (let i = 0; i < chart.data.labels.length && !wrong; i += 1) {
        const label = chart.data.labels[i];
        const value = chart.data.series[0].values[i];
        if (value === null) continue;
        bars += 1;
        const here = `${path} › ${label}`;
        const behind = await rowsUnder(enc, filters, label);
        if (!behind.available || !Object.is(jsSum(behind.rows), value)) { wrong = `${here}: the bar is not exactly its rows ${show([value, behind.available && jsSum(behind.rows), behind.reason])}`; return; }
        const r = await drill(enc, label, { filters });
        if (!r.available) { if (r.reason !== last) wrong = `${here}: ${show(r)}`; continue; }
        if (stableStringify(r.steps) !== stableStringify(behind.filters.slice(filters.length))) { wrong = `${here}: the steps are not the rows panel's ${show([r.steps, behind.filters])}`; return; }
        const child = await chartOf(r.encoding, [...filters, ...r.steps]);
        const total = child.ok ? child.data.series[0].values.reduce((n: number, v: number | null) => n + (v ?? 0), 0) : NaN;
        if (!Object.is(total, value)) { wrong = `${here}: the children add up to ${total}, the bar is ${value}`; return; }
        await down(r.encoding, [...filters, ...r.steps], here);
      }
    };
    await down(encoding, [], '');
    return { levels: [...seen], bars, wrong };
  };
  const geo = await walk(BY_REGION, msg.drillLastLevel('city', 'Geography'), (e) => e.category);
  ok('walk (region › state › city): every bar is exactly its rows, its children add up to it, its steps are the rows panel\'s', !geo.wrong && geo.levels.join() === 'region,state,city' && geo.bars > 20, geo.wrong || show(geo));
  const BY_YEAR = { category: 'order_date', grain: 'year', values: REV };
  const greg = await walk(BY_YEAR, msg.drillFinestDate(), (e) => e.grain);
  ok('walk (year › quarter › month › day, Gregorian): the same, on every date step', !greg.wrong && greg.levels.join() === 'year,quarter,month,day' && greg.bars > 700, greg.wrong || show(greg));

  // ── springfield: a child is counted under its whole path ──────────────────
  const east = (await drill(BY_REGION, 'East')).steps;
  const ohio = await drill({ ...BY_REGION, category: 'state' }, 'Ohio', { filters: east });
  const cities = await chartOf(ohio.encoding, [...east, ...ohio.steps]);
  const springOf = (c: Any): number => c.data.series[0].values[c.data.labels.indexOf('Springfield')];
  const ohioRows = ROWS.filter((row) => row[1] === 'Ohio' && row[2] === 'Springfield') as unknown[][];
  ok('springfield: drilled under East › Ohio, Springfield is Ohio\'s rows only', ohio.available && Object.is(springOf(cities), jsSum(ohioRows)) && jsSum(ohioRows) > 0, show([springOf(cities), jsSum(ohioRows)]));
  const loose = await chartOf(ohio.encoding, east);
  ok('NEGATIVE CONTROL: without the state step the same chart draws a bigger Springfield', springOf(loose) > springOf(cities), show([springOf(loose), springOf(cities)]));

  // ── calendar: under 4-5-4 a period holds whole weeks, so period › week › day ──
  dateIntel.setCalendar({ weekStart: 1, fiscalYearStart: 1, calendarType: '454', yearEnd: 'nearest' });
  try {
    const retail = await walk(BY_YEAR, msg.drillFinestDate(), (e) => e.grain);
    ok('walk (4-5-4: year › quarter › period › week › day): the same, on every retail step', !retail.wrong && retail.levels.join() === 'year,quarter,month,week,day' && retail.bars > 800, retail.wrong || show(retail));
  } finally {
    dateIntel.setCalendar({});
  }
  ok('NEGATIVE CONTROL: back on Gregorian, a month drills to days again', (await drill(BY_MONTH, '2024-03')).encoding?.grain === 'day');

  ok('a missing dataset is an error', (await call('visual:drillDown', { projectId: P, datasetId: '00000000-0000-4000-8000-000000000000', encoding: BY_REGION, mark: { category: 'East' } })).ok === false);
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
