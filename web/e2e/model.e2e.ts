// The Data model (docs/semantic-layer/00-design.md, step 10) against the real server and the seeded
// sample project:
//
//   1. Datasets: the "To fill in next" strip opens the dataset where its gap is filled in; a role and a
//      key saved in the Overview, the key counted by the server, and the strip re-ranked by the same
//      count; a guide written and rendered; the column notes and the lineage graph, inline.
//   2. Metrics (moved from /data/metrics, which redirects): the table from the server with each metric's
//      date and whether it adds up, a new metric with a live preview and a filter, delete to Trash.
//   3. Glossary: a term made here, added to a visual's filters, changes its chart, and reads "1 visual".
//   4. An empty project: nothing to describe on any tab. The error and loading states.
//
//   npm --prefix web run e2e -- model

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, screensInPlace, settled } from './fixtures.ts';
import { phoneFits } from './phoneFits.ts';

/** The loading skeleton in both themes: `channel` is held unanswered while each theme loads. */
async function loadingShots(page: Page, url: string, channel: string, label: string, name: string): Promise<void> {
  const held = `**/api/rpc/${encodeURIComponent(channel)}`;
  await page.route(held, () => undefined); // never answered
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => localStorage.setItem('ordinate.theme', t), theme);
    await page.goto(url);
    await page.getByRole('status', { name: label }).waitFor();
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.unroute(held);
  await page.evaluate(() => localStorage.removeItem('ordinate.theme'));
}

/** The first whole number in a text: a count the server sent, as the page printed it. */
const countIn = (text: string | null): number => Number((/\d[\d,]*/.exec(text ?? '')?.[0] ?? 'NaN').replace(/,/g, ''));

e2e('data model: datasets', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  await page.goto(`/model/${pid}`);
  await settled(page);
  await page.getByRole('heading', { level: 1, name: 'Data model' }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Data model' }).getAttribute('aria-current'), 'page');

  // Nothing is filled in on the sample: the strip leads with its key.
  const strip = page.getByRole('region', { name: 'To fill in next' });
  const chips = strip.getByRole('button');
  const n = await chips.count();
  assert.ok(n >= 1 && n <= 4, `the strip shows 1 to 4 gaps, not ${n}`);
  await strip.getByRole('button', { name: 'Set a key on Retail orders' }).click();
  const panel = page.getByRole('region', { name: 'About Retail orders' });
  await panel.getByRole('heading', { level: 2, name: 'Retail orders' }).waitFor();
  assert.match(page.url(), /[?&]panel=overview\b/);

  // Role and key, saved in place; the key is counted over every row by the server.
  const overview = page.getByRole('tabpanel', { name: 'Overview' });
  await overview.getByRole('radio', { name: 'Fact', exact: true }).check();
  await overview.getByRole('combobox', { name: 'Key' }).click();
  await page.getByRole('option', { name: 'state', exact: true }).click();
  const verdict = overview.getByText(/^Key state · \d[\d,]* values? repeats?/);
  await verdict.waitFor();
  // …and the strip, read again, leads with the same count.
  const lead = strip.getByRole('button').first();
  await page.waitForFunction(() => /^Retail orders: \d/.test(document.querySelector('[aria-label="To fill in next"] button')?.textContent ?? ''));
  assert.equal(countIn(await lead.textContent()), countIn(await verdict.textContent()), 'the strip and the key line say the same server count');
  await page.getByRole('navigation', { name: 'Datasets' }).getByText('key repeats').waitFor();
  await screens(page, 'model-datasets');

  // The guide: written, saved, rendered.
  await page.getByRole('tab', { name: 'Guide' }).click();
  await page.getByRole('tabpanel', { name: 'Guide' }).getByRole('button', { name: 'Write a guide', exact: true }).click();
  await page.getByRole('textbox', { name: 'Guide' }).fill('## How to query it\n\nFilter on `order_date` first: the table holds two years of orders.');
  await page.getByRole('button', { name: 'Save guide' }).click();
  await page.getByRole('heading', { name: 'How to query it' }).waitFor();
  await screens(page, 'model-guide');

  // Fields and Lineage, inline.
  await page.getByRole('tab', { name: 'Fields' }).click();
  await page.getByRole('region', { name: 'Column notes' }).waitFor();
  await screens(page, 'model-fields');
  await page.getByRole('tab', { name: 'Lineage' }).click();
  await page.getByRole('group', { name: 'Lineage graph' }).waitFor();
  await screens(page, 'model-lineage');

  // At phone width the list stacks over the panel, and nothing scrolls sideways.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('tabpanel', { name: 'Overview' }).waitFor();
  const misfits: string[] = [];
  await phoneFits(page, misfits, 'the Data model Overview');
  await screens(page, 'model-phone');
  assert.deepEqual(misfits, []);
});

