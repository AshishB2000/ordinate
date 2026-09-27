// Build-depth smoke SECTION: formatting depth and project colours, driven
// through the REAL UI. Not a smoke of its own — scripts/smoke-build.ts calls
// formatSection(s, fx) on its one launch and fixture.
//
//   1. The Visuals builder → the chart's ⋯ → Customize: a Y-axis title, a log
//      scale and the legend at the bottom, set in the Format panel — and the
//      live Chart.js instance's options say so, and the saved visual has them.
//   2. Two charts over the same category column, on one dashboard, drawn in
//      different orders: every region is the same colour in both, and the
//      project record holds the map they drew from.
//   3. The dataset's column profile → Colours: pick a slot for a value, and it
//      is on the project record.
//
// Leaves the app on Home.

import { ok } from './selfcheck';
import { openProject, seedAnalysis, openSeededAnalysis, railDriver } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

const path: typeof import('path') = require('path');

// Hub globals: classic-script `function`s are on window; the top-level
// `const chartInstances` is in the global lexical scope, read by bare name.
declare const chartInstances: WeakMap<Element, any>;
declare const selectSection: (s: string) => void;
declare const openSavedVisual: (id: string) => Promise<void>;
declare const openSavedDataset: (id: string) => Promise<void>;
declare const dsOpenProfile: (i: number) => Promise<void>;
declare const dsCloseProfile: () => void;
declare const showHome: () => void;

type Win = Smoke['win'];

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

/** The main-process record of a project / visual, read the way the other sections do. */
async function mainRead(s: Smoke, what: 'project' | 'visual', pid: string, id?: string): Promise<any> {
  return s.app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    if (arg.what === 'project') return req('./src/app/projects.js').getProject(arg.pid);
    return req('./src/analysis/visuals.js').getVisual(arg.pid, arg.id);
  }, { what, pid, id });
}

