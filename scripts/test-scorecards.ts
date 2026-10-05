// Scorecards — the model, the period windows, the statuses, and the whole
// compute path end to end against a real (temporary) project store.
//
//   1. model       sanitize, period windows (weeks, months, fiscal quarters and
//                  years, leap days), status both directions, change, roll-up
//   2. compute     computeScorecard over a fixture whose monthly figures are
//                  written out below — values, targets, attainment, status,
//                  change, sparklines, the anchor, stepping back, an undated
//                  metric, a missing one, a target that is another metric
//   3. detail      24-period history, the target and forecast overlays, the
//                  breakdown by the top dimension
//   4. facts       buildFacts for an open scorecard: "what's off track?" is in
//                  the text, and every printed figure is in the ledger
//   5. records     CRUD, duplicate, the bundle whitelist
//
//   npm run build:ts && node scripts/test-scorecards.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-scorecards-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const model: typeof import('../src/analysis/scorecardModel') = require('../src/analysis/scorecardModel');
const store: typeof import('../src/analysis/scorecards') = require('../src/analysis/scorecards');
const ipc: typeof import('../src/ipc/scorecards') = require('../src/ipc/scorecards');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const copilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');

const close = (a: unknown, b: number, eps = 1e-9): boolean => typeof a === 'number' && Math.abs(a - b) <= eps;
const CAL = { weekStart: 1, fiscalYearStart: 1 };
const FY7 = { weekStart: 1, fiscalYearStart: 7 };
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── 1. model ─────────────────────────────────────────────────────────────────

function modelChecks(): void {
  const rows = model.sanitizeRows([
    { metricId: U(1), target: 1000, owner: '  Ana  ', group: 'Sales', thresholds: { good: 95, warn: 80 } },
    { metricId: U(2), target: { metricId: U(3) } },
    { metricId: 'nope' },                                   // no metric → dropped
    { metricId: U(4), target: 'x', thresholds: { good: 5000, warn: 1 } }, // bad target / thresholds dropped
  ]);
  ok('sanitize: rows without a metric are dropped', rows.length === 3);
  ok('sanitize: owner trimmed, target and thresholds kept',
    rows[0].owner === 'Ana' && rows[0].target === 1000 && rows[0].thresholds?.good === 95);
  ok('sanitize: a target may be another metric', JSON.stringify(rows[1].target) === JSON.stringify({ metricId: U(3) }));
  ok('sanitize: an unusable target or threshold is dropped, not guessed', rows[2].target === undefined && rows[2].thresholds === undefined);
  ok('sanitize: capped at 60 rows', model.sanitizeRows(Array.from({ length: 80 }, (_, i) => ({ metricId: U(i + 1) }))).length === 60);

  const m = model.periodWindow('2024-03-15', 'month', 0, CAL);
  ok('month: the calendar month holding the anchor', m?.from === '2024-03-01' && m?.to === '2024-03-31' && m?.label === 'Mar 2024');
  ok('month: three back crosses the year', model.periodWindow('2024-03-15', 'month', 3, CAL)?.label === 'Dec 2023');
  ok('month: a negative offset is the next period (a forecast axis)', model.periodWindow('2024-03-15', 'month', -1, CAL)?.label === 'Apr 2024');
  ok('month: February of a leap year ends on the 29th', model.periodWindow('2024-02-10', 'month', 0, CAL)?.to === '2024-02-29');
  const w = model.periodWindow('2024-03-14', 'week', 0, CAL); // a Thursday
  ok('week: Monday start', w?.from === '2024-03-11' && w?.to === '2024-03-17' && w?.label === 'Week of Mar 11, 2024');
  ok('week: Sunday start honours the calendar', model.periodWindow('2024-03-14', 'week', 0, { weekStart: 0, fiscalYearStart: 1 })?.from === '2024-03-10');
  ok('week: one back', model.periodWindow('2024-03-14', 'week', 1, CAL)?.from === '2024-03-04');
  const q = model.periodWindow('2024-05-20', 'quarter', 0, CAL);
  ok('quarter: calendar Q2', q?.from === '2024-04-01' && q?.to === '2024-06-30' && q?.label === 'Q2 2024');
  // FY starting July: FY2024 = Jul 2023 – Jun 2024; May is in its fourth quarter.
  const fq = model.periodWindow('2024-05-20', 'quarter', 0, FY7);
  ok('quarter: fiscal (July) Q4 FY2024', fq?.from === '2024-04-01' && fq?.to === '2024-06-30' && fq?.label === 'Q4 FY2024');
  ok('quarter: fiscal one back is Q3', model.periodWindow('2024-05-20', 'quarter', 1, FY7)?.label === 'Q3 FY2024');
  ok('quarter: fiscal Q1 of the next year', model.periodWindow('2024-08-02', 'quarter', 0, FY7)?.label === 'Q1 FY2025');
  ok('year: calendar', model.periodWindow('2024-05-20', 'year', 0, CAL)?.label === '2024');
  const fy = model.periodWindow('2024-05-20', 'year', 0, FY7);
  ok('year: fiscal July–June, named for the year it ends', fy?.from === '2023-07-01' && fy?.to === '2024-06-30' && fy?.label === 'FY2024');
  ok('window: not a date → null', model.periodWindow('soon', 'month', 0, CAL) === null);

  const st = (v: number | null, t: number | null, th?: any, d?: any) => model.rowStatus(v, t, th, d).status;
  ok('status: at target is on track', st(100, 100) === 'good');
  ok('status: 90% is at risk, 89% off track (defaults)', st(90, 100) === 'warn' && st(89, 100) === 'off');
  ok('status: down-is-good flips — under target is on track', st(95, 100, undefined, 'down_good') === 'good');
  ok('status: down-is-good — 105% at risk, 111% off track', st(105, 100, undefined, 'down_good') === 'warn' && st(111, 100, undefined, 'down_good') === 'off');
  ok('status: custom thresholds', st(90, 100, { good: 85, warn: 70 }) === 'good' && st(60, 100, { good: 85, warn: 70 }) === 'off');
  ok('status: no target, a zero target or no value is "none"', st(5, null) === 'none' && st(5, 0) === 'none' && st(null, 10) === 'none');
  ok('attainment: value ÷ target × 100', close(model.rowStatus(45, 60, undefined).attainment, 75));

  const c = model.periodChange(120, 100, 'down_good');
  ok('change: +20 (20%), bad news for a cost', c.delta === 20 && close(c.pct, 20) && c.tone === 'bad');
  ok('change: up for an up-is-good metric is good', model.periodChange(120, 100, 'up_good').tone === 'good');
  ok('change: no direction is neutral, no change is flat', model.periodChange(120, 100).tone === 'neutral' && model.periodChange(5, 5).tone === 'flat');
  ok('change: a zero base has no percent', model.periodChange(5, 0).pct === null);
  ok('change: a missing side has no change', model.periodChange(null, 5).delta === null);

  const roll = model.rollupGroups([
    { group: 'Sales', status: 'good' }, { group: 'Sales', status: 'off' }, { status: 'none' }, { group: 'Sales', status: 'none' },
  ]);
  ok('roll-up: groups in first-seen order, on track of those with a target',
    roll.length === 2 && roll[0].group === 'Sales' && roll[0].onTrack === 1 && roll[0].scored === 2 && roll[0].total === 3 && roll[1].group === '');
}

