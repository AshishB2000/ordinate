// Dashboards on a phone (docs/phone-dashboards) at 375×812 with touch, against
// the real server:
//
//   viewer     the sample dashboard on a phone: the app's chrome steps aside, the
//              compact header (name, freshness, Filters), the KPIs one swipeable
//              strip with page dots, every chart full width in reading order, the
//              map's cooperative gestures; the Filters sheet (Compare set → the
//              badge counts it, a swipe closes it); a tap on a bar → the point
//              sheet → "Filter to …" → the chip; the drill as a bottom sheet
//   table      a wide table scrolls sideways inside its card, its first column
//              pinned
//   published  the /p/ page on a phone: the sticky bar, the strip, the filter
//              sheet; a dark-styled dashboard published the same way
//   desktop    the same dashboard and page at 1440×900 are the desktop's: no
//              phone mode, twelve tracks, the shell's rail and top bar
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { e2e, hasWebGL2, SCREENS, settled } from './fixtures.ts';

const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true };

/** One viewport screenshot per theme, without a reload (a sheet stays up). */
async function shots(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

/** A published page's screenshots: its colours are its dashboard's style, not the app's theme. */
async function pubShot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SCREENS, `${name}.png`) });
}

/** One RPC from the page, as the web client sends it (session cookie + CSRF header). */
async function call(page: Page, channel: string, payload: unknown): Promise<any> { // any: each channel's own reply
  return page.evaluate(
    async ([ch, body]) => {
      const m = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})/.exec(document.cookie);
      const res = await fetch(`/api/rpc/${ch}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(m ? { 'X-CSRF-Token': m[1] } : {}) }, body: JSON.stringify({ args: [body] }) });
      return res.json();
    },
    [channel, payload] as const,
  );
}

async function openSample(page: Page, pid: string): Promise<string> {
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  await page.getByRole('link', { name: /Retail overview/ }).first().click();
  await page.getByRole('heading', { level: 1, name: 'Retail overview' }).waitFor();
  await page.getByRole('group', { name: 'Revenue card' }).getByText('$5.2M').waitFor();
  return page.url().split('/').pop()?.split('?')[0] as string;
}

const box = async (l: Locator) => (await l.boundingBox()) as { x: number; y: number; width: number; height: number };

/** Taps across a box until `done()` holds — a bar's pixel position depends on the data and the font. */
async function tapUntil(page: Page, b: { x: number; y: number; width: number; height: number }, done: () => Promise<boolean>): Promise<boolean> {
  for (const fy of [0.75, 0.6, 0.85, 0.45]) {
    for (let c = 1; c <= 8; c++) {
      await page.touchscreen.tap(b.x + (b.width * c) / 9, b.y + b.height * fy);
      await page.waitForTimeout(150);
      if (await done()) return true;
    }
  }
  return false;
}

e2e(
  'viewer: the phone header, a KPI strip, stacked charts, the Filters sheet, a tapped point',
  async ({ page, server, rpc }) => {
    const pid = server.sample.projectId;
    await openSample(page, pid);
    console.log(`rpc: dashboard open on a phone ${rpc.loads.at(-1)?.rpcs ?? 0}`);
    await page.locator('[data-phone]').waitFor();

    // ── The app's chrome steps aside; the dashboard's own header has the way back ──
    assert.equal(await page.getByRole('navigation', { name: 'Sections' }).isVisible(), false, 'the rail is hidden on a phone dashboard');
    assert.equal(await page.getByRole('search').isVisible(), false, 'the top bar is hidden on a phone dashboard');
    await page.getByRole('link', { name: 'Back to Analyses' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Present' }).count(), 0, 'no desktop head');
    assert.equal(await page.getByRole('toolbar').count() + (await page.getByRole('group', { name: 'Add to the sheet' }).count()), 0, 'no authoring tools');

    // ── KPIs: one strip, two cards and a peek, page dots ──
    const strip = page.getByRole('region', { name: 'Key figures, 4' });
    await strip.waitFor();
    for (const k of ['Revenue', 'Profit', 'Units sold', 'Orders']) await strip.getByRole('group', { name: `${k} card` }).waitFor();
    const sb = await box(strip);
    const kb = await box(strip.getByRole('group', { name: 'Revenue card' }));
    assert.ok(kb.width > sb.width * 0.35 && kb.width < sb.width * 0.5, `two cards and a peek to a screen (card ${kb.width} of ${sb.width})`);
    assert.ok(kb.height >= 100, `a KPI tile tall enough to read, got ${kb.height}`);
    const dots = page.getByRole('button', { name: /^Key figures, page \d of \d$/ });
    assert.ok((await dots.count()) >= 2, 'page dots under the strip');
    assert.equal(await dots.first().getAttribute('aria-current'), 'true', 'the first page is current');
    await shots(page, 'phone-viewer');
    await dots.last().click();
    await page.waitForFunction(() => {
      const d = [...document.querySelectorAll('button[aria-label^="Key figures, page"]')];
      return d.at(-1)?.getAttribute('aria-current') === 'true';
    });
    assert.ok((await strip.evaluate((el) => el.scrollLeft)) > 0, 'a dot scrolls the strip');
    const snap = await strip.evaluate((el) => getComputedStyle(el).scrollSnapType);
    assert.match(snap, /x mandatory/, 'the strip snaps card by card');

    // ── Charts: full width, one column, in reading order; prose grows to its words ──
    const stack = page.locator('[data-phone-stack]');
    const stackW = (await box(stack)).width;
    const charts = ['Revenue by month', 'Revenue by category', 'Profit by state'];
    let lastY = -1;
    for (const name of charts) {
      const b = await box(page.getByRole('group', { name: `${name} card` }));
      assert.ok(Math.abs(b.width - stackW) <= 1, `${name} is full width (${b.width} of ${stackW})`);
      assert.ok(b.y > lastY, `${name} comes after the one before it`);
      assert.ok(b.height >= 260 && b.height <= 360, `${name} is phone height, got ${b.height}`);
      lastY = b.y;
    }
    const head = page.getByRole('group', { name: 'Revenue by month card' }).locator('> div').first();
    assert.equal(await head.evaluate((el) => getComputedStyle(el).touchAction), 'auto', 'a finger on a card title scrolls the page');
    // The map: one finger scrolls the page, two move the map — where the page can draw one. Without
    // WebGL2 (the nightly's headless Firefox) it shows its designed state; Chromium without it fails.
    const map = page.getByRole('group', { name: 'Profit by state card' });
    if (await hasWebGL2(page)) {
      await map.locator('.maplibregl-canvas').waitFor({ timeout: 15_000 });
      assert.equal(await map.locator('.maplibregl-cooperative-gestures, .maplibregl-cooperative-gesture-screen').count() > 0, true, 'cooperative gestures on a touch screen');
    } else await map.locator('[data-map-status="nowebgl"]').getByText('This map needs WebGL').waitFor();
    await map.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await shots(page, 'phone-viewer-charts');

    // ── Filters: a bottom sheet with the controls and the view; the badge counts what narrows ──
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await sheet.getByRole('heading', { name: 'View' }).waitFor();
    await sheet.getByRole('combobox', { name: 'Compare this dashboard with' }).click();
    await page.getByRole('option', { name: /previous period/i }).click();
    // Behind the open sheet the header is inert (aria-hidden), so it is found with the hidden ones.
    await page.getByRole('button', { name: 'Filters, 1 active', includeHidden: true }).waitFor({ state: 'attached' });
    await page.waitForTimeout(400); // the rise
    const sh = await box(sheet);
    assert.ok(Math.abs(sh.y + sh.height - 812) <= 1, 'the sheet sits on the bottom edge');
    await shots(page, 'phone-filters');
    // Swipe it down by its handle.
    const grab = sheet.locator('> div').first();
    const g = await box(grab);
    await page.mouse.move(g.x + g.width / 2, g.y + 10);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + 80, { steps: 4 });
    await page.mouse.move(g.x + g.width / 2, g.y + 220, { steps: 4 });
    await page.mouse.up();
    await sheet.waitFor({ state: 'detached' });
    // Compare off again, through Clear all.
    await page.getByRole('button', { name: 'Filters, 1 active' }).click();
    await sheet.getByRole('button', { name: 'Clear all' }).click();
    await page.getByRole('button', { name: 'Filters', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });

    // ── A tap on a bar: what to do with it, in a sheet ──
    const bars = page.getByRole('group', { name: 'Revenue by category card' });
    await bars.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    const point = page.getByRole('dialog').filter({ has: page.getByRole('list', { name: /^What to do with / }) });
    const hit = await tapUntil(page, await box(bars.locator('canvas').first()), async () => (await point.count()) === 1);
    assert.ok(hit, 'a tap on a bar opens the point sheet');
    await point.getByRole('button', { name: /^Show the rows behind this point/ }).waitFor();
    await point.getByRole('button', { name: /^Comment on this point/ }).waitFor();
    await shots(page, 'phone-point');
    const filter = point.getByRole('button', { name: /^Filter to “/ });
    const label = ((await filter.textContent()) ?? '').replace(/^Filter to “([^”]+)”.*$/, '$1');
    await filter.click();
    await point.waitFor({ state: 'detached' });
    await page.getByRole('group', { name: 'Click filters' }).getByRole('button', { name: new RegExp(`^Remove click filter category: ${label}`) }).waitFor();
    // The drill is a bottom sheet too.
    await tapUntil(page, await box(bars.locator('canvas').first()), async () => (await point.count()) === 1);
    await point.getByRole('button', { name: /^Show the rows behind this point/ }).click();
    const drill = page.getByRole('dialog', { name: 'Revenue by category' });
    await drill.getByRole('grid').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(400); // the rise
    const db = await box(drill);
    assert.ok(Math.abs(db.width - 375) <= 1 && Math.abs(db.y + db.height - 812) <= 1, `the drill rises from the bottom edge, full width (${JSON.stringify(db)})`);
    await shots(page, 'phone-drill');
    await page.keyboard.press('Escape');
  },
  { device: PHONE },
);

e2e(
  'table: a wide table scrolls sideways with its first column pinned',
  async ({ page, server }) => {
    const pid = server.sample.projectId;
    await page.goto(`/analyses?project=${pid}`);
    await settled(page);
    const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
    const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
    const t = await call(page, 'visual:save', {
      projectId: pid, datasetId: ds, name: 'Revenue by state and category', chartType: 'table',
      encoding: { category: 'state', series: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] },
    });
    const card = (type: string, layout: object, extra: object) => ({ id: crypto.randomUUID(), type, layout, ...extra });
    const made = await call(page, 'analysis:create', {
      projectId: pid,
      name: 'State table',
      sheets: [{ id: crypto.randomUUID(), name: 'Sheet 1', cards: [
        card('text', { x: 0, y: 0, w: 12, h: 2 }, { heading: 'Where revenue comes from', text: 'Each state’s revenue by product category, read across a row to compare the categories within a state and down a column to compare states. The figures are the server’s, summed from every order.' }),
        card('visual', { x: 0, y: 2, w: 12, h: 8 }, { visualId: t.visual?.id ?? t.id }),
      ] }],
    });
    await page.goto(`/analyses/${pid}/${made.id}`);
    await settled(page);
    await page.locator('[data-phone]').waitFor();
    const table = page.getByRole('group', { name: 'Revenue by state and category card' }).getByRole('table');
    await table.waitFor();
    const scroller = table.locator('xpath=..');
    const wide = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth + 20);
    assert.ok(wide, 'the table is wider than the phone and scrolls inside its card');
    const first = table.locator('tbody tr').first().locator('th').first();
    const x0 = (await box(first)).x;
    await scroller.evaluate((el) => el.scrollBy(160, 0));
    await page.waitForTimeout(200);
    assert.ok(Math.abs((await box(first)).x - x0) <= 1, 'the first column stays put while the rest scrolls');
    const note = page.getByRole('group', { name: 'Where revenue comes from card' });
    assert.ok((await box(note)).height > 100, 'the note grows to its words, not a clipped row');
    await shots(page, 'phone-table');
  },
  { device: PHONE },
);

/** A dashboard with a Category control, three KPIs and a bar chart over the same column. */
async function categoryBoard(page: Page, pid: string): Promise<string> {
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const vis = (await call(page, 'visual:list', { projectId: pid })) as { id: string; name: string }[];
  const bars = vis.find((v) => v.name === 'Revenue by category')?.id as string;
  const card = (type: string, layout: object, extra: object) => ({ id: crypto.randomUUID(), type, layout, ...extra });
  const metric = (x: number, column: string, aggregation: string, label: string) => card('metric', { x, y: 1, w: 4, h: 2 }, { metric: { datasetId: ds, column, aggregation, label } });
  const made = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Category board',
    sheets: [{ id: crypto.randomUUID(), name: 'Overview', cards: [
      card('control', { x: 0, y: 0, w: 3, h: 1 }, { control: { kind: 'dropdown', label: 'Category', datasetId: ds, column: 'category' } }),
      metric(0, 'revenue', 'sum', 'Revenue'),
      metric(4, 'profit', 'sum', 'Profit'),
      metric(8, 'units', 'sum', 'Units sold'),
      card('visual', { x: 0, y: 3, w: 12, h: 7 }, { visualId: bars }),
    ] }, { id: crypto.randomUUID(), name: 'Regions', cards: [] }],
  });
  return made.id as string;
}

e2e(
  'published: the /p/ page on a phone — the sticky bar, the strip, the filter sheet, a tapped bar, a dark style',
  async ({ page, server }) => {
    const pid = server.sample.projectId;
    await page.goto(`/analyses?project=${pid}`);
    await settled(page);
    const aid = await categoryBoard(page, pid);

    // In the app first: a control in the Filters sheet, one full-width row.
    await page.goto(`/analyses/${pid}/${aid}`);
    await settled(page);
    await page.locator('[data-phone]').waitFor();
    await page.getByRole('tablist', { name: 'Sheets' }).getByRole('tab', { name: 'Regions' }).waitFor();
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    const inApp = page.getByRole('dialog', { name: 'Filters' });
    await inApp.getByRole('region', { name: 'Controls' }).waitFor();
    await page.waitForTimeout(400);
    await shots(page, 'phone-filters-controls');
    await page.keyboard.press('Escape');

    const run = await call(page, 'publish:run', { projectId: pid, dashboardIds: [aid] });
    assert.equal(run.ok, true, JSON.stringify(run).slice(0, 300));
    await page.goto(`/p/${run.site.id}/${run.site.pages[0].file}`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true' && document.querySelectorAll('canvas').length > 0);
    const bar = page.locator('.pub-dashhead');
    assert.equal(await bar.evaluate((el) => getComputedStyle(el).position), 'sticky', 'the title row is a sticky bar');
    assert.match((await page.locator('.pub-dashhead-stamp').textContent()) ?? '', /^Published /);
    const strip = page.getByRole('region', { name: 'Key figures, 3' });
    await strip.waitFor();
    assert.equal(await page.locator('.pub-grid > .pub-in-strip').count(), 3, 'the three KPIs are in the strip');
    assert.equal(await page.locator('.pub-grid > .pub-in-strip:visible').count(), 0, 'the KPIs the strip holds are not drawn twice');
    const kw = (await box(strip.locator('.pub-card').first())).width;
    assert.ok(kw > 130 && kw < 175, `two KPI tiles and a peek to a screen, got ${kw}`);
    await page.waitForTimeout(600);
    await pubShot(page, 'phone-published-light');

    // The filter sheet: a select a thumb can use, Done; the badge counts what is picked.
    const open = page.locator('.pub-filters-open');
    await open.click();
    const sheet = page.getByRole('dialog', { name: 'Filters' });
    await sheet.waitFor();
    await page.waitForTimeout(400);
    const sb = await box(sheet);
    assert.ok(Math.abs(sb.y + sb.height - 812) <= 1, 'the filter sheet sits on the bottom edge');
    await pubShot(page, 'phone-published-filters-light');
    await sheet.locator('select[data-control="0"]').selectOption({ index: 1 });
    await sheet.getByRole('button', { name: 'Done' }).click();
    await sheet.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.pub-filters-badge').textContent(), '1', 'the badge counts the picked filter');
    await page.locator('select[data-control="0"]').evaluate((el) => {
      (el as HTMLSelectElement).value = '0';
      el.dispatchEvent(new Event('change'));
    });

    // A tapped bar asks before it filters.
    await page.mouse.wheel(0, 260);
    const canvas = page.locator('.pub-card--chart canvas').first();
    const ask = page.getByRole('dialog').filter({ hasText: 'Filter this page to' });
    const hit = await tapUntil(page, await box(canvas), async () => (await ask.count()) === 1);
    assert.ok(hit, 'a tap on a bar opens the sheet');
    await page.waitForTimeout(400);
    await pubShot(page, 'phone-published-point-light');
    await ask.getByRole('button', { name: /^Filter this page to/ }).click();
    await ask.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.pub-filters-badge').textContent(), '1', 'the tap filtered the page');
    // Scroll: the bar scrolls up to the top edge and stays there (a shorter screen, so this short page scrolls).
    await page.setViewportSize({ width: 375, height: 560 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const y0 = (await box(bar)).y;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(300);
    const scrolled = await page.evaluate(() => window.scrollY);
    assert.ok(scrolled > y0, `the page scrolls past the bar (${scrolled} > ${y0})`);
    assert.ok(Math.abs((await box(bar)).y) <= 1, 'the bar stays at the top while the page scrolls');
    await pubShot(page, 'phone-published-scrolled-light');
    await page.setViewportSize(PHONE.viewport);

    // The same dashboard styled Dark, published again. RPCs go from the app: the /p/ page's own CSP fetches nothing.
    await page.goto(`/analyses?project=${pid}`);
    await settled(page);
    await call(page, 'analysis:update', { projectId: pid, id: aid, style: { theme: 'dark', chosen: true } });
    const dark = await call(page, 'publish:run', { projectId: pid, dashboardIds: [aid], id: run.site.id });
    assert.equal(dark.ok, true, JSON.stringify(dark).slice(0, 300));
    await page.goto(`/p/${dark.site.id}/${dark.site.pages[0].file}`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true' && document.querySelectorAll('canvas').length > 0);
    await page.waitForTimeout(600);
    await pubShot(page, 'phone-published-dark');
    await page.locator('.pub-filters-open').click();
    await page.getByRole('dialog', { name: 'Filters' }).waitFor();
    await page.waitForTimeout(400);
    await pubShot(page, 'phone-published-filters-dark');
  },
  { device: PHONE },
);

e2e('desktop: unchanged — no phone mode, twelve tracks, the shell, the published grid', async ({ page, server }) => {
  const pid = server.sample.projectId;
  const aid = await openSample(page, pid);
  assert.equal(await page.locator('[data-phone]').count(), 0, 'no phone mode at 1440');
  await page.getByRole('navigation', { name: 'Sections' }).waitFor();
  await page.getByRole('search').waitFor();
  await page.getByRole('button', { name: 'Present' }).waitFor();
  const tracks = await page.locator('[data-sheet-grid]').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(tracks, 12, 'the desktop grid has twelve tracks');
  assert.equal(await page.getByRole('region', { name: /^Key figures/ }).count(), 0, 'no KPI strip on desktop');
  const run = await call(page, 'publish:run', { projectId: pid, dashboardIds: [aid] });
  await page.goto(`/p/${run.site.id}/${run.site.pages[0].file}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const pub = await page.locator('.pub-grid').evaluate((el) => ({ display: getComputedStyle(el).display, tracks: getComputedStyle(el).gridTemplateColumns.split(' ').length }));
  assert.deepEqual(pub, { display: 'grid', tracks: 12 }, 'the published grid is the desktop grid');
  assert.equal(await page.locator('.pub-kpis').first().isVisible(), false, 'no strip on a desktop page');
  assert.equal(await page.locator('.pub-dashhead').evaluate((el) => getComputedStyle(el).display), 'contents', 'the title row draws nothing of its own');
});
