// Self-check for the Summary card — src/analysis/summaryCard.ts (the wording
// and ranking, pure) and src/ipc/summary.ts (the facts, gathered from the
// modules that compute them) on the REAL sample, seeded through first launch.
//
//   1. templates   every sentence template, exact strings
//   2. ranking     one per kind, insights fill to three, magnitude order, cap
//   3. ledger      a Rewrite's facts audit clean against their own ledger
//   4. sample      selection + ranking + tile links on the bundled dashboard,
//                  each figure the same driversFor / metric call's own
//   5. extras      a failing quality rule and a fired alert join and rank
//   6. filter      a region filter recomputes every figure under it
//   7. outbound    a sensitive column's sentence never leaves the app;
//                  the published site carries the card per combination
//
//   npm run build:ts && node scripts/test-summaryCard.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const REPO = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-summary-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_n: string) => tmp, getAppPath: () => REPO, getVersion: () => '0.0.0-test' },
      ipcMain: { handle: () => {}, on: () => {} }, net: {}, nativeImage: {}, shell: {}, dialog: {},
      BrowserWindow: { getAllWindows: () => [] }, Notification: function () { return { show: () => {} }; },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const S: typeof import('../src/analysis/summaryCard') = require('../src/analysis/summaryCard');
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const summary: typeof import('../src/ipc/summary') = require('../src/ipc/summary');
const drivers: typeof import('../src/ipc/drivers') = require('../src/ipc/drivers');
const dashIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const scope: typeof import('../src/analysis/driverScope') = require('../src/analysis/driverScope');
const qualityRun: typeof import('../src/analysis/qualityRun') = require('../src/analysis/qualityRun');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
const publishData: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const publishSanitize: typeof import('../src/publish/sanitize') = require('../src/publish/sanitize');

type Sentence = import('../src/analysis/summaryCard').SummarySentence;
const texts = (l: Sentence[]): string => l.map((s) => s.text).join(' | ');
const kinds = (l: Sentence[]): string => l.map((s) => s.kind).join(',');
const ranked = (l: Sentence[]): boolean => l.every((s, i) => i === 0 || l[i - 1].magnitude >= s.magnitude);

// ── 1. templates ─────────────────────────────────────────────────────────────

