// Catalog & docs, end to end through the REAL UI — a smoke SECTION, not a
// file with its own launch: the combined workflow smoke calls it with a fresh
// app on which the bundled sample project is seeded ("My project": dataset
// "Retail orders" with a numeric `discount` column, dashboard "Retail
// overview", three visuals, six metrics).
//
// Every step goes through the control a user would touch, and every write is
// read back through IPC — a chip that painted but never reached disk is the
// failure this exists to catch.
//
//   Retail orders → Details → tag "#Sales" (normalised to `sales`) → chip
//   → the `discount` column's Details → a description → persisted
//   → the palette, "#sales" → Retail orders, with its chip
//   → the visual builder → the `discount` option carries the description
//   → Data · Catalog → Retail orders, with its chip
//   → zero renderer console errors

import { ok } from './selfcheck';
import type { Smoke } from './smokeFixture';
import { openProject, domDriver } from './smokeFixture';

const path: typeof import('path') = require('path');

const TAG_TYPED = '#Sales';
const TAG = 'sales';
const DESCRIPTION = 'Share of list price taken off the order';

export async function catalogSection(s: Smoke): Promise<void> {
  const { win } = s;

  // The sample project, read from main — the renderer opens it the way a
  // Recent row does.
  const seeded: { projectId: string; datasetId: string } = await s.app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    for (const p of await projects.listProjects()) {
      const d = (await datasets.listDatasets(p.id)).find((x: any) => x.name === 'Retail orders');
      if (d) return { projectId: p.id, datasetId: d.id };
    }
    return { projectId: '', datasetId: '' };
  });
  ok('catalog: the sample "Retail orders" dataset is on disk', !!seeded.datasetId, JSON.stringify(seeded));
  if (!seeded.datasetId) return;
  const { projectId, datasetId } = seeded;
  await openProject(win, projectId);
  const { clickExact } = domDriver(win);

  // ── Open Retail orders ─────────────────────────────────────────────────────
  ok('catalog: the Data section opens', await clickExact('Data'));
  await win.waitForTimeout(800);
  const opened = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')]
      .find((x) => /Retail orders/.test(x.textContent || '')) as HTMLElement | undefined;
    row?.click();
    return !!row;
  });
  ok('catalog: Retail orders is listed and opens', opened);
  await win.waitForFunction(() => (document.getElementById('ds-explorer-title')?.textContent || '') === 'Retail orders', null, { timeout: 15_000 }).catch(() => {});

  // ── Details → tag it "#Sales" ──────────────────────────────────────────────
  await win.locator('#ds-act-details').click();
  await win.waitForSelector('.ct-pop', { timeout: 8000 }).catch(() => {});
  ok('catalog: the dataset header opens a Details popover', await win.locator('.ct-pop').isVisible());
  const tagBox = win.locator('.ct-pop .ct-tag-input');
  await tagBox.click();
  await tagBox.fill(TAG_TYPED);
  await tagBox.press('Enter');
  await win.waitForFunction((t: string) =>
    [...document.querySelectorAll('.ct-pop .ct-tagedit .ct-chip')].some((c) => (c.textContent || '').trim() === t), TAG, { timeout: 8000 })
    .catch(() => {});
  const popChips = await win.evaluate(() =>
    [...document.querySelectorAll('.ct-pop .ct-tagedit .ct-chip')].map((c) => (c.textContent || '').trim()));
  ok(`catalog: "${TAG_TYPED}" becomes the chip "${TAG}"`, popChips.includes(TAG), JSON.stringify(popChips));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-3-details.png') });
  await win.keyboard.press('Escape');
  await win.waitForSelector('.ct-pop', { state: 'detached', timeout: 5000 }).catch(() => {});
  await win.waitForFunction((t: string) =>
    [...document.querySelectorAll('#ds-explorer-tags .ct-chip')].some((c) => (c.textContent || '').trim() === t), TAG, { timeout: 8000 })
    .catch(() => {});
  ok('catalog: Escape closes the popover and the header shows the chip',
    await win.evaluate((t: string) => !document.querySelector('.ct-pop')
      && [...document.querySelectorAll('#ds-explorer-tags .ct-chip')].some((c) => (c.textContent || '').trim() === t), TAG));
  const doc: any = await win.evaluate(({ p, d }) => (window as any).hub.catalogGet(p, 'dataset:' + d), { p: projectId, d: datasetId });
  ok('catalog: the tag is on disk, normalised, with updatedBy stamped',
    !!doc && doc.ok && doc.doc.tags.some((t: any) => t.name === TAG) && !!doc.doc.updatedBy, JSON.stringify(doc));

  // ── The `discount` column: profile → Details → describe it ─────────────────
  const profiled = await win.evaluate(() => {
    const btn = [...document.querySelectorAll('#ds-explorer-scroll .ds-th-name')]
      .find((b) => (b.textContent || '').trim() === 'discount') as HTMLElement | undefined;
    btn?.click();
    return !!btn;
  });
  ok('catalog: the grid has a `discount` column to profile', profiled);
  await win.waitForSelector('#ds-profile:not([hidden]) .js-dsp-details-btn', { timeout: 8000 }).catch(() => {});
  await win.locator('#ds-profile .js-dsp-details-btn').click();
  await win.waitForSelector('.ct-pop', { timeout: 8000 }).catch(() => {});
  const descBox = win.locator('.ct-pop textarea.ct-input');
  await descBox.fill(DESCRIPTION);
  await descBox.press('Enter');
  await win.waitForFunction(async ({ p, d, want }) => {
    const r: any = await (window as any).hub.catalogColumns(p, d);
    return !!r && r.columns && r.columns.discount && r.columns.discount.description === want;
  }, { p: projectId, d: datasetId, want: DESCRIPTION }, { timeout: 8000 }).catch(() => {});
  const cols: any = await win.evaluate(({ p, d }) => (window as any).hub.catalogColumns(p, d), { p: projectId, d: datasetId });
  ok('catalog: the column description is persisted (re-read over IPC)',
    !!cols && cols.columns && cols.columns.discount && cols.columns.discount.description === DESCRIPTION, JSON.stringify(cols && cols.columns));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  const thTitle = await win.evaluate(() => {
    const btn = [...document.querySelectorAll('#ds-explorer-scroll .ds-th-name')]
      .find((b) => (b.textContent || '').trim() === 'discount') as HTMLElement | undefined;
    return btn ? btn.title : '';
  });
  ok('catalog: the Data tab header tooltip carries the description', thTitle.includes(DESCRIPTION), thTitle);

  // ── The palette: "#sales" ──────────────────────────────────────────────────
  await win.locator('#global-search').click();
  await win.waitForSelector('#cp-overlay:not([hidden])', { timeout: 8000 }).catch(() => {});
  await win.locator('#cp-input').fill('#' + TAG);
  // A record query is debounced, and the empty-query view already lists Retail
  // orders under Recent — so wait for the RESULTS group, not for the name.
  await win.waitForFunction(() => [...document.querySelectorAll('#cp-results .cp-group')]
    .some((g) => (g.textContent || '') === 'Results'), null, { timeout: 8000 }).catch(() => {});
  const hit = await win.evaluate((t: string) => {
    const row = [...document.querySelectorAll('#cp-results .cp-row')]
      .find((r) => (r.querySelector('.cp-row-title')?.textContent || '') === 'Retail orders');
    return { found: !!row, chip: !!row && [...row.querySelectorAll('.ct-chip')].some((c) => (c.textContent || '').trim() === t) };
  }, TAG);
  ok('catalog: the top-bar search, "#sales", finds Retail orders', hit.found, JSON.stringify(hit));
  ok('catalog: …with a sales chip on the hit', hit.chip, JSON.stringify(hit));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-3-search.png') });
  await win.keyboard.press('Escape');
  await win.waitForSelector('#cp-overlay', { state: 'hidden', timeout: 5000 }).catch(() => {});

  // ── The visual builder: the picker carries the description ────────────────
  await win.evaluate(() => { (window as any).selectSection?.('datasets'); });
  await win.waitForTimeout(300);
  await win.locator('#ds-act-visual').click();
  // The create popup opens on step 2 with this dataset chosen; "Build it myself" reaches the builder.
  await win.waitForSelector('.vn-modal .js-vn-manual', { timeout: 8000 }).catch(() => {});
  await win.evaluate(() => { (document.querySelector('.vn-modal .js-vn-manual') as HTMLElement | null)?.click(); });
  await win.waitForFunction(() => !!document.querySelector('#viz-encoding-mount option[value="discount"]'), null, { timeout: 15_000 }).catch(() => {});
  const optTitle = await win.evaluate(() => {
    const o = document.querySelector('#viz-encoding-mount option[value="discount"]') as HTMLOptionElement | null;
    return o ? o.title : '';
  });
  ok('catalog: the builder\'s `discount` option carries the description as its tooltip', optTitle.includes(DESCRIPTION), optTitle);
  await win.locator('#viz-cancel-btn').click().catch(() => {});
  await win.waitForTimeout(400);

  // ── Data · Catalog ─────────────────────────────────────────────────────────
  ok('catalog: back to the Data section', await clickExact('Data'));
  await win.waitForTimeout(400);
  // The Data section remembers the open dataset; the tab strip is on the list.
  await win.evaluate(() => {
    const back = document.getElementById('ds-explorer-close') as HTMLElement | null;
    if (back && back.offsetParent !== null) back.click();
  });
  await win.waitForTimeout(400);
  await win.locator('#ds-tab-catalog').click();
  await win.waitForFunction(() => [...document.querySelectorAll('#ct-list .ct-row')]
    .some((r) => (r.querySelector('.ct-name')?.textContent || '') === 'Retail orders'), null, { timeout: 10_000 }).catch(() => {});
  const row = await win.evaluate((t: string) => {
    const rows = [...document.querySelectorAll('#ct-list .ct-row')];
    const r = rows.find((x) => (x.querySelector('.ct-name')?.textContent || '') === 'Retail orders') as HTMLElement | undefined;
    return {
      rows: rows.length,
      found: !!r,
      chip: !!r && [...r.querySelectorAll('.ct-chip')].some((c) => (c.textContent || '').trim() === t),
      usage: r ? (r.querySelector('.ct-usage')?.textContent || '') : '',
      bar: [...document.querySelectorAll('#ct-table .ct-filter .ct-chip--btn')].map((b) => (b.textContent || '').trim()),
    };
  }, TAG);
  ok('catalog: the Catalog tab lists every record kind (dataset, visuals, dashboard, metrics)', row.rows >= 11, JSON.stringify(row));
  ok('catalog: …Retail orders with its sales chip', row.found && row.chip, JSON.stringify(row));
  ok('catalog: …used by the sample\'s visuals, cards and metrics', Number(row.usage) > 0, row.usage);
  ok('catalog: …and the tag bar offers "sales"', row.bar.includes(TAG), JSON.stringify(row.bar));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-3-catalog.png') });

  ok('catalog: zero renderer console errors', s.errors.length === 0, s.errors.slice(0, 5).join(' | '));
}
