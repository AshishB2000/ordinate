// Autopilot's report end to end, on Postgres (docs/autopilot/00-design.md, phases 2 to 4): an admin switches it on, a column of a sample
// dataset is renamed, Run now repairs the chart that used it, the report page says so, and Undo puts the chart back as it was.
// Needs Postgres: without DATABASE_URL this spec prints one skip line.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const ADMIN = 'admin@acme.test';
const adminUrl = process.env.DATABASE_URL;

if (!adminUrl) {
  void test('autopilot e2e', { skip: 'DATABASE_URL is unset (set it to a Postgres this spec may CREATE DATABASE on)' }, () => {});
} else {
  const dbName = `ordinate_e2e_autopilotrep_${process.pid}_${Date.now()}`;
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

  e2e('autopilot: a renamed column is repaired by Run now, the report says so, Undo puts it back', async ({ page, server }) => {
    await page.request.get(`${server.base}/api/auth/me`);
    const csrf = (await page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
    const call = async (channel: string, input: unknown): Promise<any> => { // any: each channel's own reply
      const r = await page.request.post(`${server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: input === undefined ? [] : [input] } });
      assert.equal(r.status(), 200, `${channel}: ${await r.text()}`);
      return r.json();
    };
    const { projectId: pid } = (await call('sample:seed', undefined)) as { projectId: string };

    // A saved chart over a plain column of its dataset.
    const summaries = (await call('visual:list', { projectId: pid })) as Array<{ id: string }>;
    let chart: { id: string; name: string; datasetId: string; encoding: { category: string } } | null = null;
    for (const s of summaries) {
      const v = await call('visual:get', { projectId: pid, id: s.id });
      if (v && typeof v.encoding?.category === 'string' && v.encoding.category && !v.encoding.categoryDatasetId) { chart = v; break; }
    }
    assert.ok(chart, 'the sample project has a chart with a plain category column');
    const old = chart.encoding.category;
    const meta = await call('dataset:columns', { projectId: pid, id: chart.datasetId });
    const columns = (meta.columns as Array<{ name: string; type: string }>).map((c) => ({ name: c.name, type: c.type }));
    assert.ok(columns.some((c) => c.name === old), `the dataset has the column ${old}`);
    const renamed = `${old}_renamed`;

    // On, as this admin. Then the rename (logged by the server), and the chart is broken.
    assert.equal((await call('autopilot:save', { projectId: pid, enabled: true })).settings.runAs, ADMIN);
    assert.equal((await call('dataset:update', { projectId: pid, datasetId: chart.datasetId, columns: columns.map((c) => (c.name === old ? { ...c, name: renamed } : c)) })).ok, true);
    for (let i = 0; i < 40; i += 1) {
      if ((await db.query('SELECT 1 FROM column_renames WHERE old_name = $1 AND new_name = $2', [old, renamed])).rowCount) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal((await db.query('SELECT 1 FROM column_renames WHERE old_name = $1 AND new_name = $2', [old, renamed])).rowCount, 1, 'the rename was logged');

    // Admin → Autopilot → Run now → the report.
    await page.goto('/admin?tab=autopilot');
    await settled(page);
    const card = page.getByRole('region', { name: /^Autopilot for / }).first();
    await card.getByRole('button', { name: 'Run now' }).waitFor();
    await card.getByRole('button', { name: 'Run now' }).click();
    await page.waitForURL(/\/autopilot\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    await settled(page);
    await page.getByRole('heading', { name: 'Autopilot report' }).waitFor();
    await page.getByText(`Now uses ${renamed} (was ${old})`).waitFor();
    assert.equal((await call('visual:get', { projectId: pid, id: chart.id })).encoding.category, renamed, 'the chart now names the renamed column');

    // Undo from the report: the row reads Undone and the chart is as it was.
    await page.getByRole('button', { name: `Undo for ${chart.name}` }).click();
    await page.getByText('Undone', { exact: true }).waitFor();
    assert.equal((await call('visual:get', { projectId: pid, id: chart.id })).encoding.category, old, 'Undo put the chart back');
    console.log(`rpc: report ${await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/rpc/')).length)} requests`);
  });
}
