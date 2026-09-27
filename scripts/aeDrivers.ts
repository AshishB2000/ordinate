// Smoke SECTION: key drivers — "Why did this change?", end to end on the
// bundled sample.
//
// Not a smoke file of its own: `driversSection(s, ids)` runs against an app
// scripts/smoke-engines.ts launched, on a fresh userData whose first-launch
// sample is seeded. It walks all three doors and all three actions:
//
//   · a KPI with Compare on (Revenue, Dec 2024 vs Nov 2024) → Why? → the panel:
//     headline, periods, ranked dimensions, the waterfall, the caption;
//     another dimension; a drill into a member and back up the breadcrumb;
//   · Add as tile → a waterfall card on the sheet, recomputed by main;
//   · Ask the Assistant → the dock's context is the drivers question and the
//     model (stubbed) is handed the app's facts, not a figure of its own;
//   · Alert me → the alert dialog, prefilled with a change rule;
//   · a point on "Revenue by month" → the drill panel's "Why did this change?";
//   · an alert event → Why? in the bell's popover.
//
// The FIGURES it checks — revenue for Dec and Nov 2024 — are computed HERE
// from assets/samples/retail-orders.csv, never read back from the app.

import { ok } from './selfcheck';
import { REPO } from './smokeFixture';
import type { Smoke } from './smokeFixture';
import { installModelStub, queueReplies, stubState } from './wfStub';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Ids = { projectId: string; datasetId: string; dashboardId: string };

// Hub globals, read by bare name inside page.evaluate (classic-script lexicals).
declare const dashCurrent: any;
declare const chartInstances: WeakMap<Element, any>;
declare function renderDashGrid(): void;
declare let dashSaveTimer: number | null;
declare function persistAnalysis(): Promise<void>;
declare function dkContextRef(): { kind: string; id: string; label: string };

function sumFor(column: string, prefix: string): number {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  const di = head.indexOf('order_date');
  const ci = head.indexOf(column);
  let total = 0;
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    if (c[di].startsWith(prefix)) total += Number(c[ci]);
  }
  return total;
}

const near = (a: unknown, b: number): boolean => typeof a === 'number' && Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-6;
const DEC = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-12-01', to: '2024-12-31' } };

async function panelState(s: Smoke): Promise<any> {
  return s.win.evaluate(() => {
    const root = document.querySelector('.drv-backdrop') as HTMLElement | null;
    const text = (sel: string) => (root?.querySelector(sel)?.textContent || '').trim();
    return {
      open: !!root && !root.hidden,
      title: text('#drv-title'),
      periods: text('.drv-periods'),
      dims: [...(root?.querySelectorAll('.drv-dim') || [])].map((d) => ({
        name: (d.querySelector('.drv-dim-name')?.textContent || '').trim(),
        on: d.classList.contains('is-on'),
      })),
      rows: [...(root?.querySelectorAll('.drv-wf-row') || [])].map((r) => ({
        cls: (r as HTMLElement).className,
        name: (r.querySelector('.drv-wf-name')?.textContent || '').trim(),
        val: (r.querySelector('.drv-wf-val')?.textContent || '').trim(),
      })),
      caption: text('.drv-caption-text'),
      chip: text('.drv-caption .xp-prov-chip'),
      crumbs: text('.drv-crumbs'),
      busy: !!root?.querySelector('[aria-busy="true"]'),
      section: text('.drv-main .drv-sec-h'),
    };
  });
}

async function waitPanel(s: Smoke, pred: (p: any) => boolean, ms = 15000): Promise<any> {
  const until = Date.now() + ms;
  let p = await panelState(s);
  while (Date.now() < until && !pred(p)) {
    await s.win.waitForTimeout(250);
    p = await panelState(s);
  }
  return p;
}

const ready = (p: any): boolean => p.open && !p.busy && p.rows.length > 0;

