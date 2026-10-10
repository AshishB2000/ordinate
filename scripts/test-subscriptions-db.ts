// Subscriptions on Postgres — header sign-in on a scratch database, the real
// secrets store (ORDINATE_MASTER_KEY) and the real jobs table. Delivery goes to
// a LOCAL receiver (scripts/subscriptionHarness.ts).
//
//   roles      every channel:* and subscription:* channel allows exactly the
//              roles its access names — org admin for a channel, project
//              viewer / editor for a subscription, nobody without a grant — and
//              a denied call never reaches its handler (spy)
//   owner      a run computes with the OWNER's access as it is now: grant
//              removed → `owner_no_access`, account disabled → `owner_removed`,
//              nothing sent either time; the next writer to save it takes it over
//   once       two concurrent claimers and this pod's own poller race for one
//              due tick: exactly one runs it and the message is posted once
//              (NEGATIVE CONTROL: two ticks with no claim both send)
//   sealed     the webhook URL is ciphertext in `secrets`, and in no `records`
//              row, audit row or log line; another org's store read finds nothing
//   audit      each attempt to send is a row: the owner, the ids, the outcome
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-subscriptions-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { randomBytes } from 'crypto';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const api: typeof import('../src/api/index') = require('../src/api/index');
const runner: typeof import('../src/server/jobs/runner') = require('../src/server/jobs/runner');
const run: typeof import('../src/server/subscriptions/run') = require('../src/server/subscriptions/run');
const store: typeof import('../src/analysis/subscriptions') = require('../src/analysis/subscriptions');
const secretsMod: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
const say: typeof import('../src/analysis/subscriptionText') = require('../src/analysis/subscriptionText');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-subs-db-'));
const DAY = 86_400_000;
const NEEDLE = 'webhook-canary-7f3a91c2';
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function suite(adminUrl: string): Promise<void> {
  const dbName = `ordinate_subs_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 4 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const pool2 = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool2.on('error', () => undefined);

  B.openLoopback();
  const rx = await B.receiver();
  const logLines: string[] = [];
  const logStream = new Writable({ write(chunk, _enc, done) { logLines.push(String(chunk)); done(); } });
  const masterKey = randomBytes(32).toString('base64');
  process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'info', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', ORDINATE_MASTER_KEY: masterKey,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  });
  runner.setTimingForTest({ pollMs: 200 }); // this pod's poller races the suite's claimers in earnest
  const app = appMod.buildApp(cfg, logStream);
  try {
    const base = await B.listen(app);
    // This pod's own poller must not run a tick while the suite is driving them by hand.
    const park = () => pool.query(`UPDATE jobs SET next_run_at = now() + interval '1 hour' WHERE kind IN ('subscriptions', 'tick')`);
    const replies: string[] = [];
    const as = (who: string) => B.client(base, { 'x-forwarded-email': `${who}@acme.test` }, replies);
    for (const p of ['boss', 'alice', 'bob', 'carol']) await as(p).call('projects:list');
    const uid = async (who: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@acme.test`])).rows[0].id;
    const boss = as('boss');
    const pid: string = (await boss.call('projects:create', { name: 'Shared' })).body.id;
    const other: string = (await boss.call('projects:create', { name: 'Private' })).body.id;
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor']]) await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    const BOSS: B.Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const JOBS: B.Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: 'acme' } };
    const asJob = <T>(fn: () => Promise<T>): Promise<T> => B.context.runInContext(JOBS, 'job:subscriptions:acme', fn);
    const s = await B.seed(BOSS, pid);
    const s2 = await B.seed(BOSS, other);
    // The poller makes the org's job rows on its first pass after the org exists.
    for (let i = 0; i < 100 && (await pool.query(`SELECT 1 FROM jobs WHERE kind = 'subscriptions' AND org_id = 'acme'`)).rowCount === 0; i++) await sleep(100);
    ok('the `subscriptions` job has a row for the org in the jobs table', (await pool.query(`SELECT 1 FROM jobs WHERE kind = 'subscriptions' AND org_id = 'acme'`)).rowCount === 1);
    await park();

    // A schedule whose slot today is already behind `since`, so nothing is due by the real clock during the suite.
    const past = new Date(Date.now() - 2 * 3_600_000);
    const at = `${String(past.getUTCHours()).padStart(2, '0')}:${String(past.getUTCMinutes()).padStart(2, '0')}`;
    const def = (seed: B.Seed, channelIds: string[], over: Record<string, unknown> = {}) => B.definition(seed, channelIds, { schedule: { cadence: 'daily', at }, ...over });

    // ── channels are an org admin's; the URL is sealed ──────────────────────
    const ch = await boss.call('channel:save', { name: 'Sales', kind: 'slack', webhookUrl: rx.url() });
    ok('an org admin saves a channel; the reply carries no URL', ch.status === 200 && ch.body.ok && ch.body.channel.secretSet === true && !ch.text.includes(NEEDLE), show(ch.body));
    const SL: string = ch.body.channel.id;
    const sealed = await pool.query<{ kind: string; ciphertext: Buffer }>(`SELECT kind, ciphertext FROM secrets WHERE org_id = 'acme' AND ref = $1`, [SL]);
    ok('sealed: the URL is one `channel.webhook` row of ciphertext — not the URL, not base64 of it',
      sealed.rows.length === 1 && sealed.rows[0].kind === 'channel.webhook' && !sealed.rows[0].ciphertext.toString('latin1').includes(NEEDLE)
      && !sealed.rows[0].ciphertext.toString('utf8').includes('127.0.0.1') && sealed.rows[0].ciphertext.length >= rx.url().length);
    const real = secretsMod.createSecretStore(pool, cfg.masterKey!);
    ok('sealed: bound to its org — the same id read as another org finds nothing; NEGATIVE CONTROL: its own org reads it',
      (await real.get('globex', 'channel.webhook', SL)) === null && (await real.get('acme', 'channel.webhook', SL)) === rx.url());
    const GLOBEX: B.Identity = { user: { email: 'bo@globex.test', role: 'admin' }, org: { id: 'globex' } };
    const theirs = await B.context.runInContext(GLOBEX, 'other-org', async () => ({ list: await B.channels.listChannels(), one: await B.channels.getChannel(SL), url: await B.channels.webhookOf(SL), subs: await store.listSubscriptions(pid) }));
    ok('another org: no channel listed, none by id, no URL, no subscription under the project id (rows are per org, RLS forced)', theirs.list.length === 0 && theirs.one === null && theirs.url === null && theirs.subs.length === 0);

    const mine = (await as('bob').call('subscription:save', { projectId: pid, subscription: def(s, [SL]) })).body.subscription;
    const hidden = (await boss.call('subscription:save', { projectId: other, subscription: def(s2, [SL], { name: 'Private board' }) })).body.subscription;
    ok('a project editor creates a subscription and owns it', mine && mine.owner === 'bob@acme.test' && hidden && hidden.owner === 'boss@acme.test', show(mine));

    // ── roles ─────────────────────────────────────────────────────────────
    const calls = new Map<string, number>();
    for (const chName of Object.keys(api.contracts).filter((c) => c.startsWith('channel:') || c.startsWith('subscription:'))) {
      const realHandler = rpc.handlers.get(chName);
      if (!realHandler) continue;
      rpc.registry.removeHandler(chName);
      rpc.registry.handle(chName, (e, ...args) => {
        calls.set(chName, (calls.get(chName) ?? 0) + 1);
        return realHandler(e, ...args);
      });
    }
    const spare = (await boss.call('channel:save', { name: 'Spare', kind: 'teams', webhookUrl: rx.url('/spare') })).body.channel.id;
    type Need = 'member' | 'org-admin' | 'read' | 'write';
    const cells: Array<[string, () => unknown, Need]> = [
      ['channel:list', () => undefined, 'member'],
      ['channel:usage', () => ({ id: SL }), 'org-admin'],
      ['channel:test', () => ({ id: spare }), 'org-admin'],
      ['channel:save', () => ({ id: spare, name: 'Spare 2', kind: 'teams' }), 'org-admin'],
      ['subscription:list', () => ({ projectId: pid }), 'read'],
      ['subscription:get', () => ({ projectId: pid, id: mine.id }), 'read'],
      ['subscription:history', () => ({ projectId: pid, id: mine.id }), 'read'],
      ['subscription:preview', () => ({ projectId: pid, draft: def(s, [SL]) }), 'read'],
      ['subscription:save', () => ({ projectId: pid, id: mine.id, subscription: def(s, [SL]) }), 'write'],
      ['subscription:setEnabled', () => ({ projectId: pid, id: mine.id, enabled: true }), 'write'],
      ['subscription:sendNow', () => ({ projectId: pid, id: mine.id }), 'write'],
    ];
    // carol is a member with no grant on the project; alice views it; bob edits it; boss is the org admin.
    const may: Record<Need, string[]> = { member: ['carol', 'alice', 'bob', 'boss'], 'org-admin': ['boss'], read: ['alice', 'bob', 'boss'], write: ['bob', 'boss'] };
    let wrong = 0;
    let leaks = 0;
    const lines: string[] = [];
    for (const [chName, mk, need] of cells) {
      const line: string[] = [];
      for (const who of ['carol', 'alice', 'bob', 'boss']) {
        const n = calls.get(chName) ?? 0;
        const r = await as(who).call(chName, mk());
        const allowed = r.status === 200;
        if (allowed !== may[need].includes(who) || (r.status !== 200 && r.status !== 403)) wrong++;
        if (!allowed && (calls.get(chName) ?? 0) !== n) leaks++;
        line.push(allowed ? 'ALLOW' : 'deny ');
      }
      lines.push(`     ${chName.padEnd(26)} ${need.padEnd(9)} ${line.join(' ')}`);
    }
    console.log('     channel                    needs     no-grant viewer editor org-admin\n' + lines.join('\n'));
    ok('roles: every channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
    for (const chName of ['channel:delete', 'subscription:delete']) {
      const payload = chName === 'channel:delete' ? { id: spare } : { projectId: pid, id: (await as('bob').call('subscription:save', { projectId: pid, subscription: def(s, [SL], { name: 'Temp' }) })).body.subscription.id };
      const denied = await as('alice').call(chName, payload);
      const allowed = await boss.call(chName, payload);
      ok(`roles: ${chName} — a viewer 403, the admin 200`, denied.status === 403 && allowed.status === 200 && allowed.body.ok === true, `${denied.status} ${allowed.status}`);
    }
    ok('cross-project: an editor of ONE project cannot list, read, send or delete another project\'s subscription (403), nor reach it through their own project id',
      (await as('bob').call('subscription:list', { projectId: other })).status === 403 && (await as('bob').call('subscription:get', { projectId: other, id: hidden.id })).status === 403
      && (await as('bob').call('subscription:sendNow', { projectId: other, id: hidden.id })).status === 403 && (await as('bob').call('subscription:delete', { projectId: other, id: hidden.id })).status === 403
      && (await as('bob').call('subscription:get', { projectId: pid, id: hidden.id })).body.ok === false && (await as('bob').call('subscription:sendNow', { projectId: pid, id: hidden.id })).body.ok === false);
    ok('cross-project: the admin-only usage list is where another project\'s subscription is named — to the org admin, not to an editor',
      (await boss.call('channel:usage', { id: SL })).body.subscriptions.some((u: { name: string }) => u.name === 'Private board') && (await as('bob').call('channel:usage', { id: SL })).status === 403);
    await as('bob').call('subscription:setEnabled', { projectId: pid, id: mine.id, enabled: true });
    rx.hits.length = 0;

    // ── the owner's access, as it is now ──────────────────────────────────
    const first = Math.ceil((Date.now() + 1000) / DAY) * DAY + past.getUTCHours() * 3_600_000 + past.getUTCMinutes() * 60_000;
    const slot = (k: number): number => first + k * DAY;
    const state = (id: string, project = pid) => B.context.runInContext(BOSS, 'read', () => store.getSubscription(project, id));
    await boss.call('subscription:setEnabled', { projectId: other, id: hidden.id, enabled: false });
    await asJob(() => run.tickSubscriptions(slot(0) + 1000));
    ok('owner: with access, the scheduled run is sent (as the owner)', rx.hits.length === 1 && (await state(mine.id))!.run.history[0].outcome === 'sent', show((await state(mine.id))!.run.history[0]));
    rx.hits.length = 0;
    await boss.call('project:share', { projectId: pid, member: { userId: await uid('bob') }, role: null });
    await asJob(() => run.tickSubscriptions(slot(1) + 1000));
    const lost = (await state(mine.id))!.run.history[0];
    ok('owner: grant removed → the run FAILS typed (`owner_no_access`) and nothing is sent', rx.hits.length === 0 && lost.outcome === 'failed' && lost.code === 'owner_no_access'
      && (await boss.call('subscription:history', { projectId: pid, id: mine.id })).body.runs[0].text === say.runText('owner_no_access', { owner: 'bob@acme.test' }), show(lost));
    await boss.call('project:share', { projectId: pid, member: { userId: await uid('bob') }, role: 'editor' });
    await boss.call('admin:setDisabled', { userId: await uid('bob'), disabled: true });
    await asJob(() => run.tickSubscriptions(slot(2) + 1000));
    const removed = (await state(mine.id))!.run.history[0];
    ok('owner: account disabled → `owner_removed`, nothing sent', rx.hits.length === 0 && removed.code === 'owner_removed' && (await state(mine.id))!.run.failures === 2, show(removed));
    ok('NEGATIVE CONTROL: the same subscription owned by someone WITH access is sent — the next writer to save it takes it over',
      (await boss.call('subscription:save', { projectId: pid, id: mine.id, subscription: def(s, [SL]) })).body.subscription.owner === 'boss@acme.test'
      && (await asJob(() => run.tickSubscriptions(slot(3) + 1000))) === 1 && rx.hits.length === 1);
    rx.hits.length = 0;

    // ── exactly once ──────────────────────────────────────────────────────
    // A subscription due by the REAL clock: hourly at the minute just gone, made two hours ago.
    const minuteAgo = new Date(Date.now() - 90_000);
    const due = await B.context.runInContext(BOSS, 'due', () => store.createSubscription(pid, {
      ...B.definition(s, [SL], { name: 'Hourly', schedule: { cadence: 'hourly', at: `00:${String(minuteAgo.getUTCMinutes()).padStart(2, '0')}` } }),
    }, 'boss@acme.test', new Date(Date.now() - 2 * 3_600_000)));
    await boss.call('subscription:setEnabled', { projectId: pid, id: mine.id, enabled: false });
    await pool.query(`UPDATE jobs SET next_run_at = now() - interval '1 second', lease_owner = NULL, lease_until = NULL WHERE kind = 'subscriptions' AND org_id = 'acme'`);
    const log = app.log;
    const claims = await Promise.all([pool, pool2, pool, pool2].map((p) => runner.claimOne(p, ['subscriptions'])));
    const won = claims.filter((c): c is NonNullable<typeof c> => c !== null);
    await Promise.all(won.map((c) => runner.runClaim(pool, c, log)));
    // Whoever took it — one of the four claimers here, or this pod's own poller — it ran once.
    const settled = async (): Promise<boolean> => ((await state(due!.id))!.run.history.length > 0);
    for (let i = 0; i < 100 && !(await settled()); i++) await sleep(100);
    await sleep(300);
    ok(`once: four concurrent claimers and the pod's poller raced for one due tick — at most one claim won here (${won.length})`, won.length <= 1);
    ok('once: the message was posted exactly once, and the run is on the record once', rx.hits.length === 1 && (await state(due!.id))!.run.history.length === 1 && (await state(due!.id))!.run.history[0].outcome === 'sent',
      show([rx.hits.length, (await state(due!.id))!.run.history]));
    ok('once: a claim after it finished finds nothing due', (await runner.claimOne(pool2, ['subscriptions'])) === null);
    await park();
    rx.hits.length = 0;
    const twin = await B.context.runInContext(BOSS, 'twin', () => store.createSubscription(pid, {
      ...B.definition(s, [SL], { name: 'Twin', schedule: { cadence: 'hourly', at: `00:${String(minuteAgo.getUTCMinutes()).padStart(2, '0')}` } }),
    }, 'boss@acme.test', new Date(Date.now() - 2 * 3_600_000)));
    await Promise.all([asJob(() => run.tickSubscriptions()), asJob(() => run.tickSubscriptions())]);
    ok('NEGATIVE CONTROL: the lease is what makes it once — two ticks run with NO claim both post', twin !== null && rx.hits.length === 2, String(rx.hits.length));

    // ── audit and the canary ──────────────────────────────────────────────
    const trail = await pool.query<{ actor: string; outcome: string; target_ids: string[]; project_id: string }>(`SELECT actor, outcome, target_ids::text[] AS target_ids, project_id::text FROM audit_log WHERE channel = 'subscription:send' ORDER BY id`);
    ok('audit: every attempt to send is a row — who it ran as, the project, the subscription and channel ids, the outcome',
      trail.rows.length >= 6 && trail.rows.some((r) => r.actor === 'bob@acme.test' && r.outcome === 'ok') && trail.rows.some((r) => r.actor === 'bob@acme.test' && r.outcome === 'error')
      && trail.rows.every((r) => r.project_id === pid && r.target_ids.includes(SL)), show(trail.rows.slice(0, 3)));
    await sleep(100);
    const dump = async (table: string): Promise<string> => JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
    ok(`canary: no reply (${replies.length}), no log line (${logLines.length}), no record row and no audit row carries the webhook secret`,
      replies.length > 60 && logLines.length > 80 && !replies.some((r) => r.includes(NEEDLE)) && !logLines.some((l) => l.includes(NEEDLE))
      && !(await dump('records')).includes(NEEDLE) && !(await dump('audit_log')).includes(NEEDLE) && !(await dump('jobs')).includes(NEEDLE));
    ok('NEGATIVE CONTROL: the receiver did see it — the URL was used, only never shown', rx.hits.some((h) => h.url.includes(NEEDLE)) && (await dump('records')).includes('Sales'));
  } finally {
    await app.close().catch(() => undefined);
    await rx.close();
    await pool.end();
    await pool2.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('skip subscriptions DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    await suite(process.env.DATABASE_URL);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
