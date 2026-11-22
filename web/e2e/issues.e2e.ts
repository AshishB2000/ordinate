// E2E: the data issues board (docs/issues-board/00-design.md), on the real server with Postgres, header sign-in and a STUB model provider on
// loopback (./evalsStub.ts). An admin:
//   - sees the notice under the Assistant's composer: editors may see questions that didn't get a good answer;
//   - finds the Issues section off (the weekly check is off by default), switches it on and presses Check now;
//   - the board shows one issue: the model's title and fix, 4 questions from 4 people, the questions as words and no answer, no asker;
//   - proposes a definition (#7), resolves the issue, reopens it;
//   - opens Admin → Integrations: Linear and Jira are not connected, and nothing was sent anywhere.
// Conversations are seeded straight into Postgres (the Assistant's own path is covered by its own specs): four people each asked about an
// "active customer" that is not defined, and an answer text holds a planted figure that must never reach the board.
// Screens: web/e2e/__screens__/issues-{board,integrations}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { calls, stubUrl } from './evalsStub.ts';

const ADMIN = 'boss@acme.test';
const dbUrl = process.env.DATABASE_URL;
const FIGURE = '8675309';

if (!dbUrl) {
  void test('issues e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_issues_${process.pid}_${Date.now()}`;
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
      ORDINATE_PUBLIC_URL: 'https://ordinate.acme.test',
      SSRF_ALLOW: '127.0.0.1/32', // the stub provider is on loopback
    },
    headers: { 'x-forwarded-email': ADMIN },
  });

  e2e('issues: the notice, the check off by default, Check now, the board, a proposal, resolve and reopen, and Admin → Integrations', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
      return r.json();
    };
    const pid: string = (await rpc('projects:create', { name: 'Ledger' })).id;
    const sales = await rpc('dataset:composeSave', {
      projectId: pid, name: 'Sales', joins: [], steps: [], sourceKind: 'paste',
      base: { inline: { name: 'Sales', columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], rows: [['West', 1200], ['East', 800], ['North', 500]] } },
    });
    assert.equal(sales.ok, true, JSON.stringify(sales).slice(0, 300));
    const datasetId: string = (await rpc('dataset:list', { projectId: pid }))[0].id;
    assert.equal((await rpc('ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    assert.equal((await rpc('ai:setModels', { models: [{ provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' }], defaultIndex: 0 })).ok, true);

    // ── Four people asked about an "active customer" nobody defined: stored answers, read straight into Postgres ─────────────
    const db = new pg.Client({ connectionString: scratch.toString() });
    await db.connect();
    const org: string = (await db.query('SELECT org_id FROM users LIMIT 1')).rows[0].org_id;
    const option = { label: 'Sales', spec: { datasetId, category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }] } };
    for (const [i, who] of ['ann', 'bob', 'cy', 'dee'].entries()) {
      const thread = randomUUID();
      const at = new Date(Date.now() - 2 * 86_400_000 + i * 60_000);
      await db.query(`INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at) VALUES ($1, $2, $3, $4, 'T', $5, $5)`, [org, pid, thread, `${who}@acme.test`, at]);
      await db.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body) VALUES ($1, $2, $3, $4, 0, 'user', $5, $6, '{}')`, [org, pid, thread, randomUUID(), `How many active customers did ${who} bring in?`, at]);
      await db.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body) VALUES ($1, $2, $3, $4, 1, 'assistant', $5, $6, $7)`,
        [org, pid, thread, randomUUID(), `I could not chart that. ${FIGURE}`, new Date(at.getTime() + 1000), JSON.stringify({ define: true, factsFrom: [datasetId], suggest: { part: 'filter', said: 'active customer', options: [option] } })]);
    }
    await db.end();

    // ── The notice under the composer ───────────────────────────────────────────────────────────────────────────────────────
    await page.goto(`/visuals/${pid}`);
    await settled(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.getByTestId('issues-notice').waitFor();
    assert.equal(await page.getByTestId('issues-notice').innerText(), 'Editors may see questions that didn’t get a good answer.');

    // ── Off by default; on; Check now ───────────────────────────────────────────────────────────────────────────────────────
    await page.goto(`/model/${pid}?tab=assistant`);
    const section = page.getByRole('region', { name: 'Issues' });
    await section.scrollIntoViewIfNeeded(); // the board loads when it comes near the viewport
    await section.getByText('No issues yet').waitFor();
    await section.getByText(/Off\. Turn it on/).waitFor();
    assert.equal(calls.name, 0, 'no model call before the check is on');
    await section.getByRole('switch', { name: 'Check every week' }).click();
    await section.getByRole('button', { name: 'Check now' }).click(); // it appears once the server says the check is on
    const card = section.getByTestId('issue');
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole('heading', { name: 'Active customer is not defined' }).waitFor();
    await card.getByText('4 questions · 4 people affected').waitFor();
    await card.getByText(/Define it as a business term/).waitFor();
    assert.equal(calls.name, 1, 'one model call for the one new group');
    const examples = card.getByRole('list', { name: 'Example questions' });
    assert.equal(await examples.getByRole('listitem').count(), 4);
    const shown = await section.innerText();
    assert.ok(!shown.includes(FIGURE), 'the board never shows a figure from an answer');
    assert.ok(!/@acme\.test/.test(shown), 'and never who asked');
    const board = JSON.stringify(await rpc('issues:list', { projectId: pid }));
    assert.ok(!board.includes(FIGURE) && !/@acme\.test|owner/.test(board), 'nor does the reply');
    await settled(page);
    await screensInPlace(page, 'issues-board');

    // ── Propose a definition (#7), resolve, reopen (a fresh page load: the RPC budget counts a load) ───────────────────────────────────────────────────────────────────────────
    await page.goto(`/model/${pid}?tab=assistant`);
    await page.getByRole('region', { name: 'Issues' }).scrollIntoViewIfNeeded();
    const again = page.getByRole('region', { name: 'Issues' }).getByTestId('issue');
    await again.waitFor();
    await again.getByRole('button', { name: 'Propose a definition' }).click();
    await again.getByRole('link', { name: 'See the proposal' }).waitFor();
    assert.equal(calls.propose, 1);
    const proposals = (await rpc('proposal:list', { projectId: pid, decided: false })).proposals;
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].asks, 4);
    await again.getByRole('button', { name: 'Resolve' }).click();
    await again.getByText('Resolved', { exact: true }).waitFor();
    await again.getByRole('button', { name: 'Reopen' }).click();
    await again.getByRole('button', { name: 'Resolve' }).waitFor();

    // ── Admin → Integrations: nothing connected, nothing sent ─────────────────────────────────────────────────────────────────
    await page.goto('/admin?tab=integrations');
    const linear = page.getByTestId('integration-linear');
    await linear.getByText('Not connected').waitFor();
    await page.getByTestId('integration-jira').getByLabel('Jira site').waitFor();
    await settled(page);
    await screensInPlace(page, 'issues-integrations');
  });
}
