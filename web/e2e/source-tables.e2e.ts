// The Data model's Source tables tab (docs/semantic-layer/02-source-tables.md) against the built server,
// over the test harness's fake warehouse (scripts/liveFakeConnector.ts: its `live_fake_orders` table, a
// Live dataset built from it, and a facts reader over DuckDB's own comments), registered only because this
// spec starts the server with ORDINATE_TEST_LIVE_FAKE=1.
//
//   1. Document and read: the strip leads with the used table that has no doc; Start its notes, Read from
//      warehouse (the fake's column comment), a guide written and rendered, Built from it. No address seen
//      under /model names the table. + Add lists the connection's tables, on its click.
//   2. From Connections: the rail links here by id; "Document in Data model" on the shown table opens the
//      same doc (created once, by its exact name).
//   3. No warehouse on view: reloading and walking every tab of the panel asks the warehouse nothing. The
//      designed states (no source tables, a refused read, a warehouse a read can start) and the phone.
//   Both themes of each state are written to __screens__/model-sources*.png.
//
//   npm --prefix web run e2e -- source-tables

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, screensInPlace, settled, withLiveDataset, type Session } from './fixtures.ts';
import { phoneFits } from './phoneFits.ts';

withLiveDataset();

const TABLE = 'live_fake_orders';
/** The doc test 1 starts: test 2 must land on the same one (the server shares one store across the file). */
let docId = '';

const ids = (s: Session) => {
  const live = s.server.sample.live;
  if (!live) throw new Error('the server was seeded without the Live dataset');
  return { P: s.server.sample.projectId, C: live.connId };
};

/** The page is up and nothing is loading — including the tab's own panel. */
async function ready(page: Page): Promise<void> {
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
}

/** Every RPC channel the page asks from now on. */
function channels(page: Page): string[] {
  const asked: string[] = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/api/rpc/')) asked.push(decodeURIComponent(p.slice('/api/rpc/'.length)));
  });
  return asked;
}

e2e('source tables: document and read a warehouse table', async (s) => {
  const { page } = s;
  const { P, C } = ids(s);
  const seen: string[] = [];
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) seen.push(f.url());
  });

  await page.goto(`/model/${P}?tab=sources`);
  await ready(page);
  const strip = page.getByRole('region', { name: 'To fill in next' });
  assert.equal(await strip.getByRole('button').first().textContent(), `${TABLE}: no doc`);
  const panel = page.getByRole('region', { name: `About ${TABLE}` });
  await panel.getByRole('button', { name: 'Start its notes' }).waitFor();
  await screens(page, 'model-sources-used');

  // The chip picks it in the page; Start its notes puts the new doc's id in the address.
  await strip.getByRole('button', { name: `${TABLE}: no doc` }).click();
  await panel.getByRole('button', { name: 'Start its notes' }).click();
  await page.waitForURL(/[?&]doc=[0-9a-f-]{36}/);
  docId = new URL(page.url()).searchParams.get('doc') ?? '';
  assert.equal(new URL(page.url()).searchParams.get('conn'), C);
  await panel.getByText('Never read').waitFor();
  await page.getByRole('tab', { name: 'Columns' }).click();
  await panel.getByRole('heading', { name: 'Not read from the warehouse yet' }).waitFor();
  await ready(page);
  await screens(page, 'model-sources-never-read');

  // Read from warehouse: the fake's own column comment comes back.
  await panel.getByRole('button', { name: 'Read from warehouse' }).first().click();
  await panel.getByRole('table', { name: `Columns of ${TABLE}` }).getByText('Order amount in USD').waitFor({ timeout: 30_000 });
  await panel.getByText(/^Read just now by /).waitFor();
  await ready(page);
  await screens(page, 'model-sources-columns');

  // The guide, written in the notes form and rendered.
  await panel.getByRole('button', { name: 'Edit' }).click();
  const form = page.getByRole('dialog', { name: `Notes on ${TABLE}` });
  await form.getByLabel('Owner').fill('Data platform');
  await form.getByLabel('Guide').fill('## Always filter on day\n\nOne partition per day.');
  await form.getByRole('button', { name: 'Save notes' }).click();
  await form.waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: 'Guide' }).click();
  await panel.getByRole('heading', { name: 'Always filter on day' }).waitFor();
  await ready(page);
  await screens(page, 'model-sources-guide');

  await page.getByRole('tab', { name: 'Overview' }).click();
  const built = panel.locator('dt', { hasText: 'Built from it' }).locator('xpath=following-sibling::dd');
  await built.getByRole('link', { name: 'Orders (live)' }).waitFor();
  assert.equal(await panel.locator('dt', { hasText: 'Owner' }).locator('xpath=following-sibling::dd').textContent(), 'Data platform');
  // The strip moved on: the table has a doc, an owner, a read and a guide.
  await strip.waitFor({ state: 'detached' });
  await ready(page);
  await screens(page, 'model-sources');

  // + Add lists the connection's tables, on its click only.
  await page.getByRole('button', { name: 'Add a table from Fake warehouse' }).click();
  const add = page.getByRole('dialog', { name: 'Add a source table' });
  await add.getByRole('button', { name: new RegExp(TABLE) }).getByText('documented').waitFor();
  await screensInPlace(page, 'model-sources-add');
  await page.keyboard.press('Escape');
  await add.waitFor({ state: 'detached' });

  const named = seen.filter((u) => new URL(u).pathname.startsWith('/model') && u.includes(TABLE));
  assert.deepEqual(named, [], 'no address under /model names the table');
  assert.ok(seen.length > 3, 'the walk was seen');
});

