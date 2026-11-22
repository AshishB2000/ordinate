// E2E: metric proposals (docs/metric-proposals/00-design.md), the whole path on the real server with Postgres, header sign-in and a
// STUB model provider on loopback (./proposalsStub.ts). A viewer (Viv) and the org admin (Ana):
//   - Viv asks "Gross margin by region last quarter": the Assistant refuses (no such measure) and offers "Propose a definition";
//     a press drafts the metric as structure (one model call, told Sales' columns) and the answer says it is proposed;
//   - Ana opens Data model → Proposals: the card holds the name, the formula, the question's words and a live preview the SERVER
//     computed for her (40.0%, the engine's figure over the rows: no figure came from the model); she approves it;
//   - the metric exists with its history line ("Proposed by the Assistant from 1 question"), Viv's bell says it is defined, and
//     Ask again hands his question back: this time the answer is not refused (the facts now name the metric);
//   - Viv has no Proposals tab and no way to approve.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ASK, DRAFT, calls, seen, stubUrl } from './proposalsStub.ts';

const ANA = 'boss@acme.test';
const VIV = 'viv@acme.test';
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  void test('proposals e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_proposals_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, settled, configureServer, failOnConsoleError } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ANA,
      SSRF_ALLOW: '127.0.0.1/32', // the stub provider is on loopback
    },
    headers: { 'x-forwarded-email': ANA },
  });

  e2e('proposals: a refused question, a draft, an approval, the question answered', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { data: { args: payload === undefined ? [] : [payload] }, headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf } });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${await r.text()}`);
      return r.json();
    };
    // ── Set up over RPC: a project with Sales, a model, and Viv a viewer ─────────────────────────────────────────────────
    const pid: string = (await rpc(ANA, 'projects:create', { name: 'Ledger' })).id;
    const sales = await rpc(ANA, 'dataset:composeSave', {
      projectId: pid, name: 'Sales', joins: [], steps: [], sourceKind: 'paste',
      base: { inline: { name: 'Sales', columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }, { name: 'cost', type: 'number' }], rows: [['West', 1000, 600], ['East', 500, 300], ['North', 500, 300]] } },
    });
    assert.equal(sales.ok, true, JSON.stringify(sales).slice(0, 300));
    assert.equal((await rpc(ANA, 'ai:connect', { provider: 'anthropic', apiKey: 'sk-ant-e2e-' + randomBytes(6).toString('hex'), baseUrl: stubUrl })).ok, true);
    assert.equal((await rpc(ANA, 'ai:setModels', { models: [{ provider: 'anthropic', model: 'claude-sonnet-stub', label: 'Claude Sonnet Stub' }], defaultIndex: 0 })).ok, true);
    await rpc(VIV, 'projects:list');
    const users = (await rpc(ANA, 'admin:users')) as { id: string; email: string }[];
    assert.equal((await rpc(ANA, 'project:share', { projectId: pid, member: { userId: users.find((u) => u.email === VIV)!.id }, role: 'viewer' })).ok, true);

    // ── Viv: a refused question and "Propose a definition" ──────────────────────────────────────────────────────────────
    const vivCtx = await page.context().browser()!.newContext({ baseURL: server.base, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', extraHTTPHeaders: { 'x-forwarded-email': VIV } });
    const viv = await vivCtx.newPage();
    const vivProblems = await failOnConsoleError(viv);
    try {
      await viv.goto(`/visuals/${pid}`);
      await viv.getByRole('button', { name: 'Assistant', exact: true }).click();
      const dock = viv.getByRole('complementary', { name: 'Assistant' });
      const box = dock.getByRole('textbox', { name: 'Ask the Assistant' });
      await viv.waitForFunction(() => !(document.querySelector('textarea[aria-label="Ask the Assistant"]') as HTMLTextAreaElement | null)?.disabled);
      await box.fill(ASK);
      await box.press('Enter');
      const propose = dock.getByTestId('propose-definition');
      await propose.waitFor({ timeout: 30_000 });
      await propose.getByText(/never your figures/).waitFor();
      await propose.getByRole('button', { name: 'Propose a definition' }).click();
      await dock.getByTestId('propose-done').waitFor({ timeout: 30_000 });
      assert.equal(calls.draft, 1, 'one model call drafted it');
      assert.ok(seen.draft.includes(ASK) && seen.draft.includes('revenue (number)') && seen.draft.includes('cost (number)'), 'the model was told the question and the columns');
      assert.equal((await viv.request.post(`${server.base}/api/rpc/proposal:list`, { data: { args: [{ projectId: pid, decided: false }] }, headers: { 'x-csrf-token': csrf } })).status(), 403, 'a viewer cannot read the queue');
      await viv.goto(`/model/${pid}?tab=proposals`);
      await settled(viv);
      assert.equal(await viv.getByRole('tab', { name: 'Proposals' }).count(), 0, 'a viewer has no Proposals tab');

      // ── Ana: the card, the server's preview, the approval ──────────────────────────────────────────────────────────────
      await page.goto(`/model/${pid}?tab=proposals`);
      const card = page.getByTestId('proposal-card');
      await card.waitFor();
      await card.getByRole('heading', { name: DRAFT.name }).waitFor();
      await card.getByText(DRAFT.formula).waitFor();
      await card.getByText(ASK).waitFor();
      await card.getByText('Needed once').waitFor();
      assert.equal(await card.getByTestId('proposal-figure').textContent(), '40.0%', 'the preview is the engine\'s figure for Ana: (2000 - 1200) / 2000 over her rows, never the model\'s');
      await settled(page);
      await card.getByRole('button', { name: 'Approve' }).click();
      await page.getByText('No proposals waiting').waitFor();
      const saved = ((await rpc(ANA, 'metric:list', { projectId: pid })).metrics as { id: string; name: string }[]).find((m) => m.name === DRAFT.name);
      assert.ok(saved, 'the metric exists');
      const history = (await rpc(ANA, 'versions:list', { projectId: pid, type: 'metric', id: saved!.id })) as { proposal?: { asks: number }; by?: string }[];
      assert.deepEqual({ asks: history.at(-1)?.proposal?.asks, by: history.at(-1)?.by }, { asks: 1, by: ANA }, 'its history says it was proposed from one question, and who approved');

      // ── Viv: told in the bell, asks again, and is answered ─────────────────────────────────────────────────────────────
      await viv.reload();
      await viv.getByRole('button', { name: /Notifications/ }).click();
      const row = viv.getByTestId('bell-proposal');
      await row.waitFor();
      await row.getByText('“Gross margin” is now defined').waitFor();
      await viv.getByRole('button', { name: `Ask again: ${ASK}` }).click();
      await viv.getByText('Gross margin is now a defined metric.').waitFor({ timeout: 30_000 });
      assert.ok(seen.ask.includes('- Metric Gross margin: (sum(revenue) - sum(cost)) / sum(revenue)'), 'the Assistant was told the metric now exists, with its formula');
    } finally {
      assert.deepEqual(vivProblems(), [], 'no console error, page error or CSP violation for the viewer');
      await vivCtx.close();
    }
  });
}
