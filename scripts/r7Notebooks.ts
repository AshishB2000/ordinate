// Round 7 smoke SECTION: notebooks, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round7.ts calls notebooksSection(s, fx) on
// its one launch and fixture.
//
//   Data → Notebooks: the designed empty state → New notebook (named in the
//   app's own prompt) lands on its page with a note and a query → a parameter
//   cell, the first SQL cell rewritten, a second SQL cell that queries the
//   first one's VIEW and reads [[min_amount]], a formula cell, a chart cell, a
//   markdown cell — all through the add-cell bars → Run all: every cell runs,
//   each shows its row count and elapsed ms, the aggregate's figures are main's
//   own fold of the same rows, the chart draws, the note renders → editing the
//   first SQL cell marks everything downstream STALE → Save as dataset through
//   the composer: a `notebook` origin, shown on the dataset's Lineage line and
//   in the lineage graph → "Open notebook" goes back → Pin to dashboard reuses
//   that dataset for a live visual on the sample dashboard, then it is removed
//   → Export Markdown to a temp path (save panel stubbed in main), content
//   checked → everything created is deleted; the Data list is left on screen.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level `let`s (nbPage.ts / nbRun.ts), read by bare name inside evaluate — not on window.
declare let nbDoc: any;
declare const nbResults: Map<string, any>;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
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

/** Set a field's value the way typing does, so its `input` listener sees it. */
const fill = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) return false;
    el.value = a.v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, { q: sel, v: value });

const choose = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLSelectElement | null;
    if (!el || ![...el.options].some((o) => o.value === a.v)) return false;
    el.value = a.v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { q: sel, v: value });

/** The n-th cell (1-based) — a selector. */
const cellSel = (n: number, inner = ''): string => `#nb-cells .nb-cell:nth-of-type(${n}) ${inner}`.trim();

const states = (win: Win): Promise<string[]> =>
  win.evaluate(() => [...document.querySelectorAll('#nb-cells .nb-cell')].map((c) => (c as HTMLElement).dataset.state || ''));

const saved = (win: Win): Promise<boolean> => win.evaluate(() => /· Saved$/.test(document.getElementById('nb-meta')?.textContent || ''));

