// Smoke SECTION: the waterfall, bullet, calendar heatmap, radar and Pareto
// charts, built through the Visuals builder on the bundled sample.
//
// Not a smoke file of its own: `chartsSection(s)` runs against an app someone
// else launched, on a FRESH userData whose first-launch sample is already
// seeded ("My project" / "Retail orders"). It drives the builder the way a user
// does — New → the sample → Build it myself → encoding → chart picker → Save —
// and checks, per chart, that a real <canvas> of real size drew the Chart.js
// type it should and that the visual lands in the gallery.
//
// The one FIGURE it checks is the Pareto caption's 80% count, and the expected
// count is computed HERE, from assets/samples/retail-orders.csv, with this
// file's own arithmetic — never read back from the app it is testing.

import { ok } from './selfcheck';
import { REPO, domDriver } from './smokeFixture';
import type { Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];

/** sum(revenue) by sub_category off the committed CSV → categories, and how many make 80%. */
function paretoFromCsv(): { categories: number; count80: number } {
  const lines = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',');
  const cat = head.indexOf('sub_category');
  const rev = head.indexOf('revenue');
  const sums = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const cells = line.split(','); // the sample has no quoted fields (asserted below)
    sums.set(cells[cat], (sums.get(cells[cat]) || 0) + Number(cells[rev]));
  }
  const vals = [...sums.values()].filter((v) => v > 0).sort((a, b) => b - a);
  const total = vals.reduce((a, v) => a + v, 0);
  let cum = 0;
  let count80 = vals.length;
  for (let i = 0; i < vals.length; i++) {
    cum += vals[i];
    if (cum >= total * 0.8) { count80 = i + 1; break; }
  }
  return { categories: sums.size, count80 };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Visuals → New → the sample → "Build it myself". */
export async function openBuilder(win: Win): Promise<boolean> {
  const { clickExact, clickId } = domDriver(win);
  await clickExact('Visuals');
  await win.waitForTimeout(900);
  if (!(await clickId('viz-new-btn'))) return false;
  await win.waitForTimeout(900);
  const picked = await win.evaluate(() => {
    const row = [...document.querySelectorAll('.vn-row')]
      .find((x) => /Retail orders/i.test(x.textContent || '')) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    const manual = document.querySelector('.js-vn-manual') as HTMLElement | null;
    if (!manual) return false;
    manual.click();
    return true;
  });
  if (!picked) return false;
  await win.waitForTimeout(2500);
  return win.evaluate(() => (document.getElementById('viz-builder') as HTMLElement).hidden === false);
}

/** Category + measures, through the form's own selects and buttons. */
export async function setEncoding(win: Win, category: string, measures: string[]): Promise<boolean> {
  const done = await win.evaluate(async (arg: { category: string; measures: string[] }) => {
    const box = document.getElementById('ws-visuals') as HTMLElement;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const cat = box.querySelector('.js-enc-cat') as HTMLSelectElement | null;
    if (!cat) return false;
    cat.value = arg.category;
    if (cat.value !== arg.category) return false;
    cat.dispatchEvent(new Event('change', { bubbles: true }));
    await pause(600);
    while (box.querySelectorAll('.viz-value-row').length < arg.measures.length) {
      (box.querySelector('.js-enc-add-value') as HTMLElement).click();
      await pause(400);
    }
    for (let i = 0; i < arg.measures.length; i++) {
      const sel = box.querySelectorAll('.viz-value-col')[i] as HTMLSelectElement | undefined;
      if (!sel) return false;
      sel.value = arg.measures[i];
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await pause(400);
    }
    return true;
  }, { category, measures });
  await win.waitForTimeout(2000);
  return done;
}

/** The picker the user has: a chip, else "+ More" and the tile. */
export async function pickType(win: Win, label: string): Promise<boolean> {
  const direct = await win.evaluate((l: string) => {
    const chip = [...document.querySelectorAll('#viz-switcher-mount .cv-viz-chip')]
      .find((b) => (b.textContent || '').trim() === l) as HTMLElement | undefined;
    if (chip) { chip.click(); return true; }
    const more = [...document.querySelectorAll('#viz-switcher-mount button')]
      .find((b) => /More/i.test(b.textContent || '')) as HTMLElement | undefined;
    if (more) more.click();
    return false;
  }, label);
  if (direct) return true;
  await win.waitForTimeout(500);
  return win.evaluate((l: string) => {
    const tile = [...document.querySelectorAll('.cv-more-panel .cv-more-item')]
      .find((b) => (b.textContent || '').trim().startsWith(l)) as HTMLElement | undefined;
    if (!tile) return false;
    tile.click();
    return true;
  }, label);
}

