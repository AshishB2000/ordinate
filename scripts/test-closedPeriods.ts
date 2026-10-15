// "The latest period" is the latest CLOSED period (insightsAgg.periodPlan).
//
//   partial   one full month and five days of the next: the five days are not
//             a month, so no mover card, no change alert, no "latest two
//             periods" for Explain-a-change, and no sparkline point for them
//   full      NEGATIVE CONTROL: two full months compare exactly as before
//   cadence   the rule reads the data's own step: a dataset that skips days,
//             holds weekdays only, or one date a month (the 1st) has closed
//             its last month; a "last 45 days" export has closed neither end
//   twins     resident === JS for every insights list here, Object.is per fact
//   edge      a period-over-period alert fires once per period, not on every
//             evaluation while the same two periods are the latest
//
//   npm run build:ts && node scripts/test-closedPeriods.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-closed-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const insights: typeof import('../src/analysis/insights') = require('../src/analysis/insights');
const alerts: typeof import('../src/analysis/alerts') = require('../src/analysis/alerts');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const drivers: typeof import('../src/ipc/drivers') = require('../src/ipc/drivers');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');

type Cell = import('../src/data/transforms').Cell;
type Insight = import('../src/analysis/insights').Insight;

const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);
const DAY = 86_400_000;

/** Every ISO day from `from` to `to`, inclusive, that `keep` keeps. */
function days(from: string, to: string, keep: (d: Date) => boolean = () => true): string[] {
  const out: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY) {
    if (keep(new Date(t))) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
const weekday = (d: Date): boolean => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

/** Field by field, Object.is on every fact (test-insights.ts's comparison). */
function same(a: Insight[], b: Insight[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x.id !== y.id || x.title !== y.title || x.detail !== y.detail || x.severity !== y.severity) return false;
    const k = Object.keys(x.facts).sort();
    if (k.join() !== Object.keys(y.facts).sort().join()) return false;
    return k.every((f) => Object.is(x.facts[f], y.facts[f]));
  });
}

