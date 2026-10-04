// Captures as a SOURCE (T2.4) against the real server and a stdlib stand-in
// for an OpenAI-compatible provider (the org's "gateway"):
//
//   upload a screenshot → the model reads it ON THE SERVER (the request is
//   asserted to carry the image) → the step list while it reads → the
//   composer with editable cells, the model's caution said once → a mis-read
//   cell corrected → saved as a 'capture' dataset → the Captures tab shows the
//   card with its thumbnail and the Dataset badge, reopens its table, deletes
//   it; and a rejected key shows the typed error card.
//
// The org's config.json is written before the server reads it: the server
// starts with the first session, and no request has reached it yet.
//
//   npm --prefix web run e2e

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after } from 'node:test';
import type { Page } from 'playwright';
import { configureServer, e2e, SCREENS, screens, settled } from './fixtures.ts';

const REPLY = {
  title: 'Regional sales',
  analysis: 'Sales by region.',
  extractedTable: {
    columns: [
      { id: 'region', label: 'Region', role: 'dimension', type: 'text' },
      { id: 'sales', label: 'Sales', role: 'measure', type: 'number' },
    ],
    rows: [{ region: 'North', sales: 120 }, { region: 'South', sales: 95 }, { region: 'East', sales: 80 }],
  },
  extractionConfidence: 'medium',
};
const model = { calls: 0, last: '', delay: 0, status: 200 };
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += String(c)));
  req.on('end', () => {
    model.calls++;
    model.last = body;
    setTimeout(() => {
      res.statusCode = model.status;
      res.setHeader('content-type', 'application/json');
      res.end(model.status === 200
        ? JSON.stringify({ choices: [{ message: { content: JSON.stringify(REPLY) }, finish_reason: 'stop' }] })
        : JSON.stringify({ error: { message: 'invalid api key' } }));
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

/** A real, decodable screenshot: a little table drawn on a canvas in the page. */
async function screenshotPng(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 200;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 480, 200);
    g.fillStyle = '#111';
    g.font = '20px sans-serif';
    [['Region', 'Sales'], ['North', '120'], ['South', '95'], ['East', '80']].forEach(([a, b], i) => {
      g.fillText(a!, 24, 40 + i * 40);
      g.fillText(b!, 240, 40 + i * 40);
    });
    return c.toDataURL('image/png');
  });
  return Buffer.from(url.split(',')[1]!, 'base64');
}

async function screensInPlace(page: Page, name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

e2e('capture: upload → read on the server → correct a cell → save → Captures tab', async ({ page, server, rpc }) => {
  connectModel(server.dataDir);
  const pid = server.sample.projectId;
  await page.goto(`/data/import?project=${pid}&source=screenshot`);
  await settled(page);
  await page.getByRole('heading', { name: 'Drop a screenshot, or paste one' }).waitFor();
  await screens(page, 'capture-source');

  model.delay = 1500;
  await page.getByRole('region', { name: 'Upload or paste a screenshot' }).locator('input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: await screenshotPng(page) });
  await page.getByRole('status', { name: 'The model is reading the screenshot' }).waitFor();
  await screensInPlace(page, 'capture-reading');
  model.delay = 0;

  await page.getByRole('heading', { level: 1, name: 'New dataset' }).waitFor();
  assert.equal(model.calls, 1);
  assert.ok(model.last.includes('data:image/png;base64,iVBORw0KGgo'), 'the server sent the model the image');
  assert.equal(await page.getByLabel('Dataset name').inputValue(), 'Regional sales');
  await page.getByText('The model was unsure about some of what it read').waitFor();
  const g = page.getByRole('grid', { name: 'Preview' });
  await g.getByText('South').waitFor();
  assert.equal(await g.getAttribute('aria-readonly'), null, 'a capture\'s preview is editable');

  // The model misread South: 95 → 59.
  await g.locator('[data-row="1"][data-col="1"]').dblclick();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('59');
  await page.keyboard.press('Enter');
  await g.locator('[data-row="1"][data-col="1"]').getByText('59').waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await screensInPlace(page, 'capture-composer');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Regional sales' }).waitFor();
  await page.getByText('3 rows · 2 columns').waitFor();
  await page.getByRole('grid').getByText('59').waitFor();

  // The Captures tab: the card, its thumbnail, the Dataset badge.
  await page.goto(`/data/captures?project=${pid}`);
  await settled(page);
  const card = page.getByRole('listitem').filter({ hasText: 'Regional sales' });
  await card.getByText('Dataset', { exact: true }).waitFor();
  assert.match((await card.locator('img').getAttribute('src')) ?? '', /^data:image\/jpeg;base64,/);
  await screens(page, 'capture-list');

  // "Save as dataset" reopens the stored capture's table — no second model call.
  await card.getByRole('link', { name: 'Save as dataset' }).click();
  await page.getByRole('heading', { level: 1, name: 'New dataset' }).waitFor();
  await page.getByRole('grid', { name: 'Preview' }).getByText('95').waitFor();
  assert.equal(model.calls, 1);

  // Delete it.
  await page.goto(`/data/captures?project=${pid}`);
  await settled(page);
  await page.getByRole('button', { name: 'Delete Regional sales' }).click();
  await page.getByRole('dialog', { name: 'Delete this capture?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('heading', { name: 'No captures yet' }).waitFor();
  for (const l of rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}${new URL(l.url).search}`);
});

e2e('capture: a rejected key shows the typed error card', async ({ page, server }) => {
  connectModel(server.dataDir);
  model.status = 401;
  await page.goto(`/data/import?project=${server.sample.projectId}&source=screenshot`);
  await settled(page);
  await page.getByRole('region', { name: 'Upload or paste a screenshot' }).locator('input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: await screenshotPng(page) });
  const card = page.getByRole('alert').filter({ hasText: 'The API key was rejected' });
  await card.waitFor();
  assert.equal(await card.getByRole('link', { name: 'Open Settings' }).getAttribute('href'), '/settings');
  await screensInPlace(page, 'capture-error');
  model.status = 200;
  await card.getByRole('button', { name: 'Try another screenshot' }).click();
  await page.getByRole('heading', { name: 'Drop a screenshot, or paste one' }).waitFor();
});
