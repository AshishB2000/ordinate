// The Data model (docs/semantic-layer/00-design.md, step 10) against the real server and the seeded
// sample project:
//
//   1. Datasets: the "To fill in next" strip opens the dataset where its gap is filled in; a role and a
//      key saved in the Overview, the key counted by the server, and the strip re-ranked by the same
//      count; a guide written and rendered; the column notes and the lineage graph, inline.
//   2. An empty project: nothing to describe. The error and loading states.
//
//   npm --prefix web run e2e -- model

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';
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
