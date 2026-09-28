// Round-6 smoke SECTION: the statistics workbench, driven through the REAL UI.
// Not a standalone smoke — scripts/smoke-round6.ts calls statsSection(s, fx) on
// its one launch and fixture.
//
//   A seeded dataset with known relationships (y = 2x + 3 + a fixed wobble; web
//   revenue 12 above store; three segments) → Statistics from the dataset
//   header's ⋯ → the correlation heatmap's x × y cell says the r main computes
//   → its tooltip → click it: the scatter draws with its fit line → Regression
//   of y on x: the rendered coefficient is main's → Save as calculated field
//   adds predicted_y → Compare groups renders the app's sentence → Distribution
//   shows Shapiro–Wilk → close → Statistics from the palette → Add to dashboard
//   → the tile renders on the dashboard. Leaves the Data list on screen.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level `const`s (statsCharts.ts), read by bare name inside evaluate.
declare const swCharts: any;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

const text = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => (document.querySelector(q)?.textContent || '').trim(), sel);

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

const choose = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLSelectElement | null;
    if (!el || ![...el.options].some((o) => o.value === a.v)) return false;
    el.value = a.v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { q: sel, v: value });

const menuItem = (win: Win, label: string): Promise<boolean> =>
  win.evaluate((l: string) => {
    const b = [...document.querySelectorAll('.chart-menu-item')].find((x) => (x as HTMLElement).getClientRects().length > 0 && (x.textContent || '').trim() === l) as HTMLElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }, label);

const panelOpen = (win: Win): Promise<boolean> =>
  win.evaluate(() => document.body.classList.contains('sw-open') && !!document.getElementById('sw-panel')?.getClientRects().length);

