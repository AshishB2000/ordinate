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
//   4. Lineage and the dataset Guide: the doc's Lineage tab draws the Live view built from the table; that
//      dataset's Guide shows the doc's notes under "From the source table", read-only.
//   5. The Assistant (phase D): an answer read straight from the table, in the dock, says it is a warehouse table and
//      offers only Keep as a dataset; kept, it is drawn on the new Live dataset with Save as visual (dock-source-*.png);
//      and the checked-link card of outcome E, laid on the conversation (dock-link-*.png).
//   6. Explore (phase D): the table picked as if it were a dataset, its fields and a question answered Live through its
//      view, every figure the Live dataset's own; a table on a connection not asked live says to copy it in and asks
//      nothing; Keep as a dataset opens the new Live dataset with the same question (explore-source-*.png); and at
//      phone width the answer fits (explore-source-phone-*.png).
//   Both themes of each state are written to __screens__/model-sources*.png.
//
//   npm --prefix web run e2e -- source-tables

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, screensInPlace, settled, withLiveDataset, type Session } from './fixtures.ts';
import { PHONE, phoneFits } from './phoneFits.ts';
import { encodeQuestion } from '../src/features/explore/spec.ts';

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

e2e('source tables: lineage and the dataset guide', async (s) => {
  const { page } = s;
  const { P, C } = ids(s);
  assert.ok(docId, 'test 1 started the notes');
  const liveId = s.server.sample.live?.datasetId;
  assert.ok(liveId, 'the server was seeded with the Live dataset');
  await page.goto(`/model/${P}?tab=sources&conn=${C}&doc=${docId}&panel=lineage`);
  await ready(page);
  const graph = page.getByRole('group', { name: 'Lineage graph' });
  await graph.locator('text', { hasText: 'Orders (live)' }).first().waitFor();
  await graph.locator('text', { hasText: TABLE }).first().waitFor();
  await screens(page, 'model-sources-lineage');

  await page.goto(`/model/${P}?dataset=${liveId}&panel=guide`);
  await ready(page);
  const notes = page.getByRole('region', { name: 'From the source table' });
  await notes.getByRole('heading', { name: 'Always filter on day' }).waitFor();
  await notes.getByText('Owner Data platform').waitFor();
  assert.equal(await notes.getByRole('link', { name: /Open in Source tables/ }).getAttribute('href'), `/model/${P}?tab=sources&conn=${C}&doc=${docId}`);
  await screens(page, 'model-dataset-source-notes');
});

/** The column notes hold the meaning Use wrote: a field's value, not page text. */
const meaning = (page: Page) =>
  page.waitForFunction(() => [...document.querySelectorAll('textarea, input')].some((e) => (e as HTMLInputElement).value === 'Order amount in USD'));

e2e('source tables: a suggested meaning', async (s) => {
  const { page } = s;
  const { P } = ids(s);
  const liveId = s.server.sample.live?.datasetId;
  assert.ok(liveId, 'the server was seeded with the Live dataset');
  assert.ok(docId, 'test 1 started the notes and read the table');
  const at = `/model/${P}?dataset=${liveId}&panel=fields`;
  await page.goto(at);
  await ready(page);
  const region = page.getByRole('region', { name: 'Suggested by the warehouse' });
  await region.getByText('The warehouse says: "Order amount in USD"').waitFor();
  assert.ok(await region.getByText(`from ${TABLE}`).count() >= 1);
  await screens(page, 'model-suggestions');

  // Nothing is the dataset's until Use: the catalog says nothing about the column yet.
  await region.locator('li', { hasText: 'amount' }).getByRole('button', { name: 'Use' }).click();
  await region.getByText('The warehouse says: "Order amount in USD"').waitFor({ state: 'detached' });
  await ready(page);
  await meaning(page);
  await screens(page, 'model-suggestions-used');

  // Dismiss keeps the table comment away across a reload.
  await region.locator('li', { hasText: 'Orders, one row per line' }).getByRole('button', { name: 'Dismiss' }).click();
  await ready(page);
  await screens(page, 'model-suggestions-dismissed');
  await page.reload();
  await ready(page);
  assert.equal(await page.getByText('Orders, one row per line').count(), 0, 'a dismissed comment stays away');
  assert.equal(await page.getByText('The warehouse says: "Order amount in USD"').count(), 0, 'a used meaning does not return');
  await meaning(page);
  await screens(page, 'model-suggestions-none');
});

