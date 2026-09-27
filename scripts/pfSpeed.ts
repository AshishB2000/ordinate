// Platform depth, feature 1 — speed and background jobs, driven in the REAL
// app on the 1M-row smoke fixture. A SECTION of scripts/smoke-platform.ts.
//
// It MEASURES the four targets and prints them in one table (the PR quotes
// that table):
//   • a six-tile dashboard open — cold (first open, empty answer cache) and
//     warm (re-open) — timed from openAnalysis() to every tile drawn;
//   • a chart-type switch in the builder, click to the next painted frame;
//   • a 1M-row CSV import through the UI (pick → composer → Save), with the
//     Jobs popover showing it running with a progress bar.
// The budgets (800 ms / 2.5 s / 150 ms / 20 s) are asserted with a CI margin
// only when SMOKE_STRICT_PERF is unset — shared CI runners under xvfb are
// several times slower than a laptop, and a perf number that fails on runner
// noise teaches people to ignore red. Locally, SMOKE_STRICT_PERF=1 asserts the
// exact targets.
//
// It also proves the mechanics behind the numbers: the warm open was served
// by the answer cache (residentTrace `cache:*` hits), the builder previews a
// no-fast-path chart on a stated sample, and the dataset grid is virtual — a
// million-row table puts ~one screen of <tr> in the DOM and scrolls to the
// middle on demand.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { seedAnalysis, openProject } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

// Hub script-globals, read by bare name inside page callbacks (classic-script
// lexical globals are not on window; eval is CSP-blocked).
declare const chartInstances: { get(el: unknown): any };
declare const expTotal: number;

export interface SpeedReport {
  dashColdMs: number;
  dashWarmMs: number;
  typeSwitchMs: number;
  importMs: number;
}

const TARGET = { dashWarm: 800, dashCold: 2500, typeSwitch: 150, importMs: 20_000 };
const STRICT = process.env.SMOKE_STRICT_PERF === '1';
const MARGIN = STRICT ? 1 : 3;

/** What every tile is showing — the failure detail when a timing never completes. */
async function tileStates(s: Smoke): Promise<string> {
  return s.win.evaluate(() => JSON.stringify([...document.querySelectorAll('#dash-grid .dash-card')].map((c) => {
    const body = c.querySelector('.dash-card-body');
    return {
      busy: body ? body.getAttribute('aria-busy') : null,
      skel: !!(body && body.querySelector('.sk-wrap')),
      metric: body && body.querySelector('.dash-metric-value') ? body.querySelector('.dash-metric-value')!.textContent : undefined,
      canvas: !!(body && body.querySelector('canvas')),
      text: body ? (body.textContent || '').slice(0, 60) : '',
    };
  })));
}