/** What drew in the builder: canvas size and the live Chart.js instance's type. */
async function readChart(win: Win): Promise<{ w: number; h: number; type: string; points: number; labels: number }> {
  await win.waitForFunction(() => {
    const c = document.querySelector('#viz-area canvas') as HTMLCanvasElement | null;
    return !!c && c.width > 0;
  }, undefined, { timeout: 30_000 }).catch(() => {});
  await win.waitForTimeout(800);
  return win.evaluate(() => {
    const area = document.getElementById('viz-area') as HTMLElement;
    const canvas = area.querySelector('canvas') as HTMLCanvasElement | null;
    // chartInstances is a top-level const of chartRender.js — global lexical scope.
    const chart = (globalThis as any).eval('chartInstances').get(area);
    return {
      w: canvas ? canvas.width : 0,
      h: canvas ? canvas.height : 0,
      type: chart ? String(chart.config.type) : '',
      points: chart ? chart.data.datasets.reduce((n: number, d: any) => n + d.data.length, 0) : 0,
      labels: chart ? chart.data.labels.length : 0,
    };
  });
}

export async function save(win: Win, name: string): Promise<boolean> {
  const { clickId, fillPrompt } = domDriver(win);
  if (!(await clickId('viz-save-btn'))) return false;
  await win.waitForTimeout(600);
  if (!(await fillPrompt(name))) return false;
  await win.waitForTimeout(2500);
  return win.evaluate((n: string) => [...document.querySelectorAll('.viz-card')]
    .some((c) => (c.textContent || '').includes(n)), name);
}

export async function chartsSection(s: Smoke): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;

  const csv = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8');
  ok('charts: the sample CSV has no quoted fields, so a comma split is exact', !csv.includes('"'));
  const pareto = paretoFromCsv();
  const nSub = pareto.categories;

  const cases: Array<{
    label: string; name: string; category: string; measures: string[];
    type: string; check: (c: { type: string; points: number; labels: number }) => boolean;
  }> = [
    // Profit by sub-category: some sub-categories lose money, so there are
    // down steps, plus the closing Total bar.
    { label: 'Waterfall', name: 'Profit walk', category: 'sub_category', measures: ['profit'],
      type: 'bar', check: (c) => c.labels === nSub + 1 && c.points === nSub + 1 },
    { label: 'Bullet', name: 'Revenue vs target', category: 'region', measures: ['revenue'],
      type: 'bar', check: (c) => c.labels >= 4 },
    // A calendar is one cell per DAY: choosing it must switch the grain to day,
    // so two years of orders are ~730 cells, not 24 months.
    { label: 'Calendar heatmap', name: 'Daily revenue', category: 'order_date', measures: ['revenue'],
      type: 'matrix', check: (c) => c.points >= 700 && c.points <= 740 },
    { label: 'Radar', name: 'Region profile', category: 'region', measures: ['revenue', 'profit', 'units'],
      type: 'radar', check: (c) => c.labels === 3 && c.points >= 12 },
    { label: 'Pareto', name: 'Revenue concentration', category: 'sub_category', measures: ['revenue'],
      type: 'bar', check: (c) => c.labels === nSub && c.points === 2 * nSub },
  ];

  for (const k of cases) {
    ok(`charts/${k.label}: the builder opens on the sample`, await openBuilder(win));
    ok(`charts/${k.label}: the encoding is set`, await setEncoding(win, k.category, k.measures));
    ok(`charts/${k.label}: the picker offers it`, await pickType(win, k.label));
    await win.waitForTimeout(2500);
    const c = await readChart(win);
    ok(`charts/${k.label}: a real canvas drew, as Chart.js type ${k.type}`,
       c.w > 0 && c.h > 0 && c.type === k.type && k.check(c), JSON.stringify(c));
    if (k.label === 'Calendar heatmap') {
      ok('charts/calendar: choosing it set the date grain to Day', await win.evaluate(() =>
        (document.querySelector('#ws-visuals .js-enc-grain') as HTMLSelectElement | null)?.value === 'day'));
    }
    if (process.env.SMOKE_ARTIFACT_DIR) {
      await win.screenshot({ path: path.join(s.shotDir, 'chart-' + k.type + '-' + k.label.split(' ')[0].toLowerCase() + '.png') });
    }
    ok(`charts/${k.label}: saves and appears in the gallery`, await save(win, k.name));
  }

  // ── The Pareto caption states the 80% count the CSV implies ──────────────
  const expected = pareto.count80;
  const caption: string = await win.evaluate(async () => {
    const hub = (window as any).hub;
    const projects = await hub.listProjects();
    const proj = projects.find((p: any) => p.name === 'My project') || projects[0];
    const list = await hub.listVisuals(proj.id);
    const row = list.find((v: any) => v.name === 'Revenue concentration');
    const v = row && await hub.getVisual(proj.id, row.id);
    if (!v) return '';
    const res = await hub.computeVisualData(proj.id, v.datasetId, v.encoding, v.filters || []);
    return hub.reportsCaption({ chartType: v.chartType, data: res.data, overrides: v.overrides });
  });
  const word = expected < WORDS.length ? WORDS[expected] : String(expected);
  ok('charts/pareto: the caption states the 80% count computed from the CSV',
     caption === `${cap(word)} categories make 80% of revenue`,
     JSON.stringify({ caption, expected }));

  // The gallery, with the five new types' live thumbnails at the top.
  await win.evaluate(() => { (window as any).selectSection('visuals'); });
  await win.waitForTimeout(3000);
  await win.screenshot({ path: path.join(s.shotDir, 'wf-4-gallery.png') });

  const errors = s.errors.slice(errorsBefore);
  ok('charts: no renderer console errors in this section', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
}
