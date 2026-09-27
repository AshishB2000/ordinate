// Smoke SECTION: the builder's Analytics pane, end to end on the bundled sample.
//
// Not a smoke file of its own: `analyticsSection(s, ids)` runs against an app
// scripts/smoke-power.ts launched, on a FRESH userData whose first-launch sample
// is seeded ("My project" / "Retail orders"). It drives the builder the way a
// user does — revenue by month as a line, then the Analytics section's Add menu
// — drags a target line, ⌥-clicks a point to annotate it, switches to a type
// that cannot draw a trend, saves, reopens, and checks the caption and the
// Assistant's facts carry the trend and the forecast.
//
// The FIGURES it checks — the monthly average and the trend's slope — are
// computed HERE from assets/samples/retail-orders.csv with this file's own
// arithmetic, never read back from the app it is testing.

import { ok } from './selfcheck';
import { REPO, domDriver } from './smokeFixture';
import type { Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
type Ids = { projectId: string; datasetId: string; dashboardId: string };

// Hub globals, read by bare name inside page.evaluate (classic-script lexicals).
declare const chartInstances: WeakMap<Element, any>;
declare const vizAnalytics: any[];

/** sum(revenue) per calendar month, in month order — the line the builder draws. */
function monthlyRevenue(): { labels: string[]; values: number[] } {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  const di = head.indexOf('order_date');
  const ri = head.indexOf('revenue');
  const sums = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const m = c[di].slice(0, 7);
    sums.set(m, (sums.get(m) || 0) + Number(c[ri]));
  }
  const labels = [...sums.keys()].sort();
  return { labels, values: labels.map((l) => sums.get(l) as number) };
}

function olsSlope(ys: number[]): number {
  const n = ys.length;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let sxx = 0; let sxy = 0;
  ys.forEach((y, x) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); });
  return sxy / sxx;
}

const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-9;

async function openBuilder(win: Win): Promise<boolean> {
  const { clickExact, clickId } = domDriver(win);
  await clickExact('Visuals');
  await win.waitForTimeout(900);
  if (!(await clickId('viz-new-btn'))) return false;
  await win.waitForTimeout(900);
  const picked = await win.evaluate(() => {
    const row = [...document.querySelectorAll('.vn-row')].find((x) => /Retail orders/i.test(x.textContent || '')) as HTMLElement | undefined;
    const manual = document.querySelector('.js-vn-manual') as HTMLElement | null;
    if (!row || !manual) return false;
    row.click();
    manual.click();
    return true;
  });
  if (!picked) return false;
  await win.waitForTimeout(2500);
  return win.evaluate(() => (document.getElementById('viz-builder') as HTMLElement).hidden === false);
}

async function setEncoding(win: Win, category: string, measure: string): Promise<boolean> {
  const done = await win.evaluate(async (arg: { category: string; measure: string }) => {
    const box = document.getElementById('ws-visuals') as HTMLElement;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const cat = box.querySelector('.js-enc-cat') as HTMLSelectElement | null;
    if (!cat) return false;
    cat.value = arg.category;
    cat.dispatchEvent(new Event('change', { bubbles: true }));
    await pause(600);
    const sel = box.querySelector('.viz-value-col') as HTMLSelectElement | null;
    if (!sel) return false;
    sel.value = arg.measure;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return cat.value === arg.category && sel.value === arg.measure;
  }, { category, measure });
  await win.waitForTimeout(2000);
  return done;
}

async function pickType(win: Win, label: string): Promise<boolean> {
  const direct = await win.evaluate((l: string) => {
    const chip = [...document.querySelectorAll('#viz-switcher-mount .cv-viz-chip')]
      .find((b) => (b.textContent || '').trim() === l) as HTMLElement | undefined;
    if (chip) { chip.click(); return true; }
    const more = [...document.querySelectorAll('#viz-switcher-mount button')].find((b) => /More/i.test(b.textContent || '')) as HTMLElement | undefined;
    if (more) more.click();
    return false;
  }, label);
  if (!direct) {
    await win.waitForTimeout(500);
    const tile = await win.evaluate((l: string) => {
      const t = [...document.querySelectorAll('.cv-more-panel .cv-more-item')]
        .find((b) => (b.textContent || '').trim().startsWith(l)) as HTMLElement | undefined;
      if (!t) return false;
      t.click();
      return true;
    }, label);
    if (!tile) return false;
  }
  await win.waitForTimeout(1800);
  return true;
}

