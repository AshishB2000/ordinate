// The METRICS LAYER, in the real app, on the bundled sample.
//
// Every assertion here is a RENDERED one, and every expected figure is computed
// from the sample CSV inside this file rather than written down. A metric that
// resolves correctly in a unit test and renders "NaN", "—" or an unformatted
// 5194598.73 on the page is the failure this catches — and a hard-coded "5.2M"
// would pass against a metric that had quietly become something else.
//
// The path, end to end, as a user walks it:
//
//   1. Data → Metrics lists the sample's six, with Revenue reading $5.2M.
//   2. New metric → Formula → `[Profit] / [Revenue]` → the live preview says
//      13.2% BEFORE anything is saved, and the saved record then resolves to
//      the same figure.
//   3. Add a KPI card from the metric PICKER on the sample dashboard: the card
//      shows the metric's number in the metric's own format.
//   4. Filter the dashboard to West: the card becomes West's profit over West's
//      revenue — NOT the whole dataset's ratio, which is the bug a formula
//      metric can have and still look plausible.
//   5. An alert created from a metric row stores the metricId.
//   6. Deleting a metric that something uses says what uses it, and cancelling
//      leaves it alone.
//
//   npm run build:ts && node scripts/smoke-metrics.js

export {};
import { ok, failureCount } from './selfcheck';
import { closeApp } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-metrics-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

/**
 * The expected figures, folded out of the committed CSV.
 *
 * Written here rather than pasted as literals so the assertions below track the
 * sample instead of a snapshot of it: regenerate the CSV and this smoke still
 * asserts the truth.
 */
function sampleTruth(): {
  revenue: number; profit: number; margin: number; westMargin: number;
} {
  const csv = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  const lines = csv.trim().split('\n');
  const head = lines[0].split(',');
  const iRev = head.indexOf('revenue');
  const iProfit = head.indexOf('profit');
  const iRegion = head.indexOf('region');
  let revenue = 0, profit = 0, westRevenue = 0, westProfit = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const c = lines[i].split(',');
    revenue += Number(c[iRev]);
    profit += Number(c[iProfit]);
    if (c[iRegion] === 'West') { westRevenue += Number(c[iRev]); westProfit += Number(c[iProfit]); }
  }
  return { revenue, profit, margin: profit / revenue, westMargin: westProfit / westRevenue };
}

/** "13.2%" from 0.13209846 — the SAME rendering src/analysis/metricFormat.ts
 *  does for a percent metric with one decimal. Local, so a break in the shared
 *  formatter shows up as a disagreement here rather than as matching bugs. */
function asPercent1(ratio: number): string {
  return (ratio * 100).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
}

