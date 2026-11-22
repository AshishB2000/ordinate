// E2E: the agent router, "Auto" (docs/agent-router/00-design.md), the whole path, on the real server with Postgres, header
// sign-in and the STUB model provider on loopback (./agentsStub.ts).
//
//   - The org admin (who may use every agent) has two agents: Finance (the Payroll dataset) and Sales (Orders). The
//     Assistant's picker says Auto. A payroll question is answered by the Finance agent: the answer says "Answered by Finance
//     agent" and why (the app's words from what matched), and the stub saw the Finance agent's topic-only facts.
//   - "Change" asks the same question with the Sales agent in a new conversation: the picker follows, Auto is off, and the
//     stub saw Orders.
//   - A question that fits both agents equally shows two agent buttons and asks nothing (the stub's small model call says
//     nothing clear); a click asks it with that agent.
//   - Picking an agent turns Auto off: the next first question is not routed.
//   - Vic, a viewer outside both agents' teams, has no picker.
//
// Screens: web/e2e/__screens__/router-{auto,answer,choose}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { asks, stubUrl } from './agentsStub.ts';

const ADMIN = 'boss@acme.test';
const VIC = 'vic@acme.test';
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  void test('agent router e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_router_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, settled, screensInPlace, configureServer, failOnConsoleError } = await import('./fixtures.ts');
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

  e2e('agent router: Auto picks the agent from the question, says why, Change asks another, a close call asks with buttons, picking turns Auto off', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${await r.text()}`);
      return r.json();
    };
    const pid: string = (await rpc(ADMIN, 'projects:create', { name: 'Ledger' })).id;
    const inline = (name: string, columns: { name: string; type: string }[], rows: unknown[][]) =>
      rpc(ADMIN, 'dataset:composeSave', { projectId: pid, name, base: { inline: { name, columns, rows } }, joins: [], steps: [], sourceKind: 'paste' });
    const payroll = await inline('Payroll', [{ name: 'team', type: 'text' }, { name: 'cost', type: 'number' }], [['Ops', 120], ['Sales', 80]]);
    const orders = await inline('Orders', [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], [['East', 120], ['West', 80]]);
    assert.equal(payroll.ok && orders.ok, true, JSON.stringify([payroll, orders]).slice(0, 300));
    const topic = async (name: string, id: string): Promise<string> => {
      const t = await rpc(ADMIN, 'topic:save', { projectId: pid, topic: { name, datasets: [{ id }], metricIds: [], termIds: [] } });
      assert.equal(t.ok, true, JSON.stringify(t));
      return t.topic.id;
    };
    const agent = async (name: string, description: string, topicId: string): Promise<void> => {
      const a = await rpc(ADMIN, 'agent:save', { projectId: pid, agent: { name, description, topicId, model: null, build: false, teamIds: [] } });
      assert.equal(a.ok, true, JSON.stringify(a));
    };
    await agent('Finance agent', 'Payroll and costs', await topic('Finance', payroll.dataset.id));
    await agent('Sales agent', 'Orders and revenue', await topic('Sales', orders.dataset.id));
    assert.equal((await rpc(ADMIN, 'ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    assert.equal((await rpc(ADMIN, 'ai:setModels', { models: [{ provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' }], defaultIndex: 0 })).ok, true);

    await page.goto('/assistant');
    const wide = page.getByRole('region', { name: 'Assistant' });
    const picker = wide.getByRole('combobox', { name: 'Assistant' });
    await page.waitForFunction(() => document.querySelector('[data-testid="agent-picker"] [role="combobox"]')?.textContent === 'Auto');
    await page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Ask the Assistant"]') as HTMLTextAreaElement | null)?.disabled);
    await screensInPlace(page, 'router-auto');
    const ask = wide.getByRole('textbox', { name: 'Ask the Assistant' });

    // A payroll question: the Finance agent, and why.
    await ask.fill('What was payroll cost by team?');
    await ask.press('Enter');
    await wide.getByText('Payroll is in the Payroll data.').waitFor();
    const line = wide.getByTestId('routed-line');
    await line.getByText('Answered by Finance agent').waitFor();
    assert.match((await line.textContent()) ?? '', /Matched the .*Payroll dataset/);
    assert.equal(await picker.textContent(), 'Finance agent');
    const first = asks.at(-1)!;
    assert.ok(first.system.includes('answers from its topic alone') && first.asked.includes('Payroll') && !first.asked.includes('Orders'), 'the Finance agent was asked with its topic\'s facts');
    await screensInPlace(page, 'router-answer');

    // Change: the same question with the Sales agent, in a new conversation.
    const firstThread = new URL(page.url()).searchParams.get('thread');
    await line.getByRole('button', { name: 'Change' }).click();
    await line.getByRole('button', { name: 'Sales agent' }).click();
    await page.waitForFunction((t) => new URL(location.href).searchParams.get('thread') !== t, firstThread);
    await page.waitForFunction(() => document.querySelector('[data-testid="agent-picker"] [role="combobox"]')?.textContent === 'Sales agent');
    await wide.getByText('Payroll is in the Payroll data.').waitFor();
    assert.ok(asks.at(-1)!.asked.includes('Orders') && !asks.at(-1)!.asked.includes('Payroll'), 'the Sales agent was asked with Orders');
    assert.equal(await wide.getByTestId('routed-line').count(), 0, 'an answer the person asked for is not a routed one');

    // A new conversation is Auto again; a question that fits both agents equally asks which.
    await wide.getByRole('button', { name: 'New conversation' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="agent-picker"] [role="combobox"]')?.textContent === 'Auto');
    const before = asks.length;
    await ask.fill('payroll orders');
    await ask.press('Enter');
    const choose = wide.getByTestId('agent-choices');
    await choose.waitFor();
    assert.deepEqual(await choose.getByRole('button').allTextContents(), ['Finance agent', 'Sales agent', 'Cancel']);
    assert.equal(asks.length, before, 'nothing was asked of the model');
    await screensInPlace(page, 'router-choose');
    await choose.getByRole('button', { name: 'Sales agent' }).click();
    await wide.getByText('Payroll is in the Payroll data.').waitFor();
    assert.equal(await picker.textContent(), 'Sales agent');
    assert.ok(asks.length > before && asks.at(-1)!.asked.includes('Orders'), 'the click asked it with that agent');

    // Picking an agent turns Auto off: the next first question is not routed.
    await wide.getByRole('button', { name: 'New conversation' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="agent-picker"] [role="combobox"]')?.textContent === 'Auto');
    await picker.click();
    await page.getByRole('option', { name: /^Sales agent/ }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="agent-picker"] [role="combobox"]')?.textContent === 'Sales agent');
    await ask.fill('What was payroll cost by team?');
    await ask.press('Enter');
    await wide.getByText('Payroll is in the Payroll data.').last().waitFor();
    assert.equal(await wide.getByTestId('routed-line').count(), 0, 'a picked agent answers, not the router');
    await settled(page);

    // Vic, in no team: no agent of his, no picker.
    await rpc(VIC, 'projects:list');
    const users = (await rpc(ADMIN, 'admin:users')) as { id: string; email: string }[];
    assert.equal((await rpc(ADMIN, 'project:share', { projectId: pid, member: { userId: users.find((u) => u.email === VIC)!.id }, role: 'viewer' })).ok, true);
    const vicCtx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': VIC } });
    const vic = await vicCtx.newPage();
    const vicProblems = await failOnConsoleError(vic);
    try {
      await vic.goto('/assistant');
      await vic.getByRole('textbox', { name: 'Ask the Assistant' }).waitFor();
      await settled(vic);
      assert.equal(await vic.getByTestId('agent-picker').count(), 0, 'nobody without an agent sees a picker');
      assert.deepEqual(vicProblems(), []);
    } finally {
      await vicCtx.close();
    }
  });
}
