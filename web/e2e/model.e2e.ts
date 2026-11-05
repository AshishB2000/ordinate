// The Data model (docs/semantic-layer/00-design.md, step 10) against the real server and the seeded
// sample project:
//
//   1. Datasets: the "To fill in next" strip opens the dataset where its gap is filled in; a role and a
//      key saved in the Overview, the key counted by the server, and the strip re-ranked by the same
//      count; a guide written and rendered; the column notes and the lineage graph, inline.
//   2. Metrics (moved from /data/metrics, which redirects): the table from the server with each metric's
//      date and whether it adds up, a new metric with a live preview and a filter, delete to Trash.
//   3. Glossary: a term made here, added to a visual's filters, changes its chart, and reads "1 visual".
//   3b. Topics (part 6 step 07): Sales made from the header narrows Datasets and Metrics, is still picked after a
//      reload, Show all clears it, an edit saves, and Delete puts it in the Trash as a "Topic".
//   3c. Lineage: trace a column, "Used by" on each field, and the ask before removing a step that feeds a metric.
//   4. An empty project: nothing to describe on any tab. The error and loading states.
//   5. Assistant: the sample ships its instructions and verified questions (an empty project's tab is the
//      empty state); one written with Enter is stored by the server and still there after a reload, and a
//      figure-like one is flagged. With no model, Check the Assistant is off and says why.
//
//   npm --prefix web run e2e -- model

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { csrfToken, e2e, SCREENS, screens, screensInPlace, settled, type Session } from './fixtures.ts';
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

/** One RPC the spec sends itself, as the signed-in user, with the CSRF pair. */
async function post(s: Session, channel: string, payload: unknown): Promise<any> { // any: each channel's own reply
  const r = await s.page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': await csrfToken(s) }, data: { args: [payload] } });
  return r.json();
}

/** The open page in both themes, without reloading it (a dialog stays open). */
async function screenshotBoth(page: Page, name: string): Promise<void> {
  const prev = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate((t) => { if (t) document.documentElement.dataset.theme = t; }, prev);
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

  // Hierarchies: Geography, region then state, saved through the dialog and kept by the server.
  const hierarchies = page.getByRole('region', { name: 'Hierarchies' });
  await hierarchies.getByText('Dates drill by themselves: year › quarter › month › day').waitFor();
  await hierarchies.getByRole('button', { name: 'Hierarchy' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Geography');
  for (const level of ['region', 'state']) {
    await dialog.getByRole('combobox', { name: 'Add level' }).click();
    await page.getByRole('option', { name: level, exact: true }).click();
  }
  await screenshotBoth(page, 'model-hierarchy-dialog');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached' });
  await hierarchies.getByText('region › state').waitFor();
  await screens(page, 'model-hierarchies');
  await hierarchies.getByText('region › state').waitFor(); // kept across the reload
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

/** An RPC from the spec itself, with the CSRF pair the web client sends. */
async function post(s: Session, channel: string, payload: unknown): Promise<any> {
  const csrf = await csrfToken(s);
  const r = await s.page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [payload] } });
  assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
  return r.json();
}

