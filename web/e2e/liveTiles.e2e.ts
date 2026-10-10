// A dashboard over a LIVE dataset (docs/live-data/00-plan.md L2.4) against the
// real server, its warehouse the test harness's fake (scripts/liveFakeConnector.ts,
// DuckDB under the live compiler's DuckDB dialect; `withLiveDataset`):
//
//   open      a chart tile and a KPI tile on the Live dataset draw the
//             warehouse's figures, each card's head saying "Live · <time>",
//             inside the RPC budget
//   again     a reload inside the cache age is served from the cache: the
//             same figure, "Live · cached …"
//   scorecard a scorecard row whose Live figure the warehouse refuses (a sum
//             over a text column) says why in the row, in the server's words
//   controls  a dropdown over a Live column not synced yet says so (a typed
//             200 — no console error); Sync schema lists its values; a number
//             column then says its values are not listed
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled, withLiveDataset } from './fixtures.ts';

withLiveDataset();

/** One RPC from a page, as the web client sends it (session cookie + CSRF header). */
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

/** The fixture table's total: amount = (i × 37) mod 101 over i < 240 (liveFakeConnector's ORDERS_DDL). */
const TOTAL = Array.from({ length: 240 }, (_, i) => (i * 37) % 101).reduce((a, b) => a + b, 0);

e2e('live: a dashboard of Live tiles draws the warehouse\'s figures, each card saying "Live · …", then from the cache', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  const live = server.sample.live;
  assert.ok(live, 'the server was seeded with a Live dataset');
  await page.goto('/');
  await settled(page);

  const visual = await call(page, 'visual:save', {
    projectId: pid, datasetId: live.datasetId, name: 'Live amount by region', chartType: 'bar',
    encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
  });
  assert.ok(visual.id, JSON.stringify(visual));
  const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 6, h: type === 'metric' ? 2 : 6 }, ...extra });
  const board = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Warehouse board',
    sheets: [{ name: 'One', cards: [
      card('metric', 0, { metric: { datasetId: live.datasetId, column: 'amount', aggregation: 'sum', label: 'Live total' } }),
      card('visual', 6, { visualId: visual.id }),
    ] }],
  });
  assert.ok(board.id, JSON.stringify(board));
  const kpiNow = await call(page, 'dashboard:metric', { projectId: pid, datasetId: live.datasetId, column: 'amount', aggregation: 'sum' });
  assert.equal(kpiNow.value, TOTAL, `the warehouse's figure over the fixture rows (${JSON.stringify(kpiNow)})`);

  await page.goto(`/analyses/${pid}/${board.id}`);
  await page.getByRole('heading', { level: 1, name: 'Warehouse board' }).waitFor();
  const kpi = page.getByRole('group', { name: 'Live total card' });
  const chart = page.getByRole('group', { name: 'Live amount by region card' });
  await kpi.getByText(/^(12\.0K|11,972)$/).waitFor();
  for (const [what, el] of [['KPI', kpi], ['chart', chart]] as const) {
    const asOf = el.getByTestId('as-of');
    await asOf.waitFor();
    // Cached already when this view reused the figure the RPC above asked for; either way it says Live.
    assert.match((await asOf.textContent()) ?? '', /^Live · (\d{1,2}:\d{2}\s?[AP]M|cached just now)$/, `the ${what} card's caption`);
    assert.match((await asOf.getAttribute('title')) ?? '', /^Live data/, `the ${what} card's hover title`);
  }
  await chart.locator('canvas').first().waitFor();
  const open = rpc.loads.at(-1)?.rpcs ?? 0;
  console.log(`rpc: Live dashboard open ${open}`);
  await screens(page, 'live-dashboard');

  // A second view inside the cache age (5 min): no warehouse call — the cache's own time, said so.
  await page.reload();
  await kpi.getByText(/^(12\.0K|11,972)$/).waitFor();
  const cached = kpi.getByTestId('as-of');
  await cached.waitFor();
  assert.match((await cached.textContent()) ?? '', /^Live · cached (just now|\d+ min ago)$/);
  assert.match((await chart.getByTestId('as-of').textContent()) ?? '', /^Live · cached (just now|\d+ min ago)$/);
});

