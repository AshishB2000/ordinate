// E2E: deep research (docs/deep-research/00-design.md), the whole path on the real server with Postgres, header sign-in and a
// STUB model provider on loopback (./researchStub.ts). An admin (an org admin may start a run, and sets the limits):
//   - the composer has a Deep research switch with its line of help; a question sent with it on starts a run, and the conversation
//     gets a run card that advances in place (the plan, the meter against the limits, the step with its tick) to Finished;
//   - a second run, asked "slowly", is stopped from its card while it runs: Stopped, its steps kept, no report;
//   - the first run's report opens from the card: the model's words around a LIVE chart, the caveats in a callout, "How this was
//     made", and "Only you can see this report"; Add to project makes a story and the page offers Open story, which opens it with
//     the section dated; a second press (a reload) shows the same story;
//   - Admin → AI shows the three limits with their ceilings.
// Screens: web/e2e/__screens__/research-{card-running,card-finished,report,report-added,limits}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { QUICK, SLOW, calls, stubUrl } from './researchStub.ts';

const ADMIN = 'boss@acme.test';
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  void test('research e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_research_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, settled, screensInPlace, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      SSRF_ALLOW: '127.0.0.1/32', // the stub provider is on loopback
    },
    headers: { 'x-forwarded-email': ADMIN },
  });

  e2e('research: start a run, watch the card advance, stop another, open the report, add it to the project, open the story; the limits in Admin', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
      return r.json();
    };
    // ── Set up over RPC: a project with a Sales dataset, and a model ───────────────────────────────────────────────────
    const pid: string = (await rpc('projects:create', { name: 'Ledger' })).id;
    const sales = await rpc('dataset:composeSave', {
      projectId: pid, name: 'Sales', joins: [], steps: [], sourceKind: 'paste',
      base: { inline: { name: 'Sales', columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], rows: [['West', 1200], ['East', 800], ['North', 500]] } },
    });
    assert.equal(sales.ok, true, JSON.stringify(sales).slice(0, 300));
    assert.equal((await rpc('ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    assert.equal((await rpc('ai:setModels', { models: [{ provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' }], defaultIndex: 0 })).ok, true);

    // ── The switch, and a run from the composer ────────────────────────────────────────────────────────────────────────
    await page.goto(`/visuals/${pid}`);
    await settled(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    const box = dock.getByRole('textbox', { name: 'Ask the Assistant' });
    await page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Ask the Assistant"]') as HTMLTextAreaElement | null)?.disabled);
    const toggle = dock.getByRole('button', { name: 'Deep research' });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'off until pressed');
    await toggle.click();
    await dock.getByText('Runs several steps and writes a report. Up to 10 minutes.').waitFor();
    await box.fill(QUICK);
    await box.press('Enter');
    const card = dock.getByTestId('research-card').first();
    await card.waitFor();
    await card.getByText('Why does revenue differ by region?').waitFor();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'a send turns the switch off again');
    await card.getByText('Finished', { exact: true }).waitFor({ timeout: 60_000 });
    const meter = card.getByTestId('research-meter');
    assert.match(await meter.textContent() ?? '', /Steps\d+ of 8Queries1 of 12Time\d+:\d\d of 10:00/, 'the meter reads the server\'s counts against the org\'s limits');
    await card.getByRole('list', { name: 'Steps' }).getByText('Revenue by region').waitFor();
    await card.getByRole('link', { name: 'Open report' }).waitFor();
    await card.getByText('Only you can see this report').waitFor();
    assert.deepEqual({ ...calls }, { plan: 1, step: 2, write: 1 }, 'one plan call, two step calls (a chart, then done) and one write call');
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.cwd()}/e2e/__screens__/research-card-finished-${theme}.png`, fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

    // ── A second run, stopped while it goes ────────────────────────────────────────────────────────────────────────────
    await toggle.click();
    await box.fill(SLOW);
    await box.press('Enter');
    const second = dock.getByTestId('research-card').last();
    await second.getByText('Researching').waitFor({ timeout: 30_000 });
    await second.getByRole('list', { name: 'Steps' }).waitFor();
    await second.getByText('Which region leads?').waitFor();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await second.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.cwd()}/e2e/__screens__/research-card-running-${theme}.png`, fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await second.getByRole('button', { name: 'Stop research' }).click();
    await second.getByText('Stopped', { exact: true }).first().waitFor({ timeout: 30_000 });
    assert.equal(await second.getByRole('link', { name: 'Open report' }).count(), 0, 'a stopped run has no report');
    assert.equal(await second.getByRole('button', { name: 'Resume' }).count(), 0, 'and cannot be resumed');
    assert.equal(await toggle.isDisabled(), false, 'the switch is free again once the run has ended');

    // ── The report: live chart, caveats, how it was made, private ───────────────────────────────────────────────────────
    await card.getByRole('link', { name: 'Open report' }).click();
    await page.getByRole('heading', { level: 1, name: 'Where revenue comes from' }).waitFor();
    const report = page.getByTestId('research-report');
    await report.getByTestId('report-chart').locator('canvas').waitFor();
    await report.getByText(/Total revenue was 2[,.]?500/).waitFor();
    await report.getByTestId('research-caveats').getByText('Revenue is the sample file the project holds, not a ledger.').waitFor();
    await page.getByRole('heading', { name: 'How this was made' }).waitFor();
    await page.getByTestId('research-private').waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open story' }).count(), 0, 'no story before Add to project');
    await settled(page);
    await screensInPlace(page, 'research-report');

    // ── Add to project → the story ─────────────────────────────────────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Add to project' }).click();
    await page.getByRole('link', { name: 'Open story' }).first().waitFor();
    await page.getByText('This report is now a story.').waitFor();
    assert.equal(await page.getByTestId('research-private').count(), 0, 'the private line goes once it is in the project');
    await screensInPlace(page, 'research-report-added');
    await page.reload(); // a second look finds the same story: Add is gone, Open story stays
    await page.getByRole('link', { name: 'Open story' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Add to project' }).count(), 0);
    const href = (await page.getByRole('link', { name: 'Open story' }).first().getAttribute('href')) ?? '';
    assert.match(href, new RegExp(`^/stories/${pid}/[0-9a-f-]{36}$`));
    await page.getByRole('link', { name: 'Open story' }).first().click();
    await page.getByText(/Written on .* from the data then\./).first().waitFor();
    await page.getByText(/Total revenue was 2[,.]?500/).waitFor(); // the data is open to everyone: the prose is kept
    assert.equal((await rpc('story:list', { projectId: pid })).length, 1, 'one story, never a copy');

    // ── Admin → AI: the limits ─────────────────────────────────────────────────────────────────────────────────────────
    await page.goto('/admin?tab=ai');
    const limits = page.getByRole('form', { name: 'Deep research limits' });
    await limits.waitFor();
    assert.equal(await limits.getByLabel('Steps').inputValue(), '8');
    assert.equal(await limits.getByLabel('Engine queries').inputValue(), '12');
    assert.equal(await limits.getByLabel('Minutes').inputValue(), '10');
    await limits.getByText(/Up to 30; the default is 12/).waitFor();
    await settled(page);
    await limits.scrollIntoViewIfNeeded();
    await screensInPlace(page, 'research-limits');
  }, { rpcBudget: 60 }); // two runs, each followed live: every step the server pushes is one read of the run
}