e2e('source tables: an editor answered straight from the table, then kept as a dataset (the dock)', async (s) => {
  // Assistant phase D, outcome C (docs/assistant/00-design.md): an answer whose spec names the table (its doc's id and
  // its connection) is drawn Live through the table's in-memory view, says so, and offers only Keep as a dataset, which
  // makes the Live dataset and re-points the answer at it. No model: the answer is a follow-up chip's (`answer:rerun`).
  const { page } = s;
  const { P, C } = ids(s);
  assert.ok(docId, 'test 1 started the notes and read the table');
  await page.goto(`/model/${P}?tab=sources`);
  await ready(page);
  const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
  const call = async (channel: string, input: unknown) =>
    (await (await page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [input] } })).json()) as Record<string, any>; // any: each channel's own reply
  const threadId = (await call('copilot:newThread', { projectId: P })).thread.id as string;
  const spec = { datasetId: docId, table: C, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Amount by region' };
  assert.equal((await call('answer:rerun', { projectId: P, threadId, spec, label: 'Amount by region' })).ok, true);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const dock = page.getByRole('complementary', { name: 'Assistant' });
  const card = dock.getByTestId('answer-card').last();
  await card.locator('canvas').waitFor();
  assert.equal(await card.getByTestId('answered-from').textContent(), `Answered from${TABLE}`);
  await card.getByText('Warehouse table, not a dataset', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Also on dashboards' }).count(), 0, 'no dashboard shows a table');
  assert.equal(await card.getByRole('button', { name: 'Save as visual' }).count(), 0, 'nothing to save until it is a dataset');
  await card.getByTestId('answer-keep-table').waitFor();
  await card.scrollIntoViewIfNeeded();
  await screensInPlace(page, 'dock-source-table');
  await card.getByTestId('answer-keep-table').click();
  // The turn names the new Live dataset now: the card is drawn on it, with Save as visual and Also on.
  await card.getByRole('button', { name: 'Save as visual' }).waitFor();
  assert.equal(await card.getByTestId('answer-keep-table').count(), 0);
  assert.equal(await card.getByText('Warehouse table, not a dataset', { exact: true }).count(), 0);
  await card.getByRole('button', { name: 'Also on dashboards' }).waitFor();
  await card.locator('canvas').waitFor();
  await card.scrollIntoViewIfNeeded();
  await screensInPlace(page, 'dock-source-kept');

  // Outcome E's checked link, as a refused answer's turn carries it (its server path is scripts/test-sourceAnswers.ts:
  // this server has no model to refuse one), laid on the conversation the server sends, to see the card in both themes.
  const link = { from: { datasetId: docId, dataset: 'Shipments', column: 'country_id' }, to: { datasetId: C, dataset: 'Countries', column: 'country_id' }, cardinality: 'many_to_one', checks: { names: true, types: true, foundPct: 98, unique: true } };
  await page.route('**/api/rpc/copilot%3Ahistory', async (r) => {
    const body = (await (await r.fetch()).json()) as { turns?: unknown[] };
    const turns = [...(body.turns ?? []), { id: 'q-link', role: 'user', text: 'Shipments by territory', createdAt: '2026-11-15T10:00:00Z' },
      { id: 'a-link', role: 'assistant', text: "Shipments has no link to Countries yet, so they can't be combined. Check the link below.", createdAt: '2026-11-15T10:00:01Z', needs: 'link', link }];
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...body, turns }) });
  });
  await page.reload();
  await settled(page);
  const checked = dock.getByTestId('answer-link');
  await checked.getByText('98% of sampled values found').waitFor();
  assert.equal(await checked.getByText('Link Shipments.country_id → Countries.country_id?').count(), 1);
  await checked.scrollIntoViewIfNeeded();
  await screensInPlace(page, 'dock-link');
  await checked.getByRole('button', { name: 'Cancel' }).click();
  await checked.waitFor({ state: 'detached' });
  await page.unroute('**/api/rpc/copilot%3Ahistory');
});