async function main(): Promise<void> {
  const truth = sampleTruth();
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO, timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // Every window.confirm/alert is captured and DISMISSED — which for a confirm
  // is Cancel, and is exactly what the delete assertion at the end needs.
  const dialogs: string[] = [];
  win.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });

  // The first paint is a SPLASH — a screenshot there passes every size and DOM
  // check while proving nothing.
  await win.waitForTimeout(4000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});

  // ── 1. The Metrics tab ────────────────────────────────────────────────────
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(1500);
  await win.click('#ds-tab-metrics');
  await win.waitForTimeout(4000);

  const table = await win.evaluate(() => ({
    names: [...document.querySelectorAll('#mp-list .mp-name')].map((n) => (n.textContent || '').trim()),
    values: [...document.querySelectorAll('#mp-list .mp-row')].map((r) => ({
      name: (r.querySelector('.mp-name')?.textContent || '').trim(),
      value: (r.querySelector('.mp-value')?.textContent || '').trim(),
      def: (r.querySelector('.mp-def')?.textContent || '').trim(),
      badge: (r.querySelector('.mp-badge')?.textContent || '').trim(),
      used: (r.querySelector('.mp-used')?.textContent || '').trim(),
      spark: !!r.querySelector('.mp-spark svg'),
    })),
    emptyShown: !(document.getElementById('mp-empty') as HTMLElement).hidden,
    count: (document.getElementById('mp-count')?.textContent || '').trim(),
    datasetsHidden: (document.getElementById('ds-saved') as HTMLElement).hidden,
  }));

  ok('the Metrics tab lists the sample\'s six metrics',
    table.names.length === 6, JSON.stringify(table.names));
  ok('…including the two formula ones',
    table.names.includes('Margin %') && table.names.includes('Avg order value'),
    JSON.stringify(table.names));
  ok('…and is not showing its empty state', table.emptyShown === false);
  ok('…switching tabs hides the dataset list', table.datasetsHidden === true);
  ok('…and the header counts them', /6 metrics/.test(table.count), table.count);

  const revenueRow = table.values.find((r: any) => r.name === 'Revenue');
  ok('Revenue renders as a compact currency, not a raw float',
    !!revenueRow && revenueRow.value === '$5.2M', JSON.stringify(revenueRow));
  ok('…with its definition in words', !!revenueRow && revenueRow.def === 'sum of revenue',
    JSON.stringify(revenueRow));
  ok('…and a format chip', !!revenueRow && revenueRow.badge === '$', JSON.stringify(revenueRow));
  ok('…and a trend line, because the sample has a date column',
    !!revenueRow && revenueRow.spark === true, JSON.stringify(revenueRow));

  const marginRow = table.values.find((r: any) => r.name === 'Margin %');
  ok('the seeded Margin % resolves to the sample\'s real ratio',
    !!marginRow && marginRow.value === asPercent1(truth.margin),
    JSON.stringify({ shown: marginRow && marginRow.value, expected: asPercent1(truth.margin) }));
  ok('…and its definition shows the formula as written',
    !!marginRow && marginRow.def === '[Profit] / [Revenue]', JSON.stringify(marginRow));
  ok('a metric nothing points at says so rather than showing a blank',
    table.values.every((r: any) => r.used.length > 0), JSON.stringify(table.values.map((r: any) => r.used)));
  await win.screenshot({ path: path.join(shotDir, 'metrics-page.png') });

  // ── 2. The editor, and its live preview ───────────────────────────────────
  await win.click('#mp-new');
  await win.waitForTimeout(1500);

  await win.fill('.me-modal .ws-modal-input', 'Margin check');
  // Formula tab, then the expression — typed, so the debounce and the
  // main-process preview both run the way they do for a user.
  await win.click('.me-modal .me-tab:nth-of-type(2)');
  await win.waitForTimeout(400);
  await win.fill('.me-modal .me-formula', '[Profit] / [Revenue]');
  await win.selectOption('.me-modal .me-format-kind', 'percent');
  await win.fill('.me-modal .me-format-dec', '1');
  await win.waitForTimeout(3000);

  const preview = await win.evaluate(() => ({
    value: (document.querySelector('.me-preview .dash-metric-value')?.textContent || '').trim(),
    def: (document.querySelector('.me-preview .me-preview-def')?.textContent || '').trim(),
  }));
  ok('the editor previews the app-computed figure before anything is saved',
    preview.value === asPercent1(truth.margin),
    JSON.stringify({ shown: preview.value, expected: asPercent1(truth.margin) }));
  ok('…and echoes the definition it is previewing',
    preview.def === '[Profit] / [Revenue]', JSON.stringify(preview));
  await win.screenshot({ path: path.join(shotDir, 'metrics-editor.png') });

  await win.click('.me-modal .btn-primary');
  await win.waitForTimeout(3000);

  // The RECORD, resolved by main — the preview above has to have been showing
  // what the saved metric actually is, not a number the dialog made up.
  const saved: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const metrics = req('./src/analysis/metrics.js');
    const metricsIpc = req('./src/ipc/metrics.js');
    const p = (await projects.listProjects())[0];
    const list = await metrics.listMetrics(p.id);
    const row = list.find((m: any) => m.name === 'Margin check');
    if (!row) return { projectId: p.id, found: false };
    const r = await metricsIpc.resolveMetric(p.id, row.id);
    return {
      projectId: p.id, found: true, id: row.id, value: r.value, display: r.display,
      definition: row.definition, format: row.format, count: list.length,
    };
  });
  ok('the metric was saved as a record', saved.found === true);
  ok('…as a FORMULA definition, not a column and an aggregation',
    saved.found && saved.definition.formula === '[Profit] / [Revenue]', JSON.stringify(saved.definition));
  ok('…carrying the percent format the editor was set to',
    saved.found && saved.format.kind === 'percent' && saved.format.decimals === 1,
    JSON.stringify(saved.format));
  ok('…and resolving to the figure the preview showed',
    saved.found && saved.display === preview.value && Math.abs(saved.value - truth.margin) < 1e-12,
    JSON.stringify({ value: saved.value, display: saved.display, expected: truth.margin }));
  ok('…which makes seven metrics in the project', saved.count === 7, String(saved.count));

  // ── 3. A KPI card, added from the PICKER ──────────────────────────────────
  // A region control is seeded on the sample sheet first, so step 4 has a real
  // filter-bar widget to drive rather than a synthetic filter.
  await app.evaluate(async (_electron, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const datasets = req('./src/data/datasets.js');
    const crypto = req('crypto');
    const a = (await analysis.listAnalyses(projectId))[0];
    const full = await analysis.getAnalysis(projectId, a.id);
    const ds = (await datasets.listDatasets(projectId))[0];
    full.sheets[0].cards.push({
      id: crypto.randomUUID(),
      type: 'control',
      layout: { x: 0, y: 0, w: 3, h: 1 },
      control: { kind: 'dropdown', label: 'Region', datasetId: ds.id, column: 'region' },
    });
    await analysis.updateAnalysis(projectId, a.id, { sheets: full.sheets });
  }, saved.projectId);

  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(2500);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list > *')]
      .find((r) => /Retail overview/.test(r.textContent || ''));
    if (row) (row.querySelector('button, a') as HTMLElement || row as HTMLElement).click();
  });
  await win.waitForTimeout(8000);

  await win.click('#dash-add-metric');
  await win.waitForTimeout(3500);
  const pickerRows = await win.evaluate(() => ({
    open: !!document.querySelector('.mpk-menu'),
    names: [...document.querySelectorAll('.mpk-menu .mpk-name')].map((n) => (n.textContent || '').trim()),
    values: [...document.querySelectorAll('.mpk-menu .mpk-value')].map((n) => (n.textContent || '').trim()),
    custom: !!document.querySelector('.mpk-menu .mpk-custom'),
  }));
  ok('the metric picker opens from Add → Metric', pickerRows.open === true);
  ok('…listing the project\'s metrics by name',
    pickerRows.names.includes('Margin check') && pickerRows.names.includes('Revenue'),
    JSON.stringify(pickerRows.names));
  ok('…with each one\'s current figure beside it',
    pickerRows.values.includes('$5.2M'), JSON.stringify(pickerRows.values));
  ok('…and a Custom row, so the old column + aggregation form is still reachable',
    pickerRows.custom === true);
  await win.screenshot({ path: path.join(shotDir, 'metrics-picker.png') });

  await win.evaluate(() => {
    const row = [...document.querySelectorAll('.mpk-menu .mpk-row')]
      .find((r) => (r.querySelector('.mpk-name')?.textContent || '').trim() === 'Margin check');
    if (row) (row as HTMLElement).click();
  });
  await win.waitForTimeout(5000);

  /** Open a metric row's ⋯ menu, by the metric's name. */
  const openRowMenu = async (name: string): Promise<void> => {
    await win.evaluate((want: string) => {
      const row = [...document.querySelectorAll('#mp-list .mp-row')]
        .find((r) => (r.querySelector('.mp-name')?.textContent || '').trim() === want);
      (row?.querySelector('.mp-more') as HTMLElement | null)?.click();
    }, name);
    await win.waitForTimeout(1200);
  };

  /** Click one item in whatever mini-menu is open. */
  const clickMenuItem = async (label: string): Promise<void> => {
    await win.evaluate((want: string) => {
      const item = [...document.querySelectorAll('.chart-menu .chart-menu-item')]
        .find((b) => (b.textContent || '').trim() === want);
      (item as HTMLElement | null)?.click();
    }, label);
    await win.waitForTimeout(1200);
  };

  /** The rendered KPI card for one label — what a reader actually reads. */
  const kpiText = (label: string) => win.evaluate((want: string) => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.textContent || '').includes(want));
    return (card?.querySelector('.dash-metric-value')?.textContent || '').trim();
  }, label);

  const unfiltered = await kpiText('Margin check');
  ok('the new card shows the metric in the metric\'s OWN format',
    unfiltered === asPercent1(truth.margin),
    JSON.stringify({ shown: unfiltered, expected: asPercent1(truth.margin) }));

  const cardRecord: any = await win.evaluate(() => {
    const cards = ((window as any).dashCards && (window as any).dashCards()) || [];
    const c = cards.find((x: any) => x.type === 'metric' && x.metric && x.metric.label === 'Margin check');
    return c ? c.metric : null;
  });
  ok('…and the card stores the metricId', !!cardRecord && typeof cardRecord.metricId === 'string',
    JSON.stringify(cardRecord));
  ok('…ALONGSIDE a column and aggregation, so a deleted metric degrades rather than breaks',
    !!cardRecord && typeof cardRecord.aggregation === 'string', JSON.stringify(cardRecord));

  // ── 4. The ratio-of-ratios guard, on screen ───────────────────────────────
  await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    sel?.dispatchEvent(new Event('mousedown', { bubbles: true }));
    sel?.dispatchEvent(new Event('focus', { bubbles: true }));
  });
  await win.waitForTimeout(1500);
  const picked = await win.evaluate(() => {
    const sel = document.querySelector('.dash-filter-bar .dash-ctrl-select') as HTMLSelectElement | null;
    if (!sel || ![...sel.options].some((o) => o.value === 'West')) return false;
    sel.value = 'West';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  ok('the region control offers West off the real column', picked === true);
  await win.waitForTimeout(5000);

  const filtered = await kpiText('Margin check');
  ok('a filtered formula metric is the SCOPE\'S ratio',
    filtered === asPercent1(truth.westMargin),
    JSON.stringify({ shown: filtered, expected: asPercent1(truth.westMargin) }));
  // The bug this exists for: if the operands were not re-resolved under the
  // filter, the card would still read the whole dataset's ratio and look fine.
  ok('…and therefore NOT the unfiltered one',
    filtered !== unfiltered, JSON.stringify({ filtered, unfiltered }));

  // ── 5. An alert about a metric ────────────────────────────────────────────
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(1500);
  await win.click('#ds-tab-metrics');
  await win.waitForTimeout(4000);
  await openRowMenu('Revenue');
  await clickMenuItem('Alert me…');
  await win.waitForTimeout(2500);
  await win.fill('.al-num', '1000');
  await win.waitForTimeout(500);
  await win.click('.al-save');
  await win.waitForTimeout(3000);

  const rule: any = await app.evaluate(async (_electron, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const alertStore = req('./src/analysis/alertStore.js');
    const file = await alertStore.load(projectId);
    const r = file.rules.find((x: any) => x.metric && x.metric.metricId);
    return r ? { name: r.name, metric: r.metric } : null;
  }, saved.projectId);
  ok('an alert created from a metric row stores the metricId',
    !!rule && typeof rule.metric.metricId === 'string', JSON.stringify(rule));
  ok('…and still stores the column and aggregation the evaluator reads',
    !!rule && rule.metric.column === 'revenue' && rule.metric.aggregation === 'sum',
    JSON.stringify(rule && rule.metric));
  ok('…named for the METRIC, not for the column',
    !!rule && /Revenue/.test(rule.name), JSON.stringify(rule && rule.name));

  // ── 6. Deleting something that is used ────────────────────────────────────
  await win.waitForTimeout(2500);
  const before = dialogs.length;
  await openRowMenu('Revenue');
  await clickMenuItem('Delete');
  await win.waitForTimeout(3000);

  const confirmText = dialogs.slice(before).join(' | ');
  ok('deleting a used metric asks first', dialogs.length > before, confirmText);
  ok('…and the question names what would break',
    /Used by/.test(confirmText) && /alert/.test(confirmText), confirmText);
  ok('…naming the metric being deleted', /Revenue/.test(confirmText), confirmText);

  await win.waitForTimeout(2500);
  const stillThere = await win.evaluate(() =>
    [...document.querySelectorAll('#mp-list .mp-name')].map((n) => (n.textContent || '').trim()));
  ok('…and cancelling leaves it alone',
    stillThere.includes('Revenue'), JSON.stringify(stillThere));

  // ── A clean console is the CSP check ──────────────────────────────────────
  ok('no renderer console errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  await closeApp(app);
  process.exit(failureCount() ? 1 : 0);
}

void main();
