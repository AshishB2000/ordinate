// Smoke SECTION: table calculations — "Calculate as" on a builder measure, on a
// pivot value and on a KPI card, in the real app.
//
// Not a smoke file of its own: `tableCalcSection(s, ids)` runs against an app
// someone else launched, on a FRESH userData whose first-launch sample is
// already seeded ("My project" / "Retail orders" / the "Retail overview"
// dashboard). It drives the menus the way a user does and reads what was drawn:
// a chart's tooltip and caption, a pivot's cells, a KPI's figure line.
//
// Every expected FIGURE is computed here from assets/samples/retail-orders.csv
// with this file's own arithmetic — never read back from the app. Only the
// formatting goes through src/app/format, the app's one formatter, so the
// expected string is spelled the way every figure in the app is.

import { ok } from './selfcheck';
import { REPO } from './smokeFixture';
import type { Smoke } from './smokeFixture';
import { openBuilder, pickType, save, setEncoding } from './wfCharts';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const format: typeof import('../src/app/format') = require('../src/app/format');

type Win = Smoke['win'];

// The hub's own globals (chartRender.ts / anNew.ts), read inside page.evaluate
// by their bare names: a top-level const of a classic script is not on window.
declare const chartInstances: WeakMap<Element, any>;

/** The sample as columns → cells. It has no quoted fields (wfCharts asserts it). */
function sample(): { col: (name: string) => number; rows: string[][] } {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  return { col: (n) => head.indexOf(n), rows: lines.slice(1).map((l) => l.split(',')) };
}

/** Click the first element matching `selector` whose text starts with `text` (or any, when text is ''). */
async function clickText(win: Win, selector: string, text = ''): Promise<boolean> {
  const done = await win.evaluate((a: { selector: string; text: string }) => {
    const el = [...document.querySelectorAll(a.selector)]
      .find((b) => !a.text || (b.textContent || '').trim().startsWith(a.text)) as HTMLElement | undefined;
    if (!el) return false;
    el.click();
    return true;
  }, { selector, text });
  await win.waitForTimeout(500);
  return done;
}

/** Apply the open settings popover (compute along / restart / N) as it stands. */
async function applyPopover(win: Win): Promise<boolean> {
  const shown = await win.evaluate(() => {
    const pop = document.querySelector('.tc-pop') as HTMLElement | null;
    return !!pop && pop.getClientRects().length > 0;
  });
  if (!shown) return false;
  return clickText(win, '.tc-pop .js-tc-apply');
}

