// A dashboard's Compare on a chart (src/ipc/visualsOverlay.ts
// withCompareSeries) — through the shipped `visual:data` handler.
//
// DIFFERENTIAL throughout: the comparison series is checked against the SAME
// chart asked directly for the comparison period (no compare, the period as
// its filter), label by label with Object.is — and its total against the
// figure a KPI card's Compare reports for the same filters, so a sheet's KPIs
// and charts cannot be comparing two different stretches of time.
//
//   pair       previous period and custom dates: each bar's second value is
//              that category's figure in the comparison period; a category
//              with rows only then is appended; the series names its dates
//   kpi        the comparison series adds up to `metric:compare`'s `previous`
//   dated      a dated axis takes the year-earlier overlay for "last year"
//              and is left whole for the other modes
//   quiet      NEGATIVE CONTROLS: no compare → one series; no date in scope →
//              the chart is not compared with itself; a split chart, two
//              measures and a binned number axis are left as they are
//
//   npm run build:ts && node scripts/test-compareSeries.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-compare-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const periods: typeof import('../src/ipc/periods') = require('../src/ipc/periods');

type Any = any; // any: each handler's own reply shape, read field by field below
const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);

// Two months and the February a year before. "North" sells only in January;
// "Online" only in February. Whole numbers, so every sum is exact.
const ROWS: Array<[string, string, string, number, number]> = [];
const add = (day: string, region: string, channel: string, amount: number, qty: number): void => void ROWS.push([day, region, channel, amount, qty]);
for (let d = 1; d <= 28; d += 1) {
  const dd = String(d).padStart(2, '0');
  add(`2024-01-${dd}`, 'East', 'store', 100 + d, 2);
  add(`2024-01-${dd}`, 'West', 'store', 60 + d, 1);
  if (d % 7 === 0) add(`2024-01-${dd}`, 'North', 'store', 500, 9);
  add(`2024-02-${dd}`, 'East', d % 2 ? 'store' : 'web', 80 + d, 3);
  add(`2024-02-${dd}`, 'West', 'store', 90 + 2 * d, 1);
  if (d % 5 === 0) add(`2024-02-${dd}`, 'Online', 'web', 300, 4);
  add(`2023-02-${dd}`, 'East', 'store', 40 + d, 1);
}
const COLS = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'channel', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'qty', type: 'number' }] as Any;
const period = (from: string, to: string) => ({ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from, to } });
const FEB = [period('2024-02-01', '2024-02-29')];
const JAN = [period('2024-01-01', '2024-01-31')];

