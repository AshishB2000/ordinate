// Round 7 smoke SECTION: level-of-detail expressions, driven through the REAL
// UI. Not a standalone smoke — scripts/smoke-round7.ts calls lodSection(s, fx)
// on its one launch and fixture.
//
//   Sales → Prepare → Add step → Calculated field → the formula editor: the
//   catalog's "Level of detail" group, `{fi` completing to FIXED, the
//   dimension list completing `reg` to [region], the braces/keyword/colon
//   coloured as one construct → "share of region" =
//   [amount] / {FIXED [region] : SUM([amount])}: the preview's LOD column is
//   each row's REGION TOTAL over the whole stored table (recomputed here from
//   the record, not from eight rows) and answered by the resident path → Save
//   → a visual of sum(share of region) by region, opened in the builder → a
//   FILTERS-well filter amount ≥ 20, run AFTER the LOD (each region reads its
//   kept rows' share of the WHOLE region) → the same filter switched to "Apply
//   before LOD" in the dialog: tagged "context", and every region reads 100%.
//   Deletes the visual, restores the dataset's steps, and leaves the project's
//   Data list on screen with nothing open.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page globals, read by bare name inside evaluate — never via window.x (CSP: no eval).
declare const selectSection: any;
declare const openSavedDataset: any;
declare const dxSelectTab: any;
declare const openSavedVisual: any;
declare const dkSetOpen: any;
declare let vizForm: any;

const NAME = 'share of region';
const LOD = '{FIXED [region] : SUM([amount])}';
const EXPR = '[amount] / ' + LOD;
const ENCODING = { category: 'region', values: [{ column: NAME, aggregation: 'sum' }] };

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
  }
  return false;
}

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

const inputValue = (win: Win): Promise<string> =>
  win.evaluate(() => (document.querySelector('.fx-modal .fx-input') as HTMLTextAreaElement).value);

const popLabels = (win: Win): Promise<string[]> =>
  win.evaluate(() => [...document.querySelectorAll('.fx-modal .fx-pop-item .fx-pop-label')].map((e) => (e.textContent || '').trim()));

