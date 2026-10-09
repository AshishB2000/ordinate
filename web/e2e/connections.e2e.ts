// E2E (T2.5): Connections against the real server.
//
// Always: the picker (no local-file sources on a server, search, keyboard),
// the generated form (required fields, a failed test shown inline), and — when
// the server has no encrypted store — a password REFUSED with the clear error.
// Snowflake's form (L1.1): the private key in a masked, write-only textarea,
// and an account that is not an identifier refused before any socket opens.
//
// With DATABASE_URL (a Postgres this spec may CREATE DATABASE on): the server
// runs on its own scratch database with ORDINATE_MASTER_KEY, header sign-in,
// and the main flow runs against a second scratch database as the SOURCE:
// connect with a canary password → the workbench (schema tree, columns,
// sample, autocomplete, Run, Explain, Save query, Save as dataset, schedule,
// Refresh now) → the rail shows the password as "Set", Replace tests and keeps
// a new one → delete. The canary must never appear in an RPC reply, the DOM
// or the server log. Live (L2.1) on Redshift's wire; Live on a PostgreSQL read
// replica (L3.2): the box ticked on the form, Live saved, unticking refused.
// Screens in both themes: web/e2e/__screens__/connections-*.png.

import assert from 'node:assert/strict';
import path from 'node:path';
import { after } from 'node:test';
import pg from 'pg';
import type { Page, Response } from 'playwright';
import { configureServer, e2e, SCREENS, screens, settled, type Session } from './fixtures.ts';

const ADMIN = 'owner@acme.test';
const CANARY = `Canary/pw+${Math.random().toString(36).slice(2)}=x y`;
const CANARY2 = `Second-${Math.random().toString(36).slice(2)}`;
const adminUrl = process.env.DATABASE_URL;
const stamp = `${process.pid}_${Date.now()}`;
const appDb = `ordinate_e2e_conn_${stamp}`;
const srcDb = `ordinate_e2e_src_${stamp}`;
const at = (db: string): string => {
  const u = new URL(adminUrl!);
  u.pathname = '/' + db;
  return u.toString();
};

