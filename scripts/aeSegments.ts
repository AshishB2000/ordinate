// Smoke SECTION: Find segments, end to end on the bundled sample.
//
// Not a smoke file of its own: `segmentsSection(s, ids)` runs against an app
// someone else launched, on a FRESH userData whose first-launch sample is
// seeded ("Retail orders", 5,000 rows, no customer id). It drives what a user
// does:
//
//   · the dataset header's ⋯ → Find segments opens the full-width page, with
//     the six number columns ticked and the text/date ones named as not listed;
//   · Run → sizes, the profile table, app-written names and the PCA scatter;
//   · Save as column → a Prepare step whose column holds the labels, and the
//     step's line in the Prepare panel;
//   · a small customer-orders dataset seeded through main's ordinary save path
//     → its id column is skipped as id-like, a constant as near-constant; the
//     palette's "Score customers (RFM)" → the eleven-segment table and the
//     R × FM map → Save as dataset.
//
// The expected figures (row counts, customers, the designed Champion and Lost
// customer) are computed HERE, never read back from the app. The section
// restores the sample's pipeline and removes what it created.

import { ok } from './selfcheck';
import { REPO } from './smokeFixture';
import type { Smoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
type Ids = { projectId: string; datasetId: string; dashboardId: string };

// Hub globals, read by bare name inside page.evaluate (classic-script lexicals).
declare const sgChart: any;
declare const sgResult: any;
declare const expId: string;

const CUSTOMERS = 40;

/** The designed customer table: 1001 is Lost (first, one tiny early order), 1040 a Champion. */
function customerRows(): { rows: Array<[number, string, number, number]>; orders: number } {
  const rows: Array<[number, string, number, number]> = [[1001, '2023-01-01', 1, 7]];
  const day = (d: number): string => new Date(Date.UTC(2023, 1, 1) + d * 86_400_000).toISOString().slice(0, 10);
  for (let c = 1; c < CUSTOMERS - 1; c++) {
    const n = 1 + ((c * 7) % 9);
    for (let k = 0; k < n; k++) rows.push([1001 + c, day((c * 37 + k * 53) % 600), 10 + ((c * 13 + k * 29) % 190), 7]);
  }
  for (let k = 0; k < 20; k++) rows.push([1000 + CUSTOMERS, k === 19 ? '2024-12-31' : day(100 + k * 20), 500, 7]);
  return { rows, orders: rows.length };
}

async function waitFor(win: Win, fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await win.evaluate(fn).catch(() => false)) return true;
    await win.waitForTimeout(400);
  }
  return false;
}

