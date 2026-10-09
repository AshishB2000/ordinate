// Freshness (docs/live-data/00-plan.md, L0.1 and L0.2) against the real server:
//
//   live      a dashboard open in one page; the rows under it change and the
//             dataset is refreshed from ANOTHER page (over RPC, as the Data
//             list's ↻ sends it); the KPI moves without a reload, inside the
//             RPC budget, and each card's head says how fresh it is — the
//             time moving with the refresh
//   answers   "Explain" on a chart, no model: the answer card in the dock is
//             dated too
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { e2e, screens, settled } from './fixtures.ts';

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

const SALES = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };

/**
 * A refreshable dataset with no network: `Feed`, a query over the input table
 * `Feed base` (typed rows, edited over RPC — an edit there re-runs nothing by
 * itself, so only the refresh moves `Feed`), a chart and a dashboard over it.
 */
async function seed(page: Page, pid: string) {
  const base = await call(page, 'input:create', {
    projectId: pid, name: 'Feed base', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }],
  });
  assert.equal(base.ok, true, JSON.stringify(base));
  const typed = await call(page, 'input:save', { projectId: pid, id: base.id, batches: [{ label: 'Add rows', ops: [{ t: 'ins', at: 0, rows: [['North', '100'], ['South', '200']] }] }] });
  assert.equal(typed.ok, true, JSON.stringify(typed).slice(0, 300));
  const prep = await call(page, 'sql:prepareSave', { projectId: pid, sql: 'SELECT region, amount FROM "Feed base"' });
  assert.equal(prep.ok, true, JSON.stringify(prep).slice(0, 300));
  const saved = await call(page, 'dataset:composeSave', {
    projectId: pid, name: 'Feed', base: { inline: { name: 'q', stagedId: prep.stagedId } }, joins: [], steps: [], sourceKind: 'sql', origin: prep.origin,
  });
  assert.equal(saved.ok, true, JSON.stringify(saved).slice(0, 300));
  const feed = saved.dataset.id as string;
  const visual = await call(page, 'visual:save', { projectId: pid, datasetId: feed, name: 'Feed by region', chartType: 'bar', encoding: SALES });
  assert.ok(visual.id, JSON.stringify(visual));
  const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 6, h: type === 'metric' ? 2 : 6 }, ...extra });
  const board = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Live board',
    sheets: [{ name: 'One', cards: [card('metric', 0, { metric: { datasetId: feed, column: 'amount', aggregation: 'sum', label: 'Feed total' } }), card('visual', 6, { visualId: visual.id })] }],
  });
  assert.ok(board.id, JSON.stringify(board));
  return { base: base.id as string, feed, visual: visual.id as string, board: board.id as string };
}