const BY_REGION = { chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' as const }] }, filters: [] };

/** Explore on the table, asking `q` when given. */
const exploreAt = (P: string, C: string, q?: typeof BY_REGION) => `/explore?project=${P}&dataset=${docId}&table=${C}${q ? `&q=${encodeQuestion(q)}` : ''}`;

e2e('source tables: Explore on the table, no dataset, then kept as one', async (s) => {
  // Assistant phase D in Explore (docs/assistant/00-design.md, "Explore, as built"): the table's fields from its facts, a
  // question answered Live through its in-memory view, Keep as a dataset making the Live dataset Explore then opens.
  const { page } = s;
  const { P, C } = ids(s);
  const liveId = s.server.sample.live?.datasetId;
  assert.ok(docId && liveId, 'test 1 read the table; the server has its Live dataset');
  const asked = channels(page);
  await page.goto(exploreAt(P, C));
  await ready(page);
  await page.getByText('Warehouse table, not a dataset').waitFor();
  await page.getByRole('heading', { name: 'Start with a question' }).waitFor();
  const rail = page.getByRole('complementary', { name: 'Fields' });
  await rail.getByRole('button', { name: 'amount', exact: true }).waitFor();
  await screens(page, 'explore-source-table');

  // A question, answered Live: the table's figures are the Live dataset's (the server's own reply to the same question).
  await page.goto(exploreAt(P, C, BY_REGION));
  await ready(page);
  await page.getByRole('heading', { level: 2, name: 'Total amount by region' }).waitFor();
  await page.locator('[data-chart-type="column"] canvas').waitFor();
  const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
  const live = (await (await page.request.post(`${s.server.base}/api/rpc/visual:data`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ projectId: P, datasetId: liveId, encoding: BY_REGION.encoding }] } })).json()) as { data: { labels: string[] } };
  const table = page.getByRole('table', { name: 'Total amount by region, as a table' });
  assert.ok(live.data.labels.length === 4, JSON.stringify(live.data.labels));
  for (const label of live.data.labels) await table.getByRole('rowheader', { name: label, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save as visual' }).count(), 0, 'nothing to save until it is a dataset');
  assert.ok(!asked.includes('dataset:copyLive') && !asked.includes('visual:save'), 'no copy, no save');
  await screens(page, 'explore-source-answer');

  // A table on a connection not asked live: the page says to copy it in and asks nothing about it.
  await page.route('**/api/rpc/sourceTable%3Alist', async (r) => {
    const res = await r.fetch();
    const j = (await res.json()) as { connections: { live?: true }[] };
    j.connections = j.connections.map(({ live: _l, ...c }) => c);
    await r.fulfill({ response: res, json: j });
  });
  const before = asked.length;
  await page.goto(exploreAt(P, C, BY_REGION));
  await page.getByRole('heading', { name: `Copy ${TABLE} into Ordinate first` }).waitFor();
  await ready(page);
  assert.deepEqual(asked.slice(before).filter((c) => c === 'explore:suggest' || c.startsWith('visual:')), [], 'a table to copy first is asked nothing');
  await screens(page, 'explore-source-copy');
  await page.unroute('**/api/rpc/sourceTable%3Alist');

  // Keep as a dataset: the Live dataset is made and opened in its place, with the same question.
  await page.goto(exploreAt(P, C, BY_REGION));
  await ready(page);
  await page.getByRole('button', { name: 'Keep as a dataset' }).click();
  await page.waitForURL((u) => u.searchParams.get('dataset') !== docId && !u.searchParams.has('table'));
  const kept = new URL(page.url()).searchParams;
  assert.ok(kept.get('q'), 'the question stays');
  await page.getByRole('button', { name: 'Save as visual' }).waitFor();
  assert.equal(await page.getByText('Warehouse table, not a dataset').count(), 0);
  await page.locator('[data-chart-type="column"] canvas').waitFor();
  await ready(page);
  await screens(page, 'explore-source-kept');
});

e2e(
  'source tables: Explore on the table at phone width',
  async (s) => {
    const { page } = s;
    const { P, C } = ids(s);
    assert.ok(docId, 'test 1 read the table');
    await page.goto(exploreAt(P, C, BY_REGION));
    await ready(page);
    await page.getByRole('heading', { level: 2, name: 'Total amount by region' }).waitFor();
    await page.locator('[data-chart-type="column"] canvas').waitFor();
    const misfits: string[] = [];
    await phoneFits(page, misfits, 'Explore on a source table');
    await screens(page, 'explore-source-phone');
    assert.deepEqual(misfits, []);
  },
  { device: PHONE },
);