export async function segmentsSection(s: Smoke, ids: Ids): Promise<void> {
  const { win } = s;
  const errorsBefore = s.errors.length;
  const { projectId: pid, datasetId: did } = ids;
  const csv = fs.readFileSync(path.join(REPO, 'assets', 'samples', 'retail-orders.csv'), 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const nRows = csv.length - 1;
  const NUMBERS = ['units', 'unit_price', 'discount', 'revenue', 'profit', 'ship_days'];
  const before = await win.evaluate(async (a: { pid: string; did: string }) => {
    const ds = await (window as any).hub.getDataset(a.pid, a.did);
    return { steps: ds.steps || [], columns: (ds.columns || []).map((c: any) => ({ name: c.name, type: c.type })) as Array<{ name: string; type: string }> };
  }, { pid, did });
  // The CSV's measures are the number columns; everything else the dataset holds is not offered.
  const others = before.columns.filter((c) => c.type !== 'number').length;
  ok('segments: the sample declares exactly the CSV\'s measures as numbers',
    JSON.stringify(before.columns.filter((c) => c.type === 'number').map((c) => c.name)) === JSON.stringify(NUMBERS), JSON.stringify(before.columns));
  const made: string[] = [];

  try {
    // ── Open from the dataset's ⋯ menu ─────────────────────────────────────
    await win.evaluate(async (id: string) => {
      const w = window as any;
      w.selectSection('datasets');
      await w.openSavedDataset(id);
    }, did);
    await win.waitForTimeout(1200);
    const opened = await win.evaluate(async () => {
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      (document.getElementById('ds-act-more') as HTMLElement).click();
      await pause(300);
      const item = [...document.querySelectorAll('.chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Find segments') as HTMLElement | undefined;
      if (!item) return { item: false, shown: false };
      item.click();
      await pause(2500);
      const page = document.getElementById('ws-segments') as HTMLElement | null;
      return { item: true, shown: !!page && !page.hidden, section: document.querySelector('.hub-body')?.getAttribute('data-section') || '' };
    });
    ok('segments: the ⋯ menu offers Find segments and opens its page', opened.item && opened.shown, JSON.stringify(opened));

    const chips = await win.evaluate(() => ({
      chips: [...document.querySelectorAll('#sg-chips .sg-chip')].map((c) => ({
        name: (c.querySelector('.sg-chip-name')?.textContent || '').trim(),
        on: (c.querySelector('input') as HTMLInputElement).checked,
        why: (c.querySelector('.sg-chip-why')?.textContent || '').trim(),
      })),
      note: document.querySelector('#sg-tabp-kmeans .sg-note')?.textContent || '',
      empty: !!document.querySelector('#sg-results .ws-empty'),
      title: document.getElementById('sg-sub')?.textContent || '',
    }));
    ok('segments: the six number columns are offered, all ticked', JSON.stringify(chips.chips.map((c) => c.name)) === JSON.stringify(NUMBERS) && chips.chips.every((c) => c.on && !c.why), JSON.stringify(chips.chips));
    ok('segments: the text/date columns are named as not listed', chips.note.startsWith(`${others} text or date columns are not listed`), chips.note);
    ok('segments: an empty state before the first run', chips.empty);
    ok('segments: the page names the dataset and its rows', chips.title.includes('Retail orders') && chips.title.includes(nRows.toLocaleString('en-US')), chips.title);

    // ── Run ───────────────────────────────────────────────────────────────────
    await win.evaluate(() => (document.getElementById('sg-run') as HTMLElement).click());
    const done = await waitFor(win, () => !!document.querySelector('#sg-results .sg-kpis'), 120_000);
    ok('segments: Run produced results', done);
    const view = await win.evaluate(() => {
      const r = sgResult;
      const sizes = [...document.querySelectorAll('#sg-results .sg-size')].map((li) => ({
        seg: (li as HTMLElement).dataset.segment || '',
        name: (li.querySelector('.sg-size-name')?.textContent || '').trim(),
        n: Number((li.querySelector('.sg-size-fig b')?.textContent || '').replace(/,/g, '')),
      }));
      const table = document.querySelector('#sg-results .sg-profile table') as HTMLTableElement | null;
      const canvas = document.getElementById('sg-scatter') as HTMLCanvasElement | null;
      return {
        k: r ? r.k : 0,
        names: r ? r.names : [],
        sizes,
        profileRows: table ? table.tBodies[0].rows.length : 0,
        profileCols: table ? table.tHead!.rows[0].cells.length : 0,
        devBars: document.querySelectorAll('#sg-results .sg-dev-bar').length,
        chartSets: sgChart ? sgChart.data.datasets.length : 0,
        chartPoints: sgChart ? sgChart.data.datasets.reduce((a: number, d: any) => a + d.data.length, 0) : 0,
        canvasW: canvas ? canvas.clientWidth : 0,
        chosen: (document.querySelector('.sg-k-row.is-chosen .sg-k-n')?.textContent || '').trim(),
      };
    });
    const segRows = view.sizes.filter((x) => x.seg !== '');
    ok('segments: k is between 2 and 8, one size row per segment', view.k >= 2 && view.k <= 8 && segRows.length === view.k, JSON.stringify(view.sizes));
    ok('segments: every one of the 5,000 rows is counted', view.sizes.reduce((a, x) => a + x.n, 0) === nRows, JSON.stringify(view.sizes));
    ok('segments: app-written names ("High revenue · Low discount")',
      view.names.length === view.k && view.names.every((n: string) => /^(High|Low|Average) .+ · (High|Low|Average) .+/.test(n)) && new Set(view.names).size === view.k, JSON.stringify(view.names));
    ok('segments: the profile has a row per column and a column per segment', view.profileRows === NUMBERS.length && view.profileCols === view.k + 2 && view.devBars > 0, JSON.stringify(view));
    ok('segments: the PCA scatter is drawn, one colour per segment', view.chartSets === view.k && view.chartPoints > 100 && view.canvasW > 100, JSON.stringify(view));
    ok('segments: the chosen k is marked', view.chosen === `${view.k} segments`, view.chosen);
    await win.screenshot({ path: path.join(s.shotDir, 'ae-segments-results.png') });

    // ── Save as column ────────────────────────────────────────────────────────
    await win.evaluate(() => (document.getElementById('sg-save') as HTMLElement).click());
    const saved = await waitFor(win, () => !!document.querySelector('#sg-save-status.is-ok'), 60_000);
    ok('segments: Save as column reports success', saved);
    const stored = await s.app.evaluate(async (_a: unknown, arg: { pid: string; did: string }) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const datasets = req('./src/data/datasets.js');
      const ds = await datasets.getDataset(arg.pid, arg.did);
      const col = ds.columns.findIndex((c: any) => c.name === 'segment');
      const counts: Record<string, number> = {};
      for (const r of ds.rows) { const v = col >= 0 ? r[col] : undefined; counts[String(v)] = (counts[String(v)] || 0) + 1; }
      const last = ds.steps[ds.steps.length - 1] || {};
      return { type: col >= 0 ? ds.columns[col].type : '', counts, stepType: last.type, k: (last.centroids || []).length };
    }, { pid, did });
    ok('segments: the dataset gained a segment step carrying the model', stored.stepType === 'segment' && stored.k === view.k, JSON.stringify(stored));
    ok('segments: the column is text and holds the labels, sized as shown',
      stored.type === 'text' && segRows.every((x) => stored.counts[view.names[Number(x.seg)]] === x.n), JSON.stringify(stored.counts));

    await win.evaluate(() => ([...document.querySelectorAll('#sg-save-status button')].find((b) => /Open in Prepare/.test(b.textContent || '')) as HTMLElement)?.click());
    await win.waitForTimeout(2000);
    const prep = await win.evaluate(() => ({
      section: document.querySelector('.hub-body')?.getAttribute('data-section') || '',
      steps: [...document.querySelectorAll('#ds-steps-list .ds-step-summary')].map((e) => (e.textContent || '').trim()),
    }));
    ok('segments: Open in Prepare shows the step', prep.section === 'datasets' && prep.steps.some((t) => /^Segments: \d groups by units, unit_price/.test(t)), JSON.stringify(prep));

    // ── RFM on a seeded customer-orders dataset ───────────────────────────────
    const cust = customerRows();
    const custId = await s.app.evaluate(async (_a: unknown, arg: { pid: string; rows: any[] }) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const datasets = req('./src/data/datasets.js');
      const ds = await datasets.saveDataset(arg.pid, {
        name: 'Smoke customer orders',
        sourceKind: 'paste',
        columns: [{ name: 'customer_id', type: 'number' }, { name: 'order_date', type: 'date' }, { name: 'amount', type: 'number' }, { name: 'fee', type: 'number' }],
        rows: arg.rows,
      });
      return ds ? ds.id : '';
    }, { pid, rows: cust.rows });
    ok('rfm: a customer-orders dataset saved through main', !!custId);
    if (custId) made.push(custId);
    await win.evaluate(async (id: string) => {
      const w = window as any;
      w.selectSection('datasets');
      await w.openSavedDataset(id);
    }, custId);
    await win.waitForTimeout(1200);
    await win.evaluate(() => (window as any).runCommand('data.rfm'));
    await win.waitForTimeout(2500);
    const setup = await win.evaluate(() => ({
      rfmShown: !(document.getElementById('sg-tabp-rfm') as HTMLElement).hidden,
      id: (document.getElementById('sg-rfm-id') as HTMLSelectElement).value,
      date: (document.getElementById('sg-rfm-date') as HTMLSelectElement).value,
      amount: (document.getElementById('sg-rfm-amount') as HTMLSelectElement).value,
      chips: [...document.querySelectorAll('#sg-chips .sg-chip')].map((c) => `${(c.querySelector('.sg-chip-name')?.textContent || '').trim()}:${(c.querySelector('input') as HTMLInputElement).checked}:${(c.querySelector('.sg-chip-why')?.textContent || '').trim()}`),
      open: expId,
    }));
    ok('rfm: the palette command opens the RFM tab with the pickers guessed',
      setup.rfmShown && setup.id === 'customer_id' && setup.date === 'order_date' && setup.amount === 'amount', JSON.stringify(setup));
    ok('segments: an id column and a constant are skipped, with why',
      JSON.stringify(setup.chips) === JSON.stringify(['customer_id:false:looks like an id', 'amount:true:', 'fee:false:nearly constant']), JSON.stringify(setup.chips));

    await win.evaluate(() => (document.getElementById('sg-rfm-run') as HTMLElement).click());
    const scored = await waitFor(win, () => !!document.getElementById('sg-rfm-table'), 60_000);
    ok('rfm: Score customers produced the table', scored);
    const rfm = await win.evaluate(() => {
      const rows = [...document.querySelectorAll('#sg-rfm-table tbody tr')].map((tr) => ({
        name: (tr as HTMLElement).dataset.segment || '',
        n: Number((tr.querySelector('.sg-rfm-count')?.textContent || '').replace(/,/g, '')),
      }));
      const cells = [...document.querySelectorAll('.sg-rfm-grid .sg-rfm-cell-n')].map((c) => Number((c.textContent || '').replace(/,/g, '')));
      const kpis = [...document.querySelectorAll('#sg-rfm-results .sg-kpi-v')].map((k) => (k.textContent || '').trim());
      return { rows, cells, kpis };
    });
    ok('rfm: all eleven segments, in order', rfm.rows.map((r) => r.name).join('|') ===
      "Champions|Loyal Customers|Potential Loyalists|New Customers|Promising|Need Attention|About to Sleep|At Risk|Can't Lose Them|Hibernating|Lost", JSON.stringify(rfm.rows));
    ok('rfm: every customer is in exactly one segment', rfm.rows.reduce((a, r) => a + r.n, 0) === CUSTOMERS, JSON.stringify(rfm.rows));
    ok('rfm: the R × FM map holds every customer in 25 cells', rfm.cells.length === 25 && rfm.cells.reduce((a, b) => a + b, 0) === CUSTOMERS, JSON.stringify(rfm.cells));
    ok('rfm: customers, orders and the as-of date are the data’s',
      rfm.kpis[0] === String(CUSTOMERS) && rfm.kpis[1] === cust.orders.toLocaleString('en-US') && rfm.kpis[2] === '2024-12-31', JSON.stringify(rfm.kpis));
    await win.screenshot({ path: path.join(s.shotDir, 'ae-segments-rfm.png') });

    await win.evaluate(() => (document.getElementById('sg-rfm-save') as HTMLElement).click());
    const rfmSaved = await waitFor(win, () => !!document.querySelector('#sg-rfm-status.is-ok'), 30_000);
    ok('rfm: Save as dataset reports success', rfmSaved);
    const table = await s.app.evaluate(async (_a: unknown, arg: { pid: string }) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const datasets = req('./src/data/datasets.js');
      const list = await datasets.listDatasets(arg.pid);
      const hit = list.find((d: any) => d.name === 'Smoke customer orders — RFM');
      if (!hit) return null;
      const ds = await datasets.getDataset(arg.pid, hit.id);
      const seg = (id: string) => (ds.rows.find((r: any) => r[0] === id) || [])[7];
      return { id: hit.id, rows: ds.rowCount, columns: ds.columns.map((c: any) => c.name), champion: seg('1040'), lost: seg('1001') };
    }, { pid });
    if (table) made.push(table.id);
    ok('rfm: the saved dataset has one row per customer and the eight columns',
      !!table && table.rows === CUSTOMERS && table.columns.join(',') === 'customer_id,recency,frequency,monetary,r,f,m,rfm_segment', JSON.stringify(table));
    ok('rfm: the designed customers land where the grid says (Champions, Lost)', !!table && table.champion === 'Champions' && table.lost === 'Lost', JSON.stringify(table));
  } finally {
    // Leave the sample exactly as it was for whatever runs next.
    const restored = await win.evaluate(async (a: { pid: string; did: string; steps: any[]; made: string[] }) => {
      const w = window as any;
      const res = await w.hub.setDatasetSteps(a.pid, a.did, a.steps);
      for (const id of a.made) await w.hub.deleteDataset(a.pid, id);
      w.selectSection('datasets');
      return res && res.dataset ? (res.dataset.steps || []).length : -1;
    }, { pid, did, steps: before.steps, made });
    ok('segments: the sample\'s pipeline is restored', restored === before.steps.length, String(restored));
  }

  const errors = s.errors.slice(errorsBefore);
  ok('segments: no renderer console errors in this section', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
}