/** Add one overlay through the pane's own Add menu. */
async function addOverlay(win: Win, name: string): Promise<boolean> {
  const opened = await win.evaluate(() => {
    const add = document.querySelector('#viz-analytics-mount .anp-add') as HTMLElement | null;
    if (!add) return false;
    add.click();
    return true;
  });
  if (!opened) return false;
  await win.waitForTimeout(200);
  const picked = await win.evaluate((n: string) => {
    const item = [...document.querySelectorAll('.anp-menu .anp-menu-item')]
      .find((b) => (b.querySelector('.anp-menu-name')?.textContent || '') === n) as HTMLButtonElement | undefined;
    if (!item || item.disabled) return false;
    item.click();
    return true;
  }, name);
  await win.waitForTimeout(1600);
  return picked;
}

async function rows(win: Win): Promise<Array<{ kind: string; name: string; read: string }>> {
  return win.evaluate(() => [...document.querySelectorAll('#viz-analytics-mount .anp-row')].map((r) => ({
    kind: (r as HTMLElement).dataset.kind || '',
    name: (r.querySelector('.anp-row-name')?.textContent || '').trim(),
    read: (r.querySelector('.anp-row-read')?.textContent || '').trim(),
  })));
}

export async function analyticsSection(s: Smoke, ids: Ids): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const truth = monthlyRevenue();
  const avg = truth.values.reduce((a, v) => a + v, 0) / truth.values.length;
  const slope = olsSlope(truth.values);
  ok('analytics: the sample spans 24 months', truth.labels.length === 24, String(truth.labels.length));

  ok('analytics: the builder opens on the sample', await openBuilder(win));
  ok('analytics: revenue by order month', await setEncoding(win, 'order_date', 'revenue'));
  ok('analytics: drawn as a line', await pickType(win, 'Line'));

  const empty = await win.evaluate(() => (document.querySelector('#viz-analytics-mount .anp-empty')?.textContent || ''));
  ok('analytics: the section shows its empty state first', /reference line/i.test(empty), empty);

  for (const k of ['Reference line', 'Target', 'Trend line', 'Moving average', 'Forecast', 'Band', 'Highlight']) {
    ok(`analytics: "${k}" is added from the Add menu`, await addOverlay(win, k));
  }
  await win.waitForTimeout(1500);
  const r1 = await rows(win);
  ok('analytics: seven rows, one per overlay', r1.length === 7, JSON.stringify(r1));
  const read = (kind: string) => (r1.find((r) => r.kind === kind) || { read: '' }).read;
  ok('analytics: the reference row reads out the average', /^Average /.test(read('reference')), read('reference'));
  ok('analytics: the trend row reads out a per-month slope and R²', /per month · R² \d\.\d\d$/.test(read('trend')), read('trend'));
  ok('analytics: the forecast row reads out its last period and 80% range', /by 2025-03 \(80%: .+\)/.test(read('forecast')), read('forecast'));

  // The figures, from main, against this file's own arithmetic.
  const res = await win.evaluate(async (a: { pid: string; dsid: string }) => (window as any).hub.computeVisualData(
    a.pid, a.dsid, { category: 'order_date', values: [{ column: 'revenue', aggregation: 'sum' }] }, [], undefined, vizAnalytics,
  ), { pid: ids.projectId, dsid: ids.datasetId });
  const an: any[] = (res && res.data && res.data.analytics) || [];
  const byKind = (k: string) => an.find((o) => o.kind === k) || {};
  ok('analytics: the reference line sits at the monthly average', near(byKind('reference').value, avg), `${byKind('reference').value} vs ${avg}`);
  ok('analytics: the trend slope is the OLS slope of the monthly sums', near(byKind('trend').trend?.slope, slope), `${byKind('trend').trend?.slope} vs ${slope}`);
  ok('analytics: the forecast runs three months past the axis',
    JSON.stringify(byKind('forecast').forecast?.labels) === '["2025-01","2025-02","2025-03"]');

  const chart = await win.evaluate(() => {
    const c = chartInstances.get(document.getElementById('viz-area') as HTMLElement);
    return c ? { plugin: (c.config.plugins || []).some((p: any) => p && p.id === 'ordAnnotations'), labels: c.data.labels.length } : null;
  });
  ok('analytics: the chart carries the annotations plugin and an axis grown by the forecast',
    !!chart && chart.plugin && chart.labels === 27, JSON.stringify(chart));

  // Drag the target line up 40px: it moves, and becomes that constant.
  const before = await win.evaluate(() => (vizAnalytics.find((o) => o.kind === 'target') || {}).value);
  const px = await win.evaluate((v: number) => {
    const area = document.getElementById('viz-area') as HTMLElement;
    const c = chartInstances.get(area);
    const rect = c.canvas.getBoundingClientRect();
    return { x: rect.left + (c.chartArea.left + c.chartArea.right) / 2, y: rect.top + c.scales.y.getPixelForValue(v) };
  }, before && before.value);
  await win.mouse.move(px.x, px.y);
  await win.mouse.down();
  await win.mouse.move(px.x, px.y - 20, { steps: 4 });
  await win.mouse.move(px.x, px.y - 40, { steps: 4 });
  await win.mouse.up();
  await win.waitForTimeout(1800);
  const after = await win.evaluate(() => (vizAnalytics.find((o) => o.kind === 'target') || {}).value);
  ok('analytics: dragging the target line up raises its value',
    !!after && after.type === 'constant' && after.value > before.value, JSON.stringify({ before, after }));

  // ⌥-click the sixth month to annotate it.
  const pt = await win.evaluate(() => {
    const c = chartInstances.get(document.getElementById('viz-area') as HTMLElement);
    const rect = c.canvas.getBoundingClientRect();
    const v = c.data.datasets[0].data[5];
    return { x: rect.left + c.scales.x.getPixelForValue(5), y: rect.top + c.scales.y.getPixelForValue(v) };
  });
  await win.keyboard.down('Alt');
  await win.mouse.click(pt.x, pt.y);
  await win.keyboard.up('Alt');
  await win.waitForTimeout(500);
  ok('analytics: ⌥-click asks for the note', await domDriver(win).fillPrompt('Spring promo'));
  await win.waitForTimeout(1600);
  const note = await win.evaluate(() => vizAnalytics.find((o) => o.kind === 'annotation'));
  ok('analytics: the annotation is pinned to the clicked month', !!note && note.at === '2023-06' && note.text === 'Spring promo', JSON.stringify(note));

  if (process.env.SMOKE_ARTIFACT_DIR) {
    await win.evaluate(() => { const row = document.querySelector('#viz-analytics-mount .anp-row[data-kind="forecast"] .anp-row-main') as HTMLElement | null; row?.click(); });
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(s.shotDir, 'analytics-builder.png') });
  }

  // A type that cannot draw a trend says so, row by row.
  ok('analytics: switched to Pareto', await pickType(win, 'Pareto'));
  const r2 = await rows(win);
  ok('analytics: on a Pareto, trend and forecast read "Not drawn"',
    ['trend', 'forecast', 'moving_average'].every((k) => /^Not drawn on Pareto/.test((r2.find((r) => r.kind === k) || { read: '' }).read)),
    JSON.stringify(r2));
  ok('analytics: back to a line', await pickType(win, 'Line'));

  // Save, then reopen — the overlays are the visual's.
  const { clickId, fillPrompt } = domDriver(win);
  ok('analytics: save opens the name prompt', await clickId('viz-save-btn'));
  await win.waitForTimeout(600);
  ok('analytics: saved', await fillPrompt('Revenue with analytics'));
  await win.waitForTimeout(2500);
  const saved = await win.evaluate(async (pid: string) => {
    const w = window as any;
    const v = (await w.hub.listVisuals(pid)).find((x: any) => x.name === 'Revenue with analytics');
    return v ? w.hub.getVisual(pid, v.id) : null;
  }, ids.projectId);
  ok('analytics: the saved record holds eight overlay definitions and no figures',
    !!saved && Array.isArray(saved.analytics) && saved.analytics.length === 8 && !saved.analytics.some((o: any) => 'points' in o || 'text' in o && o.kind !== 'annotation'),
    JSON.stringify(saved && saved.analytics));
  await win.evaluate(async (id: string) => { await (window as any).openSavedVisual(id); }, saved ? saved.id : '');
  await win.waitForTimeout(3000);
  ok('analytics: reopening the visual brings its overlays back', (await rows(win)).length === 8);

  // The caption and the Assistant's facts narrate the same figures.
  const cap = await win.evaluate(async (d: any) => (window as any).hub.reportsCaption({ chartType: 'line', data: d }), res && res.data);
  ok('analytics: the report caption carries the trend and the forecast', /; trend [+−].+ per month/.test(cap) && /; forecast .+ by 2025-03, 80% range /.test(cap), cap);
  const facts = await s.app.evaluate(async (_a: unknown, arg: { pid: string; id: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const f = await req('./src/ipc/copilot.js').buildFacts(arg.pid, { kind: 'visual', id: arg.id });
    return { text: f.text, ledger: f.ledger.length };
  }, { pid: ids.projectId, id: saved ? saved.id : '' });
  ok('analytics: the Assistant\'s facts list the overlays, figures and all',
    facts.text.includes('Analytics overlays on this chart') && facts.text.includes('Linear trend') && facts.text.includes('Forecast ('), facts.text.slice(-600));

  ok('analytics: no renderer console errors in this section', s.errors.length === errorsBefore, s.errors.slice(errorsBefore).join('\n'));
}
