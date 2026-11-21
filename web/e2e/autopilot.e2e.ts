// Autopilot phase 1 end to end, on Postgres: opening a dashboard adds NO request of its own (the server records the open and
// each chart's compute where it already answers, off the request path), and the open and the timed computes land as rows
// of item_usage_daily within a flush. Without a database recording is a no-op and this check would prove nothing, so this
// spec needs Postgres: without DATABASE_URL it prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('autopilot e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_autopilot_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const db = new pg.Pool({ connectionString: scratch.toString(), max: 2 });
  db.on('error', () => undefined);

  const { e2e, settled, configureServer } = await import('./fixtures.ts');
  configureServer({
    env: {
      DATABASE_URL: scratch.toString(),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
    },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await db.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  e2e('autopilot: opening a dashboard makes no extra request, and its open and charts are recorded', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const call = async (channel: string, input: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: input === undefined ? [] : [input] } });
      assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
      return r.json();
    };
    const { projectId: pid } = (await call('sample:seed', undefined)) as { projectId: string };
    const list = (await call('analysis:gallery', { projectId: pid })) as Array<{ id: string }>;
    assert.ok(list.length > 0, 'the sample project has a dashboard');
    const aid = list[0].id;

    // The sample dashboard has a map: its tiles are another origin's, and the sign-in header fails their CORS preflight (a harness
    // matter, as in channels.e2e.ts). Answer them from here, so the page is quiet and the count is the app's own.
    await page.route(/tile\.openstreetmap\.org/, (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, contentType: 'image/png', body: Buffer.alloc(0) }));
    const channels: string[] = [];
    page.on('request', (r) => {
      const m = /\/api\/rpc\/([^/?]+)/.exec(r.url());
      if (r.method() === 'POST' && m) channels.push(decodeURIComponent(m[1]));
    });
    await page.goto(`/dashboards/${pid}/${aid}`);
    await settled(page);
    assert.ok(channels.includes('analysis:open'), 'the page opened the dashboard');
    assert.deepEqual(channels.filter((c) => /autopilot|usage|record|telemetry/i.test(c)), [], 'no request of the browser is made for the record');

    let rows: Array<{ kind: string; opened: boolean; computes: number }> = [];
    for (let i = 0; i < 60 && !rows.some((r) => r.kind === 'dashboard'); i += 1) {
      rows = (await db.query(`SELECT kind, opened, computes FROM item_usage_daily WHERE project_id = $1`, [pid])).rows;
      if (!rows.some((r) => r.kind === 'dashboard')) await new Promise((res) => setTimeout(res, 500)); // the pod writes its batch every 10 s
    }
    assert.ok(rows.some((r) => r.kind === 'dashboard' && r.opened), `the dashboard's open was recorded: ${JSON.stringify(rows)}`);
    assert.ok(rows.some((r) => r.kind === 'visual' && r.computes > 0), 'a chart on it was timed');
    console.log(`rpc: dashboard load ${channels.length} requests, none for the record`);
  });
}