export async function statsSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };

  // ── Seed: known relationships, and main's own answers to check against ───
  const seeded: any = await app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const rows: any[] = [];
    for (let i = 0; i < 120; i++) {
      const x = (i % 40) + 1 + ((i * 7) % 5) / 10;
      const wobble = (((i * 37) % 17) - 8) / 4;
      const channel = i % 2 ? 'web' : 'store';
      rows.push([x, 2 * x + 3 + wobble, ['north', 'south', 'east'][i % 3], channel, 100 + (channel === 'web' ? 12 : 0) + (((i * 13) % 11) - 5)]);
    }
    const ds = await datasets.saveDataset(a.pid, {
      name: 'Stats demo', sourceKind: 'csv',
      columns: [
        { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'segment', type: 'text' },
        { name: 'channel', type: 'text' }, { name: 'revenue', type: 'number' },
      ],
      rows,
    });
    const cor = req('./src/analysis/stats/correlation.js');
    const reg = req('./src/analysis/stats/regression.js');
    const col = (j: number) => rows.map((r) => r[j]);
    const fit = reg.olsFit('y', col(1), [{ name: 'x', kind: 'numeric', values: col(0) }]);
    return { id: ds.id, r: cor.correlate(col(0), col(1), 'pearson').r, slope: fit.terms[1].estimate };
  }, { pid });
  ok('stats: the demo dataset is seeded', !!seeded && !!seeded.id);
  const id = seeded.id as string;
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    if (a.fn === 'columns') return (await datasets.getDatasetMeta(a.pid, a.id)).columns.map((c: any) => c.name);
    if (a.fn === 'sentence') {
      const ds = await datasets.getDataset(a.pid, a.id);
      const vj = req('./src/analysis/stats/vectorsJs.js');
      const run = req('./src/analysis/stats/run.js');
      const v = vj.loadVectorsJs(ds.columns, ds.rows, [{ column: 'channel', as: 'label' }, { column: 'revenue', as: 'number' }]);
      return run.runStats({ kind: 'groups', datasetId: a.id, columns: [], group: 'channel', outcome: 'revenue' }, v).sentence;
    }
    if (a.fn === 'cards') {
      const analysis = req('./src/analysis/analysis.js');
      const rec = await analysis.getAnalysis(a.pid, a.aid);
      return rec ? rec.sheets.flatMap((sh: any) => sh.cards).filter((c: any) => c.type === 'stats').map((c: any) => c.stats) : [];
    }
    return null;
  }, { fn, pid, id, ...arg }) as Promise<T>;

  // ── From the dataset header's ⋯ ───────────────────────────────────────────
  await openProject(win, pid);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(800);
  await win.evaluate((d: string) => (window as any).openSavedDataset(d), id);
  await until(win, () => win.evaluate(() => !document.getElementById('ds-explorer')?.hidden), 10_000);
  ok('stats: the dataset header has a More menu', await click(win, '#ds-act-more'));
  ok('stats: More → Statistics', await menuItem(win, 'Statistics'));
  ok('stats: the workbench opens full width', await until(win, () => panelOpen(win), 10_000));
  const cell = '#sw-results .sw-heat button.sw-cell[data-i="0"][data-j="1"]';
  ok('stats: the correlation heatmap renders', await until(win, () => win.evaluate((q: string) => !!document.querySelector(q), cell), 20_000));
  const label = await win.evaluate((q: string) => document.querySelector(q)?.getAttribute('aria-label') || '', cell);
  const shown = /r = (-?\d+\.\d+)/.exec(label);
  ok(`stats: the x × y cell says r = ${Number(seeded.r).toFixed(3)} (main's figure)`, !!shown && shown[1] === Number(seeded.r).toFixed(3), label);
  ok('stats: the cell prints r to two decimals with its significance', (await text(win, cell)) === Number(seeded.r).toFixed(2) + '***', await text(win, cell));
  await win.evaluate((q: string) => (document.querySelector(q) as HTMLElement).focus(), cell);
  ok('stats: the tooltip gives r, p and n', await until(win, async () => /r = .*p .*n = 120/.test(await text(win, '#sw-heat-tip')), 5000), await text(win, '#sw-heat-tip'));
  await shot('stats-correlation.png');

  ok('stats: click the cell', await click(win, cell));
  const fitDrawn = (): Promise<boolean> => win.evaluate(() => swCharts.some((c: any) => c.config.type === 'scatter'
    && c.data.datasets.length === 2 && c.data.datasets[1].label === 'Fit' && c.data.datasets[0].data.length === 120));
  ok('stats: the pair\'s scatter draws with its fit line', await until(win, fitDrawn, 15_000));
  ok('stats: the pair has the app\'s sentence', /x and y have a strong positive correlation \(r = /.test(await text(win, '#sw-pair .sw-sentence')), await text(win, '#sw-pair .sw-sentence'));

  // ── Regression: y on x ────────────────────────────────────────────────────
  ok('stats: the Regression tab', await click(win, '#sw-tab-regression'));
  await until(win, () => win.evaluate(() => !!document.getElementById('sw-target')), 10_000);
  ok('stats: target y', await choose(win, '#sw-target', 'y'));
  const coef = (): Promise<string> => win.evaluate(() => {
    const row = [...document.querySelectorAll('#sw-results .sw-coef tbody tr')].find((r) => r.querySelector('th')?.textContent === 'x');
    return row ? (row.children[1]?.textContent || '') : '';
  });
  await until(win, async () => (await coef()).length > 0 && /on 1 term/.test(await text(win, '#sw-results .sw-result-title')), 15_000);
  ok(`stats: the rendered coefficient of x is main's ${Number(seeded.slope).toFixed(2)}`, (await coef()) === Number(seeded.slope).toFixed(2), await coef());
  ok('stats: residual and Q-Q plots draw', await until(win, () => win.evaluate(() => swCharts.length >= 2), 5000));
  await shot('stats-regression.png');
  ok('stats: Save as predicted_y', await click(win, '#sw-results .sw-save-calc'));
  ok('stats: the dataset gains predicted_y', await until(win, async () => (await main<string[]>('columns')).includes('predicted_y'), 15_000));

  // ── Compare groups: revenue by channel ───────────────────────────────────
  ok('stats: the Compare groups tab', await click(win, '#sw-tab-groups'));
  await until(win, () => win.evaluate(() => !!document.getElementById('sw-group')), 10_000);
  ok('stats: group by channel', await choose(win, '#sw-group', 'channel'));
  ok('stats: outcome revenue', await choose(win, '#sw-outcome', 'revenue'));
  const expected = await main<string>('sentence');
  ok('stats: Compare groups renders the app\'s sentence',
    await until(win, async () => (await text(win, '#sw-results .sw-sentence')) === expected, 15_000), `${await text(win, '#sw-results .sw-sentence')} | want ${expected}`);
  ok('stats: … "web\'s average revenue is …% higher than store\'s; the difference is significant"', /^web's average revenue is \d+\.\d% higher than store's; the difference is significant \(p [<=] 0\.\d{3}\)\.$/.test(expected), expected);
  ok("stats: Welch's t and Mann–Whitney cards", /Welch's t-test/.test(await text(win, '#sw-results .sw-cards')) && /Mann–Whitney U/.test(await text(win, '#sw-results .sw-cards')));
  await shot('stats-groups.png');

  // ── Distribution ─────────────────────────────────────────────────────────
  ok('stats: the Distribution tab', await click(win, '#sw-tab-distribution'));
  ok('stats: Distribution shows Shapiro–Wilk', await until(win, async () => /Shapiro–Wilk test/.test(await text(win, '#sw-results .sw-cards')) && /W/.test(await text(win, '#sw-results .sw-dl')), 15_000),
    await text(win, '#sw-results'));
  ok('stats: … with the histogram', await until(win, () => win.evaluate(() => swCharts.some((c: any) => c.data.datasets.some((d: any) => d.label === 'Normal curve'))), 5000));
  await shot('stats-distribution.png');

  // ── Close; the palette opens it too ───────────────────────────────────────
  ok('stats: Close', await click(win, '#sw-close'));
  ok('stats: the section is back', await until(win, async () => !(await panelOpen(win)) && await win.evaluate(() => !document.getElementById('ds-explorer')?.hidden), 5000));
  await win.evaluate(() => (window as any).paletteOpen('>statistics'));
  ok('stats: the palette offers Statistics…', await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#cp-results .cp-row-title')].some((t) => (t.textContent || '').trim() === 'Statistics…')), 5000));
  await win.evaluate(() => {
    // A palette row runs on mousedown (palette.ts), before the input's blur.
    const row = [...document.querySelectorAll('#cp-results .cp-row')].find((r) => (r.querySelector('.cp-row-title')?.textContent || '').trim() === 'Statistics…') as HTMLElement | undefined;
    row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  ok('stats: the palette opens the workbench', await until(win, () => panelOpen(win), 10_000));
  ok('stats: … on the open dataset', (await win.evaluate(() => (document.getElementById('sw-dataset') as HTMLSelectElement | null)?.value)) === id);

  // ── Add to dashboard → a tile that renders ────────────────────────────────
  const aid = await seedAnalysis(app, pid, { name: 'Stats board', sheets: [{ name: 'Sheet 1', cards: [] }] });
  await click(win, '#sw-tab-correlation');
  await until(win, () => win.evaluate((q: string) => !!document.querySelector(q), cell), 15_000);
  ok('stats: Add to dashboard', await click(win, '#sw-results .sw-add-dash'));
  await until(win, () => win.evaluate(() => [...document.querySelectorAll('.ws-modal-overlay')].some((o) => (o as HTMLElement).getClientRects().length > 0)), 5000);
  const picked = await win.evaluate((a: string) => {
    const box = [...document.querySelectorAll('.ws-modal-overlay')].filter((o) => (o as HTMLElement).getClientRects().length > 0).map((o) => o.querySelector('.ws-modal'))[0];
    const sel = box?.querySelector('select.ws-modal-input') as HTMLSelectElement | null;
    if (!box || !sel || ![...sel.options].some((o) => o.value === a)) return false;
    sel.value = a;
    (box.querySelector('.ws-modal-actions .btn-primary') as HTMLElement).click();
    return true;
  }, aid);
  ok('stats: … choose "Stats board"', picked);
  ok('stats: the dashboard holds a stats card with only its spec', await until(win, async () => {
    const cards = await main<any[]>('cards', { aid });
    return cards.length === 1 && cards[0].kind === 'correlation' && cards[0].datasetId === id && !('matrix' in cards[0]);
  }, 10_000));
  ok('stats: Close the workbench', await click(win, '#sw-close'));
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(1200);
  ok('stats: the dashboard opens', await openSeededAnalysis(win, 'Stats board'));
  const tileCell = (): Promise<string> => win.evaluate(() => {
    const row = [...document.querySelectorAll('#dash-grid .dash-card .sw-tile tbody tr')].find((r) => r.querySelector('th')?.textContent === 'x');
    return row ? (row.children[2]?.textContent || '') : '';
  });
  ok('stats: the tile renders the x × y coefficient', await until(win, async () => (await tileCell()) === Number(seeded.r).toFixed(2) + '***', 15_000), await tileCell());
  ok('stats: the tile is titled by its analysis', /Correlation · Pearson/.test(await text(win, '#dash-grid .dash-card .dash-card-title')));
  await shot('stats-tile.png');

  // Neutral: the project's Data list, nothing open.
  await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(600);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(400);
  await win.evaluate(() => { const b = document.getElementById('ds-explorer-close') as HTMLElement | null; if (b && b.getClientRects().length) b.click(); });
  await win.waitForTimeout(400);
  ok('stats: left neutral — the workbench is closed', !(await panelOpen(win)));
  const errs = s.errors.slice(errors0);
  ok('stats: no renderer console error in the section', errs.length === 0, errs.join('\n'));
}