async function main(): Promise<void> {
  ipcVisuals.register();
  periods.register();
  const viz = handlers.get('visual:data');
  const kpi = handlers.get('metric:compare');
  ok('the shipped handlers are registered', !!viz && !!kpi);
  if (!viz || !kpi) return;
  const pid = (await projects.createProject('Compare')).id;
  const ds = (await datasets.saveDataset(pid, { name: 'Sales', sourceKind: 'csv', columns: COLS, rows: ROWS } as Any))!.id;
  const chart = (encoding: Record<string, unknown>, filters: unknown[]) => viz(null, { projectId: pid, datasetId: ds, encoding, filters }) as Promise<Any>;
  const byRegion = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
  const pairs = (r: Any, i: number): Map<string, number | null> => new Map(r.data.labels.map((l: unknown, k: number) => [String(l), r.data.series[i].values[k]]));

  // ── pair ────────────────────────────────────────────────────────────────
  const feb = await chart(byRegion, FEB);
  const jan = await chart(byRegion, JAN);
  for (const [name, compare] of [
    ['previous period', { mode: 'previous_period' }],
    ['custom dates', { mode: 'custom', from: '2024-01-01', to: '2024-01-31' }],
  ] as Array<[string, Any]>) {
    // The comparison period is the KPI's own (`prior`), so the reference chart is asked for exactly those dates.
    const k = await kpi(null, { projectId: pid, card: { datasetId: ds, column: 'amount', aggregation: 'sum' }, filters: FEB, compare });
    ok(`kpi (${name}): the KPI names its comparison period`, k.ok && k.prior && k.prior.from === '2024-01-01' && k.prior.to === '2024-01-31', show(k));
    const reference = await chart(byRegion, [period(k.prior.from, k.prior.to)]);
    ok(`pair (${name}): the reference is January's chart`, show(reference.data) === show(jan.data));
    const both = await chart({ ...byRegion, compare }, FEB);
    const now = pairs(both, 0);
    const then = pairs(both, 1);
    const want = pairs(reference, 0);
    const cur = pairs(feb, 0);
    ok(`pair (${name}): two series, the second marked as the comparison`, both.ok && both.data.series.length === 2 && both.data.series[1].role === 'overlay' && both.data.series[0].role !== 'overlay', show(both));
    ok(`pair (${name}): the chart's own figures are untouched`, [...cur].every(([l, v]) => Object.is(now.get(l), v)), show([...now]));
    ok(`pair (${name}): each bar's comparison is that category's figure in the comparison period`, [...want].every(([l, v]) => Object.is(then.get(l), v)) && want.size > 0, show([[...then], [...want]]));
    ok(`pair (${name}): a category with rows only THEN is appended, with no figure now`, then.get('North') === want.get('North') && now.get('North') === null && typeof then.get('North') === 'number');
    ok(`pair (${name}): a category with rows only NOW has no comparison`, typeof now.get('Online') === 'number' && then.get('Online') === null);
    ok(`pair (${name}): the series names its dates`, /Jan/.test(both.data.series[1].name) && both.data.series[1].name.startsWith(both.data.series[0].name + ' · '), both.data.series[1].name);

    // ── kpi ───────────────────────────────────────────────────────────────
    const total = (m: Map<string, number | null>): number => [...m.values()].reduce((n: number, v) => n + (v ?? 0), 0);
    ok(`kpi (${name}): the comparison series adds up to the KPI's "previous", and the chart to its value`, k.ok && Object.is(total(then), k.previous) && Object.is(total(now), k.value), show([total(then), total(now), k]));
  }

  // ── dated ───────────────────────────────────────────────────────────────
  const byDay = { category: 'day', grain: 'month', values: [{ column: 'amount', aggregation: 'sum' }] };
  const overlaid = await chart({ ...byDay, overlay: 'previous_year' }, FEB);
  const yearAgo = await chart({ ...byDay, compare: { mode: 'previous_year' } }, FEB);
  ok('dated: "last year" is the year-earlier overlay, exactly', yearAgo.ok && yearAgo.data.series.length === 2 && show(yearAgo.data) === show(overlaid.data) && yearAgo.overlay?.kind === 'previous_year', show(yearAgo));
  const plainDay = await chart(byDay, FEB);
  const prevDay = await chart({ ...byDay, compare: { mode: 'previous_period' } }, FEB);
  ok('dated: the other modes leave a dated axis whole', prevDay.ok && show(prevDay.data) === show(plainDay.data));

  // ── quiet ───────────────────────────────────────────────────────────────
  ok('NEGATIVE CONTROL: no compare → one series', feb.ok && feb.data.series.length === 1);
  const unscoped = await chart({ ...byRegion, compare: { mode: 'previous_period' } }, []);
  const whole = await chart(byRegion, []);
  ok('NEGATIVE CONTROL: no date in scope → the chart is not compared with itself', unscoped.ok && show(unscoped.data) === show(whole.data));
  const cmp = { mode: 'previous_period' };
  const split = { ...byRegion, series: 'channel' };
  const two = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }, { column: 'qty', aggregation: 'sum' }] };
  const binned = { category: 'amount', values: [{ column: 'qty', aggregation: 'sum' }] };
  for (const [name, enc] of [['a split chart', split], ['two measures', two], ['a binned number axis', binned]] as Array<[string, Record<string, unknown>]>) {
    const a = await chart({ ...enc, compare: cmp }, FEB);
    const b = await chart(enc, FEB);
    ok(`NEGATIVE CONTROL: ${name} is left as it is`, a.ok && b.ok && show(a.data) === show(b.data), show(a));
  }
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
