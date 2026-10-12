// Captures (T2.4) against the real server and a stdlib stand-in for an
// OpenAI-compatible provider (the org's "gateway"):
//
//   as a SOURCE — upload a screenshot on Bring data in → the model reads it ON
//   THE SERVER (the request is asserted to carry the image) → the step list
//   while it reads → the composer with editable cells, the model's caution
//   said once → a mis-read cell corrected → saved as a 'capture' dataset → the
//   Captures tab shows the card with its thumbnail and the Dataset badge, opens
//   its page, deletes it; and a rejected key shows the typed error card;
//
//   on the Captures tab — upload in place → the capture's own page: the
//   screenshot beside the analysis, the app's figures, the chart and the table
//   → "Build an analysis" → the composer's cell check → the wizard on the
//   saved dataset.
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
  dataShape: 'categorical',
  columnRoles: { category: 'region', primaryValue: 'sales' },
  suggestedCalculations: ['rank_by_value', 'pct_of_total'],
  headline: { focus: ['rank_by_value'], angle: 'One region leads.' },
  visualizations: [{ type: 'bar' }, { type: 'pie' }, { type: 'table' }],
  followups: ['Which region leads?', 'How far behind is East?'],
};
const model ={ calls: 0, last: '', delay: 0, status: 200 };
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

  // A capture that became a dataset links to it; the card itself opens the capture's page.
  assert.match((await card.getByRole('link', { name: 'Open dataset' }).getAttribute('href')) ?? '', new RegExp(`^/data/${pid}/[0-9a-f-]{36}$`));
  await card.getByRole('link', { name: /Regional sales/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Regional sales' }).waitFor();
  // Already a dataset: "Build an analysis" needs no second cell check — the wizard opens on it.
  assert.match((await page.getByRole('link', { name: 'Build an analysis' }).getAttribute('href')) ?? '', new RegExp(`^/analyses\\?project=${pid}&new=1&dataset=[0-9a-f-]{36}$`));
  assert.equal(model.calls, 1, 'opening a stored capture asks no model');

  // Delete it: with none left, the way to make one is the empty state.
  await page.goto(`/data/captures?project=${pid}`);
  await settled(page);
  await page.getByRole('button', { name: 'Delete Regional sales' }).click();
  await page.getByRole('dialog', { name: 'Delete this capture?' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('heading', { name: 'Drop a screenshot, or paste one' }).waitFor();
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
  await screensInPlace(page, 'capture-error');
  model.status = 200;
  await card.getByRole('button', { name: 'Try another screenshot' }).click();
  await page.getByRole('heading', { name: 'Drop a screenshot, or paste one' }).waitFor();
});

e2e('capture: upload on the Captures tab → its page, the analysis beside the screenshot → build an analysis', async ({ page, server, rpc }) => {
  connectModel(server.dataDir);
  const pid = server.sample.projectId;
  const before = model.calls;
  await page.goto(`/data/captures?project=${pid}`);
  await settled(page);
  // No captures: the drop zone is the empty state, on this tab — not a link to Bring data in.
  const zone = page.getByRole('region', { name: 'Upload a screenshot' });
  await zone.getByRole('heading', { name: 'Drop a screenshot, or paste one' }).waitFor();
  await screens(page, 'captures-empty');

  model.delay = 1500;
  await zone.locator('input[type="file"]').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: await screenshotPng(page) });
  await page.getByRole('status', { name: 'The model is reading the screenshot' }).waitFor();
  assert.ok(new URL(page.url()).pathname === '/data/captures', 'the model reads without leaving Captures');
  model.delay = 0;

  // The capture's own page: the screenshot, and what was read out of it.
  await page.getByRole('heading', { level: 1, name: 'Regional sales' }).waitFor();
  assert.match(new URL(page.url()).pathname, new RegExp(`^/data/captures/${pid}/[0-9a-f-]{36}$`));
  assert.equal(model.calls, before + 1);
  const shot = page.getByRole('img', { name: 'Screenshot: Regional sales' });
  await shot.waitFor();
  assert.match((await shot.getAttribute('src')) ?? '', /^data:image\/png;base64,iVBORw0KGgo/);
  const analysis = page.getByRole('region', { name: 'Analysis' });
  await analysis.getByText('Sales by region.').waitFor();
  // The headline's figure is the app's, from the extracted table: North, 120.
  assert.equal(await analysis.locator('strong').first().textContent(), '120');
  await page.getByRole('region', { name: 'Metrics' }).getByText('1. North — 120').waitFor();
  await page.getByRole('region', { name: 'Chart' }).locator('canvas').waitFor();
  const read = page.getByRole('region', { name: 'What the model read' });
  await read.getByRole('cell', { name: '95' }).waitFor();
  await read.getByText('The model was unsure about some of what it read').waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await screens(page, 'capture-page');
  assert.equal(model.calls, before + 1, 'reloading the page asks no model');
  // The lower half: the chart and the table, the screenshot still in view beside them.
  await read.scrollIntoViewIfNeeded();
  await screensInPlace(page, 'capture-page-table');

  // The other suggested chart, and the screenshot at full size.
  await page.getByRole('group', { name: 'Chart type' }).getByRole('button', { name: 'Pie' }).click();
  await page.getByRole('group', { name: 'Chart type' }).locator('button[aria-pressed="true"]', { hasText: 'Pie' }).waitFor();
  await page.getByRole('button', { name: 'Enlarge the screenshot' }).click();
  await page.getByRole('dialog', { name: 'Regional sales' }).getByRole('img').waitFor();
  await page.keyboard.press('Escape');

  // The question: build an analysis → the cell check → saved → the wizard, on that dataset.
  await page.getByRole('heading', { name: 'Want an analysis built from this?' }).waitFor();
  await page.getByRole('link', { name: 'Build an analysis' }).click();
  await page.getByRole('heading', { level: 1, name: 'New dataset' }).waitFor();
  await page.getByRole('grid', { name: 'Preview' }).getByText('South').waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await page.getByRole('button', { name: 'Save and build the analysis' }).click();
  const wizard = page.getByRole('dialog', { name: 'Create dashboard' });
  await wizard.waitFor();
  // "Start from" is the wizard's second step: it opens there only with a dataset of this project picked.
  await wizard.getByText('Start from a template built for your data, a plain layout, or let a model design it.').waitFor();
  assert.equal(new URL(page.url()).pathname, '/analyses');
  assert.equal(model.calls, before + 1, 'the composer and the wizard open without a model call');

  // Back on Captures there is one now: the button opens the same zone in place.
  await page.goto(`/data/captures?project=${pid}`);
  await settled(page);
  await page.getByRole('listitem').filter({ hasText: 'Regional sales' }).getByText('Dataset', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Upload a screenshot' }).click();
  await page.getByRole('region', { name: 'Upload a screenshot' }).getByRole('heading', { name: 'Drop a screenshot, or paste one' }).waitFor();
  await screensInPlace(page, 'captures-upload');
  for (const l of rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}${new URL(l.url).search}`);
});
