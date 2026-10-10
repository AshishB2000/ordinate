// E2E (T2.12): the Assistant dock against the real server and a STUB model
// provider on loopback (an Anthropic Messages API look-alike in this process —
// no real network call is made).
//
// Without DATABASE_URL: the dock opens from the top bar onto its designed
// not-set-up state — "AI isn't set up", and for this admin the operator line
// (no database, so no key can be stored) instead of a key field. Screens in
// both themes.
//
// With DATABASE_URL (its own scratch database, header sign-in as the org
// admin, a master key): AI is set up the way Admin → AI does it (ai:connect,
// ai:setModels — the tab's own walk is admin.e2e.ts), then the dock's model
// picker offers both models and saves the pick, "Powered by" names it, the
// stub is asked with it, and the answer STREAMS into the pending bubble token
// by token over this tab's event stream; then a plan whose import step is fed
// by an upload (T0.4 — the server has no file picker) runs to the
// app-computed KPI. Zero console errors throughout; screens in both themes.

import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { after } from 'node:test';
import pg from 'pg';
import type { Page } from 'playwright';

const ADMIN = 'boss@acme.test';
const ANSWER = ['This project ', 'has no ', 'datasets yet — ', 'import a file ', 'to start.'];
const PLAN = {
  kind: 'plan',
  intent: 'Import the sales file and track total revenue',
  steps: [
    { kind: 'import', file: 'sales.csv', name: 'Sales' },
    { kind: 'metric', dataset: 'Sales', name: 'Total revenue', column: 'revenue', aggregation: 'sum' },
  ],
};

/** The models the stub asked with, in order. */
const askedModels: string[] = [];

