// Round-8 smoke SECTION: small multiples, driven through the REAL app. Not a
// standalone smoke — scripts/smoke-round8.ts calls facetsSection(s, fx).
//
//   Seed a small dataset (West has no Tech) and a column chart faceted by
//   region → the builder draws one panel per region, titled as main says, on
//   one shared value axis with the y ticks drawn once → the Facet shelf adds
//   Rows = cat: a 3 × 3 matrix with the missing combination as an empty cell →
//   Independent scale → a click on a bar in a panel drills to THAT panel's rows
//   → an Average line is resolved per panel in main → the grid exports as one
//   image → the caption summarises across panels → a share chart over three
//   series draws through the same grid → the facet survives a save → the tile
//   draws as a grid on a dashboard. Cleans up everything it made.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page globals, read by bare name inside evaluate (see smoke-page-globals).
declare const chartInstances: any;
declare const drillFilters: any;
declare const drillTotal: any;
declare const vizAnalytics: any;
declare const selectSection: any;
declare const openSavedVisual: any;
declare const recomputeVisual: any;
declare const anpSetOverlays: any;
declare const vizEncodingForType: any;
declare const closeDrillPanel: any;
declare const closeVisualBuilder: any;
declare const captureChartPNG: any;
declare const renderVizInArea: any;
declare const currentProjectId: any;
declare const vizDatasetId: any;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

const count = (win: Win, sel: string): Promise<number> => win.evaluate((q: string) => document.querySelectorAll(q).length, sel);

const choose = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLSelectElement | null;
    if (!el || ![...el.options].some((o) => o.value === a.v)) return false;
    el.value = a.v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { q: sel, v: value });

/** The builder's panel charts: title, y max, y tick colour. */
const panels = (win: Win): Promise<{ title: string; max: number; tick: string }[]> => win.evaluate(() => {
  const inst = chartInstances.get(document.getElementById('viz-area'));
  return Array.isArray(inst) ? inst.map((c: any) => ({ title: c.$facet.title, max: c.scales.y.max, tick: String(c.options.scales.y.ticks.color) })) : [];
});