export async function formatSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(350);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };

  // ── 1. Builder → ⋯ → Customize → Format ──────────────────────────────────
  const original = await mainRead(s, 'visual', fx.projectId, fx.visualId);
  const before = (original && original.overrides) || {};
  await openProject(win, fx.projectId);
  await win.evaluate(() => selectSection('visuals'));
  await win.waitForTimeout(800);
  await win.evaluate((id: string) => openSavedVisual(id), fx.visualId);
  const drawn = await until(win, () => win.evaluate(() => {
    const area = document.getElementById('viz-area');
    return !!area && area.getClientRects().length > 0 && !!chartInstances.get(area);
  }));
  ok('format: the saved visual draws in the builder', drawn);

  const opened = await win.evaluate(() => {
    const btn = document.querySelector('.viz-builder-stage .cv-chart-menu-btn') as HTMLElement | null;
    btn?.click();
    return !!btn;
  });
  await win.waitForTimeout(300);
  await win.evaluate(() => (document.getElementById('cm-customize-toggle') as HTMLElement | null)?.click());
  const panel = await win.evaluate(() => {
    const mount = document.getElementById('cm-format-mount');
    return {
      visible: !!mount && mount.getClientRects().length > 0,
      sections: [...(mount ? mount.querySelectorAll('.an-sec-head') : [])].map((h) => (h.textContent || '').trim()),
      legend: !!mount?.querySelector('[data-fmt-key="legend"]'),
    };
  });
  ok('format: ⋯ → Customize shows the Format panel with its sections',
    opened && panel.visible && panel.legend && ['Axes', 'Data labels', 'Sort', 'Colours'].every((t) => panel.sections.includes(t)),
    JSON.stringify(panel));

  // Open Axes, type a title, switch on log; then move the legend right, then bottom.
  await win.evaluate(() => {
    const head = [...document.querySelectorAll('#cm-format-mount .an-sec-head')]
      .find((h) => (h.textContent || '').trim() === 'Axes') as HTMLElement | undefined;
    head?.click();
    const title = document.querySelector('#cm-format-mount [data-fmt-key="y:title"]') as HTMLInputElement | null;
    if (title) {
      title.value = 'Revenue (log)';
      title.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await win.waitForTimeout(700); // the title field is debounced
  const logged = await win.evaluate(() => {
    const b = document.querySelector('#cm-format-mount [data-fmt-key="y:log"]') as HTMLButtonElement | null;
    if (!b || b.disabled) return false;
    b.click();
    return true;
  });
  const pickLegend = (v: string) => win.evaluate((val: string) => {
    const sel = document.querySelector('#cm-format-mount [data-fmt-key="legend"]') as HTMLSelectElement | null;
    if (!sel) return false;
    sel.value = val;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, v);
  await pickLegend('right');
  await win.waitForTimeout(300);
  const rightPos = await win.evaluate(() => chartInstances.get(document.getElementById('viz-area') as Element)?.options?.plugins?.legend?.position);
  await pickLegend('bottom');
  await win.waitForTimeout(500);
  const opts = await win.evaluate(() => {
    const chart = chartInstances.get(document.getElementById('viz-area') as Element);
    const o = chart && chart.options;
    return o ? {
      yType: o.scales && o.scales.y && o.scales.y.type,
      yTitle: o.scales && o.scales.y && o.scales.y.title && o.scales.y.title.text,
      legendPos: o.plugins.legend.position,
      legendOn: o.plugins.legend.display,
      logSwitch: document.querySelector('#cm-format-mount [data-fmt-key="y:log"]')?.getAttribute('aria-checked'),
    } : null;
  });
  ok('format: the Y title reaches the chart', !!opts && opts.yTitle === 'Revenue (log)', JSON.stringify(opts));
  ok('format: the log switch draws a logarithmic Y axis', logged && !!opts && opts.yType === 'logarithmic' && opts.logSwitch === 'true',
    JSON.stringify(opts));
  ok('format: the legend moves right, then back to the bottom',
    rightPos === 'right' && !!opts && opts.legendPos === 'bottom' && opts.legendOn === true, `${rightPos} ${JSON.stringify(opts)}`);
  await win.waitForTimeout(800); // the builder's override save is debounced
  const savedVis = await mainRead(s, 'visual', fx.projectId, fx.visualId);
  const ov = (savedVis && savedVis.overrides) || {};
  ok('format: the saved visual carries them in its overrides',
    ov.yAxisLabel === 'Revenue (log)' && ov.axes && ov.axes.y && ov.axes.y.log === true, JSON.stringify(ov));
  await shot('format-menu-axes.png');

  // Sort → Custom order: the drag list, moved from the keyboard (Alt+↑), redraws the bars.
  const vizLabels = () => win.evaluate(() =>
    (chartInstances.get(document.getElementById('viz-area') as Element)?.data?.labels || []).join());
  await win.evaluate(() => {
    const head = [...document.querySelectorAll('#cm-format-mount .an-sec-head')]
      .find((h) => (h.textContent || '').trim() === 'Sort') as HTMLElement | undefined;
    if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
    const sel = document.querySelector('#cm-format-mount [data-fmt-key="sort"]') as HTMLSelectElement | null;
    if (sel) { sel.value = 'custom'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await win.waitForTimeout(400);
  const listRows = await win.evaluate(() => [...document.querySelectorAll('#cm-format-mount .fmt-order-row')]
    .map((r) => r.textContent || ''));
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#cm-format-mount .fmt-order-row')]
      .find((r) => (r.textContent || '') === 'region3') as HTMLElement | undefined;
    row?.focus();
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
  });
  await win.waitForTimeout(400);
  const moved = await vizLabels();
  ok('format: Custom order lists the categories to drag', listRows.length === 7 && listRows[3] === 'region3', JSON.stringify(listRows));
  ok('format: moving region3 up redraws the bars in that order',
    moved === 'region0,region1,region3,region2,region4,region5,region6', moved);
  ok('format: …and keeps focus on the moved row',
    await win.evaluate(() => (document.activeElement?.textContent || '') === 'region3'));
  await shot('format-menu-sort.png');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  // Dual axis: a combo of two measures, one moved to the right axis from the panel.
  const comboId: string = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const v = await req('./src/analysis/visuals.js').saveVisual(arg.pid, {
      datasetId: arg.ds, name: 'Amount and rows by region', chartType: 'line',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }, { column: 'sku', aggregation: 'count' }] },
    });
    return v ? v.id : '';
  }, { pid: fx.projectId, ds: fx.datasetId });
  await win.evaluate((id: string) => openSavedVisual(id), comboId);
  await until(win, () => win.evaluate(() => {
    const c = chartInstances.get(document.getElementById('viz-area') as Element);
    return !!c && c.data.datasets.length === 2;
  }));
  await win.evaluate(async () => {
    (document.querySelector('.viz-builder-stage .cv-chart-menu-btn') as HTMLElement | null)?.click();
    await new Promise((r) => setTimeout(r, 300));
    (document.getElementById('cm-customize-toggle') as HTMLElement | null)?.click();
    const head = [...document.querySelectorAll('#cm-format-mount .an-sec-head')]
      .find((h) => (h.textContent || '').trim() === 'Axes') as HTMLElement | undefined;
    if (head && head.getAttribute('aria-expanded') !== 'true') head.click();
    (document.querySelector('#cm-format-mount [data-fmt-key="y2:sku"]') as HTMLElement | null)?.click();
  });
  await win.waitForTimeout(500);
  const dual = await win.evaluate(() => {
    const c = chartInstances.get(document.getElementById('viz-area') as Element);
    return c ? {
      axes: c.data.datasets.map((d: any) => d.label + '→' + (d.yAxisID || 'y')),
      right: !!(c.scales && c.scales.y1),
      rightTitle: !!document.querySelector('#cm-format-mount [data-fmt-key="y2:title"]'),
    } : null;
  });
  ok('format: a measure switched to the right axis draws on its own scale',
    !!dual && dual.right && dual.axes.join() === 'sum of amount→y,sku→y1' && dual.rightTitle, JSON.stringify(dual));
  await shot('format-menu-dual.png');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  // Leave the fixture's visual as the other sections found it.
  await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    await req('./src/analysis/visuals.js').updateVisual(arg.pid, arg.id, { overrides: arg.ov });
  }, { pid: fx.projectId, id: fx.visualId, ov: before });

  // ── 2. Two charts over one category column ─────────────────────────────────
  const ids: string[] = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const donut = await visuals.saveVisual(arg.pid, {
      datasetId: arg.ds, name: 'Amount share by region', chartType: 'donut',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
    });
    // Another measure, sorted Z → A — so it draws the regions in another order.
    const pie = await visuals.saveVisual(arg.pid, {
      datasetId: arg.ds, name: 'Notes by region', chartType: 'pie',
      encoding: { category: 'region', values: [{ column: 'note', aggregation: 'count' }] },
      overrides: { sort: 'label_desc' },
    });
    return [donut ? donut.id : '', pie ? pie.id : ''];
  }, { pid: fx.projectId, ds: fx.datasetId });
  await seedAnalysis(app, fx.projectId, {
    name: 'Format colours',
    sheets: [{ name: 'Sheet 1', cards: [
      { type: 'visual', visualId: ids[0], layout: { x: 0, y: 0, w: 6, h: 5 } },
      { type: 'visual', visualId: ids[1], layout: { x: 6, y: 0, w: 6, h: 5 } },
    ] }],
  });
  await win.evaluate(() => selectSection('analyses'));
  await win.waitForTimeout(1500);
  ok('format: the two-chart dashboard opens', await openSeededAnalysis(win, 'Format colours'));
  await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#dash-grid .cv-viz-area')].filter((a) => chartInstances.get(a)).length >= 2));
  const pair = await win.evaluate(() => {
    const charts = [...document.querySelectorAll('#dash-grid .cv-viz-area')].map((a) => chartInstances.get(a)).filter(Boolean);
    const colours = (type: string): Record<string, string> => {
      const c = charts.find((x: any) => x.config.type === type);
      if (!c) return {};
      const out: Record<string, string> = {};
      const bg = c.data.datasets[0].backgroundColor;
      c.data.labels.forEach((l: string, i: number) => { out[l] = Array.isArray(bg) ? bg[i] : String(bg); });
      return out;
    };
    const d = colours('doughnut');
    const p = colours('pie');
    return {
      donut: d, pie: p,
      donutOrder: Object.keys(d).join(), pieOrder: Object.keys(p).join(),
    };
  });
  const regions = Object.keys(pair.donut);
  ok('format: both charts drew the seven regions', regions.length === 7 && Object.keys(pair.pie).length === 7, JSON.stringify(pair));
  ok('format: …in different orders', pair.donutOrder !== pair.pieOrder, `${pair.donutOrder} | ${pair.pieOrder}`);
  ok('format: every region is the same colour in both charts',
    regions.length > 0 && regions.every((r) => pair.donut[r] === pair.pie[r]), JSON.stringify(pair));
  ok('format: seven regions, seven different colours', new Set(regions.map((r) => pair.donut[r])).size === 7);
  await shot('format-two-charts.png');
  // The donut's own ⋯ → Customize → Colours lists the same project colours.
  const menuColours = await win.evaluate(async () => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => { const a = c.querySelector('.cv-viz-area'); const ch = a && chartInstances.get(a); return ch && ch.config.type === 'doughnut'; });
    (card?.querySelector('.cv-chart-menu-btn') as HTMLElement | null)?.click();
    await new Promise((r) => setTimeout(r, 300));
    (document.getElementById('cm-customize-toggle') as HTMLElement | null)?.click();
    const head = [...document.querySelectorAll('#cm-format-mount .an-sec-head')]
      .find((h) => (h.textContent || '').trim() === 'Colours') as HTMLElement | undefined;
    head?.click();
    return document.querySelectorAll('#cm-format-mount .fmt-color-row').length;
  });
  ok('format: the donut\'s Format → Colours lists its seven regions', menuColours === 7, String(menuColours));
  await shot('format-menu-colours.png');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  // The analysis editor's Properties → Format tab carries the same panel.
  await railDriver(win).openPane('an-pane-props');
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card') as HTMLElement | null)?.click());
  await win.waitForTimeout(600);
  await win.evaluate(() => (document.getElementById('an-tab-format') as HTMLElement | null)?.click());
  const tab = await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#an-props .fmt-panel .fmt-color-row')].length === 7), 10_000);
  const tabSections = await win.evaluate(() => {
    const heads = [...document.querySelectorAll('#an-props .fmt-panel .an-sec-head')] as HTMLElement[];
    const colours = heads.find((h) => (h.textContent || '').trim() === 'Colours');
    // Open state is remembered across panels, so it may already be open.
    if (colours && colours.getAttribute('aria-expanded') !== 'true') colours.click();
    return heads.map((h) => (h.textContent || '').trim());
  });
  ok('format: the analysis Format tab has the same sections, colours included',
    tab && ['Data labels', 'Sort', 'Colours'].every((t) => tabSections.includes(t)), JSON.stringify(tabSections));
  await shot('format-analysis-tab.png');
  let project: any = null;
  await until(win, async () => {
    project = await mainRead(s, 'project', fx.projectId);
    return !!(project && project.colorMap && project.colorMap.region && Object.keys(project.colorMap.region).length === 7);
  }, 8000);
  const stored = (project && project.colorMap && project.colorMap.region) || {};
  ok('format: the project record holds the region colours they drew from',
    Object.keys(stored).length === 7 && Object.values(stored).every((t: any) => /^chart-[1-8]$/.test(t)), JSON.stringify(stored));

  // Leave the analysis (it owns the window while open).
  await win.evaluate(() => {
    const back = [...document.querySelectorAll('.dash-editor-head button')]
      .find((b) => /Back/.test(b.textContent || '')) as HTMLElement | undefined;
    back?.click();
  });
  await win.waitForTimeout(1200);

  // ── 3. Column profile → Colours ──────────────────────────────────────────
  await win.evaluate(() => selectSection('datasets'));
  await win.waitForTimeout(600);
  await win.evaluate((id: string) => openSavedDataset(id), fx.datasetId);
  await until(win, () => win.evaluate(() => document.querySelectorAll('#ds-explorer-scroll .ds-th').length > 0));
  await win.evaluate(() => {
    const i = [...document.querySelectorAll('#ds-explorer-scroll .ds-th')]
      .findIndex((th) => (th.textContent || '').trim().startsWith('region'));
    void dsOpenProfile(i >= 0 ? i : 0);
  });
  // VISIBLE rows: a hidden dataset page keeps its DOM, and counting that
  // proves nothing about what is on screen.
  const listed = await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#ds-profile .fmt-dsp-colors .fmt-color-row')].some((r) => r.getClientRects().length > 0)));
  const rows = await win.evaluate(() => [...document.querySelectorAll('#ds-profile .fmt-dsp-colors .fmt-color-row')]
    .map((r) => ({ name: (r.querySelector('.fmt-color-name')?.textContent || ''), auto: !!r.querySelector('.fmt-swatch.is-auto') })));
  ok('format: the region profile lists every value under Colours', listed && rows.length === 7, JSON.stringify(rows));
  ok('format: …each already coloured from the charts above', rows.length > 0 && rows.every((r) => !r.auto), JSON.stringify(rows));
  await shot('format-profile-colours.png');
  const target = rows[0] ? rows[0].name : '';
  const current = stored[target] || '';
  const slot = current === 'chart-8' ? 'chart-7' : 'chart-8';
  const picked = await win.evaluate((arg: { name: string; slot: string }) => {
    const row = [...document.querySelectorAll('#ds-profile .fmt-dsp-colors .fmt-color-row')]
      .find((r) => r.querySelector('.fmt-color-name')?.textContent === arg.name);
    const sw = row?.querySelector('.fmt-swatch') as HTMLElement | null;
    sw?.click();
    const picker = row?.nextElementSibling as HTMLElement | null;
    const b = picker && !picker.hidden ? picker.querySelector(`[data-token="${arg.slot}"]`) as HTMLElement | null : null;
    b?.click();
    return !!b;
  }, { name: target, slot });
  ok('format: a swatch opens the eight slots and one can be picked', picked);
  const persisted = await until(win, async () => {
    const p = await mainRead(s, 'project', fx.projectId);
    return !!(p && p.colorMap && p.colorMap.region && p.colorMap.region[target] === slot);
  }, 8000);
  ok(`format: ${target} → ${slot} is on the project record`, persisted);
  const repainted = await until(win, () => win.evaluate((arg: { name: string; n: string }) => {
    const row = [...document.querySelectorAll('#ds-profile .fmt-dsp-colors .fmt-color-row')]
      .find((r) => r.querySelector('.fmt-color-name')?.textContent === arg.name);
    return !!row && (row.querySelector('.fmt-swatch')?.getAttribute('aria-label') || '').endsWith(': colour ' + arg.n);
  }, { name: target, n: slot.slice(6) }), 5000);
  ok('format: the profile repaints the value in its new colour', repainted);

  await win.evaluate(() => { dsCloseProfile(); showHome(); });
  await win.waitForTimeout(500);
  const newErrors = s.errors.slice(errors0);
  ok('format: no renderer console error in the whole section', newErrors.length === 0, newErrors.join('\n'));
}