e2e('source tables: from Connections', async (s) => {
  const { page } = s;
  const { P, C } = ids(s);
  assert.ok(docId, 'test 1 started the notes');
  // The workbench keeps its own selected table in its own, editor-only address (unchanged).
  await page.goto(`/connections/${P}/${C}?table=${TABLE}`);
  await settled(page);
  const rail = page.getByRole('complementary', { name: 'Connection details' });
  assert.equal(await rail.getByRole('link', { name: 'Document in Data model' }).getAttribute('href'), `/model/${P}?tab=sources&conn=${C}`);
  await page.getByRole('region', { name: 'Results' }).getByRole('button', { name: 'Document in Data model' }).click();
  await page.waitForURL(/\/model\/[^/?]+\?tab=sources&conn=[^&]+&doc=/);
  const url = new URL(page.url());
  assert.equal(url.searchParams.get('doc'), docId, 'the same doc: created once, by its exact name');
  assert.equal(url.searchParams.get('conn'), C);
  assert.ok(!page.url().includes(TABLE), 'the address names no table');
  await page.getByRole('region', { name: `About ${TABLE}` }).getByRole('heading', { level: 2, name: TABLE }).waitFor();
});

e2e('source tables: no warehouse on view, and the designed states', async (s) => {
  const { page } = s;
  const { P, C } = ids(s);
  assert.ok(docId, 'test 1 started the notes');
  const at = `/model/${P}?tab=sources&conn=${C}&doc=${docId}`;
  const asked = channels(page);
  await page.goto(at);
  await ready(page);
  for (const tab of ['Columns', 'Guide', 'Overview']) {
    await page.getByRole('tab', { name: tab }).click();
    await ready(page);
  }
  await page.goto(at);
  await ready(page);
  assert.ok(asked.includes('sourceTable:get'), 'the panel was read');
  assert.deepEqual(asked.filter((c) => c === 'sourceTable:read' || c.startsWith('connection:')), [], 'opening the tab asks the warehouse nothing');

  // A refused read keeps the columns and says the server's sentence where it happened.
  await page.route('**/api/rpc/sourceTable%3Aread', (r) => r.fulfill({ json: { ok: false, error: 'This connection’s tables were read 60 times in the last hour. Try again in 12 min.' } }));
  await page.getByRole('tab', { name: 'Columns' }).click();
  await page.getByRole('button', { name: 'Read again' }).click();
  await page.getByRole('alert').getByText(/read 60 times/).waitFor();
  await page.getByText('Order amount in USD').waitFor();
  await screensInPlace(page, 'model-sources-read-failed');
  await page.unroute('**/api/rpc/sourceTable%3Aread');

  // A warehouse a read can start (Databricks) says so beside the button.
  await page.route('**/api/rpc/sourceTable%3Alist', async (r) => {
    const res = await r.fetch();
    const j = (await res.json()) as { connections: { factsWake?: true; label: string }[] };
    j.connections = j.connections.map((c) => ({ ...c, factsWake: true, label: 'Databricks SQL' }));
    await r.fulfill({ response: res, json: j });
  });
  await page.goto(at);
  await page.getByText('Reading runs on the SQL warehouse and can start it.').waitFor();
  await ready(page);
  await screens(page, 'model-sources-wake');
  await page.unroute('**/api/rpc/sourceTable%3Alist');

  // A project with no source tables yet.
  await page.route('**/api/rpc/sourceTable%3Alist', (r) => r.fulfill({ json: { ok: true, connections: [], todo: [], more: 0 } }));
  await page.goto(`/model/${P}?tab=sources`);
  await page.getByRole('heading', { name: 'No source tables yet' }).waitFor();
  await ready(page);
  await screens(page, 'model-sources-none');
  await page.unroute('**/api/rpc/sourceTable%3Alist');

  // At phone width the list stacks over the panel, and nothing scrolls sideways.
  await page.goto(`${at}&panel=columns`);
  await ready(page);
  const misfits: string[] = [];
  await phoneFits(page, misfits, 'the Source tables panel');
  await screens(page, 'model-sources-phone');
  assert.deepEqual(misfits, []);
});