// ── 2–5. the store, compute, detail, facts ───────────────────────────────────

async function storeChecks(): Promise<void> {
  const project = await projects.createProject('Scorecard test');
  const pid = project.id;

  // Six months × two regions. Revenue: East 100·m, West 50·m → 150·m a month.
  // Cost: 10·m per row → 20·m a month. The last row is 2024-06-15.
  const rows: (string | number)[][] = [];
  for (let m = 1; m <= 6; m++) {
    const day = `2024-0${m}-15`;
    rows.push([day, 'East', 100 * m, 10 * m]);
    rows.push([day, 'West', 50 * m, 10 * m]);
  }
  const ds = await datasets.saveDataset(pid, {
    name: 'Sales', sourceKind: 'csv',
    columns: [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'cost', type: 'number' }] as any,
    rows,
  });
  const teams = await datasets.saveDataset(pid, {
    name: 'Teams', sourceKind: 'csv',
    columns: [{ name: 'team', type: 'text' }, { name: 'heads', type: 'number' }] as any,
    rows: [['A', 4], ['B', 3]],
  });
  ok('fixture datasets saved', !!ds && !!teams);
  if (!ds || !teams) return;
  const mk = (name: string, datasetId: string, column: string, direction?: string) =>
    metrics.saveMetric(pid, { name, datasetId, definition: { column, aggregation: 'sum' }, direction } as any);
  const revenue = await mk('Revenue', ds.id, 'revenue', 'up_good');
  const cost = await mk('Cost', ds.id, 'cost', 'down_good');
  const heads = await mk('Heads', teams.id, 'heads');
  const costBudget = await mk('Cost budget', ds.id, 'revenue'); // a target that is another metric
  ok('fixture metrics saved', !!revenue && !!cost && !!heads && !!costBudget);
  if (!revenue || !cost || !heads || !costBudget) return;

  const sc = await store.saveScorecard(pid, {
    name: 'Monthly', period: 'month',
    rows: [
      { metricId: revenue.id, target: 1000, group: 'Sales', owner: 'Ana' },
      { metricId: revenue.id, target: 1000, group: 'Sales', thresholds: { good: 85, warn: 70 } },
      { metricId: cost.id, target: 100, group: 'Ops', owner: 'Bo' },
      { metricId: cost.id, target: { metricId: costBudget.id }, group: 'Ops' },
      { metricId: heads.id, target: 10 },
      { metricId: U(999) },
    ],
  });
  ok('scorecard saved with its rows sanitized', !!sc && sc.rows.length === 6);
  if (!sc) return;

  const res = await ipc.computeScorecard(pid, sc, 0);
  ok('anchor: the latest dated row across the metrics\' datasets', res.anchor === '2024-06-15', res.anchor);
  ok('window: June 2024', res.window.label === 'Jun 2024' && res.window.from === '2024-06-01' && res.window.to === '2024-06-30');
  const [rev, revLoose, cst, cstVsMetric, hd, missing] = res.rows;
  // June revenue 150·6 = 900 vs 1000 → 90% → at risk; May 750 → +150 (+20%)
  ok('revenue: 900 vs 1000, 90%, at risk', rev.value === 900 && rev.target === 1000 && close(rev.attainment, 90) && rev.status === 'warn');
  ok('revenue: +150 on May (+20%), good news', rev.previous === 750 && rev.delta === 150 && close(rev.pct, 20) && rev.tone === 'good');
  ok('revenue: twelve-period sparkline, empty before the data starts',
    JSON.stringify(rev.spark) === JSON.stringify([null, null, null, null, null, null, 150, 300, 450, 600, 750, 900])
    && rev.sparkLabels[0] === 'Jul 2023' && rev.sparkLabels[11] === 'Jun 2024');
  ok('revenue: owner and group carried', rev.owner === 'Ana' && rev.group === 'Sales');
  ok('custom thresholds: the same 90% is on track at good ≥ 85', revLoose.status === 'good');
  // June cost 20·6 = 120 vs 100 → 120% → off track for a down-is-good metric; +20 is bad news.
  ok('cost: 120 vs 100 is off track (down is good)', cst.value === 120 && close(cst.attainment, 120) && cst.status === 'off' && cst.tone === 'bad');
  // Target = the "Cost budget" metric over June = revenue 900 → 120 / 900 = 13.3% → on track.
  ok('a metric target is resolved over the same period', cstVsMetric.target === 900 && cstVsMetric.status === 'good' && cstVsMetric.targetName === 'Cost budget');
  ok('an undated metric reads all-time, with no history (7 vs 10 → off track)', hd.undated === true && hd.value === 7 && hd.spark.length === 0 && hd.previous === null && hd.status === 'off');
  ok('a deleted metric is a row that says so', missing.missing === true && missing.status === 'none');
  const sales = res.groups.find((g) => g.group === 'Sales');
  const ops = res.groups.find((g) => g.group === 'Ops');
  ok('roll-up: Sales 1 of 2 on track, Ops 1 of 2', !!sales && sales.onTrack === 1 && sales.scored === 2 && !!ops && ops.onTrack === 1 && ops.scored === 2);

  const back = await ipc.computeScorecard(pid, sc, 1);
  // May: revenue 750 → 75% → off; cost 100 → 100% → on track.
  ok('stepping back: May 2024, recomputed', back.window.label === 'May 2024' && back.rows[0].value === 750 && back.rows[0].status === 'off'
    && back.rows[2].value === 100 && back.rows[2].status === 'good');

  const q = await ipc.computeScorecard(pid, { ...sc, period: 'quarter' }, 0);
  // Q2 = Apr+May+Jun revenue = 600+750+900 = 2250; Q1 = 150+300+450 = 900
  ok('quarterly: Q2 2024 = 2,250, Q1 = 900', q.window.label === 'Q2 2024' && q.rows[0].value === 2250 && q.rows[0].previous === 900);

  const det = await ipc.scorecardDetail(pid, sc, revenue.id, 0);
  ok('detail: 24 periods ending June 2024', det.ok && det.series.labels.length === 24 && det.series.labels[23] === 'Jun 2024'
    && det.series.series[0].values[23] === 900);
  const tgt = det.series.analytics.find((o: any) => o.kind === 'target');
  const fc = det.series.analytics.find((o: any) => o.kind === 'forecast');
  ok('detail: the target line is an Analytics overlay at 1,000', !!tgt && tgt.value === 1000);
  // Six points on a perfect line of +150 → Holt's linear continues it: 1050, 1200, 1350.
  ok('detail: the forecast continues the line into Jul–Sep 2024',
    !!fc && JSON.stringify(fc.forecast.labels) === '["Jul 2024","Aug 2024","Sep 2024"]'
    && close(fc.forecast.values[0], 1050, 1e-6) && close(fc.forecast.values[2], 1350, 1e-6), fc && JSON.stringify(fc.forecast));
  ok('detail: June broken out by the top dimension, largest first',
    det.breakdown && det.breakdown.dimension === 'region' && JSON.stringify(det.breakdown.labels) === '["East","West"]'
    && det.breakdown.values[0] === 600 && det.breakdown.values[1] === 300, JSON.stringify(det.breakdown));

  const facts = await copilot.buildFacts(pid, { kind: 'scorecard', id: sc.id });
  ok('facts: the open scorecard is the context', facts.text.includes('Scorecard: "Monthly"') && facts.text.includes('Jun 2024'));
  ok('facts: "what\'s off track?" is answered from the app\'s own verdicts', facts.text.includes('Off track: "Cost", "Heads".') && facts.text.includes('At risk: "Revenue".'), facts.text);
  ok('facts: the figures are in the ledger', [900, 1000, 120, 100].every((n) => facts.ledger.some((e) => e.value === n)));
  const a = audit.auditNumbers(facts.text, facts.ledger);
  ok('facts: the block passes its own number audit', a.violations.length === 0, JSON.stringify(a.violations));
  const factsBack = await copilot.buildFacts(pid, { kind: 'scorecard', id: sc.id, offset: 1 } as any);
  ok('facts: the period on screen is the one described', factsBack.text.includes('May 2024'));

  const list = await store.listScorecards(pid);
  ok('list: one scorecard with its groups', list.length === 1 && JSON.stringify(list[0].groups) === '["Sales","Ops"]' && list[0].rowCount === 6);
  const upd = await store.updateScorecard(pid, sc.id, { name: 'Renamed', period: 'bogus' });
  ok('update: name changes, an unknown period is refused', upd?.name === 'Renamed' && upd?.period === 'month' && upd?.rows.length === 6);
  const dup = await store.duplicateScorecard(pid, sc.id);
  ok('duplicate: a new id, "(copy)", same rows', !!dup && dup.id !== sc.id && dup.name === 'Renamed (copy)' && dup.rows.length === 6);
  ok('delete', await store.deleteScorecard(pid, dup ? dup.id : ''));
  ok('get: a non-UUID id never touches a path', (await store.getScorecard(pid, '../x')) === null);
  const snap = await ipc.scorecardSnapshot(pid, sc.id);
  ok('snapshot: the publisher seam returns the computed rows', !!snap && snap.rows.length === 6 && snap.rows[0].display !== '');

  // Published to a folder (feat/platform-depth's publisher): one scorecard page.
  const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
  const out = path.join(tmp, 'site');
  const cfg = pub.sanitizePublishConfig({ projectId: pid, dashboardIds: [], storyIds: [], scorecardIds: [sc.id], outDir: out, options: {} });
  ok('publish: a scorecard alone is a publishable site', !('error' in cfg), JSON.stringify(cfg));
  if (!('error' in cfg)) {
    const plan = await pub.planPublish(cfg);
    ok('publish: the plan lists it as a scorecard page', plan.pages.length === 1 && plan.pages[0].kind === 'scorecard' && plan.pages[0].name === 'Renamed');
    const result = await pub.publishSite(cfg);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const file = manifest.pages[0] ? manifest.pages[0].file : '';
    const html = file ? fs.readFileSync(path.join(out, file), 'utf8') : '';
    ok('publish: the site holds the scorecard page and an index', result.files.includes('index.html') && manifest.pages[0].kind === 'scorecard');
    ok('publish: the page carries the rows the app scored, statuses and all',
      /"kind":"scorecard"/.test(html) && /"name":"Revenue"/.test(html) && /"status":"warn"/.test(html) && /"label":"Jun 2024"/.test(html));
  }
  ok('publish: nothing picked is refused', 'error' in pub.sanitizePublishConfig({ projectId: pid, outDir: out }));

  const bundleSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'bundle.ts'), 'utf8');
  ok('bundle: scorecards travel in a project bundle', /\^scorecards\//.test(bundleSrc));
}

void (async () => {
  try {
    modelChecks();
    await storeChecks();
  } catch (e: any) {
    ok('no exception', false, e && e.stack);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp */ }
  }
  finish();
})();