e2e('live: a scorecard row with no Live figure says why, in the row', async ({ page, server }) => {
  const pid = server.sample.projectId;
  const live = server.sample.live;
  assert.ok(live, 'the server was seeded with a Live dataset');
  await page.goto('/');
  await settled(page);
  // The warehouse cannot sum text: a typed refusal (200), where an extract would simply have no figure.
  const bad = await call(page, 'metric:save', { projectId: pid, input: { name: 'Region total (live)', datasetId: live.datasetId, definition: { column: 'region', aggregation: 'sum' } } });
  const good = await call(page, 'metric:save', { projectId: pid, input: { name: 'Amount total (live)', datasetId: live.datasetId, definition: { column: 'amount', aggregation: 'sum' } } });
  const badId = bad.metric?.id;
  const goodId = good.metric?.id;
  assert.ok(badId && goodId, JSON.stringify([bad, good]));
  const sc = await call(page, 'scorecard:create', { projectId: pid, name: 'Live scorecard', period: 'month', rows: [{ metricId: badId }, { metricId: goodId }] });
  assert.ok(sc.scorecard?.id, JSON.stringify(sc));

  await page.goto(`/scorecards/${pid}/${sc.scorecard.id}`);
  await settled(page);
  const refused = page.locator(`tr[data-metric-id="${badId}"]`);
  const why = refused.locator('[data-live-refusal]');
  await why.waitFor();
  assert.ok(((await why.textContent()) ?? '').trim().length > 20, 'the server\'s sentence, in the open');
  // NEGATIVE CONTROL: the row the warehouse answered carries no reason.
  const answered = page.locator(`tr[data-metric-id="${goodId}"]`);
  await answered.waitFor();
  assert.equal(await answered.locator('[data-live-refusal]').count(), 0);
  await screens(page, 'live-scorecard-row');
});

/** Both themes of the page AS IT STANDS (an open panel survives; `screens()` reloads). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

// LAST in this file: it syncs the schema, which the tests above find unsynced.
e2e('live: a dashboard control over a Live column says why it has no values, and Sync schema lists them', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  const live = server.sample.live;
  assert.ok(live, 'the server was seeded with a Live dataset');
  await page.goto('/');
  await settled(page);
  const control = (column: string, label: string, x: number) => ({ id: crypto.randomUUID(), type: 'control', layout: { x, y: 0, w: 3, h: 1 }, control: { kind: 'dropdown', datasetId: live.datasetId, column, label } });
  const board = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Live controls',
    sheets: [{ name: 'One', cards: [
      control('region', 'Region', 0),
      control('amount', 'Amount', 3),
      { id: crypto.randomUUID(), type: 'metric', layout: { x: 0, y: 1, w: 6, h: 2 }, metric: { datasetId: live.datasetId, column: 'amount', aggregation: 'sum', label: 'Live total' } },
    ] }],
  });
  assert.ok(board.id, JSON.stringify(board));

  await page.goto(`/analyses/${pid}/${board.id}`);
  await page.getByRole('heading', { level: 1, name: 'Live controls' }).waitFor();
  const region = page.getByRole('button', { name: 'Region: not synced yet' });
  await region.waitFor();
  await page.getByRole('button', { name: 'Amount: not synced yet' }).waitFor();
  console.log(`rpc: Live controls open ${rpc.loads.at(-1)?.rpcs ?? 0}`);
  await region.click();
  await page.getByText(/has not been synced yet, so there is no list of values/).waitFor();
  await screensInPlace(page, 'live-control-not-synced');

  // Sync schema (an editor's): the profile lands, the values are refetched, the control is a menu.
  await page.getByRole('button', { name: 'Sync schema' }).click();
  const menu = page.getByRole('combobox', { name: 'Region' });
  await menu.waitFor({ timeout: 30_000 });
  assert.deepEqual((await menu.locator('option').allTextContents()).sort(), ['All', 'East', 'North', 'South', 'West']);
  // A number column is never listed: it says so, and offers no sync that would not help.
  const amount = page.getByRole('button', { name: 'Amount: values not listed' });
  await amount.waitFor();
  await amount.click();
  await page.getByText(/keeps a list only for a text column with up to 50 different values/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Sync schema' }).count(), 0);
  await screensInPlace(page, 'live-control-not-listed');
  await page.keyboard.press('Escape');

  // The menu filters the Live KPI through the warehouse.
  const kpi = page.getByRole('group', { name: 'Live total card' });
  const all = await kpi.textContent();
  await menu.selectOption('North');
  await page.waitForFunction((before) => document.querySelector('[role="group"][aria-label="Live total card"]')?.textContent !== before, all);
});
