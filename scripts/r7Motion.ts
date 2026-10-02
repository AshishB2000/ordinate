// Round-7 smoke SECTION: linked hover and data transitions, driven through the
// REAL app. Not a standalone smoke — scripts/smoke-round7.ts calls
// motionSection(s, fx) on its one launch and fixture.
//
//   A seeded dashboard — two charts on Sales.region (column + line), a KPI on
//   Sales.amount, the state map and a column chart on the same state column —
//   opens → a real mouse over one region bar lights the SAME region on the line
//   chart (its own active mark, its own tooltip, a crosshair) → over a state bar,
//   the map outlines that state; over the map, the bar lights → the pointer
//   leaves and everything lets go → a cross-filter: the column chart's canvas is
//   sampled mid-transition and after, the two differ, and the final frame is
//   what an animation-free redraw paints; the KPI shows in-between figures and
//   lands on exactly its final text → reduced motion: the same change is an
//   instant swap (no transition, no in-between figure) and lands on the same
//   text and the same pixels → filter, media and records restored. Leaves the
//   project's Data list on screen and nothing open.

import { ok } from './selfcheck';
import type { Smoke, Fixture, SeedCard } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

type Win = Smoke['win'];
// Page globals (chartRender.ts / mapRender.ts / dashFiltersUi.ts / dock.ts),
// read by bare name inside evaluate — never window.x.
declare const chartInstances: WeakMap<Element, any>;
declare const mapInstances: WeakMap<Element, any>;
declare function applyCrossFilter(column: string, value: unknown): void;
declare function chartMotionReduced(): boolean;
declare function dkSetOpen(open: boolean): void;
declare let dashCurrent: any;

const BOARD = 'Motion board';
const LINE = 'Motion · amount by region';
const STATES = 'Motion · revenue by state';
const COLUMN = 'Sales by region'; // fx.visualId
const MAP = 'Revenue by state'; // fx.mapVisualId

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

/** A chart card's state, by its title: the label of each active mark, the crosshair, the tooltip. */
const chartState = (win: Win, title: string): Promise<{ ready: boolean; active: string[]; cross: string | null; tip: number } | null> =>
  win.evaluate((t: string) => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === t);
    const area = card?.querySelector('.dash-viz-area');
    const ch = area ? chartInstances.get(area) : null;
    if (!ch || !ch.canvas) return null;
    const labels: unknown[] = ch.data.labels || [];
    return {
      ready: !ch.$mtTarget,
      active: ch.getActiveElements().map((a: any) => String(labels[a.index])),
      cross: ch.$lhIndex == null ? null : String(labels[ch.$lhIndex]),
      tip: ch.tooltip ? ch.tooltip.getActiveElements().length : 0,
    };
  }, title);

/** The page point over mark `label` of the chart titled `title` — mid-bar, in page pixels. */
const markPoint = (win: Win, title: string, label: string): Promise<{ x: number; y: number } | null> =>
  win.evaluate((a: { t: string; l: string }) => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === a.t);
    const area = card?.querySelector('.dash-viz-area');
    const ch = area ? chartInstances.get(area) : null;
    if (!ch) return null;
    card?.scrollIntoView({ block: 'center' });
    const i = (ch.data.labels || []).map(String).indexOf(a.l);
    const el = i >= 0 ? ch.getDatasetMeta(0).data[i] : null;
    if (!el) return null;
    const r = ch.canvas.getBoundingClientRect();
    const y = typeof el.base === 'number' ? (el.y + el.base) / 2 : el.y;
    return { x: r.left + el.x, y: r.top + y };
  }, { t: title, l: label });

interface Change {
  transition: boolean;
  hashes: number[]; // first sight, ~150 ms, final
  settled: number; // after chart.stop(); update('none') — the animation-free frame
  print: number[]; // the final frame scaled to 64×32 — for comparing two different canvases
  kpi: string[];
  kpiFinal: string;
  kpiBefore: string;
}

/**
 * Toggle the region filter and watch it land: the column chart's canvas at first
 * sight of the new chart, ~150 ms on and once settled, and every text the KPI showed.
 */