e2e('data model: lineage, used by, and the ask before removing what feeds a metric', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  const retail = ((await post(s, 'dataset:list', { projectId: pid })) as { id: string; name: string }[]).find((d) => d.name === 'Retail orders')!;
  assert.ok(retail);

  // Trace a column: the server's graph around it, and its "Used by" line.
  await page.goto(`/model/${pid}?dataset=${retail.id}&panel=lineage`);
  await settled(page);
  const lineage = page.getByRole('tabpanel', { name: 'Lineage' });
  await lineage.getByRole('combobox', { name: 'Trace a column' }).click();
  await page.getByRole('option', { name: 'revenue', exact: true }).click();
  await lineage.getByText(/^Used by \d/).waitFor();
  await lineage.getByRole('group', { name: 'Lineage graph' }).waitFor();
  assert.match(page.url(), /[?&]column=revenue\b/);
  await screens(page, 'model-lineage-column');

  // Used by, on the Fields tab.
  await page.goto(`/model/${pid}?dataset=${retail.id}&panel=fields`);
  await settled(page);
  const notes = page.getByRole('region', { name: 'Column notes' });
  await notes.getByRole('columnheader', { name: 'Used by' }).waitFor();
  await notes.locator('tr[data-column="revenue"]').getByText(/^Used by \d/).waitFor();
  await screens(page, 'model-used-by');

  // A calculated step and a metric on it: removing the step asks, and says what it feeds.
  const added = await post(s, 'dataset:addStep', { projectId: pid, datasetId: retail.id, step: { type: 'calculated_field', name: 'Margin', expression: '[revenue] * 2' } });
  assert.ok(added.ok, JSON.stringify(added));
  const saved = await post(s, 'metric:save', { projectId: pid, input: { name: 'Total margin', datasetId: retail.id, definition: { column: 'Margin', aggregation: 'sum' } } });
  assert.ok(saved.ok, JSON.stringify(saved));
  await page.goto(`/data/${pid}/${retail.id}/prepare`);
  await settled(page);
  const steps = page.getByRole('list', { name: 'Pipeline steps' });
  const n = await steps.getByRole('listitem').count();
  await page.getByRole('button', { name: `Remove step ${n}` }).click();
  const dlg = page.getByRole('dialog', { name: 'Delete “Margin”?' });
  await dlg.getByText(/It feeds 1 metric\b/).waitFor();
  await screensInPlace(page, 'prepare-remove-confirm');
  await dlg.getByRole('button', { name: 'Keep it' }).click();
  await dlg.waitFor({ state: 'detached' });
  assert.equal(await steps.getByRole('listitem').count(), n, 'cancel kept the step');

  // Put the sample back.
  await page.getByRole('button', { name: `Remove step ${n}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction((k) => document.querySelectorAll('[aria-label="Pipeline steps"] > li').length === k, n - 1);
  const metrics = (await post(s, 'metric:list', { projectId: pid })).metrics as { id: string; name: string }[];
  await post(s, 'metric:delete', { projectId: pid, id: metrics.find((m) => m.name === 'Total margin')!.id });
  for (const l of s.rpc.loads) assert.ok(l.rpcs <= 25, `${l.url} made ${l.rpcs} calls`);
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

/** One RPC from the page, as the web client sends it (T6.2: the cookie's CSRF token as a header). */
async function callFromPage(page: Page, channel: string, payload: unknown): Promise<unknown> {
  return page.evaluate(async ([ch, p]) => {
    const token = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})/.exec(document.cookie)?.[1] ?? '';
    const r = await fetch(`/api/rpc/${encodeURIComponent(ch as string)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify({ args: [p] }) });
    return r.json();
  }, [channel, payload] as const);
}