export async function tableCalcSection(
  s: Smoke, ids: { projectId: string; datasetId: string; dashboardId: string },
): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const { col, rows } = sample();
  const REV = col('revenue');
  const byRegion = new Map<string, number>();
  const byMonth = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    const v = Number(r[REV]);
    byRegion.set(r[col('region')], (byRegion.get(r[col('region')]) || 0) + v);
    const month = r[col('order_date')].slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + v);
    total += v;
  }
  const shareText = (region: string): string =>
    format.formatPercent((byRegion.get(region) as number) / total, 1) + ' of total · ' + format.formatCompact(byRegion.get(region));

  // ── 1. The builder: Calculate as → Percent of total ─────────────────────────
  ok('calc/builder: the builder opens on the sample', await openBuilder(win));
  ok('calc/builder: revenue by region is encoded', await setEncoding(win, 'region', ['revenue']));
  // Explicitly a column chart: the type the builder opened with followed its
  // first (date) category, and the caption frame follows the type.
  ok('calc/builder: drawn as a column chart', await pickType(win, 'Column'));
  await win.waitForTimeout(1500);
  ok('calc/builder: the measure row offers "Calculate as"', await clickText(win, '#ws-visuals .viz-value-row .js-tc-calc'));
  const menu = await win.evaluate(() => [...document.querySelectorAll('.tc-menu .tc-menu-row')].map((b) => ({
    kind: (b as HTMLElement).dataset.kind, disabled: (b as HTMLButtonElement).disabled, why: (b.querySelector('.tc-menu-why')?.textContent || '').trim(),
  })));
  ok('calc/builder: the menu lists all eleven kinds', menu.length === 11, JSON.stringify(menu));
  const yoy = menu.find((m) => m.kind === 'yoy');
  ok('calc/builder: year over year is disabled on a text category, with the reason shown', !!yoy && yoy.disabled && /date/.test(yoy.why), JSON.stringify(yoy));
  ok('calc/builder: Percent of total is chosen', await clickText(win, '.tc-menu .tc-menu-row[data-kind="pct_of_total"]'));
  ok('calc/builder: the settings popover applies', await applyPopover(win));
  await win.waitForTimeout(3000);

  const drawn = await win.evaluate(() => {
    const area = document.getElementById('viz-area') as HTMLElement;
    const chart = chartInstances.get(area);
    const badge = (document.querySelector('#ws-visuals .viz-value-row .tc-badge')?.textContent || '').trim();
    if (!chart) return { badge, tips: [] as Array<{ label: string; text: string }>, tick: '' };
    const cb = chart.options.plugins.tooltip.callbacks.label;
    const tips: Array<{ label: string; text: string }> = chart.data.labels.map((label: string, i: number) => ({
      label: String(label),
      text: String(cb({ datasetIndex: 0, dataIndex: i, dataset: chart.data.datasets[0] })),
    }));
    const y = chart.options.scales && (chart.options.scales.y || chart.options.scales.x);
    const tick = y && y.ticks && typeof y.ticks.callback === 'function' ? String(y.ticks.callback(0.25)) : '';
    return { badge, tips, tick };
  });
  ok('calc/builder: the measure chip carries a "% of total" badge', drawn.badge === '% of total', drawn.badge);
  ok('calc/builder: every bar\'s tooltip shows the share AND the raw figure, from the CSV',
     drawn.tips.length === byRegion.size && drawn.tips.every((t) => byRegion.has(t.label) && t.text.endsWith(shareText(t.label))),
     JSON.stringify({ drawn: drawn.tips, want: [...byRegion.keys()].map(shareText) }));
  ok('calc/builder: the value axis ticks read as percents', drawn.tick === format.formatPercent(0.25, 1, { maxOnly: true }), drawn.tick);

  ok('calc/builder: the visual saves', await save(win, 'Revenue share by region'));
  const caption: string = await win.evaluate(async (pid: string) => {
    const hub = (window as any).hub;
    const row = (await hub.listVisuals(pid)).find((v: any) => v.name === 'Revenue share by region');
    const v = row && await hub.getVisual(pid, row.id);
    if (!v || !v.encoding.values[0].calc) return 'no calc saved';
    const res = await hub.computeVisualData(pid, v.datasetId, v.encoding, v.filters || []);
    return hub.reportsCaption({ chartType: v.chartType, data: res.data });
  }, ids.projectId);
  const top = [...byRegion.entries()].sort((a, b) => b[1] - a[1])[0][0];
  ok('calc/builder: the saved visual keeps its calc, and the caption names both figures',
     caption === `${top} leads revenue at ${shareText(top)}`, JSON.stringify({ caption, want: `${top} leads revenue at ${shareText(top)}` }));

  // ── 2. A pivot value: Calculate as → Running total ──────────────────────────
  ok('calc/pivot: a fresh builder opens', await openBuilder(win));
  ok('calc/pivot: revenue by region is encoded', await setEncoding(win, 'region', ['revenue']));
  ok('calc/pivot: the type switches to Pivot table', await pickType(win, 'Pivot table'));
  await win.waitForTimeout(2500);
  const valuesMenu = await win.evaluate(() => {
    const block = [...document.querySelectorAll('#ws-visuals .pivot-shelf')]
      .find((b) => (b.querySelector('.viz-build-label')?.textContent || '').trim() === 'Values') as HTMLElement | undefined;
    const btn = block && block.querySelector('.enc-pill-menu') as HTMLElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  });
  await win.waitForTimeout(400);
  ok('calc/pivot: the value chip\'s ⋮ menu offers "Calculate as…"', valuesMenu && await clickText(win, '.project-card-popup button', 'Calculate as'));
  await win.waitForTimeout(300);
  ok('calc/pivot: Running total is chosen', await clickText(win, '.tc-menu .tc-menu-row[data-kind="running_total"]'));
  const along = await win.evaluate(() => (document.querySelector('.tc-pop .js-tc-along select') as HTMLSelectElement | null)?.value || '');
  ok('calc/pivot: a pivot computes down the table by default', along === 'down', along);
  ok('calc/pivot: the settings popover applies', await applyPopover(win));
  await win.waitForFunction(() => !!document.querySelector('#viz-area .pivot-table tbody tr'), undefined, { timeout: 30_000 }).catch(() => {});
  await win.waitForTimeout(2500);
  const grid = await win.evaluate(() => {
    const table = document.querySelector('#viz-area .pivot-table');
    const body = [...(table?.querySelectorAll('tbody tr.pivot-row') || [])].map((tr) => ({
      label: (tr.querySelector('.pivot-row-head')?.textContent || '').trim(),
      cell: (tr.querySelector('.pivot-cell')?.textContent || '').trim(),
    }));
    const first = table?.querySelector('tbody .pivot-cell') as HTMLElement | null;
    first?.dispatchEvent(new MouseEvent('mouseenter'));
    const tip = (document.querySelector('.pivot-tip')?.textContent || '').trim();
    first?.dispatchEvent(new MouseEvent('mouseleave'));
    const badge = (document.querySelector('#ws-visuals .pivot-chip .tc-badge')?.textContent || '').trim();
    return { body, tip, badge };
  });
  let run = 0;
  const want = grid.body.map((r) => format.formatCompact((run += byRegion.get(r.label) || 0)));
  ok('calc/pivot: each region\'s cell is the running total down the rows, from the CSV',
     grid.body.length === byRegion.size && grid.body.every((r, i) => r.cell === want[i]),
     JSON.stringify({ got: grid.body, want }));
  ok('calc/pivot: …ending at the grand total', want[want.length - 1] === format.formatCompact(total));
  const firstRegion = grid.body[0] ? grid.body[0].label : '';
  ok('calc/pivot: a cell\'s tooltip names the running total and the raw figure',
     grid.tip.includes(`${format.formatCompact(byRegion.get(firstRegion))} running total · ${format.formatCompact(byRegion.get(firstRegion))}`),
     grid.tip);
  ok('calc/pivot: the value chip carries a "Running total" badge', grid.badge === 'Running total', grid.badge);

  // ── 3. A KPI card: Calculate as → Percent difference from previous ──────────
  // Opened from the Analyses list, as a user does — that is the authoring surface.
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(2500);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list > *')].find((r) => /Retail overview/.test(r.textContent || ''));
    if (row) ((row.querySelector('button, a') as HTMLElement) || (row as HTMLElement)).click();
  });
  await win.waitForTimeout(7000);
  await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue');
    (card?.querySelector('.an-card-props') as HTMLElement | null)?.click();
  });
  await win.waitForTimeout(1500);
  ok('calc/kpi: the Revenue card\'s Properties offer "Calculate as"', await clickText(win, '#an-kpi-props .js-tc-kpi'));
  const kpiMenu = await win.evaluate(() => [...document.querySelectorAll('.tc-menu .tc-menu-row')].filter((b) => !(b as HTMLButtonElement).disabled).length);
  ok('calc/kpi: with a date column every kind is available', kpiMenu === 11, String(kpiMenu));
  ok('calc/kpi: Percent difference from previous is chosen', await clickText(win, '.tc-menu .tc-menu-row[data-kind="pct_diff"]'));
  await win.waitForTimeout(5000);
  const kpi = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card--metric')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === 'Revenue');
    return {
      value: (card?.querySelector('.dash-metric-value')?.textContent || '').trim(),
      line: (card?.querySelector('.dash-metric-calc')?.textContent || '').trim(),
    };
  });
  const months = [...byMonth.keys()].sort();
  const latest = months[months.length - 1];
  const prev = byMonth.get(months[months.length - 2]) as number;
  const pct = ((byMonth.get(latest) as number) - prev) / Math.abs(prev);
  const pctText = (pct > 0 ? '+' : '') + format.formatPercent(pct, 1);
  ok(`calc/kpi: the figure is ${latest} against the month before, from the CSV (${pctText})`, kpi.value === pctText,
     JSON.stringify({ kpi, want: pctText }));
  ok('calc/kpi: the figure line names the calculation, the raw figure and its period',
     kpi.line.startsWith('vs previous · ') && kpi.line.endsWith(' in ' + latest), kpi.line);
  if (process.env.SMOKE_ARTIFACT_DIR) await win.screenshot({ path: path.join(s.shotDir, 'tablecalc-kpi.png') });
  // The 600 ms autosave has run: the calc is on the card, through sanitizeCard and disk.
  const stored = await win.evaluate(async (a: { pid: string; id: string }) => {
    const an = await (window as any).hub.getAnalysis(a.pid, a.id);
    const cards = ((an && (an.sheets || an.pages)) || []).flatMap((p: any) => p.cards || []);
    const card = cards.find((c: any) => c.type === 'metric' && c.metric && c.metric.calc);
    return card ? card.metric.calc : null;
  }, { pid: ids.projectId, id: ids.dashboardId });
  ok('calc/kpi: the dashboard stored the calc on the card', !!stored && stored.kind === 'pct_diff', JSON.stringify(stored));

  const errors = s.errors.slice(errorsBefore);
  ok('calc: no renderer console errors in this section', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
}