export async function driversSection(s: Smoke, ids: Ids): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const dec = sumFor('revenue', '2024-12');
  const nov = sumFor('revenue', '2024-11');
  ok('drivers: the sample has Dec and Nov 2024 revenue', dec > 0 && nov > 0);

  // ── Door 1: a KPI with Compare on ──────────────────────────────────────────
  await win.evaluate(async (dash: string) => {
    const w = window as any;
    w.selectSection('analyses');
    await w.openAnalysis(dash);
  }, ids.dashboardId);
  await win.waitForTimeout(3000);
  // What the sheet looked like before this section — put back at the end, so
  // the Compare, the December filter and the tile never reach later sections.
  const saved = await win.evaluate(() => JSON.parse(JSON.stringify({ filters: dashCurrent.filters || [], sheets: dashCurrent.pages })));
  const armed = await win.evaluate((dec: any) => {
    if (!dashCurrent) return false;
    dashCurrent.filters = [dec];
    let done = false;
    for (const page of dashCurrent.pages || []) {
      for (const c of page.cards || []) {
        if (!done && c.type === 'metric' && c.metric && c.metric.column === 'revenue') {
          c.metric.compare = { mode: 'previous_period' };
          done = true;
        }
      }
    }
    renderDashGrid();
    return done;
  }, DEC);
  ok('drivers: the Revenue KPI has Compare on, under a December filter', armed);
  await win.waitForSelector('.dash-metric-why', { timeout: 15000 }).catch(() => null);
  const why = await win.$('.dash-metric-why');
  ok('drivers: the KPI shows "Why?" beside its delta', !!why);
  if (!why) return;
  await why.click();
  let p = await waitPanel(s, ready);
  ok('drivers: the panel opens from the KPI', p.open && p.rows.length > 0, JSON.stringify(p).slice(0, 400));
  ok('drivers: the headline is the change in words', /^Revenue (fell|rose) /.test(p.title), p.title);
  ok('drivers: the two periods, before then after', /Nov 2024.*Dec 2024/.test(p.periods), p.periods);
  ok('drivers: dimensions ranked, one selected', p.dims.length >= 3 && p.dims.filter((d: any) => d.on).length === 1,
    JSON.stringify(p.dims));
  ok('drivers: the waterfall starts at Nov and ends at Dec', p.rows[0].name === 'Nov 2024' && p.rows[p.rows.length - 1].name === 'Dec 2024');
  ok('drivers: the caption is app-computed', /explains \d+%|offset each other/.test(p.caption) && p.chip === 'app-computed', p.caption);

  // The same question straight from main: the figures agree with the CSV.
  const main = await win.evaluate(async (a: { pid: string; dsid: string; dec: any }) => {
    const r = await (window as any).hubDrivers.explain(a.pid, {
      datasetId: a.dsid, metric: { column: 'revenue', aggregation: 'sum' }, filters: [a.dec], compare: { mode: 'previous_period' },
    });
    return r && r.ok ? { a: r.totals.a, b: r.totals.b, top: r.dimensions[0] && r.dimensions[0].column, steps: r.selected ? r.selected.waterfall.steps.length : 0 } : null;
  }, { pid: ids.projectId, dsid: ids.datasetId, dec: DEC });
  ok('drivers: main\'s totals are the CSV\'s December and November revenue', !!main && near(main.a, dec) && near(main.b, nov),
    JSON.stringify({ main, dec, nov }));
  ok('drivers: the panel selected main\'s best dimension', !!main && p.dims.find((d: any) => d.on)?.name === main.top);

  // Another dimension.
  const other = p.dims.find((d: any) => !d.on && d.name === 'region') || p.dims.find((d: any) => !d.on);
  await win.evaluate((name: string) => {
    const b = [...document.querySelectorAll('.drv-dim')].find((x) => (x.querySelector('.drv-dim-name')?.textContent || '') === name) as HTMLElement;
    b?.click();
  }, other.name);
  p = await waitPanel(s, (x) => ready(x) && x.dims.find((d: any) => d.on)?.name === other.name);
  ok('drivers: picking another dimension redraws its contributors', p.section.startsWith('Contributors by ' + other.name), p.section);

  // Drill into the first contributor, then climb back.
  const first = p.rows.find((r: any) => /is-drill/.test(r.cls));
  ok('drivers: contributors can be broken down further', !!first);
  if (first) {
    await win.click('.drv-wf-row.is-drill');
    p = await waitPanel(s, (x) => ready(x) && !!x.crumbs);
    ok('drivers: the breadcrumb names the member drilled into', p.crumbs.includes(other.name + ': ' + first.name), p.crumbs);
    ok('drivers: the drilled column is spent', !p.dims.some((d: any) => d.name === other.name));
    await win.evaluate(() => (document.querySelector('.drv-crumb:not(.is-current)') as HTMLElement | null)?.click());
    p = await waitPanel(s, (x) => ready(x) && !x.crumbs);
    ok('drivers: the breadcrumb climbs back to the top', !p.crumbs && p.dims.some((d: any) => d.name === other.name));
  }

  // ── Action: Add as tile ────────────────────────────────────────────────────
  const before = await win.evaluate(() => (dashCurrent.pages[0].cards || []).length);
  await win.click('.drv-act-tile');
  await win.waitForTimeout(2500);
  const tile = await win.evaluate(() => {
    const cards = dashCurrent.pages[0].cards || [];
    for (const el of document.querySelectorAll('#dash-grid .dash-card')) {
      const area = el.querySelector('.cv-viz-area') as HTMLElement | null;
      const chart = area ? chartInstances.get(area) : null;
      const labels = chart ? chart.data.labels.map(String) : [];
      if (labels[0] === 'Previous total') return { cards: cards.length, labels };
    }
    return { cards: cards.length, labels: [] as string[] };
  });
  ok('drivers: Add as tile puts a waterfall card on the sheet', tile.cards === before + 1 && tile.labels[tile.labels.length - 1] === 'Current total',
    JSON.stringify(tile));

  // ── Action: Ask the Assistant (facts only) ─────────────────────────────────
  const stub = await installModelStub(s);
  ok('drivers: the model stub is ready', stub.ready);
  await queueReplies(s, [{ text: 'The change is mostly in one place, as the app\'s breakdown shows.' }]);
  await win.waitForSelector('.dash-metric-why', { timeout: 15000 }).catch(() => null);
  await win.click('.dash-metric-why');
  p = await waitPanel(s, ready);
  const askedBefore = (await stubState(s)).asked.length;
  await win.click('.drv-act-ask');
  await win.waitForTimeout(3000);
  const ctx = await win.evaluate(() => dkContextRef());
  const st = await stubState(s);
  const asked = st.asked.slice(askedBefore).join('\n');
  ok('drivers: the dock\'s context is the drivers question', ctx.kind === 'drivers' && /^why · /.test(ctx.label), JSON.stringify(ctx));
  ok('drivers: the model was handed the app\'s decomposition as facts',
    /Question: why did "Revenue" change/.test(asked) && /computed by the app/.test(asked), asked.slice(0, 300));
  ok('drivers: no model call reached the network', st.net === 0);

  // ── Action: Alert me ───────────────────────────────────────────────────────
  await win.click('.dash-metric-why');
  p = await waitPanel(s, ready);
  await win.click('.drv-act-alert');
  await win.waitForSelector('#al-dialog', { timeout: 5000 }).catch(() => null);
  const dialog = await win.evaluate(() => {
    const d = document.getElementById('al-dialog');
    return { open: !!d, text: (d?.textContent || '').slice(0, 400) };
  });
  ok('drivers: Alert me opens the alert dialog for this metric', dialog.open && /Revenue/i.test(dialog.text), dialog.text);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  await win.evaluate(() => document.getElementById('al-dialog')?.remove());

  // ── Door 2: a point on "Revenue by month" ──────────────────────────────────
  // Without the December filter, so the line has every month.
  await win.evaluate(() => { dashCurrent.filters = []; renderDashGrid(); });
  await win.waitForTimeout(3000);
  const point = await win.evaluate(() => {
    for (const el of document.querySelectorAll('#dash-grid .dash-card')) {
      const area = el.querySelector('.cv-viz-area') as HTMLElement | null;
      const chart = area ? chartInstances.get(area) : null;
      if (!chart || chart.config.type !== 'line') continue;
      const meta = chart.getDatasetMeta(0);
      const i = chart.data.labels.length - 1;
      const pt = meta && meta.data[i];
      const canvas = chart.canvas.getBoundingClientRect();
      if (!pt) continue;
      area!.scrollIntoView({ block: 'center' });
      const again = chart.canvas.getBoundingClientRect();
      return { x: again.left + pt.x, y: again.top + pt.y, label: String(chart.data.labels[i]), prev: String(chart.data.labels[i - 1]), moved: canvas.top !== again.top };
    }
    return null;
  });
  ok('drivers: the sample has a line chart over months', !!point);
  if (point) {
    await win.mouse.click(point.x, point.y);
    await win.waitForSelector('.drill-why:not([hidden])', { timeout: 8000 }).catch(() => null);
    const has = await win.$('.drill-why:not([hidden])');
    const diag = has ? '' : await win.evaluate(() => JSON.stringify({
      drillOpen: document.body.classList.contains('drill-open'),
      sub: (document.querySelector('.js-drill-sub')?.textContent || ''),
      note: (document.querySelector('.js-drill-note')?.textContent || '').slice(0, 160),
      why: !!document.querySelector('.drill-why'),
    }));
    ok('drivers: the point\'s panel offers "Why did this change?"', !!has, diag + ' ' + JSON.stringify(point));
    if (has) {
      await has.click();
      p = await waitPanel(s, ready);
      ok('drivers: a point compares its month with the one before', p.open && p.rows.length > 0 && p.periods.includes('Dec 2024') && p.periods.includes('Nov 2024'),
        JSON.stringify({ periods: p.periods, point }));
    }
    await win.keyboard.press('Escape');
  }

  // ── Door 3: an alert event ─────────────────────────────────────────────────
  const rule = await s.app.evaluate(async (_a: unknown, arg: { pid: string; dsid: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const store = req('./src/analysis/alertStore.js');
    const r = await store.saveRule(arg.pid, {
      name: 'Revenue moves', datasetId: arg.dsid, metric: { column: 'revenue', aggregation: 'sum', label: 'Revenue' },
      compare: 'change', change: { pct: 5, direction: 'either', vs: 'previous_period', periodColumn: 'order_date' }, enabled: true,
    });
    if (!r) return '';
    await store.recordEvents(arg.pid, [{
      id: req('crypto').randomUUID(), ruleId: r.id, ruleName: r.name, datasetId: arg.dsid, at: new Date().toISOString(),
      value: 1, previous: 2, delta: -1, deltaPct: -50, message: 'Revenue moved', seen: false,
    }]);
    return r.id;
  }, { pid: ids.projectId, dsid: ids.datasetId });
  ok('drivers: an alert rule and an event exist', !!rule);
  await win.evaluate(async () => {
    const w = window as any;
    await w.aiRefresh();
    await w.aiTogglePopover();
  });
  await win.waitForTimeout(600);
  const opened = await win.evaluate(() => {
    const b = [...document.querySelectorAll('.al-ev-act')].find((x) => (x.textContent || '').trim() === 'Why?') as HTMLElement | undefined;
    b?.click();
    return !!b;
  });
  ok('drivers: the alert event offers "Why?"', opened);
  if (opened) {
    p = await waitPanel(s, ready);
    ok('drivers: an alert compares the rule\'s latest two periods', p.open && /Nov 2024.*Dec 2024/.test(p.periods), p.periods);
    await win.keyboard.press('Escape');
  }

  // Leave the sample as we found it: the sheet, the tile's visual, the rule.
  const tileIds = await win.evaluate(async (a: { saved: any; dash: string }) => {
    const before = new Set<string>();
    for (const sh of a.saved.sheets || []) for (const c of sh.cards || []) if (c.visualId) before.add(c.visualId);
    const added: string[] = [];
    for (const sh of dashCurrent.pages || []) for (const c of sh.cards || []) if (c.visualId && !before.has(c.visualId)) added.push(c.visualId);
    if (dashSaveTimer !== null) { window.clearTimeout(dashSaveTimer); dashSaveTimer = null; }
    (window as any).dkSetOpen(false); // "Ask the Assistant" opened the dock; it narrows the sheet
    dashCurrent.filters = a.saved.filters;
    dashCurrent.pages = a.saved.sheets;
    await persistAnalysis();
    await (window as any).openAnalysis(a.dash);
    return added;
  }, { saved, dash: ids.dashboardId });
  await s.app.evaluate(async (_a: unknown, arg: { pid: string; visuals: string[]; rule: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    for (const id of arg.visuals) await visuals.deleteVisual(arg.pid, id);
    if (arg.rule) await req('./src/analysis/alertStore.js').deleteRule(arg.pid, arg.rule);
  }, { pid: ids.projectId, visuals: tileIds, rule });
  await win.waitForTimeout(1500);
  const restored = await win.evaluate(() => ({
    filters: (dashCurrent.filters || []).length,
    why: !!document.querySelector('.dash-metric-why'),
    dock: (window as any).dkIsOpen(),
  }));
  ok('drivers: the sample sheet is back as it was, the dock closed', restored.filters === saved.filters.length && !restored.why && !restored.dock,
    JSON.stringify(restored));

  const errs = s.errors.slice(errorsBefore);
  ok('drivers: no renderer console errors in this section', errs.length === 0, errs.slice(0, 5).join('\n'));
}