const change = (win: Win, chartTitle: string, kpiLabel: string): Promise<Change | null> =>
  win.evaluate(async (a: { t: string; k: string }) => {
    const cardBy = (pred: (c: Element) => boolean): Element | undefined =>
      [...document.querySelectorAll('#dash-grid .dash-card')].find(pred);
    const chartOf = (): any => {
      const area = cardBy((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === a.t)?.querySelector('.dash-viz-area');
      return area ? chartInstances.get(area) : null;
    };
    const kpi = (): HTMLElement | null => (cardBy((c) => (c.querySelector('.dash-metric-label')?.textContent || '').trim() === a.k)
      ?.querySelector('.dash-metric-value') as HTMLElement | null) || null;
    const hash = (c: HTMLCanvasElement): number => {
      const d = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4) { h ^= d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24); h = Math.imul(h, 16777619); }
      return h >>> 0;
    };
    const frame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
    const old = chartOf();
    const kpiBefore = (kpi()?.textContent || '').trim();
    const seen: string[] = [];
    const note = (): void => { const t = (kpi()?.textContent || '').trim(); if (t && seen[seen.length - 1] !== t) seen.push(t); };
    const grid = document.getElementById('dash-grid') as HTMLElement;
    const mo = new MutationObserver(note);
    mo.observe(grid, { subtree: true, childList: true, characterData: true });

    applyCrossFilter('region', 'region3');
    const t0 = performance.now();
    let ch: any = null;
    while (performance.now() - t0 < 10_000) {
      const c = chartOf();
      if (c && c !== old && c.canvas) { ch = c; break; }
      await frame();
    }
    if (!ch) { mo.disconnect(); return null; }
    const transition = !!ch.$mtTarget;
    const seenAt = performance.now();
    const hashes = [hash(ch.canvas)];
    while (performance.now() - seenAt < 150) await frame();
    hashes.push(hash(ch.canvas));
    while (ch.$mtTarget && performance.now() - seenAt < 5000) await frame();
    await new Promise((r) => setTimeout(r, 150));
    hashes.push(hash(ch.canvas));
    // Two canvases drawn by two draw sequences differ in anti-aliasing noise no
    // eye sees, so across charts the comparison is a coarse print, not a hash.
    const small = document.createElement('canvas');
    small.width = 64;
    small.height = 32;
    const sctx = small.getContext('2d') as CanvasRenderingContext2D;
    sctx.drawImage(ch.canvas, 0, 0, 64, 32);
    const print = [...sctx.getImageData(0, 0, 64, 32).data];
    ch.stop();
    ch.update('none');
    const settled = hash(ch.canvas);
    // The KPI: until it has stopped ticking and nothing is in flight.
    const k0 = performance.now();
    while (performance.now() - k0 < 5000) {
      const el = kpi();
      if (el && !el.classList.contains('is-ticking') && el.textContent !== '…' && performance.now() - k0 > 700) break;
      await frame();
    }
    note();
    mo.disconnect();
    return { transition, hashes, settled, print, kpi: seen, kpiFinal: (kpi()?.textContent || '').trim(), kpiBefore };
  }, { t: chartTitle, k: kpiLabel });