async function main(): Promise<void> {
  const pid = (await projects.createProject('Closed periods')).id;
  const save = async (name: string, rows: Cell[][], cols = [['day', 'date'], ['region', 'text'], ['revenue', 'number']]) =>
    datasets.saveDataset(pid, { name, sourceKind: 'csv', columns: cols.map(([n, type]) => ({ name: n, type })) as any, rows });

  // PARTIAL: all of January, then Feb 1–5. 20 a day throughout, so the only
  // thing that differs between the "months" is how many days each holds:
  //   Jan 620 (West 310, East 310)   Feb 1–5 100 (West 50, East 50)  → "fell 84%".
  const partialRows: Cell[][] = days('2024-01-01', '2024-02-05').flatMap((d) => [[d, 'West', 10], [d, 'East', 10]]);
  // FULL: all of January and all of February (29 days); West sells 8 a day in Feb.
  //   Jan 620 (West 310, East 310)   Feb 522 (West 232, East 290)  → -15.8%.
  const fullRows: Cell[][] = days('2024-01-01', '2024-02-29').flatMap((d) => [[d, 'West', d < '2024-02' ? 10 : 8], [d, 'East', 10]]);
  const partial = await save('Partial', partialRows);
  const full = await save('Full', fullRows);
  ok('fixtures saved', !!partial && !!full);
  if (!partial || !full) return;

  // ── movers (and the twins) ──────────────────────────────────────────────
  const both = async (id: string): Promise<Insight[]> => {
    const ds = await datasets.getDataset(pid, id);
    const src = await datasets.residentSource(pid, id);
    if (!ds || !src) return [];
    // The period series both halves fold — and that the resident one answered at all.
    const a = insights.jsAgg(ds.columns, ds.rows)('day', 'revenue');
    const b = await insights.residentAgg(src)('day', 'revenue');
    ok(`twins: the resident period series === JS on ${ds.name} (${a ? a.labels.length : 0} days)`, !!a && !!b && a.labels.length > 24
      && a.labels.join() === b.labels.join() && a.values.every((v, i) => Object.is(v, b.values[i])));
    const js = await insights.detectInsights(id, ds.columns, insights.jsAgg(ds.columns, ds.rows));
    const res = await insights.detectInsights(id, src.columns, insights.residentAgg(src));
    ok(`twins: resident === JS on ${ds.name} (${js.length} insights)`, same(js, res), show([js.map((i) => i.id), res.map((i) => i.id)]));
    return js;
  };
  const movers = (list: Insight[]) => list.filter((i) => i.kind === 'mover');
  const pMovers = movers(await both(partial.id));
  ok('partial: five days of February are not compared with all of January — no mover card',
    pMovers.length === 0, show(pMovers.map((m) => m.title)));
  const fMovers = movers(await both(full.id));
  const west = fMovers.find((m) => m.facts.category === 'West');
  ok('full (control): January → February, West 310 → 232, as before',
    !!west && west.facts.fromPeriod === '2024-01' && west.facts.toPeriod === '2024-02'
    && Object.is(west.facts.prev, 310) && Object.is(west.facts.now, 232), show(fMovers.map((m) => m.facts)));

  // ── recentPeriods (alerts, Explain-a-change, the Summary card) ──────────
  const pPeriods = await alertStore.recentPeriods(pid, partial.id, 'day');
  ok('partial: recentPeriods has no second CLOSED period to compare', pPeriods === null, show(pPeriods));
  const fPeriods = await alertStore.recentPeriods(pid, full.id, 'day');
  ok('full (control): recentPeriods is January and February, by month',
    !!fPeriods && fPeriods.keys.join() === '2024-01,2024-02' && fPeriods.op === 'contains', show(fPeriods));

  // ── a "change vs previous period" alert rule ────────────────────────────
  const rule = (datasetId: string, name: string) => ({
    name, datasetId, metric: { column: 'revenue', aggregation: 'sum', label: 'Revenue' }, compare: 'change',
    change: { pct: 10, direction: 'down', vs: 'previous_period', periodColumn: 'day' }, enabled: true,
  });
  const pRule = await alertStore.saveRule(pid, rule(partial.id, 'Partial drop'));
  const fRule = await alertStore.saveRule(pid, rule(full.id, 'Full drop'));
  ok('rules saved', !!pRule && !!fRule);
  if (!pRule || !fRule) return;
  const first = await alertStore.evaluateProject(pid);
  const fired = (list: typeof first, id: string) => list.filter((e) => e.ruleId === id);
  ok('partial: the change rule does not fire on five days of February', fired(first, pRule.id).length === 0, show(fired(first, pRule.id)));
  const tested = await alertStore.testRule(pid, pRule);
  ok('partial: the Test button agrees — would not fire', tested.ok && !tested.fire, show(tested));
  const fEv = fired(first, fRule.id);
  ok('full (control): the change rule fires on January → February, 620 → 522',
    fEv.length === 1 && fEv[0].value === 522 && fEv[0].previous === 620, show(fEv));

  // ── the edge: the same two periods do not fire again ────────────────────
  const second = await alertStore.evaluateProject(pid);
  ok('edge: a second evaluation over the same two periods does not fire again', fired(second, fRule.id).length === 0, show(fired(second, fRule.id)));
  const renamed = await alertStore.saveRule(pid, { ...(await alertStore.load(pid)).rules.find((r) => r.id === fRule.id), name: 'Renamed' });
  ok('edge: renaming the rule keeps that', !!renamed && fired(await alertStore.evaluateProject(pid), fRule.id).length === 0);
  await alertStore.saveRule(pid, { ...(await alertStore.load(pid)).rules.find((r) => r.id === fRule.id), change: { ...rule('', '').change, pct: 12 } });
  ok('edge: changing its condition is a new question, and it fires again', fired(await alertStore.evaluateProject(pid), fRule.id).length === 1);
  {
    // Pure: a NEW latest period fires again; no period (previous_refresh) is unchanged.
    const r = alerts.sanitizeRule({ ...rule(full.id, 'Pure'), id: crypto.randomUUID() })!;
    const ev = (rr: typeof r, period?: string) =>
      alerts.evaluateRule({ rule: rr, value: 80, previous: 100, now: Date.UTC(2024, 2, 1, 12), eventId: crypto.randomUUID(), ...(period ? { period } : {}) } as any);
    const a = ev(r, '2024-02');
    const b = ev(a.rule, '2024-02');
    const c = ev(b.rule, '2024-03');
    ok('edge: fires for 2024-02, not again for 2024-02, again for 2024-03', !!a.event && !b.event && !!c.event);
    const noPeriod = ev(ev(r).rule);
    ok('edge: without a period (the old call) a met change still fires', !!noPeriod.event);
  }

  // ── Explain-a-change "latest" (and so the dashboard Summary card) ───────
  const latest = (id: string) => drivers.driversFor(pid, {
    datasetId: id, metric: { column: 'revenue', aggregation: 'sum' }, compare: { mode: 'latest', column: 'day' },
    path: [], filters: [],
  } as any);
  const pWhy = await latest(partial.id);
  ok('partial: Explain-a-change says there are not two complete periods, not "fell 84%"',
    !pWhy.ok && /complete/.test(pWhy.error), show(pWhy));
  const fWhy = await latest(full.id);
  ok('full (control): Explain-a-change compares February with January',
    fWhy.ok && fWhy.totals.a === 522 && fWhy.totals.b === 620, show(fWhy.ok ? fWhy.totals : fWhy));

  // ── metric sparkline ────────────────────────────────────────────────────
  const metricOn = async (id: string) => metrics.saveMetric(pid, { name: `Revenue ${id.slice(0, 4)}`, datasetId: id, definition: { column: 'revenue', aggregation: 'sum' } } as any);
  const pm = await metricOn(partial.id);
  const fm = await metricOn(full.id);
  const pSeries = pm ? await metricsIpc.resolveMetricSeries(pid, pm.id, 'day') : null;
  ok('partial: the sparkline ends at January — no 100 point reading as a collapse',
    !!pSeries && pSeries.labels.join() === '2024-01' && Object.is(pSeries.values[0], 620), show(pSeries));
  const fSeries = fm ? await metricsIpc.resolveMetricSeries(pid, fm.id, 'day') : null;
  ok('full (control): the sparkline is January and February',
    !!fSeries && fSeries.labels.join() === '2024-01,2024-02' && Object.is(fSeries.values[1], 522), show(fSeries));

  // ── cadence: the data's own step decides, never the wall clock ──────────
  const periodsOf = async (name: string, dates: string[]) => {
    const ds = await save(name, dates.map((d) => [d, 1]), [['day', 'date'], ['v', 'number']]);
    const p = ds ? await alertStore.recentPeriods(pid, ds.id, 'day') : undefined;
    return p === undefined ? 'unsaved' : p === null ? null : p.keys.join();
  };
  const sample = fs.readFileSync(path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv'), 'utf8')
    .trim().split('\n').slice(1).map((l) => l.split(',')[0]);
  const sampleDays = [...new Set(sample)];
  ok('cadence: the bundled sample skips days and ends Dec 30 — December has closed',
    (await periodsOf('Sample dates', sampleDays)) === '2024-11,2024-12');
  const firsts: string[] = [];
  for (let m = 0; m < 30; m += 1) firsts.push(new Date(Date.UTC(2022, m, 1)).toISOString().slice(0, 10));
  ok('cadence: one date a month (the 1st) — every month is closed', (await periodsOf('Monthly', firsts)) === '2024-05,2024-06');
  ok('cadence: weekdays only, ending Friday Mar 29 — March has closed',
    (await periodsOf('Weekdays', days('2024-01-01', '2024-03-29', weekday))) === '2024-02,2024-03');
  ok('cadence: weekdays only, ending Friday Mar 15 — March has not',
    (await periodsOf('Weekdays mid', days('2024-01-01', '2024-03-15', weekday))) === '2024-01,2024-02');
  ok('cadence: a dataset that ends on the 31st has closed its month',
    (await periodsOf('To the 31st', days('2024-01-01', '2024-03-31'))) === '2024-02,2024-03');
  ok('cadence: a "last 45 days" export (Aug 31 – Oct 15) has closed neither end — only September is whole',
    (await periodsOf('Last 45 days', days('2024-08-31', '2024-10-15'))) === null);
  ok('cadence (control): under 24 dates a period is still one day, and the last day is compared',
    (await periodsOf('Twenty days', days('2024-01-01', '2024-01-20'))) === '2024-01-19,2024-01-20');
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
