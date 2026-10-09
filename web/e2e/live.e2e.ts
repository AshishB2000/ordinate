// The Live dataset screen (docs/live-data/00-plan.md L2.6) against the built
// server, over the test harness's fake warehouse — the compiler's DuckDB
// dialect in the org's own worker (scripts/liveFakeConnector.ts), registered
// only because this spec starts the server with ORDINATE_TEST_LIVE_FAKE=1.
//
//   1. The page: the Live badge, the Live switch, the cache age (5 min, the
//      default), Refresh now; the Data tab says what works, what needs a copy.
//   2. Schema: not profiled yet → Sync schema reads the warehouse → the sample's
//      figures (240 rows), each column's values.
//   3. Settings: a new cache age reaches the server; Refresh now resets the cache.
//   4. Off for Live: Quality, Prepare and Statistics say why and offer a copy —
//      without calling the channel they guard (a refusal would be a console error
//      here, and the fixtures fail on any).
//   5. The builder: the warehouse's answer with "Live · …", or the server's typed
//      refusal with "Make a copy" (until charts are routed to the warehouse, L2.4).
//   6. Make a copy: a new dataset with every row, opened where the person was going;
//      the Live dataset stays Live.
//   Both themes of each state are written to __screens__/live-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, settled, withLiveDataset, type Session } from './fixtures.ts';

withLiveDataset();

async function post(s: Session, channel: string, payload?: unknown) {
  const csrf = (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
  return s.page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
}

const ids = (s: Session) => {
  const live = s.server.sample.live;
  if (!live) throw new Error('the server was seeded without the Live dataset');
  return { P: s.server.sample.projectId, D: live.datasetId };
};

/** The page is up and nothing is loading — including the tab's own panel. */
async function ready(page: Page): Promise<void> {
  await settled(page);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
}

e2e('live: the dataset page — settings, Schema and Sync schema, what is off, the builder, Make a copy', async (s) => {
  const { page } = s;
  const { P, D } = ids(s);

  // ── 1. The page ─────────────────────────────────────────────────────────
  await page.goto(`/data/${P}/${D}`);
  await ready(page);
  await page.getByRole('heading', { level: 1, name: 'Orders (live)' }).waitFor();
  await page.getByRole('heading', { name: 'Live — the rows stay in the warehouse' }).waitFor();
  await page.getByText('Live · cached up to 5 min').waitFor();
  assert.equal(await page.getByRole('switch', { name: 'Live' }).isChecked(), true, 'the Live switch is on');
  assert.match((await page.getByRole('combobox', { name: 'Cache age of Orders (live)' }).textContent()) ?? '', /5 min \(default\)/);
  assert.equal(await page.getByRole('button', { name: 'Refresh now' }).isEnabled(), true);
  assert.equal(await page.getByRole('region', { name: 'Needs a copy' }).getByRole('listitem').count(), 6, "the plan's six groups");
  assert.equal(await page.getByRole('link', { name: 'Prepare' }).count(), 0, 'no Prepare on a Live dataset');
  await screens(page, 'live-dataset');

  // ── 2. Schema: Sync schema reads the warehouse ────────────────────────────
  await page.getByRole('tab', { name: 'Schema' }).click();
  await page.getByText(/^Not profiled yet/).waitFor();
  await page.getByRole('button', { name: 'Sync schema' }).click();
  await page.getByText('Synced 3 columns. Profiled from 240 rows.').waitFor({ timeout: 30_000 });
  await page.getByText(/^Profiled from a sample of 240 rows · /).waitFor();
  const region = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'region', exact: true }) });
  for (const v of ['North', 'South', 'East', 'West']) await region.getByText(v, { exact: true }).waitFor();
  assert.match((await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'amount', exact: true }) }).textContent()) ?? '', /100%/);
  await screens(page, 'live-schema');

  // ── 3. Settings: the cache age, Refresh now ───────────────────────────────
  await page.getByRole('combobox', { name: 'Cache age of Orders (live)' }).click();
  await page.getByRole('option', { name: '1 h' }).click();
  await page.getByText('Answers on “Orders (live)” are cached up to 1 h.').waitFor();
  await page.getByText('Live · cached up to 1 h').waitFor();
  const source = (await (await post(s, 'dataset:source', { projectId: P, id: D })).json()) as Record<string, unknown>;
  assert.equal(source.maxCacheAgeSec, 3600, 'the server keeps the new cache age');
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await page.getByText('Cache reset — the next figure asks the warehouse.').waitFor();

  // ── 4. Off for Live, with no request to the channel it guards ─────────────
  await page.getByRole('tab', { name: 'Quality' }).click();
  await page.getByRole('heading', { name: 'Quality checks are off for Live datasets' }).waitFor();
  await screens(page, 'live-off-quality');
  await page.goto(`/data/${P}/${D}/prepare`);
  await ready(page);
  await page.getByRole('heading', { name: 'Prepare steps and formulas are off for Live datasets' }).waitFor();
  await page.goto(`/analytics/${P}/${D}/stats`);
  await ready(page);
  await page.getByRole('heading', { name: 'Statistics are off for Live datasets' }).waitFor();

  // ── 5. The builder: the warehouse's figure, or the server's typed refusal ──
  await page.goto(`/visuals/${P}/new?dataset=${D}`);
  await ready(page);
  const figure = page.locator('[data-testid="as-of"], [data-live-refusal]').first();
  await figure.waitFor();
  if ((await figure.getAttribute('data-testid')) === 'as-of') assert.match((await figure.textContent()) ?? '', /^Live · /, 'a Live figure says so');
  else await page.locator('[data-live-refusal]').getByRole('button', { name: 'Make a copy' }).waitFor();
  assert.equal(await page.getByRole('combobox', { name: /As of/ }).count(), 0, 'no "As of" picker: a Live dataset keeps no snapshots');
  await screens(page, 'live-builder');

  // ── 6. Make a copy: from the Quality tab, the copy opens on ITS Quality tab ─
  await page.goto(`/data/${P}/${D}?tab=quality`);
  await ready(page);
  await page.getByRole('button', { name: 'Make a copy' }).click();
  await page.waitForURL((u) => u.pathname.startsWith(`/data/${P}/`) && !u.pathname.endsWith(D) && u.search === '?tab=quality', { timeout: 30_000 });
  await page.getByRole('heading', { level: 1, name: 'Orders (live) (copy)' }).waitFor();
  await page.getByText(/Copied into “Orders \(live\) \(copy\)” — 240 rows/).waitFor();
  await page.getByText('240 rows', { exact: false }).first().waitFor();
  await page.getByRole('tab', { name: 'Data' }).click();
  await ready(page);
  await page.getByRole('grid').first().waitFor();
  const list = (await (await post(s, 'dataset:list', { projectId: P })).json()) as { id: string; name: string; mode?: string; rowCount: number }[];
  const live = list.find((d) => d.id === D);
  const copy = list.find((d) => d.name === 'Orders (live) (copy)');
  assert.equal(live?.mode, 'live', 'the Live dataset stays Live');
  assert.equal(copy?.mode, undefined, 'the copy is an extract');
  assert.equal(copy?.rowCount, 240, 'with every row the warehouse holds');
});