e2e('data model: topics', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  // A term of the sample's own, for the topic to list.
  const orders = ((await callFromPage(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[]).find((d) => d.name === 'Retail orders');
  const term = (await callFromPage(page, 'term:save', { projectId: pid, input: { name: 'East side', datasetId: orders!.id, filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }] } })) as { ok: boolean };
  assert.equal(term.ok, true, `the term is saved: ${JSON.stringify(term)}`);

  // No topic yet: the picker reads All, and an editor can start one.
  const picker = page.getByRole('combobox', { name: 'Topic' });
  await picker.click();
  await page.getByRole('option', { name: 'New topic…' }).waitFor();
  for (const theme of ['light', 'dark'] as const) {
    // The viewport only: a full-page capture resizes the page, and the open list hides while it moves.
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.getByRole('listbox').waitFor();
    await page.waitForTimeout(250); // the list repositions a frame after the theme moves the page
    await page.screenshot({ path: path.join(SCREENS, `model-topic-none-${theme}.png`) });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.getByRole('option', { name: 'New topic…' }).click();
  const drawer = page.getByRole('dialog', { name: 'New topic' });
  await drawer.getByLabel('Name').fill('Sales');
  await drawer.getByLabel('Description').fill('What the sales team reads first');
  await drawer.getByRole('checkbox', { name: 'Retail orders' }).check();
  await drawer.getByRole('button', { name: /^Fields of Retail orders: all \d+$/ }).click();
  const fields = page.getByRole('dialog', { name: 'Fields of Retail orders' });
  const boxes = fields.getByRole('checkbox');
  await boxes.nth(1).waitFor();
  const total = (await boxes.count()) - 1; // "All fields" first
  for (let i = total; i > 4; i--) await boxes.nth(i).uncheck(); // keep the first four columns
  await page.keyboard.press('Escape');
  await drawer.getByRole('button', { name: `Fields of Retail orders: 4 of ${total}` }).waitFor();
  await drawer.getByRole('checkbox', { name: 'Revenue', exact: true }).check();
  await drawer.getByRole('checkbox', { name: 'East side' }).check();
  await screenshotBoth(page, 'model-topic-drawer');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await drawer.waitFor({ state: 'detached' });
  await page.waitForURL(/[?&]topic=[0-9a-f-]{36}/);

  // Picked: Metrics holds Revenue only, the Datasets list Retail orders only.
  const line = page.getByTestId('topic-line');
  await line.getByText(/^1 of \d+ metrics$/).waitFor();
  const rows = page.getByRole('table').getByRole('row');
  assert.equal(await rows.count(), 2, 'the header row and Revenue');
  await rows.filter({ has: page.getByRole('button', { name: 'Revenue', exact: true }) }).waitFor();
  await page.getByRole('tab', { name: 'Datasets' }).click();
  const list = page.getByRole('navigation', { name: 'Datasets' });
  await list.getByRole('link', { name: 'Retail orders' }).waitFor();
  assert.equal(await list.getByRole('link').count(), 1, 'Shipments is not in Sales');
  await line.getByText(/^1 of \d+ datasets$/).waitFor();

  // A reload with no topic= keeps it: the pick is remembered in this browser.
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  await line.getByText(/^1 of \d+ metrics$/).waitFor();
  assert.match((await picker.textContent()) ?? '', /Sales/);
  await screens(page, 'model-topic');

  // An edit: the term out; the Glossary then says Sales lists none.
  await picker.click();
  await page.getByRole('option', { name: 'Edit Sales…' }).click();
  const edit = page.getByRole('dialog', { name: 'Topic · Sales' });
  await edit.getByRole('checkbox', { name: 'East side' }).waitFor();
  // At phone width it is a bottom sheet in one column, and nothing scrolls sideways.
  const misfits: string[] = [];
  await phoneFits(page, misfits, 'the topic drawer', { on: [edit] });
  await screenshotBoth(page, 'model-topic-phone');
  assert.deepEqual(misfits, []);
  await page.setViewportSize({ width: 1440, height: 900 });
  await edit.getByRole('checkbox', { name: 'East side' }).uncheck();
  await edit.getByRole('button', { name: 'Save' }).click();
  await edit.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Glossary' }).click();
  await page.getByRole('heading', { name: 'Sales lists no terms' }).waitFor();
  await screens(page, 'model-topic-empty');

  // Show all clears it, for the next load too.
  await page.getByRole('button', { name: 'Show all' }).click();
  await line.waitFor({ state: 'detached' });
  await page.goto(`/model/${pid}?tab=metrics`);
  await settled(page);
  await page.getByText(/^\d+ metrics$/).waitFor(); // the unnarrowed count, in place of the line
  assert.equal(await line.count(), 0, 'All after Show all and a reload');

  // Delete: confirmed, to the Trash, listed there as a Topic.
  await picker.click();
  await page.getByRole('option', { name: 'Sales' }).click();
  await line.waitFor();
  await picker.click();
  await page.getByRole('option', { name: 'Edit Sales…' }).click();
  await page.getByRole('dialog', { name: 'Topic · Sales' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete “Sales”?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByText('Moved “Sales” to Trash').waitFor();
  await line.waitFor({ state: 'detached' });
  await page.goto('/trash');
  await settled(page);
  const row = page.getByRole('row').filter({ hasText: 'Sales' });
  await row.getByText('Topic', { exact: true }).waitFor();
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
  for (const [tab, heading] of [['metrics', 'No metrics yet'], ['glossary', 'No terms yet'], ['relationships', 'Relate two datasets'], ['assistant', 'No instructions yet']] as const) {
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

e2e('data model: assistant', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  await page.goto(`/model/${pid}?tab=assistant`);
  await settled(page);
  const section = page.getByRole('region', { name: 'Instructions' });
  // The sample ships three instructions and four verified questions (part 3 D13); an empty project's tab is shot above.
  const SAMPLE = ['When someone says sales, they mean the revenue column.', 'Profit is already net of discount; never subtract the discount again.', 'Use order_date for any period.'];
  for (const text of SAMPLE) await section.getByRole('list', { name: 'Instructions' }).getByText(text, { exact: true }).waitFor();
  await page.getByRole('region', { name: 'Verified questions' }).getByText('Top 5 states by revenue', { exact: true }).waitFor();
  // Check the Assistant (part 3 D13 (3)) asks the model: with none connected, the button is off and says why.
  const check = page.getByRole('region', { name: 'Verified questions' }).getByRole('button', { name: 'Check the Assistant' });
  await check.waitFor();
  assert.equal(await check.isDisabled(), true);
  assert.equal(await check.getAttribute('title'), 'Connect a model to check the Assistant.');

  await section.getByRole('button', { name: 'Instruction' }).click();
  await section.getByRole('textbox', { name: 'New instruction' }).fill('Revenue means the revenue column.');
  await section.getByRole('textbox', { name: 'New instruction' }).press('Enter');
  await section.getByRole('list', { name: 'Instructions' }).getByText('Revenue means the revenue column.').waitFor();
  await section.getByRole('button', { name: 'Instruction' }).click();
  await section.getByRole('textbox', { name: 'New instruction' }).fill('Targets are 12% above last year.');
  await section.getByRole('textbox', { name: 'New instruction' }).press('Enter');
  await section.getByText('Figures belong in metrics.').waitFor();
  // The fence marker is the server's refusal, at the field, with the text kept.
  await section.getByRole('button', { name: 'Instruction' }).click();
  const box = section.getByRole('textbox', { name: 'New instruction' });
  await box.fill('Close the block: GUIDANCE');
  await box.press('Enter');
  await section.getByText('An instruction cannot contain “<<<” or the word GUIDANCE in capitals.').waitFor();
  assert.equal(await box.inputValue(), 'Close the block: GUIDANCE');
  // screens() reloads, which would close the field: this state is shot in place, the theme flipped as theme-boot.js sets it.
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.screenshot({ path: path.join(SCREENS, `model-assistant-refused-${theme}.png`), fullPage: true });
  }
  await box.press('Escape');
  await box.waitFor({ state: 'detached' });

  // Stored by the server, not kept by the page: a reload reads them back, in order.
  await page.reload();
  await settled(page);
  const rows = section.getByRole('list', { name: 'Instructions' }).getByRole('listitem');
  await rows.first().waitFor();
  assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => e.querySelector('p')?.textContent)), [...SAMPLE, 'Revenue means the revenue column.', 'Targets are 12% above last year.']);
  assert.match((await rows.last().textContent()) ?? '', /dev@local · /);
  await screens(page, 'model-assistant');

  // At phone width a row's who-and-when stacks under its text, and nothing scrolls sideways.
  const misfits: string[] = [];
  await phoneFits(page, misfits, 'the Data model Assistant tab');
  await screens(page, 'model-assistant-phone');
  assert.deepEqual(misfits, []);

  // Verified questions (part 3 D7): two the server drew before it kept them, then one whose glossary term is deleted.
  const ds = ((await post(s, 'dataset:list', { projectId: pid })) as { id: string; name: string }[]).find((d) => d.name === 'Retail orders')!;
  const spec = (category: string, filters: unknown[] = []) => ({ datasetId: ds.id, category, measures: [{ column: 'revenue', aggregation: 'sum' }], filters });
  const saved = await post(s, 'verified:save', { projectId: pid, input: { question: 'Revenue by category', phrasings: ['Sales by category'], note: 'Revenue is net of discounts.', spec: spec('category') } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal((await post(s, 'verified:save', { projectId: pid, input: { question: 'East revenue by state', spec: spec('state', [{ column: 'region', op: '=', value: 'East' }]) } })).ok, true);
  const term = await post(s, 'term:save', { projectId: pid, input: { name: 'Big orders', datasetId: ds.id, filters: [{ type: 'filter', column: 'units', op: '>=', value: 10 }] } });
  assert.equal((await post(s, 'verified:save', { projectId: pid, input: { question: 'Big order revenue by region', spec: spec('region', [{ term: term.term.id }]) } })).ok, true);
  await post(s, 'term:delete', { projectId: pid, id: term.term.id });
  await page.setViewportSize({ width: 1440, height: 900 }); // back from phone width
  await page.reload();
  await settled(page);
  const verified = page.getByRole('region', { name: 'Verified questions' });
  await verified.getByText('1 no longer runs').waitFor();
  await verified.getByText('A glossary term this question uses was deleted.').waitFor();
  await verified.getByText('Retail orders · sum of revenue by state · region = East').waitFor();
  await screens(page, 'model-verified');
  // The edit dialog, shot in place (screens() reloads, which would close it).
  await verified.getByRole('listitem').filter({ hasText: 'Revenue by category' }).getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit verified question' });
  await dialog.getByRole('textbox', { name: 'Other ways people ask it' }).fill('Sales by category\nRevenue per category');
  await screensInPlace(page, 'model-verified-edit');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached' });
  await verified.getByText('Also asked as “Sales by category”, “Revenue per category”').waitFor();
  await phoneFits(page, misfits, 'the verified questions');
  await verified.scrollIntoViewIfNeeded(); // the shot is of the rows, not the instructions above them
  await screensInPlace(page, 'model-verified-phone');
  assert.deepEqual(misfits, []);
});

// The test chat (part 3 D11), with no model: a verified question answers from the app and says so, a follow-up chip has no
// "how" line, a good answer is saved as verified, and a reload brings the conversation and its "how" line back.
e2e('data model: assistant test chat', async (s) => {
  const { page } = s;
  const pid = s.server.sample.projectId;
  const url = `/model/${pid}?tab=assistant`;
  await page.goto(url);
  await settled(page);
  const chat = page.getByRole('region', { name: 'Try a question' });
  await chat.getByText('Nothing asked yet').waitFor();
  await chat.scrollIntoViewIfNeeded(); // the shot is of the chat, not the lists above it
  await screensInPlace(page, 'model-assistant-chat-empty');

  await chat.getByRole('textbox', { name: 'Question to try' }).fill('revenue by region');
  await chat.getByRole('button', { name: 'Ask' }).click();
  await chat.getByText('✓ Verified').waitFor();
  await chat.getByText('A verified question — no model call.').waitFor();
  const cards = chat.getByTestId('answer-card');
  assert.equal(await cards.count(), 1);

  await chat.getByRole('button', { name: 'Split by category' }).first().click();
  await cards.nth(1).waitFor();
  assert.equal(await chat.getByTestId('how-answered').filter({ hasText: 'no model call' }).count(), 1); // the chip's turn has no "how" line
  await cards.nth(1).getByRole('button', { name: 'Save as verified' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save as a verified question' });
  await dialog.getByRole('textbox', { name: 'Question' }).fill('Revenue by region and category');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('region', { name: 'Verified questions' }).getByText('Revenue by region and category', { exact: true }).waitFor();

  // Stored by the server: a reload reads the thread back, both answers and the first one's "how".
  await page.reload();
  await settled(page);
  await cards.nth(1).waitFor();
  await chat.getByText('A verified question — no model call.').waitFor();
  assert.equal(await cards.count(), 2);
  await chat.getByText('Spec:').first().waitFor();
  await chat.getByRole('heading', { name: 'Try a question' }).scrollIntoViewIfNeeded();
  await screensInPlace(page, 'model-assistant-chat');
});