if (adminUrl) {
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${appDb}`);
  await root.query(`CREATE DATABASE ${srcDb}`);
  const src = new pg.Client({ connectionString: at(srcDb) });
  await src.connect();
  await src.query(`CREATE SCHEMA sales;
    CREATE TABLE sales.orders (id int NOT NULL, region text, amount numeric, ordered_on date);
    INSERT INTO sales.orders SELECT g, (ARRAY['North','South','East','West'])[1 + g % 4], round((g * 13.7)::numeric, 2), date '2026-01-01' + g FROM generate_series(1, 240) g;
    CREATE TABLE sales.customers (id int, name text);
    INSERT INTO sales.customers SELECT g, 'Customer ' || g FROM generate_series(1, 12) g;
    ANALYZE;`);
  await src.end();
  configureServer({
    env: {
      DATABASE_URL: at(appDb),
      ORDINATE_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      AUTH_MODE: 'header',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      ORDINATE_ADMIN_EMAIL: ADMIN,
      // The source Postgres is on loopback, which the SSRF guard refuses unless allowlisted (T6.1).
      // Both families: `localhost` resolves to ::1 and 127.0.0.1, and every answer must pass.
      SSRF_ALLOW: '127.0.0.1/32,::1/128',
    },
    headers: { 'x-forwarded-email': ADMIN },
  });
  after(async () => {
    await root.query(`DROP DATABASE IF EXISTS ${appDb} WITH (FORCE)`);
    await root.query(`DROP DATABASE IF EXISTS ${srcDb} WITH (FORCE)`);
    await root.end();
  });
}

/** Both themes of a filled form: screens() reloads, which would empty it (secrets are never kept). */
async function screensInPlace(page: Page, name: string): Promise<void> {
  const prev = await page.evaluate(() => document.documentElement.dataset.theme ?? 'light');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.screenshot({ path: path.join(SCREENS, `${name}-${theme}.png`), fullPage: true });
  }
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), prev);
}

/** Every RPC reply body this page receives — the canary must be in none. */
function recordReplies(page: Page): () => string {
  let all = '';
  page.on('response', (r: Response) => {
    if (new URL(r.url()).pathname.startsWith('/api/rpc/')) void r.text().then((t) => (all += t + '\n'), () => undefined);
  });
  return () => all;
}

function report(s: Session): void {
  for (const l of s.rpc.loads) console.log(`rpc  ${String(l.rpcs).padStart(2)}  ${new URL(l.url).pathname}${new URL(l.url).search}`);
}

/** An RPC from the spec itself, with the CSRF pair the web client sends (T6.2); the cookie comes with a page load. */
async function post(s: Session, channel: string, payload?: unknown) {
  let csrf = (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value;
  if (!csrf) {
    await s.page.goto('/');
    csrf = (await s.page.context().cookies()).find((c) => c.name === 'ordinate_csrf')?.value ?? '';
  }
  return s.page.request.post(`${s.server.base}/api/rpc/${channel}`, { headers: { 'x-csrf-token': csrf }, data: { args: payload === undefined ? [] : [payload] } });
}

/** The project to connect into: the seeded sample (no DB) or one made over RPC (records in Postgres). */
async function projectOf(s: Session): Promise<string> {
  if (!adminUrl) return s.server.sample.projectId;
  const list = (await (await post(s, 'projects:list')).json()) as { id: string; name: string }[];
  const have = list.find((p) => p.name === 'Warehouse');
  if (have) return have.id;
  const made = await post(s, 'projects:create', { name: 'Warehouse' });
  assert.equal(made.status(), 200);
  return ((await made.json()) as { id: string }).id;
}

e2e('connections: picker, generated form, required fields, a failed test, secrets on a store-less server', async (s) => {
  const { page } = s;
  const projectId = await projectOf(s);
  await page.goto('/connections');
  await settled(page);
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'Connections');
  const tiles = page.locator('button[data-connector]');
  await tiles.first().waitFor();
  const ids = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-connector')));
  for (const local of ['duckdb-file', 'parquet-folder', 'csv-folder']) assert.ok(!ids.includes(local), `${local} is not offered on a server`);
  assert.ok(ids.includes('url') && ids.includes('postgres'), 'URL and PostgreSQL are offered');
  await page.getByText(`${ids.length} sources`, { exact: true }).waitFor();
  await screens(page, 'connections-picker');

  // Search, the no-match state, and the arrow keys across tiles.
  const search = page.getByRole('textbox', { name: 'Search data sources' });
  await search.fill('zzzz');
  await page.getByText('No data sources match that search.').waitFor();
  await search.fill('postgres');
  await page.getByText(new RegExp(`^\\d+ of ${ids.length} sources$`)).waitFor();
  await search.fill('');
  await tiles.first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-connector')), ids[1]);

  // The form, generated from PostgreSQL's fields.
  await page.locator('button[data-connector="postgres"]').click();
  await page.getByRole('heading', { name: 'PostgreSQL', level: 2 }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('source'), 'postgres');
  await page.getByLabel('Host *').fill('');
  await page.getByLabel('Database *').fill('');
  await page.getByRole('button', { name: 'Test & Save' }).click();
  await page.getByRole('alert').filter({ hasText: 'These fields are required' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'conn-f-host', 'focus goes to the first missing field');
  await page.getByLabel('Host *').fill('127.0.0.1');
  await page.getByLabel('Port *').fill('1');
  await page.getByLabel('Database *').fill('nowhere');
  await page.getByLabel('User *').fill('nobody');
  await page.getByRole('button', { name: 'Test & Save' }).click();
  const failed = page.getByRole('alert').filter({ hasNotText: 'required' });
  await failed.waitFor();
  assert.ok((await failed.textContent())!.length > 5, 'the driver error is shown inline');
  await screens(page, 'connections-form');

  if (!adminUrl) {
    // No DATABASE_URL → no encrypted store: a password is refused, never kept in plaintext.
    await page.getByLabel('Host *').fill('127.0.0.1');
    await page.getByLabel('Port *').fill('1');
    await page.getByLabel('Database *').fill('nowhere');
    await page.getByLabel('User *').fill('nobody');
    await page.getByLabel('Password').fill(CANARY);
    await page.getByRole('button', { name: 'Test & Save' }).click();
    await page.getByRole('alert').filter({ hasText: 'needs DATABASE_URL and ORDINATE_MASTER_KEY' }).waitFor();
    const list = (await (await post(s, 'connections:list', { projectId })).json()) as unknown[];
    assert.equal(list.length, 0, 'nothing was saved');
  }
  // Snowflake: a multi-line secret, masked; the account is never a URL.
  await page.goto(`/connections/${projectId}?source=snowflake`);
  await page.getByRole('heading', { name: 'Snowflake', level: 2 }).waitFor();
  const key = page.getByLabel('Private key or access token *');
  assert.equal(await key.evaluate((el) => el.tagName), 'TEXTAREA');
  assert.equal(await key.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-text-security')), 'disc', 'the key is drawn as discs');
  assert.equal(await key.getAttribute('spellcheck'), 'false');
  await key.fill('-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHzBJBgkqhkiG9w0BBQ0wPDAbBgkqhkiG9w0BBQwwDgQI\nCanaryKeyLine/not+a+real+key==\n-----END ENCRYPTED PRIVATE KEY-----');
  await page.getByLabel('Private key passphrase').fill(CANARY);
  await page.getByLabel('Account *').fill('evil.com/');
  await page.getByLabel('User *').fill('reader');
  await page.getByLabel('Warehouse *').fill('COMPUTE_WH');
  await page.getByLabel('Role *').fill('ORDINATE_READER');
  await page.getByRole('button', { name: 'Test & Save' }).click();
  // Without the encrypted store the secret is refused first; with it, the account is.
  await page.getByRole('alert').filter({ hasText: adminUrl ? 'not a URL' : 'needs DATABASE_URL and ORDINATE_MASTER_KEY' }).waitFor();
  await screensInPlace(page, 'connections-snowflake');
  assert.equal(((await (await post(s, 'connections:list', { projectId })).json()) as unknown[]).filter((c) => (c as { connectorId: string }).connectorId === 'snowflake').length, 0, 'nothing was saved');
  await page.getByRole('button', { name: 'Change source' }).click();
  await tiles.first().waitFor();
  report(s);
});

if (adminUrl) {
  e2e('connections: connect with a password, browse, query, save a dataset, replace the secret, delete', async (s) => {
    const { page, server } = s;
    const replies = recordReplies(page);
    const projectId = await projectOf(s);
    const u = new URL(adminUrl);

    // ── Connect ──────────────────────────────────────────────────────────
    await page.goto(`/connections/${projectId}?source=postgres`);
    await settled(page);
    await page.getByLabel('Name', { exact: true }).fill('Orders warehouse');
    await page.getByLabel('Host *').fill(u.hostname);
    await page.getByLabel('Port *').fill(u.port || '5432');
    await page.getByLabel('Database *').fill(srcDb);
    await page.getByLabel('User *').fill(decodeURIComponent(u.username));
    await page.getByLabel('Password').fill(CANARY);
    await page.getByRole('button', { name: 'Test & Save' }).click();

    // ── The workbench ────────────────────────────────────────────────────
    await page.getByRole('heading', { level: 1, name: 'Orders warehouse' }).waitFor();
    const connId = new URL(page.url()).pathname.split('/').pop()!;
    const tree = page.getByRole('tree', { name: 'Schema' });
    await tree.getByRole('treeitem', { name: /orders/ }).waitFor();
    assert.ok(await tree.getByText('sales', { exact: true }).isVisible(), 'grouped under its schema');
    const rail = page.getByRole('complementary', { name: 'Connection details' });
    await rail.getByText('Set', { exact: true }).waitFor();
    assert.equal(await page.locator('input[type=password]').count(), 0, 'no password input holds a value on the page');

    // Expand columns (metadata only), then select: the sample.
    await tree.getByRole('button', { name: 'Show columns of sales.orders' }).click();
    await tree.getByText('ordered_on').waitFor();
    await tree.getByText('integer not null').waitFor();
    await tree.getByRole('treeitem', { name: /orders/ }).click();
    await page.getByText('240 of 240 rows · 4 columns').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('table'), 'sales.orders');
    await page.getByRole('grid', { name: 'Results of sales.orders' }).waitFor();
    // L3.2: PostgreSQL CAN be Live, but this connection is not marked a read replica — no Live choice.
    assert.equal(await page.getByRole('combobox', { name: 'How to save' }).count(), 0, 'no Live choice on an unticked PostgreSQL');
    assert.equal(await rail.getByRole('switch', { name: 'This is a read replica or a warehouse' }).isChecked(), false);

    // Autocomplete, Run, Explain.
    const editor = page.getByRole('combobox', { name: 'SQL' });
    await editor.click();
    await editor.pressSequentially('select region, count(*) as n from sales.ord');
    await page.getByRole('option', { name: /sales\.orders/ }).waitFor();
    await page.keyboard.press('Enter');
    assert.match(await editor.inputValue(), /from "sales"\."orders"$/);
    await editor.pressSequentially(' group by region order by region');
    await page.getByRole('button', { name: 'Explain' }).click();
    await page.getByText('Returns 2 columns').waitFor();
    await editor.focus();
    await page.keyboard.press('Control+Enter');
    await page.getByText('4 of 4 rows · 2 columns').waitFor();

    // Save the query (named), then save the result as a dataset.
    await page.getByRole('button', { name: 'Save query' }).click();
    const dialog = page.getByRole('dialog', { name: 'Name this query' });
    await dialog.getByLabel('Query name').fill('Orders by region');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await page.getByRole('button', { name: 'Orders by region', pressed: true }).waitFor();
    await page.getByRole('textbox', { name: 'Dataset name' }).fill('Regions');
    await page.getByRole('button', { name: 'Save as dataset' }).click();
    await page.getByText('Saved “Regions” as a dataset.').waitFor();
    const row = rail.getByRole('listitem').filter({ hasText: 'Regions' });
    await row.getByText(/4 rows/).waitFor();

    // Schedule and Refresh now.
    await row.getByRole('combobox', { name: 'Auto-refresh Regions' }).click();
    await page.getByRole('option', { name: 'Refresh daily' }).click();
    await row.getByText(/Refreshes daily/).waitFor();
    await row.getByRole('button', { name: 'Refresh Regions now' }).click();
    await page.getByText('Refreshed “Regions”.').waitFor();
    // Fresh on ask (L3.1) beside the schedule: disabled without incremental refresh, saying why.
    const freshPicker = row.getByRole('combobox', { name: 'Fresh on ask for Regions — needs incremental refresh' });
    assert.equal(await freshPicker.isDisabled(), true, 'no incremental refresh: fresh on ask is disabled');
    await row.getByText('needs incremental refresh', { exact: true }).waitFor();
    // …and the Incremental refresh panel that turns it on (web/e2e/data.e2e.ts walks it).
    await row.getByRole('button', { name: 'Incremental refresh for Regions: off' }).click();
    const inc = page.getByRole('dialog', { name: 'Incremental refresh · Regions' });
    await inc.getByText(/Each run asks PostgreSQL only for rows at or past the mark/).waitFor();
    await inc.getByRole('button', { name: 'Cancel' }).click();
    await inc.waitFor({ state: 'detached' });
    // Its refresh URL panel (live data L0.5), opened from the rail (web/e2e/refreshUrl.e2e.ts walks it).
    await row.getByRole('button', { name: 'Refresh URL for Regions' }).click();
    const hooks = page.getByRole('dialog', { name: 'Refresh URL · Regions' });
    await hooks.getByRole('heading', { name: 'No refresh URLs yet' }).waitFor();
    await hooks.getByRole('button', { name: 'Done' }).click();
    await hooks.waitFor({ state: 'detached' });

    // Replace the password: tested, kept, never shown.
    await rail.getByRole('button', { name: 'Replace Password' }).click();
    await rail.getByLabel('New password').fill(CANARY2);
    await rail.getByRole('button', { name: 'Test & replace' }).click();
    await page.getByText('Password replaced — the connection tested OK with it.').waitFor();
    await rail.getByRole('button', { name: 'Test', exact: true }).click();
    await rail.getByText('OK', { exact: true }).waitFor();

    // Reopened from its URL (?table= reselects the sample): every pane full.
    await page.goto(`/connections/${projectId}/${connId}?table=sales.orders`);
    await page.getByText('240 of 240 rows · 4 columns').waitFor();
    await tree.getByText('~240').waitFor();
    await screens(page, 'connections-workbench');

    // Back to the list: the card, with its dataset and saved query.
    await page.getByRole('link', { name: 'Connections' }).first().click();
    const card = page.getByRole('link', { name: 'Open Orders warehouse' });
    await card.filter({ hasText: /1 dataset · 1 saved query · used / }).waitFor();
    await screens(page, 'connections-list');

    // Nothing anywhere ever carried either password.
    const dom = await page.content();
    for (const [where, text] of [['RPC replies', replies()], ['DOM', dom], ['server log', server.log()]] as const) {
      assert.ok(!text.includes(CANARY) && !text.includes(CANARY2) && !text.includes(encodeURIComponent(CANARY)), `no password in the ${where}`);
    }
    assert.ok(replies().includes(connId), 'the replies were recorded');

    // Delete, after a confirmation.
    await page.getByRole('button', { name: 'Delete connection Orders warehouse' }).click();
    await page.getByRole('dialog', { name: 'Delete this connection?' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByText('No connections yet. Pick a source below to add one.').waitFor();
    report(s);
  });
}

if (adminUrl) {
  // Live (docs/live-data/00-plan.md L2.1): Redshift speaks Postgres's wire, so the local
  // Postgres stands in for the warehouse. "Add from connection" asks Copy or Live; Live
  // keeps the schema only; the dataset page says so; the switch both ways.
  e2e('connections: save a Live dataset, open it, copy it, switch it back to Live', async (s) => {
    const { page } = s;
    const projectId = await projectOf(s);
    const u = new URL(adminUrl);
    await page.goto(`/connections/${projectId}?source=amazon-redshift`);
    await settled(page);
    await page.getByLabel('Name', { exact: true }).fill('Live warehouse');
    await page.getByLabel('Host *').fill(u.hostname);
    await page.getByLabel('Port *').fill(u.port || '5432');
    await page.getByLabel('Database *').fill(srcDb);
    await page.getByLabel('User *').fill(decodeURIComponent(u.username));
    await page.getByLabel('Password').fill(CANARY);
    await page.getByLabel('Use TLS').uncheck(); // the local Postgres has no certificate
    await page.getByRole('button', { name: 'Test & Save' }).click();
    await page.getByRole('heading', { level: 1, name: 'Live warehouse' }).waitFor();
    const connId = new URL(page.url()).pathname.split('/').pop()!;

    // The table's sample, then "Live" in the save bar.
    await page.goto(`/connections/${projectId}/${connId}?table=sales.orders`);
    await page.getByText('240 of 240 rows · 4 columns').waitFor();
    const how = page.getByRole('combobox', { name: 'How to save' });
    assert.equal(await how.textContent(), 'Copy the data');
    await how.click();
    await page.getByRole('option', { name: 'Live' }).click();
    await page.getByRole('textbox', { name: 'Dataset name' }).fill('Orders live');
    await page.getByRole('button', { name: 'Save as Live dataset' }).click();
    await page.getByText('Saved “Orders live” as a Live dataset.').waitFor();
    const rail = page.getByRole('complementary', { name: 'Connection details' });
    const row = rail.getByRole('listitem').filter({ hasText: 'Orders live' });
    await row.getByText('Live · asked at the warehouse').waitFor();
    assert.equal(await row.getByRole('combobox').count(), 0, 'no refresh schedule on a Live dataset');

    // The dataset page: a Live badge, the notice in place of rows, only Data and Columns.
    await row.getByRole('link', { name: 'Orders live' }).click();
    await page.getByRole('heading', { name: 'Live — the rows stay in the warehouse' }).waitFor();
    await page.getByText('Live · cached up to 5 min').waitFor();
    assert.equal(await page.getByRole('tab', { name: /Quality/ }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Prepare' }).count(), 0);
    const datasetId = new URL(page.url()).pathname.split('/').pop()!;
    await page.getByRole('tab', { name: 'Columns' }).click();
    await page.getByText('ordered_on').first().waitFor();
    await page.getByRole('tab', { name: 'Data' }).click();
    await screens(page, 'connections-live-dataset');

    // Copy the data instead → an extract with its rows; then back to Live through the confirm.
    await page.getByRole('button', { name: 'Copy the data instead' }).click();
    await page.getByText('240 rows', { exact: false }).first().waitFor();
    const more = page.getByRole('button', { name: 'More dataset actions' });
    await more.click();
    await page.getByRole('menuitem', { name: 'Switch to Live…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Switch to Live?' });
    await dialog.getByText('The stored copy of 240 rows is deleted.', { exact: false }).waitFor();
    await dialog.screenshot({ path: `${SCREENS}connections-live-switch-dialog-light.png` });
    await dialog.getByRole('button', { name: 'Delete the copy and go Live' }).click();
    await page.getByText('“Orders live” is Live.').waitFor();
    await page.getByRole('heading', { name: 'Live — the rows stay in the warehouse' }).waitFor();
    const source = (await (await post(s, 'dataset:source', { projectId, id: datasetId })).json()) as Record<string, unknown>;
    assert.equal(source.live, true);
    assert.deepEqual(Object.keys(source).sort(), ['kind', 'label', 'live', 'maxCacheAgeSec', 'refreshable'], 'flags and a label — no SQL, no host');
    report(s);
  });
}

if (adminUrl) {
  // Live on a PostgreSQL read replica (docs/live-data/00-plan.md L3.2, D8): the box ticked on the
  // form, "Live" offered in the save bar, a Live dataset saved; unticking it then is refused in place.
  e2e('connections: a PostgreSQL read replica — tick the box, save a Live dataset, unticking refused', async (s) => {
    const { page } = s;
    const projectId = await projectOf(s);
    const u = new URL(adminUrl);
    const BOX = 'This is a read replica or a warehouse';
    await page.goto(`/connections/${projectId}?source=postgres`);
    await settled(page);
    await page.getByLabel('Name', { exact: true }).fill('Orders replica');
    await page.getByLabel('Host *').fill(u.hostname);
    await page.getByLabel('Port *').fill(u.port || '5432');
    await page.getByLabel('Database *').fill(srcDb);
    await page.getByLabel('User *').fill(decodeURIComponent(u.username));
    await page.getByLabel('Password').fill(CANARY);
    const box = page.getByRole('checkbox', { name: BOX });
    assert.equal(await box.isChecked(), false, 'off by default');
    await page.getByText('pointing them at a primary OLTP database adds load to production.', { exact: false }).waitFor();
    await box.check();
    await screensInPlace(page, 'connections-replica-form');
    await page.getByRole('button', { name: 'Test & Save' }).click();
    await page.getByRole('heading', { level: 1, name: 'Orders replica' }).waitFor();
    const connId = new URL(page.url()).pathname.split('/').pop()!;

    // Ticked: the save bar asks Copy or Live.
    await page.goto(`/connections/${projectId}/${connId}?table=sales.orders`);
    await page.getByText('240 of 240 rows · 4 columns').waitFor();
    const rail = page.getByRole('complementary', { name: 'Connection details' });
    assert.equal(await rail.getByRole('switch', { name: BOX }).isChecked(), true);
    const how = page.getByRole('combobox', { name: 'How to save' });
    assert.equal(await how.textContent(), 'Copy the data');
    await how.click();
    await page.getByRole('option', { name: 'Live' }).click();
    await page.getByRole('textbox', { name: 'Dataset name' }).fill('Orders on the replica');
    await page.getByRole('button', { name: 'Save as Live dataset' }).click();
    await page.getByText('Saved “Orders on the replica” as a Live dataset.').waitFor();
    const row = rail.getByRole('listitem').filter({ hasText: 'Orders on the replica' });
    await row.getByText('Live · asked at the warehouse').waitFor();

    // Unticking while a Live dataset asks the connection: refused in place, still ticked.
    await rail.getByRole('switch', { name: BOX }).click();
    await rail.getByRole('alert').filter({ hasText: 'One Live dataset asks this connection.' }).waitFor();
    assert.equal(await rail.getByRole('switch', { name: BOX }).isChecked(), true);
    await screensInPlace(page, 'connections-replica-workbench');

    // The Live dataset's own page.
    await row.getByRole('link', { name: 'Orders on the replica' }).click();
    await page.getByRole('heading', { name: 'Live — the rows stay in the warehouse' }).waitFor();
    const datasetId = new URL(page.url()).pathname.split('/').pop()!;
    const source = (await (await post(s, 'dataset:source', { projectId, id: datasetId })).json()) as Record<string, unknown>;
    assert.equal(source.live, true);
    report(s);
  });
}
