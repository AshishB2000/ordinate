// Round-10 smoke SECTION: multi-currency, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round10.ts calls currencySection(s, fx) on
// its one launch.
//
//   A dataset of its own (orders in USD / EUR / GBP / ZAR, one currency per row)
//   → its amount column's profile → "A currency per row": the Currency section
//   reads the codes column, says what the total converts to, warns that the ZAR
//   rows have no rate and shows "Sample rates, not live" → Settings → General →
//   Currency: target EUR, with the sample label → a dashboard over it: the
//   metric card shows main's own converted sum with the € symbol, the missing-
//   rate chip on both tiles, the sample chip → the dashboard's own currency
//   (GBP) re-reads every tile in £, to main's answer under that target.
//   Everything it made is deleted and the project's currency settings restored.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level globals, read by bare name inside evaluate.
declare const dashCurrent: any;
declare const OrdFormat: any;
declare const selectSection: (s: string) => void;
declare const openSavedDataset: (id: string) => Promise<void>;
declare const dsOpenProfile: (c: number) => Promise<void>;
declare const showSettingsPanel: (cat?: string) => Promise<void>;
declare const hideSettingsPanel: () => void;
declare const fxAdopt: (id: string) => Promise<void>;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

/** Pick a value in a <select> the way a user does: set it, fire change. */
const choose = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { sel: string; value: string }) => {
    const el = document.querySelector(a.sel) as HTMLSelectElement | null;
    if (!el || el.getClientRects().length === 0 || ![...el.options].some((o) => o.value === a.value)) return false;
    el.value = a.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { sel, value });

const textOf = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => [...document.querySelectorAll(q)].map((e) => (e.textContent || '').trim()).join(' | '), sel);

const N = 1_200;
const CURS = ['USD', 'EUR', 'GBP', 'USD', 'EUR', 'GBP', 'USD', 'EUR', 'GBP', 'ZAR']; // every 10th row: no rate anywhere

