// Rebuild a dashboard from a screenshot (docs/rebuild-from-screenshot/) against
// the real server, the sample project's Retail orders, and a stdlib stand-in
// for an OpenAI-compatible provider (the org's "gateway"):
//
//   the page → a dashboard screenshot drawn on a canvas (four KPIs, charts,
//   filters, each with a FIGURE on it) → the model reads it ON THE SERVER (the
//   request is asserted to carry the image) → the check screen: each tile
//   outlined and matched to the sample's columns, the KPI figure the ENGINE's
//   (a sum over the CSV, formatted by the app's formatter) and never the one
//   painted on the screenshot → a sum over a text column refused, fixed by
//   switching it to a count → a chart Ordinate does not draw dropped → Create
//   dashboard → the built dashboard shows the same figure.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after } from 'node:test';
import type { Page } from 'playwright';
import { formatCompact } from '../../src/app/format.ts';
import { configureServer, e2e, SCREENS, screens, settled } from './fixtures.ts';

/** What the stub model reads off the screenshot: structure, plus the figures a model is not allowed to hand over. */
const REPLY = {
  title: 'Sales Performance FY2024',
  tool: 'power_bi',
  tiles: [
    { kind: 'text', title: 'Sales Performance — FY2024', box: [2, 2, 58, 7] },
    { kind: 'filter', title: 'Region', box: [62, 2, 17, 7], dimension: 'Region', filterKind: 'dropdown' },
    { kind: 'filter', title: 'Order Date', box: [81, 2, 17, 7], dimension: 'Order Date', filterKind: 'date_range' },
    { kind: 'kpi', title: 'Total Sales $2.30M', box: [2, 12, 23, 14], measures: [{ field: 'Sales', aggregation: 'sum' }], value: '$2,297,201' },
    { kind: 'kpi', title: 'Profit', box: [26.5, 12, 23, 14], measures: [{ field: 'Profit', aggregation: 'sum' }], value: 286397 },
    { kind: 'kpi', title: 'Units Sold', box: [51, 12, 23, 14], measures: [{ field: 'Units', aggregation: 'sum' }] },
    { kind: 'kpi', title: 'Avg Discount', box: [75.5, 12, 22.5, 14], measures: [{ field: 'Discount', aggregation: 'avg' }], value: '15.6%' },
    { kind: 'chart', chart: 'clustered bar', title: 'Sales by Region', box: [2, 29, 47, 33], dimension: 'Region', measures: [{ field: 'Sales', aggregation: 'sum' }] },
    { kind: 'chart', chart: 'line', title: 'Profit trend', box: [51, 29, 47, 33], dimension: 'Order Date', measures: [{ field: 'Profit', aggregation: 'sum' }] },
    { kind: 'chart', chart: 'doughnut', title: 'Sales by Segment', box: [2, 65, 23, 33], dimension: 'Segment', measures: [{ field: 'Sales', aggregation: 'sum' }] },
    { kind: 'chart', chart: 'treemap', title: 'Sales by Sub-Category', box: [26.5, 65, 23, 33], dimension: 'Sub-Category', measures: [{ field: 'Sales', aggregation: 'sum' }] },
    { kind: 'chart', chart: 'bar', title: 'Customers by State', box: [51, 65, 23, 33], dimension: 'State', measures: [{ field: 'State', aggregation: 'sum' }] },
    { kind: 'chart', chart: 'sunburst', title: 'Category mix', box: [75.5, 65, 22.5, 33], dimension: 'Category', measures: [{ field: 'Sales', aggregation: 'sum' }] },
  ],
};
/** Figures painted on the screenshot and planted in the reply: none may reach the page. */
const PLANTED = ['2,297,201', '$2.30M', '286,397', '286397', '15.6%'];

const model = { calls: 0, last: '', delay: 0 };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += String(c)));
  req.on('end', () => {
    model.calls++;
    model.last = body;
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLY) }, finish_reason: 'stop' }] }));
    }, model.delay);
  });
});
await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
const port = (mock.address() as { port: number }).port;
after(() => mock.close());
// The stub model is on loopback, which the SSRF guard refuses unless allowlisted (T6.1).
configureServer({ env: { SSRF_ALLOW: '127.0.0.1/32' } });

