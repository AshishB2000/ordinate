// E2E (T2.7): the Visuals screen against the real server and the seeded sample
// project (three saved visuals: a line, a column and a region map).
//
//   gallery   cards with LIVE thumbnails (canvas ink for the charts, the drawn
//             mini-map for the map) from one `visual:thumbs`; the count chip
//   builder   reopen a saved visual: the chart draws, an aggregation edit
//             recomputes on the server, a chip switches the type, Customize
//             persists a title on the saved visual, Download PNG / Copy data,
//             a pivot draws its grid on its own shelves, Save renames
//   new       "+ New visual" → dataset → Open the builder → Map regions → the
//             region map draws → Save; the card's menu duplicates, renames and
//             deletes (to the Trash)
//   empty     a project with no data: the designed empty state
//
// Every page: no console error or CSP violation, inside the RPC budget.
// Screens in both themes: web/e2e/__screens__/visuals-*.png.

import assert from 'node:assert/strict';
import type { Page, Response } from 'playwright';
import { e2e, screens, settled, type Session } from './fixtures.ts';

async function post(s: Session, channel: string, payload?: unknown) {
  let csrf = (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value;
  if (!csrf) {
    await s.page.goto('/');
    csrf = (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
  }
  return s.page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
}

/** Canvas pixels with any alpha, per canvas under `sel`. */
function ink(page: Page, sel: string): Promise<number[]> {
  return page.evaluate(
    (q) =>
      [...document.querySelectorAll<HTMLCanvasElement>(q)].map((c) => {
        if (!c.width || !c.height) return 0;
        const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
        return n;
      }),
    sel,
  );
}

const rpcReply = (page: Page, channel: string) =>
  page.waitForResponse((r: Response) => r.url().endsWith(`/api/rpc/${encodeURIComponent(channel)}`) && r.request().method() === 'POST');

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}`);
}

e2e('visuals: the gallery with live thumbnails, and the builder on a saved visual', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  await page.goto('/visuals');
  await settled(page);
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Visuals');
  const cards = page.locator('[data-visual-id]');
  await page.getByText('3 visuals', { exact: true }).waitFor();
  assert.equal(await cards.count(), 3);
  // Thumbnails: both charts inked, the map's mini-map drawn.
  await page.waitForFunction(() => document.querySelectorAll('[data-visual-id] canvas').length >= 3);
  await page.waitForFunction(() => document.querySelector('[data-visual-id] [data-drawn="true"]'));
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLCanvasElement>('[data-visual-id] span > canvas')].filter((c) => c.width > 0).length >= 2,
  );
  const thumbInk = await ink(page, '[data-visual-id] span > canvas');
  assert.ok(thumbInk.filter((n) => n > 200).length >= 2, `two chart thumbnails have ink: ${thumbInk.join(',')}`);
  const galleryLoad = s.rpc.loads.at(-1)!;
  assert.ok(galleryLoad.rpcs <= 6, `the gallery costs ${galleryLoad.rpcs} RPCs (thumbnails batched)`);
  await screens(page, 'visuals-gallery');

  // Open the column chart.
  await page.getByRole('button', { name: /^Revenue by category/ }).click();
  await page.waitForURL(new RegExp(`/visuals/${pid}/[0-9a-f-]{36}$`));
  await page.getByRole('heading', { level: 1, name: 'Revenue by category' }).waitFor();
  const area = page.locator('[data-chart-type]');
  await page.waitForFunction(() => document.querySelector('[data-chart-type="column"] canvas'));
  assert.equal(await page.getByRole('radio', { name: /^Column$/ }).getAttribute('aria-checked'), 'true');
  await page.waitForTimeout(400);
  assert.ok((await ink(page, '[data-chart-type] canvas'))[0] > 1000, 'the column chart has ink');

  // An aggregation edit recomputes on the server.
  const recomputed = rpcReply(page, 'visual:preview');
  await page.getByRole('combobox', { name: 'Aggregation' }).click();
  await page.getByRole('option', { name: 'Average' }).click();
  const body = (await (await recomputed).json()) as unknown;
  assert.ok(JSON.stringify(body).includes('avg of revenue'), 'the reply is the average');

  // A chip switches the type.
  await page.getByRole('radio', { name: /^Bar$/ }).click();
  await page.locator('[data-chart-type="bar"] canvas').waitFor();

  // Customize: a title, kept on the saved visual as it changes.
  await page.getByRole('button', { name: 'Chart options' }).click();
  await page.getByRole('button', { name: 'Customize' }).click();
  const saved = rpcReply(page, 'visual:update');
  await page.getByLabel('Title').fill('Revenue, by category');
  assert.equal((await saved).status(), 200);

  // Download PNG and Copy data.
  await page.evaluate(() => {
    const w = window as unknown as { __png?: string };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      w.__png = this.href;
    };
  });
  await page.getByRole('button', { name: 'Download chart (PNG)' }).click();
  assert.ok((await page.evaluate(() => (window as unknown as { __png?: string }).__png ?? '')).startsWith('data:image/png;base64,'));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Chart options' }).click();
  await page.getByRole('button', { name: 'Copy data' }).click();
  await page.getByText('Data copied to clipboard').waitFor();
  const tsv = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(/^Label\tavg of revenue\n/.test(tsv) && tsv.split('\n').length === 4, `TSV: ${tsv}`);
  await screens(page, 'visuals-builder');

  // A pivot table draws its grid (T1.2's GridViz, T2.11's shelves): the server's cells, row headers and all.
  await page.getByRole('button', { name: 'More chart types' }).click();
  await page.getByRole('dialog', { name: 'All chart types' }).getByRole('button', { name: 'Pivot table' }).click();
  await page.getByRole('group', { name: 'Rows' }).waitFor();
  await area.getByRole('table').waitFor();
  await area.getByRole('rowheader').first().waitFor();
  await page.getByRole('radio', { name: /^Column$/ }).click();
  await area.locator('canvas').waitFor();

  // Save: the name dialog starts from the saved name.
  await page.getByRole('button', { name: 'Save visual' }).click();
  const name = page.getByRole('dialog', { name: 'Rename this visual' }).getByLabel('Name');
  assert.equal(await name.inputValue(), 'Revenue by category');
  await name.fill('Average revenue by category');
  await page.getByRole('dialog', { name: 'Rename this visual' }).getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(new RegExp(`/visuals/${pid}$`));
  await page.getByRole('button', { name: /^Average revenue by category/ }).waitFor();

  // History opens the versions page for this visual.
  await page.getByRole('button', { name: 'More actions for Average revenue by category' }).click();
  await page.getByRole('menuitem', { name: 'History' }).click();
  await page.waitForURL(new RegExp(`/versions/${pid}/visual/[0-9a-f-]{36}$`));
  await settled(page);
  report(s);
});

e2e('visuals: a new visual from the dialog, a region map, and the card menu', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  await page.goto(`/visuals/${pid}`);
  await settled(page);
  const before = await page.locator('[data-visual-id]').count();

  await page.getByRole('button', { name: 'New visual' }).click();
  const dialog = page.getByRole('dialog', { name: 'New visual' });
  await dialog.getByRole('radio', { name: /^Retail orders/ }).click();
  await dialog.getByRole('button', { name: 'Open the builder' }).click();
  await page.waitForURL(/\/visuals\/[0-9a-f-]{36}\/new\?dataset=/);
  await page.getByRole('heading', { level: 1, name: 'New visual' }).waitFor();
  await page.locator('[data-chart-type] canvas').waitFor();

  // Category state, measure profit, Map regions: US states → the region map.
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: 'state' }).click();
  await page.getByRole('combobox', { name: 'Measure column' }).click();
  await page.getByRole('option', { name: 'profit' }).click();
  await page.getByRole('combobox', { name: 'Map regions' }).click();
  await page.getByRole('option', { name: 'US states' }).click();
  await page.getByRole('combobox', { name: 'Basemap' }).waitFor();
  const regionMap = page.getByRole('radio', { name: /^Region map$/ });
  await regionMap.waitFor();
  await regionMap.click();
  await page.locator('[data-chart-type="map_choropleth"] canvas').first().waitFor();

  await page.getByRole('button', { name: 'Save visual' }).click();
  const named = page.getByRole('dialog', { name: 'Name this visual' });
  assert.equal(await named.getByLabel('Name').inputValue(), 'profit by state');
  await named.getByLabel('Name').fill('Profit map');
  await named.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(new RegExp(`/visuals/${pid}$`));
  await page.getByRole('button', { name: /^Profit map/ }).waitFor();
  assert.equal(await page.locator('[data-visual-id]').count(), before + 1);

  // The card menu: duplicate, rename the copy, delete it.
  await page.getByRole('button', { name: 'More actions for Profit map' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await page.getByText('Made “Profit map (copy)”.').waitFor();
  await page.getByRole('button', { name: 'More actions for Profit map (copy)' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('dialog', { name: 'Rename this visual' }).getByLabel('Name').fill('Profit map, again');
  await page.getByRole('dialog', { name: 'Rename this visual' }).getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('button', { name: /^Profit map, again/ }).waitFor();
  await page.getByRole('button', { name: 'More actions for Profit map, again' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByText('Moved “Profit map, again” to Trash').waitFor();
  await page.getByRole('button', { name: /^Profit map, again/ }).waitFor({ state: 'detached' });
  // Undo on the toast restores it (trash:restore), then it goes for good.
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: /^Profit map, again/ }).waitFor();
  await page.getByRole('button', { name: 'More actions for Profit map, again' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('button', { name: /^Profit map, again/ }).waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-visual-id]').count(), before + 1);

  // The star pins a card to the front.
  await page.getByRole('button', { name: 'Favourite Profit map' }).click();
  await page.getByRole('button', { name: 'Unfavourite Profit map' }).waitFor();
  assert.equal(await page.locator('[data-visual-id]').first().locator('button').first().textContent().then((t) => t?.startsWith('Profit map')), true);
  report(s);
});

e2e('visuals: filters, analytics, small multiples, the rows behind a bar, and Format', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  await page.goto(`/visuals/${pid}`);
  await settled(page);
  // The first spec saved this one as 'Average revenue by category'; alone it is still the sample's name.
  await page.getByRole('button', { name: /^(Average r|R)evenue by category/ }).first().click();
  await page.locator('[data-chart-type="column"] canvas').waitFor();
  const builderUrl = page.url();

  // A filter: the type-aware dialog lists the column's values from the server.
  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.getByRole('combobox', { name: 'Filter column' }).click();
  await page.getByRole('option', { name: 'region', exact: true }).click();
  await page.getByRole('button', { name: 'Edit the filter on region' }).click();
  const dialog = page.getByRole('dialog', { name: 'Filter: region' });
  await dialog.getByLabel('West', { exact: true }).check();
  await dialog.getByLabel('East', { exact: true }).check();
  const filtered = rpcReply(page, 'visual:preview');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  const fbody = JSON.stringify(await (await filtered).json());
  assert.ok(fbody.includes('"ok":true'), 'the filtered chart recomputed');
  await page.getByRole('button', { name: 'Edit the filter on region' }).filter({ hasText: /is any of (West, East|East, West)/ }).waitFor();

  // Analytics: a reference line, its readout written by the server.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: /Reference line/ }).click();
  await page.locator('[data-kind="reference"]').getByText(/^Average /).waitFor();

  // Format → Colours → colour bars by category: the project's colours list appears.
  await page.getByRole('button', { name: 'Chart options' }).click();
  await page.getByRole('button', { name: 'Customize' }).click();
  await page.getByRole('button', { name: 'Colours', exact: true }).click();
  const kept = rpcReply(page, 'visual:update');
  await page.getByLabel('Colour bars by category').check();
  assert.equal((await kept).status(), 200, 'a saved visual keeps its styling as it changes');
  await page.getByText('“category” colours').waitFor();
  await page.keyboard.press('Escape');

  // Save it, with the filter and the overlay.
  await page.getByRole('button', { name: 'Save visual' }).click();
  await page.getByRole('dialog', { name: 'Rename this visual' }).getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(new RegExp(`/visuals/${pid}$`));

  // Reopen: everything came back from the record; screens of the rail and the chart.
  await page.goto(builderUrl);
  await page.locator('[data-chart-type="column"] canvas').waitFor();
  await page.getByRole('button', { name: 'Edit the filter on region' }).filter({ hasText: /is any of/ }).waitFor();
  await page.locator('[data-kind="reference"]').waitFor();
  await screens(page, 'visuals-panels');

  // Small multiples: one panel per segment, drawn the same way.
  await page.getByRole('combobox', { name: 'Columns' }).click();
  await page.getByRole('option', { name: 'customer_segment' }).click();
  const grid = page.getByRole('group', { name: 'Small multiples' });
  await grid.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Small multiples"] canvas').length === 3);
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Small multiples"] canvas') && document.querySelectorAll('[data-chart-type="column"] canvas').length === 1);

  // The rows behind a bar: a click on the mark opens the drill panel.
  await page.reload();
  const canvas = page.locator('[data-chart-type="column"] canvas');
  await canvas.waitFor();
  await page.waitForTimeout(600);
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.84, box.y + box.height * 0.75);
  const drawer = page.getByRole('dialog', { name: /^(Average r|R)evenue by category$/ });
  await drawer.getByText('The rows behind the selected mark').waitFor();
  await drawer.getByText(/^category = /).waitFor();
  await drawer.getByRole('grid').waitFor();
  const download = page.waitForEvent('download');
  await drawer.getByRole('button', { name: 'Export these rows (CSV)' }).click();
  assert.match((await download).suggestedFilename(), /\.csv$/);
  report(s);
});

e2e('visuals: a project with nothing in it shows the designed empty state', async (s) => {
  const { page } = s;
  const made = await post(s, 'projects:create', { name: 'Empty for visuals' });
  assert.equal(made.status(), 200);
  const { id } = (await made.json()) as { id: string };
  await page.goto(`/visuals/${id}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No visuals yet' }).waitFor();
  await page.getByRole('heading', { name: 'No data yet' }).waitFor();
  await page.getByRole('button', { name: 'Import data' }).waitFor();
  await screens(page, 'visuals-empty');
  report(s);
});