function templateChecks(): void {
  const base = {
    cardId: 'k', metric: 'Revenue', a: 322670.95, b: 288928.58, delta: 33742.37, pct: 11.678,
    aText: '$322.7K', bText: '$288.9K', deltaText: '+$33.7K', aLabel: 'Dec 2024', bLabel: 'Nov 2024', direction: 'up_good' as const,
  };
  const rose = S.kpiSentence(base)!;
  ok('kpi: a rise, exact', rose.text === 'Revenue rose $33.7K (+12%) to $322.7K in Dec 2024, from $288.9K in Nov 2024.', rose.text);
  ok('kpi: up is good → good, magnitude = |pct| as a share', rose.tone === 'good' && Object.is(rose.magnitude, 11.678 / 100));
  const fell = S.kpiSentence({ ...base, metric: 'Cost', a: 28000, b: 29200, delta: -1200, pct: -4.06, aText: '$28K', bText: '$29.2K', deltaText: '−$1.2K', aLabel: 'Q2 2024', bLabel: 'Q1 2024', direction: 'down_good' })!;
  ok('kpi: a fall, exact, with one decimal under 10%', fell.text === 'Cost fell $1.2K (−4.1%) to $28K in Q2 2024, from $29.2K in Q1 2024.', fell.text);
  ok('kpi: a cost falling is good', fell.tone === 'good');
  ok('kpi: a revenue falling is bad', S.kpiSentence({ ...base, delta: -5, pct: -1 })!.tone === 'bad');
  const flat = S.kpiSentence({ ...base, metric: 'Orders', a: 412, b: 412, delta: 0, pct: 0, aText: '412', bText: '412' })!;
  ok('kpi: unchanged, exact', flat.text === 'Orders held at 412 in Dec 2024, unchanged from Nov 2024.' && flat.magnitude === 0 && flat.tone === 'flat', flat.text);
  const fromZero = S.kpiSentence({ ...base, b: 0, delta: 322670.95, pct: null, bText: '$0', deltaText: '+$322.7K' })!;
  ok('kpi: no percent off a zero base', fromZero.text === 'Revenue rose $322.7K to $322.7K in Dec 2024, from $0 in Nov 2024.' && fromZero.magnitude === 1, fromZero.text);
  const level = S.kpiSentence({ ...base, metric: 'Margin %', a: 0.312, b: null, delta: null, pct: null, aText: '31.2%' })!;
  ok('kpi: a level with no second period, exact', level.text === 'Margin % is 31.2%.' && level.magnitude === 0, level.text);
  ok('kpi: no figure → no sentence', S.kpiSentence({ ...base, a: null }) === null);

  const drv = { cardId: 'k', datasetId: 'D', metric: 'Revenue', column: 'state', label: 'Colorado', delta: 13271.19, deltaText: '+$13.3K', share: 39.33, moveShare: 8.01, offsetting: false };
  const d1 = S.driverSentence(drv);
  ok('driver: share of the change, exact', d1.text === 'Colorado (state) drove 39% of the change in Revenue, +$13.3K.' && Object.is(d1.magnitude, 39.33 / 100), d1.text);
  ok('driver: carries the column it quotes', d1.column === 'state' && d1.datasetId === 'D');
  const d2 = S.driverSentence({ ...drv, metric: 'Profit', column: 'region', label: 'West', delta: -2100, deltaText: '−$2.1K', share: 240, moveShare: 31, offsetting: true });
  ok('driver: offsetting members, exact, weighted by all movement', d2.text === 'West (region) moved Profit the most, −$2.1K.' && Object.is(d2.magnitude, 0.31), d2.text);

  const ins = S.insightSentence({ title: 'northeast profit fell 76.1% in 2024-12', facts: { contribution: 0.175, pctChange: -0.76 }, severity: 'warn', datasetId: 'D', column: 'region' }, 'c');
  ok('insight: its own words, capitalised and stopped', ins.text === 'Northeast profit fell 76.1% in 2024-12.' && ins.tone === 'warn', ins.text);
  ok('insight: ranked by rankInsights\' magnitude', ins.magnitude === 0.175 && S.insightMagnitude({ facts: { pctChange: -3 } }) === 1 && S.insightMagnitude({ facts: {} }) === 0);
  ok('insight: a sentence already stopped is not stopped twice', S.insightSentence({ title: 'Ship days is mostly empty.', facts: {}, severity: 'info', datasetId: 'D' }, null).text === 'Ship days is mostly empty.');

  const q = { cardId: null, datasetName: 'Retail orders', signature: 'range(units)', rowCountRule: false, failing: 1234, rowCount: 5000, severity: 'warn' as const };
  ok('quality: failing rows, exact', S.qualitySentence(q).text === 'Quality check "range(units)" is failing on 1,234 rows of Retail orders.');
  ok('quality: one row is a row', S.qualitySentence({ ...q, failing: 1 }).text === 'Quality check "range(units)" is failing on 1 row of Retail orders.');
  ok('quality: row_count, exact', S.qualitySentence({ ...q, signature: 'row_count', rowCountRule: true }).text === 'Quality check "row_count" is failing on Retail orders.');
  ok('quality: magnitude is the share of rows; fail is bad, warn is warn',
    Object.is(S.qualitySentence(q).magnitude, 1234 / 5000) && S.qualitySentence(q).tone === 'warn' && S.qualitySentence({ ...q, severity: 'fail' }).tone === 'bad');

  const al = S.alertSentence({ cardId: null, ruleName: 'Revenue drop', message: 'Revenue fell 12% to 4.1M since the last refresh', value: 4.1e6, previous: 4.66e6, deltaPct: -12 });
  ok('alert: exact, stopped once', al.text === 'Alert “Revenue drop” fired: Revenue fell 12% to 4.1M since the last refresh.' && Object.is(al.magnitude, 0.12), al.text);
  ok('alert: no change figure → full weight', S.alertSentence({ cardId: null, ruleName: 'Low', message: 'x.', value: 1, previous: null, deltaPct: null }).magnitude === 1);

  ok('pctText: signs, decimals, a real minus',
    S.pctText(11.678) === '+12%' && S.pctText(-4.06) === '−4.1%' && S.pctText(5) === '+5%' && S.pctText(0) === '0%' && S.pctText(-250) === '−250%');
}