export async function lodSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const dsId = fx.datasetId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(250);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => { // any: a JSON arg bag
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    if (a.fn === 'steps') return ((await datasets.getDatasetMeta(a.pid, a.id)) || {}).steps || [];
    if (a.fn === 'setSteps') return !!(await datasets.updateSteps(a.pid, a.id, a.steps));
    if (a.fn === 'trace') return req('./src/engine/residentTrace.js').snapshot()[a.op] || null;
    if (a.fn === 'expect') {
      // The figures the UI must show, from the stored record: each row's region
      // total, and per region the share kept by amount ≥ 20 — after the LOD
      // (kept / whole region) and before it (kept / kept, i.e. 1).
      const ds = await datasets.getDataset(a.pid, a.id);
      const ri = ds.columns.findIndex((c: any) => c.name === 'region');
      const ai = ds.columns.findIndex((c: any) => c.name === 'amount');
      const total = new Map<string, number>();
      const kept = new Map<string, number>();
      for (const r of ds.rows) {
        total.set(r[ri], (total.get(r[ri]) || 0) + r[ai]);
        if (r[ai] >= 20) kept.set(r[ri], (kept.get(r[ri]) || 0) + r[ai]);
      }
      return {
        head: ds.rows.slice(0, 8).map((r: any[]) => ({ region: r[ri], amount: r[ai], total: total.get(r[ri]) })),
        after: Object.fromEntries([...total.keys()].map((k) => [k, (kept.get(k) || 0) / (total.get(k) as number)])),
      };
    }
    if (a.fn === 'saveVisual') {
      const v = await visuals.saveVisual(a.pid, { datasetId: a.id, name: 'Share of region', chartType: 'column', encoding: a.encoding });
      return v && v.id;
    }
    if (a.fn === 'dropVisual') return visuals.deleteVisual(a.pid, a.vid);
    return null;
  }, { fn, pid, id: dsId, ...arg }) as Promise<T>;

  const before = await main<any[]>('steps');
  let vid: string | null = null;
  try {
    // ── The formula editor ───────────────────────────────────────────────────
    await openProject(win, pid);
    await win.evaluate(async (id: string) => {
      selectSection('datasets');
      await openSavedDataset(id);
      dxSelectTab('ds-tab-prepare', true);
    }, dsId);
    await win.waitForTimeout(1200);
    const picked = await win.evaluate(async () => {
      (document.getElementById('ds-step-add') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 300));
      const item = [...document.querySelectorAll('.chart-menu-item')]
        .find((b) => (b.textContent || '').trim() === 'Calculated field') as HTMLElement | undefined;
      if (!item) return false;
      item.click();
      return true;
    });
    ok('lod: Prepare → Add step → Calculated field', picked);
    ok('lod: the formula editor opens', await until(win, () => win.evaluate(() => !!document.querySelector('.fx-modal .fx-item-fn'))));

    const catalog = await win.evaluate(() => ({
      groups: [...document.querySelectorAll('.fx-modal .fx-group')].map((e) => (e.textContent || '').trim()),
      lod: [...document.querySelectorAll('.fx-modal .fx-item-lod')].map((e) => (e.textContent || '').trim()),
    }));
    ok('lod: the catalog has a "Level of detail" group with FIXED, INCLUDE, EXCLUDE and the three recipes',
      catalog.groups.includes('Level of detail') && catalog.lod.length === 6 &&
      ['Share of region', 'First order date per customer', 'Customers with more than 3 orders'].every((r) => catalog.lod.includes(r)),
      JSON.stringify(catalog));

    // Completion, typed — the popover reads the text before the caret.
    await win.click('.fx-modal .fx-input');
    await win.type('.fx-modal .fx-input', '{fi', { delay: 40 });
    await win.waitForTimeout(400);
    const kw = await popLabels(win);
    ok('lod: "{fi" offers the FIXED keyword', kw.includes('{FIXED [dim], … : AGG(expr)}'), JSON.stringify(kw));
    await win.keyboard.press('Tab');
    await win.waitForTimeout(200);
    ok('lod: Tab completes it inside the typed brace', (await inputValue(win)) === '{FIXED ', JSON.stringify(await inputValue(win)));
    await win.type('.fx-modal .fx-input', 'reg', { delay: 40 });
    await win.waitForTimeout(400);
    const dims = await popLabels(win);
    ok('lod: the dimension list offers the dataset\'s columns', dims.includes('region'), JSON.stringify(dims));
    await win.keyboard.press('Enter');
    await win.waitForTimeout(200);
    ok('lod: Enter writes the bracketed dimension', (await inputValue(win)) === '{FIXED [region]', JSON.stringify(await inputValue(win)));

    // The whole field.
    await win.fill('.fx-modal .fx-name', NAME);
    await win.fill('.fx-modal .fx-input', EXPR);
    await until(win, () => win.evaluate(() => !!document.querySelector('.fx-modal .fx-table th.fx-lod-col')), 10_000);
    const pv = await win.evaluate(() => ({
      lodTokens: [...document.querySelectorAll('.fx-modal .fx-hl .fx-t-lod')].map((e) => e.textContent).join(''),
      lodHead: (document.querySelector('.fx-modal .fx-table th.fx-lod-col') as HTMLElement | null)?.textContent || '',
      rows: [...document.querySelectorAll('.fx-modal .fx-table tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim())),
      errors: [...document.querySelectorAll('.fx-modal .fx-msg-err')].map((e) => (e.textContent || '').trim()),
      badge: (document.querySelector('.fx-modal .fx-badge') as HTMLElement | null)?.textContent || '',
      saveDisabled: (document.querySelector('.fx-modal .btn-primary') as HTMLButtonElement).disabled,
    }));
    ok('lod: the braces, FIXED and the colon are coloured as one construct', pv.lodTokens === '{FIXED:}', pv.lodTokens);
    ok('lod: the preview has a column for the LOD, headed by its text', pv.lodHead === LOD, pv.lodHead);
    ok('lod: no errors, a number, savable', pv.errors.length === 0 && pv.badge === 'number' && !pv.saveDisabled, JSON.stringify(pv));
    const want: any = await main('expect');
    // Preview columns: amount, region, the LOD value, the result.
    const lodOk = pv.rows.length === 8 && pv.rows.every((cells: string[], i: number) =>
      cells[2] === String(want.head[i].total) && cells[3] === String(want.head[i].amount / want.head[i].total));
    ok('lod: every preview row shows its REGION\'s total over the whole table, and the share', lodOk,
      JSON.stringify({ got: pv.rows.slice(0, 2), want: want.head.slice(0, 2) }));
    const tr: any = await main('trace', { op: 'lodPreview' });
    ok('lod: the preview\'s LOD values came off the stored Parquet (resident)', !fx.resident || (!!tr && tr.resident > 0), JSON.stringify(tr));
    await shot('r7-lod-editor.png');

    await click(win, '.fx-modal .btn-primary');
    ok('lod: Save closes the editor', await until(win, () => win.evaluate(() => !document.querySelector('.fx-modal')), 10_000));
    const steps: any[] = await main('steps');
    ok('lod: the field is a calculated_field step, as written', steps.some((st) => st.type === 'calculated_field' && st.name === NAME && st.expression === EXPR),
      JSON.stringify(steps));
    await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(400);

    // ── A visual over it, filtered from the builder's FILTERS well ──────────
    vid = await main<string>('saveVisual', { encoding: ENCODING });
    ok('lod: a visual of sum(share of region) by region', !!vid);
    await win.evaluate(() => selectSection('visuals'));
    await win.waitForTimeout(500);
    await win.evaluate((id: string) => openSavedVisual(id), vid);
    ok('lod: it opens in the builder', await until(win, () => win.evaluate(() => !!document.querySelector('#viz-encoding-mount .js-enc-add-filter'))));
    await click(win, '#viz-encoding-mount .js-enc-add-filter');
    await win.waitForTimeout(200);
    await win.evaluate(() => {
      const sel = document.querySelector('#viz-encoding-mount .viz-filter-row select') as HTMLSelectElement;
      sel.value = 'amount';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await win.waitForTimeout(200);

    const openDialog = async (): Promise<boolean> => {
      await click(win, '#viz-encoding-mount .viz-filter-row .viz-filter-cond');
      return until(win, () => win.evaluate(() => !!document.querySelector('.fd-modal .lod-ctx-switch')), 5000);
    };
    const figures = (): Promise<any> => win.evaluate(async (a: any) => {
      const filters = vizForm.getFilters();
      const r = await (window as any).hub.computeVisualData(a.pid, a.id, a.encoding, filters);
      return { filters, labels: r.ok ? r.data.labels : [], values: r.ok ? r.data.series[0].values : [] };
    }, { pid, id: dsId, encoding: ENCODING });

    ok('lod: the filter dialog offers "Apply before LOD", off by default', await openDialog() &&
      await win.evaluate(() => document.querySelector('.fd-modal .lod-ctx-switch')?.getAttribute('aria-checked') === 'false'));
    await win.fill('.fd-modal .fd-body input', '20');
    await click(win, '.fd-modal .ws-modal-actions .btn-primary');
    await win.waitForTimeout(600);
    const after = await figures();
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
    ok('lod: an ordinary filter runs AFTER the LOD — each region reads its kept rows over the WHOLE region',
      after.filters.length === 1 && !after.filters[0].context && after.labels.length === 7 &&
      after.labels.every((l: string, i: number) => near(after.values[i], want.after[l])) &&
      after.values.some((v: number) => !near(v, 1)), JSON.stringify(after));

    ok('lod: re-opening the filter shows the switch again', await openDialog());
    await click(win, '.fd-modal .lod-ctx-switch');
    const hint = await win.evaluate(() => ({
      on: document.querySelector('.fd-modal .lod-ctx-switch')?.getAttribute('aria-checked'),
      text: document.querySelector('.fd-modal .lod-ctx-hint')?.textContent || '',
    }));
    ok('lod: switched on, it says it is a context filter', hint.on === 'true' && /^Context filter/.test(hint.text), JSON.stringify(hint));
    await shot('r7-lod-context-dialog.png');
    await click(win, '.fd-modal .ws-modal-actions .btn-primary');
    await win.waitForTimeout(600);
    const ctx = await figures();
    ok('lod: the FILTERS well tags it "context"', await win.evaluate(() =>
      (document.querySelector('#viz-encoding-mount .viz-filter-row .lod-ctx-tag')?.textContent || '') === 'context'));
    ok('lod: a context filter runs BEFORE the LOD — every region\'s shares sum to 100%',
      ctx.filters.length === 1 && ctx.filters[0].context === true && ctx.labels.length === 7 &&
      ctx.values.every((v: number) => near(v, 1)), JSON.stringify(ctx));
    await shot('r7-lod-context.png');
    await click(win, '#viz-cancel-btn');
    await win.waitForTimeout(400);
  } finally {
    // ── Leave the app neutral ─────────────────────────────────────────────────
    if (vid) await main('dropVisual', { vid });
    await main('setSteps', { steps: before });
    await win.evaluate(() => { if (typeof dkSetOpen === 'function') dkSetOpen(false); }).catch(() => null);
    await win.evaluate(() => selectSection('datasets')).catch(() => null);
    await win.waitForTimeout(400);
    await win.evaluate(() => { const b = document.getElementById('ds-explorer-close') as HTMLElement | null; if (b && b.getClientRects().length) b.click(); });
    await win.waitForTimeout(300);
  }
  ok('lod: the dataset\'s steps are restored', JSON.stringify(await main('steps')) === JSON.stringify(before));
  ok('lod: back on the Data list, nothing open', await win.evaluate(() =>
    !!document.getElementById('ds-explorer')?.hidden && !document.querySelector('.fx-modal') && !document.querySelector('.fd-modal')));
}