function connectModel(dataDir: string): void {
  const dir = path.join(dataDir, 'orgs', 'default', 'userData');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    version: 2,
    executionMode: 'byok',
    byok: { activeProvider: 'gateway', providers: { gateway: { baseUrl: `http://127.0.0.1:${port}`, model: 'mock', maxTokens: '', verified: true } } },
  }));
}

/** The sample's revenue, summed here from the CSV the sample was seeded from — the engine's answer must equal it. */
function revenueTotal(): number {
  const lines = readFileSync(new URL('../../assets/samples/retail-orders.csv', import.meta.url), 'utf8').trim().split('\n');
  const head = lines[0]!.split(',');
  const at = head.indexOf('revenue');
  return lines.slice(1).reduce((n, l) => {
    const cells = l.split(',');
    assert.equal(cells.length, head.length, 'a plain CSV line');
    return n + Number(cells[at]);
  }, 0);
}

/** A BI dashboard drawn on a canvas: the tiles where the reply says they are, each with a figure painted on it. */
async function dashboardPng(page: Page): Promise<Buffer> {
  const url = await page.evaluate((tiles) => {
    const W = 1200, H = 760;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    g.fillStyle = '#eef0f4';
    g.fillRect(0, 0, W, H);
    const figures: Record<string, string> = { 'Total Sales $2.30M': '$2.30M', Profit: '$286,397', 'Units Sold': '37.9K', 'Avg Discount': '15.6%' };
    tiles.forEach((t: { kind: string; title: string; box: number[]; chart?: string }, i: number) => {
      const [x, y, w, h] = [t.box[0]! * W / 100, t.box[1]! * H / 100, t.box[2]! * W / 100, t.box[3]! * H / 100];
      g.fillStyle = t.kind === 'text' ? '#eef0f4' : '#ffffff';
      g.fillRect(x, y, w, h);
      g.fillStyle = '#1f2937';
      g.font = t.kind === 'text' ? 'bold 24px sans-serif' : '13px sans-serif';
      g.fillText(t.kind === 'kpi' ? t.title.replace(/\s\$.*$/, '') : t.title, x + 12, y + (t.kind === 'text' ? 34 : 22));
      if (t.kind === 'kpi') {
        g.font = 'bold 30px sans-serif';
        g.fillText(figures[t.title] ?? '', x + 12, y + 70);
      } else if (t.kind === 'filter') {
        g.strokeStyle = '#9ca3af';
        g.strokeRect(x + 8, y + 28, w - 16, 18);
      } else if (t.kind === 'chart') {
        g.fillStyle = ['#118dff', '#12239e', '#e66c37', '#6b007b'][i % 4]!;
        if (t.chart === 'line') {
          g.beginPath();
          for (let k = 0; k < 12; k++) g.lineTo(x + 20 + k * (w - 40) / 11, y + h - 30 - ((k * 37) % 90));
          g.strokeStyle = '#118dff';
          g.lineWidth = 3;
          g.stroke();
        } else if (t.chart === 'doughnut' || t.chart === 'sunburst') {
          g.beginPath();
          g.arc(x + w / 2, y + h / 2 + 10, Math.min(w, h) / 3, 0, Math.PI * 1.4);
          g.lineWidth = 22;
          g.strokeStyle = '#118dff';
          g.stroke();
        } else {
          for (let k = 0; k < 4; k++) g.fillRect(x + 16, y + 40 + k * 26, (w - 40) * (1 - k * 0.2), 16);
        }
      }
    });
    return c.toDataURL('image/png');
  }, REPLY.tiles);
  return Buffer.from(url.split(',')[1]!, 'base64');
}