export async function notebooksSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(250);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const nbStore = req('./src/analysis/notebook/store.js');
    const lineage = req('./src/ipc/lineage.js');
    if (a.fn === 'notebooks') return nbStore.listNotebooks(a.pid);
    if (a.fn === 'notebook') return nbStore.getNotebook(a.pid, a.id);
    if (a.fn === 'fromNotebook') {
      const out: any[] = [];
      for (const d of await datasets.listDatasets(a.pid)) {
        const m = await datasets.getDatasetMeta(a.pid, d.id);
        if (m && m.origin && m.origin.kind === 'notebook' && m.origin.notebookId === a.id) out.push({ id: d.id, origin: m.origin, rows: m.rowCount, deps: d.originDeps });
      }
      return out;
    }
    if (a.fn === 'lineage') {
      const g = await lineage.lineageFor(a.pid, 'dataset', a.id);
      return g ? g.nodes.map((n: any) => n.id) : [];
    }
    if (a.fn === 'aggregate') {
      // main's own fold of the rows the cell reads — the figures it must show.
      const ds = await datasets.getDataset(a.pid, a.id);
      const m = new Map<string, number>();
      for (const r of ds.rows) if (typeof r[2] === 'number' && r[2] > a.min) m.set(r[0], (m.get(r[0]) || 0) + r[2]);
      return [...m].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    }
    if (a.fn === 'analyses') return analysis.listAnalyses(a.pid);
    if (a.fn === 'analysis') return analysis.getAnalysis(a.pid, a.id);
    if (a.fn === 'restoreAnalysis') return analysis.updateAnalysis(a.pid, a.id, { sheets: a.sheets });
    if (a.fn === 'dropAnalysis') return analysis.deleteAnalysis(a.pid, a.id);
    if (a.fn === 'visual') return visuals.getVisual(a.pid, a.id);
    if (a.fn === 'dropVisual') return visuals.deleteVisual(a.pid, a.id);
    if (a.fn === 'dropDataset') return datasets.deleteDataset(a.pid, a.id);
    if (a.fn === 'dropNotebook') return nbStore.deleteNotebook(a.pid, a.id);
    if (a.fn === 'stubSave') {
      const electron = req('electron');
      (globalThis as any).__nbOrigSave ||= electron.dialog.showSaveDialog;
      electron.dialog.showSaveDialog = (async () => ({ canceled: false, filePath: a.file })) as any;
      return true;
    }
    if (a.fn === 'unstubSave') {
      const electron = req('electron');
      if ((globalThis as any).__nbOrigSave) electron.dialog.showSaveDialog = (globalThis as any).__nbOrigSave;
      return true;
    }
    return null;
  }, { fn, pid, ...arg }) as Promise<T>;

  await openProject(win, pid);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(800);
  await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(400);

  // ── The tab and its empty state ───────────────────────────────────────────
  ok('notebooks: a Notebooks tab sits beside Query', await win.evaluate(() =>
    document.getElementById('ds-tab-query')?.nextElementSibling?.id === 'ds-tab-notebooks'));
  ok('notebooks: the tab opens', await click(win, '#ds-tab-notebooks'));
  const before: any[] = await main('notebooks');
  if (!before.length) {
    ok('notebooks: the designed empty state — picture, title, what a notebook does, one action',
      await until(win, () => win.evaluate(() => {
        const e = document.getElementById('nb-empty');
        return !!e && !e.hidden && !!e.querySelector('.nb-empty-art') && e.querySelectorAll('.nb-empty-facts li').length === 3
          && (e.querySelector('.ws-empty-h')?.textContent || '') === 'No notebooks yet';
      })));
    await shot('notebooks-empty.png');
  }

  // ── New notebook ──────────────────────────────────────────────────────────
  await win.evaluate(() => {
    const b = document.querySelector('#nb-empty:not([hidden]) .btn-primary, #nb-new') as HTMLElement | null;
    b?.click();
  });
  await until(win, () => win.evaluate(() => !!document.querySelector('.ws-modal-overlay .ws-modal-input')), 5000);
  await fill(win, '.ws-modal-overlay .ws-modal-input', 'Regional review');
  await click(win, '.ws-modal-overlay .ws-modal-actions .btn-primary');
  ok('notebooks: New notebook lands on its page', await until(win, () => win.evaluate(() => !!document.getElementById('nb-cells'))));
  const nbId: string = await win.evaluate(() => (nbDoc ? nbDoc.id : ''));
  ok('notebooks: it opens on a note and a query over the first dataset', await win.evaluate(() =>
    nbDoc && nbDoc.cells.length === 2 && nbDoc.cells[0].kind === 'markdown' && nbDoc.cells[1].kind === 'sql' && /from \w+/.test(nbDoc.cells[1].sql)),
  await win.evaluate(() => JSON.stringify(nbDoc && nbDoc.cells)));

  // ── Build it: param, SQL, SQL over SQL, formula, chart, markdown ──────────
  // A parameter between the note and the query (the add bar after cell 1).
  ok('notebooks: an add-cell bar between cells adds a parameter there',
    await click(win, '#nb-cells > .nb-add:nth-of-type(2) .nb-add-btn[data-kind="param"]'));
  await until(win, () => win.evaluate(() => nbDoc.cells[1].kind === 'param'));
  await fill(win, cellSel(2, '.nb-param-name'), 'min_amount');
  await fill(win, cellSel(2, '.nb-param-value'), '50');
  // Cell 3 is the starter query: rewrite it.
  await fill(win, cellSel(3, '.nb-sql-input'), 'select region, sku, amount from sales');
  ok('notebooks: the first SQL cell is a view named cell_3', await until(win, async () => (await text(win, cellSel(3, '.nb-view-name'))) === 'cell_3'),
    await text(win, cellSel(3, '.nb-view-name')));
  const addLast = async (kind: string): Promise<boolean> => click(win, `#nb-cells > .nb-add.is-last .nb-add-btn[data-kind="${kind}"]`);
  ok('notebooks: + SQL after the last cell', await addLast('sql'));
  await fill(win, cellSel(4, '.nb-sql-input'), 'select region, sum(amount) as total, count(*) as n\nfrom cell_3\nwhere amount > [[min_amount]]\ngroup by 1\norder by 1');
  await fill(win, cellSel(4, '.nb-cell-title'), 'Big orders');
  ok('notebooks: + Formula', await addLast('formula'));
  await fill(win, cellSel(5, '.nb-fx-col'), 'avg_big');
  await fill(win, cellSel(5, '.nb-fx-expr'), '[total] / [n]');
  ok('notebooks: + Chart', await addLast('chart'));
  const ids: string[] = await win.evaluate(() => nbDoc.cells.map((c: any) => c.id));
  ok('notebooks: …charting the Big orders cell', await until(win, () => choose(win, cellSel(6, '.nb-chart-source'), ids[3])));
  ok('notebooks: + Text', await addLast('markdown'));
  await fill(win, cellSel(7, '.nb-md-input'), '## Findings\nEvery region clears **50** on its big orders.');
  ok('notebooks: the second SQL cell names its view after its title', await until(win, async () => (await text(win, cellSel(4, '.nb-view-name'))) === 'big_orders'));
  ok('notebooks: the graph wires the second query to cell_3 and [[min_amount]] — no problems shown', await until(win, async () => saved(win)) && await win.evaluate(() =>
    [...document.querySelectorAll('#nb-cells .nb-cell-problem')].every((p) => (p as HTMLElement).hidden)),
  await win.evaluate(() => [...document.querySelectorAll('#nb-cells .nb-cell-problem')].map((p) => p.textContent).join(' | ')));


  // ── Run all ───────────────────────────────────────────────────────────────
  ok('notebooks: Run all', await click(win, '#nb-run-all'));
  ok('notebooks: every runnable cell runs and is up to date', await until(win, async () => {
    const st = await states(win);
    return st[2] === 'ok' && st[3] === 'ok' && st[4] === 'ok' && st[5] === 'ok';
  }, 45_000), JSON.stringify(await states(win)));
  const statusOf = (n: number): Promise<string> => text(win, cellSel(n, '.nb-status'));
  ok('notebooks: each result shows its row count and elapsed ms',
    /^[\d,]+\+? rows? · \d+ ms$/.test(await statusOf(3)) && /^7 rows · \d+ ms$/.test(await statusOf(4)) && /^7 rows · \d+ ms$/.test(await statusOf(5))
    && /^Charted 7 rows · \d+ ms$/.test(await statusOf(6)),
  [await statusOf(3), await statusOf(4), await statusOf(5), await statusOf(6)].join(' | '));
  const expect: Array<[string, number]> = await main('aggregate', { id: fx.datasetId, min: 50 });
  const shown: any[][] = await win.evaluate((id: string) => (nbResults.get(id) || {}).rows || [], ids[3]);
  ok('notebooks: the aggregate over the view is main\'s own fold of the same rows, figure for figure',
    shown.length === expect.length && shown.every((r, i) => r[0] === expect[i][0] && Object.is(r[1], expect[i][1])),
    JSON.stringify([shown.map((r) => r.slice(0, 2)), expect]));
  ok('notebooks: the preview grid shows the columns', await win.evaluate((sel: string) =>
    [...document.querySelectorAll(sel)].map((t) => (t.textContent || '').trim()).join() === 'region,total,n', cellSel(4, '.nb-grid-scroll thead .ds-th-name')));
  ok('notebooks: the formula cell adds avg_big', await win.evaluate((sel: string) =>
    [...document.querySelectorAll(sel)].map((t) => (t.textContent || '').trim()).pop() === 'avg_big', cellSel(5, '.nb-grid-scroll thead .ds-th-name')));
  ok('notebooks: the chart draws', await win.evaluate((sel: string) => !!document.querySelector(sel), cellSel(6, '.nb-chart canvas')));
  ok('notebooks: the note renders its Markdown', (await text(win, cellSel(7, '.nb-md-view strong'))) === '50');
  ok('notebooks: the gutter counts runs', /^\[\d+\]$/.test(await text(win, cellSel(4, '.nb-gutter-exec'))));
  await shot('notebooks-run.png');
  await win.evaluate((sel: string) => { document.querySelector(sel)?.scrollIntoView({ block: 'center' }); }, cellSel(6));
  await shot('notebooks-chart.png');

  // ── Edit the first query → downstream is stale ────────────────────────────
  await fill(win, cellSel(3, '.nb-sql-input'), 'select region, sku, amount from sales where sku <> \'000\'');
  ok('notebooks: editing the first SQL cell marks it and everything downstream stale',
    await until(win, async () => {
      const st = await states(win);
      return st[2] === 'stale' && st[3] === 'stale' && st[4] === 'stale' && st[5] === 'stale';
    }), JSON.stringify(await states(win)));
  ok('notebooks: …with the Stale badge, and the parameter and note untouched', await win.evaluate(() =>
    [...document.querySelectorAll('#nb-cells .nb-cell')].map((c) => !(c.querySelector('.nb-stale-badge') as HTMLElement).hidden).join() ===
      'false,false,true,true,true,true,false'));
  await shot('notebooks-stale.png');

  // ── Save as dataset (the composer) → origin + Lineage ─────────────────────
  ok('notebooks: Save as dataset on the Big orders cell', await click(win, cellSel(4, '.nb-save')));
  await win.waitForSelector('#dc-save', { state: 'visible', timeout: 30_000 }).catch(() => null);
  await win.click('#dc-save', { timeout: 8000 }).catch(() => null);
  ok('notebooks: the saved dataset carries a notebook origin naming the cell and its inputs', await until(win, async () => {
    const got: any[] = await main('fromNotebook', { id: nbId });
    return got.length === 1 && got[0].origin.cellId === ids[3] && JSON.stringify(got[0].deps) === JSON.stringify([fx.datasetId]) && got[0].rows === 7;
  }, 30_000), JSON.stringify(await main('fromNotebook', { id: nbId })));
  const savedId: string = ((await main<any[]>('fromNotebook', { id: nbId }))[0] || {}).id || '';
  ok('notebooks: the dataset page\'s Lineage line reads from Sales and opens the notebook', await until(win, () => win.evaluate(() => {
    const host = document.getElementById('ds-lineage');
    return !!host && !host.hidden && /Sales/.test(host.textContent || '') && !!host.querySelector('.ds-lineage-notebook');
  }), 15_000), await text(win, '#ds-lineage'));
  const nodes: string[] = await main('lineage', { id: savedId });
  ok('notebooks: the lineage graph has the notebook as the source and Sales upstream',
    nodes.includes('source:notebook:' + nbId) && nodes.includes('dataset:' + fx.datasetId), JSON.stringify(nodes));
  await shot('notebooks-lineage.png');
  ok('notebooks: "Open notebook" goes back to it', await click(win, '#ds-lineage .ds-lineage-notebook'));
  ok('notebooks: …on its page', await until(win, () => win.evaluate((id: string) => !!nbDoc && nbDoc.id === id && !document.getElementById('nb-page')!.hidden, nbId)));

  // ── Pin the chart to the sample dashboard, then take it off again ─────────
  const boards: any[] = await main('analyses');
  const seeded = boards.length === 0;
  const boardId: string = seeded ? await seedAnalysis(app, pid, { name: 'Notebook board', sheets: [{ name: 'Sheet 1', cards: [] }] }) : String(boards[0].id);
  const boardBefore: any = await main('analysis', { id: boardId });
  await click(win, '#nb-run-all');
  await until(win, async () => (await states(win))[5] === 'ok', 45_000);
  ok('notebooks: Pin to dashboard on the chart', await click(win, cellSel(6, '.nb-pin')));
  await until(win, () => win.evaluate(() => !!document.querySelector('.ws-modal-overlay select.ws-modal-input')), 5000);
  ok('notebooks: …the dashboard is picked in the app\'s own chooser', await choose(win, '.ws-modal-overlay select.ws-modal-input', boardId));
  await click(win, '.ws-modal-overlay .ws-modal-actions .btn-primary');
  let card: any = null;
  ok('notebooks: a visual card lands on the dashboard', await until(win, async () => {
    const a: any = await main('analysis', { id: boardId });
    const cards = (a.sheets[a.sheets.length - 1].cards || []) as any[];
    card = cards.find((c) => c.type === 'visual' && !(boardBefore.sheets[boardBefore.sheets.length - 1].cards || []).some((o: any) => o.id === c.id));
    return !!card;
  }, 20_000));
  const vis: any = card ? await main('visual', { id: card.visualId }) : null;
  ok('notebooks: …a live visual over the SAME saved dataset (reused), with the cell\'s spec',
    !!vis && vis.datasetId === savedId && vis.chartType === 'column' && vis.encoding.category === 'region'
    && vis.encoding.values[0].column === 'total', JSON.stringify(vis));
  ok('notebooks: still one dataset from the notebook', (await main<any[]>('fromNotebook', { id: nbId })).length === 1);
  if (seeded) await main('dropAnalysis', { id: boardId });
  else await main('restoreAnalysis', { id: boardId, sheets: boardBefore.sheets });
  if (vis) await main('dropVisual', { id: vis.id });

  // ── Export Markdown ───────────────────────────────────────────────────────
  const mdFile = path.join(s.userData, 'regional-review.md');
  await main('stubSave', { file: mdFile });
  ok('notebooks: Export Markdown', await click(win, '#nb-export'));
  ok('notebooks: …writes the file', await until(win, () => fs.existsSync(mdFile), 30_000));
  const md = fs.existsSync(mdFile) ? fs.readFileSync(mdFile, 'utf8') : '';
  ok('notebooks: the export has every cell in order: title, note, parameter, SQL, a result table, the formula, the chart image',
    md.startsWith('# Regional review\n') && md.includes('**Parameter** `[[min_amount]]` = `50` (number)')
    && md.indexOf('```sql\nselect region, sku, amount from sales') < md.indexOf('### Big orders')
    && md.includes('| region | total | n |') && md.includes('[avg_big] = [total] / [n]')
    && /!\[Chart\]\(data:image\/png;base64,[A-Za-z0-9+/]+=*\)/.test(md) && md.includes('## Findings'),
  md.slice(0, 600));
  await main('unstubSave');

  // ── Leave the app neutral ─────────────────────────────────────────────────
  if (savedId) await main('dropDataset', { id: savedId });
  await win.evaluate(() => { (document.querySelector('#nb-page .nb-back') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(400);
  await main('dropNotebook', { id: nbId });
  await win.evaluate(() => { (window as any).nbRefreshList?.(); });
  ok('notebooks: nothing of the notebook is left', (await main<any[]>('notebooks')).length === before.length);
  await win.evaluate(() => { if (typeof (window as any).dkSetOpen === 'function') (window as any).dkSetOpen(false); });
  await click(win, '#ds-tab-datasets');
  await win.waitForTimeout(300);
  const neutral = (): Promise<string> => win.evaluate(() => JSON.stringify({
    explorer: !!document.getElementById('ds-explorer')?.hidden,
    nb: !!document.getElementById('nb-wrap')?.hidden,
    list: !document.getElementById('ds-saved')?.hidden,
    modal: !!document.querySelector('.ws-modal-overlay:not([hidden])'),
    composer: !!document.getElementById('ds-composer')?.hidden,
  }));
  ok('notebooks: back on the Data list, nothing open',
    (await neutral()) === JSON.stringify({ explorer: true, nb: true, list: true, modal: false, composer: true }), await neutral());
}