export async function facetsSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    if (a.fn === 'seed') {
      const rows: any[] = [];
      ['West', 'East', 'North'].forEach((r, ri) => ['Furniture', 'Office', 'Tech'].forEach((c, ci) => ['Jan', 'Feb', 'Mar', 'Apr'].forEach((m, mi) => {
        if (r === 'West' && c === 'Tech') return; // the missing combination
        rows.push([r, c, m, (ri + 1) * 10 + ci * 3 + mi]);
      })));
      const ds = await datasets.saveDataset(a.pid, { name: 'Facet demo', sourceKind: 'csv', rows,
        columns: [{ name: 'region', type: 'text' }, { name: 'cat', type: 'text' }, { name: 'month', type: 'text' }, { name: 'sales', type: 'number' }] });
      const v = await visuals.saveVisual(a.pid, { datasetId: ds.id, name: 'Sales by month, per region', chartType: 'column',
        encoding: { category: 'month', values: [{ column: 'sales', aggregation: 'sum' }], facet: { cols: 'region' } } });
      return { ds: ds.id, v: v.id };
    }
    if (a.fn === 'reply') {
      const { vizDataFor } = req('./src/ipc/visuals.js');
      return vizDataFor(a.pid, a.ds, visuals.sanitizeEncoding(a.encoding), []);
    }
    if (a.fn === 'caption') {
      const { vizDataFor } = req('./src/ipc/visuals.js');
      const r = await vizDataFor(a.pid, a.ds, visuals.sanitizeEncoding(a.encoding), []);
      return req('./src/analysis/captions.js').tileCaption({ chartType: 'column', data: r.data });
    }
    if (a.fn === 'rows') {
      const ds = await datasets.getDataset(a.pid, a.ds);
      const { applyPipeline } = req('./src/data/transforms.js');
      return applyPipeline({ columns: ds.columns, rows: ds.rows }, a.steps).rows.length;
    }
    if (a.fn === 'visual') return visuals.getVisual(a.pid, a.v);
    if (a.fn === 'cleanup') {
      const analysis = req('./src/analysis/analysis.js');
      for (const x of await analysis.listAnalyses(a.pid)) if (x.name === 'Facet board') await analysis.deleteAnalysis(a.pid, x.id);
      if (a.v) await visuals.deleteVisual(a.pid, a.v);
      if (a.ds) await datasets.deleteDataset(a.pid, a.ds);
      return true;
    }
    return null;
  }, { fn, pid, ...arg }) as Promise<T>;

  const seeded: { ds: string; v: string } = await main('seed');
  ok('facets: seeded a dataset and a faceted visual', !!seeded && !!seeded.v);
  if (!seeded || !seeded.v) return;
  const enc1 = { category: 'month', values: [{ column: 'sales', aggregation: 'sum' }], facet: { cols: 'region' } };

  try {
    // ── 1. The builder draws one panel per region ──────────────────────────
    await openProject(win, pid);
    await win.evaluate(() => selectSection('visuals'));
    await win.waitForTimeout(600);
    await win.evaluate((id: string) => openSavedVisual(id), seeded.v);
    ok('facets: the builder draws three panels', await until(win, async () => (await count(win, '#viz-area .fc-cell canvas')) === 3), String(await count(win, '#viz-area .fc-cell')));
    const reply: any = await main('reply', { ds: seeded.ds, encoding: enc1 });
    const drawn = await panels(win);
    ok('facets: panel titles are main\'s, in label order', JSON.stringify(drawn.map((p) => p.title)) === JSON.stringify(reply.data.facets.panels.map((p: any) => p.title))
      && drawn.map((p) => p.title).join() === 'East,North,West', JSON.stringify(drawn));
    ok('facets: shared scale — every panel on one value axis', drawn.length === 3 && drawn.every((p) => p.max === drawn[0].max), JSON.stringify(drawn));
    ok('facets: y ticks drawn once (left column only)', drawn[0].tick !== 'rgba(0,0,0,0)' && drawn.slice(1).some((p) => p.tick === 'rgba(0,0,0,0)'), JSON.stringify(drawn));
    await win.screenshot({ path: path.join(s.shotDir, 'r8-facets-wrap.png') }).catch(() => null);

    // ── 2. The shelf: Rows = cat makes a matrix with a missing combination ──
    ok('facets: the Facet shelf is in the builder', await count(win, '#viz-encoding-mount .fc-shelf:not([hidden])') === 1);
    ok('facets: Rows = cat', await choose(win, '#viz-encoding-mount .fc-shelf select[aria-label="Facet rows"]', 'cat'));
    ok('facets: a 3 × 3 matrix with headers', await until(win, async () => (await count(win, '#viz-area .fc-grid.is-matrix .fc-cell')) === 9));
    ok('facets: the matrix has column and row headers', (await count(win, '#viz-area .fc-head')) === 3 && (await count(win, '#viz-area .fc-rowhead')) === 3);
    ok('facets: West × Tech is one empty panel', (await count(win, '#viz-area .fc-cell.is-empty')) === 1
      && await win.evaluate(() => document.querySelector('#viz-area .fc-cell.is-empty')?.getAttribute('aria-label') === 'Tech · West'));
    await win.screenshot({ path: path.join(s.shotDir, 'r8-facets-matrix.png') }).catch(() => null);

    // ── 3. Independent scale ───────────────────────────────────────────────
    const sharedMax = (await panels(win)).map((p) => p.max);
    await win.evaluate(() => ([...document.querySelectorAll('#viz-encoding-mount .fc-shelf .seg-opt')].find((b) => b.textContent === 'Independent') as HTMLElement)?.click());
    ok('facets: Independent gives each panel its own axis', await until(win, async () => new Set((await panels(win)).map((p) => p.max)).size > 1), JSON.stringify(await panels(win)));
    ok('facets: shared had been one axis', new Set(sharedMax).size === 1, JSON.stringify(sharedMax));

    // ── 4. Drill: a bar in the "Furniture · East" panel → that panel's rows ─
    const at: any = await win.evaluate(() => {
      const inst = chartInstances.get(document.getElementById('viz-area'));
      const ch = inst.find((c: any) => c.$facet.title === 'Furniture · East');
      const el = ch.getDatasetMeta(0).data[0];
      const r = ch.canvas.getBoundingClientRect();
      return { x: r.left + el.x, y: r.top + el.y + Math.max(2, (el.base - el.y) / 2) };
    });
    await win.mouse.click(at.x, at.y);
    ok('facets: the click opens the drill panel', await until(win, () => win.evaluate(() => Array.isArray(drillFilters) && drillFilters.length > 0), 10_000));
    const fl: any[] = await win.evaluate(() => drillFilters);
    ok('facets: the drill carries the panel\'s facet values and the mark', ['region=East', 'cat=Furniture', 'month=Jan'].every((k) => fl.some((f) => `${f.column}=${f.value}` === k)), JSON.stringify(fl));
    const want = await main<number>('rows', { ds: seeded.ds, steps: [{ type: 'filter', column: 'region', op: '=', value: 'East' }, { type: 'filter', column: 'cat', op: '=', value: 'Furniture' }, { type: 'filter', column: 'month', op: '=', value: 'Jan' }] });
    ok('facets: the drilled rows are that panel\'s (main\'s count)', await until(win, () => win.evaluate((n: number) => drillTotal === n, want), 10_000), String(want));
    await win.evaluate(() => closeDrillPanel());

    // ── 5. Analytics per panel: an Average line is each panel's own ────────
    await win.evaluate(async () => { anpSetOverlays([{ id: 'avg1', kind: 'reference', value: { type: 'stat', stat: 'avg' } }]); await recomputeVisual(); });
    const perPanel: any[] = await win.evaluate(async () => {
      const r = await (window as any).hub.computeVisualData(currentProjectId, vizDatasetId, vizEncodingForType(), [], undefined, vizAnalytics);
      return r && r.ok ? r.data.facets.panels.filter((p: any) => !p.empty).map((p: any) => {
        const v = p.series[0].values.filter((x: any) => typeof x === 'number');
        return { got: p.analytics && p.analytics[0].value, want: v.reduce((a: number, b: number) => a + b, 0) / v.length };
      }) : [];
    });
    ok('facets: every panel\'s average line is its own mean (main)', perPanel.length === 8 && perPanel.every((p: any) => Object.is(p.got, p.want)), JSON.stringify(perPanel));
    ok('facets: the averages differ by panel', new Set(perPanel.map((p: any) => p.got)).size > 1);
    await win.evaluate(async () => { anpSetOverlays([]); await recomputeVisual(); });

    // ── 6. Export: the whole grid as one image ─────────────────────────────
    const img: any = await win.evaluate(async (data: any) => {
      const url = await captureChartPNG('column', data, {});
      if (!url) return null;
      const im = new Image();
      await new Promise((res) => { im.onload = res; im.src = url; });
      return { w: im.naturalWidth, h: im.naturalHeight };
    }, reply.data);
    ok('facets: the grid exports as ONE composite image', !!img && img.w >= 1000 && img.h >= 300, JSON.stringify(img));

    // ── 7. Caption across panels ───────────────────────────────────────────
    const cap = await main<string>('caption', { ds: seeded.ds, encoding: { category: 'cat', values: [{ column: 'sales', aggregation: 'sum' }], facet: { cols: 'region' } } });
    ok('facets: the caption summarises across panels', /^\w+ leads in (all 3|\d of 3) regions$/.test(cap), cap);

    // ── 8. A share chart over three series draws through the same grid ─────
    const share = await win.evaluate(() => {
      const box = document.createElement('div');
      box.className = 'cv-viz-area';
      document.body.appendChild(box);
      renderVizInArea(box, { labels: ['a', 'b'], series: [{ name: '2023', values: [1, 2] }, { name: '2024', values: [3, 4] }, { name: '2025', values: [5, 6] }] }, 'pie');
      const n = box.querySelectorAll('.fc-cell canvas').length;
      const inst = chartInstances.get(box);
      if (inst && inst.destroy) inst.destroy();
      box.remove();
      return n;
    });
    ok('facets: a pie over three series is a three-panel grid (one implementation)', share === 3, String(share));

    // ── 9. The facet survives a save ───────────────────────────────────────
    await win.evaluate(async (id: string) => { await (window as any).hub.updateVisual(currentProjectId, id, { encoding: vizEncodingForType() }); }, seeded.v);
    const saved: any = await main('visual', { v: seeded.v });
    ok('facets: the saved visual keeps Rows, Columns and the scale', !!saved && saved.encoding.facet && saved.encoding.facet.rows === 'cat'
      && saved.encoding.facet.cols === 'region' && saved.encoding.facet.scale === 'independent', JSON.stringify(saved && saved.encoding.facet));
    await win.evaluate(() => closeVisualBuilder());

    // ── 10. On a dashboard the tile is a grid ──────────────────────────────
    await seedAnalysis(app, pid, { name: 'Facet board', sheets: [{ name: 'Sheet 1', cards: [{ type: 'visual', visualId: seeded.v, layout: { x: 0, y: 0, w: 12, h: 8 } }] }] });
    await win.evaluate(() => selectSection('analyses'));
    await win.waitForTimeout(1000);
    ok('facets: the dashboard opens', await openSeededAnalysis(win, 'Facet board'));
    ok('facets: the tile draws the 3 × 3 grid', await until(win, async () => (await count(win, '#dash-grid .dash-card .fc-cell')) === 9), String(await count(win, '#dash-grid .dash-card .fc-cell')));
    await win.screenshot({ path: path.join(s.shotDir, 'r8-facets-dashboard.png') }).catch(() => null);
    await win.evaluate(() => (document.getElementById('dash-back-btn') as HTMLElement | null)?.click());
    await win.waitForTimeout(800);
  } finally {
    await main('cleanup', { ds: seeded.ds, v: seeded.v }).catch(() => null);
    await win.evaluate(() => {
      document.querySelectorAll('.ws-modal-overlay').forEach((o) => o.remove());
      selectSection('datasets');
    }).catch(() => null);
    await win.waitForTimeout(500);
  }
}