/** Both themes without a reload — the check screen's state lives in the page. */
async function screensInPlace(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

e2e('rebuild: a dashboard screenshot → read on the server → matched to your columns → fixed → built on your data', async ({ page, server }) => {
  connectModel(server.dataDir);
  const pid = server.sample.projectId;
  await page.goto(`/analyses/${pid}/rebuild`);
  await settled(page);
  await page.getByRole('heading', { name: 'Drop a dashboard screenshot, or paste one' }).waitFor();
  await screens(page, 'rebuild-drop'); // reloads, so before anything is picked
  // The sample project holds two datasets: build on Retail orders.
  const on = page.getByRole('region', { name: 'How it works' }).getByRole('combobox', { name: 'Build it on' });
  await on.click();
  await page.getByRole('listbox', { name: 'Build it on' }).getByRole('option', { name: 'Retail orders' }).click();
  await on.getByText('Retail orders').waitFor();

  model.delay = 1500;
  const input = page.getByRole('button', { name: 'Choose a screenshot' }).locator('..').locator('input[type="file"]');
  await input.setInputFiles({ name: 'dashboard.png', mimeType: 'image/png', buffer: await dashboardPng(page) });
  await page.getByRole('status', { name: 'The model is reading the screenshot' }).waitFor();
  await screensInPlace(page, 'rebuild-reading');
  model.delay = 0;

  await page.getByRole('heading', { level: 1, name: 'Check the rebuild' }).waitFor();
  assert.equal(model.calls, 1);
  assert.ok(model.last.includes('data:image/png;base64,iVBORw0KGgo'), 'the server sent the model the image');
  await page.getByText('Power BI dashboard').waitFor();
  const tile = (n: number, title: string) => page.getByRole('article', { name: `Tile ${n}: ${title}` });

  // The KPI: "Sales" matched to revenue, and the figure is the engine's — not the $2.30M painted on the screenshot.
  const sales = tile(4, 'Total Sales');
  await sales.getByText('Likely').waitFor();
  await sales.getByText(formatCompact(revenueTotal()), { exact: true }).waitFor();
  await sales.getByText('Sum of revenue').waitFor();
  // Units → units, exactly; a clustered bar is Ordinate's own chart, drawn from the sample.
  await tile(6, 'Units Sold').getByText('Exact').waitFor();
  await tile(8, 'Sales by Region').locator('canvas').waitFor();
  // "Segment" is the sample's customer_segment — the column holding the word, not a synonym of it.
  await tile(10, 'Sales by Segment').getByRole('combobox', { name: 'Tile 10: column for category “Segment”' }).getByText('customer_segment · text').waitFor();

  // Refused: a sum over a text column, in the server's words — and never built.
  const state = tile(12, 'Customers by State');
  await state.getByRole('note').getByText('needs a number column, but "state" is text').waitFor();
  await state.getByText('Needs you').waitFor();
  // Not coerced: a sunburst waits for a pick.
  await tile(13, 'Category mix').getByRole('note').getByText('Ordinate has no "sunburst" chart').waitFor();
  await page.getByText('10 of 13 tiles ready').waitFor();
  // The heading repeats the dashboard's title: it names the dashboard rather than becoming an empty note.
  await tile(1, 'Sales Performance — FY2024').getByText('Dropped').waitFor();
  await page.getByText('2 filters in the bar').waitFor();

  const body = (await page.locator('main').textContent()) ?? '';
  for (const f of PLANTED) assert.ok(!body.includes(f), `the figure ${f} read off the screenshot is not on the page`);
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await screensInPlace(page, 'rebuild-check');
  // Further down: the KPIs with the engine's figures, the charts drawn from the sample, the refusal.
  await tile(8, 'Sales by Region').scrollIntoViewIfNeeded();
  await screensInPlace(page, 'rebuild-check-tiles');
  await state.scrollIntoViewIfNeeded();
  await screensInPlace(page, 'rebuild-check-refused');

  // Fix the refused tile: count the states instead of summing them. Drop the sunburst.
  await state.getByRole('combobox', { name: 'Tile 12: how State is aggregated' }).click();
  await page.getByRole('listbox', { name: 'Tile 12: how State is aggregated' }).getByRole('option', { name: 'Count' }).click();
  await state.getByText('Ready').waitFor();
  await tile(13, 'Category mix').getByRole('button', { name: 'Drop' }).click();
  await tile(13, 'Category mix').getByText('Dropped').waitFor();
  await page.getByText('11 of 13 tiles ready').waitFor();
  await page.getByRole('img', { name: 'The dashboard that will be built: 4 KPIs, 5 charts' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await screensInPlace(page, 'rebuild-fixed');

  await page.getByRole('button', { name: 'Create dashboard' }).click();
  await page.waitForURL(new RegExp(`/analyses/${pid}/[0-9a-f-]{36}$`));
  await page.getByRole('heading', { level: 1, name: 'Sales Performance FY2024' }).waitFor();
  // The built KPI tile shows the same engine figure the check screen did.
  await page.getByText(formatCompact(revenueTotal()), { exact: true }).first().waitFor();
  await page.getByText('Customers by State').first().waitFor();
  assert.equal(model.calls, 1, 'matching, fixing and building ask no model');
  await settled(page);
  await screens(page, 'rebuild-built');
});
