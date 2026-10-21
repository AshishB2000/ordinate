// Channels and subscriptions end to end, on Postgres with the secrets store:
// an org admin (header sign-in, as oauth2-proxy would) adds a Slack and a Teams
// channel in Admin → Channels — a plain http:// URL is refused beside its field
// — and an email list (picked from the org's people, sent a test), then makes
// a subscription to the sample dashboard from Reports → Subscriptions (the
// dialog, the dashboard picked in it), sends it now, reads the run, switches it
// off, sends a second one by email (its Email preview first), and removes a
// channel past the warning that names the subscription.
//
// EMAIL goes to an in-process fake relay (scripts/smtpFake.ts, compiled) on
// loopback in plaintext mode — TLS is scripts/test-smtp.ts's job.
//
// NOTHING REACHES SLACK OR TEAMS. The webhook URLs are on the reserved
// `.invalid` TLD, which never resolves: a send fails as "could not be reached",
// which is exactly the failed-run state this spec photographs. The success path
// is the server suites' (scripts/test-subscriptions-server.ts), against a local
// receiver.
//
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import pg from 'pg';
import type { Page } from 'playwright';

interface FakeRelay { port: number; txns: Array<{ rcpts: string[]; data: string }>; close(): Promise<void> }
const { startFake } = createRequire(import.meta.url)('../../scripts/smtpFake.js') as { startFake: (o: { mode: 'none' }) => Promise<FakeRelay> };

