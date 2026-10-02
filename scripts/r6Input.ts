// Depth round 6 smoke SECTION: input tables, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round6.ts calls inputSection(s, fx) on its
// one launch and fixture.
//
//   Data → "Input table" → the dialog's designed "Define your columns" state →
//   three columns (text region, number target, a lookup to Sales.region) →
//   Create lands on the grid → values typed with the keyboard (Tab across,
//   Enter down, Home) → a TSV block pasted through a real ClipboardEvent (a
//   quoted cell with a comma in it) → ⌘D fill down → focus leaves the grid:
//   "Saved · 5 rows", and main's stored table read back → the text typed in the
//   number column is flagged and stored as NULL, never as a number; the lookup
//   value outside Sales' regions is flagged → ⌘Z undoes ONE batch, through the
//   app's own keymap, and the stored table follows on blur → History lists one
//   version per batch → a metric over the table shows its sum on the Metrics
//   tab. Leaves the project's Data list on screen and nothing open.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level `let`s (inputPage.ts), read by bare name inside evaluate — not on window.
declare let itS: any;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
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

/** Set an input's value the way typing does, so its `input` listener sees it. */
const fill = (win: Win, sel: string, value: string): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string }) => {
    const el = document.querySelector(a.q) as HTMLInputElement | null;
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

const grid = (win: Win): Promise<any[][]> => win.evaluate(() => (itS ? itS.rows : []));
const undoDepth = (win: Win): Promise<number> => win.evaluate(() => (itS ? itS.hist.past.length : -1));
const cell = (win: Win, r: number, c: number): Promise<{ text: string; cls: string; title: string } | null> =>
  win.evaluate((a: { r: number; c: number }) => {
    const td = document.getElementById(`it-c-${a.r}-${a.c}`);
    return td ? { text: (td.textContent || '').trim(), cls: td.className, title: td.title } : null;
  }, { r, c });

export async function inputSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const salesId = fx.datasetId;
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(250);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const versions = req('./src/app/versions.js');
    const metrics = req('./src/analysis/metrics.js');
    const { resolveMetric } = req('./src/ipc/metrics.js');
    if (a.fn === 'find') return ((await datasets.listDatasets(a.pid)).find((d: any) => d.name === a.name) || {}).id || null;
    if (a.fn === 'record') {
      const ds = await datasets.getDataset(a.pid, a.id);
      return ds && { kind: ds.sourceKind, columns: ds.columns, rows: ds.rows, input: ds.input || null };
    }
    if (a.fn === 'versions') return (await versions.list(a.pid, 'dataset', a.id)).map((v: any) => v.summary);
    if (a.fn === 'metric') {
      const m = await metrics.saveMetric(a.pid, { name: 'Regional target', datasetId: a.id, definition: { column: 'target', aggregation: 'sum' } });
      return m && { id: m.id, value: (await resolveMetric(a.pid, m.id)).value };
    }
    if (a.fn === 'dropMetric') return metrics.deleteMetric(a.pid, a.metricId);
    return null;
  }, { fn, pid, ...arg }) as Promise<T>;

  await openProject(win, pid);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(800);
  // The doors live on the dataset LIST; a page an earlier section opened would hide them.
  await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(400);

  // ── New dataset → Input table ─────────────────────────────────────────────
  ok('input: the Data section offers "Input table" beside Import and Paste', await click(win, '#ds-input-open'));
  await until(win, () => win.evaluate(() => !!document.querySelector('.it-modal')), 5000);
  ok('input: the dialog opens on the designed "Define your columns" state',
    (await text(win, '.it-modal .ws-empty-h')) === 'Define your columns', await text(win, '.it-modal'));
  ok('input: it is a real dialog, focus inside', await win.evaluate(() => {
    const box = document.querySelector('.it-modal');
    return !!box && box.getAttribute('role') === 'dialog' && box.contains(document.activeElement);
  }));
  await fill(win, '.it-modal .me-field input', 'Regional targets');
  await click(win, '.it-modal .ws-empty .btn-primary');
  await click(win, '.it-modal .it-add-col');
  await click(win, '.it-modal .it-add-col');
  const rowSel = (i: number, part: string): string => `.it-modal .it-col-row:nth-child(${i}) ${part}`;
  await fill(win, rowSel(1, '.it-col-name'), 'region');
  await win.evaluate(() => { (document.querySelector('.it-modal .it-col-row:nth-child(1) .it-col-req input') as HTMLInputElement).click(); });
  await fill(win, rowSel(2, '.it-col-name'), 'target');
  await choose(win, rowSel(2, '.it-col-type'), 'number');
  await fill(win, rowSel(3, '.it-col-name'), 'sales_region');
  const lookupValue = JSON.stringify([salesId, 'region']);
  ok('input: a column can take its values from Sales · region',
    await until(win, () => choose(win, rowSel(3, '.it-col-lookup'), lookupValue), 10_000));
  ok('input: a lookup column\'s type follows the key\'s', await win.evaluate(() =>
    (document.querySelector('.it-modal .it-col-row:nth-child(3) .it-col-type') as HTMLSelectElement).disabled));
  await shot('input-define.png');
  ok('input: Create table', await click(win, '.it-modal .ws-modal-actions .btn-primary'));
  await until(win, () => win.evaluate(() => !document.querySelector('.it-modal') && !!document.querySelector('#ds-explorer.is-input #it-grid thead')), 15_000);
  const id: string | null = await main('find', { name: 'Regional targets' });
  const created: any = id ? await main('record', { id }) : null;
  ok('input: it is an ordinary dataset with sourceKind "input" and the three definitions', !!created && created.kind === 'input'
    && JSON.stringify(created.columns.map((c: any) => [c.name, c.type, !!c.required, c.lookup ? c.lookup.column : ''])) ===
      JSON.stringify([['region', 'text', true, ''], ['target', 'number', false, ''], ['sales_region', 'text', false, 'region']]),
    JSON.stringify(created && created.columns));
  ok('input: it opens on its grid, empty, with the designed empty state',
    (await text(win, '#it-empty .it-empty-h')) === 'No rows yet' && /Type to add the first row/.test(await text(win, '#it-grid tbody')));
  ok('input: the list badge says Input', await win.evaluate(() => (document.getElementById('ds-explorer-source')?.textContent || '') === 'Input'));

  // ── Keyboard: type, Tab across, Enter down ─────────────────────────────────
  await win.click('#it-c-0-0');
  await win.keyboard.type('north');
  await win.keyboard.press('Tab');
  await win.keyboard.type('120');
  await win.keyboard.press('Tab');
  await win.keyboard.type('region1');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Home');
  await win.keyboard.type('south');
  await win.keyboard.press('Tab');
  await win.keyboard.type('80');
  await win.keyboard.press('Tab');
  await win.keyboard.type('region2');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Home');
  ok('input: typing, Tab and Enter filled two rows', JSON.stringify(await grid(win)) === JSON.stringify([['north', '120', 'region1'], ['south', '80', 'region2']]),
    JSON.stringify(await grid(win)));
  ok('input: each typed cell is one undo step', (await undoDepth(win)) === 6, String(await undoDepth(win)));
  ok('input: the active cell is the new-row line\'s first cell', await win.evaluate(() => itS.sel.r1 === 2 && itS.sel.c1 === 0));
  ok('input: unsaved edits say so', /Unsaved/.test(await text(win, '#it-status')), await text(win, '#it-status'));

  // ── Paste a TSV block through the real paste handler ──────────────────────
  await win.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'east\t300\tregion3\r\nwest\tabc\tregion4\r\n"central, hq"\t150\tmars\r\n');
    document.getElementById('it-grid')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  ok('input: a 3×3 paste lands as three new rows', (await grid(win)).length === 5 && JSON.stringify((await grid(win))[4]) === JSON.stringify(['central, hq', '150', 'mars']),
    JSON.stringify(await grid(win)));
  ok('input: the paste is ONE undo step', (await undoDepth(win)) === 7);

  // ── ⌘D fill down ──────────────────────────────────────────────────────────
  await win.click('#it-c-1-1');
  await win.keyboard.press('Shift+ArrowDown');
  await win.keyboard.press(`${mod}+d`);
  ok('input: ⌘D copies the first row of the selection down (80 over 300), no series', String((await grid(win))[2][1]) === '80', JSON.stringify(await grid(win)));
  ok('input: the fill is one undo step', (await undoDepth(win)) === 8);

  // ── Blur saves; main's table read back ────────────────────────────────────
  await win.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  ok('input: leaving the grid saves — "Saved · 5 rows"', await until(win, async () => /^Saved · 5 rows/.test(await text(win, '#it-status'))), await text(win, '#it-status'));
  const rec: any = await main('record', { id });
  ok('input: the stored rows, typed numbers stored as numbers', JSON.stringify(rec.rows) === JSON.stringify([
    ['north', 120, 'region1'], ['south', 80, 'region2'], ['east', 80, 'region3'], ['west', null, 'region4'], ['central, hq', 150, 'mars'],
  ]), JSON.stringify(rec.rows));
  ok('input: "abc" in the number column is NOT stored as a number — NULL, with the text kept aside',
    rec.rows[3][1] === null && JSON.stringify(rec.input) === JSON.stringify({ invalid: [[3, 1, 'abc']] }), JSON.stringify(rec.input));
  await until(win, async () => /is-bad/.test((await cell(win, 3, 1))?.cls || ''));
  const bad = await cell(win, 3, 1);
  ok('input: the grid still shows "abc", with the validation marker and the reason',
    !!bad && bad.text === 'abc' && /is-bad/.test(bad.cls) && /Not a number/.test(bad.title), JSON.stringify(bad));
  const stranger = await cell(win, 4, 2);
  ok('input: a lookup value outside Sales\' regions is flagged', !!stranger && /is-bad/.test(stranger.cls) && /Not a value of Sales · region/.test(stranger.title),
    JSON.stringify(stranger));
  ok('input: the status line counts the cells that need attention', /2 cells need attention/.test(await text(win, '#it-attn')), await text(win, '#it-attn'));
  await shot('input-grid.png');
  const v1: string[] = await main('versions', { id });
  ok('input: one version per batch (8 batches + the creation)', v1.length === 9, JSON.stringify(v1));
  ok('input: each version says what its batch did', v1[0] === 'Edited 1 cell' && v1[1] === 'Added 3 rows' && v1[v1.length - 1] === 'Created the table', JSON.stringify(v1));

  // ── ⌘Z undoes ONE batch, through the app's keymap ──────────────────────────
  await win.click('#it-c-0-0');
  await win.keyboard.press(`${mod}+z`);
  ok('input: ⌘Z undid the fill — 300 is back', String((await grid(win))[2][1]) === '300', JSON.stringify(await grid(win)));
  ok('input: …and only the fill', (await undoDepth(win)) === 7 && String((await grid(win))[1][1]) === '80');
  await win.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  await until(win, async () => /^Saved/.test(await text(win, '#it-status')));
  ok('input: the undo is saved on blur', await until(win, async () => ((await main<any>('record', { id })).rows[2][1]) === 300));

  // ── Version history ───────────────────────────────────────────────────────
  ok('input: History is on the toolbar', await click(win, '#it-history'));
  await until(win, () => win.evaluate(() => document.querySelectorAll('.vh-row').length > 0), 10_000);
  const listed: string[] = await win.evaluate(() => [...document.querySelectorAll('.vh-row .vh-summary')].map((e) => (e.textContent || '').trim()));
  ok('input: History lists a version per batch — 10 with the undo', listed.length === 10 && listed[0] === 'Edited 1 cell', JSON.stringify(listed));
  ok('input: the panel names it a table', (await text(win, '.ws-side[data-kind="history"] .dsp-kind')) === 'Version history · Table',
    await text(win, '.ws-side[data-kind="history"] .dsp-kind'));
  await win.evaluate(() => { const b = document.querySelectorAll('.vh-row')[1] as HTMLElement | undefined; b?.click(); });
  await until(win, () => win.evaluate(() => !!document.querySelector('.vh-table')), 5000);
  ok('input: a version previews its table', await win.evaluate(() => !!document.querySelector('.vh-preview .vh-table')));
  await shot('input-history.png');
  await win.evaluate(() => { if (typeof (window as any).spClose === 'function') (window as any).spClose(); });

  // ── A lookup cell's dropdown of the key column's values ────────────────────
  await win.click('#it-c-4-2');
  await win.keyboard.press('F2');
  ok('input: editing a lookup cell lists Sales\' regions', await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#it-pop .it-opt')].map((o) => o.textContent).join() ===
      'region0,region1,region2,region3,region4,region5,region6'), 10_000),
  await win.evaluate(() => [...document.querySelectorAll('#it-pop .it-opt')].map((o) => o.textContent).join()));
  await shot('input-lookup.png');
  const theme = await win.evaluate(() => document.documentElement.dataset.theme || '');
  await win.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot('input-lookup-dark.png');
  await win.evaluate((t: string) => { document.documentElement.dataset.theme = t; }, theme);
  await win.evaluate(() => {
    const o = [...document.querySelectorAll('#it-pop .it-opt')].find((x) => x.textContent === 'region5') as HTMLElement | undefined;
    o?.click();
  });
  ok('input: picking a value writes it', (await grid(win))[4][2] === 'region5' && !(await win.evaluate(() => !!document.getElementById('it-pop'))));
  await win.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  ok('input: …and the lookup flag clears once saved', await until(win, async () =>
    /1 cell needs attention/.test(await text(win, '#it-attn')) && !/is-bad/.test((await cell(win, 4, 2))?.cls || '')), await text(win, '#it-attn'));
  ok('input: that pick is one more version', (await main<string[]>('versions', { id })).length === 11);

  // ── A metric over the input table ─────────────────────────────────────────
  const metric: any = await main('metric', { id });
  ok('input: a metric over the table is its sum (120 + 80 + 300 + 150; the refused cell is empty)', !!metric && Object.is(metric.value, 650), JSON.stringify(metric));
  await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(500);
  await click(win, '#ds-tab-metrics');
  const valueSel = `.mp-row[data-metric-id="${metric && metric.id}"] .mp-value`;
  ok('input: the Metrics tab shows it', await until(win, async () => (await text(win, valueSel)) === '650', 15_000), await text(win, valueSel));

  // ── Leave the app neutral ─────────────────────────────────────────────────
  if (metric) await main('dropMetric', { metricId: metric.id });
  await click(win, '#ds-tab-datasets');
  await win.waitForTimeout(300);
  ok('input: back on the Data list, nothing open', await win.evaluate(() =>
    !!document.getElementById('ds-explorer')?.hidden && !document.querySelector('.ws-modal-overlay:not([hidden]) .it-modal') && !document.getElementById('it-pop')));
}
