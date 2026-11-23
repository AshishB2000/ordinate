// E2E: Assistant agents (docs/assistant-agents/00-design.md), the whole path, on the real server with Postgres, header
// sign-in and a STUB model provider on loopback (./agentsStub.ts: an Anthropic Messages API look-alike in this process —
// no real network call is made).
//
//   - The org admin opens Assistant → Agents & setup: the Agents section is the Project assistant alone, with the way in.
//     They create a Finance agent there, in the UI — a topic, a team, answers only — and give it an instruction.
//   - Fay, in the Finance team and a project viewer, opens the Assistant: the Finance assistant is preselected and its
//     topic is what answers are based on. She asks about revenue, which is outside it: the app's card names Orders,
//     and one click asks the Project assistant in a new conversation, which charts it. The stub saw the agent's
//     answer-only, topic-only prompt first and the Project assistant's after. Switching back is a new conversation, and
//     the conversations column names each one's assistant. On the agent's page she sees no admin control.
//   - Vic, a viewer outside the team, has no picker at all.
//   - The admin deletes the agent: it is in the Trash.
//
// Screens: web/e2e/__screens__/agents-{empty,new,page,list,composer,outside,history,viewer,home,dock,trash}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Page } from 'playwright';
import { asks, CHART_SAID, REVENUE_Q, stubUrl } from './agentsStub.ts';

