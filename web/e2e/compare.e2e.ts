// A dashboard's Compare, against the real server on the sample project's
// "Retail orders" (2023-01 … 2024-12), on a sheet filtered to Q4 2024:
//
//   off       no "What changed" strip, no delta on a KPI, one series asked for
//   on        "vs previous period": the strip says what changed, one server-
//             written sentence per KPI; every KPI wears its delta and "Why?";
//             the bar chart is asked for the comparison period beside its own
//             (the request carries the compare; the time-series one does too,
//             and the server leaves a dated axis whole for this mode)
//   custom    two dates: nothing is asked until both are picked, then the
//             sentences are about those dates
//   back off  the strip and the deltas go
//
// Fails on any console error or CSP violation and stays inside the RPC budget.
// Screens in both themes go to web/e2e/__screens__/compare-*.png.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';
import { e2e, SCREENS, settled } from './fixtures.ts';

const SENTENCE = /^Revenue (rose|fell) \S+(;| as members offset each other;) .+\.$/;

/** One screenshot per theme WITHOUT a reload (the view state stays as it is). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

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

async function pick(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}

e2e('compare: the whole sheet against another period — the strip, the KPI deltas, the bars; custom dates; off', async ({ page, server }) => {
  const pid = server.sample.projectId;
  await page.goto(`/analyses?project=${pid}`);
  await settled(page);
  const datasets = (await call(page, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const ds = datasets.find((d) => d.name === 'Retail orders')?.id as string;
  const save = async (name: string, encoding: object): Promise<string> => {
    const r = await call(page, 'visual:save', { projectId: pid, datasetId: ds, name, chartType: 'column', encoding });
    return (r.visual?.id ?? r.id) as string;
  };
  const byCategory = await save('Revenue by category', { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] });
  const byMonth = await save('Revenue by month', { category: 'order_date', grain: 'month', values: [{ column: 'revenue', aggregation: 'sum' }] });
  const kpi = (label: string, column: string, x: number) => ({ id: crypto.randomUUID(), type: 'metric', layout: { x, y: 0, w: 3, h: 3 }, metric: { datasetId: ds, column, aggregation: 'sum', label } });
  const made = await call(page, 'analysis:create', {
    projectId: pid,
    name: 'Compare',
    filters: [{ type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-10-01', to: '2024-12-31' } }],
    sheets: [{
      id: crypto.randomUUID(),
      name: 'Sheet 1',
      cards: [
        kpi('Revenue', 'revenue', 0), kpi('Units', 'units', 3),
        { id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 3, w: 6, h: 7 }, visualId: byCategory },
        { id: crypto.randomUUID(), type: 'visual', layout: { x: 6, y: 3, w: 6, h: 7 }, visualId: byMonth },
      ],
    }],
  });
  assert.ok(made.id, JSON.stringify(made));

  // What the tiles ask the server for, so "the bars are compared" is checked at the request, not by reading pixels.
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/rpc/analysis%3Atiles') || r.url().includes('/api/rpc/analysis:tiles')) asked.push(r.postData() ?? '');
  });
  await page.goto(`/analyses/${pid}/${made.id}`);
  await settled(page);
  const revenue = page.getByRole('group', { name: 'Revenue card' });
  const bars = page.getByRole('group', { name: 'Revenue by category card' });
  await bars.getByRole('img', { name: 'Revenue by category' }).waitFor();
  const strip = page.getByRole('region', { name: 'What changed' });

  // ── Off ─────────────────────────────────────────────────────────────────
  assert.equal(await strip.count(), 0, 'no strip while Compare is off');
  assert.equal(await revenue.getByRole('button', { name: 'Why did this change?' }).count(), 0, 'no delta on a KPI while Compare is off');
  assert.ok(asked.length > 0 && !asked.some((b) => b.includes('"compare"')), 'NEGATIVE CONTROL: nothing asks for a comparison while it is off');

  // ── On: vs previous period ──────────────────────────────────────────────
  await pick(page, 'Compare this dashboard with', 'vs previous period');
  await strip.getByText('What changed · vs previous period').waitFor();
  const lines = strip.getByRole('listitem');
  await strip.getByText(SENTENCE).first().waitFor();
  assert.equal(await lines.count(), 2, 'one line per KPI');
  assert.match((await lines.nth(0).textContent()) ?? '', SENTENCE, 'the line is the server’s sentence, with what drove the change');
  await revenue.getByText('vs previous period').waitFor();
  await revenue.getByRole('button', { name: 'Why did this change?' }).waitFor();
  await page.getByRole('group', { name: 'Units card' }).getByRole('button', { name: 'Why did this change?' }).waitFor();
  const compared = asked.filter((b) => b.includes('"compare":{"mode":"previous_period"}'));
  assert.ok(compared.some((b) => b.includes('"kind":"visual"') && b.includes('"category":"category"')), 'the bar chart asks for the comparison period beside its own');
  await page.waitForTimeout(700); // the second bars finish animating in
  await screensInPlace(page, 'compare-on');

  // The strip's question IS the card's "Why?": the drawer opens on the answer already held.
  await revenue.getByRole('button', { name: 'Why did this change?' }).click();
  const why = page.getByRole('dialog', { name: 'Why did Revenue change?' });
  await why.getByRole('list', { name: 'Waterfall of contributors' }).waitFor();
  await page.keyboard.press('Escape');
  await why.waitFor({ state: 'detached' });

  // ── Custom dates ────────────────────────────────────────────────────────
  const before = asked.length;
  await pick(page, 'Compare this dashboard with', 'vs custom dates…');
  await strip.getByText('Pick both dates to compare with.').waitFor();
  await page.waitForTimeout(400);
  assert.ok(!asked.slice(before).some((b) => b.includes('"mode":"custom"')), 'NEGATIVE CONTROL: nothing is asked until both dates are picked');
  await page.getByLabel('Compare from').fill('2023-10-01');
  await page.getByLabel('Compare to').fill('2023-12-31');
  await strip.getByText(SENTENCE).first().waitFor();
  await revenue.getByText('vs custom range').waitFor();
  assert.ok(asked.some((b) => b.includes('"compare":{"mode":"custom","from":"2023-10-01","to":"2023-12-31"}')), 'the tiles ask for exactly those dates');
  await page.waitForTimeout(700);
  await screensInPlace(page, 'compare-custom');

  // ── Back off ────────────────────────────────────────────────────────────
  await pick(page, 'Compare this dashboard with', 'Compare: off');
  await strip.waitFor({ state: 'detached' });
  await revenue.getByRole('button', { name: 'Why did this change?' }).waitFor({ state: 'detached' });
});
