// One set of figures (docs/chart-figures/00-design.md), against the real server:
//
//   the same Pareto tile and the same waterfall tile on a dashboard in the app
//   and on its published page at /p/ list IDENTICAL figure text — the figures
//   each drawer drew, as the screen-reader list under its canvas spells them
//   (the server's `figures`, through the shared formatter). The Pareto is by a
//   sub-category, so it arrives unsorted; the waterfall is by month, so its
//   steps are named "Jan 2023" in both. The published Pareto is sorted and its
//   line ends at 100% (the /p/ copy of the math, now gone, drew it in arrival
//   order); light and dark screenshots of both pages.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, screens, settled } from './fixtures.ts';

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

/** The figure text a chart lists under its canvas, in order. */
const listed = (page: Page, card: string) => page.locator(card).locator('[data-figures] li').allTextContents();

e2e('figures: a Pareto and a waterfall read the same in the app and on the published page', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const save = async (name: string, chartType: string, encoding: object) => {
    const r = await call(page, 'visual:save', { projectId: pid, datasetId: ds, name, chartType, encoding });
    return (r.visual?.id ?? r.id) as string;
  };
  // The sample's own month field (a first-of-month date, as "Revenue by month" charts it): the axis reads "Jan 2023".
  const visuals = (await call(page, 'visual:get', { projectId: pid, id: ((await call(page, 'visual:list', { projectId: pid })) as { id: string; name: string }[]).find((v) => v.name === 'Revenue by month')?.id })) as { encoding: { category: string } };
  const month = visuals.encoding.category;
  const pareto = await save('Where revenue concentrates', 'pareto', { category: 'sub_category', values: [{ column: 'revenue', aggregation: 'sum' }] });
  const bridge = await save('Profit month by month', 'waterfall', { category: month, values: [{ column: 'profit', aggregation: 'sum' }] });
  const card = (id: string, y: number) => ({ id: crypto.randomUUID(), type: 'visual', visualId: id, layout: { x: 0, y, w: 12, h: 7 } });
  const made = await call(page, 'analysis:create', { projectId: pid, name: 'Figures', sheets: [{ id: crypto.randomUUID(), name: 'Sheet 1', cards: [card(pareto, 0), card(bridge, 7)] }] });

  // ── The app ──
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);
  const appPareto = '[role="group"][aria-label="Where revenue concentrates card"]';
  const appBridge = '[role="group"][aria-label="Profit month by month card"]';
  await page.locator(appPareto).locator('[data-figures] li').first().waitFor();
  await page.locator(appBridge).locator('[data-figures] li').first().waitFor();
  const inApp = { pareto: await listed(page, appPareto), bridge: await listed(page, appBridge) };
  assert.ok(inApp.pareto.length >= 5 && inApp.bridge.length >= 20, JSON.stringify(inApp).slice(0, 300));
  assert.match(inApp.pareto.at(-1) ?? '', /· 100% cumulative$/, 'the cumulative line ends at 100%');
  assert.match(inApp.bridge[0] ?? '', /^Jan 2023: \+/, 'a month step is named as the axis names it');
  await screens(page, 'figures-app');

  // ── The published page ──
  const run = await call(page, 'publish:run', { projectId: pid, dashboardIds: [made.id] });
  assert.equal(run.ok, true, JSON.stringify(run).slice(0, 300));
  await page.goto(`/p/${run.site.id}/${run.site.pages[0].file}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true' && document.querySelectorAll('canvas').length >= 2);
  const pubCard = (title: string) => `section.pub-card:has(> h3.pub-card-title:text-is("${title}"))`;
  const published = { pareto: await listed(page, pubCard('Where revenue concentrates')), bridge: await listed(page, pubCard('Profit month by month')) };
  assert.deepEqual(published.pareto, inApp.pareto, 'the Pareto: the same order, bars and cumulative share at /p/ as in the app');
  assert.deepEqual(published.bridge, inApp.bridge, 'the waterfall: the same steps, levels and totals at /p/ as in the app');
  // Sorted, largest first: the first bar is the largest figure the Pareto lists.
  const head = (line: string) => line.replace(/^[^:]+: /, '').split(' · ')[0];
  assert.notEqual(head(published.pareto[0]), head(published.pareto.at(-1) ?? ''), 'the bars are not all one figure');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400); // an Auto dashboard redraws its charts in the reader's scheme
    await page.screenshot({ path: path.join(SCREENS, `figures-published-${scheme}.png`), fullPage: true });
  }
});