const ADMIN = 'boss@acme.test';
const FAY = 'fay@acme.test';
const VIC = 'vic@acme.test';
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  void test('agents e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_agents_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, settled, screensInPlace, configureServer, failOnConsoleError, rpcBudget } = await import('./fixtures.ts');
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

  e2e('agents: an admin makes a Finance agent; a team member has it preselected, is offered the Project assistant, switches; a viewer sees no controls; delete goes to the Trash', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${await r.text()}`);
      return r.json();
    };
    // ── Set up over RPC: a project with two datasets and a topic, a model, a team ──
    const pid: string = (await rpc(ADMIN, 'projects:create', { name: 'Ledger' })).id;
    const inline = (name: string, columns: { name: string; type: string }[], rows: unknown[][]) =>
      rpc(ADMIN, 'dataset:composeSave', { projectId: pid, name, base: { inline: { name, columns, rows } }, joins: [], steps: [], sourceKind: 'paste' });
    const payroll = await inline('Payroll', [{ name: 'team', type: 'text' }, { name: 'cost', type: 'number' }], [['Ops', 120], ['Sales', 80]]);
    const orders = await inline('Orders', [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], [['East', 120], ['West', 80], ['North', 45]]);
    assert.equal(payroll.ok && orders.ok, true, JSON.stringify([payroll, orders]).slice(0, 300));
    const topic = await rpc(ADMIN, 'topic:save', { projectId: pid, topic: { name: 'Finance', datasets: [{ id: payroll.dataset.id }], metricIds: [], termIds: [] } });
    assert.equal(topic.ok, true, JSON.stringify(topic));
    assert.equal((await rpc(ADMIN, 'ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    assert.equal((await rpc(ADMIN, 'ai:setModels', { models: [{ provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' }], defaultIndex: 0 })).ok, true);
    await rpc(FAY, 'projects:list');
    await rpc(VIC, 'projects:list');
    const team: string = (await rpc(ADMIN, 'admin:createTeam', { name: 'Finance' })).id;
    const users = (await rpc(ADMIN, 'admin:users')) as { id: string; email: string }[];
    await rpc(ADMIN, 'admin:teamMember', { teamId: team, userId: users.find((u) => u.email === FAY)!.id, member: true });
    for (const who of [FAY, VIC]) assert.equal((await rpc(ADMIN, 'project:share', { projectId: pid, member: { userId: users.find((u) => u.email === who)!.id }, role: 'viewer' })).ok, true);

    // ── The admin: the Agents section, then a new agent, in the UI ─────────
    await page.goto(`/assistant/setup/${pid}`);
    const agents = page.getByRole('region', { name: 'Agents' });
    const empty = agents.getByTestId('agents-empty');
    await empty.waitFor();
    assert.deepEqual(await agents.getByTestId('agent-row').allTextContents(), ['Project assistantEvery question, from all the data each person can readEveryoneAll dataDefault']);
    await settled(page);
    await screensInPlace(page, 'agents-empty');
    await empty.getByRole('button', { name: 'New agent' }).click();
    const form = page.getByTestId('agent-page');
    await form.getByRole('textbox', { name: 'Name' }).fill('Finance assistant');
    await form.getByRole('textbox', { name: 'Description' }).fill('Invoices, costs and payroll');
    await form.getByRole('combobox', { name: 'Topic' }).click();
    await page.getByRole('option', { name: 'Finance', exact: true }).click();
    await form.getByRole('combobox', { name: 'Add team' }).click();
    await page.getByRole('option', { name: 'Finance', exact: true }).click();
    await form.getByText('Finance', { exact: true }).first().waitFor();
    assert.equal(await form.getByRole('checkbox', { name: /Build charts and dashboards/ }).isChecked(), false, 'a new agent answers only until it is allowed to build');
    await screensInPlace(page, 'agents-new');
    await form.getByRole('button', { name: 'Create agent' }).click();
    await page.waitForURL(/agent=[0-9a-f-]{36}/);
    const agentId = new URL(page.url()).searchParams.get('agent') ?? '';
    const instructions = form.getByRole('region', { name: 'Instructions' });
    await instructions.getByRole('button', { name: 'Instruction' }).click();
    const box = instructions.getByRole('textbox', { name: 'New instruction' });
    await box.fill('Revenue means recognized revenue');
    await box.press('Enter');
    await instructions.getByText('Revenue means recognized revenue').waitFor();
    await form.getByRole('heading', { level: 2, name: 'Finance assistant' }).waitFor();
    await screensInPlace(page, 'agents-page');
    await form.getByRole('button', { name: 'All assistants' }).click();
    const row = agents.getByRole('button', { name: 'Open Finance assistant' });
    await row.waitFor();
    assert.match((await row.textContent()) ?? '', /Finance assistant.*Invoices, costs and payroll.*Finance.*Finance topic.*Answers only/);
    await screensInPlace(page, 'agents-list');

    // ── Fay: preselected, out of scope, the Project assistant, switching ───
    const fayCtx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': FAY } });
    const fay = await fayCtx.newPage();
    const fayProblems = await failOnConsoleError(fay);
    const fayRpc = rpcBudget(fay);
    try {
      await fay.goto('/assistant');
      const wide = fay.getByRole('region', { name: 'Assistant' });
      const picker = wide.getByRole('combobox', { name: 'Assistant' });
      await fay.waitForFunction(() => document.querySelector('[data-testid="agent-picker"] [role="combobox"]')?.textContent === 'Finance assistant');
      assert.equal(await wide.getByTestId('dock-context').textContent(), '@ Finance', 'answers are based on the agent\'s topic');
      await fay.waitForFunction(() => !(document.querySelector('textarea[aria-label="Ask the Assistant"]') as HTMLTextAreaElement | null)?.disabled);
      console.log(`rpc  ${String(fayRpc.loads.at(-1)?.rpcs).padStart(2)}  /assistant, a team member with an agent`);
      await screensInPlace(fay, 'agents-composer');
      const ask = wide.getByRole('textbox', { name: 'Ask the Assistant' });
      await ask.fill(REVENUE_Q);
      await ask.press('Enter');
      const card = wide.getByTestId('agent-outside');
      await card.getByText('This isn’t in the Finance data.').waitFor();
      await card.getByText('The Project assistant can answer it from “Orders”.').waitFor();
      assert.equal(await card.getByText('Finance assistant', { exact: true }).count(), 1, 'the card is signed by the agent');
      const first = asks.at(-1)!;
      assert.ok(first.system.includes('answers from its topic alone') && !first.system.includes('\\"plan\\"'), 'the agent was asked with its answer-only, topic-only prompt');
      assert.ok(first.asked.includes('Payroll') && !first.asked.includes('Orders') && first.asked.includes('Revenue means recognized revenue'), 'its facts were its topic\'s, with its instruction');
      await screensInPlace(fay, 'agents-outside');
      const firstThread = new URL(fay.url()).searchParams.get('thread');
      await card.getByRole('button', { name: 'Ask the Project assistant' }).click();
      await wide.getByTestId('answer-card').locator('canvas').waitFor();
      await wide.getByText(CHART_SAID).waitFor();
      assert.equal(await picker.textContent(), 'Project assistant');
      const second = asks.at(-1)!;
      assert.ok(!second.system.includes('answers from its topic alone') && second.asked.includes('Orders'), 'the Project assistant was asked with all the data');
      await fay.waitForFunction((t) => new URL(location.href).searchParams.get('thread') !== t, firstThread);
      const paThread = new URL(fay.url()).searchParams.get('thread');
      // Switching back starts a new conversation with the Finance assistant.
      await picker.click();
      await fay.getByRole('option', { name: /^Finance assistant/ }).click();
      await fay.waitForFunction((t) => new URL(location.href).searchParams.get('thread') !== t, paThread);
      assert.equal(await picker.textContent(), 'Finance assistant');
      await ask.fill('What was payroll cost by team?');
      await ask.press('Enter');
      await wide.getByText('Payroll is in the Payroll data.').waitFor();
      // The conversations column names each one's assistant.
      const list = fay.getByRole('complementary', { name: 'Conversations' });
      await list.getByRole('button', { name: /payroll cost/ }).waitFor();
      const tags = await list.getByTestId('history-agent').allTextContents();
      assert.deepEqual(tags, ['Finance assistant', 'Project assistant', 'Finance assistant'], JSON.stringify(tags));
      await screensInPlace(fay, 'agents-history');

      // On the agent's page she reads; she changes nothing.
      await fay.goto(`/assistant/setup/${pid}?agent=${agentId}`);
      const view = fay.getByTestId('agent-page');
      await view.getByRole('heading', { level: 2, name: 'Finance assistant' }).waitFor();
      await settled(fay);
      for (const name of ['Delete', 'Save', 'Instruction']) assert.equal(await view.getByRole('button', { name, exact: true }).count(), 0, `no ${name} for a viewer`);
      assert.equal(await view.getByRole('textbox').count(), 0, 'no field to type in');
      assert.equal(await view.getByRole('checkbox', { name: /Build charts and dashboards/ }).isDisabled(), true);
      await screensInPlace(fay, 'agents-viewer');

      // Home's ask bar has the picker too, preselected; the dock's History names each conversation's assistant.
      await fay.goto('/');
      const bar = fay.getByRole('form', { name: 'Ask the Assistant' });
      await fay.waitForFunction(() => document.querySelector('form[aria-label="Ask the Assistant"] [data-testid="agent-picker"] [role="combobox"]')?.textContent === 'Finance assistant');
      await settled(fay);
      console.log(`rpc  ${String(fayRpc.loads.at(-1)?.rpcs).padStart(2)}  Home, a team member with an agent`);
      assert.equal(await bar.getByTestId('agent-picker').count(), 1);
      await screensInPlace(fay, 'agents-home');
      await fay.getByRole('button', { name: 'Assistant', exact: true }).click();
      const dock = fay.getByRole('complementary', { name: 'Assistant' });
      await dock.getByTestId('agent-picker').waitFor();
      await dock.getByRole('button', { name: 'Conversation history' }).click();
      const pop = fay.getByRole('dialog', { name: 'Conversation history' });
      await pop.getByTestId('history-row').first().waitFor();
      assert.deepEqual(await pop.getByTestId('history-agent').allTextContents(), ['Finance assistant', 'Project assistant', 'Finance assistant']);
      await screensInPlace(fay, 'agents-dock');
      assert.deepEqual([...fayProblems(), ...fayRpc.problems()], []);
    } finally {
      await fayCtx.close();
    }

    // ── Vic: no agent of his, so no picker ──────────────────────────────────
    const vicCtx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': VIC } });
    const vic: Page = await vicCtx.newPage();
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

    // ── The admin deletes it: the Trash ─────────────────────────────────────
    await page.goto(`/assistant/setup/${pid}?agent=${agentId}`);
    await form.getByRole('heading', { level: 2, name: 'Finance assistant' }).waitFor();
    await form.getByRole('button', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete “Finance assistant”?' });
    await confirm.getByText(/Its conversations stay readable/).waitFor();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await agents.getByTestId('agents-empty').waitFor();
    await page.goto(`/trash?project=${pid}`);
    await page.getByText('Finance assistant').first().waitFor();
    await page.getByText('Assistant agent').first().waitFor();
    await settled(page);
    await screensInPlace(page, 'agents-trash');
  });
}