export async function motionSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const errors0 = s.errors.length;
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const analysis = req('./src/analysis/analysis.js');
    if (a.fn === 'visuals') {
      const line = await visuals.saveVisual(a.pid, { datasetId: a.sales, name: a.line, chartType: 'line',
        encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } });
      const bars = await visuals.saveVisual(a.pid, { datasetId: a.geo, name: a.states, chartType: 'column',
        encoding: { category: 'state', values: [{ column: 'revenue', aggregation: 'sum' }] } });
      return { line: line && line.id, bars: bars && bars.id };
    }
    if (a.fn === 'cleanup') {
      for (const v of await visuals.listVisuals(a.pid)) if (v.name === a.line || v.name === a.states) await visuals.deleteVisual(a.pid, v.id);
      for (const x of await analysis.listAnalyses(a.pid)) if (x.name === a.board) await analysis.deleteAnalysis(a.pid, x.id);
      return true;
    }
    return null;
  }, { fn, pid, sales: fx.datasetId, geo: fx.geoDatasetId, line: LINE, states: STATES, board: BOARD, ...arg }) as Promise<T>;

  const v = await main<{ line: string; bars: string }>('visuals');
  ok('motion: seeded a line on Sales.region and bars on the map\'s state column', !!(v && v.line && v.bars));
  const cards: SeedCard[] = [
    { type: 'metric', metric: { datasetId: fx.datasetId, column: 'amount', aggregation: 'sum', label: 'Motion total' }, layout: { x: 0, y: 0, w: 3, h: 2 } },
    { type: 'visual', visualId: fx.visualId, layout: { x: 0, y: 2, w: 6, h: 5 } },
    { type: 'visual', visualId: v.line, layout: { x: 6, y: 2, w: 6, h: 5 } },
    { type: 'visual', visualId: fx.mapVisualId, layout: { x: 0, y: 7, w: 6, h: 6 } },
    { type: 'visual', visualId: v.bars, layout: { x: 6, y: 7, w: 6, h: 6 } },
  ];
  await seedAnalysis(app, pid, { name: BOARD, sheets: [{ name: 'Sheet 1', cards }] });

  try {
    await openProject(win, pid);
    await win.evaluate(() => { (window as any).selectSection('analyses'); });
    await win.waitForTimeout(1000);
    ok('motion: the dashboard opens', await openSeededAnalysis(win, BOARD));
    ok('motion: all four charts drawn', await until(win, async () =>
      !!(await chartState(win, COLUMN)) && !!(await chartState(win, LINE)) && !!(await chartState(win, STATES))
      && await win.evaluate((t: string) => {
        const card = [...document.querySelectorAll('#dash-grid .dash-card')]
          .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === t);
        const area = card?.querySelector('.dash-viz-area');
        const map = area ? mapInstances.get(area) : null;
        return !!(map && map.getLayer('lh-hl'));
      }, MAP), 30_000));
    await win.waitForTimeout(600); // the first draws' own grow-in

    // ── Linked hover: chart → chart ────────────────────────────────────────
    const p = await markPoint(win, COLUMN, 'region2');
    ok('hover: found region2\'s bar', !!p);
    if (p) await win.mouse.move(p.x, p.y, { steps: 4 });
    await win.waitForTimeout(250);
    const line = await chartState(win, LINE);
    ok('hover: the line chart lights region2 — its own marks',
      !!line && line.active.length > 0 && line.active.every((l) => l === 'region2'), JSON.stringify(line));
    ok('hover: …with a crosshair there', !!line && line.cross === 'region2', JSON.stringify(line));
    ok('hover: …and its own tooltip with its value', !!line && line.tip > 0, JSON.stringify(line));
    const src = await chartState(win, COLUMN);
    ok('hover: the hovered chart draws the crosshair too', !!src && src.cross === 'region2', JSON.stringify(src));
    const other = await chartState(win, STATES);
    ok('hover: a chart on another dimension stays still', !!other && other.active.length === 0 && other.cross === null, JSON.stringify(other));

    // ── Linked hover: chart → map, map → chart ────────────────────────────
    const tx = await markPoint(win, STATES, 'Texas');
    if (tx) await win.mouse.move(tx.x, tx.y, { steps: 4 });
    await win.waitForTimeout(300);
    const mapFilter = (): Promise<string> => win.evaluate((t: string) => {
      const card = [...document.querySelectorAll('#dash-grid .dash-card')]
        .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === t);
      const map = mapInstances.get(card?.querySelector('.dash-viz-area') as Element);
      return JSON.stringify(map ? map.getFilter('lh-hl') : null);
    }, MAP);
    ok('hover: a state bar outlines that state on the map', (await mapFilter()).includes('"Texas"'), await mapFilter());
    ok('hover: the region charts let go of region2', ((await chartState(win, LINE))?.active.length || 0) === 0);
    const onMap = await win.evaluate((t: string) => {
      const card = [...document.querySelectorAll('#dash-grid .dash-card')]
        .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === t);
      card?.scrollIntoView({ block: 'center' });
      const map = mapInstances.get(card?.querySelector('.dash-viz-area') as Element);
      if (!map) return null;
      const pt = map.project([-99.3, 31.3]);
      const r = map.getCanvas().getBoundingClientRect();
      return { x: r.left + pt.x, y: r.top + pt.y };
    }, MAP);
    if (onMap) await win.mouse.move(onMap.x, onMap.y, { steps: 6 });
    await win.waitForTimeout(400);
    const lit = await chartState(win, STATES);
    ok('hover: over Texas on the map, the state bars light Texas',
      !!lit && lit.active.length > 0 && lit.active.every((l) => l === 'Texas') && lit.tip > 0, JSON.stringify(lit));
    await win.mouse.move(4, 4, { steps: 3 });
    await win.waitForTimeout(300);
    const after = await chartState(win, STATES);
    ok('hover: the pointer leaves, everything lets go',
      !!after && after.active.length === 0 && after.cross === null && !(await mapFilter()).includes('Texas'), JSON.stringify(after) + (await mapFilter()));

    // ── Transitions ───────────────────────────────────────────────────────
    const moving = await change(win, COLUMN, 'Motion total'); // → region3
    ok('transition: a filter change animates the chart from old to new', !!moving && moving.transition, JSON.stringify(moving));
    if (moving) {
      const [first, mid, last] = moving.hashes;
      ok('transition: mid-transition pixels differ from the final frame', first !== last && mid !== last, JSON.stringify(moving.hashes));
      ok('transition: the final frame is the animation-free one', last === moving.settled, `${last} vs ${moving.settled}`);
      const between = moving.kpi.filter((t) => t !== moving.kpiBefore && t !== moving.kpiFinal && t !== '…');
      ok('ticker: the KPI shows in-between figures', between.length > 0, JSON.stringify(moving.kpi));
      ok('ticker: …and ends on exactly its final text', moving.kpi[moving.kpi.length - 1] === moving.kpiFinal
        && moving.kpiFinal !== moving.kpiBefore, JSON.stringify(moving.kpi));
    }

    // ── Reduced motion: instant swaps, the same destination ───────────────
    await win.emulateMedia({ reducedMotion: 'reduce' });
    ok('reduced: the app hears prefers-reduced-motion live', await win.evaluate(() => chartMotionReduced()));
    const back = await change(win, COLUMN, 'Motion total'); // → unfiltered
    const again = await change(win, COLUMN, 'Motion total'); // → region3 again
    ok('reduced: no transition — the new chart is simply drawn', !!back && !!again && !back.transition && !again.transition);
    if (back && again && moving) {
      ok('reduced: the first sight IS the final frame', again.hashes[0] === again.hashes[2], JSON.stringify(again.hashes));
      // Off by more than noise in under 1% of the print's channels: the same picture.
      const off = again.print.filter((v, i) => Math.abs(v - moving.print[i]) > 6).length;
      ok('reduced: the same picture the animation landed on',
        again.print.length === moving.print.length && off < again.print.length / 100, off + ' of ' + again.print.length + ' channels differ');
      ok('reduced: the KPI swaps with no in-between figure',
        again.kpi.every((t) => t === again.kpiBefore || t === again.kpiFinal || t === '…'), JSON.stringify(again.kpi));
      ok('reduced: …to the same text the ticker landed on', again.kpiFinal === moving.kpiFinal, `${again.kpiFinal} vs ${moving.kpiFinal}`);
      ok('reduced: and back again to the unfiltered figure', back.kpiFinal === moving.kpiBefore, `${back.kpiFinal} vs ${moving.kpiBefore}`);
    }
    await change(win, COLUMN, 'Motion total'); // → unfiltered, as found
    ok('motion: the filter is cleared again', await win.evaluate(() => !!dashCurrent && dashCurrent.filters.length === 0));
  } finally {
    await win.emulateMedia({ reducedMotion: null });
    await win.mouse.move(4, 4);
    await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(800);
    await win.evaluate(() => { if (typeof dkSetOpen === 'function') dkSetOpen(false); (window as any).selectSection('datasets'); });
    await win.waitForTimeout(600);
    await main('cleanup');
  }
  ok('motion: back on the project\'s Data list, the editor closed',
    await win.evaluate(() => (document.getElementById('dash-editor') as HTMLElement).hidden === true));
  const errs = s.errors.slice(errors0);
  ok('motion: no renderer console error in the section', errs.length === 0, errs.join('\n'));
}
