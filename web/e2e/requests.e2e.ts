// E2E (docs/team-folders/00-design.md, "Dashboard requests"): a viewer asks for a dashboard, an editor approves it,
// the viewer opens it — on the real server with Postgres (header sign-in from a trusted 127.0.0.1 peer, its own
// scratch database). Priya (a project viewer) has two answers in a conversation; on the Assistant page she clicks
// "Request a dashboard" on one, ticks the other, names it and sends it. Sam (a project editor) sits on Home: his open
// tab shows "Priya asked for a dashboard in Pipeline" with Review, which opens the review page — the charts with
// today's figures, computed as Sam, and what approving makes. Approve and publish opens the new dashboard. Priya's tab
// shows the notice; her bell's row opens the dashboard, with both charts. Then she asks for a chart onto that
// dashboard ("A dashboard already there"), sees the request waiting in her bell, and withdraws it. Every page holds the
// RPC budget (≤ 25 per load) and fails on any console error or CSP violation. Screens in both themes, desktop and
// phone width, go to web/e2e/__screens__/requests-*.png.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const PRIYA = 'priya@acme.test';
const SAM = 'sam@acme.test';
const PHONE = { width: 375, height: 812 };
const DESK = { width: 1440, height: 900 };
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('requests e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_requests_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, openSession, settled, configureServer, screens, screensInPlace } = await import('./fixtures.ts');
  configureServer({
    env: { DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN },
    headers: { 'x-forwarded-email': SAM },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('requests: a viewer asks for a dashboard, an editor approves it, and the viewer opens it', async ({ page, server, rpc }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const call = async (as: string, channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, {
        data: { args: payload === undefined ? [] : [payload] },
        headers: { 'x-forwarded-email': as, 'x-csrf-token': csrf },
      });
      assert.equal(r.status(), 200, `${channel} as ${as}: ${r.status()} ${await r.text()}`);
      return r.json();
    };

    // The project, its data, and its two members.
    const pid: string = (await call(ADMIN, 'projects:create', { name: 'Pipeline' })).id;
    const saved = await call(ADMIN, 'dataset:composeSave', {
      projectId: pid,
      name: 'Deals',
      base: { inline: { name: 'Deals', columns: [{ name: 'stage', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['Lead', 'North', 120], ['Won', 'South', 80], ['Lead', 'South', 30], ['Lost', 'North', 45], ['Won', 'North', 60]] } },
      joins: [],
      steps: [],
      sourceKind: 'paste',
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const did: string = saved.dataset.id;
    for (const who of [PRIYA, SAM]) await call(who, 'projects:list'); // a first header-mode request provisions the account
    const targets = (await call(ADMIN, 'project:shareTargets', { projectId: pid })) as { users: { id: string; email: string }[] };
    const uid = (email: string) => targets.users.find((u) => u.email === email)?.id;
    await call(ADMIN, 'project:share', { projectId: pid, member: { userId: uid(PRIYA) }, role: 'viewer' });
    await call(ADMIN, 'project:share', { projectId: pid, member: { userId: uid(SAM) }, role: 'editor' });

    // Priya's two answers, in one conversation (follow-ups need no model).
    const spec = (category: string, title: string) => ({ datasetId: did, category, measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'bar', title });
    const first = await call(PRIYA, 'answer:rerun', { projectId: pid, spec: spec('stage', 'Pipeline by stage') });
    assert.equal(first.ok, true, JSON.stringify(first));
    const thread: string = first.threadId;
    assert.equal((await call(PRIYA, 'answer:rerun', { projectId: pid, threadId: thread, spec: spec('region', 'Pipeline by region') })).ok, true);

    // Sam's tab, on Home.
    await page.goto('/');
    await settled(page);

    const p = await openSession();
    try {
      await p.page.setExtraHTTPHeaders({ 'x-forwarded-email': PRIYA });
      await p.page.goto(`/assistant?thread=${thread}`);
      await settled(p.page);
      // On the second answer: Request a dashboard, with the first one ticked too.
      const card = p.page.getByTestId('answer-card').filter({ hasText: 'Pipeline by region' });
      await card.getByRole('button', { name: 'Request a dashboard' }).click();
      const dialog = p.page.getByRole('dialog', { name: 'Request a dashboard' });
      await dialog.getByRole('checkbox', { name: 'Pipeline by stage' }).check();
      await dialog.getByRole('textbox', { name: 'Dashboard name' }).fill('Pipeline review');
      await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill('For Monday’s sales meeting.');
      await screensInPlace(p.page, 'requests-dialog');
      await dialog.getByRole('button', { name: 'Send request' }).click();
      await card.getByTestId('request-sent').waitFor();
      console.log(`rpc: Priya's Assistant ${p.rpc.loads.at(-1)?.rpcs ?? 0}`);

      // Sam's open tab: the notice, then the review page.
      const notice = page.getByText('Priya asked for a dashboard in Pipeline');
      await notice.waitFor();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.waitForURL(new RegExp(`/requests/${pid}/[0-9a-f-]{36}$`));
      await settled(page);
      await page.getByRole('heading', { level: 1, name: 'Pipeline review' }).waitFor();
      assert.equal(await page.getByTestId('request-card').count(), 2);
      const makes = await page.getByTestId('request-creates').innerText();
      assert.match(makes, /2 visuals: Pipeline by stage, Pipeline by region/);
      assert.match(makes, /Everyone in the project/);
      await page.getByText('For Monday’s sales meeting.').waitFor();
      await screens(page, 'requests-review');
      await page.setViewportSize(PHONE);
      await screens(page, 'requests-review-phone');
      await page.setViewportSize(DESK);
      console.log(`rpc: Sam's review page ${rpc.loads.at(-1)?.rpcs ?? 0}`);

      await page.getByRole('button', { name: 'Approve and publish' }).click();
      await page.waitForURL(new RegExp(`/dashboards/${pid}/[0-9a-f-]{36}$`));
      const dashboardPath = new URL(page.url()).pathname;

      // Priya's tab: the notice; her bell's row opens the dashboard.
      await p.page.getByText('Sam approved your dashboard request in Pipeline').waitFor();
      await p.page.getByRole('button', { name: /^Notifications: \d+ unseen$/ }).click();
      const inbox = p.page.getByRole('dialog', { name: 'Notifications' });
      const row = inbox.getByRole('button', { name: /Your dashboard Pipeline review is ready, new/ });
      await row.waitFor();
      await screensInPlace(p.page, 'requests-bell');
      await p.page.setViewportSize(PHONE);
      await screensInPlace(p.page, 'requests-bell-phone');
      await p.page.setViewportSize(DESK);
      await row.click();
      await p.page.waitForURL((u) => u.pathname === dashboardPath);
      await settled(p.page);
      await p.page.getByText('Pipeline by region').first().waitFor();
      await screens(p.page, 'requests-dashboard');
      console.log(`rpc: Priya's dashboard ${p.rpc.loads.at(-1)?.rpcs ?? 0}`);

      // A chart onto the dashboard she now opens; then, from her bell, she takes it back.
      await p.page.goto(`/assistant?thread=${thread}`);
      await settled(p.page);
      const stage = p.page.getByTestId('answer-card').filter({ hasText: 'Pipeline by stage' });
      await stage.getByRole('button', { name: 'Request a dashboard' }).click();
      const onto = p.page.getByRole('dialog', { name: 'Request a dashboard' });
      await onto.getByRole('radio', { name: 'A dashboard already there' }).check();
      await onto.getByRole('combobox', { name: 'Dashboard' }).click();
      await p.page.getByRole('option', { name: 'Pipeline review' }).click();
      await screensInPlace(p.page, 'requests-dialog-onto');
      await onto.getByRole('button', { name: 'Send request' }).click();
      await stage.getByTestId('request-sent').waitFor();
      await p.page.getByRole('button', { name: /^Notifications/ }).click();
      const mine = p.page.getByRole('dialog', { name: 'Notifications' });
      await mine.getByRole('button', { name: /^Your request for Pipeline review is waiting for review/ }).waitFor();
      await screensInPlace(p.page, 'requests-withdraw');
      await p.page.setViewportSize(PHONE);
      await screensInPlace(p.page, 'requests-withdraw-phone');
      await p.page.setViewportSize(DESK);
      await mine.getByRole('button', { name: 'Withdraw your request for Pipeline review' }).click();
      await mine.getByText('You withdrew your request for Pipeline review').waitFor();
      assert.equal(await mine.getByRole('button', { name: /^Withdraw your request/ }).count(), 0);
      const problems = p.problems();
      assert.deepEqual(problems, [], `Priya's page: ${problems.join('\n')}`);
    } finally {
      await p.close();
    }
  });
}