/** The provider stub: lists two models, a connectivity test gets "OK", a streamed ask gets ANSWER (or a plan when asked for one). */
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-stub', display_name: 'Claude Sonnet Stub', created_at: 2 }, { id: 'claude-haiku-stub', display_name: 'Claude Haiku Stub', created_at: 1 }] }));
      return;
    }
    const json = JSON.parse(body || '{}') as { stream?: boolean; model?: string; messages?: { content: unknown }[] };
    askedModels.push(String(json.model));
    if (!json.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
      return;
    }
    const asked = JSON.stringify(json.messages?.at(-1)?.content ?? '');
    const parts = asked.includes('a plan') ? ['Here is a plan you can run step by step.', `\n@@ACTION ${JSON.stringify(PLAN)}`] : ANSWER;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = setInterval(() => {
      if (i < parts.length) {
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: parts[i++] } })}\n\n`);
        return;
      }
      clearInterval(tick);
      res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
    }, 150);
  });
});
await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
after(() => stub.close());

async function openDock(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask the Assistant' }).waitFor();
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  const { e2e, screens, settled } = await import('./fixtures.ts');
  e2e('dock: opens from the top bar onto the not-set-up state (no database → no key field)', async ({ page }) => {
    await page.goto('/');
    await settled(page);
    await openDock(page);
    const setup = page.getByTestId('dock-setup');
    await setup.getByText(/AI isn’t set up for your organization yet/).waitFor();
    await setup.getByText(/no database, so it cannot store API keys/).waitFor();
    assert.equal(await page.getByLabel('API key').count(), 0, 'no key field in the dock, ever');
    assert.equal(await setup.getByRole('link', { name: /Set up AI/ }).count(), 0, 'no Set up button where nothing can be set up');
    assert.equal(await page.getByRole('textbox', { name: 'Ask the Assistant' }).isDisabled(), true);
    await screens(page, 'dock-setup');
    // The left edge is a handle the pointer can find: it runs the panel's height
    // (it was 0 x 0 once), drags the panel wider, and a double-click restores the default.
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    const edge = await dock.getByRole('separator', { name: 'Resize the Assistant panel' }).boundingBox();
    const start = await dock.boundingBox();
    assert.ok(edge && start && edge.height === start.height, `the resize handle spans the panel (${JSON.stringify(edge)})`);
    const y = edge.y + edge.height / 2;
    await page.mouse.move(edge.x, y);
    await page.mouse.down();
    await page.mouse.move(edge.x - 60, y, { steps: 4 });
    await page.mouse.up();
    assert.equal(Math.round((await dock.boundingBox())?.width ?? 0), Math.round(start.width) + 60, 'dragging the edge left widens the panel by the drag');
    await page.mouse.dblclick(edge.x - 60, y);
    assert.equal(Math.round((await dock.boundingBox())?.width ?? 0), 340, 'a double-click restores the default width');
    // Escape closes it and hands focus back to the toggle.
    await page.keyboard.press('Escape');
    await page.getByRole('complementary', { name: 'Assistant' }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'dock-toggle');
  });
} else {
  const dbName = `ordinate_e2e_dock_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, screens, settled, configureServer, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      // The stub provider is on loopback, which the SSRF guard refuses unless allowlisted (T6.1).
      SSRF_ALLOW: '127.0.0.1/32',
    },
    headers: { 'x-forwarded-email': ADMIN },
  });

  e2e('dock: pick a model, stream an answer into the dock, run a plan fed by an upload', async ({ page, server }) => {
    // Records live in Postgres here: make the project over RPC.
    // Any GET hands the context its CSRF cookie (T6.2); the POST repeats it, as the app does.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const made = await page.request.post(`${server.base}/api/rpc/projects:create`, { headers: { 'x-csrf-token': csrf }, data: { args: [{ name: 'Ledger' }] } });
    assert.equal(made.status(), 200);

    // ── Set up, as Admin → AI does: connect the stub, enable two models ──────
    const rpc = async (channel: string, input: unknown) => {
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: [input] } });
      return (await r.json()) as { ok: boolean };
    };
    assert.equal((await rpc('ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    const models = [
      { provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' },
      { provider: 'anthropic', model: 'claude-haiku-stub', label: 'Claude Haiku Stub' },
    ];
    assert.equal((await rpc('ai:setModels', { models, defaultIndex: 0 })).ok, true);

    // ── The picker: both models, the default marked; the pick is saved ──────
    await page.goto('/');
    await settled(page);
    await openDock(page);
    const box = page.getByRole('textbox', { name: 'Ask the Assistant' });
    await page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Ask the Assistant"]') as HTMLTextAreaElement | null)?.disabled);
    assert.equal(await page.getByLabel('API key').count(), 0, 'no key field in the dock, ever');
    await page.getByText('Powered by Claude Sonnet Stub').waitFor();
    await page.getByRole('combobox', { name: 'Model' }).click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Claude Sonnet Stub · Default', 'Claude Haiku Stub']);
    await page.getByRole('option', { name: 'Claude Haiku Stub' }).click();
    await page.getByText('Powered by Claude Haiku Stub').waitFor();
    await screens(page, 'dock-picker');

    // ── Ask: the answer streams in, then is the stored turn ──────────────────
    await page.reload();
    await settled(page);
    await box.waitFor();
    await box.fill('What is in this project?');
    await box.press('Enter');
    const partial = await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="dock-pending"]');
      return el && el.className.includes('streaming') ? el.textContent : null;
    });
    const seen = String(await partial.jsonValue());
    assert.ok(seen.length > 0 && seen.length < ANSWER.join('').length, `a PARTIAL answer was on screen while streaming (${JSON.stringify(seen)})`);
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    await dock.getByText(ANSWER.join(''), { exact: true }).waitFor();
    assert.equal(askedModels.at(-1), 'claude-haiku-stub', 'the question went to the member\'s pick, which survived the reload');
    await dock.getByText(/stats app-computed$/).first().waitFor();
    await page.getByRole('button', { name: /Scanned the project/ }).waitFor(); // the app's work, collapsed above the answer
    await screens(page, 'dock-answer');

    // ── A plan: its import step reads an upload ─────────────────────────────
    await box.fill('Make a plan for my sales file');
    await box.press('Enter');
    const card = page.getByTestId('plan-card');
    await card.getByText('Plan — 2 steps').waitFor();
    await card.getByRole('button', { name: 'Run all' }).click();
    await card.getByText('Choose the file for step 1.').waitFor();
    await page.setInputFiles('input[aria-label="File to import"]', {
      name: 'sales.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('region,revenue\nWest,1200\nEast,800\nNorth,500\n'),
    });
    await card.getByRole('link', { name: 'Sales' }).waitFor();
    // The KPI is the app's: sum of revenue = 2,500, formatted by the server.
    await card.getByText('Total revenue', { exact: true }).first().waitFor();
    const kpi = (await card.getByText('Total revenue', { exact: true }).first().locator('xpath=..').textContent()) ?? '';
    assert.match(kpi, /^Total revenue2[,.]?500$|^Total revenue2\.5K$/, `the KPI chip carries the app's sum (${kpi})`);
    await card.getByRole('button', { name: 'Undo run' }).waitFor();
    // A plan card is never persisted (a reload drops it, as on the desktop), so
    // these two screens switch the theme in place instead of reloading.
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SCREENS, `dock-plan-${theme}.png`), fullPage: true });
    }
  });
}