// ── 2. ranking ───────────────────────────────────────────────────────────────

function rankingChecks(): void {
  const s = (kind: Sentence['kind'], magnitude: number, text: string = kind): Sentence => ({ kind, text, magnitude, tone: 'info', cardId: null, figures: [] });
  const all = S.composeSummary({ kpi: s('kpi', 0.1), driver: s('driver', 0.4), insights: [s('insight', 0.2, 'i1'), s('insight', 0.9, 'i2')], quality: s('quality', 0.05), alert: s('alert', 1) });
  ok('ranking: one per kind, by magnitude, the top insight only', kinds(all) === 'alert,driver,insight,kpi,quality' && texts(all).includes('i1') && !texts(all).includes('i2'), kinds(all));
  const thin = S.composeSummary({ kpi: s('kpi', 0.1), driver: null, insights: [s('insight', 0.2, 'i1'), s('insight', 0.3, 'i2'), s('insight', 0.5, 'i3')], quality: null, alert: null });
  ok('ranking: further insights fill to three, no more', thin.length === S.MIN_SENTENCES && texts(thin) === 'i2 | i1 | kpi', texts(thin));
  const tie = S.composeSummary({ kpi: s('kpi', 0.5), driver: s('driver', 0.5), insights: [], quality: s('quality', 0.5), alert: null });
  ok('ranking: ties keep the kind order', kinds(tie) === 'kpi,driver,quality');
  ok('ranking: nothing in, nothing out', S.composeSummary({ kpi: null, driver: null, insights: [], quality: null, alert: null }).length === 0);
}

// ── 3. the Rewrite's ledger ──────────────────────────────────────────────────

function ledgerChecks(list: Sentence[]): void {
  const facts = S.summaryFacts('Retail overview', list);
  ok('ledger: the facts block audits clean against its own ledger', audit.auditNumbers(facts.text, facts.ledger).ok);
  ok('ledger: a prose restatement of the sentences audits clean', audit.auditNumbers(list.map((x) => x.text).join(' '), facts.ledger).ok);
  ok('ledger: a figure the app did not compute is caught', !audit.auditNumbers('Revenue rose 47.3% to $901.2K.', facts.ledger).ok);
}