const ADMIN = 'admin@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('channels e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_channels_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);

  const { e2e, screens, settled, configureServer, SCREENS } = await import('./fixtures.ts');
  const relay = await startFake({ mode: 'none' });
  configureServer({
    env: {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(relay.port),
      SMTP_SECURITY: 'plaintext',
      SMTP_FROM: 'Acme Analytics <bi@acme.test>',
      DATABASE_URL: scratch.toString(),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
      ORDINATE_PUBLIC_URL: 'https://bi.example.test',
    },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await relay.close();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const screensInPlace = async (page: Page, name: string): Promise<void> => {
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  };

  e2e('channels: add Slack and Teams → a new subscription from the list → its row, send now, runs, switch off → remove a channel past its warning', async ({ page, server, rpc }) => {
    // Records live in Postgres here, so the file-seeded sample is not visible: seed it through the app's own door.
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const seeded = await page.request.post(`${server.base}/api/rpc/sample:seed`, { headers: { 'x-csrf-token': csrf }, data: { args: [] } });
    assert.equal(seeded.status(), 200);
    const { projectId: pid } = (await seeded.json()) as { projectId: string };
    assert.match(pid, /^[0-9a-f-]{36}$/);

    // ── Admin → Channels ───────────────────────────────────────────────
    await page.goto('/admin?tab=channels');
    await settled(page);
    await page.getByRole('heading', { name: 'No channels yet' }).waitFor();
    await screens(page, 'admin-channels-empty');
    await page.getByRole('button', { name: 'Add a channel' }).first().click();
    const add = page.getByRole('dialog', { name: 'Add a channel' });
    await add.getByLabel('Name').fill('#sales-weekly');
    await add.getByRole('textbox', { name: 'Webhook URL' }).fill('http://hooks.invalid/services/T000/B000/e2e');
    await add.getByRole('button', { name: 'Add channel' }).click();
    await add.getByText('A webhook URL must start with https:// and carry no user name or password.').waitFor();
    await screensInPlace(page, 'admin-channel-add');
    await add.getByRole('textbox', { name: 'Webhook URL' }).fill('https://hooks.invalid/services/T000/B000/e2e-secret');
    await add.getByRole('button', { name: 'Add channel' }).click();
    await add.waitFor({ state: 'detached' });
    const slackRow = page.getByRole('row').filter({ hasText: '#sales-weekly' });
    await slackRow.getByText('Stored').waitFor();

    await page.getByRole('button', { name: 'Add a channel' }).click();
    const add2 = page.getByRole('dialog', { name: 'Add a channel' });
    await add2.getByRole('radio', { name: 'Microsoft Teams' }).check();
    await add2.getByText(/Post to a channel when a webhook request is received/).waitFor();
    await add2.getByLabel('Name').fill('Leadership');
    await add2.getByRole('textbox', { name: 'Webhook URL' }).fill('https://teams.invalid/workflows/e2e-secret');
    await add2.getByRole('button', { name: 'Add channel' }).click();
    await add2.waitFor({ state: 'detached' });
    await page.getByRole('row').filter({ hasText: 'Leadership' }).getByText('Teams').waitFor();

    // An email list: people picked from the org, never a typed address; a test goes to the admin alone.
    await page.getByRole('button', { name: 'Add a channel' }).click();
    const add3 = page.getByRole('dialog', { name: 'Add a channel' });
    await add3.getByRole('radio', { name: 'Email' }).check();
    await add3.getByText(/reaches only those of them who can open its project at that moment/).waitFor();
    await add3.getByLabel('Name').fill('Sales leads');
    await add3.getByRole('checkbox', { name: ADMIN }).check();
    await add3.getByText(/^Names 1 person\./).waitFor();
    await screensInPlace(page, 'admin-channel-email');
    await add3.getByRole('button', { name: 'Add channel' }).click();
    await add3.waitFor({ state: 'detached' });
    const mailRow = page.getByRole('row').filter({ hasText: 'Sales leads' });
    await mailRow.getByText('1 person').waitFor();
    await mailRow.getByRole('button', { name: 'Send a test email' }).click();
    await page.getByText('Test email sent to you').waitFor({ timeout: 30_000 });
    assert.deepEqual(relay.txns.at(-1)?.rcpts, [ADMIN], 'the test email went to the admin alone');
    // The URL was write-only: nothing on the page holds it.
    assert.equal((await page.content()).includes('e2e-secret'), false, 'no webhook URL in the page');
    await screens(page, 'admin-channels');
    console.log(`rpc: Admin → Channels load ${rpc.loads.at(-1)?.rpcs ?? 0}`);

    // ── A new subscription, from the list: the dashboard is the first choice ──
    // (Not from the dashboard itself here: its map tile fetches OSM tiles, and this spec's sign-in header on a
    // cross-origin request fails their CORS preflight — a console error of the harness, not of the app.
    // The dashboard's own Subscribe button is subscriptions.e2e.ts.)
    await page.goto(`/reports?project=${pid}&tab=subscriptions`);
    await settled(page);
    await page.getByRole('heading', { name: 'Nothing is scheduled yet' }).waitFor();
    await page.getByRole('button', { name: 'New subscription' }).click();
    const dlg = page.getByRole('dialog', { name: 'New subscription' });
    await dlg.getByText(/Choose a dashboard and its message appears here/).waitFor();
    await dlg.getByRole('combobox', { name: 'Dashboard' }).click();
    await page.getByRole('option', { name: 'Retail overview' }).click();
    await dlg.getByTestId('preview-slack').getByText('$5.2M').first().waitFor({ timeout: 30_000 });
    await dlg.getByTestId('preview-slack').getByText('Open in Ordinate').waitFor();
    await dlg.getByRole('button', { name: /^Where/ }).click();
    await dlg.getByRole('checkbox', { name: '#sales-weekly' }).check();
    await dlg.getByRole('checkbox', { name: 'Leadership' }).check();
    await dlg.getByText('Send to · 2 chosen').waitFor();
    await screensInPlace(page, 'subscribe-where');
    await dlg.getByRole('button', { name: /^Message/ }).click();
    await dlg.getByLabel('Subscription name').fill('Weekly board');
    await dlg.getByLabel('Note').fill('Numbers for the Monday review.');
    await dlg.getByTestId('preview-slack').getByText('Numbers for the Monday review.').waitFor({ timeout: 15_000 });
    await screensInPlace(page, 'subscribe-message');
    await dlg.getByRole('button', { name: 'Subscribe' }).click();
    await dlg.waitFor({ state: 'detached' });
    await page.getByText(/^Subscribed — next: /).waitFor();

    // ── Reports → Subscriptions ────────────────────────────────────────
    await page.goto(`/reports?project=${pid}&tab=subscriptions`);
    await settled(page);
    const row = page.getByRole('listitem', { name: 'Weekly board' });
    await row.getByText('Every weekday at 08:00', { exact: false }).waitFor();
    await row.getByText(/^Next: \w{3},? \d{1,2} \w{3},? 08:00$/).waitFor();
    await row.getByText('#sales-weekly').waitFor();
    await row.getByText('Leadership').waitFor();
    await row.getByText('Not run yet').waitFor();
    await row.getByRole('link', { name: 'Retail overview' }).waitFor();
    await screens(page, 'subscriptions-list');
    console.log(`rpc: Reports → Subscriptions load ${rpc.loads.at(-1)?.rpcs ?? 0}`);

    // Send now: `.invalid` never resolves, so both posts fail — three attempts each, then the reason in words.
    await page.getByRole('listitem', { name: 'Weekly board' }).getByRole('button', { name: 'Send now' }).click();
    await page.getByRole('listitem', { name: 'Weekly board' }).getByText('Failed').waitFor({ timeout: 60_000 });
    await page.getByRole('listitem', { name: 'Weekly board' }).getByText('Not delivered: #sales-weekly could not be reached.').waitFor();
    await page.getByRole('button', { name: 'Weekly board options' }).click();
    await page.getByRole('menuitem', { name: 'Runs' }).click();
    const runs = page.getByRole('dialog', { name: 'Runs of Weekly board' });
    await runs.getByRole('list', { name: 'Runs' }).getByText('Sent by hand').waitFor();
    await runs.getByText('Not delivered: #sales-weekly could not be reached.').waitFor();
    await screensInPlace(page, 'subscriptions-runs');
    await runs.getByRole('button', { name: 'Close' }).click();

    // Off: no next run.
    // A controlled switch: it shows the server's state, so it moves when the write has landed.
    await page.getByRole('switch', { name: 'Send Weekly board on its schedule' }).click();
    await page.getByRole('listitem', { name: 'Weekly board' }).getByText('Off — no next run').waitFor();

    // ── By email: the Email preview, then a send that arrives at the relay ──
    await page.getByRole('button', { name: 'New subscription' }).first().click();
    const mdlg = page.getByRole('dialog', { name: 'New subscription' });
    await mdlg.getByRole('combobox', { name: 'Dashboard' }).click();
    await page.getByRole('option', { name: 'Retail overview' }).click();
    await mdlg.getByTestId('preview-slack').getByText('$5.2M').first().waitFor({ timeout: 30_000 });
    await mdlg.getByRole('button', { name: /^Where/ }).click();
    await mdlg.getByRole('checkbox', { name: 'Sales leads' }).check();
    await mdlg.getByRole('tab', { name: 'Email' }).click();
    await mdlg.getByTestId('preview-email').getByText('$5.2M').first().waitFor({ timeout: 15_000 });
    await mdlg.getByTestId('preview-email').getByText(/You receive this as a member of Sales leads/).waitFor({ timeout: 15_000 });
    await screensInPlace(page, 'subscribe-email-preview');
    await mdlg.getByRole('button', { name: /^Message/ }).click();
    await mdlg.getByLabel('Subscription name').fill('Email board');
    await mdlg.getByRole('button', { name: 'Subscribe' }).click();
    await mdlg.waitFor({ state: 'detached' });
    const sentBefore = relay.txns.length;
    await page.getByRole('listitem', { name: 'Email board' }).getByRole('button', { name: 'Send now' }).click();
    await page.getByRole('listitem', { name: 'Email board' }).getByText('Sent to 1 channel.').waitFor({ timeout: 60_000 });
    assert.equal(relay.txns.length, sentBefore + 1, 'one email arrived');
    assert.deepEqual(relay.txns.at(-1)?.rcpts, [ADMIN], 'to the one reader on the list');
    await screens(page, 'subscriptions-list-email');

    // ── Removing a channel names what it breaks ────────────────────────
    await page.goto('/admin?tab=channels');
    await settled(page);
    await page.getByRole('button', { name: 'Actions for #sales-weekly' }).click();
    await page.getByRole('menuitem', { name: 'Remove…' }).click();
    const rm = page.getByRole('dialog', { name: 'Remove #sales-weekly?' });
    await rm.getByRole('alert').getByText('Weekly board').waitFor();
    await rm.getByText(/1 thing posts to this channel and will stop sending here/).waitFor();
    await screensInPlace(page, 'admin-channel-remove');
    await rm.getByRole('button', { name: 'Remove channel' }).click();
    await rm.waitFor({ state: 'detached' });
    await page.getByRole('row').filter({ hasText: '#sales-weekly' }).waitFor({ state: 'detached' });

    await page.goto(`/reports?project=${pid}&tab=subscriptions`);
    await settled(page);
    await page.getByRole('listitem', { name: 'Weekly board' }).getByText('Removed channel').waitFor();
    await page.getByRole('listitem', { name: 'Weekly board' }).getByText('Leadership').waitFor();
  });
}
