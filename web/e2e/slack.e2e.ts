// E2E: Ordinate in Slack (docs/slack/00-design.md), setup and linking, on the real server with Postgres, header sign-in and
// the secrets store, against a LOCAL STUB of Slack (./slackStub.ts: the Web API, Sign in with Slack and a signed event
// sender, in this process — no call reaches the real Slack).
//
//   - The org admin opens Admin → Slack: the empty set-up, the manifest with this server's address filled in; pastes the app's
//     keys; Slack is asked who the bot is and the page says connected, with no key on it.
//   - A direct message from a Slack user nobody has linked gets a private Connect button; the person follows it (signed in to
//     Ordinate, then "Sign in with Slack" at the stub), lands on Settings with their Slack row connected, and the question
//     they asked is answered (with no model set up, by the fixed "not set up" sentence).
//   - A project admin ties a channel the bot is in to an agent on its page; it is still there after a reload.
//   - Disconnecting the Slack account puts the row back to "Not connected".
//
// Screens: web/e2e/__screens__/slack-{admin-empty,admin-connected,profile,agent}-{light,dark}.png.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, SIGNING, startSlackStub, TEAM } from './slackStub.ts';

const ADMIN = 'boss@acme.test';
const dbUrl = process.env.DATABASE_URL;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
const until = async (fn: () => boolean, ms = 20_000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (fn()) return true;
  return false;
};

if (!dbUrl) {
  void test('slack e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_slack_${process.pid}_${Date.now()}`;
  const scratch = new URL(dbUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: dbUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const stub = await startSlackStub();
  const port = await freePort();
  const PUBLIC = `http://127.0.0.1:${port}`;
  after(async () => {
    await stub.close();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });
  const { e2e, settled, screens, configureServer, SCREENS } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(), ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN,
      PORT: String(port), ORDINATE_PUBLIC_URL: PUBLIC, ORDINATE_TEST_SLACK_BASE: stub.origin, SSRF_ALLOW: '127.0.0.1/32',
    },
    headers: { 'x-forwarded-email': ADMIN },
  });

  e2e('slack: set up in Admin → Slack, a first question gets a Connect button, linking lands on Settings, an agent takes a channel, disconnect', async ({ page, server }) => {
    assert.equal(server.base, PUBLIC, 'the server listens where its public address says');
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const rpc = async (channel: string, payload?: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
      assert.equal(r.status(), 200, `${channel}: ${r.status()} ${await r.text()}`);
      return r.json();
    };
    const { projectId: pid } = await rpc('sample:seed');

    // ── Admin → Slack, nothing set up ───────────────────────────────────
    await page.goto('/admin?tab=slack');
    await settled(page);
    await page.getByRole('heading', { name: 'Ask Ordinate from Slack' }).waitFor();
    await page.getByText('App not connected').waitFor();
    assert.ok(((await page.getByTestId('slack-manifest').textContent()) ?? '').includes(`${PUBLIC}/api/slack/events`), 'the manifest carries this server\'s address');
    assert.equal(await page.getByRole('button', { name: 'Connect to Slack' }).isDisabled(), true, 'nothing to save before a token is typed');
    await screens(page, 'slack-admin-empty');

    // ── Paste the keys ──────────────────────────────────────────────────
    await page.getByLabel('Bot token').fill('xoxb-not-the-right-token-1');
    await page.getByLabel('Signing secret').fill(SIGNING);
    await page.getByLabel('Client ID').fill(CLIENT_ID);
    await page.getByLabel('Client secret').fill(CLIENT_SECRET);
    await page.getByRole('button', { name: 'Connect to Slack' }).click();
    await page.getByRole('alert').getByText('Slack did not accept that bot token.').waitFor();
    await page.getByLabel('Bot token').fill(BOT_TOKEN);
    await page.getByRole('button', { name: 'Connect to Slack' }).click();
    await page.getByText('Connected to Acme E2E').first().waitFor();
    for (const secret of [BOT_TOKEN, SIGNING, CLIENT_SECRET]) assert.equal((await page.content()).includes(secret), false, 'no key is on the page once saved');
    await page.getByRole('switch', { name: 'Answer questions in Slack' }).waitFor();
    await screens(page, 'slack-admin-connected');

    // ── A first question from an unknown Slack user ─────────────────────
    const person = 'UADMIN00E2E';
    const sent = await stub.send(server.base, {
      type: 'event_callback', team_id: TEAM, event_id: 'EvE2E1', event: { type: 'message', channel_type: 'im', user: person, text: 'how many orders?', channel: `D${person}`, ts: '1800000001.000200' },
    });
    assert.equal(sent.status, 200, 'a signed event is accepted');
    assert.ok(await until(() => stub.calls.some((c) => c.method === 'chat.postEphemeral')), 'the stranger is sent a private Connect button');
    const ephemeral = stub.calls.find((c) => c.method === 'chat.postEphemeral')?.params as { user: string; blocks: Array<{ elements?: Array<{ url?: string }> }> };
    assert.equal(ephemeral.user, person, 'only to them');
    const connect = ephemeral.blocks[1].elements?.[0].url ?? '';
    assert.ok(connect.startsWith(`${PUBLIC}/api/slack/connect?s=`), connect);
    assert.equal(JSON.stringify(ephemeral).includes('how many orders'), false, 'the Connect button carries no question text');

    // ── Linking: signed in to Ordinate, then Sign in with Slack ─────────
    stub.signInAs = person;
    await page.goto(connect);
    await page.waitForURL(`${PUBLIC}/settings**`);
    await settled(page);
    await page.getByText('Your Slack account is linked.').waitFor();
    await page.getByText('Connected', { exact: true }).first().waitFor();
    assert.equal(new URL(page.url()).searchParams.has('slack'), false, 'the result is said once and dropped from the address');
    assert.ok(await until(() => stub.calls.some((c) => c.method === 'chat.update' && /not set up/.test(JSON.stringify(c.params)))), 'the waiting question is answered after linking');
    await screens(page, 'slack-profile');

    // ── An agent takes a channel ────────────────────────────────────────
    const agent = (await rpc('agent:save', { projectId: pid, agent: { name: 'Sales agent', topicId: null, model: null, build: false, teamIds: [] } })).agent.id as string;
    await page.goto(`/model/${pid}?tab=assistant&agent=${agent}`);
    await settled(page);
    const channels = page.getByRole('group', { name: 'Slack channels' });
    await channels.getByRole('checkbox', { name: '#sales' }).waitFor();
    await channels.getByRole('checkbox', { name: '#sales' }).check();
    await page.getByRole('button', { name: 'Save channels' }).click();
    await page.getByText('Slack channels saved.').waitFor();
    await page.reload();
    await settled(page);
    assert.equal(await page.getByRole('group', { name: 'Slack channels' }).getByRole('checkbox', { name: '#sales' }).isChecked(), true, 'the channel is still tied after a reload');
    assert.equal(await page.getByRole('group', { name: 'Slack channels' }).getByRole('checkbox', { name: '#ops' }).isChecked(), false);
    const field = page.getByRole('group', { name: 'Slack channels' }).locator('..');
    await field.scrollIntoViewIfNeeded();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.waitForTimeout(250);
      await field.screenshot({ path: path.join(SCREENS, `slack-agent-${theme}.png`) });
    }

    // ── Disconnect ──────────────────────────────────────────────────────
    await page.goto('/settings');
    await settled(page);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByText('Not connected', { exact: true }).waitFor();
  });
}