// ── 4–7. on the sample ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  templateChecks();
  rankingChecks();

  const seeded = await sample.seedSampleProject();
  const pid = seeded.projectId!;
  const a = (await analysis.getAnalysis(pid, seeded.analysisId!))!;
  const ds = (await datasets.listDatasets(pid))[0];
  const cards = a.sheets[0].cards;
  const revenueCard = cards.find((c) => c.type === 'metric' && c.metric!.column === 'revenue')!;
  const unitsCard = cards.find((c) => c.type === 'metric' && c.metric!.column === 'units')!;
  const none = { filters: [], params: new Map() };

  // The card itself: a type the whitelist keeps, carrying nothing.
  const kept = dashboards.sanitizeCard({ type: 'summary', layout: { x: 0, y: 0, w: 12, h: 4 }, sentences: ['<b>x</b>'] });
  ok('a summary card survives the whitelist, and stores nothing', !!kept && kept.type === 'summary' && !('sentences' in kept));

  const base = await summary.computeSummary(pid, a.sheets, none);
  ok('sample: three sentences — the KPI, its contributor, the top insight', base.length === 3 && new Set(base.map((x) => x.kind)).size === 3
    && ['kpi', 'driver', 'insight'].every((k) => base.some((x) => x.kind === k)), kinds(base));
  ok('sample: ranked by magnitude', ranked(base), base.map((x) => x.magnitude).join());
  ok('sample: ranking pinned (driver, insight, kpi)', kinds(base) === 'driver,insight,kpi', kinds(base));
  const kpi = base.find((x) => x.kind === 'kpi')!;
  ok('sample: the headline is the first KPI card — Revenue, Dec 2024 against Nov 2024',
    kpi.text === 'Revenue rose $33.7K (+12%) to $322.7K in Dec 2024, from $288.9K in Nov 2024.', kpi.text);
  ok('sample: the KPI and its contributor link to the Revenue card',
    kpi.cardId === revenueCard.id && base.find((x) => x.kind === 'driver')!.cardId === revenueCard.id);
  const insight = base.find((x) => x.kind === 'insight')!;
  const tileIds = new Set(cards.map((c) => c.id));
  ok('sample: the insight links to a tile on the sheet', !!insight.cardId && tileIds.has(insight.cardId), String(insight.cardId));

  // Every figure is the drivers call's own: the same spec, the same answer.
  const spec = scope.sanitizeDriversSpec({ datasetId: ds.id, metric: { metricId: revenueCard.metric!.metricId, column: 'revenue', aggregation: 'sum', label: revenueCard.metric!.label }, compare: { mode: 'latest', column: 'order_date' }, path: [] }, [])!;
  const r = await drivers.driversFor(pid, spec);
  ok('sample: the KPI sentence is driversFor\'s figures, verbatim', r.ok && kpi.figures.some((f) => Object.is(f.value, r.totals.a)) && kpi.figures.some((f) => Object.is(f.value, r.totals.delta)));
  const dec = await dashIpc.computeCardMetric(pid, ds.id, { column: 'revenue', aggregation: 'sum' }, [{ type: 'filter', column: 'order_date', op: 'contains', value: '2024-12' } as any]);
  ok('sample: …which is the KPI card\'s own figure for the latest month', dec.ok && Object.is(kpi.figures[0].value, dec.value), `${kpi.figures[0].value} vs ${dec.value}`);
  ledgerChecks(base);

  // ── 5. a failing quality rule and a fired alert join ──
  qualityRun.setAlertSinkForTest(null);
  const rule = await qualityRun.saveRule(pid, ds.id, { kind: 'range', column: 'units', args: { min: 1, max: 5 }, severity: 'warn' });
  ok('extras: a range rule saved and run', rule.ok);
  const evId = '11111111-2222-4333-8444-555555555555';
  await alertStore.recordEvents(pid, [
    { id: evId, ruleId: '11111111-2222-4333-8444-666666666666', ruleName: 'Revenue watch', datasetId: ds.id, at: new Date().toISOString(),
      value: 322670.95, previous: 288928.58, delta: 33742.37, deltaPct: 11.678, message: 'Revenue rose 11.7% to 322.7K since the last refresh.', seen: false },
    { id: '11111111-2222-4333-8444-777777777777', ruleId: '11111111-2222-4333-8444-888888888888', ruleName: 'Data quality', datasetId: ds.id, at: new Date().toISOString(),
      value: 3, previous: null, delta: null, deltaPct: null, message: 'Data quality: "x" failing.', seen: false },
  ]);
  const five = await summary.computeSummary(pid, a.sheets, none);
  ok('extras: five sentences, one per kind', five.length === 5 && new Set(five.map((x) => x.kind)).size === 5, kinds(five));
  ok('extras: still ranked by magnitude', ranked(five), five.map((x) => `${x.kind}:${x.magnitude}`).join());
  const q = five.find((x) => x.kind === 'quality')!;
  const meta = (await datasets.getDatasetMeta(pid, ds.id))!;
  const failing = meta.quality!.latest!.results[0].failing;
  ok('extras: the quality sentence is the stored run\'s count, linked to the Units card',
    q.text === `Quality check "range(units)" is failing on ${failing.toLocaleString('en-US')} rows of Retail orders.` && q.cardId === unitsCard.id, `${q.text} → ${q.cardId}`);
  const al = five.find((x) => x.kind === 'alert')!;
  ok('extras: the alert is the event\'s own message — never the quality one',
    al.text === 'Alert “Revenue watch” fired: Revenue rose 11.7% to 322.7K since the last refresh.', al.text);
  await alertStore.markSeen(pid, evId);
  ok('extras: a seen alert is not repeated', !(await summary.computeSummary(pid, a.sheets, none)).some((x) => x.kind === 'alert'));

  // ── 6. recompute under a filter ──
  const west = [{ type: 'filter', column: 'region', op: '=', value: 'West' }] as any[];
  const filtered = await summary.computeSummary(pid, a.sheets, { filters: west, params: new Map() });
  const fk = filtered.find((x) => x.kind === 'kpi')!;
  const westDec = await dashIpc.computeCardMetric(pid, ds.id, { column: 'revenue', aggregation: 'sum' }, [...west, { type: 'filter', column: 'order_date', op: 'contains', value: '2024-12' }]);
  ok('filter: the KPI recomputes under it', !!fk && fk.text !== kpi.text && westDec.ok && Object.is(fk.figures[0].value, westDec.value), `${fk && fk.text} / ${westDec.value}`);
  const rw = await drivers.driversFor(pid, scope.sanitizeDriversSpec({ ...spec, compare: { mode: 'latest', column: 'order_date' } }, west)!);
  const fd = filtered.find((x) => x.kind === 'driver');
  ok('filter: the contributor is the filtered drivers answer\'s lead',
    rw.ok && !!rw.selected && !!fd && fd.column === rw.selected.column && fd.text.startsWith(`${rw.dimensions[0].lead} (${rw.selected.column})`), fd && fd.text);
  ok('filter: never the region it is filtered to', !!fd && fd.column !== 'region');
  ok('filter: still ranked', ranked(filtered));

  // ── 7. outbound ──
  const lead = base.find((x) => x.kind === 'driver')!;
  await catalog.setColumn(pid, ds.id, lead.column!, { sensitivity: 'personal' });
  const inApp = await summary.computeSummary(pid, a.sheets, none);
  const out = await summary.computeSummary(pid, a.sheets, { ...none, outbound: true });
  ok('outbound: a sentence quoting a sensitive column stays in the app', inApp.some((x) => x.kind === 'driver') && !out.some((x) => x.kind === 'driver'), kinds(out));
  await catalog.setColumn(pid, ds.id, lead.column!, { sensitivity: 'none' });

  const sheets = JSON.parse(JSON.stringify(a.sheets));
  for (const c of sheets[0].cards) c.layout.y += 4;
  sheets[0].cards.unshift({ type: 'summary', layout: { x: 0, y: 0, w: 12, h: 4 } });
  await analysis.updateAnalysis(pid, a.id, { sheets });
  const pub = await publishData.buildDashboard(pid, a.id, 10);
  const card = pub!.sheets[0].cards.find((c) => c.kind === 'summary');
  const expect = await summary.computeSummary(pid, (await analysis.getAnalysis(pid, a.id))!.sheets, { analysisId: a.id, ...none, outbound: true });
  ok('publish: the card publishes its sentences, the same ones', !!card && JSON.stringify((card.payloads[card.variants[0]] as any).sentences) === JSON.stringify(expect.map((x) => x.text)));
  const page = publishSanitize.sanitizePage({ kind: 'dashboard', dashboard: { ...pub, sheets: [{ name: 'S', cards: [{ ...card, payloads: [{ sentences: ['ok', 7, '<x>'], script: 'no' }] }] }] } });
  const sc = (page.dashboard as any).sheets[0].cards[0];
  ok('publish: the whitelist keeps strings only', sc.kind === 'summary' && JSON.stringify(sc.payloads[0]) === JSON.stringify({ sentences: ['ok', '', '<x>'] }), JSON.stringify(sc.payloads[0]));

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