export async function currencySection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };

  // ── A dataset of its own, a visual and a dashboard over it ─────────────────
  const made: { datasetId: string; visualId: string; before: any } = await app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const before = await req('./src/app/fxStore.js').getFx(a.pid);
    const rows: any[][] = [];
    for (let i = 0; i < a.n; i++) {
      const d = new Date(Date.UTC(2024, 0, 1) + (i % 600) * 86400000).toISOString().slice(0, 10);
      rows.push([(i % 97) * 10 + 5, a.curs[i % a.curs.length], d, i % 2 ? 'West' : 'East']);
    }
    const ds = await datasets.saveDataset(a.pid, {
      name: 'FX orders', sourceKind: 'csv',
      columns: [{ name: 'amount', type: 'number' }, { name: 'currency', type: 'text' }, { name: 'ordered', type: 'date' }, { name: 'region', type: 'text' }],
      rows,
    });
    const v = await visuals.saveVisual(a.pid, { datasetId: ds.id, name: 'FX by region', chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } });
    return { datasetId: ds.id, visualId: v.id, before: JSON.parse(JSON.stringify(before)) };
  }, { pid, n: N, curs: CURS });
  ok('currency: a dataset of its own to convert', !!made.datasetId && !!made.visualId);
  let aid = '';

  /** Main's own converted sum (and its note), under an optional dashboard target. */
  const mainSum = (currency?: string): Promise<{ value: number | null; fx: any }> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const run = () => req('./src/ipc/dashboards.js').computeCardMetric(a.pid, a.ds, { column: 'amount', aggregation: 'sum' }, []);
    const r = a.currency ? await req('./src/ipc/fxQuery.js').fxScope(a.currency, run) : await run();
    return { value: r.value, fx: r.fx || null };
  }, { pid, ds: made.datasetId, currency });

  try {
    // ── The column profile: declare the currency ────────────────────────────
    await openProject(win, pid);
    await win.evaluate(() => selectSection('datasets'));
    await win.waitForTimeout(500);
    await win.evaluate((id: string) => openSavedDataset(id), made.datasetId);
    await win.waitForTimeout(1500);
    await win.evaluate(() => dsOpenProfile(0));
    ok('currency: a number column\'s profile has a Currency section', await until(win, () => win.evaluate(() => {
      const sec = document.querySelector('#ds-profile .fx-dsp') as HTMLElement | null;
      return !!sec && !sec.hidden && /Not money/.test(sec.textContent || '');
    })));
    ok('currency: "A currency per row"', await choose(win, '#ds-profile .fx-dsp select', 'column'));
    ok('currency: it reads the codes from the currency column', await until(win, () => win.evaluate(() => {
      const sels = [...document.querySelectorAll('#ds-profile .fx-dsp select')] as HTMLSelectElement[];
      return sels.length >= 2 && sels[0].value === 'column' && sels[1].value === 'currency';
    })));
    ok('currency: the profile says the ZAR rows have no rate', await until(win, async () =>
      /120 rows had no ZAR→USD rate — excluded/.test(await textOf(win, '#ds-profile .fx-dsp .fx-chip-warn'))));
    ok('currency: …and that the rates are the sample', /Sample rates, not live/.test(await textOf(win, '#ds-profile .fx-dsp .fx-chip-sample')));
    const stored = await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return (await req('./src/app/fxStore.js').getFx(a.pid)).columns[a.ds] || null;
    }, { pid, ds: made.datasetId });
    ok('currency: the declaration is stored', JSON.stringify(stored) === JSON.stringify({ amount: { kind: 'column', column: 'currency' } }), JSON.stringify(stored));
    await shot('currency-profile.png');

    // ── Settings → General → Currency: target EUR ───────────────────────────
    await win.evaluate(() => showSettingsPanel('general'));
    ok('currency: Settings has a Currency group', await until(win, () => win.evaluate(() => !!document.getElementById('stp-fx-target'))));
    ok('currency: the sample rates are labelled "Sample rates, not live"', /Sample rates, not live/.test(await textOf(win, '#stp-fx-sample')));
    ok('currency: target → EUR', await choose(win, '#stp-fx-target', 'EUR'));
    ok('currency: main holds EUR', await until(win, () => app.evaluate(async (_e, p: string) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return (await req('./src/app/fxStore.js').getFx(p)).target === 'EUR';
    }, pid)));
    await shot('currency-settings.png');
    await win.evaluate(() => hideSettingsPanel());

    // ── A dashboard: the converted figure, in €, with its notes ─────────────
    aid = await seedAnalysis(app, pid, { name: 'FX board', sheets: [{ name: 'Sheet 1', cards: [
      { type: 'metric', metric: { datasetId: made.datasetId, column: 'amount', aggregation: 'sum', label: 'Revenue' }, layout: { x: 0, y: 0, w: 4, h: 3 } },
      { type: 'visual', visualId: made.visualId, layout: { x: 4, y: 0, w: 8, h: 5 } },
    ] }] });
    await win.evaluate(() => selectSection('analyses'));
    await win.evaluate(() => (window as any).refreshAnalysisList?.());
    await win.waitForTimeout(800);
    ok('currency: the dashboard opens', await openSeededAnalysis(win, 'FX board'));
    const eur = await mainSum();
    ok('currency: main converts to EUR and counts the ZAR rows', !!eur.fx && eur.fx.target === 'EUR' && eur.fx.missing === 120 && eur.fx.sample, JSON.stringify(eur));
    const card = (): Promise<{ value: string; want: string; warn: string; sample: string }> => win.evaluate((v: number | null) => {
      const c = dashCurrent.pages[0].cards.find((x: any) => x.type === 'metric');
      const el = document.querySelector('.dash-card[data-card-id="' + c.id + '"]') as HTMLElement;
      return {
        value: (el.querySelector('.dash-metric-value')?.textContent || '').trim(),
        want: OrdFormat.formatValue(v, 'currency'),
        warn: (el.querySelector('.fx-chip-warn')?.textContent || '').trim(),
        sample: (el.querySelector('.fx-chip-sample')?.textContent || '').trim(),
      };
    }, eur.value);
    ok('currency: the metric card shows main\'s converted sum', await until(win, async () => { const c = await card(); return c.value === c.want && c.value !== '…'; }), JSON.stringify(await card()));
    const c1 = await card();
    ok('currency: …in euros', c1.value.includes('€'), c1.value);
    ok('currency: the card warns about the rows with no rate', c1.warn === '120 rows had no ZAR→EUR rate — excluded', c1.warn);
    ok('currency: the card says the rates are the sample', c1.sample === 'Sample rates, not live', c1.sample);
    ok('currency: the chart tile carries the same warning', await until(win, async () =>
      /had no ZAR→EUR rate — excluded/.test(await textOf(win, '.dash-card .dash-viz-area ~ .fx-tile-note .fx-chip-warn'))));
    await shot('currency-dashboard.png');

    // ── The dashboard's own currency ─────────────────────────────────────────
    ok('currency: the dashboard header offers its own currency', await until(win, () => win.evaluate(() => {
      const w = document.getElementById('fx-dash-wrap');
      return !!w && !w.hidden;
    })));
    ok('currency: this dashboard → GBP', await choose(win, '#fx-dash-currency', 'GBP'));
    const gbp = await mainSum('GBP');
    ok('currency: main converts the same rows to GBP', !!gbp.fx && gbp.fx.target === 'GBP' && gbp.value !== eur.value, JSON.stringify(gbp));
    const want = await win.evaluate((v: number | null) => OrdFormat.formatValue(v, 'currency'), gbp.value);
    ok('currency: the card re-reads in pounds, to main\'s answer', await until(win, async () => (await card()).value === want), `${(await card()).value} vs ${want}`);
    ok('currency: …with the £ symbol and the GBP warning', await until(win, async () => {
      const c = await card();
      return c.value.includes('£') && c.warn === '120 rows had no ZAR→GBP rate — excluded';
    }), JSON.stringify(await card()));
    await shot('currency-dashboard-gbp.png');
  } finally {
    // ── Leave no trace ──────────────────────────────────────────────────────
    await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(600);
    await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const fxStore = req('./src/app/fxStore.js');
      if (a.aid) {
        await fxStore.setDashboardCurrency(a.pid, a.aid, null);
        await req('./src/analysis/analysis.js').deleteAnalysis(a.pid, a.aid);
      }
      await fxStore.setColumnCurrency(a.pid, a.ds, 'amount', null);
      await fxStore.setProjectFx(a.pid, { target: a.before.target || null, source: a.before.source });
      await req('./src/analysis/visuals.js').deleteVisual(a.pid, a.v);
      await req('./src/data/datasets.js').deleteDataset(a.pid, a.ds);
    }, { pid, aid, ds: made.datasetId, v: made.visualId, before: made.before });
    await win.evaluate((p: string) => fxAdopt(p), pid);
    await win.evaluate(() => selectSection('datasets'));
    await win.waitForTimeout(500);
  }
  const clean = await app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const s = await req('./src/app/fxStore.js').getFx(a.pid);
    const ds = await req('./src/data/datasets.js').getDatasetMeta(a.pid, a.ds);
    return JSON.stringify({ target: s.target, source: s.source }) === JSON.stringify({ target: a.before.target, source: a.before.source })
      && !s.columns[a.ds] && Object.keys(s.dashboards).length === Object.keys(a.before.dashboards).length && !ds;
  }, { pid, ds: made.datasetId, before: made.before });
  ok('currency: settings restored, dataset, visual and dashboard deleted', clean);
  ok('currency: no renderer errors in this section', s.errors.length === errors0, s.errors.slice(errors0).join('\n'));
}