/** Open a dashboard and wait for every tile to be drawn. Returns ms. */
async function timeDashboardOpen(s: Smoke, analysisId: string, tiles: number): Promise<number> {
  return s.win.evaluate(async (arg: { id: string; tiles: number }) => {
    const t0 = performance.now();
    await (window as any).openAnalysis(arg.id);
    const drawn = (): boolean => {
      const cards = [...document.querySelectorAll('#dash-grid .dash-card')];
      if (cards.length < arg.tiles) return false;
      return cards.every((c) => {
        const body = c.querySelector('.dash-card-body');
        if (!body || body.getAttribute('aria-busy') === 'true' || body.querySelector('.sk-wrap')) return false;
        const metric = body.querySelector('.dash-metric-value');
        if (metric) return (metric.textContent || '').trim() !== '…';
        return !!body.querySelector('canvas, table');
      });
    };
    for (;;) {
      if (drawn()) break;
      if (performance.now() - t0 > 60_000) return -1;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    return Math.round(performance.now() - t0);
  }, { id: analysisId, tiles });
}

export async function speedSection(s: Smoke, fx: Fixture): Promise<SpeedReport> {
  const { app, win } = s;
  const report: SpeedReport = { dashColdMs: -1, dashWarmMs: -1, typeSwitchMs: -1, importMs: -1 };

  // ── A six-tile dashboard over the 1M-row Sales dataset ─────────────────────
  const visualIds: string[] = await app.evaluate(async (_e, arg: { pid: string; ds: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const specs = [
      { name: 'Units by sku', chartType: 'bar', encoding: { category: 'sku', values: [{ column: 'amount', aggregation: 'count' }] } },
      { name: 'Average by region', chartType: 'line', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'avg' }] } },
      { name: 'Share by region', chartType: 'pie', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } },
    ];
    const out: string[] = [];
    for (const v of specs) {
      const saved = await visuals.saveVisual(arg.pid, { datasetId: arg.ds, ...v });
      out.push(saved.id);
    }
    return out;
  }, { pid: fx.projectId, ds: fx.datasetId });
  const analysisId = await seedAnalysis(app, fx.projectId, {
    name: 'Speed dashboard',
    sheets: [{
      name: 'Sheet 1',
      cards: [
        { type: 'metric', metric: { datasetId: fx.datasetId, column: 'amount', aggregation: 'sum', label: 'Revenue' }, layout: { x: 0, y: 0, w: 3, h: 2 } },
        { type: 'metric', metric: { datasetId: fx.datasetId, column: 'amount', aggregation: 'avg', label: 'Average' }, layout: { x: 3, y: 0, w: 3, h: 2 } },
        { type: 'visual', visualId: fx.visualId, layout: { x: 0, y: 2, w: 6, h: 6 } },
        { type: 'visual', visualId: visualIds[0], layout: { x: 6, y: 2, w: 6, h: 6 } },
        { type: 'visual', visualId: visualIds[1], layout: { x: 0, y: 8, w: 6, h: 6 } },
        { type: 'visual', visualId: visualIds[2], layout: { x: 6, y: 8, w: 6, h: 6 } },
      ],
    }],
  });
  ok('speed: seeded a six-tile dashboard over the 1M-row dataset', Boolean(analysisId) && visualIds.length === 3);

  await openProject(win, fx.projectId);
  // From the Dashboards list — where a user opens one — for BOTH timings.
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(800);
  await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    req('./src/engine/queryCache.js').clear(); // COLD: nothing answered yet
    req('./src/engine/residentTrace.js').reset();
  });
  report.dashColdMs = await timeDashboardOpen(s, analysisId, 6);
  ok(`speed: cold dashboard open drew all six tiles (${report.dashColdMs} ms)`, report.dashColdMs > 0, await tileStates(s));
  ok(`speed: cold open within ${TARGET.dashCold * MARGIN} ms`, report.dashColdMs > 0 && report.dashColdMs < TARGET.dashCold * MARGIN, report.dashColdMs);

  // WARM: leave, come back. Same questions, unchanged data.
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(800);
  report.dashWarmMs = await timeDashboardOpen(s, analysisId, 6);
  ok(`speed: warm dashboard open drew all six tiles (${report.dashWarmMs} ms)`, report.dashWarmMs > 0);
  ok(`speed: warm open within ${TARGET.dashWarm * MARGIN} ms`, report.dashWarmMs > 0 && report.dashWarmMs < TARGET.dashWarm * MARGIN, report.dashWarmMs);
  const trace = await app.evaluate(() => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/engine/residentTrace.js').snapshot();
  });
  const agg = trace['cache:aggregate'] || { hit: 0, miss: 0 };
  const met = trace['cache:metric'] || { hit: 0, miss: 0 };
  ok('speed: the warm open was answered from the cache (4 chart + 2 KPI hits)',
    agg.hit >= 4 && met.hit >= 2, JSON.stringify({ agg, met }));
  ok('speed: …and the cold one computed them (misses recorded)', agg.miss >= 4 && met.miss >= 2);

  // ── Builder: a chart-type switch ───────────────────────────────────────────
  await win.evaluate(async (id: string) => {
    (window as any).selectSection('visuals');
    await (window as any).openSavedVisual(id);
  }, fx.visualId);
  await win.waitForSelector('#viz-area canvas', { timeout: 30_000 }).catch(() => {});
  report.typeSwitchMs = await win.evaluate(async () => {
    // chartInstances is keyed by the chart AREA, not the canvas.
    const area = document.getElementById('viz-area');
    const before = area ? chartInstances.get(area) : null;
    const beforeCanvas = area ? area.querySelector('canvas') : null;
    const chips = [...document.querySelectorAll('#viz-switcher-mount .cv-viz-chip')] as HTMLElement[];
    // The saved visual is a column chart; switch it to a bar chart.
    const next = chips.find((c) => c.dataset.type === 'bar') || chips.find((c) => c.dataset.type === 'line');
    if (!next || !area) return -1;
    const t0 = performance.now();
    next.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    const after = chartInstances.get(area);
    const redrawn = !!after && (after !== before || area.querySelector('canvas') !== beforeCanvas);
    return redrawn ? Math.round(performance.now() - t0) : -1;
  });
  ok(`speed: a builder type switch redraws (${report.typeSwitchMs} ms)`, report.typeSwitchMs >= 0,
    await win.evaluate(() => JSON.stringify({
      chips: [...document.querySelectorAll('#viz-switcher-mount .cv-viz-chip')].map((c) => (c as HTMLElement).dataset.type + ((c as HTMLElement).classList.contains('is-on') ? '*' : '')),
      canvas: !!document.querySelector('#viz-area canvas'),
    })));
  ok(`speed: type switch within ${TARGET.typeSwitch * MARGIN} ms`, report.typeSwitchMs >= 0 && report.typeSwitchMs < TARGET.typeSwitch * MARGIN, report.typeSwitchMs);

  // A split series has no resident fast path: over 250k rows the builder
  // previews it on a stated sample instead of hydrating a million rows.
  const sample = await win.evaluate(async (arg: { pid: string; ds: string }) => {
    const res = await (window as any).hubPlatform.previewVisualData(arg.pid, arg.ds,
      { category: 'region', series: 'sku', values: [{ column: 'amount', aggregation: 'sum' }] }, []);
    return res && res.sample ? res.sample : null;
  }, { pid: fx.projectId, ds: fx.datasetId });
  ok('speed: the builder previews a no-fast-path chart on a sample of a 1M-row table',
    !!sample && sample.of === 1_000_000 && sample.rows > 240_000 && sample.rows < 260_000, JSON.stringify(sample));
  ok('speed: …stratified by the category, and saying so ("Preview computed on 250k of 1M rows")',
    !!sample && sample.by === 'region' && sample.note === 'Preview computed on 250k of 1M rows', sample && sample.note);
  const full = await win.evaluate(async (arg: { pid: string; ds: string }) => {
    const res = await (window as any).hub.computeVisualData(arg.pid, arg.ds,
      { category: 'region', series: 'sku', values: [{ column: 'amount', aggregation: 'sum' }] }, []);
    return { ok: !!(res && res.ok), sampled: !!(res && res.sample) };
  }, { pid: fx.projectId, ds: fx.datasetId });
  ok('speed: …while visual:data (Save, dashboards) computes the same chart in full', full.ok && !full.sampled);

  // ── The dataset grid is virtual ────────────────────────────────────────────
  await win.evaluate(async (id: string) => {
    (window as any).selectSection('datasets');
    await (window as any).openSavedDataset(id);
  }, fx.datasetId);
  await win.waitForSelector('#ds-explorer-scroll table.ds-table.is-virtual tbody tr', { timeout: 30_000 }).catch(() => {});
  const grid = await win.evaluate(() => {
    const host = document.getElementById('ds-explorer-scroll') as HTMLElement;
    const rows = host.querySelectorAll('tbody tr:not(.ds-vspacer)').length;
    return { rows, total: expTotal, height: host.scrollHeight, rowcount: host.querySelector('table')?.getAttribute('aria-rowcount') };
  });
  ok('speed: the dataset grid knows all 1,000,000 rows', grid.total === 1_000_000 && grid.rowcount === '1000001', JSON.stringify(grid));
  ok('speed: …but only ~one screen of them is in the DOM', grid.rows > 5 && grid.rows < 400, grid.rows);
  // Compressed above 8 M px (Chromium clamps element heights at ~16.7 M), so
  // the whole table is reachable rather than one row per 28 px.
  ok('speed: …in a scroll space that stays under the browser\'s height clamp', grid.height > 7_000_000 && grid.height < 16_000_000, grid.height);
  await win.evaluate(() => {
    const host = document.getElementById('ds-explorer-scroll') as HTMLElement;
    host.scrollTop = host.scrollHeight / 2;
  });
  await win.waitForFunction(() => {
    const host = document.getElementById('ds-explorer-scroll') as HTMLElement;
    return !host.querySelector('tbody tr.ds-tr-loading') && /Rows 4\d\d,\d{3}|Rows 5\d\d,\d{3}/.test(document.getElementById('ds-explorer-note')?.textContent || '');
  }, null, { timeout: 30_000 }).catch(() => {});
  const mid = await win.evaluate(() => ({
    note: document.getElementById('ds-explorer-note')?.textContent || '',
    rows: document.querySelectorAll('#ds-explorer-scroll tbody tr:not(.ds-vspacer)').length,
    loading: document.querySelectorAll('#ds-explorer-scroll tbody tr.ds-tr-loading').length,
  }));
  ok('speed: scrolling to the middle fetches and draws rows ~500,000', /Rows (4\d\d|5\d\d),\d{3}/.test(mid.note) && mid.loading === 0, JSON.stringify(mid));
  await win.evaluate(() => {
    const host = document.getElementById('ds-explorer-scroll') as HTMLElement;
    host.scrollTop = host.scrollHeight;
  });
  const end = await win.waitForFunction(() => {
    const t = document.getElementById('ds-explorer-note')?.textContent || '';
    return /–1,000,000 of 1,000,000/.test(t) && !document.querySelector('#ds-explorer-scroll tbody tr.ds-tr-loading') ? t : null;
  }, null, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => '');
  ok('speed: …and to the very end: the last row of a million is reachable', Boolean(end), String(end));

  // ── Import 1M rows through the UI, as a job ────────────────────────────────
  const csv = path.join(s.userData, 'million.csv');
  {
    const out = fs.openSync(csv, 'w');
    fs.writeSync(out, 'order_id,region,sku,amount,day\n');
    let buf = '';
    for (let i = 0; i < 1_000_000; i++) {
      buf += `${i},region${i % 7},${String(i % 500).padStart(3, '0')},${(i % 97) - 10},2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}\n`;
      if (buf.length > 1 << 20) { fs.writeSync(out, buf); buf = ''; }
    }
    fs.writeSync(out, buf);
    fs.closeSync(out);
  }
  await app.evaluate(async (electronModule, file: string) => {
    (electronModule as any).dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, csv);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(500);
  const t0 = Date.now();
  await win.evaluate(() => { (document.getElementById('ds-import-open') as HTMLElement).click(); });
  // Reading the file is itself a job: the button spins while it parses.
  await win.waitForFunction(() => document.getElementById('topbar-jobs')?.classList.contains('is-busy'), null, { timeout: 20_000 }).catch(() => {});
  await win.waitForSelector('#dc-save', { state: 'visible', timeout: 60_000 });
  await win.evaluate(() => {
    const name = document.getElementById('dc-name') as HTMLInputElement;
    name.value = 'Million';
    (document.getElementById('dc-save') as HTMLElement).click();
  });
  // While it saves: the Jobs popover lists it RUNNING, with a progress bar.
  await win.waitForFunction(() => document.getElementById('topbar-jobs')?.classList.contains('is-busy'), null, { timeout: 20_000 }).catch(() => {});
  await win.evaluate(() => { (document.getElementById('topbar-jobs') as HTMLElement).click(); });
  const running = await win.waitForFunction(() => {
    const row = document.querySelector('#jp-pop .jp-row--running');
    return row ? { label: row.querySelector('.jp-name')?.textContent || '', bar: !!row.querySelector('.jp-bar[role=progressbar]') } : null;
  }, null, { timeout: 20_000 }).then((h) => h.jsonValue()).catch(() => null);
  ok('speed: the import shows in the Jobs popover as running, with a progress bar',
    !!running && /Import Million/.test(running.label) && running.bar, JSON.stringify(running));
  const done = await win.waitForFunction(() => {
    const row = [...document.querySelectorAll('#jp-pop .jp-row--done')].find((r) => /Import Million/.test(r.textContent || ''));
    return row ? (row.querySelector('.jp-msg')?.textContent || 'done') : null;
  }, null, { timeout: 120_000 }).then((h) => h.jsonValue()).catch(() => null);
  report.importMs = Date.now() - t0;
  ok('speed: the import job finished and says how many rows it saved', !!done && /1,000,000 rows saved/.test(String(done)), String(done));
  ok(`speed: import of 1M rows within ${TARGET.importMs * MARGIN} ms (${report.importMs} ms)`, report.importMs < TARGET.importMs * MARGIN, report.importMs);
  const saved = await app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const list = await req('./src/data/datasets.js').listDatasets(pid);
    const m = list.find((d: any) => d.name === 'Million');
    return m ? m.rowCount : -1;
  }, fx.projectId);
  ok('speed: the imported dataset has every row', saved === 1_000_000, saved);
  await win.evaluate(() => { (document.getElementById('topbar-jobs') as HTMLElement).click(); }); // close

  console.log('');
  console.log('  Platform speed (1M-row fixture)          measured    target');
  console.log(`  dashboard open, six tiles — cold      ${String(report.dashColdMs).padStart(8)} ms   < ${TARGET.dashCold} ms`);
  console.log(`  dashboard open, six tiles — warm      ${String(report.dashWarmMs).padStart(8)} ms   < ${TARGET.dashWarm} ms`);
  console.log(`  builder chart-type switch             ${String(report.typeSwitchMs).padStart(8)} ms   < ${TARGET.typeSwitch} ms`);
  console.log(`  import 1,000,000 rows (pick → saved)  ${String(report.importMs).padStart(8)} ms   < ${TARGET.importMs} ms`);
  console.log('');
  return report;
}