e2e('live: a refresh from another page moves an open dashboard, no reload, and every card says how fresh it is', async ({ page, server, rpc }) => {
  const pid = server.sample.projectId;
  await page.goto('/');
  await settled(page);
  const s = await seed(page, pid);

  await page.goto(`/analyses/${pid}/${s.board}`);
  await page.getByRole('heading', { level: 1, name: 'Live board' }).waitFor();
  const kpi = page.getByRole('group', { name: 'Feed total card' });
  const chart = page.getByRole('group', { name: 'Feed by region card' });
  await kpi.getByText('300', { exact: true }).waitFor();
  // L0.2: each card's head says how fresh its figure is — the server's time, worded here.
  const kpiAsOf = kpi.getByTestId('as-of');
  await kpiAsOf.waitFor();
  assert.match((await kpiAsOf.textContent()) ?? '', /^As of \d{1,2}:\d{2}\s?[AP]M$/);
  await chart.getByTestId('as-of').waitFor();
  const before = await kpiAsOf.getAttribute('datetime');
  const load = rpc.loads.at(-1);
  const loads = rpc.loads.length;
  const atOpen = load?.rpcs ?? 0;
  console.log(`rpc: dashboard open ${atOpen}`);

  const timeOf = () => page.evaluate(() => document.querySelector('[aria-label="Feed total card"] time')?.getAttribute('datetime') ?? '');
  const movedFrom = (prev: string) =>
    page.waitForFunction(([p]) => (document.querySelector('[aria-label="Feed total card"] time')?.getAttribute('datetime') ?? p) !== p, [prev] as const, { timeout: 5000 });

  // ── Another page edits the rows under it ────────────────────────────────
  // An input-table save re-runs the queries built on the table (datasetDependents):
  // `Feed` is refreshed downstream, announced, and the open dashboard follows.
  const other = await page.context().newPage();
  await other.goto('/');
  await settled(other);
  let t0 = Date.now();
  const more = await call(other, 'input:save', { projectId: pid, id: s.base, batches: [{ label: 'Add a row', ops: [{ t: 'ins', at: 2, rows: [['East', '50']] }] }] });
  assert.equal(more.ok, true, JSON.stringify(more).slice(0, 300));
  await kpi.getByText('350', { exact: true }).waitFor({ timeout: 5000 });
  const byEdit = Date.now() - t0;
  await movedFrom(before ?? '');
  const afterEdit = await timeOf();
  assert.ok(before && Date.parse(afterEdit) > Date.parse(before), `the caption moved with the re-run (${before} → ${afterEdit})`);
  assert.equal(await chart.getByTestId('as-of').getAttribute('datetime'), afterEdit, 'the chart on the same dataset says the same time');

  // ── …then refreshes the dataset itself (the Data list's ↻: refreshAsJob) ─
  t0 = Date.now();
  const refreshed = await call(other, 'dataset:refresh', { projectId: pid, id: s.feed });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed).slice(0, 300));
  await movedFrom(afterEdit);
  const byRefresh = Date.now() - t0;
  assert.ok(Date.parse(await timeOf()) > Date.parse(afterEdit), 'a refresh with the same rows still says the data is newer');
  assert.equal(await kpi.getByText('350', { exact: true }).count(), 1, 'the figure stands');
  await other.close();

  assert.equal(rpc.loads.length, loads, 'no reload, no navigation');
  const spent = (rpc.loads.at(-1)?.rpcs ?? 0) - atOpen;
  console.log(`another page's edit → this dashboard redrawn in ${byEdit} ms; its refresh → in ${byRefresh} ms (the 500 ms debounce included) · ${spent} RPCs for both redraws`);
  assert.ok(spent <= 6, `each redraw is one batch, not a call per tile (${spent} RPCs for two)`);
  await screens(page, 'freshness-dashboard');

  // Two days on (the browser's clock): over a day old wears the warning tint —
  // and an icon and the date in words, never colour alone. Both themes.
  await page.clock.install({ time: Date.now() + 2 * 86_400_000 }); // time still flows: charts animate
  await screens(page, 'freshness-old');
  const old = page.getByRole('group', { name: 'Feed total card' }).getByTestId('as-of');
  assert.match((await old.textContent()) ?? '', /^As of [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M$/);
  assert.equal(await old.locator('svg').count(), 1, 'the old caption carries the alert icon');
  assert.match((await old.getAttribute('title')) ?? '', /more than a day old$/);
});

e2e('answers: Explain on a chart (no model) — the answer card in the dock is dated', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/visuals/${pid}`);
  await settled(page);
  await page.getByRole('button', { name: 'More actions for Revenue by month' }).click();
  await page.getByRole('menuitem', { name: 'Explain' }).click();
  const card = page.getByRole('complementary', { name: 'Assistant' }).getByTestId('answer-card');
  await card.waitFor();
  const asOf = card.getByTestId('as-of');
  assert.match((await asOf.textContent()) ?? '', /^As of \d{1,2}:\d{2}\s?[AP]M$/);
  assert.ok(Number.isFinite(Date.parse((await asOf.getAttribute('datetime')) ?? '')), 'the server\'s instant rides on the <time>');
  await screens(page, 'freshness-answer');
});