e2e('data model: metrics', async ({ page, server }) => {
  const pid = server.sample.projectId;
  // The old address lands on the tab.
  await page.goto(`/data/metrics?project=${pid}`);
  await page.waitForURL(/\/model\/[^/]+\?tab=metrics/);
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  const table = page.getByRole('table');
  const revenue = table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Revenue', exact: true }) });
  await revenue.getByRole('cell', { name: '$5.2M' }).waitFor(); // metric:value's display, through metric:table
  await revenue.getByRole('img', { name: 'Revenue trend' }).waitFor(); // metric:series
  await revenue.getByText(/card/).waitFor(); // metric:usage — the sample dashboard's KPI uses it
  await revenue.getByRole('cell', { name: 'Yes', exact: true }).waitFor(); // a sum adds up: the server's rule
  await revenue.getByText('Any date').waitFor(); // no date of its own: the dashboard's
  await page.getByText('6 metrics').waitFor();
  await screens(page, 'model-metrics');

  await page.getByRole('button', { name: 'New metric' }).click();
  const dlg = page.getByRole('dialog', { name: 'New metric' });
  await dlg.getByLabel('Name').fill('Large orders');
  await dlg.getByRole('combobox', { name: 'Dataset' }).click();
  await page.getByRole('option', { name: 'Retail orders' }).click();
  await dlg.getByRole('combobox', { name: 'Column', exact: true }).click();
  await page.getByRole('option', { name: 'revenue (number)' }).click();
  await dlg.getByRole('radio', { name: 'Count' }).click();
  // The builder's filter rows and typed dialog: a number column is a range, typed on its declared type by the server.
  await dlg.getByRole('button', { name: 'Add filter' }).click();
  await dlg.getByRole('combobox', { name: 'Filter column' }).click();
  await page.getByRole('option', { name: 'revenue', exact: true }).click();
  await dlg.getByRole('button', { name: 'Edit the filter on revenue' }).click();
  const fdlg = page.getByRole('dialog', { name: 'Filter: revenue' });
  await fdlg.getByLabel('Minimum').fill('1000');
  await fdlg.getByRole('button', { name: 'Apply' }).click();
  await fdlg.waitFor({ state: 'detached' });
  // A snapshot (semantic D8): only the rows on the latest order date, so the figure below is the snapshot's.
  await dlg.getByRole('combobox', { name: 'Snapshot' }).click();
  await page.getByRole('option', { name: 'Latest order_date only' }).click();
  const preview = dlg.getByRole('complementary', { name: 'Preview' });
  await preview.getByText(/on the latest order_date, where revenue/).waitFor(); // the server's own words for the definition, with the snapshot and the filter
  const figure = (await preview.getByText(/^[\d,.]+[KM]?$/).first().textContent()) ?? '';
  assert.match(figure, /^\d/, `a figure computed by the server, got ${figure}`);
  await screensInPlace(page, 'model-metrics-editor');
  await dlg.getByRole('button', { name: 'Create metric' }).click();
  const row = table.getByRole('row').filter({ has: page.getByRole('button', { name: 'Large orders' }) });
  await row.getByRole('cell', { name: figure }).waitFor();
  // A snapshot adds up across categories, not across dates: the server's rule, worded.
  await row.getByText('Snapshot', { exact: true }).waitFor();
  await row.getByText('last of order_date').waitFor();
  await row.getByText('Not over time').waitFor();

  await page.getByRole('button', { name: 'Actions for Large orders' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete “Large orders”?' });
  await confirm.getByText('Nothing uses it yet.').waitFor();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Moved “Large orders” to Trash').waitFor();
  await row.waitFor({ state: 'detached' });
});

e2e('data model: glossary', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/model/${pid}?tab=glossary`);
  await settled(page);
  const glossary = page.getByRole('region', { name: 'Glossary' });
  await glossary.getByRole('heading', { name: 'No terms yet' }).waitFor(); // the designed empty state
  await page.getByRole('button', { name: 'New term' }).click(); // the header's: the empty state does not repeat it
  const dlg = page.getByRole('dialog', { name: 'New term' });
  await dlg.getByLabel('Name').fill('West side');
  await dlg.getByLabel('Also called').fill('Westerly, The west');
  await dlg.getByRole('combobox', { name: 'Dataset' }).click();
  await page.getByRole('option', { name: 'Retail orders' }).click();
  await dlg.getByRole('button', { name: 'Add filter' }).click();
  await dlg.getByRole('combobox', { name: 'Filter column' }).click();
  await page.getByRole('option', { name: 'region', exact: true }).click();
  await dlg.getByRole('button', { name: 'Edit the filter on region' }).click();
  const fdlg = page.getByRole('dialog', { name: 'Filter: region' });
  await fdlg.getByLabel('West', { exact: true }).check();
  await fdlg.getByRole('button', { name: 'Apply' }).click();
  await fdlg.waitFor({ state: 'detached' });
  await dlg.getByRole('button', { name: 'Create term' }).click();
  const row = glossary.getByRole('row').filter({ has: page.getByRole('button', { name: 'West side' }) });
  await row.getByText('Westerly, The west').waitFor();
  await row.getByText(/region/).waitFor(); // the server's words for its filter
  await row.getByText('Not used yet').waitFor();

  await page.goto(`/visuals/${pid}`);
  await settled(page);
  const first = page.waitForResponse((r) => r.url().endsWith('/api/rpc/visual%3Apreview') && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^(Average r|R)evenue by category/ }).first().click();
  const before = JSON.stringify(await (await first).json());
  await page.getByRole('button', { name: 'Add term' }).click();
  const after = page.waitForResponse((r) => r.url().endsWith('/api/rpc/visual%3Apreview') && r.request().method() === 'POST');
  await page.getByRole('menuitem', { name: 'West side' }).click();
  const filtered = JSON.stringify(await (await after).json());
  assert.ok(filtered.includes('"ok":true') && filtered !== before, 'the chart recomputed under the term, with other figures');
  await page.getByText('West side').first().waitFor(); // the filter row names the term
  // Saved with the term, the visual is where the glossary says it is used.
  const stored = page.waitForResponse((r) => r.url().endsWith('/api/rpc/visual%3Aupdate') && r.status() === 200);
  await page.getByRole('button', { name: 'Save visual' }).click();
  await page.getByRole('dialog', { name: 'Rename this visual' }).getByRole('button', { name: 'Save' }).click();
  await stored;
  await page.goto(`/model/${pid}?tab=glossary`);
  await settled(page);
  await row.getByText('1 visual', { exact: true }).waitFor(); // term:usage, the server's count
  await screens(page, 'model-glossary');
});

e2e('data model: an empty project, and the error and loading states', async (s) => {
  const { page } = s;
  await page.goto('/model');
  await settled(page);
  await page.waitForURL(/\/model\/[0-9a-f-]{36}/);
  const id = await page.evaluate(async () => {
    // The CSRF pair, as the web client sends it (T6.2): the cookie's token as a header.
    const token = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})/.exec(document.cookie)?.[1] ?? '';
    const r = await fetch('/api/rpc/projects%3Acreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ args: [{ name: 'Empty project' }] }),
    });
    return ((await r.json()) as { id: string }).id;
  });
  await page.goto(`/model/${id}`);
  await settled(page);
  await page.getByRole('heading', { name: 'No datasets to describe yet' }).waitFor();
  await screens(page, 'model-empty');
  // Every tab says what it holds when there is nothing yet.
  for (const [tab, heading] of [['metrics', 'No metrics yet'], ['glossary', 'No terms yet'], ['relationships', 'Relate two datasets']] as const) {
    await page.getByRole('tab', { name: tab[0]!.toUpperCase() + tab.slice(1) }).click();
    await page.getByRole('heading', { name: heading }).waitFor();
    await screens(page, `model-${tab}-empty`);
  }

  // A server that cannot read the data model (a handler's `ok: false`: a 404 or 500 is a console error in the browser).
  const pid = s.server.sample.projectId;
  const refused = JSON.stringify({ ok: false, error: 'The data model could not be read.' });
  await page.route('**/api/rpc/model%3Aoverview', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: refused }));
  await page.goto(`/model/${pid}`);
  await settled(page);
  await page.getByRole('alert').filter({ hasText: 'The data model could not be loaded' }).waitFor();
  await screens(page, 'model-error');
  await page.unroute('**/api/rpc/model%3Aoverview');
  await loadingShots(page, `/model/${pid}`, 'model:overview', 'Loading the data model', 'model-loading');
});
