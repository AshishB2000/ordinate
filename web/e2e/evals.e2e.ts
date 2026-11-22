// E2E: evaluation suites (docs/eval-suites/00-design.md), the whole path on the real server with Postgres, header sign-in and a STUB
// model provider on loopback (./evalsStub.ts). An admin:
//   - asks a revenue question; the answer has thumbs, and a thumbs-down says "Editors will see this question" BEFORE it sends;
//   - adds that answer to a new suite ("Add to tests"), adds the thumbs-down question from the inbox with words for the judge, and types
//     a case that should be refused: a 3-case suite on Model → Assistant → Tests;
//   - runs it: the run card advances to Finished; the results page shows 2 passed and 1 failed (the stub answers the refusal with plain
//     words, which is not a refusal), the model calls, and that the Assistant's own model judged;
//   - runs it again: the page compares with the last run (0 better, 0 worse, 3 the same);
//   - Admin → AI shows the Judge model card.
// Screens: web/e2e/__screens__/evals-{thumbs,tests,results,results-compared,judge}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { DELETE, REVENUE, calls, stubUrl } from './evalsStub.ts';

const ADMIN = 'boss@acme.test';
const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  void test('evals e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_evals_${process.pid}_${Date.now()}`;
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

  e2e('evals: thumbs with the notice, a 3-case suite from an answer, the inbox and a typed case, a run, its results, and a second run compared', async ({ page, server }) => {
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

    // ── Ask, and the thumbs ────────────────────────────────────────────────────────────────────────────────────────────
    await page.goto(`/visuals/${pid}`);
    await settled(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const dock = page.getByRole('complementary', { name: 'Assistant' });
    const box = dock.getByRole('textbox', { name: 'Ask the Assistant' });
    await page.waitForFunction(() => !(document.querySelector('textarea[aria-label="Ask the Assistant"]') as HTMLTextAreaElement | null)?.disabled);
    await box.fill(REVENUE);
    await box.press('Enter');
    await dock.getByTestId('answer-card').first().waitFor({ timeout: 30_000 });
    const thumbs = dock.getByTestId('thumbs').first();
    await thumbs.getByRole('button', { name: 'Bad answer' }).click();
    const panel = thumbs.getByTestId('thumbs-panel');
    await panel.getByText('Editors will see this question. They never see the answer.').waitFor();
    assert.equal((await rpc('feedback:inbox', { projectId: pid })).items.length, 0, 'nothing is shared before Send');
    await panel.getByRole('button', { name: 'Wrong number' }).click();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.cwd()}/e2e/__screens__/evals-thumbs-${theme}.png`, fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await panel.getByRole('button', { name: 'Send' }).click();
    await thumbs.getByText('Thanks. The question went to the editors.').waitFor();
    const inbox = (await rpc('feedback:inbox', { projectId: pid })).items;
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].question, REVENUE);
    assert.equal(inbox[0].reason, 'wrong_number');
    assert.ok(!JSON.stringify(inbox).includes('West leads'), 'the inbox never holds the answer');

    // ── Add to tests: the answer into a new suite ──────────────────────────────────────────────────────────────────────
    await dock.getByRole('button', { name: 'Add to tests' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add to tests' });
    await add.getByRole('textbox', { name: 'Suite name' }).fill('Revenue questions');
    await add.getByRole('button', { name: 'Add', exact: true }).click();
    await add.waitFor({ state: 'detached' });

    // ── The Tests section: the inbox question with words, and a typed refusal ───────────────────────────────────────────────
    await page.goto(`/model/${pid}?tab=assistant`);
    const section = page.getByRole('region', { name: 'Tests' });
    const row = section.getByTestId('suite-row');
    await row.getByText('1 test case').waitFor();
    const inboxRow = page.getByTestId('inbox-row');
    await inboxRow.getByText(REVENUE).waitFor();
    await inboxRow.getByRole('button', { name: 'Add to tests' }).click();
    const fromInbox = page.getByRole('dialog', { name: 'Add to tests' });
    await fromInbox.getByRole('textbox', { name: 'What a good answer says' }).fill('says which region leads');
    await fromInbox.getByRole('button', { name: 'Add', exact: true }).click();
    await fromInbox.waitFor({ state: 'detached' });
    await row.getByText('2 test cases').waitFor();
    await row.getByRole('button', { name: 'Cases' }).click();
    const cases = page.getByRole('dialog', { name: 'Revenue questions' });
    await cases.getByRole('textbox', { name: 'Question' }).fill(DELETE);
    await cases.getByRole('checkbox', { name: /It should be refused/ }).check();
    await cases.getByRole('button', { name: 'Add test case' }).click();
    await cases.getByText(DELETE).waitFor();
    assert.equal(await cases.getByTestId('case-row').count(), 3);
    await cases.getByRole('button', { name: 'Done' }).click();
    await row.getByText('3 test cases').waitFor();
    await settled(page);
    await screensInPlace(page, 'evals-tests');

    // ── Run it ────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const asksBefore = calls.ask;
    await row.getByRole('button', { name: 'Run tests' }).click();
    await row.getByText(/Last run .*: 2 passed, 1 failed/).waitFor({ timeout: 90_000 });
    assert.equal(calls.ask - asksBefore, 3, 'one ask per case, through the real Assistant');
    assert.equal(calls.judge, 1, 'the judge reads only the case that has words and passed the engine\'s checks');
    await row.getByRole('link', { name: /2 passed, 1 failed/ }).click();
    const results = page.getByTestId('eval-results');
    await results.waitFor();
    await page.getByText('Finished', { exact: true }).first().waitFor();
    const lines = results.getByTestId('result-row');
    assert.deepEqual(await lines.evaluateAll((els) => els.map((e) => e.getAttribute('data-outcome'))), ['pass', 'pass', 'fail']);
    await results.getByText(/The Assistant’s own model judged the words/).waitFor();
    await results.getByText(/first run of the suite/).waitFor();
    await lines.nth(2).getByRole('button').click();
    await results.getByText('It replied in words only: the app did not refuse.').waitFor();
    await results.getByText('Okay, I did that.').waitFor(); // the runner reads the answer's words
    await settled(page);
    await screensInPlace(page, 'evals-results');

    // ── A second run, compared with the first ──────────────────────────────────────────────────────────────────────────────
    await page.goBack();
    await row.getByRole('button', { name: 'Run tests' }).click();
    await page.waitForResponse((r) => r.url().includes('/api/rpc/eval%3ArunStart') || r.url().includes('/api/rpc/eval:runStart'));
    await row.getByRole('link', { name: /2 passed, 1 failed/ }).waitFor({ timeout: 90_000 });
    const runs = (await rpc('eval:runList', { projectId: pid })).runs;
    assert.equal(runs.length, 2);
    await page.goto(`/evals/${pid}/${runs[0].id}`);
    await page.getByTestId('compare').getByText('0 better, 0 worse, 3 the same').waitFor();
    await settled(page);
    await screensInPlace(page, 'evals-results-compared');

    // ── Admin → AI: the Judge model ──────────────────────────────────────────────────────────────────────────────────────
    await page.goto('/admin?tab=ai');
    const judge = page.getByRole('form', { name: 'Judge model' });
    await judge.waitFor();
    await judge.getByText('The Assistant’s own model').waitFor();
    await settled(page);
    await judge.scrollIntoViewIfNeeded();
    await screensInPlace(page, 'evals-judge');
  }, { rpcBudget: 80 }); // two runs, each followed live: every case the server pushes is one read of the run
}
